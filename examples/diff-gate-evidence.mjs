// Fixed synthetic task, real local file reads/calculation/verification; no LLM or network.
// Build first, then: node examples/diff-gate-evidence.mjs [new-output-directory]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const hashBuild = () =>
  Object.fromEntries(
    readdirSync(dist)
      .filter((name) => name.endsWith(".js"))
      .sort()
      .map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(join(dist, name)))
          .digest("hex"),
      ]),
  );
const builtFilesSha256 = hashBuild();
const { Recorder, SqliteTraceStore, serializeRunTraceJsonl } = await import(
  "../dist/index.js"
);

const directory = process.argv[2]
  ? resolve(process.argv[2])
  : mkdtempSync(join(tmpdir(), "agentlens-diff-evidence-"));
if (process.argv[2]) mkdirSync(directory); // Refuse to overwrite an existing evidence directory.
const orders = [
  { id: "fixture-a", paid: true, amountCents: 500 },
  { id: "fixture-b", paid: false, amountCents: 900 },
  { id: "fixture-c", paid: true, amountCents: 700 },
];
const input = `${JSON.stringify(orders, null, 2)}\n`;
writeFileSync(join(directory, "orders.json"), input);
const database = join(directory, "traces.db");
const store = SqliteTraceStore.open(database);
const runs = [];
try {
  for (const variant of ["baseline", "candidate"]) {
    let seq = 0;
    const recorder = new Recorder({
      store,
      persistence: "incremental",
      newId: () => `${variant}-e${++seq}`,
    });
    const run = recorder.startRun({
      id: variant,
      agent: "synthetic-local-invoice-task",
    });
    function tool(name, args, execute) {
      const started = run.emit("tool.started", { tool: name, input: args });
      const start = performance.now();
      try {
        const result = execute();
        run.emit(
          "tool.completed",
          {
            tool: name,
            success: true,
            durationMs: performance.now() - start,
            output: result,
          },
          { parentId: started.id },
        );
        return result;
      } catch {
        run.emit(
          "tool.failed",
          {
            tool: name,
            success: false,
            durationMs: performance.now() - start,
            error: `${name} failed on synthetic fixture`,
          },
          { parentId: started.id },
        );
        throw new Error(`${name} failed on synthetic fixture`);
      }
    }
    let recorded;
    try {
      if (variant === "candidate") {
        // Controlled extra stale-cache lookup: its real ENOENT is recorded, then recovered.
        try {
          tool("read-json", { path: "orders-cache.json" }, () =>
            JSON.parse(
              readFileSync(join(directory, "orders-cache.json"), "utf8"),
            ),
          );
        } catch {
          /* fall back to the source fixture */
        }
      }
      const data = tool("read-json", { path: "orders.json" }, () =>
        JSON.parse(readFileSync(join(directory, "orders.json"), "utf8")),
      );
      // Controlled candidate bug: totals all invoices instead of paid invoices.
      const total = tool(
        "sum-invoices",
        { paidOnly: variant === "baseline" },
        () =>
          data
            .filter((row) => variant === "candidate" || row.paid)
            .reduce((sum, row) => sum + row.amountCents, 0),
      );
      tool("verify-total", { expectedCents: 1200, actualCents: total }, () => {
        assert.equal(total, 1200);
        return { verified: true };
      });
      recorded = run.completeRun();
    } catch (error) {
      recorded = run.failRun(error);
    }
    runs.push(recorded);
    writeFileSync(
      join(directory, `${variant}.jsonl`),
      serializeRunTraceJsonl(recorded),
    );
  }
} finally {
  store.close();
}
assert.equal(runs[0].status, "passed");
assert.equal(runs[1].status, "failed");

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const compare = (rules, name, expectedExit) => {
  const args = [
    cli,
    "diff",
    "baseline",
    "candidate",
    "--db",
    database,
    "--json",
    ...rules.flatMap((rule) => ["--check", rule]),
  ];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(result.status, expectedExit, result.stderr);
  const report = JSON.parse(result.stdout);
  writeFileSync(join(directory, name), result.stdout);
  return report;
};
const regression = compare(
  ["status", "errors=0", "toolCalls=0", "inputTokens=0"],
  "gate.json",
  2,
);
assert.equal(regression.gate.status, "regression");
const [status, errors, calls, tokens] = regression.gate.checks;
assert.deepEqual(
  [status.a, status.b, status.status],
  ["passed", "failed", "regression"],
);
assert.deepEqual(
  [errors.a, errors.b, errors.delta, errors.status],
  [0, 2, 2, "regression"],
);
assert.deepEqual(errors.eventIds, {
  a: [],
  b: ["candidate-e3", "candidate-e9"],
});
assert.deepEqual(
  [calls.a, calls.b, calls.delta, calls.status],
  [3, 4, 1, "regression"],
);
assert.deepEqual(
  [tokens.a, tokens.b, tokens.status],
  [null, null, "insufficient_data"],
);
const usage = compare(["inputTokens=0"], "usage-gate.json", 3);
assert.equal(usage.gate.status, "insufficient_data");
const text = spawnSync(
  process.execPath,
  [cli, "diff", "baseline", "candidate", "--db", database],
  { encoding: "utf8" },
);
assert.equal(text.status, 0, text.stderr);
writeFileSync(join(directory, "diff.txt"), text.stdout);
assert.deepEqual(
  hashBuild(),
  builtFilesSha256,
  "dist changed during this run; rebuild then retry",
);
writeFileSync(
  join(directory, "evidence.json"),
  `${JSON.stringify(
    {
      schema: "agentlens.example-evidence/1",
      source:
        "synthetic controlled regression; not an external user or model experiment",
      task: "Sum amountCents of paid invoices; expected 1200",
      runtime: process.version,
      builtFilesSha256,
      scriptSha256: createHash("sha256")
        .update(readFileSync(fileURLToPath(import.meta.url)))
        .digest("hex"),
      inputSha256: createHash("sha256").update(input).digest("hex"),
      timing:
        "Observed local wall time and monotonic per-tool timings; not a performance benchmark",
      usage: "No LLM called; token and cost metrics are unrecorded, not zero",
      runs: runs.map((run) => ({
        id: run.id,
        status: run.status,
        metrics: run.metrics,
        tools: run.events
          .filter((event) => event.type.startsWith("tool."))
          .map((event) => ({
            id: event.id,
            parentId: event.parentId ?? null,
            type: event.type,
            data: event.data,
          })),
      })),
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify(
    {
      directory,
      regressionExit: 2,
      missingUsageExit: 3,
      baselineEvents: runs[0].events.length,
      candidateEvents: runs[1].events.length,
    },
    null,
    2,
  ),
);
