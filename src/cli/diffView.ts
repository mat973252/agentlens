import type { AgentEvent } from "../core/event.js";
import type { JsonValue } from "../core/json.js";
import type { Run } from "../core/run.js";
import type { StoredRelayEvidence } from "../storage/sqlite/store.js";
import {
  durationOf,
  errorMessage,
  eventSummary,
  formatDurationMs,
  offsetOf,
  preview,
  toolName,
  toolOutcomes,
} from "./eventDetails.js";
import { formatRelayEvidenceDiffSection } from "./relayView.js";

/** Pure text renderer for `agentlens diff <runA> <runB>`. */

const pad = (text: string, width: number) => text.padEnd(width);
const UNKNOWN = "unknown";

const canonicalJson = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key] ?? null)]),
    );
  }
  return value;
};

const sameData = (a: AgentEvent, b: AgentEvent): boolean =>
  JSON.stringify(canonicalJson(a.data)) ===
  JSON.stringify(canonicalJson(b.data));

const signature = (event: AgentEvent): string =>
  `${event.type}\0${toolName(event) ?? ""}`;

const signatureLabel = (event: AgentEvent): string => {
  const tool = toolName(event);
  return tool === undefined ? event.type : `${event.type} ${tool}`;
};

type TimelineOp =
  | {
      kind: "same" | "changed";
      a: AgentEvent;
      b: AgentEvent;
      ai: number;
      bi: number;
    }
  | { kind: "a"; a: AgentEvent; ai: number }
  | { kind: "b"; b: AgentEvent; bi: number };

/**
 * Aligns event signatures by longest common subsequence. Signatures contain
 * only event type and tool name; ids, timestamps and payloads are ignored.
 * Equal-length alternatives always emit the unmatched A event first.
 */
const timelineOps = (a: Run, b: Run): TimelineOp[] => {
  const aSig = a.events.map(signature);
  const bSig = b.events.map(signature);
  const n = aSig.length;
  const m = bSig.length;
  const width = m + 1;
  const dp = new Array<number>((n + 1) * width).fill(0);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        aSig[i] === bSig[j]
          ? (dp[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + j + 1] ?? 0);
    }
  }

  const ops: TimelineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const aEvent = a.events[i];
    const bEvent = b.events[j];
    if (aEvent !== undefined && bEvent !== undefined && aSig[i] === bSig[j]) {
      ops.push({
        kind: sameData(aEvent, bEvent) ? "same" : "changed",
        a: aEvent,
        b: bEvent,
        ai: i,
        bi: j,
      });
      i++;
      j++;
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
      if (aEvent !== undefined) ops.push({ kind: "a", a: aEvent, ai: i });
      i++;
    } else {
      if (bEvent !== undefined) ops.push({ kind: "b", b: bEvent, bi: j });
      j++;
    }
  }
  while (i < n) {
    const event = a.events[i];
    if (event !== undefined) ops.push({ kind: "a", a: event, ai: i });
    i++;
  }
  while (j < m) {
    const event = b.events[j];
    if (event !== undefined) ops.push({ kind: "b", b: event, bi: j });
    j++;
  }
  return ops;
};

const numberText = (value: number | undefined): string =>
  value === undefined ? UNKNOWN : String(value);

const numericDelta = (a: number | undefined, b: number | undefined): string => {
  if (a === undefined || b === undefined) return UNKNOWN;
  const delta = b - a;
  const sign = delta > 0 ? "+" : "";
  if (a === 0) return `${sign}${delta}`;
  const pct = (delta / a) * 100;
  const pctSign = pct > 0 ? "+" : "";
  return `${sign}${delta} (${pctSign}${pct.toFixed(1)}%)`;
};

const durationText = (value: number | undefined): string =>
  value === undefined ? UNKNOWN : formatDurationMs(value);

const durationDelta = (
  a: number | undefined,
  b: number | undefined,
): string => {
  if (a === undefined || b === undefined) return UNKNOWN;
  const delta = b - a;
  const text = `${delta > 0 ? "+" : delta < 0 ? "-" : "+"}${formatDurationMs(Math.abs(delta))}`;
  if (a === 0) return text;
  const pct = (delta / a) * 100;
  return `${text} (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`;
};

const metricRow = (
  label: string,
  a: string,
  b: string,
  delta: string,
): string => `  ${pad(label, 18)} ${pad(a, 17)} ${pad(b, 17)} ${delta}`;

const toolCounts = (
  run: Run,
): { counts: Map<string, number>; unfinished: string[] } => {
  const counts = new Map<string, number>();
  const unfinished: string[] = [];
  for (const outcome of toolOutcomes(run)) {
    const name = toolName(outcome.started) ?? "(unknown)";
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (outcome.end === undefined) unfinished.push(name);
  }
  return { counts, unfinished };
};

const errorGroups = (
  run: Run,
): { count: number; groups: { label: string; count: number }[] } => {
  const events = run.events.filter(
    (event) => event.type === "error" || event.type === "tool.failed",
  );
  const groups = new Map<string, { label: string; count: number }>();
  for (const event of events) {
    const label = `${event.type}${toolName(event) !== undefined ? ` ${toolName(event)}` : ""}: ${errorMessage(event)}`;
    const key = `${event.type}\0${toolName(event) ?? ""}\0${errorMessage(event)}`;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { label, count: 1 });
  }
  return { count: events.length, groups: [...groups.values()] };
};

const outcomeLine = (run: Run): string => {
  const terminal = run.events.at(-1);
  const base = `${run.status}${terminal !== undefined ? ` (${terminal.type} at ${terminal.timestamp})` : ""}`;
  return terminal !== undefined && terminal.data !== null
    ? `${base} ${preview(terminal.data, 100)}`
    : base;
};

export function formatRunDiff(
  a: Run,
  b: Run,
  aEvidence?: StoredRelayEvidence,
  bEvidence?: StoredRelayEvidence,
): string {
  const out: string[] = [`Diff ${a.id} vs ${b.id}`, "", "Summary"];
  const aDuration = durationOf(a);
  const bDuration = durationOf(b);
  const aTools = toolCounts(a);
  const bTools = toolCounts(b);

  out.push(
    metricRow("Status", a.status, b.status, `${a.status} -> ${b.status}`),
  );
  out.push(
    metricRow(
      "Duration",
      durationText(aDuration),
      durationText(bDuration),
      durationDelta(aDuration, bDuration),
    ),
  );
  out.push(
    metricRow(
      "Input tokens",
      numberText(a.metrics.inputTokens),
      numberText(b.metrics.inputTokens),
      numericDelta(a.metrics.inputTokens, b.metrics.inputTokens),
    ),
  );
  out.push(
    metricRow(
      "Output tokens",
      numberText(a.metrics.outputTokens),
      numberText(b.metrics.outputTokens),
      numericDelta(a.metrics.outputTokens, b.metrics.outputTokens),
    ),
  );
  out.push(
    metricRow(
      "Reasoning tokens",
      numberText(a.metrics.reasoningTokens),
      numberText(b.metrics.reasoningTokens),
      numericDelta(a.metrics.reasoningTokens, b.metrics.reasoningTokens),
    ),
  );
  out.push(
    metricRow(
      "Tool calls",
      String(a.metrics.toolCalls),
      String(b.metrics.toolCalls),
      numericDelta(a.metrics.toolCalls, b.metrics.toolCalls),
    ),
  );
  out.push(
    metricRow(
      "Failed tools",
      String(a.metrics.failedToolCalls),
      String(b.metrics.failedToolCalls),
      numericDelta(a.metrics.failedToolCalls, b.metrics.failedToolCalls),
    ),
  );
  out.push(
    metricRow(
      "Unfinished tools",
      String(aTools.unfinished.length),
      String(bTools.unfinished.length),
      numericDelta(aTools.unfinished.length, bTools.unfinished.length),
    ),
  );

  out.push("", "Tool distribution");
  out.push(
    "  Counts are event-derived (one tool.started per call; a terminal tool event without a started event still counts). Sorted by absolute change, then tool name.",
  );
  const names = [...new Set([...aTools.counts.keys(), ...bTools.counts.keys()])]
    .map((name) => {
      const aCount = aTools.counts.get(name) ?? 0;
      const bCount = bTools.counts.get(name) ?? 0;
      return { name, aCount, bCount, delta: bCount - aCount };
    })
    .sort(
      (x, y) =>
        Math.abs(y.delta) - Math.abs(x.delta) ||
        (x.name < y.name ? -1 : x.name > y.name ? 1 : 0),
    );
  if (names.length === 0) {
    out.push("  (no tool events)");
  } else {
    out.push(`  ${pad("TOOL", 20)} ${pad("A", 6)} ${pad("B", 6)} CHANGE`);
    for (const row of names) {
      out.push(
        `  ${pad(row.name, 20)} ${pad(String(row.aCount), 6)} ${pad(String(row.bCount), 6)} ${row.delta > 0 ? "+" : ""}${row.delta}`,
      );
    }
  }
  if (aTools.unfinished.length > 0 || bTools.unfinished.length > 0) {
    const describe = (items: string[]) => {
      const counts = new Map<string, number>();
      for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
      return [...counts.entries()]
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        .map(([name, count]) => `${name}×${count}`)
        .join(", ");
    };
    out.push(
      `  Unfinished: A ${aTools.unfinished.length}${aTools.unfinished.length > 0 ? ` (${describe(aTools.unfinished)})` : ""}; B ${bTools.unfinished.length}${bTools.unfinished.length > 0 ? ` (${describe(bTools.unfinished)})` : ""}`,
    );
  }

  const aErrors = errorGroups(a);
  const bErrors = errorGroups(b);
  out.push("", "Errors");
  out.push(
    `  Recorded failure/error events: A ${aErrors.count}; B ${bErrors.count}. Entries are grouped only by identical source type, tool and error text; identical text from different sources is not treated as the same root cause.`,
  );
  const writeErrors = (
    label: "A" | "B",
    groups: { label: string; count: number }[],
  ) => {
    out.push(`  ${label}`);
    if (groups.length === 0) out.push("    (none)");
    for (const group of groups) {
      out.push(
        `    ${group.label}${group.count > 1 ? ` ×${group.count}` : ""}`,
      );
    }
  };
  writeErrors("A", aErrors.groups);
  writeErrors("B", bErrors.groups);

  out.push("", "Outcome");
  out.push(`  A ${outcomeLine(a)}`);
  out.push(`  B ${outcomeLine(b)}`);
  out.push(`  Change ${a.status} -> ${b.status}`);

  out.push("", "Timeline diff");
  out.push(
    "  Match rule: events align by longest common subsequence of signatures (event type + tool name); ids, timestamps and payloads do not affect matching. '=' same signature and payload, '~' same signature but different payload, '-' only in A, '+' only in B. Offsets are relative to each run's start.",
  );
  const ops = timelineOps(a, b);
  let differences = 0;
  for (const op of ops) {
    if (op.kind !== "same") differences++;
    if (op.kind === "same") {
      out.push(
        `  = A${op.ai + 1}/B${op.bi + 1} +${formatDurationMs(offsetOf(a, op.a))}/+${formatDurationMs(offsetOf(b, op.b))} ${signatureLabel(op.a)}`,
      );
    } else if (op.kind === "changed") {
      out.push(
        `  ~ A${op.ai + 1}/B${op.bi + 1} +${formatDurationMs(offsetOf(a, op.a))}/+${formatDurationMs(offsetOf(b, op.b))} ${signatureLabel(op.a)}`,
      );
      out.push(`      A ${preview(op.a.data, 100)}`);
      out.push(`      B ${preview(op.b.data, 100)}`);
    } else if (op.kind === "a") {
      out.push(
        `  - A${op.ai + 1} +${formatDurationMs(offsetOf(a, op.a))} ${eventSummary(op.a)}`,
      );
    } else {
      out.push(
        `  + B${op.bi + 1} +${formatDurationMs(offsetOf(b, op.b))} ${eventSummary(op.b)}`,
      );
    }
  }
  if (differences === 0) out.push("  (no signature or payload differences)");

  // Observed evidence is compared in its own section, never merged into
  // run/tool metrics or the timeline alignment.
  out.push("", ...formatRelayEvidenceDiffSection(a, b, aEvidence, bEvidence));

  return `${out.join("\n")}\n`;
}
