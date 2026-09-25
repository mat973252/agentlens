import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/program.js";
import { deserializeRunTrace } from "../src/schema/trace.js";
import { SqliteTraceStore } from "../src/storage/sqlite/store.js";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures", import.meta.url));

const tmpDirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentlens-view-"));
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

/** Builds a database from an M1 fixture, importing several runs. */
const fixtureDb = (dir: string, files: string[]): string => {
  const db = join(dir, "agentlens.db");
  const store = SqliteTraceStore.open(db);
  try {
    for (const file of files) {
      const doc = deserializeRunTrace(
        readFileSync(join(FIXTURES_DIR, file), "utf8"),
      );
      store.saveRun(doc.run);
    }
  } finally {
    store.close();
  }
  return db;
};

const runCli = async (args: string[]): Promise<string> => {
  process.exitCode = 0;
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await createProgram().parseAsync(["node", "agentlens", ...args]);
  } finally {
    spy.mockRestore();
    errSpy.mockRestore();
  }
  return writes.join("");
};

const digest = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

describe("agentlens runs", () => {
  it("lists runs in stable order with status, model and tool metrics", async () => {
    const dir = tmpDir();
    const db = fixtureDb(dir, [
      "success-basic.json",
      "tool-failure-recovered.json",
      "cancelled.json",
    ]);

    const first = await runCli(["runs", "--db", db]);
    const second = await runCli(["runs", "--db", db]);
    expect(process.exitCode).toBe(0);
    expect(first).toBe(second);
    expect(first).toContain("ID");
    expect(first).toContain("run-success-basic");
    expect(first).toContain("run-tool-failure-recovered");
    expect(first).toContain("passed");
    expect(first).toContain("cancelled");
  });

  it("reports an empty store", async () => {
    const dir = tmpDir();
    const db = fixtureDb(dir, []);
    const out = await runCli(["runs", "--db", db]);
    expect(process.exitCode).toBe(0);
    expect(out).toContain("No runs recorded");
  });
});

describe("agentlens inspect", () => {
  it("shows metadata, tools, errors, metrics, timeline and result", async () => {
    const dir = tmpDir();
    const db = fixtureDb(dir, ["tool-failure-recovered.json"]);

    const out = await runCli([
      "inspect",
      "run-tool-failure-recovered",
      "--db",
      db,
    ]);
    expect(process.exitCode).toBe(0);
    expect(out).toContain("Run run-tool-failure-recovered");
    expect(out).toContain("Status    passed");
    expect(out).toContain("Agent     generic-agent");
    expect(out).toContain("Model     model-a");
    expect(out).toContain("Tool calls");
    expect(out).toContain("run_test");
    expect(out).toContain("failed");
    expect(out).toContain("edit_file");
    expect(out).toContain("Errors");
    expect(out).toContain("Timeline");
    expect(out).toContain("run.started");
    expect(out).toContain("run.completed");
    expect(out).toContain("Result");
    // Events appear in stored order.
    expect(out.indexOf("run.started")).toBeLessThan(
      out.indexOf("run.completed"),
    );
  });

  it("shows explicit endedAt in runs and tool io plus final payload in inspect", async () => {
    const dir = tmpDir();
    const db = fixtureDb(dir, ["success-basic.json"]);

    const table = await runCli(["runs", "--db", db]);
    expect(process.exitCode).toBe(0);
    const row = table.split("\n").find((l) => l.includes("run-success-basic"));
    expect(row).toContain("2026-09-20T10:00:00.000Z");
    expect(row).toContain("2026-09-20T10:01:12.400Z");

    const out = await runCli(["inspect", "run-success-basic", "--db", db]);
    expect(out).toContain('"path":"src/app.test.ts"');
    expect(out).toContain('"bytes":2048');
    expect(out).toContain('"passed":12');
    expect(out).toContain('"failed":0');
    expect(out).toContain('"summary":"fixed flaky test"');
  });

  it("shows a placeholder for a running run's missing endedAt", async () => {
    const dir = tmpDir();
    const db = fixtureDb(dir, ["running-partial.json"]);
    const table = await runCli(["runs", "--db", db]);
    const row = table
      .split("\n")
      .find((l) => l.includes("run-running-partial"));
    expect(row).toBeDefined();
    // endedAt placeholder renders as "-" between startedAt and duration
    expect(row).toMatch(/running.*\s-\s+-?\s*\d/);
  });

  it("produces identical output on repeated inspection", async () => {
    const dir = tmpDir();
    const db = fixtureDb(dir, ["success-planned.json"]);
    const a = await runCli(["inspect", "run-success-planned", "--db", db]);
    const b = await runCli(["inspect", "run-success-planned", "--db", db]);
    expect(a).toBe(b);
  });

  it("fails clearly on an unknown run id", async () => {
    const dir = tmpDir();
    const db = fixtureDb(dir, ["success-basic.json"]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
    await createProgram().parseAsync([
      "node",
      "agentlens",
      "inspect",
      "no-such-run",
      "--db",
      db,
    ]);
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Run not found: no-such-run"),
    );
    errSpy.mockRestore();
  });
});

describe("read-only guarantees", () => {
  it("does not create a missing database or its directory", async () => {
    const dir = tmpDir();
    const db = join(dir, "missing", "agentlens.db");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
    await createProgram().parseAsync(["node", "agentlens", "runs", "--db", db]);
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Database not found"),
    );
    errSpy.mockRestore();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves the database byte-identical and creates no wal/journal", async () => {
    const dir = tmpDir();
    const db = fixtureDb(dir, ["success-basic.json"]);
    const before = digest(db);
    const beforeMtime = statSync(db).mtimeMs;

    await runCli(["runs", "--db", db]);
    await runCli(["inspect", "run-success-basic", "--db", db]);

    expect(digest(db)).toBe(before);
    expect(statSync(db).mtimeMs).toBe(beforeMtime);
    expect(
      readdirSync(dir).filter(
        (f) => f.endsWith("-wal") || f.endsWith("-journal"),
      ),
    ).toEqual([]);
  });

  it("fails clearly on a corrupt (non-SQLite) file", async () => {
    const dir = tmpDir();
    const db = join(dir, "agentlens.db");
    writeFileSync(db, "not a sqlite database at all");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
    await createProgram().parseAsync(["node", "agentlens", "runs", "--db", db]);
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("corrupt or not a SQLite database"),
    );
    errSpy.mockRestore();
  });

  it("fails clearly on an unsupported future schema version", async () => {
    const dir = tmpDir();
    const db = fixtureDb(dir, ["success-basic.json"]);
    const store = SqliteTraceStore.open(db);
    store.database.exec("PRAGMA user_version = 99");
    store.close();

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
    await createProgram().parseAsync([
      "node",
      "agentlens",
      "inspect",
      "run-success-basic",
      "--db",
      db,
    ]);
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unsupported database schema version 99"),
    );
    errSpy.mockRestore();
  });

  it("fails clearly on a SQLite file that is not an AgentLens store", async () => {
    const dir = tmpDir();
    const db = join(dir, "other.db");
    const { DatabaseSync } = await import("node:sqlite");
    const other = new DatabaseSync(db);
    other.exec("CREATE TABLE unrelated (id TEXT)");
    other.close();

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
    await createProgram().parseAsync(["node", "agentlens", "runs", "--db", db]);
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("not an AgentLens store"),
    );
    errSpy.mockRestore();
  });
});
