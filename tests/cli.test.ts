import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_NAME, CLI_VERSION, createProgram } from "../src/cli/program.js";
import { Recorder } from "../src/core/recorder.js";
import { serializeRunTraceJsonl } from "../src/schema/traceJsonl.js";
import { SqliteTraceStore } from "../src/storage/sqlite/store.js";

const tmpDirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentlens-cli-"));
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

const jsonlFile = (dir: string) => {
  const store = SqliteTraceStore.open(":memory:");
  const rec = new Recorder({ store });
  const run = rec.startRun({ id: "imported-run", agent: "cli-test" });
  const t = run.emit("tool.started", { tool: "x" });
  run.emit("tool.completed", { tool: "x", success: true }, { parentId: t.id });
  const finished = run.completeRun();
  store.close();
  const file = join(dir, "trace.jsonl");
  writeFileSync(file, serializeRunTraceJsonl(finished));
  return file;
};

const runImport = (file: string, db: string) => {
  const program = createProgram();
  return program.parseAsync(["node", "agentlens", "import", file, "--db", db]);
};

const resetExitCode = () => {
  process.exitCode = 0;
};

describe("agentlens CLI", () => {
  it("shows the project name and entry point in help", () => {
    const help = createProgram().helpInformation();
    expect(help).toContain(`Usage: ${CLI_NAME}`);
    expect(help).toContain("AgentLens");
    expect(help).toContain("--help");
  });

  it("exposes only the implemented commands", () => {
    const program = createProgram();
    expect(program.commands.map((c) => c.name())).toEqual([
      "import",
      "runs",
      "inspect",
    ]);
    expect(createProgram().helpInformation()).toContain(
      "Not yet implemented: show, diff",
    );
  });

  it("exposes a version", () => {
    expect(createProgram().version()).toBe(CLI_VERSION);
  });
});

describe("agentlens import", () => {
  it("imports a valid trace file and preserves the run", async () => {
    const dir = tmpDir();
    const file = jsonlFile(dir);
    const db = join(dir, "agentlens.db");

    resetExitCode();
    await runImport(file, db);
    expect(process.exitCode).toBe(0);

    const store = SqliteTraceStore.open(db);
    try {
      const run = store.getRun("imported-run");
      expect(run.events.map((e) => e.type)).toEqual([
        "run.started",
        "tool.started",
        "tool.completed",
        "run.completed",
      ]);
      expect(run.events[2]?.parentId).toBe(run.events[1]?.id);
      expect(run.status).toBe("passed");
    } finally {
      store.close();
    }
  });

  it("fails on an invalid file and leaves the database empty", async () => {
    const dir = tmpDir();
    const file = join(dir, "bad.jsonl");
    writeFileSync(file, "{oops\n");
    const db = join(dir, "agentlens.db");

    resetExitCode();
    await runImport(file, db);
    expect(process.exitCode).toBe(1);

    const store = SqliteTraceStore.open(db);
    try {
      expect(store.listRunIds()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rejects a duplicate run id atomically", async () => {
    const dir = tmpDir();
    const file = jsonlFile(dir);
    const db = join(dir, "agentlens.db");

    resetExitCode();
    await runImport(file, db);
    resetExitCode();
    await runImport(file, db); // second import must fail
    expect(process.exitCode).toBe(1);

    const store = SqliteTraceStore.open(db);
    try {
      expect(store.listRunIds()).toEqual(["imported-run"]);
      expect(store.getRun("imported-run").events).toHaveLength(4);
    } finally {
      store.close();
    }
  });

  it("fails on a missing file", async () => {
    const dir = tmpDir();
    resetExitCode();
    await runImport(join(dir, "nope.jsonl"), join(dir, "agentlens.db"));
    expect(process.exitCode).toBe(1);
    expect(() => readFileSync(join(dir, "nope.jsonl"))).toThrow();
  });
});
