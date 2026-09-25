import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/program.js";
import type { AgentEvent, AgentEventType } from "../src/core/event.js";
import type { JsonValue } from "../src/core/json.js";
import {
  detectPossibleLoops,
  LOOP_RULE_THRESHOLDS,
  type LoopRule,
} from "../src/core/loops.js";
import type { Run } from "../src/core/run.js";
import { deserializeRunTrace } from "../src/schema/trace.js";
import { SqliteTraceStore } from "../src/storage/sqlite/store.js";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures", import.meta.url));

const tmpDirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentlens-loops-"));
  tmpDirs.push(dir);
  return dir;
};

afterEach(() => {
  let dir = tmpDirs.pop();
  while (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = tmpDirs.pop();
  }
});

const fixtureRun = (file: string): Run =>
  deserializeRunTrace(readFileSync(join(FIXTURES_DIR, file), "utf8")).run;

const fixtureDb = (dir: string, files: string[]): string => {
  const db = join(dir, "agentlens.db");
  const store = SqliteTraceStore.open(db);
  try {
    for (const file of files) {
      store.saveRun(fixtureRun(file));
    }
  } finally {
    store.close();
  }
  return db;
};

const runCli = async (args: string[]): Promise<string> => {
  process.exitCode = 0;
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await createProgram().parseAsync(["node", "agentlens", ...args]);
  } finally {
    spy.mockRestore();
    errSpy.mockRestore();
  }
  return writes.join("");
};

const digest = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const rulesOf = (run: Run): LoopRule[] =>
  detectPossibleLoops(run).signals.map((s) => s.rule);

describe("detectPossibleLoops: positive fixtures", () => {
  it("flags identical grep calls and repeated file access in loop-grep-repeat", () => {
    const report = detectPossibleLoops(fixtureRun("loop-grep-repeat.json"));
    expect(rulesOf(fixtureRun("loop-grep-repeat.json"))).toEqual([
      "repeated-identical-call",
      "repeated-file",
    ]);
    const signal = report.signals[0];
    expect(signal?.description).toContain("grep");
    expect(signal?.description).toContain("4 times");
    expect(signal?.evidence.join(" ")).toContain("TODO");
    expect(signal?.evidence.join(" ")).toContain("e2");
    expect(signal?.caveat.length).toBeGreaterThan(0);
  });

  it("flags repeated call, file access and ping-pong in loop-read-pingpong", () => {
    const report = detectPossibleLoops(fixtureRun("loop-read-pingpong.json"));
    expect(report.signals.map((s) => s.rule)).toEqual([
      "repeated-identical-call",
      "repeated-file",
      "tool-ping-pong",
    ]);
    const file = report.signals.find((s) => s.rule === "repeated-file");
    expect(file?.description).toContain("src/a.ts");
    expect(file?.description).toContain("3 times");
    const pingPong = report.signals.find((s) => s.rule === "tool-ping-pong");
    expect(pingPong?.description).toContain("read_file");
    expect(pingPong?.description).toContain("src/a.ts");
    expect(pingPong?.description).toContain("src/b.ts");
    expect(pingPong?.eventIds).toEqual(["e2", "e4", "e6", "e8", "e10"]);
  });

  it("flags repeated identical errors in retry-exhausted", () => {
    const rules = rulesOf(fixtureRun("retry-exhausted.json"));
    expect(rules).toContain("repeated-error");
    expect(rules).toContain("repeated-identical-call");
  });

  it("flags a no-observable-progress streak of repeated identical calls", () => {
    const report = detectPossibleLoops(fixtureRun("loop-no-progress.json"));
    const streak = report.signals.find(
      (s) => s.rule === "no-observable-progress",
    );
    expect(streak).toBeDefined();
    expect(streak?.description).toContain("6 consecutive tool calls");
    expect(streak?.eventIds).toEqual(["e6", "e8", "e10", "e12", "e14", "e16"]);
  });
});

describe("detectPossibleLoops: counterexamples", () => {
  it.each([
    // Same tool, inputs change each call; also two identical errors
    // followed by a successful retry on a changed input.
    "retry-success.json",
    // Fail -> edit -> retest pass: normal edit-then-retry workflow.
    "tool-failure-recovered.json",
    // Single tool call.
    "run-failed-fatal-tool.json",
    // Two calls, the last still running with no outcome.
    "running-partial.json",
    // Same tool four times with different pattern and path each time.
    "loop-counter-varied-inputs.json",
    // Two identical failures followed by success on the identical call.
    "loop-counter-error-recovery.json",
  ])("%s produces no loop signals", (file) => {
    const report = detectPossibleLoops(fixtureRun(file));
    expect(report.signals).toEqual([]);
  });

  it("does not treat an unfinished running call as a completed repetition", () => {
    const report = detectPossibleLoops(fixtureRun("running-partial.json"));
    expect(report.signals).toEqual([]);
    expect(report.notes.join(" ")).toContain("unfinished");
  });
});

describe("detectPossibleLoops: determinism and limits", () => {
  it("is deterministic and does not mutate the run or event order", () => {
    const run = fixtureRun("loop-no-progress.json");
    const before = JSON.parse(JSON.stringify(run)) as Run;
    const a = detectPossibleLoops(run);
    const b = detectPossibleLoops(run);
    expect(a).toEqual(b);
    expect(run).toEqual(before);
  });

  it("bounds evidence lines per signal", () => {
    expect(LOOP_RULE_THRESHOLDS.maxEvidencePerSignal).toBeGreaterThan(0);
    for (const run of [
      fixtureRun("loop-no-progress.json"),
      fixtureRun("loop-read-pingpong.json"),
    ]) {
      for (const signal of detectPossibleLoops(run).signals) {
        expect(signal.evidence.length).toBeLessThanOrEqual(
          LOOP_RULE_THRESHOLDS.maxEvidencePerSignal + 1,
        );
      }
    }
  });

  it("caps signals per rule and eventIds per signal while preserving totals", () => {
    // 100 distinct files x 3 identical read_file calls = 300 calls:
    // 100 repeated-identical-call groups + 100 repeated-file groups.
    const mkEvent = (
      id: number,
      type: AgentEventType,
      data: JsonValue,
      parentId?: string,
    ): AgentEvent => ({
      id: `e${id}`,
      runId: "r-big",
      timestamp: new Date(1_700_000_000_000 + id * 1000).toISOString(),
      type,
      ...(parentId !== undefined ? { parentId } : {}),
      data,
    });
    const events: AgentEvent[] = [];
    let next = 1;
    events.push(mkEvent(next++, "run.started", null));
    for (let f = 1; f <= 100; f++) {
      for (let c = 0; c < 3; c++) {
        const startId = next;
        events.push(
          mkEvent(next++, "tool.started", {
            tool: "read_file",
            input: { path: `src/f${f}.ts` },
          }),
        );
        events.push(
          mkEvent(
            next++,
            "tool.completed",
            {
              tool: "read_file",
              output: { bytes: 100 },
              durationMs: 10,
              success: true,
            },
            `e${startId}`,
          ),
        );
      }
    }
    events.push(mkEvent(next++, "run.completed", { summary: "done" }));
    const run: Run = {
      id: "r-big",
      startedAt: new Date(1_700_000_000_000).toISOString(),
      endedAt: new Date(1_700_000_000_000 + next * 1000).toISOString(),
      status: "passed",
      events,
      metrics: { toolCalls: 300, failedToolCalls: 0 },
    };
    const report = detectPossibleLoops(run);
    // Totals are preserved even though output is capped.
    expect(report.totalSignalCount).toBe(200);
    expect(report.signals.length).toBe(
      2 * LOOP_RULE_THRESHOLDS.maxSignalsPerRule,
    );
    for (const rule of ["repeated-identical-call", "repeated-file"]) {
      const kept = report.signals.filter((s) => s.rule === rule).length;
      expect(kept).toBe(LOOP_RULE_THRESHOLDS.maxSignalsPerRule);
      expect(report.notes.join(" ")).toContain(
        `${rule} matched 100 times; showing the first ${LOOP_RULE_THRESHOLDS.maxSignalsPerRule}`,
      );
    }
    for (const signal of report.signals) {
      expect(signal.eventIds.length).toBeLessThanOrEqual(
        LOOP_RULE_THRESHOLDS.maxEventIdsPerSignal,
      );
      expect(signal.evidence.length).toBeLessThanOrEqual(
        LOOP_RULE_THRESHOLDS.maxEvidencePerSignal + 1,
      );
    }
    // Still only "possible" signals — nothing asserts a confirmed loop.
    for (const signal of report.signals) {
      expect(signal.caveat.length).toBeGreaterThan(0);
    }
    // Deterministic across repeated runs.
    expect(detectPossibleLoops(run)).toEqual(report);
  });

  it("truncates eventIds when a single signal spans many calls", () => {
    // One identical call repeated 25 times (> maxEventIdsPerSignal).
    const events = [];
    let next = 1;
    events.push({
      id: "e1",
      runId: "r-many",
      timestamp: new Date(1_700_000_000_000).toISOString(),
      type: "run.started" as const,
      data: null,
    });
    for (let c = 0; c < 25; c++) {
      const startId = `e${next}`;
      events.push({
        id: `e${next++}`,
        runId: "r-many",
        timestamp: new Date(1_700_000_000_000 + next * 1000).toISOString(),
        type: "tool.started" as const,
        data: { tool: "ping", input: { host: "h" } },
      });
      events.push({
        id: `e${next++}`,
        runId: "r-many",
        timestamp: new Date(1_700_000_000_000 + next * 1000).toISOString(),
        type: "tool.completed" as const,
        parentId: startId,
        data: {
          tool: "ping",
          output: { ok: true },
          durationMs: 5,
          success: true,
        },
      });
    }
    events.push({
      id: `e${next}`,
      runId: "r-many",
      timestamp: new Date(1_700_000_000_000 + next * 1000).toISOString(),
      type: "run.completed" as const,
      data: null,
    });
    const run: Run = {
      id: "r-many",
      startedAt: new Date(1_700_000_000_000).toISOString(),
      endedAt: new Date(1_700_000_000_000 + next * 1000).toISOString(),
      status: "passed",
      events: events as AgentEvent[],
      metrics: { toolCalls: 25, failedToolCalls: 0 },
    };
    const signal = detectPossibleLoops(run).signals.find(
      (s) => s.rule === "repeated-identical-call",
    );
    expect(signal).toBeDefined();
    expect(signal?.eventIds.length).toBe(
      LOOP_RULE_THRESHOLDS.maxEventIdsPerSignal,
    );
    expect(signal?.evidence.join(" ")).toContain("eventIds truncated");
    expect(signal?.evidence.join(" ")).toContain("of 25");
    expect(signal?.description).toContain("25 times");
  });

  it("reports progress as indeterminate when no progress events exist", () => {
    const report = detectPossibleLoops(fixtureRun("loop-grep-repeat.json"));
    expect(report.progressEvidencePresent).toBe(false);
    expect(report.notes.join(" ")).toContain("cannot be confirmed or denied");
  });
});

describe("agentlens inspect: Possible loops section", () => {
  it("shows loop signals with evidence for a loop fixture", async () => {
    const db = fixtureDb(tmpDir(), ["loop-read-pingpong.json"]);
    const out = await runCli(["inspect", "run-loop-read-pingpong", "--db", db]);
    expect(out).toContain("Possible loops");
    expect(out).toContain("[repeated-identical-call]");
    expect(out).toContain("[tool-ping-pong]");
    expect(out).toContain("src/a.ts");
    expect(out).not.toContain("No loop signals detected.");
  });

  it("states explicitly when no signals are found", async () => {
    const db = fixtureDb(tmpDir(), ["loop-counter-varied-inputs.json"]);
    const out = await runCli([
      "inspect",
      "run-loop-counter-varied-inputs",
      "--db",
      db,
    ]);
    expect(out).toContain("Possible loops");
    expect(out).toContain("No loop signals detected.");
  });

  it("produces identical output on repeated inspection", async () => {
    const db = fixtureDb(tmpDir(), ["loop-grep-repeat.json"]);
    const a = await runCli(["inspect", "run-loop-grep-repeat", "--db", db]);
    const b = await runCli(["inspect", "run-loop-grep-repeat", "--db", db]);
    expect(a).toBe(b);
  });

  it("leaves the database byte-identical and creates no wal/journal", async () => {
    const dir = tmpDir();
    const db = fixtureDb(dir, ["loop-no-progress.json"]);
    const beforeHash = digest(db);
    const beforeMtime = statSync(db).mtimeMs;
    await runCli(["inspect", "run-loop-no-progress", "--db", db]);
    expect(digest(db)).toBe(beforeHash);
    expect(statSync(db).mtimeMs).toBe(beforeMtime);
    expect(
      readdirSync(dir).filter((f) => f.endsWith("-wal") || f.endsWith("-shm")),
    ).toEqual([]);
  });
});
