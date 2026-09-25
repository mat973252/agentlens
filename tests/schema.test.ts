import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AgentLensValidationError,
  UnsupportedSchemaVersionError,
} from "../src/core/errors.js";
import { parseRun, type Run } from "../src/core/run.js";
import { deserializeRunTrace, serializeRunTrace } from "../src/schema/trace.js";

const fixture = (name: string) => {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return deserializeRunTrace(readFileSync(path, "utf8")).run;
};

const validRun = () => fixture("success-basic.json");

const at = (run: Run, i: number) => {
  const e = run.events[i];
  if (e === undefined) throw new Error(`no event at index ${i}`);
  return e;
};

const event = (over: Record<string, unknown>) => ({
  id: "x1",
  runId: "run-success-basic",
  timestamp: "2026-09-20T10:00:00.500Z",
  type: "tool.started",
  data: { tool: "read_file" },
  ...over,
});

describe("parseRun", () => {
  it("accepts the reference fixture", () => {
    expect(() => parseRun(validRun())).not.toThrow();
  });

  it("rejects an unknown event type", () => {
    const run = { ...validRun(), events: [event({ type: "teleport" })] };
    expect(() => parseRun(run)).toThrow(AgentLensValidationError);
    expect(() => parseRun(run)).toThrow(/Invalid (enum|option)|teleport/i);
  });

  it("rejects an event whose runId does not match the run", () => {
    const run = { ...validRun(), events: [event({ runId: "other-run" })] };
    expect(() => parseRun(run)).toThrow(
      /runId.*expected run-success-basic|Invalid Run/,
    );
  });

  it("rejects a duplicate event id", () => {
    const run = validRun();
    const e0 = at(run, 0);
    run.events = [e0, e0];
    expect(() => parseRun(run)).toThrow(/duplicate event id/);
  });

  it("rejects tool.completed without parentId", () => {
    const run = validRun();
    run.events.push(
      event({
        id: "late",
        type: "tool.completed",
        data: { tool: "read_file", success: true },
      }) as never,
    );
    expect(() => parseRun(run)).toThrow(/requires parentId/);
  });

  it("rejects parentId pointing at a later or unknown event", () => {
    const run = validRun();
    run.events[3] = { ...at(run, 3), parentId: "e8" };
    expect(() => parseRun(run)).toThrow(/does not reference an earlier event/);
    run.events[3] = { ...at(run, 3), parentId: "missing" };
    expect(() => parseRun(run)).toThrow(/does not reference an earlier event/);
  });

  it("rejects tool.completed whose parent is not tool.started", () => {
    const run = validRun();
    run.events[3] = { ...at(run, 3), parentId: "e2" };
    expect(() => parseRun(run)).toThrow(/parent must be a tool.started/);
  });

  it("rejects tool.completed for a different tool than its started parent", () => {
    const run = validRun();
    run.events[3] = {
      ...at(run, 3),
      data: { tool: "grep", success: true },
    };
    expect(() => parseRun(run)).toThrow(
      /for tool grep references tool.started/,
    );
  });

  it("rejects tool.completed with success false and tool.failed with success true", () => {
    const run = validRun();
    run.events[3] = {
      ...at(run, 3),
      data: { tool: "read_file", success: false },
    };
    expect(() => parseRun(run)).toThrow(
      /tool.completed must have success: true/,
    );

    run.events[3] = {
      ...at(run, 3),
      type: "tool.failed",
      data: { tool: "read_file", success: true },
    };
    expect(() => parseRun(run)).toThrow(/tool.failed must have success: false/);
  });

  it("rejects unknown top-level fields instead of silently dropping them", () => {
    const run = { ...validRun(), vendorExtension: { x: 1 } };
    expect(() => parseRun(run)).toThrow(/Unrecognized key/);
  });

  it("rejects non-JSON event data", () => {
    const run = { ...validRun(), events: [event({ data: () => 1 })] };
    expect(() => parseRun(run)).toThrow(AgentLensValidationError);
  });

  it("rejects failedToolCalls greater than toolCalls", () => {
    const run = {
      ...validRun(),
      metrics: { toolCalls: 1, failedToolCalls: 2 },
    };
    expect(() => parseRun(run)).toThrow(
      /failedToolCalls cannot exceed toolCalls/,
    );
  });

  it("rejects a passed run that does not end with run.completed", () => {
    const run = validRun();
    run.events = [
      ...run.events.slice(0, -1),
      { ...at(run, run.events.length - 1), type: "error" },
    ];
    expect(() => parseRun(run)).toThrow(/must end with run.completed/);
  });
});

describe("deserializeRunTrace", () => {
  it("rejects malformed JSON", () => {
    expect(() => deserializeRunTrace("{not json")).toThrow(
      AgentLensValidationError,
    );
    expect(() => deserializeRunTrace("{not json")).toThrow(/not valid JSON/);
  });

  it("rejects an unsupported schemaVersion", () => {
    const text = JSON.stringify({ schemaVersion: 99, run: validRun() });
    expect(() => deserializeRunTrace(text)).toThrow(
      UnsupportedSchemaVersionError,
    );
    expect(() => deserializeRunTrace(text)).toThrow(
      /version 99.*supports version 1/,
    );
  });

  it("rejects a document without schemaVersion", () => {
    expect(() =>
      deserializeRunTrace(JSON.stringify({ run: validRun() })),
    ).toThrow(AgentLensValidationError);
  });

  it("rejects extra top-level fields", () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      run: validRun(),
      extra: true,
    });
    expect(() => deserializeRunTrace(text)).toThrow(/Unrecognized key/);
  });

  it("serializes the reference fixture to the same canonical document", () => {
    const text = readFileSync(
      fileURLToPath(new URL("../fixtures/success-basic.json", import.meta.url)),
      "utf8",
    );
    const doc = deserializeRunTrace(text);
    expect(deserializeRunTrace(serializeRunTrace(doc.run)).run).toEqual(
      doc.run,
    );
  });
});
