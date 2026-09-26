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
import {
  type RelayEffectHistory,
  type RelayHistoryExport,
  validateRelayHistoryDoc,
} from "../../core/relayEvidence.js";
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

interface RelayImportRow {
  run_id: string;
  schema: string;
  session_sha256: string;
  history_sha256: string;
  imported_at: string;
  effect_count: number;
  event_count: number;
}

interface RelayEffectRow {
  position: number;
  effect_id: string;
  effect_key: string;
  kind: string;
  status: string;
  coverage: string;
  created_at: number;
  submitted_at: number | null;
  settled_at: number | null;
  updated_at: number;
}

interface RelayEffectEventRow {
  effect_id: string;
  seq: number;
  from_status: string | null;
  to_status: string;
  cause: string;
  at: number;
}

/**
 * Offline Relay effect evidence attached to one run at import time.
 * `exportDoc` is the validated `relay.effect-history/1` document; the
 * hashes are SHA-256 of the exact session/history file contents read.
 */
export interface RelayEvidenceAttachment {
  exportDoc: RelayHistoryExport;
  sessionSha256: string;
  historySha256: string;
  importedAt: string;
}

/** Persisted Relay evidence as read back from the evidence tables. */
export interface StoredRelayEvidence {
  runId: string;
  schema: string;
  sessionSha256: string;
  historySha256: string;
  importedAt: string;
  histories: RelayEffectHistory[];
}

const EXPECTED_TABLES = [
  "runs",
  "events",
  "relay_evidence_imports",
  "relay_effects",
  "relay_effect_events",
] as const;

/**
 * Synchronous SQLite store for runs and their ordered events.
 * All input is validated before write; reads are re-validated so a
 * corrupt or hand-edited row fails explicitly instead of returning
 * silently mangled events.
 */
export class SqliteTraceStore {
  private constructor(
    private readonly db: DatabaseSyncType,
    private readonly hasRelayEvidence = true,
  ) {}

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
   * store, or an unsupported schema version fails explicitly. Pre-M8 stores
   * remain readable without migration and have no Relay evidence.
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
    let hasRelayEvidence = true;
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
              `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${EXPECTED_TABLES.map(() => "?").join(", ")})`,
            )
            .all(...EXPECTED_TABLES) as { name: string }[]
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
      const requiredTables =
        version === 1 ? ["runs", "events"] : EXPECTED_TABLES;
      if (
        version < 1 ||
        !requiredTables.every((name) => tables.includes(name))
      ) {
        throw new AgentLensStorageError(
          version === 0
            ? `Database ${path} is not an AgentLens store (schema version 0)`
            : `Database ${path} has schema version ${version}; this AgentLens reads version ${target}. Read-only commands do not migrate.`,
        );
      }
      hasRelayEvidence = version >= 2;
    } catch (error) {
      db.close();
      throw error;
    }
    return new SqliteTraceStore(db, hasRelayEvidence);
  }

  /**
   * Validates and persists a run plus its events atomically. When
   * `evidence` is given, its already-validated histories are written in the
   * same transaction — a duplicate run, invalid sidecar or any insert
   * failure rolls back run and evidence together; nothing is left partial.
   */
  saveRun(input: unknown, evidence?: RelayEvidenceAttachment): Run {
    const run = parseRun(input);
    const insertRun = this.db.prepare(
      "INSERT INTO runs (id, started_at, ended_at, agent, model, status, metrics_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertEvent = this.db.prepare(
      "INSERT INTO events (run_id, seq, id, timestamp, type, parent_id, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertImport = this.db.prepare(
      "INSERT INTO relay_evidence_imports (run_id, schema, session_sha256, history_sha256, imported_at, effect_count, event_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertEffect = this.db.prepare(
      "INSERT INTO relay_effects (run_id, position, effect_id, effect_key, kind, status, coverage, created_at, submitted_at, settled_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertEffectEvent = this.db.prepare(
      "INSERT INTO relay_effect_events (run_id, effect_id, seq, from_status, to_status, cause, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
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
      if (evidence !== undefined) {
        const histories = evidence.exportDoc.histories;
        insertImport.run(
          run.id,
          evidence.exportDoc.schema,
          evidence.sessionSha256,
          evidence.historySha256,
          evidence.importedAt,
          histories.length,
          histories.reduce((total, h) => total + h.events.length, 0),
        );
        histories.forEach((history, position) => {
          const record = history.record;
          insertEffect.run(
            run.id,
            position,
            record.id,
            record.key,
            record.kind,
            record.status,
            history.coverage,
            record.createdAt,
            record.submittedAt ?? null,
            record.settledAt ?? null,
            record.updatedAt,
          );
          for (const transition of history.events) {
            insertEffectEvent.run(
              run.id,
              transition.effectId,
              transition.seq,
              transition.fromStatus ?? null,
              transition.toStatus,
              transition.cause,
              transition.at,
            );
          }
        });
      }
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

  private evidenceRows(runId: string): {
    import: RelayImportRow;
    effects: RelayEffectRow[];
    events: RelayEffectEventRow[];
  } | null {
    const importRow = this.db
      .prepare(
        "SELECT run_id, schema, session_sha256, history_sha256, imported_at, effect_count, event_count FROM relay_evidence_imports WHERE run_id = ?",
      )
      .get(runId) as RelayImportRow | undefined;
    if (importRow === undefined) return null;
    const effects = this.db
      .prepare(
        "SELECT position, effect_id, effect_key, kind, status, coverage, created_at, submitted_at, settled_at, updated_at FROM relay_effects WHERE run_id = ? ORDER BY position",
      )
      .all(runId) as unknown as RelayEffectRow[];
    const events = this.db
      .prepare(
        "SELECT effect_id, seq, from_status, to_status, cause, at FROM relay_effect_events WHERE run_id = ? ORDER BY seq",
      )
      .all(runId) as unknown as RelayEffectEventRow[];
    return { import: importRow, effects, events };
  }

  private toEvidence(rows: {
    import: RelayImportRow;
    effects: RelayEffectRow[];
    events: RelayEffectEventRow[];
  }): StoredRelayEvidence {
    const eventsByEffect = new Map<string, RelayEffectEventRow[]>();
    for (const event of rows.events) {
      const list = eventsByEffect.get(event.effect_id) ?? [];
      list.push(event);
      eventsByEffect.set(event.effect_id, list);
    }
    // Rows are re-validated through the same rules as file input, so a
    // corrupt or hand-edited evidence row fails explicitly on read.
    const doc = validateRelayHistoryDoc({
      schema: rows.import.schema,
      histories: rows.effects.map((effect) => ({
        record: {
          id: effect.effect_id,
          key: effect.effect_key,
          kind: effect.kind,
          status: effect.status,
          createdAt: effect.created_at,
          ...(effect.submitted_at !== null
            ? { submittedAt: effect.submitted_at }
            : {}),
          ...(effect.settled_at !== null
            ? { settledAt: effect.settled_at }
            : {}),
          updatedAt: effect.updated_at,
        },
        events: (eventsByEffect.get(effect.effect_id) ?? []).map((event) => ({
          seq: event.seq,
          effectId: event.effect_id,
          key: effect.effect_key,
          kind: effect.kind,
          ...(event.from_status !== null
            ? { fromStatus: event.from_status }
            : {}),
          toStatus: event.to_status,
          cause: event.cause,
          at: event.at,
        })),
        coverage: effect.coverage,
      })),
    });
    if (
      doc.histories.length !== rows.import.effect_count ||
      doc.histories.reduce((t, h) => t + h.events.length, 0) !==
        rows.import.event_count
    ) {
      throw new AgentLensStorageError(
        `Run ${rows.import.run_id}: evidence row count does not match the recorded import counts`,
      );
    }
    return {
      runId: rows.import.run_id,
      schema: doc.schema,
      sessionSha256: rows.import.session_sha256,
      historySha256: rows.import.history_sha256,
      importedAt: rows.import.imported_at,
      histories: doc.histories,
    };
  }

  /**
   * Reads the Relay evidence attached to a run, or undefined when the run
   * was imported without a `--relay-history` sidecar.
   */
  getRelayEvidence(runId: string): StoredRelayEvidence | undefined {
    if (!this.hasRelayEvidence) return undefined;
    const rows = this.evidenceRows(runId);
    return rows === null ? undefined : this.toEvidence(rows);
  }

  /** All stored Relay evidence, keyed by run id. */
  listRelayEvidence(): Map<string, StoredRelayEvidence> {
    if (!this.hasRelayEvidence) return new Map();
    const runIds = this.db
      .prepare("SELECT run_id FROM relay_evidence_imports")
      .all() as unknown as { run_id: string }[];
    const map = new Map<string, StoredRelayEvidence>();
    for (const { run_id: runId } of runIds) {
      map.set(runId, this.getRelayEvidence(runId) as StoredRelayEvidence);
    }
    return map;
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
