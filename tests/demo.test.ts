import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
