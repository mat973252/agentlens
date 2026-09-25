import { formatRunDiff } from "../cli/diffView.js";
import {
  durationOf,
  errorMessage,
  eventSummary,
  formatDurationMs,
  offsetOf,
  preview,
  toolName,
  toolOutcomes,
} from "../cli/eventDetails.js";
import { formatRunInspect } from "../cli/runView.js";
import { detectPossibleLoops } from "../core/loops.js";
import type { Run } from "../core/run.js";

/**
 * Read-only view-model builders for the TUI. Everything derives from the
 * same helpers the text CLI uses (eventDetails/runView/diffView/loops), so
 * status, tool paths, errors and outcomes shown interactively match the
 * `runs`/`inspect`/`diff` commands exactly.
 */

export interface TuiData {
  dbPath: string;
  runs: Run[];
}

export type Tone =
  | "paper"
  | "dim"
  | "faint"
  | "mint"
  | "teal"
  | "bad"
  | "warn"
  | "good";

/** One selectable row. `detail` is the full untruncated text for the pager. */
export interface Item {
  summary: string;
  tone: Tone;
  detail?: string;
  /** Section header row: not selectable for expansion, jumpable with Tab. */
  section?: boolean;
}

export const DETAIL_TABS = [
  "timeline",
  "tools",
  "errors",
  "loops",
  "inspect",
] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

const pretty = (value: unknown): string =>
  JSON.stringify(value, null, 2) ?? "-";

const eventTone = (type: string): Tone => {
  if (type === "tool.failed" || type === "error" || type === "run.failed")
    return "bad";
  if (type === "run.completed") return "good";
  if (type === "tool.started" || type === "tool.completed") return "paper";
  return "dim";
};

const eventDetail = (run: Run, event: Run["events"][number]): string =>
  [
    `event ${event.id} · ${event.type} · ${event.timestamp}`,
    `offset +${formatDurationMs(offsetOf(run, event))}` +
      (event.parentId !== undefined ? ` · parent ${event.parentId}` : ""),
    "",
    `data ${pretty(event.data)}`,
  ].join("\n");

const SECTION_NAMES = [
  "Metadata",
  "Metrics",
  "Tool calls",
  "Errors",
  "Timeline",
  "Possible loops",
  "Result",
];

/** Items for one detail tab of a run. */
export function detailItems(run: Run, tab: DetailTab): Item[] {
  if (tab === "timeline") {
    return run.events.map((event) => ({
      summary: `+${formatDurationMs(offsetOf(run, event))}  ${eventSummary(event)}`,
      tone: eventTone(event.type),
      detail: eventDetail(run, event),
    }));
  }
  if (tab === "tools") {
    const items: Item[] = toolOutcomes(run).map((outcome, i) => {
      const name = toolName(outcome.started) ?? "(unknown)";
      const end =
        outcome.end !== undefined && outcome.end !== outcome.started
          ? outcome.end
          : undefined;
      const startedData = outcome.started.data as { input?: unknown };
      const input = startedData.input;
      if (end === undefined) {
        return {
          summary:
            `${i + 1}. ${name}  started, no outcome` +
            (input !== undefined ? `  input ${preview(input, 40)}` : ""),
          tone: "warn",
          detail: eventDetail(run, outcome.started),
        };
      }
      const data = end.data as {
        output?: unknown;
        durationMs?: number;
        error?: string;
      };
      const ok = end.type === "tool.completed";
      const parts = [ok ? "ok" : "failed"];
      if (data.durationMs !== undefined)
        parts.push(formatDurationMs(data.durationMs));
      if (data.error !== undefined) parts.push(`error: ${data.error}`);
      const detail = [
        `tool call ${i + 1} · ${name} · ${parts.join(" · ")}`,
        `started ${outcome.started.id} · outcome ${end.id}`,
        "",
        `input  ${pretty(input)}`,
        `output ${pretty(data.output)}`,
        ...(data.error !== undefined ? [`error  ${data.error}`] : []),
      ].join("\n");
      return {
        summary:
          `${i + 1}. ${name}  ${parts.join("  ")}` +
          (input !== undefined ? `  input ${preview(input, 40)}` : ""),
        tone: ok ? "paper" : "bad",
        detail,
      };
    });
    if (items.length === 0)
      items.push({ summary: "(no tool calls recorded)", tone: "faint" });
    return items;
  }
  if (tab === "errors") {
    const items: Item[] = run.events
      .filter((e) => e.type === "error" || e.type === "tool.failed")
      .map((event) => ({
        summary:
          `+${formatDurationMs(offsetOf(run, event))}  ` +
          `${toolName(event) !== undefined ? `${toolName(event)}: ` : ""}${errorMessage(event)}`,
        tone: "bad",
        detail: eventDetail(run, event),
      }));
    if (items.length === 0)
      items.push({ summary: "(no errors recorded)", tone: "faint" });
    return items;
  }
  if (tab === "loops") {
    const report = detectPossibleLoops(run);
    const items: Item[] = [];
    if (report.totalSignalCount === 0) {
      items.push({ summary: "No loop signals detected.", tone: "good" });
    } else {
      report.signals.forEach((signal, i) => {
        items.push({
          summary: `${i + 1}. [${signal.rule}] ${signal.description}`,
          tone: "warn",
          detail: [
            `${signal.rule}`,
            signal.description,
            "",
            ...signal.evidence.map((line) => `evidence  ${line}`),
            `boundary  ${signal.caveat}`,
          ].join("\n"),
        });
      });
      if (report.signals.length < report.totalSignalCount) {
        items.push({
          summary: `… ${report.totalSignalCount - report.signals.length} more signal(s) truncated`,
          tone: "faint",
        });
      }
    }
    for (const note of report.notes) {
      items.push({ summary: `note: ${note}`, tone: "faint" });
    }
    return items;
  }
  // inspect: exact `agentlens inspect` text; header rows are section rows.
  return formatRunInspect(run)
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => ({
      summary: line,
      tone: line.startsWith("  +")
        ? eventTone(line.trim().split(/\s+/)[1] ?? "")
        : "paper",
      section: SECTION_NAMES.includes(line) || line.startsWith("Run "),
      detail: formatRunInspect(run),
    }));
}

export interface CompareRow {
  label: string;
  a: string;
  b: string;
  delta: string;
  section?: boolean;
}

const text = (value: string | undefined): string => value ?? "unknown";
const num = (value: number | undefined): string =>
  value === undefined ? "unknown" : String(value);
const dur = (value: number | undefined): string =>
  value === undefined ? "unknown" : formatDurationMs(value);

const numericDelta = (a: number | undefined, b: number | undefined): string => {
  if (a === undefined || b === undefined) return "unknown";
  const delta = b - a;
  const sign = delta > 0 ? "+" : "";
  if (a === 0) return `${sign}${delta}`;
  const pct = (delta / a) * 100;
  return `${sign}${delta} (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`;
};

/** Compressed tool path, e.g. `read_file×3 → grep → test ✗`. */
export function toolPath(run: Run): string {
  const segments: { name: string; count: number; failed: boolean }[] = [];
  for (const outcome of toolOutcomes(run)) {
    const name = toolName(outcome.started) ?? "(unknown)";
    const failed = outcome.end?.type === "tool.failed";
    const last = segments.at(-1);
    if (last !== undefined && last.name === name) {
      last.count++;
      last.failed = last.failed || failed;
    } else {
      segments.push({ name, count: 1, failed });
    }
  }
  if (segments.length === 0) return "(no tool calls)";
  return segments
    .map(
      (s) =>
        `${s.name}${s.count > 1 ? `×${s.count}` : ""}${s.failed ? " ✗" : ""}`,
    )
    .join(" → ");
}

export function loopCount(run: Run): number {
  return detectPossibleLoops(run).totalSignalCount;
}

/** Side-by-side comparison rows for the home compare card (A vs B). */
export function compareRows(a: Run | null, b: Run | null): CompareRow[] {
  const rows: CompareRow[] = [];
  const val = (f: (run: Run) => string): [string, string] => [
    a !== null ? f(a) : "-",
    b !== null ? f(b) : "-",
  ];
  const push = (
    label: string,
    f: (run: Run) => string,
    delta?: (ra: Run, rb: Run) => string,
  ) => {
    const [av, bv] = val(f);
    rows.push({
      label,
      a: av,
      b: bv,
      delta: delta !== undefined && a !== null && b !== null ? delta(a, b) : "",
    });
  };
  push(
    "Status",
    (r) => r.status,
    (ra, rb) => (ra.status === rb.status ? "=" : `${ra.status} → ${rb.status}`),
  );
  push("Agent", (r) => text(r.agent));
  push("Model", (r) => text(r.model));
  push("Started", (r) => r.startedAt.replace("T", " ").replace(/\.\d+/, ""));
  push(
    "Duration",
    (r) => dur(durationOf(r)),
    (ra, rb) => {
      const da = durationOf(ra);
      const db = durationOf(rb);
      if (da === undefined || db === undefined) return "unknown";
      return `${db - da > 0 ? "+" : db - da < 0 ? "-" : "±"}${formatDurationMs(Math.abs(db - da))}`;
    },
  );
  push(
    "Input tokens",
    (r) => num(r.metrics.inputTokens),
    (ra, rb) => numericDelta(ra.metrics.inputTokens, rb.metrics.inputTokens),
  );
  push(
    "Output tokens",
    (r) => num(r.metrics.outputTokens),
    (ra, rb) => numericDelta(ra.metrics.outputTokens, rb.metrics.outputTokens),
  );
  push(
    "Reasoning tokens",
    (r) => num(r.metrics.reasoningTokens),
    (ra, rb) =>
      numericDelta(ra.metrics.reasoningTokens, rb.metrics.reasoningTokens),
  );
  push(
    "Tool calls",
    (r) => String(r.metrics.toolCalls),
    (ra, rb) => numericDelta(ra.metrics.toolCalls, rb.metrics.toolCalls),
  );
  push(
    "Failed tools",
    (r) => String(r.metrics.failedToolCalls),
    (ra, rb) =>
      numericDelta(ra.metrics.failedToolCalls, rb.metrics.failedToolCalls),
  );
  push("Files read", (r) => num(r.metrics.filesRead));
  push("Files written", (r) => num(r.metrics.filesWritten));
  push("Events", (r) => String(r.events.length));
  push("Possible loops", (r) => String(loopCount(r)));
  rows.push({ label: "TOOL PATH", a: "", b: "", delta: "", section: true });
  rows.push({
    label: "A",
    a: a !== null ? toolPath(a) : "-",
    b: "",
    delta: "",
  });
  rows.push({
    label: "B",
    a: b !== null ? toolPath(b) : "-",
    b: "",
    delta: "",
  });
  return rows;
}

const DIFF_SECTIONS = [
  "Summary",
  "Tool distribution",
  "Errors",
  "Outcome",
  "Timeline diff",
];

/** Full `agentlens diff` text plus the row indexes of its section headers. */
export function diffText(
  a: Run,
  b: Run,
): { lines: { text: string; section: boolean }[] } {
  const lines = formatRunDiff(a, b).replace(/\n$/, "").split("\n");
  return {
    lines: lines.map((l) => ({
      text: l,
      section: DIFF_SECTIONS.includes(l) || l.startsWith("Diff "),
    })),
  };
}

/** Compact run summary strip shown above the detail tabs. */
export function runSummaryStrip(run: Run): string {
  const tokens = `in ${num(run.metrics.inputTokens)}/out ${num(run.metrics.outputTokens)}/reas ${num(run.metrics.reasoningTokens)}`;
  return [
    `${run.status}  ${text(run.agent)} · ${text(run.model)}`,
    `${dur(durationOf(run))} · ${run.metrics.toolCalls} tools (${run.metrics.failedToolCalls} failed) · ${run.events.length} events · ${loopCount(run)} loop signal(s)`,
    `tokens ${tokens} · files r${num(run.metrics.filesRead)}/w${num(run.metrics.filesWritten)} · ${run.startedAt}`,
  ].join("\n");
}
