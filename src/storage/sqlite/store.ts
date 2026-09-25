import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// Bundlers (esbuild/tsup) rewrite `import from "node:sqlite"` to bare
// "sqlite", which Node cannot resolve — the node:sqlite builtin has no
// unprefixed alias. A require through createRequire keeps the specifier
// opaque to the bundler while staying plain Node at runtime.
import {
  AgentLensStorageError,
  UnsupportedSchemaVersionError,
} from "../../core/errors.js";
import type { JsonValue } from "../../core/json.js";
import { parseRun, type Run } from "../../core/run.js";
import { applyMigrations, MIGRATIONS } from "./migrations.js";

const { DatabaseSync }: { DatabaseSync: typeof DatabaseSyncType } =
  createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: typeof DatabaseSyncType;
  };

/** Local-first default: `<cwd>/.agentlens/agentlens.db`. */
export function defaultDbPath(cwd = process.cwd()): string {
  return join(cwd, ".agentlens", "agentlens.db");
}

interface EventRow {
  id: string;
  timestamp: string;
  type: string;
  parent_id: string | null;
  data_json: string;
}

/**
 * Synchronous SQLite store for runs and their ordered events.
 * All input is validated before write; reads are re-validated so a
 * corrupt or hand-edited row fails explicitly instead of returning
 * silently mangled events.
 */
export class SqliteTraceStore {
  private constructor(private readonly db: DatabaseSyncType) {}

  /** Opens (and migrates) a database at `path`, or in-memory when ":memory:". */
  static open(path: string | ":memory:" = defaultDbPath()): SqliteTraceStore {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyMigrations(db, MIGRATIONS);
    } catch (error) {
      db.close();
      throw error;
    }
    return new SqliteTraceStore(db);
  }

  /**
   * Opens an existing database strictly read-only for inspection. Never
   * creates the file or its directory and never runs migrations: a missing
   * file, a non-SQLite/corrupt file, a database that is not an AgentLens
   * store, or one at a different schema version fails explicitly.
   */
  static openReadOnly(path: string): SqliteTraceStore {
    if (!existsSync(path)) {
      throw new AgentLensStorageError(`Database not found: ${path}`);
    }
    if (!statSync(path).isFile()) {
      throw new AgentLensStorageError(`Database path is not a file: ${path}`);
    }
    let db: DatabaseSyncType;
    try {
      db = new DatabaseSync(path, { readOnly: true });
    } catch (error) {
      throw new AgentLensStorageError(
        `Cannot open database ${path}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    try {
      const target = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
      let version: number;
      let tables: string[];
      try {
        const row = db.prepare("PRAGMA user_version").get() as
          | { user_version?: number }
          | undefined;
        version = Number(row?.user_version ?? 0);
        tables = (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('runs', 'events')",
            )
            .all() as { name: string }[]
        ).map((r) => r.name);
      } catch (error) {
        throw new AgentLensStorageError(
          `Database ${path} is corrupt or not a SQLite database: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
      if (version > target) {
        throw new UnsupportedSchemaVersionError(version, target, "database");
      }
      if (version < target || tables.length !== 2) {
        throw new AgentLensStorageError(
          version === 0
            ? `Database ${path} is not an AgentLens store (schema version 0)`
            : `Database ${path} has schema version ${version}; this AgentLens reads version ${target}. Read-only commands do not migrate.`,
        );
      }
    } catch (error) {
      db.close();
      throw error;
    }
    return new SqliteTraceStore(db);
  }

  /** Validates and persists a run plus its events atomically. */
  saveRun(input: unknown): Run {
    const run = parseRun(input);
    const insertRun = this.db.prepare(
      "INSERT INTO runs (id, started_at, ended_at, agent, model, status, metrics_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertEvent = this.db.prepare(
      "INSERT INTO events (run_id, seq, id, timestamp, type, parent_id, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      insertRun.run(
        run.id,
        run.startedAt,
        run.endedAt ?? null,
        run.agent ?? null,
        run.model ?? null,
        run.status,
        JSON.stringify(run.metrics),
      );
      run.events.forEach((event, seq) => {
        insertEvent.run(
          run.id,
          seq,
          event.id,
          event.timestamp,
          event.type,
          event.parentId ?? null,
          JSON.stringify(event.data),
        );
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw new AgentLensStorageError(
        `Failed to save run ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return run;
  }

  /** Reads a run back with events in original order; re-validates the result. */
  getRun(id: string): Run {
    const runRow = this.db
      .prepare(
        "SELECT id, started_at, ended_at, agent, model, status, metrics_json FROM runs WHERE id = ?",
      )
      .get(id) as
      | {
          id: string;
          started_at: string;
          ended_at: string | null;
          agent: string | null;
          model: string | null;
          status: string;
          metrics_json: string;
        }
      | undefined;
    if (!runRow) {
      throw new AgentLensStorageError(`Run not found: ${id}`);
    }
    const eventRows = this.db
      .prepare(
        "SELECT id, timestamp, type, parent_id, data_json FROM events WHERE run_id = ? ORDER BY seq",
      )
      .all(id) as unknown as EventRow[];
    let metrics: unknown;
    try {
      metrics = JSON.parse(runRow.metrics_json);
    } catch (error) {
      throw new AgentLensStorageError(
        `Run ${id}: metrics_json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const events = eventRows.map((row, seq) => {
      let data: JsonValue;
      try {
        data = JSON.parse(row.data_json) as JsonValue;
      } catch (error) {
        throw new AgentLensStorageError(
          `Run ${id}, event ${seq}: data_json is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
      const event: Record<string, unknown> = {
        id: row.id,
        runId: id,
        timestamp: row.timestamp,
        type: row.type,
        data,
      };
      if (row.parent_id !== null) event.parentId = row.parent_id;
      return event;
    });
    const raw: Record<string, unknown> = {
      id: runRow.id,
      startedAt: runRow.started_at,
      status: runRow.status,
      events,
      metrics,
    };
    if (runRow.ended_at !== null) raw.endedAt = runRow.ended_at;
    if (runRow.agent !== null) raw.agent = runRow.agent;
    if (runRow.model !== null) raw.model = runRow.model;
    try {
      return parseRun(raw);
    } catch (error) {
      throw new AgentLensStorageError(
        `Run ${id} is stored in an invalid state: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  listRunIds(): string[] {
    const rows = this.db
      .prepare("SELECT id FROM runs ORDER BY started_at, id")
      .all() as {
      id: string;
    }[];
    return rows.map((r) => r.id);
  }

  /** All runs, fully read back and validated, in stable (startedAt, id) order. */
  listRuns(): Run[] {
    return this.listRunIds().map((id) => this.getRun(id));
  }

  /** Direct access to the underlying database (migrations, integrity checks). */
  get database(): DatabaseSyncType {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
