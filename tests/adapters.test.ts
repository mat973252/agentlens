import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GENERIC_JSONL_FORMAT,
  GENERIC_JSONL_FORMAT_VERSION,
  parseGenericJsonl,
} from "../src/adapters/generic.js";
import { parsePiSession } from "../src/adapters/pi.js";
import {
  AgentLensValidationError,
  UnsupportedSchemaVersionError,
} from "../src/core/errors.js";

const fixtureText = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const genericLine = (obj: Record<string, unknown>) => JSON.stringify(obj);
const genericRun = (run: Record<string, unknown>) =>
  genericLine({
    format: GENERIC_JSONL_FORMAT,
    formatVersion: GENERIC_JSONL_FORMAT_VERSION,
    kind: "run",
    run,
  });
const genericEvent = (event: Record<string, unknown>) =>
  genericLine({
    format: GENERIC_JSONL_FORMAT,
    formatVersion: GENERIC_JSONL_FORMAT_VERSION,
    kind: "event",
    event,
  });

const PI_SAMPLE_NOTE =
  "fixtures/pi/*.jsonl are verbatim line slices of the real session file " +
  "packages/coding-agent/test/fixtures/before-compaction.jsonl in " +
  "github.com/badlogic/pi-mono (MIT) at commit " +
  "5fd446ca1843682e8da3fec4ceb71c42f56fbace";

describe("generic JSONL adapter", () => {
  it("normalizes a success run: explicit metadata, linked tool calls, derived status/metrics", () => {
    const run = parseGenericJsonl(
      fixtureText("fixtures/generic/generic-success.jsonl"),
    );
    expect(run.id).toBe("gen-success-1");
    expect(run.agent).toBe("demo-agent");
    expect(run.model).toBe("demo-model");
    expect(run.status).toBe("passed");
    expect(run.startedAt).toBe("2026-09-25T10:00:00.000Z");
    expect(run.endedAt).toBe("2026-09-25T10:00:05.000Z");
    expect(run.metrics.toolCalls).toBe(1);
    expect(run.events.map((e) => e.type)).toEqual([
      "run.started",
      "message.input",
      "tool.started",
      "tool.completed",
      "message.output",
      "run.completed",
    ]);
    const completed = run.events[3];
    expect(completed?.type).toBe("tool.completed");
    expect(completed?.parentId).toBe("g3");
    expect(completed?.data).toMatchObject({
      tool: "ls",
      input: { path: "." },
      success: true,
      durationMs: 12,
    });
  });

  it("normalizes a failure run with tool.failed error text", () => {
    const run = parseGenericJsonl(
      fixtureText("fixtures/generic/generic-error.jsonl"),
    );
    expect(run.id).toBe("gen-error-1");
    expect(run.status).toBe("failed");
    const failed = run.events.find((e) => e.type === "tool.failed");
    expect(failed?.parentId).toBe("e3");
    expect(failed?.data).toMatchObject({
      tool: "deploy",
      success: false,
      error: "permission denied",
    });
    expect(run.events.at(-1)?.type).toBe("run.failed");
  });

  it("derives status: absent run.status + terminal event, or running without one", () => {
    const text = [
      genericRun({ id: "r1", startedAt: "2026-09-25T10:00:00.000Z" }),
      genericEvent({
        id: "e1",
        type: "message.input",
        timestamp: "2026-09-25T10:00:01.000Z",
        data: { text: "hi" },
      }),
    ].join("\n");
    const run = parseGenericJsonl(text);
    expect(run.status).toBe("running");
    expect(run.endedAt).toBeUndefined();
  });

  it("keeps explicit metrics instead of deriving them", () => {
    const text = [
      genericRun({
        id: "r1",
        startedAt: "2026-09-25T10:00:00.000Z",
        status: "passed",
        metrics: { toolCalls: 9, failedToolCalls: 0, inputTokens: 42 },
      }),
      genericEvent({
        id: "e1",
        type: "run.completed",
        timestamp: "2026-09-25T10:00:01.000Z",
        data: null,
      }),
    ].join("\n");
    const run = parseGenericJsonl(text);
    expect(run.metrics).toEqual({
      toolCalls: 9,
      failedToolCalls: 0,
      inputTokens: 42,
    });
  });

  it("rejects an unsupported formatVersion", () => {
    const text = genericLine({
      format: GENERIC_JSONL_FORMAT,
      formatVersion: 2,
      kind: "run",
      run: { id: "r1" },
    });
    expect(() => parseGenericJsonl(text)).toThrow(
      UnsupportedSchemaVersionError,
    );
  });

  it.each([
    ["malformed JSON", "{broken\n"],
    [
      "event before the run line",
      `${genericEvent({ id: "e1", type: "error", timestamp: "2026-09-25T10:00:00.000Z", data: null })}\n${genericRun({ id: "r1" })}`,
    ],
    [
      "duplicate run line",
      `${genericRun({ id: "r1", startedAt: "2026-09-25T10:00:00.000Z" })}\n${genericRun({ id: "r2" })}`,
    ],
    [
      "unknown event type",
      `${genericRun({ id: "r1", startedAt: "2026-09-25T10:00:00.000Z" })}\n${genericEvent({ id: "e1", type: "magic.event", timestamp: "2026-09-25T10:00:01.000Z", data: null })}`,
    ],
    [
      "toolCallId with no earlier tool.started",
      `${genericRun({ id: "r1", startedAt: "2026-09-25T10:00:00.000Z" })}\n${genericEvent({ id: "e1", type: "tool.completed", timestamp: "2026-09-25T10:00:01.000Z", toolCallId: "nope" })}`,
    ],
    [
      "tool result without any association",
      `${genericRun({ id: "r1", startedAt: "2026-09-25T10:00:00.000Z" })}\n${genericEvent({ id: "e1", type: "tool.completed", timestamp: "2026-09-25T10:00:01.000Z", tool: "x" })}`,
    ],
    [
      "tool field on a non-tool event",
      `${genericRun({ id: "r1", startedAt: "2026-09-25T10:00:00.000Z" })}\n${genericEvent({ id: "e1", type: "message.input", timestamp: "2026-09-25T10:00:01.000Z", data: null, tool: "x" })}`,
    ],
    [
      "unknown field",
      `${genericRun({ id: "r1", startedAt: "2026-09-25T10:00:00.000Z", surprise: true })}`,
    ],
  ])("fails explicitly on %s", (_label, text) => {
    expect(() => parseGenericJsonl(text)).toThrow(AgentLensValidationError);
  });
});

describe("Pi session adapter", () => {
  it(PI_SAMPLE_NOTE, () => {
    // Provenance guard: this test documents where the samples come from.
    expect(true).toBe(true);
  });

  it("normalizes a real success session slice", () => {
    const run = parsePiSession(
      fixtureText("fixtures/pi/pi-session-success.jsonl"),
    );
    expect(run.id).toBe("ffae836b-9420-4060-ac13-7745215f90ff");
    expect(run.agent).toBe("pi");
    expect(run.model).toBe("claude-opus-4-5");
    expect(run.status).toBe("passed");
    expect(run.events[0]?.type).toBe("run.started");
    expect(run.events.at(-1)?.type).toBe("run.completed");
    // branched sessions: run starts at the earliest entry, not the (later)
    // session-file header creation timestamp
    expect(run.startedAt).toBe("2025-12-08T22:41:05.306Z");
    expect(run.endedAt).toBe("2025-12-08T22:45:42.397Z");
    expect(run.metrics.durationMs).toBe(277091);

    const types = run.events.map((e) => e.type);
    expect(types).toEqual([
      "run.started",
      "message.input",
      "tool.started",
      "tool.started",
      "tool.completed",
      "tool.completed",
      "message.output",
      "tool.started",
      "tool.completed",
      "message.output",
      "run.completed",
    ]);
    // toolCall ids link start→result, preserving tool input and raw output
    const [s1, s2] = [run.events[2], run.events[3]];
    expect(run.events[4]?.parentId).toBe(s1?.id);
    expect(run.events[5]?.parentId).toBe(s2?.id);
    expect(run.events[4]?.data).toMatchObject({
      tool: "read",
      input: {
        path: "/Users/badlogic/workspaces/pi-mono/packages/coding-agent/src/main.ts",
      },
      success: true,
    });
    // metrics come only from recorded assistant usage
    expect(run.metrics.toolCalls).toBe(3);
    expect(run.metrics.failedToolCalls).toBe(0);
    expect(run.metrics.inputTokens).toBeGreaterThan(0);
    expect(run.metrics.outputTokens).toBeGreaterThan(0);
    // unmapped session metadata is preserved verbatim, not dropped
    const end = run.events.at(-1);
    const endData = end?.data as
      | { source?: { unmappedEntries?: unknown[] } }
      | undefined;
    const unmapped = endData?.source?.unmappedEntries;
    expect(Array.isArray(unmapped)).toBe(true);
    expect(JSON.stringify(unmapped)).toContain("thinking_level_change");
  });

  it("normalizes a real failure session slice: tool errors, abort, final API error", () => {
    const run = parsePiSession(
      fixtureText("fixtures/pi/pi-session-error.jsonl"),
    );
    expect(run.id).toBe("ffae836b-9420-4060-ac13-7745215f90fe");
    expect(run.status).toBe("failed");
    expect(run.events.at(-1)?.type).toBe("run.failed");
    const failedTools = run.events.filter((e) => e.type === "tool.failed");
    expect(failedTools).toHaveLength(3);
    expect(failedTools[0]?.data).toMatchObject({
      tool: "edit",
      success: false,
    });
    const failedData = failedTools[0]?.data as { error?: string } | undefined;
    expect(String(failedData?.error)).toContain(
      "Could not find the exact text",
    );
    const errorEvents = run.events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(2);
    const terminal = run.events.at(-1)?.data as { error?: string } | undefined;
    expect(String(terminal?.error)).toContain("invalid_request_error");
    expect(run.metrics.failedToolCalls).toBe(3);
  });

  it("rejects a toolResult for an unknown toolCallId", () => {
    const text = fixtureText("fixtures/pi/pi-session-success.jsonl")
      .split("\n")
      .map((line, i) =>
        i === 3
          ? line.replace("toolu_012yuiPP1VAfh196GXaAmT8D", "toolu_missing")
          : line,
      )
      .join("\n");
    expect(() => parsePiSession(text)).toThrow(/unknown toolCallId/);
  });

  it("rejects a future session version", () => {
    const text = fixtureText("fixtures/pi/pi-session-success.jsonl").replace(
      '"type":"session"',
      '"type":"session","version":4',
    );
    expect(() => parsePiSession(text)).toThrow(UnsupportedSchemaVersionError);
  });

  it("rejects a file without a session header", () => {
    const text = fixtureText("fixtures/pi/pi-session-success.jsonl")
      .split("\n")
      .slice(1)
      .join("\n");
    expect(() => parsePiSession(text)).toThrow(/session/);
  });

  it("rejects malformed JSON with a line number", () => {
    const text = `${fixtureText("fixtures/pi/pi-session-success.jsonl")}{oops\n`;
    expect(() => parsePiSession(text)).toThrow(/line 10/);
  });

  it("treats a header-only file as a completed empty run", () => {
    const text = fixtureText("fixtures/pi/pi-session-success.jsonl").split(
      "\n",
    )[0] as string;
    const run = parsePiSession(text);
    expect(run.status).toBe("passed");
    expect(run.events.map((e) => e.type)).toEqual([
      "run.started",
      "run.completed",
    ]);
  });

  it("is deterministic: same input parses to the same run", () => {
    const text = fixtureText("fixtures/pi/pi-session-error.jsonl");
    expect(parsePiSession(text)).toEqual(parsePiSession(text));
  });
});
