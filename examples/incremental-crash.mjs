// Build first: corepack pnpm build
// Run: node examples/incremental-crash.mjs
// This local fixture performs no external tool actions and retains its temp DB.
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Recorder, SqliteTraceStore } from "../dist/index.js";

if (process.argv[2] === "--writer") {
  const store = SqliteTraceStore.open(process.argv[3]);
  const run = new Recorder({ store, persistence: "incremental" }).startRun({
    id: "interrupted",
  });
  for (let index = 0; index < 20; index++)
    run.emit("message.output", { index });
  process.send("committed");
  setInterval(() => {}, 1000);
} else {
  const db = join(mkdtempSync(join(tmpdir(), "agentlens-crash-")), "trace.db");
  const child = fork(fileURLToPath(import.meta.url), ["--writer", db], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exited = once(child, "exit");
  try {
    const [ack] = await once(child, "message", {
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(ack, "committed");
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      [cli, "inspect", "interrupted", "--db", db, "--json"],
      { encoding: "utf8" },
    ),
  );
  assert.equal(report.run.status, "running");
  assert.equal(report.run.events.length, 21);
  assert.equal(report.run.endedAt, undefined);
  console.log(
    JSON.stringify(
      {
        db,
        status: report.run.status,
        committedEvents: report.run.events.length,
      },
      null,
      2,
    ),
  );
  console.log(
    `Inspect again: node ${JSON.stringify(cli)} inspect interrupted --db ${JSON.stringify(db)} --json`,
  );
}
