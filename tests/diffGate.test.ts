import { describe, expect, it } from "vitest";
import { evaluateDiffGate, parseGateRules } from "../src/cli/diffGate.js";
import type { Run } from "../src/core/run.js";

function run(id: string, extra: Partial<Run> = {}): Run {
  return {
    id,
    startedAt: "2026-10-03T00:00:00Z",
    endedAt: "2026-10-03T00:00:01Z",
    status: "passed",
    events: [],
    metrics: { toolCalls: 0, failedToolCalls: 0 },
    ...extra,
  };
}

describe("explicit diff gate", () => {
  it("uses inclusive absolute thresholds, including a zero baseline", () => {
    const a = run("a", {
      metrics: { toolCalls: 0, failedToolCalls: 0, inputTokens: 0 },
    });
    const b = run("b", {
      metrics: { toolCalls: 1, failedToolCalls: 0, inputTokens: 100 },
    });
    expect(
      evaluateDiffGate(a, b, parseGateRules(["inputTokens=100", "toolCalls=1"]))
        .status,
    ).toBe("pass");
    expect(
      evaluateDiffGate(a, b, parseGateRules(["inputTokens=99"])).status,
    ).toBe("regression");
  });

  it("reports missing metrics separately and never hides a known regression", () => {
    const gate = evaluateDiffGate(
      run("a"),
      run("b", { status: "failed" }),
      parseGateRules(["status", "inputTokens=0"]),
    );
    expect(gate.status).toBe("regression");
    expect(gate.checks.map((c) => c.status)).toEqual([
      "regression",
      "insufficient_data",
    ]);
    expect(
      evaluateDiffGate(run("a"), run("b"), parseGateRules(["inputTokens=0"]))
        .status,
    ).toBe("insufficient_data");
  });

  it.each(["running", "cancelled"] as const)(
    "does not greenlight %s runs",
    (status) => {
      expect(
        evaluateDiffGate(
          run("a"),
          run("b", { status }),
          parseGateRules(["status", "toolCalls=0", "errors=0"]),
        ).checks.map((c) => c.status),
      ).toEqual([
        "insufficient_data",
        "insufficient_data",
        "insufficient_data",
      ]);
    },
  );

  it("requires a successful baseline for the status check", () => {
    expect(
      evaluateDiffGate(
        run("a", { status: "failed" }),
        run("b"),
        parseGateRules(["status"]),
      ).status,
    ).toBe("insufficient_data");
  });

  it("uses the same duration fallback as diff and rejects negative duration evidence", () => {
    expect(
      evaluateDiffGate(run("a"), run("b"), parseGateRules(["durationMs=0"]))
        .status,
    ).toBe("pass");
    const b = run("b", { endedAt: "2026-10-02T00:00:00Z" });
    expect(
      evaluateDiffGate(run("a"), b, parseGateRules(["durationMs=0"])).status,
    ).toBe("insufficient_data");
  });

  it("links increased recorded errors to events without judging legitimate polling", () => {
    const b = run("b", {
      events: [
        {
          id: "e1",
          runId: "b",
          timestamp: "2026-10-03T00:00:00Z",
          type: "error",
          data: "recovered",
        },
        {
          id: "e2",
          runId: "b",
          timestamp: "2026-10-03T00:00:00Z",
          type: "message.output",
          data: "done",
        },
      ],
    });
    const gate = evaluateDiffGate(run("a"), b, parseGateRules(["errors=0"]));
    expect(gate.status).toBe("regression");
    expect(gate.checks[0]?.eventIds).toEqual({ a: [], b: ["e1"] });
  });

  it.each([
    "",
    "cost=0",
    "status=0",
    "errors",
    "inputTokens=-1",
    "durationMs=Infinity",
    "errors=NaN",
    "errors=",
    "toolCalls=1=2",
  ])("rejects invalid rule %s", (rule) => {
    expect(() => parseGateRules([rule])).toThrow();
  });
  it("rejects empty and duplicate rule sets", () => {
    expect(() => parseGateRules([])).toThrow();
    expect(() => parseGateRules(["errors=0", "errors=1"])).toThrow();
  });
});
