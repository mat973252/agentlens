import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UnsupportedSchemaVersionError } from "../src/core/errors.js";
import { deserializeRunTrace } from "../src/schema/trace.js";
import {
  parseRunTraceJsonl,
  serializeRunTraceJsonl,
} from "../src/schema/traceJsonl.js";

const fixture = (name: string) =>
  deserializeRunTrace(
    readFileSync(
      fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  ).run;

const FIXTURES = readdirSync(
  fileURLToPath(new URL("../fixtures", import.meta.url)),
).filter((f) => f.endsWith(".json"));

const runLine = (run: Record<string, unknown>) =>
  JSON.stringify({
    format: "agentlens-trace",
    formatVersion: 1,
    kind: "run",
    run,
  });
const eventLine = (event: Record<string, unknown>) =>
  JSON.stringify({
    format: "agentlens-trace",
    formatVersion: 1,
    kind: "event",
    event,
  });

const baseRun = {
  id: "r1",
  startedAt: "2026-09-25T10:00:00.000Z",
  status: "passed",
  metrics: { toolCalls: 0, failedToolCalls: 0 },
};

const runStarted = {
  id: "e1",
  runId: "r1",
  timestamp: "2026-09-25T10:00:00.000Z",
  type: "run.started",
  data: null,
};
const runCompleted = {
  id: "e2",
  runId: "r1",
  timestamp: "2026-09-25T10:00:05.000Z",
  type: "run.completed",
  data: null,
};

const validDoc = `${runLine({ ...baseRun, endedAt: "2026-09-25T10:00:05.000Z" })}\n${eventLine(runStarted)}\n${eventLine(runCompleted)}\n`;

describe("trace JSONL", () => {
  it.each(FIXTURES)("round-trips fixture %s", (name) => {
    const run = fixture(name);
    expect(parseRunTraceJsonl(serializeRunTraceJsonl(run)).run).toEqual(run);
  });

  it("rejects a file that is not JSON", () => {
    expect(() => parseRunTraceJsonl("not json\n")).toThrow(
      /line 1 is not valid JSON/,
    );
  });

  it("rejects an event before the run line", () => {
    expect(() => parseRunTraceJsonl(`${eventLine(runStarted)}\n`)).toThrow(
      /before the run line/,
    );
  });

  it("rejects a missing run line", () => {
    expect(() => parseRunTraceJsonl("")).toThrow(/missing run metadata line/);
  });

  it("rejects a duplicate run line", () => {
    const doc = `${runLine(baseRun)}\n${runLine(baseRun)}\n`;
    expect(() => parseRunTraceJsonl(doc)).toThrow(/duplicate run line/);
  });

  it("rejects an unsupported formatVersion", () => {
    const doc = `${JSON.stringify({
      format: "agentlens-trace",
      formatVersion: 2,
      kind: "run",
      run: baseRun,
    })}\n`;
    expect(() => parseRunTraceJsonl(doc)).toThrow(
      UnsupportedSchemaVersionError,
    );
  });

  it("rejects unknown fields instead of dropping them", () => {
    const line = JSON.stringify({
      format: "agentlens-trace",
      formatVersion: 1,
      kind: "run",
      run: baseRun,
      extra: 1,
    });
    expect(() => parseRunTraceJsonl(`${line}\n`)).toThrow(/line 1.*extra/i);
  });

  it("rejects events embedded in the run line", () => {
    const line = runLine({ ...baseRun, events: [] });
    expect(() => parseRunTraceJsonl(`${line}\n`)).toThrow(
      /line 1 run metadata/,
    );
  });

  it("rejects an event from a different run", () => {
    const doc =
      `${runLine(baseRun)}\n` +
      `${eventLine({ ...runStarted, runId: "other" })}\n`;
    expect(() => parseRunTraceJsonl(doc)).toThrow(/expected r1/);
  });

  it("rejects a tool.completed without its tool.started parentId", () => {
    const doc =
      `${runLine(baseRun)}\n` +
      `${eventLine(runStarted)}\n` +
      `${eventLine({
        id: "e2",
        runId: "r1",
        timestamp: "2026-09-25T10:00:01.000Z",
        type: "tool.completed",
        data: { tool: "x", success: true },
      })}\n` +
      `${eventLine({ ...runCompleted, id: "e3" })}\n`;
    expect(() => parseRunTraceJsonl(doc)).toThrow(/requires parentId/);
  });

  it("parses a valid document", () => {
    const { run } = parseRunTraceJsonl(validDoc);
    expect(run.id).toBe("r1");
    expect(run.events.map((e) => e.type)).toEqual([
      "run.started",
      "run.completed",
    ]);
  });
});
