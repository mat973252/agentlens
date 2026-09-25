import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runDemoAgent } from "../examples/demo-agent.js";
import { parseRunTraceJsonl } from "../src/schema/traceJsonl.js";
import { SqliteTraceStore } from "../src/storage/sqlite/store.js";

const tmpDirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentlens-demo-"));
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

describe("demo agent", () => {
  it("records start -> tool -> tool -> error -> tool -> complete and re-imports identically", () => {
    const dir = tmpDir();
    const db = join(dir, "agentlens.db");
    const jsonl = join(dir, "trace.jsonl");
    const result = runDemoAgent(db, jsonl);

    const store = SqliteTraceStore.open(db);
    const recorded = store.getRun(result.runId);
    store.close();

    expect(recorded.events.map((e) => e.type)).toEqual([
      "run.started",
      "tool.started",
      "tool.completed",
      "tool.started",
      "tool.failed",
      "error",
      "tool.started",
      "tool.completed",
      "run.completed",
    ]);
    expect(recorded.status).toBe("passed");
    expect(recorded.agent).toBe("demo-agent");
    expect(recorded.metrics.failedToolCalls).toBe(1);

    // The exported JSONL preserves ids, order, parentIds, times and data.
    const exported = readFileSync(jsonl, "utf8");
    const parsed = parseRunTraceJsonl(exported).run;
    expect(parsed).toEqual(recorded);

    // Import into a fresh database keeps the same run end to end.
    const db2 = join(dir, "imported.db");
    const store2 = SqliteTraceStore.open(db2);
    store2.saveRun(parsed);
    expect(store2.getRun(result.runId)).toEqual(recorded);
    store2.close();
  });

  // Regression: the demo's entry-point guard must fire on every OS. On
  // Windows argv[1] is `C:\path\demo-agent.ts` while import.meta.url is a
  // `file:///C:/...` URL, so a string/URL comparison silently skipped main.
  it("runs end to end when invoked as a script entry point", () => {
    const dir = tmpDir();
    const db = join(dir, "script.db");
    const jsonl = join(dir, "script-trace.jsonl");
    const tsx = createRequire(import.meta.url).resolve("tsx/cli");
    const demo = fileURLToPath(
      new URL("../examples/demo-agent.ts", import.meta.url),
    );

    const proc = spawnSync(
      process.execPath,
      [tsx, demo, "--db", db, "--jsonl", jsonl],
      { encoding: "utf8" },
    );

    // stderr may carry Node's node:sqlite ExperimentalWarning; only the exit
    // status and outputs prove the entry point ran.
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("Recorded demo run");
    expect(existsSync(db)).toBe(true);
    expect(existsSync(jsonl)).toBe(true);
    expect(parseRunTraceJsonl(readFileSync(jsonl, "utf8")).run.status).toBe(
      "passed",
    );
  });
});
