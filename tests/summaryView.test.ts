import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatRunSummary } from "../src/cli/summaryView.js";
import { deserializeRunTrace } from "../src/schema/trace.js";

const fixture = (name: string) =>
  deserializeRunTrace(
    readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"),
  ).run;

describe("summary evidence boundaries", () => {
  it("keeps recovered errors separate from passed status and Relay uncertainty", () => {
    const run = fixture("tool-failure-recovered");
    const text = formatRunSummary(run, {
      runId: run.id,
      schema: "relay.effect-history/1",
      sessionSha256: "a",
      historySha256: "b",
      importedAt: "2026-09-26",
      histories: [
        {
          record: {
            id: "external",
            key: "x:y",
            kind: "mcp:x",
            status: "UNKNOWN",
            createdAt: 1,
            updatedAt: 2,
          },
          events: [],
          coverage: "unavailable",
        },
      ],
    });
    expect(text).toContain("Recorded status: passed");
    expect(text).toContain("UNKNOWN: 1");
    expect(text).toContain("ownership and recovery are unverified");
    expect(text).toContain("starts without recorded outcome: 0");
  });

  it("reports an unfinished tool without calling it failed", () => {
    const text = formatRunSummary(fixture("running-partial"));
    expect(text).toContain("Recorded status: running");
    expect(text).toContain("starts without recorded outcome: 1");
    expect(text).toContain("Recorded error/failure signals: 0");
  });

  it("bounds large error payloads and retains the terminal failure", () => {
    const run = fixture("run-failed-fatal-tool");
    const last = run.events.pop();
    if (!last) throw new Error("missing terminal event");
    for (let i = 0; i < 100; i++)
      run.events.push({
        ...last,
        id: `error-${i}`,
        type: "error",
        data: { message: `line\n${"x".repeat(10000)}` },
      });
    run.events.push(last);
    const text = formatRunSummary(run);
    expect(text).toContain('run.failed event="e5"');
    expect(text).toContain("98 signals omitted");
    expect(text).toContain("line\\n");
    expect(text.length).toBeLessThan(2200);
    expect(text.split("\n").length).toBeLessThan(18);
  });
});
