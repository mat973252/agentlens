import type { AgentEvent } from "./event.js";
import type { JsonValue } from "./json.js";
import type { Run } from "./run.js";

/**
 * M5 — deterministic, rules-first possible-loop detection over stored
 * AgentEvent data. No LLM judgement: every signal is backed by observable
 * event evidence and reported as a *possible* loop, never as confirmed
 * semantic behavior. See README "M5" for thresholds and the documented
 * false-positive / false-negative boundaries.
 */

/** One threshold per rule so README can cite them and tests can pin them. */
export const LOOP_RULE_THRESHOLDS = {
  /** Repeated identical tool call: same tool + input + outcome + result. */
  identicalCallMin: 3,
  /** Repeated access of the same file path across tool calls. */
  fileRepeatMin: 3,
  /** Repeated identical error (same source type + tool + message). */
  errorRepeatMin: 3,
  /** Ping-pong: smallest cycle length examined. */
  cycleMinLength: 2,
  /** Ping-pong: largest cycle length examined. */
  cycleMaxLength: 6,
  /** Ping-pong: a cycle must complete at least this many full turns. */
  cycleMinTurns: 2,
  /** No-progress: consecutive tool calls re-running an earlier identical
   * call that returned an identical result. */
  noProgressStreakMin: 4,
  /** Evidence lines emitted per signal before they are truncated. */
  maxEvidencePerSignal: 8,
  /** Signals reported per rule; the total match count is always preserved
   * in the report notes and `totalSignalCount`. */
  maxSignalsPerRule: 10,
  /** Event ids listed per signal; the full count stays in the evidence
   * range line ("events e1–e9 (N calls)"). */
  maxEventIdsPerSignal: 20,
} as const;

export type LoopRule =
  | "repeated-identical-call"
  | "repeated-file"
  | "repeated-error"
  | "tool-ping-pong"
  | "no-observable-progress";

export interface LoopSignal {
  /** Stable rule identifier (also the README anchor for its threshold). */
  rule: LoopRule;
  /** One sentence: what was observed, with counts. */
  description: string;
  /** Evidence lines: event ids/range, tool, file or error text and count. */
  evidence: string[];
  /** Event ids backing the signal (first..last occurrence). */
  eventIds: string[];
  /**
   * Why this remains a *possible* loop: the boundary conditions under
   * which the same event pattern is legitimate behavior.
   */
  caveat: string;
}

export interface LoopReport {
  /**
   * Signals in fixed rule order, each with bounded evidence, bounded
   * eventIds and at most LOOP_RULE_THRESHOLDS.maxSignalsPerRule entries
   * per rule. Truncated rules keep their full match count in notes and
   * in totalSignalCount.
   */
  signals: LoopSignal[];
  /** Total signals matched by every rule before per-rule truncation. */
  totalSignalCount: number;
  /**
   * True when the run recorded at least one event type that can carry
   * observable state change (artifact, plan, verification events). When false,
   * progress cannot be confirmed or denied from the stored payloads alone.
   */
  progressEvidencePresent: boolean;
  /** Free-text notes about detection limits relevant to this run. */
  notes: string[];
}

interface CallInfo {
  /** Index of the tool.started (or orphan outcome) event in run.events. */
  index: number;
  eventId: string;
  tool: string;
  input: JsonValue | undefined;
  /** tool + canonical(input); used by identical-call and cycle rules. */
  signature: string;
  outcome: "completed" | "failed" | undefined;
  /** Canonical result: output for completed, error text for failed. */
  result: string | undefined;
}

/** Canonical JSON: object keys sorted recursively, undefined -> null. */
const canonicalJson = (value: JsonValue | undefined): string =>
  JSON.stringify(canonicalize(value ?? null));

const canonicalize = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key] ?? null)]),
    );
  }
  return value;
};

const toolOf = (event: AgentEvent): string | undefined =>
  typeof event.data === "object" &&
  event.data !== null &&
  "tool" in event.data &&
  typeof (event.data as { tool: unknown }).tool === "string"
    ? (event.data as { tool: string }).tool
    : undefined;

const inputOf = (event: AgentEvent): JsonValue | undefined =>
  typeof event.data === "object" && event.data !== null && "input" in event.data
    ? (event.data as { input?: JsonValue }).input
    : undefined;

const resultOf = (event: AgentEvent): string | undefined => {
  if (typeof event.data !== "object" || event.data === null) return undefined;
  const data = event.data as { output?: JsonValue; error?: string };
  if (event.type === "tool.failed")
    return data.error ?? canonicalJson(data.output ?? null);
  return data.output !== undefined ? canonicalJson(data.output) : undefined;
};

const errorTextOf = (event: AgentEvent): string => {
  if (typeof event.data === "object" && event.data !== null) {
    const data = event.data as { message?: unknown; error?: unknown };
    if (typeof data.message === "string") return data.message;
    if (typeof data.error === "string") return data.error;
  }
  return JSON.stringify(event.data);
};

const FILE_INPUT_KEYS = ["path", "file", "filePath", "filename"] as const;

const fileTargetsOf = (input: JsonValue | undefined): string[] => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return [];
  const targets: string[] = [];
  for (const key of FILE_INPUT_KEYS) {
    const value = (input as Record<string, JsonValue>)[key];
    if (typeof value === "string" && value !== "") targets.push(value);
  }
  return targets;
};

const previewJson = (text: string, max = 80): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Ordered tool calls: each tool.started plus any orphan tool.completed /
 * tool.failed whose parentId does not resolve to a start event (matching
 * the pairing rules used by the inspect/diff views).
 */
const collectCalls = (run: Run): CallInfo[] => {
  const byId = new Map(run.events.map((e, i) => [e.id, i]));
  const calls: CallInfo[] = [];
  const makeCall = (event: AgentEvent, index: number): CallInfo => {
    const tool = toolOf(event) ?? "(unknown)";
    const input = inputOf(event);
    return {
      index,
      eventId: event.id,
      tool,
      input,
      signature: `${tool} ${canonicalJson(input)}`,
      outcome: undefined,
      result: undefined,
    };
  };
  run.events.forEach((event, index) => {
    if (event.type === "tool.started") {
      calls.push(makeCall(event, index));
      return;
    }
    if (event.type !== "tool.completed" && event.type !== "tool.failed") return;
    const parentIndex =
      event.parentId !== undefined ? byId.get(event.parentId) : undefined;
    const parentEvent =
      parentIndex !== undefined ? run.events[parentIndex] : undefined;
    const open =
      parentEvent !== undefined && parentEvent.type === "tool.started"
        ? calls.find((c) => c.eventId === parentEvent.id)
        : undefined;
    const outcome = event.type === "tool.completed" ? "completed" : "failed";
    if (open !== undefined && open.outcome === undefined) {
      open.outcome = outcome;
      open.result = resultOf(event);
      // An outcome may carry input when the start did not; signatures then
      // prefer the richer payload.
      if (open.input === undefined && inputOf(event) !== undefined) {
        open.input = inputOf(event);
        open.signature = `${open.tool} ${canonicalJson(open.input)}`;
      }
      return;
    }
    const orphan = makeCall(event, index);
    orphan.outcome = outcome;
    orphan.result = resultOf(event);
    calls.push(orphan);
  });
  return calls;
};

const idRange = (ids: string[]): string =>
  ids.length === 1 ? (ids[0] ?? "") : `${ids[0]}–${ids.at(-1)}`;

/** Rule matches before output capping: signals kept plus total matched. */
interface RuleResult {
  signals: LoopSignal[];
  /** All groups that met the rule threshold, before maxSignalsPerRule. */
  matched: number;
}

/** Rule 1: same tool + same input + same outcome + same result, >=3 times. */
const repeatedIdenticalCalls = (calls: CallInfo[]): RuleResult => {
  const groups = new Map<string, CallInfo[]>();
  for (const call of calls) {
    if (call.outcome === undefined) continue; // unfinished calls carry no result
    const key = `${call.signature}${call.outcome}${call.result ?? ""}`;
    const group = groups.get(key);
    if (group) group.push(call);
    else groups.set(key, [call]);
  }
  const signals: LoopSignal[] = [];
  let matched = 0;
  const ordered = [...groups.values()].sort(
    (a, b) => (a[0]?.index ?? 0) - (b[0]?.index ?? 0),
  );
  for (const group of ordered) {
    if (group.length < LOOP_RULE_THRESHOLDS.identicalCallMin) continue;
    matched++;
    if (signals.length >= LOOP_RULE_THRESHOLDS.maxSignalsPerRule) continue;
    const first = group[0];
    if (first === undefined) continue;
    const ids = group.map((c) => c.eventId);
    const outcomeText =
      first.outcome === "failed"
        ? `failure "${previewJson(first.result ?? "", 80)}"`
        : `result ${previewJson(first.result ?? "{}", 80)}`;
    signals.push({
      rule: "repeated-identical-call",
      description: `${first.tool} called ${group.length} times with identical input, identical outcome (${first.outcome}) and identical result`,
      evidence: [
        `input ${previewJson(canonicalJson(first.input))}`,
        `same ${outcomeText} each time`,
        `events ${idRange(ids)} (${group.length} calls)`,
      ],
      eventIds: ids,
      caveat:
        "Identical retries can be legitimate (polling, rate-limit backoff); " +
        "the payload alone cannot prove the repeated result carried no new information.",
    });
  }
  return { signals, matched };
};

/**
 * Rule 2: the same file path accessed >=3 times by the same tool. Paths are
 * read from the tool input keys path/file/filePath/filename. Mixed-tool
 * access (test then edit the same file) is treated as plausible progress
 * and reported only when one tool alone still hits the threshold.
 */
const repeatedFiles = (calls: CallInfo[]): RuleResult => {
  const byPath = new Map<string, CallInfo[]>();
  for (const call of calls) {
    for (const target of fileTargetsOf(call.input)) {
      const group = byPath.get(target);
      if (group) group.push(call);
      else byPath.set(target, [call]);
    }
  }
  const ordered: { path: string; group: CallInfo[]; firstIndex: number }[] = [];
  const paths = [...byPath.keys()].sort();
  for (const path of paths) {
    const group = byPath.get(path) ?? [];
    ordered.push({ path, group, firstIndex: group[0]?.index ?? 0 });
  }
  ordered.sort((a, b) => a.firstIndex - b.firstIndex || 0);

  const signals: LoopSignal[] = [];
  let matched = 0;
  for (const { path, group } of ordered) {
    const perTool = new Map<string, number>();
    for (const call of group) {
      perTool.set(call.tool, (perTool.get(call.tool) ?? 0) + 1);
    }
    const maxByTool = Math.max(...perTool.values());
    if (maxByTool < LOOP_RULE_THRESHOLDS.fileRepeatMin) continue;
    matched++;
    if (signals.length >= LOOP_RULE_THRESHOLDS.maxSignalsPerRule) continue;
    const breakdown = [...perTool.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tool, count]) => `${tool} ×${count}`)
      .join(", ");
    const ids = group.map((c) => c.eventId);
    signals.push({
      rule: "repeated-file",
      description: `${path} accessed ${group.length} times (${breakdown})`,
      evidence: [`events ${idRange(ids)} (${group.length} calls)`],
      eventIds: ids,
      caveat:
        "Re-reading a file after edits, or across test-fix cycles, is normal; " +
        "tool payloads do not record whether file contents changed between accesses.",
    });
  }
  return { signals, matched };
};

/** Rule 3: the same error (source type + tool + text) >=3 times. */
const repeatedErrors = (run: Run): RuleResult => {
  const groups = new Map<
    string,
    { label: string; ids: string[]; firstIndex: number }
  >();
  run.events.forEach((event, index) => {
    if (event.type !== "error" && event.type !== "tool.failed") return;
    const tool = toolOf(event);
    const text = errorTextOf(event);
    const key = `${event.type}${tool ?? ""}${text}`;
    const label =
      event.type === "tool.failed" ? `${tool ?? "(unknown)"}: ${text}` : text;
    const group = groups.get(key);
    if (group) group.ids.push(event.id);
    else groups.set(key, { label, ids: [event.id], firstIndex: index });
  });
  const ordered = [...groups.values()].sort(
    (a, b) => a.firstIndex - b.firstIndex,
  );
  const signals: LoopSignal[] = [];
  let matched = 0;
  for (const group of ordered) {
    if (group.ids.length < LOOP_RULE_THRESHOLDS.errorRepeatMin) continue;
    matched++;
    if (signals.length >= LOOP_RULE_THRESHOLDS.maxSignalsPerRule) continue;
    signals.push({
      rule: "repeated-error",
      description: `"${previewJson(group.label, 100)}" repeated ${group.ids.length} times`,
      evidence: [`events ${idRange(group.ids)} (${group.ids.length} errors)`],
      eventIds: group.ids,
      caveat:
        "Repeating an error before a fix attempt is normal recovery behavior; " +
        "only repetition with no intervening change suggests a stuck loop.",
    });
  }
  return { signals, matched };
};

/**
 * Rule 4: tool ping-pong — a cycle of call signatures of length k in
 * [cycleMinLength, cycleMaxLength] completing at least cycleMinTurns full
 * turns (>= 2k calls). Each run is reported at its minimal period so e.g.
 * a,b,a,b,a,b is reported once at k=2, not again at k=4.
 */
const pingPongCycles = (calls: CallInfo[]): RuleResult => {
  const sigs = calls.map((c) => c.signature);
  const reported: { start: number; end: number }[] = [];
  const signals: LoopSignal[] = [];
  let matched = 0;
  for (
    let k = LOOP_RULE_THRESHOLDS.cycleMinLength;
    k <= LOOP_RULE_THRESHOLDS.cycleMaxLength;
    k++
  ) {
    let i = k;
    while (i < sigs.length) {
      if (sigs[i] !== sigs[i - k]) {
        i++;
        continue;
      }
      // Maximal run of matches i..j => span [i-k, j] of length j-i+k+1.
      let j = i;
      while (j + 1 < sigs.length && sigs[j + 1] === sigs[j + 1 - k]) j++;
      const start = i - k;
      const end = j;
      const len = end - start + 1;
      i = j + 1;
      if (len < LOOP_RULE_THRESHOLDS.cycleMinTurns * k) continue;
      const cycle = sigs.slice(start, start + k);
      // Skip when the cycle has a smaller internal period (dedup):
      // e.g. a,b,a,b at k=4 is already reported at k=2, and a,a at k=2
      // is a repeated identical call, not a ping-pong.
      let minimal = true;
      for (let p = 1; p < k && minimal; p++) {
        if (k % p !== 0) continue;
        minimal = !cycle.every((sig, idx) => sig === cycle[idx % p]);
      }
      const covered = reported.some((r) => start >= r.start && end <= r.end);
      if (!minimal || covered) continue;
      matched++;
      reported.push({ start, end });
      if (signals.length >= LOOP_RULE_THRESHOLDS.maxSignalsPerRule) continue;
      const span = calls.slice(start, end + 1);
      const turns = Math.floor(len / k);
      const extra = len % k;
      const labels = span
        .slice(0, k)
        .map((c) => `${c.tool} ${previewJson(canonicalJson(c.input), 60)}`);
      signals.push({
        rule: "tool-ping-pong",
        description: `cycle of ${k} distinct calls repeated ${turns} full turn(s)${extra > 0 ? ` plus ${extra} call(s)` : ""}: ${labels.join(" → ")}`,
        evidence: [
          `events ${idRange(span.map((c) => c.eventId))} (${len} calls)`,
        ],
        eventIds: span.map((c) => c.eventId),
        caveat:
          "Edit→test or read→search alternation is a normal workflow; " +
          "only a cycle that changes nothing between turns is a stuck loop, " +
          "and payloads cannot confirm that.",
      });
    }
  }
  return { signals, matched };
};

/** Event types that can carry observable state change between calls. */
const PROGRESS_EVENT_TYPES = new Set([
  "artifact.created",
  "artifact.updated",
  "plan.created",
  "plan.updated",
  "verification.started",
  "verification.completed",
]);

/**
 * Rule 5: no observable progress — >=4 consecutive finished calls that each
 * re-run an earlier identical call (same signature) returning an identical
 * result, with no progress-carrying event in between. Unfinished calls
 * break the streak: a call still running may yet return new information.
 */
const noProgressStreaks = (run: Run, calls: CallInfo[]): RuleResult => {
  const callIndexByEventIndex = new Map<number, number>();
  calls.forEach((c, i) => {
    callIndexByEventIndex.set(c.index, i);
  });
  const firstSeen = new Map<string, { result: string | undefined }>();
  const streaks: number[][] = [];
  let current: number[] = [];
  const flush = () => {
    if (current.length >= LOOP_RULE_THRESHOLDS.noProgressStreakMin) {
      streaks.push(current);
    }
    current = [];
  };
  run.events.forEach((event, index) => {
    if (PROGRESS_EVENT_TYPES.has(event.type)) {
      flush();
      return;
    }
    const callIndex = callIndexByEventIndex.get(index);
    if (callIndex === undefined) return;
    const call = calls[callIndex];
    if (call === undefined || call.outcome === undefined) {
      flush();
      return;
    }
    const seen = firstSeen.get(call.signature);
    if (seen !== undefined && seen.result === call.result) {
      current.push(callIndex);
      return;
    }
    flush();
    if (seen === undefined) {
      firstSeen.set(call.signature, { result: call.result });
    }
  });
  flush();
  const matched = streaks.length;
  const signals = streaks
    .slice(0, LOOP_RULE_THRESHOLDS.maxSignalsPerRule)
    .map((callIndexes) => {
      const span = callIndexes
        .map((i) => calls[i])
        .filter((c): c is CallInfo => c !== undefined);
      const kinds = [...new Set(span.map((c) => c.tool))].sort().join(", ");
      return {
        rule: "no-observable-progress" as const,
        description: `${callIndexes.length} consecutive tool calls re-ran earlier identical calls and returned identical results (${kinds})`,
        evidence: [
          `events ${idRange(span.map((c) => c.eventId))} (${callIndexes.length} calls, no new inputs or results, no artifact/plan/verification events between them)`,
        ],
        eventIds: span.map((c) => c.eventId),
        caveat:
          "Progress may occur in payloads AgentLens cannot compare (message text, " +
          "external state); this is an observable no-progress pattern, not proof the agent was stuck.",
      };
    });
  return { signals, matched };
};

/**
 * Pure entry point: detect possible loops in one stored run. Deterministic —
 * same events in the same order always produce the same report; event order
 * is preserved; the run is not modified.
 */
export function detectPossibleLoops(run: Run): LoopReport {
  const calls = collectCalls(run);
  const ruleResults: [LoopRule, RuleResult][] = [
    ["repeated-identical-call", repeatedIdenticalCalls(calls)],
    ["repeated-file", repeatedFiles(calls)],
    ["repeated-error", repeatedErrors(run)],
    ["tool-ping-pong", pingPongCycles(calls)],
    ["no-observable-progress", noProgressStreaks(run, calls)],
  ];
  const notes: string[] = [];
  const signals: LoopSignal[] = [];
  let totalSignalCount = 0;
  for (const [rule, result] of ruleResults) {
    totalSignalCount += result.matched;
    signals.push(...result.signals);
    if (result.matched > result.signals.length) {
      notes.push(
        `${rule} matched ${result.matched} times; showing the first ${result.signals.length} in event order (cap maxSignalsPerRule=${LOOP_RULE_THRESHOLDS.maxSignalsPerRule})`,
      );
    }
  }
  for (const signal of signals) {
    if (signal.eventIds.length > LOOP_RULE_THRESHOLDS.maxEventIdsPerSignal) {
      const keep = LOOP_RULE_THRESHOLDS.maxEventIdsPerSignal;
      const total = signal.eventIds.length;
      signal.eventIds = signal.eventIds.slice(0, keep);
      signal.evidence.push(
        `eventIds truncated to first ${keep} of ${total} (cap maxEventIdsPerSignal=${keep}); the events range line above still covers all occurrences`,
      );
    }
    if (signal.evidence.length > LOOP_RULE_THRESHOLDS.maxEvidencePerSignal) {
      const keep = LOOP_RULE_THRESHOLDS.maxEvidencePerSignal;
      signal.evidence = [
        ...signal.evidence.slice(0, keep),
        `… ${signal.evidence.length - keep} more evidence line(s) truncated`,
      ];
    }
  }
  const progressEvidencePresent = run.events.some((event) =>
    PROGRESS_EVENT_TYPES.has(event.type),
  );
  if (!progressEvidencePresent) {
    notes.push(
      "no artifact/plan/verification events recorded: progress cannot be confirmed or denied from stored payloads alone",
    );
  }
  if (calls.some((c) => c.outcome === undefined)) {
    notes.push(
      "unfinished tool call(s) carry no result; they are excluded from repeat counts and break no-progress streaks",
    );
  }
  return { signals, totalSignalCount, progressEvidencePresent, notes };
}
