import { describe, expect, it } from "vitest";
import { AgentLensValidationError } from "../src/core/errors.js";
import { AgentLensRecorderError, Recorder } from "../src/core/recorder.js";
import { SqliteTraceStore } from "../src/storage/sqlite/store.js";

const clock = (start = "2026-09-25T10:00:00.000Z") => {
  let ms = Date.parse(start);
  return () => {
    ms += 1000;
    return new Date(ms).toISOString();
  };
};

const ids = () => {
  let n = 0;
  return () => `e${++n}`;
};

const recorder = () =>
  new Recorder({
    store: SqliteTraceStore.open(":memory:"),
    now: clock(),
    newId: ids(),
  });

describe("Recorder", () => {
  it("records start -> tool -> tool -> error -> tool -> complete end to end", () => {
    const store = SqliteTraceStore.open(":memory:");
    const rec = new Recorder({ store, now: clock(), newId: ids() });

    const run = rec.startRun({ agent: "demo-agent", model: "demo-model" });
    expect(run.status).toBe("active");
    expect(run.events.map((e) => e.type)).toEqual(["run.started"]);

    const t1 = run.emit("tool.started", {
      tool: "read_file",
      input: { path: "a.ts" },
    });
    run.emit(
      "tool.completed",
      { tool: "read_file", success: true, durationMs: 10 },
      { parentId: t1.id },
    );
    const t2 = run.emit("tool.started", { tool: "grep" });
    run.emit(
      "tool.failed",
      { tool: "grep", success: false, error: "boom" },
      { parentId: t2.id },
    );
    run.emit("error", { message: "recovered" });
    const t3 = run.emit("tool.started", { tool: "write_file" });
    const done = run.emit(
      "tool.completed",
      { tool: "write_file", success: true },
      { parentId: t3.id },
    );

    const finished = run.completeRun();

    expect(finished.status).toBe("passed");
    expect(finished.events.map((e) => e.type)).toEqual([
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
    expect(done.parentId).toBe(t3.id);
    expect(finished.metrics).toMatchObject({
      toolCalls: 3,
      failedToolCalls: 1,
    });
    expect(finished.endedAt).toBeDefined();

    const stored = store.getRun(run.id);
    expect(stored).toEqual(finished);
    store.close();
  });

  it("records a failed run via failRun", () => {
    const store = SqliteTraceStore.open(":memory:");
    const rec = new Recorder({ store, now: clock(), newId: ids() });
    const run = rec.startRun();
    const finished = run.failRun(new Error("agent crashed"));

    expect(finished.status).toBe("failed");
    expect(finished.events.at(-1)?.type).toBe("run.failed");
    expect(finished.events.at(-1)?.data).toEqual({
      message: "agent crashed",
    });
    expect(store.getRun(run.id)).toEqual(finished);
    store.close();
  });

  it("rejects invalid call order", () => {
    const rec = recorder();
    const run = rec.startRun();
    run.completeRun();

    expect(() => run.completeRun()).toThrow(AgentLensRecorderError);
    expect(() => run.failRun()).toThrow(AgentLensRecorderError);
    expect(() => run.emit("error", null)).toThrow(/already completed/);
  });

  it("reserves lifecycle event types for the lifecycle methods", () => {
    const rec = recorder();
    const run = rec.startRun();
    for (const type of [
      "run.started",
      "run.completed",
      "run.failed",
    ] as const) {
      expect(() => run.emit(type, null)).toThrow(/reserved/);
    }
  });

  it("rejects an unknown parentId at emit time", () => {
    const rec = recorder();
    const run = rec.startRun();
    expect(() =>
      run.emit(
        "tool.completed",
        { tool: "x", success: true },
        {
          parentId: "nope",
        },
      ),
    ).toThrow(AgentLensValidationError);
    expect(() =>
      run.emit(
        "tool.completed",
        { tool: "x", success: true },
        {
          parentId: "nope",
        },
      ),
    ).toThrow(/does not reference an earlier event/);
  });

  it("fails completeRun when the event stream violates the run schema", () => {
    const store = {
      saved: [] as unknown[],
      saveRun(run: unknown) {
        this.saved.push(run);
      },
    };
    const rec = new Recorder({ store, now: clock(), newId: ids() });
    const run = rec.startRun();
    run.emit("tool.completed", { tool: "x", success: true }); // no parentId

    expect(() => run.completeRun()).toThrow(/requires parentId/);
    expect(store.saved).toHaveLength(0);
  });

  it("rejects malformed event payloads at emit time", () => {
    const rec = recorder();
    const run = rec.startRun();
    expect(() =>
      run.emit("tool.started", { tool: "x", extra: "field" }),
    ).toThrow(AgentLensValidationError);
    expect(() => run.emit("message.output", undefined as never)).not.toThrow();
  });

  it("accepts metric overrides on completeRun", () => {
    const rec = recorder();
    const run = rec.startRun();
    const finished = run.completeRun({ inputTokens: 100, outputTokens: 25 });
    expect(finished.metrics).toMatchObject({
      toolCalls: 0,
      failedToolCalls: 0,
      inputTokens: 100,
      outputTokens: 25,
    });
  });
});
