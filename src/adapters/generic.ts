import { z } from "zod";
import {
  AgentLensValidationError,
  UnsupportedSchemaVersionError,
} from "../core/errors.js";
import {
  AGENT_EVENT_TYPES,
  type AgentEvent,
  type AgentEventType,
} from "../core/event.js";
import { type JsonValue, jsonValueSchema } from "../core/json.js";
import { runMetricsSchema } from "../core/metrics.js";
import { parseRun, RUN_STATUSES, type Run } from "../core/run.js";

/**
 * Generic JSONL adapter: a simple line-per-event input for external agents.
 *
 *   {"format":"agentlens-generic","formatVersion":1,"kind":"run","run":{"id":...,"agent":...,"model":...,"startedAt":...,"status":...,"metrics":{...}}}
 *   {"format":"agentlens-generic","formatVersion":1,"kind":"event","event":{"id":...,"type":...,"timestamp":...,"data":...}}
 *
 * Rules:
 * - exactly one `kind:"run"` line, and it must be the first non-empty line;
 *   only `id` is required — agent/model/startedAt/endedAt/status/metrics are
 *   optional and never guessed: startedAt falls back to the first event
 *   timestamp, endedAt to the last event timestamp of a terminal run, and
 *   status is derived from the terminal event (run.completed → passed,
 *   run.failed → failed, otherwise running). metrics may carry explicit
 *   token counts; toolCalls/failedToolCalls are computed when metrics is
 *   absent;
 * - every following line is `kind:"event"`. Non-tool events map `type` to an
 *   AgentEventType one-to-one and keep `data` verbatim (opaque JSON);
 *   `parentId` references an earlier event id. Unknown `type` values and
 *   unknown fields are rejected, never dropped or rewritten;
 * - `tool.started` takes `tool` (required), optional `input` and a
 *   `toolCallId` (defaults to the event id) that links the call pair;
 *   `tool.completed`/`tool.failed` take `toolCallId` (resolved to the
 *   matching earlier `tool.started`) or an explicit `parentId`, plus
 *   optional `output`/`error`/`durationMs`. `tool`/`input` inherit from the
 *   linked start event when omitted;
 * - malformed JSON, a missing/duplicated run line, an event before the run
 *   line, an unsupported formatVersion, an unknown event type or an invalid
 *   tool association fails the whole import with a line number.
 */
export const GENERIC_JSONL_FORMAT = "agentlens-generic";
export const GENERIC_JSONL_FORMAT_VERSION = 1;

const TOOL_TYPES: ReadonlySet<AgentEventType> = new Set([
  "tool.started",
  "tool.completed",
  "tool.failed",
]);

const genericRunSchema = z.strictObject({
  id: z.string().min(1),
  agent: z.string().optional(),
  model: z.string().optional(),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  endedAt: z.iso.datetime({ offset: true }).optional(),
  status: z.enum(RUN_STATUSES).optional(),
  metrics: runMetricsSchema.optional(),
});

const genericEventSchema = z.strictObject({
  id: z.string().min(1),
  type: z.enum(AGENT_EVENT_TYPES),
  timestamp: z.iso.datetime({ offset: true }),
  parentId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  data: jsonValueSchema.optional(),
  tool: z.string().min(1).optional(),
  input: jsonValueSchema.optional(),
  output: jsonValueSchema.optional(),
  error: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
});

type GenericEvent = z.infer<typeof genericEventSchema>;

const genericLineSchema = z
  .strictObject({
    format: z.literal(GENERIC_JSONL_FORMAT),
    formatVersion: z.number().int(),
    kind: z.enum(["run", "event"]),
    run: z.unknown().optional(),
    event: z.unknown().optional(),
  })
  .superRefine((line, ctx) => {
    if (line.kind === "run") {
      if (line.run === undefined) {
        ctx.addIssue({ code: "custom", message: 'kind "run" requires "run"' });
      }
      if (line.event !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: 'kind "run" must not carry "event"',
        });
      }
    } else {
      if (line.event === undefined) {
        ctx.addIssue({
          code: "custom",
          message: 'kind "event" requires "event"',
        });
      }
      if (line.run !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: 'kind "event" must not carry "run"',
        });
      }
    }
  });

function fail(lineNumber: number, message: string): never {
  throw new AgentLensValidationError(
    `Invalid generic JSONL: line ${lineNumber}: ${message}`,
  );
}

function normalizeEvent(
  event: GenericEvent,
  runId: string,
  lineNumber: number,
  toolCalls: Map<string, { eventId: string; tool: string; input?: JsonValue }>,
): AgentEvent {
  const isTool = TOOL_TYPES.has(event.type);
  const toolFields = [
    "tool",
    "input",
    "output",
    "error",
    "durationMs",
    "toolCallId",
  ] as const;
  if (!isTool) {
    const misplaced = toolFields.filter((f) => event[f] !== undefined);
    if (misplaced.length > 0) {
      fail(
        lineNumber,
        `fields ${misplaced.map((f) => `"${f}"`).join(", ")} are only valid on tool.* events`,
      );
    }
    if (event.data === undefined) {
      fail(lineNumber, `non-tool event "${event.type}" requires "data"`);
    }
    return {
      id: event.id,
      runId,
      timestamp: event.timestamp,
      type: event.type,
      ...(event.parentId !== undefined ? { parentId: event.parentId } : {}),
      data: event.data,
    };
  }

  if (event.data !== undefined) {
    fail(
      lineNumber,
      `tool event "${event.type}" takes tool/input/output/error/durationMs fields, not "data"`,
    );
  }

  if (event.type === "tool.started") {
    if (event.tool === undefined) {
      fail(lineNumber, 'tool.started requires "tool"');
    }
    const callId = event.toolCallId ?? event.id;
    if (toolCalls.has(callId)) {
      fail(lineNumber, `duplicate toolCallId "${callId}"`);
    }
    toolCalls.set(callId, {
      eventId: event.id,
      tool: event.tool,
      input: event.input,
    });
    return {
      id: event.id,
      runId,
      timestamp: event.timestamp,
      type: event.type,
      ...(event.parentId !== undefined ? { parentId: event.parentId } : {}),
      data:
        event.input !== undefined
          ? { tool: event.tool, input: event.input }
          : { tool: event.tool },
    };
  }

  // tool.completed / tool.failed
  if (event.toolCallId !== undefined && event.parentId !== undefined) {
    const linked = toolCalls.get(event.toolCallId);
    if (linked !== undefined && linked.eventId !== event.parentId) {
      fail(
        lineNumber,
        `parentId "${event.parentId}" disagrees with toolCallId "${event.toolCallId}"`,
      );
    }
  }
  let parentId = event.parentId;
  let linkedTool = event.tool;
  let linkedInput = event.input;
  if (event.toolCallId !== undefined) {
    const linked = toolCalls.get(event.toolCallId);
    if (linked === undefined) {
      fail(
        lineNumber,
        `toolCallId "${event.toolCallId}" has no earlier tool.started`,
      );
    }
    parentId = linked.eventId;
    linkedTool = linkedTool ?? linked.tool;
    linkedInput = linkedInput ?? linked.input;
  }
  if (parentId === undefined) {
    fail(lineNumber, `${event.type} requires "toolCallId" or "parentId"`);
  }
  if (linkedTool === undefined) {
    fail(
      lineNumber,
      `${event.type} requires "tool" (or a toolCallId that resolves it)`,
    );
  }
  const success = event.type === "tool.completed";
  const data: Record<string, JsonValue> = {
    tool: linkedTool,
    success,
  };
  if (linkedInput !== undefined) data.input = linkedInput;
  if (event.output !== undefined) data.output = event.output;
  if (event.durationMs !== undefined) data.durationMs = event.durationMs;
  if (event.error !== undefined) data.error = event.error;
  return {
    id: event.id,
    runId,
    timestamp: event.timestamp,
    type: event.type,
    parentId,
    data,
  };
}

/**
 * Parse Generic JSONL into a normalized Run. Fails explicitly — with a line
 * number — on malformed input; returns the validated Run only when the whole
 * file is well-formed.
 */
export function parseGenericJsonl(text: string): Run {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();

  let runCore: z.infer<typeof genericRunSchema> | undefined;
  const events: AgentEvent[] = [];
  const toolCalls = new Map<
    string,
    { eventId: string; tool: string; input?: JsonValue }
  >();

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    if (rawLine.trim() === "") {
      fail(lineNumber, "unexpected empty line");
    }

    let raw: unknown;
    try {
      raw = JSON.parse(rawLine);
    } catch (error) {
      fail(
        lineNumber,
        `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }

    if (typeof raw === "object" && raw !== null && "formatVersion" in raw) {
      const version = (raw as { formatVersion: unknown }).formatVersion;
      if (version !== GENERIC_JSONL_FORMAT_VERSION) {
        throw new UnsupportedSchemaVersionError(
          Number(version),
          GENERIC_JSONL_FORMAT_VERSION,
          "generic JSONL format",
        );
      }
    }

    const line = genericLineSchema.safeParse(raw);
    if (!line.success) {
      throw new AgentLensValidationError(
        `Invalid generic JSONL: line ${lineNumber}: ${z.prettifyError(line.error)}`,
        line.error.issues,
      );
    }

    if (line.data.kind === "run") {
      if (runCore !== undefined) {
        fail(lineNumber, "duplicate run line");
      }
      if (events.length > 0) {
        fail(lineNumber, "run line must precede events");
      }
      const core = genericRunSchema.safeParse(line.data.run);
      if (!core.success) {
        throw new AgentLensValidationError(
          `Invalid generic JSONL: line ${lineNumber} run metadata: ${z.prettifyError(core.error)}`,
          core.error.issues,
        );
      }
      runCore = core.data;
    } else {
      if (runCore === undefined) {
        fail(lineNumber, "event appears before the run line");
      }
      const event = genericEventSchema.safeParse(line.data.event);
      if (!event.success) {
        throw new AgentLensValidationError(
          `Invalid generic JSONL: line ${lineNumber} event: ${z.prettifyError(event.error)}`,
          event.error.issues,
        );
      }
      events.push(
        normalizeEvent(event.data, runCore.id, lineNumber, toolCalls),
      );
    }
  }

  if (runCore === undefined) {
    throw new AgentLensValidationError(
      "Invalid generic JSONL: missing run metadata line",
    );
  }
  if (events.length === 0 && runCore.startedAt === undefined) {
    throw new AgentLensValidationError(
      "Invalid generic JSONL: run.startedAt is required when there are no events",
    );
  }

  const last = events.at(-1);
  const status =
    runCore.status ??
    (last?.type === "run.completed"
      ? "passed"
      : last?.type === "run.failed"
        ? "failed"
        : "running");
  const endedAt =
    runCore.endedAt ??
    (status === "running" || last === undefined ? undefined : last.timestamp);
  const startedAt = runCore.startedAt ?? events[0]?.timestamp;
  if (startedAt === undefined) {
    throw new AgentLensValidationError(
      "Invalid generic JSONL: run.startedAt is required when there are no events",
    );
  }

  const metrics = runCore.metrics ?? {
    toolCalls: events.filter((e) => e.type === "tool.started").length,
    failedToolCalls: events.filter((e) => e.type === "tool.failed").length,
  };

  try {
    return parseRun({
      id: runCore.id,
      startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(runCore.agent !== undefined ? { agent: runCore.agent } : {}),
      ...(runCore.model !== undefined ? { model: runCore.model } : {}),
      status,
      events,
      metrics,
    });
  } catch (error) {
    throw new AgentLensValidationError(
      `Invalid generic JSONL: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof AgentLensValidationError ? error.issues : undefined,
    );
  }
}
