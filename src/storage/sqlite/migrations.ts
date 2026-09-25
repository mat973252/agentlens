import type { DatabaseSync } from "node:sqlite";
import {
  AgentLensStorageError,
  UnsupportedSchemaVersionError,
} from "../../core/errors.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Applies pending migrations in order, each in its own transaction.
 * Tracks progress in `PRAGMA user_version`. Throws explicitly when the
 * database was created by a newer AgentLens (user_version above target)
 * or a migration fails — never leaves a half-applied migration.
 */
export function applyMigrations(
  db: DatabaseSync,
  migrations: Migration[],
): number {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev && cur && cur.version <= prev.version) {
      throw new AgentLensStorageError(
        `Invalid migration list: version ${cur.version} is not increasing`,
      );
    }
  }
  const target = sorted.at(-1)?.version ?? 0;
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined;
  const current = Number(row?.user_version ?? 0);
  if (current > target) {
    throw new UnsupportedSchemaVersionError(current, target, "database");
  }
  for (const migration of sorted) {
    if (migration.version <= current) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${Math.trunc(migration.version)}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new AgentLensStorageError(
        `Migration ${migration.version} (${migration.name}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }
  return target;
}

/** M1 schema: runs + ordered events. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "m1-event-schema",
    sql: `
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        agent TEXT,
        model TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'cancelled')),
        metrics_json TEXT NOT NULL
      );

      CREATE TABLE events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        parent_id TEXT,
        data_json TEXT NOT NULL,
        PRIMARY KEY (run_id, id),
        UNIQUE (run_id, seq),
        FOREIGN KEY (run_id, parent_id)
          REFERENCES events (run_id, id)
      );

      CREATE INDEX idx_events_run_seq ON events (run_id, seq);
      CREATE INDEX idx_events_run_type ON events (run_id, type);
    `,
  },
];
