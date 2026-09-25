import type { AgentEvent } from "../core/event.js";
import type { Run } from "../core/run.js";

/** Shared, read-only event helpers for the text CLI views. */

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${s}s`;
}

export const durationOf = (run: Run): number | undefined =>
  run.metrics.durationMs ??
  (run.endedAt !== undefined
    ? Date.parse(run.endedAt) - Date.parse(run.startedAt)
    : undefined);

export const offsetOf = (run: Run, event: AgentEvent): number =>
  Date.parse(event.timestamp) - Date.parse(run.startedAt);

export const preview = (value: unknown, max = 80): string => {
  const json = value === undefined ? "-" : JSON.stringify(value);
  return json !== undefined && json.length > max
    ? `${json.slice(0, max - 1)}…`
    : (json ?? "-");
};

export const toolName = (event: AgentEvent): string | undefined =>
  typeof event.data === "object" &&
  event.data !== null &&
  "tool" in event.data &&
  typeof (event.data as { tool: unknown }).tool === "string"
    ? (event.data as { tool: string }).tool
    : undefined;

export const errorMessage = (event: AgentEvent): string => {
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

export interface ToolOutcome {
  started: AgentEvent;
  end?: AgentEvent;
}

/** Pairs each tool.started with its tool.completed/tool.failed (via parentId). */
export function toolOutcomes(run: Run): ToolOutcome[] {
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

export const eventSummary = (event: AgentEvent): string => {
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
