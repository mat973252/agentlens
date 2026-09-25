import { detectPossibleLoops } from "../core/loops.js";
import type { Run } from "../core/run.js";
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
import { formatLoopSection } from "./loopView.js";

/** Pure text renderers for `agentlens runs` and `agentlens inspect`. */

const PAD_ID = 34;
const PAD_STATUS = 9;
const PAD_AGENT = 16;
const PAD_MODEL = 16;

// Pad for alignment but never truncate: run ids and agent names must stay
// complete and copy-pasteable.
const pad = (text: string, width: number) => text.padEnd(width);
const field = (value: string | undefined) => value ?? "-";

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

/**
 * `agentlens inspect <run-id>`: metadata, tools, errors, metrics, timeline,
 * rules-based possible-loop diagnostics, result.
 */
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

  out.push(...formatLoopSection(detectPossibleLoops(run)));

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
