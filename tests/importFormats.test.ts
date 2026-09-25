import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../src/cli/program.js";
import { SqliteTraceStore } from "../src/storage/sqlite/store.js";

const tmpDirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentlens-m6-"));
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

const fixture = (rel: string) =>
  fileURLToPath(new URL(`../${rel}`, import.meta.url));

const runImport = (file: string, db: string, format?: string) => {
  const program = createProgram();
  const args = ["node", "agentlens", "import", file, "--db", db];
  if (format !== undefined) args.push("--format", format);
  return program.parseAsync(args);
};

describe("agentlens import --format", () => {
  it("imports a generic JSONL run end-to-end", async () => {
    const dir = tmpDir();
    const db = join(dir, "agentlens.db");
    process.exitCode = 0;
    await runImport(
      fixture("fixtures/generic/generic-success.jsonl"),
      db,
      "generic",
    );
    expect(process.exitCode).toBe(0);
    const store = SqliteTraceStore.open(db);
    try {
      const run = store.getRun("gen-success-1");
      expect(run.status).toBe("passed");
      expect(run.events).toHaveLength(6);
      expect(run.events[3]?.parentId).toBe(run.events[2]?.id);
    } finally {
      store.close();
    }
  });

  it("imports a Pi session end-to-end with normalized tool calls and status", async () => {
    const dir = tmpDir();
    const db = join(dir, "agentlens.db");
    process.exitCode = 0;
    await runImport(fixture("fixtures/pi/pi-session-error.jsonl"), db, "pi");
    expect(process.exitCode).toBe(0);
    const store = SqliteTraceStore.open(db);
    try {
      const run = store.getRun("ffae836b-9420-4060-ac13-7745215f90fe");
      expect(run.status).toBe("failed");
      expect(run.agent).toBe("pi");
      expect(run.events.at(-1)?.type).toBe("run.failed");
      expect(run.events.filter((e) => e.type === "tool.failed")).toHaveLength(
        3,
      );
    } finally {
      store.close();
    }
  });

  it("defaults to agentlens-trace and keeps M2 imports working", async () => {
    const dir = tmpDir();
    const db = join(dir, "agentlens.db");
    process.exitCode = 0;
    // A valid agentlens-trace file must still import with no --format flag.
    const file = join(dir, "trace.jsonl");
    writeFileSync(
      file,
      `${[
        JSON.stringify({
          format: "agentlens-trace",
          formatVersion: 1,
          kind: "run",
          run: {
            id: "r-m2",
            startedAt: "2026-09-25T10:00:00.000Z",
            status: "passed",
            metrics: { toolCalls: 0, failedToolCalls: 0 },
          },
        }),
        JSON.stringify({
          format: "agentlens-trace",
          formatVersion: 1,
          kind: "event",
          event: {
            id: "e1",
            runId: "r-m2",
            timestamp: "2026-09-25T10:00:00.000Z",
            type: "run.completed",
            data: null,
          },
        }),
      ].join("\n")}\n`,
    );
    await runImport(file, db);
    expect(process.exitCode).toBe(0);
    const store = SqliteTraceStore.open(db);
    try {
      expect(store.getRun("r-m2").status).toBe("passed");
    } finally {
      store.close();
    }
  });

  it("refuses to guess: a Pi file under the default format fails explicitly", async () => {
    const dir = tmpDir();
    const db = join(dir, "agentlens.db");
    process.exitCode = 0;
    await runImport(fixture("fixtures/pi/pi-session-success.jsonl"), db);
    expect(process.exitCode).toBe(1);
    expect(() => SqliteTraceStore.openReadOnly(db)).toThrow();
  });

  it("rejects an unknown --format", async () => {
    const dir = tmpDir();
    const db = join(dir, "agentlens.db");
    process.exitCode = 0;
    await runImport(
      fixture("fixtures/generic/generic-success.jsonl"),
      db,
      "codex",
    );
    expect(process.exitCode).toBe(1);
  });

  it("rejects a duplicate run id atomically across formats", async () => {
    const dir = tmpDir();
    const db = join(dir, "agentlens.db");
    process.exitCode = 0;
    await runImport(fixture("fixtures/pi/pi-session-success.jsonl"), db, "pi");
    expect(process.exitCode).toBe(0);
    process.exitCode = 0;
    // Same session id via a second import must fail and leave the run intact.
    await runImport(fixture("fixtures/pi/pi-session-success.jsonl"), db, "pi");
    expect(process.exitCode).toBe(1);
    const store = SqliteTraceStore.open(db);
    try {
      expect(
        store.getRun("ffae836b-9420-4060-ac13-7745215f90ff").events,
      ).toHaveLength(11);
    } finally {
      store.close();
    }
  });

  it("fails atomically on a truncated Pi file: no partial run is stored", async () => {
    const dir = tmpDir();
    const db = join(dir, "agentlens.db");
    const file = join(dir, "truncated.jsonl");
    const full = readFileSync(
      fixture("fixtures/pi/pi-session-success.jsonl"),
      "utf8",
    );
    writeFileSync(file, full.slice(0, full.length / 2));
    process.exitCode = 0;
    await runImport(file, db, "pi");
    expect(process.exitCode).toBe(1);
    expect(() => SqliteTraceStore.openReadOnly(db)).toThrow();
  });

  it("fails atomically on a malformed generic file", async () => {
    const dir = tmpDir();
    const db = join(dir, "agentlens.db");
    const file = join(dir, "bad.jsonl");
    writeFileSync(
      file,
      '{"format":"agentlens-generic","formatVersion":1,"kind":"run","run":{"id":"x","startedAt":"2026-09-25T10:00:00.000Z"}}\n{broken\n',
    );
    process.exitCode = 0;
    await runImport(file, db, "generic");
    expect(process.exitCode).toBe(1);
    expect(() => SqliteTraceStore.openReadOnly(db)).toThrow();
  });
});
