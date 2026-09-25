import type { AgentEvent } from "../core/event.js";
import type { Run } from "../core/run.js";

/** Pure text renderers for `agentlens runs` and `agentlens inspect`. */

const PAD_ID = 34;
const PAD_STATUS = 9;
const PAD_AGENT = 16;
const PAD_MODEL = 16;

// Pad for alignment but never truncate: run ids and agent names must stay
// complete and copy-pasteable.
const pad = (text: string, width: number) => text.padEnd(width);
const field = (value: string | undefined) => value ?? "-";

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${s}s`;
}

const durationOf = (run: Run): number | undefined =>
  run.metrics.durationMs ??
  (run.endedAt !== undefined
    ? Date.parse(run.endedAt) - Date.parse(run.startedAt)
    : undefined);

const offsetOf = (run: Run, event: AgentEvent): number =>
  Date.parse(event.timestamp) - Date.parse(run.startedAt);

const preview = (value: unknown, max = 80): string => {
  const json = value === undefined ? "-" : JSON.stringify(value);
  return json !== undefined && json.length > max
    ? `${json.slice(0, max - 1)}…`
    : (json ?? "-");
};

const toolName = (event: AgentEvent): string | undefined =>
  typeof event.data === "object" &&
  event.data !== null &&
  "tool" in event.data &&
  typeof (event.data as { tool: unknown }).tool === "string"
    ? (event.data as { tool: string }).tool
    : undefined;

const errorMessage = (event: AgentEvent): string => {
  if (
    typeof event.data === "object" &&
    event.data !== null &&
    "message" in event.data &&
    typeof (event.data as { message: unknown }).message === "string"
  ) {
    return (event.data as { message: string }).message;
  }
  if (
    typeof event.data === "object" &&
    event.data !== null &&
    "error" in event.data &&
    typeof (event.data as { error: unknown }).error === "string"
  ) {
    return (event.data as { error: string }).error;
  }
  return preview(event.data);
};

/** `agentlens runs`: one aligned row per run in stable (startedAt, id) order. */
export function formatRunsTable(runs: Run[]): string {
  if (runs.length === 0) {
    return "No runs recorded.\n";
  }
  const lines = [
    `${pad("ID", PAD_ID)} ${pad("STATUS", PAD_STATUS)} ${pad("AGENT", PAD_AGENT)} ${pad("MODEL", PAD_MODEL)} ${pad("STARTED", 25)} ${pad("ENDED", 25)} ${pad("DURATION", 9)} ${pad("EVENTS", 6)} TOOLS`,
  ];
  for (const run of runs) {
    const duration = durationOf(run);
    const tools = `${run.metrics.toolCalls} (${run.metrics.failedToolCalls} failed)`;
    lines.push(
      `${pad(run.id, PAD_ID)} ${pad(run.status, PAD_STATUS)} ${pad(field(run.agent), PAD_AGENT)} ${pad(field(run.model), PAD_MODEL)} ${pad(run.startedAt, 25)} ${pad(field(run.endedAt), 25)} ${pad(duration !== undefined ? formatDurationMs(duration) : "-", 9)} ${pad(String(run.events.length), 6)} ${tools}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

interface ToolOutcome {
  started: AgentEvent;
  end?: AgentEvent;
}

/** Pairs each tool.started with its tool.completed/tool.failed (via parentId). */
function toolOutcomes(run: Run): ToolOutcome[] {
  const byId = new Map(run.events.map((e) => [e.id, e]));
  const outcomes: ToolOutcome[] = [];
  for (const event of run.events) {
    if (event.type === "tool.started") {
      outcomes.push({ started: event });
    } else if (
      event.type === "tool.completed" ||
      event.type === "tool.failed"
    ) {
      const parent =
        event.parentId !== undefined ? byId.get(event.parentId) : undefined;
      const outcome = outcomes.find((o) => o.started === parent);
      if (outcome) outcome.end = event;
      else outcomes.push({ started: event, end: event });
    }
  }
  return outcomes;
}

const toolDetail = (event: AgentEvent): string => {
  const data = event.data as {
    input?: unknown;
    output?: unknown;
    durationMs?: number;
    error?: string;
  };
  const parts: string[] = [];
  if (event.type === "tool.started" && data.input !== undefined) {
    parts.push(`input=${preview(data.input)}`);
  }
  if (data.output !== undefined) parts.push(`output=${preview(data.output)}`);
  if (data.durationMs !== undefined)
    parts.push(formatDurationMs(data.durationMs));
  if (data.error !== undefined) parts.push(`error: ${data.error}`);
  return parts.join(" ");
};

const eventSummary = (event: AgentEvent): string => {
  const tool = toolName(event);
  if (tool !== undefined) {
    const detail = toolDetail(event);
    return `${event.type} ${tool}${detail !== "" ? ` ${detail}` : ""}`;
  }
  if (event.type === "error") {
    return `error ${errorMessage(event)}`;
  }
  return event.data === null
    ? event.type
    : `${event.type} ${preview(event.data)}`;
};

/** `agentlens inspect <run-id>`: metadata, tools, errors, metrics, timeline, result. */
export function formatRunInspect(run: Run): string {
  const out: string[] = [`Run ${run.id}`, "", "Metadata"];
  out.push(`  Status    ${run.status}`);
  out.push(`  Agent     ${field(run.agent)}`);
  out.push(`  Model     ${field(run.model)}`);
  out.push(`  Started   ${run.startedAt}`);
  out.push(`  Ended     ${field(run.endedAt)}`);
  const duration = durationOf(run);
  out.push(
    `  Duration  ${duration !== undefined ? formatDurationMs(duration) : "-"}`,
  );

  const m = run.metrics;
  const tokens: string[] = [];
  if (m.inputTokens !== undefined) tokens.push(`input ${m.inputTokens}`);
  if (m.outputTokens !== undefined) tokens.push(`output ${m.outputTokens}`);
  if (m.reasoningTokens !== undefined)
    tokens.push(`reasoning ${m.reasoningTokens}`);
  const files: string[] = [];
  if (m.filesRead !== undefined) files.push(`read ${m.filesRead}`);
  if (m.filesWritten !== undefined) files.push(`written ${m.filesWritten}`);

  out.push("", "Metrics");
  out.push(`  Tool calls    ${m.toolCalls} (${m.failedToolCalls} failed)`);
  if (tokens.length > 0) out.push(`  Tokens        ${tokens.join(" / ")}`);
  if (files.length > 0) out.push(`  Files         ${files.join(" / ")}`);

  const tools = toolOutcomes(run);
  out.push("", "Tool calls");
  if (tools.length === 0) {
    out.push("  (none)");
  }
  tools.forEach((t, i) => {
    const name = toolName(t.started) ?? "(unknown)";
    const end = t.end !== undefined && t.end !== t.started ? t.end : undefined;
    if (end === undefined) {
      out.push(`  ${i + 1}. ${name}  started, no outcome`);
      return;
    }
    const ok = end.type === "tool.completed";
    const parts = [ok ? "ok" : "failed"];
    const data = end.data as { durationMs?: number; error?: string };
    if (data.durationMs !== undefined)
      parts.push(formatDurationMs(data.durationMs));
    if (data.error !== undefined) parts.push(`error: ${data.error}`);
    out.push(`  ${i + 1}. ${name}  ${parts.join("  ")}`);
    const input = (t.started.data as { input?: unknown }).input;
    if (input !== undefined) out.push(`      input   ${preview(input)}`);
    const output = (end.data as { output?: unknown }).output;
    if (output !== undefined) out.push(`      output  ${preview(output)}`);
  });

  const errorEvents = run.events.filter(
    (e) => e.type === "error" || e.type === "tool.failed",
  );
  out.push("", "Errors");
  if (errorEvents.length === 0) {
    out.push("  (none)");
  }
  for (const event of errorEvents) {
    const prefix =
      event.type === "tool.failed" ? `${toolName(event) ?? "tool"}: ` : "";
    out.push(
      `  +${formatDurationMs(offsetOf(run, event))}  ${prefix}${errorMessage(event)}`,
    );
  }

  out.push("", "Timeline");
  for (const event of run.events) {
    out.push(
      `  +${formatDurationMs(offsetOf(run, event))}  ${eventSummary(event)}`,
    );
  }

  out.push("", "Result");
  const terminal = run.events.at(-1);
  out.push(
    `  ${run.status}` +
      (terminal !== undefined
        ? ` (${terminal.type} at ${terminal.timestamp})`
        : ""),
  );
  if (terminal !== undefined && terminal.data !== null) {
    out.push(`  Payload   ${preview(terminal.data, 120)}`);
  }
  return `${out.join("\n")}\n`;
}
