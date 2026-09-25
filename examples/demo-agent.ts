/**
 * Demo agent: a tiny fake harness that records the acceptance trace
 * Run Start → Tool → Tool → Error → Tool → Complete through the SDK
 * Recorder, then exports the same run as agentlens-trace JSONL.
 *
 * Usage: pnpm demo [--db <path>] [--jsonl <path>]
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Recorder } from "../src/core/recorder.js";
import { serializeRunTraceJsonl } from "../src/schema/traceJsonl.js";
import {
  defaultDbPath,
  SqliteTraceStore,
} from "../src/storage/sqlite/store.js";

export interface DemoResult {
  runId: string;
  dbPath: string;
  jsonlPath: string;
}

/**
 * Runs the demo agent against `dbPath` and writes the JSONL export to
 * `jsonlPath`. Tool calls are fake (the point is the recorded events).
 */
export function runDemoAgent(
  dbPath: string,
  jsonlPath: string,
  now: () => string = () => new Date().toISOString(),
): DemoResult {
  const store = SqliteTraceStore.open(dbPath);
  try {
    const recorder = new Recorder({ store, now });
    const run = recorder.startRun({
      agent: "demo-agent",
      model: "demo-model",
    });

    // Tool 1: read a file.
    const t1 = run.emit("tool.started", {
      tool: "read_file",
      input: { path: "src/app.ts" },
    });
    run.emit(
      "tool.completed",
      {
        tool: "read_file",
        output: { lines: 42 },
        durationMs: 30,
        success: true,
      },
      { parentId: t1.id },
    );

    // Tool 2: a search that reports a failed outcome.
    const t2 = run.emit("tool.started", {
      tool: "grep",
      input: { pattern: "TODO" },
    });
    run.emit(
      "tool.failed",
      {
        tool: "grep",
        durationMs: 12,
        success: false,
        error: "binary file skipped",
      },
      { parentId: t2.id },
    );

    // The agent notices the failure but keeps going.
    run.emit("error", { message: "grep failed; falling back to file scan" });

    // Tool 3: write the result.
    const t3 = run.emit("tool.started", {
      tool: "write_file",
      input: { path: "out/report.md" },
    });
    run.emit(
      "tool.completed",
      {
        tool: "write_file",
        output: { bytes: 512 },
        durationMs: 20,
        success: true,
      },
      { parentId: t3.id },
    );

    const finished = run.completeRun();
    writeFileSync(jsonlPath, serializeRunTraceJsonl(finished));
    return { runId: finished.id, dbPath, jsonlPath };
  } finally {
    store.close();
  }
}

// True when executed as a script (`tsx examples/demo-agent.ts`): argv[1] is
// an OS path (e.g. C:\... on Windows) while import.meta.url is a file URL —
// compare resolved paths, never a string prefix of the URL.
const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  const args = process.argv.slice(2);
  const opt = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    const value = i >= 0 ? args[i + 1] : undefined;
    return value !== undefined ? value : fallback;
  };
  const cwd = process.cwd();
  const result = runDemoAgent(
    opt("--db", defaultDbPath(cwd)),
    opt("--jsonl", join(cwd, "demo-trace.jsonl")),
  );
  console.log(
    `Recorded demo run ${result.runId}\n` +
      `  database: ${result.dbPath}\n` +
      `  jsonl:    ${result.jsonlPath}\n` +
      `  try:      agentlens import ${result.jsonlPath} --db <other.db>`,
  );
}
