import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentLensStorageError,
  UnsupportedSchemaVersionError,
} from "../src/core/errors.js";
import { deserializeRunTrace } from "../src/schema/trace.js";
import { applyMigrations } from "../src/storage/sqlite/migrations.js";
import {
  defaultDbPath,
  SqliteTraceStore,
} from "../src/storage/sqlite/store.js";

const loadRun = (name: string) =>
  deserializeRunTrace(
    readFileSync(
      fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  ).run;

const tmpDirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentlens-test-"));
  tmpDirs.push(dir);
  return dir;
};

afterEach(() => {
  let dir = tmpDirs.pop();
  while (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = tmpDirs.pop();
  }
});

describe("SqliteTraceStore", () => {
  it("migrates a fresh database to schema version 2", () => {
    const store = SqliteTraceStore.open(":memory:");
    try {
      const version = store.database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      expect(version.user_version).toBe(2);
    } finally {
      store.close();
    }
  });

  it("persists and reads back a run with ordered events", () => {
    const store = SqliteTraceStore.open(":memory:");
    try {
      const run = loadRun("success-planned.json");
      store.saveRun(run);
      const read = store.getRun(run.id);
      expect(read).toEqual(run);
      expect(read.events.map((e) => e.id)).toEqual(run.events.map((e) => e.id));
    } finally {
      store.close();
    }
  });

  it("persists across reopen and applies migrations idempotently", () => {
    const dbPath = join(tmpDir(), "agentlens.db");
    const run = loadRun("retry-success.json");
    const first = SqliteTraceStore.open(dbPath);
    first.saveRun(run);
    first.close();

    const second = SqliteTraceStore.open(dbPath);
    try {
      expect(second.getRun(run.id)).toEqual(run);
      const version = second.database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      expect(version.user_version).toBe(2);
    } finally {
      second.close();
    }
  });

  it("keeps multiple runs in one database", () => {
    const store = SqliteTraceStore.open(":memory:");
    try {
      const a = loadRun("success-basic.json");
      const b = loadRun("timeout.json");
      store.saveRun(a);
      store.saveRun(b);
      expect(store.listRunIds().sort()).toEqual([a.id, b.id].sort());
      expect(store.getRun(b.id)).toEqual(b);
    } finally {
      store.close();
    }
  });

  it("rejects a database created by a newer schema version", () => {
    const dbPath = join(tmpDir(), "future.db");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 99");
    db.close();
    expect(() => SqliteTraceStore.open(dbPath)).toThrow(
      UnsupportedSchemaVersionError,
    );
    // A failed open must release its handle: on Windows an open
    // database file cannot be deleted (EPERM).
    expect(() => rmSync(dbPath)).not.toThrow();
  });

  it("rejects invalid run input and persists nothing", () => {
    const store = SqliteTraceStore.open(":memory:");
    try {
      expect(() => store.saveRun({ id: "bad", status: "passed" })).toThrow(
        /Invalid Run/,
      );
      expect(store.listRunIds()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rejects a duplicate run id", () => {
    const store = SqliteTraceStore.open(":memory:");
    try {
      const run = loadRun("success-basic.json");
      store.saveRun(run);
      expect(() => store.saveRun(run)).toThrow(AgentLensStorageError);
      expect(() => store.saveRun(run)).toThrow(/Failed to save run/);
    } finally {
      store.close();
    }
  });

  it("throws when reading a missing run", () => {
    const store = SqliteTraceStore.open(":memory:");
    try {
      expect(() => store.getRun("nope")).toThrow(/Run not found: nope/);
    } finally {
      store.close();
    }
  });

  it("fails explicitly on corrupt stored data instead of returning mangled events", () => {
    const store = SqliteTraceStore.open(":memory:");
    try {
      const run = loadRun("success-basic.json");
      store.saveRun(run);
      store.database.exec(
        `UPDATE events SET type = 'bogus.type' WHERE run_id = '${run.id}' AND seq = 0`,
      );
      expect(() => store.getRun(run.id)).toThrow(/invalid state|Invalid Run/);
      store.database.exec(
        `UPDATE events SET data_json = '{oops' WHERE run_id = '${run.id}' AND seq = 1`,
      );
      expect(() => store.getRun(run.id)).toThrow(/data_json is not valid JSON/);
    } finally {
      store.close();
    }
  });
});

describe("applyMigrations", () => {
  it("rolls back a failing migration and leaves earlier versions applied", () => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(() =>
        applyMigrations(db, [
          {
            version: 1,
            name: "ok",
            sql: "CREATE TABLE t1 (id INTEGER PRIMARY KEY)",
          },
          { version: 2, name: "bad", sql: "THIS IS NOT SQL" },
        ]),
      ).toThrow(/Migration 2 \(bad\) failed/);
      const version = db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      expect(version.user_version).toBe(1);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='t1'").all(),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("rejects a non-increasing migration list", () => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(() =>
        applyMigrations(db, [
          { version: 2, name: "two", sql: "CREATE TABLE t2 (id INTEGER)" },
          { version: 2, name: "dup", sql: "CREATE TABLE t3 (id INTEGER)" },
        ]),
      ).toThrow(/not increasing/);
    } finally {
      db.close();
    }
  });

  it("defaults the database path under .agentlens", () => {
    expect(defaultDbPath("/some/dir")).toBe(
      join("/some/dir", ".agentlens", "agentlens.db"),
    );
  });
});
