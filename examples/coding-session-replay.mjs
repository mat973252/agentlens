// Replay one sanitized real session; this does not invoke a model or its tools.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Recorder, SqliteTraceStore } from "../dist/index.js";

const fixtureUrl = new URL(
  "./fixtures/permit-coding-session.json",
  import.meta.url,
);
const fixtureBytes = readFileSync(fixtureUrl);
const fixture = JSON.parse(fixtureBytes);
const session = fixture.session;
assert.equal(session.result, "accepted_single_coding_smoke");
assert.equal(session.calls.length, 10);
const directory = process.argv[2]
  ? resolve(process.argv[2])
  : mkdtempSync(join(tmpdir(), "agentlens-coding-replay-"));
if (process.argv[2]) mkdirSync(directory); // Never overwrite an existing trace.
const database = join(directory, "replay.db");
const store = SqliteTraceStore.open(database);
try {
  for (const projection of ["full", "prefix"]) {
    let sequence = 0;
    const run = new Recorder({
      store,
      persistence: "incremental",
      newId: () => `${projection}-e${++sequence}`,
    }).startRun({
      id: `java-${projection}`,
      agent: "maintainer-coding-session-replay",
      model: session.model,
      data: {
        projection,
        source: fixture.source,
        sourceResult: session.result,
        timestampMeaning: "replay time, not original session wall time",
        originalRecoveryMs: session.recoveryMs,
        originalReviewWaitMs: session.sourceReviewWaitMs,
      },
    });
    for (const [index, call] of session.calls.entries()) {
      const started = run.emit("tool.started", { tool: call.tool });
      // Deliberately stop before the sixth tool's outcome. This is not a crash.
      if (projection === "prefix" && index === 5) break;
      const completed = run.emit(
        call.success ? "tool.completed" : "tool.failed",
        {
          tool: call.tool,
          success: call.success,
          durationMs: call.elapsedMs,
          output: { sourceCallIndex: index, recordedCall: call },
        },
        { parentId: started.id },
      );
      if (call.exitCode !== undefined && call.exitCode !== 0) {
        run.emit(
          "error",
          {
            message: `Recorded test command exited ${call.exitCode}; tool transport succeeded`,
            derived: true,
            basis: "source call exitCode, not a recorded source error event",
            sourceCallIndex: index,
          },
          { parentId: completed.id },
        );
      }
    }
    if (projection === "full") run.completeRun();
  }
} finally {
  store.close();
}

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
function inspect(args, filename, expectedExit = 0) {
  const result = spawnSync(process.execPath, [cli, ...args, "--db", database], {
    encoding: "utf8",
  });
  assert.equal(result.status, expectedExit, result.stderr);
  writeFileSync(join(directory, filename), result.stdout);
  return result.stdout;
}
const full = JSON.parse(
  inspect(["inspect", "java-full", "--json"], "full.json"),
).run;
const prefix = JSON.parse(
  inspect(["inspect", "java-prefix", "--json"], "prefix.json"),
).run;
assert.equal(full.status, "passed");
assert.equal(full.events.length, 23);
assert.equal(full.metrics.toolCalls, 10);
assert.equal(full.metrics.failedToolCalls, 0);
const errors = full.events.filter((event) => event.type === "error");
assert.equal(errors.length, 1);
assert.equal(errors[0].data.derived, true);
assert.equal(prefix.status, "running");
assert.equal(prefix.endedAt, undefined);
assert.equal(prefix.events.length, 12);
assert.equal(prefix.metrics.toolCalls, 5);
assert.equal(prefix.events.at(-1).type, "tool.started");
const summary = inspect(
  ["inspect", "java-prefix", "--summary"],
  "prefix-summary.txt",
);
assert.match(summary, /starts without recorded outcome: 1/);
const fullSummary = inspect(
  ["inspect", "java-full", "--summary"],
  "full-summary.txt",
);
assert.match(fullSummary, /Recorded error\/failure signals: 1/);
const gate = JSON.parse(
  inspect(
    [
      "diff",
      "java-full",
      "java-prefix",
      "--json",
      "--check",
      "status",
      "--check",
      "toolCalls=0",
      "--check",
      "errors=0",
      "--check",
      "inputTokens=0",
    ],
    "incomplete-gate.json",
    3,
  ),
).gate;
assert.equal(gate.status, "insufficient_data");
assert.equal(gate.checks.length, 4);
assert.ok(gate.checks.every((check) => check.status === "insufficient_data"));
for (const run of [full, prefix]) {
  for (const metric of ["inputTokens", "outputTokens", "reasoningTokens"]) {
    assert.equal(run.metrics[metric], undefined);
  }
}
assert.equal(gate.checks[3].a, null);
assert.equal(gate.checks[3].b, null);
const evidence = {
  schema: "agentlens.coding-replay/1",
  source: fixture.source,
  fixtureSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
  scriptSha256: createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest("hex"),
  runtime: process.version,
  projections: {
    fullEvents: full.events.length,
    prefixEvents: prefix.events.length,
  },
  gateExit: 3,
  boundary:
    "Two projections of one maintainer session, not independent runs, live capture, a crash experiment or a performance comparison",
};
writeFileSync(
  join(directory, "evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(JSON.stringify({ directory, ...evidence }, null, 2));
