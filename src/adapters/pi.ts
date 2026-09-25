import { z } from "zod";
import {
  AgentLensValidationError,
  UnsupportedSchemaVersionError,
} from "../core/errors.js";
import type { AgentEvent, AgentEventType } from "../core/event.js";
import type { JsonValue } from "../core/json.js";
import { parseRun, type Run, type RunStatus } from "../core/run.js";

/**
 * Pi session adapter: normalizes a session JSONL file written by the Pi
 * coding agent (`pi`, `@earendil-works/pi-coding-agent`) into a Run.
 *
 * Format under test (verified against pi-mono source):
 *   {"type":"session","version":3,"id":"...","timestamp":"...","cwd":"..."}
 *   {"type":"message","id":"...","parentId":"...","timestamp":"...","message":{"role":"user"|"assistant"|"toolResult",...}}
 *   {"type":"model_change"|"usage"|"compaction"|"branch_summary"|"thinking_level_change"|"custom"|"custom_message"|"context_edit"|"label"|"session_info",...}
 *
 * The first line is the `type:"session"` header; `version` is absent on v1
 * sessions (CURRENT_SESSION_VERSION is 3 in pi-mono). Sessions newer than
 * the supported version are rejected, never guessed at.
 *
 * Mapping (core only ever sees AgentEvent/Run):
 * - session header → run metadata + a synthesized `run.started` event whose
 *   data carries the verbatim header and provenance;
 * - message(user|custom injected content) → `message.input`;
 * - message(assistant) text → `message.output`, thinking →
 *   `reasoning.summary`, toolCall → `tool.started` (linked by the toolCall
 *   id); stopReason "error"/"aborted" or an errorMessage additionally emits
 *   an `error` event;
 * - message(toolResult) → `tool.completed` (isError false) or `tool.failed`
 *   (isError true), parented to the `tool.started` of the same toolCallId;
 *   input inherits the recorded call arguments, output keeps the raw
 *   content/details blocks, durationMs is derived from the message
 *   timestamps;
 * - message(bashExecution) → a `tool.started` + `tool.completed`/`tool.failed`
 *   pair for the executed shell command;
 * - compaction / branch_summary → `reasoning.summary` (a context summary
 *   injected for later reasoning);
 * - model_change sets run.model; assistant usage aggregates into run
 *   metrics (input/output/reasoning tokens — only when reported);
 * - every other entry type (usage records, thinking_level_change, label,
 *   session_info, context_edit, custom, unknown types) has no AgentLens
 *   counterpart: it is preserved verbatim under
 *   `data.source.unmappedEntries` of the synthesized terminal event, with
 *   its original line index and timestamp — nothing is silently dropped;
 * - run status: failed when the last assistant message has stopReason
 *   "error", cancelled on "aborted", otherwise passed; a synthesized
 *   run.completed/run.failed terminal event carries the unmapped entries.
 *
 * A toolResult for an unknown toolCallId, a malformed line, a missing
 * session header, or an unsupported session version fails the whole import.
 */
export const PI_SESSION_FORMAT = "pi-session";
export const PI_SESSION_FORMAT_VERSION = 3;

const sessionHeaderSchema = z.looseObject({
  type: z.literal("session"),
  version: z.number().int().optional(),
  id: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }).optional(),
});

const piLineSchema = z.looseObject({
  type: z.string().min(1),
});

interface PiEntry {
  type: string;
  id?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface UnmappedEntry {
  index: number;
  entryType: string;
  entry: JsonValue;
}

const asJson = (value: unknown): JsonValue => (value ?? null) as JsonValue;

const msToIso = (ms: number): string => new Date(ms).toISOString();

const isIsoDateTime = (value: string): boolean => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
};

const messageRawMinusContent = (
  message: PiEntry["message"] | undefined,
): Record<string, unknown> => {
  const { content: _content, ...rest } = message ?? {};
  return rest;
};

function fail(lineNumber: number, message: string): never {
  throw new AgentLensValidationError(
    `Invalid Pi session JSONL: line ${lineNumber}: ${message}`,
  );
}

/** Parse Pi session JSONL into a normalized Run. */
export function parsePiSession(text: string): Run {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) {
    throw new AgentLensValidationError(
      "Invalid Pi session JSONL: file is empty",
    );
  }

  const parseLine = (rawLine: string, lineNumber: number): PiEntry => {
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
    const line = piLineSchema.safeParse(raw);
    if (!line.success) {
      throw new AgentLensValidationError(
        `Invalid Pi session JSONL: line ${lineNumber}: ${z.prettifyError(line.error)}`,
        line.error.issues,
      );
    }
    return line.data as PiEntry;
  };

  // ---- session header --------------------------------------------------
  const headerRaw = parseLine(lines[0] ?? "", 1);
  const header = sessionHeaderSchema.safeParse(headerRaw);
  if (!header.success) {
    throw new AgentLensValidationError(
      `Invalid Pi session JSONL: line 1: expected a {"type":"session",...} header: ${z.prettifyError(header.error)}`,
      header.error.issues,
    );
  }
  const sessionVersion = header.data.version ?? 1;
  if (sessionVersion > PI_SESSION_FORMAT_VERSION) {
    throw new UnsupportedSchemaVersionError(
      sessionVersion,
      PI_SESSION_FORMAT_VERSION,
      "Pi session format",
    );
  }
  const runId = header.data.id;
  const headerTimestamp = header.data.timestamp;

  // ---- normalization state ---------------------------------------------
  const events: AgentEvent[] = [];
  const unmapped: UnmappedEntry[] = [];
  const toolCalls = new Map<
    string,
    { eventId: string; tool: string; input?: JsonValue; timestampMs?: number }
  >();
  let lastEventId: string | undefined;
  let lastTimestamp = headerTimestamp;
  let model: string | undefined =
    typeof headerRaw.modelId === "string" ? headerRaw.modelId : undefined;
  let lastStopReason: string | undefined;
  let lastErrorMessage: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let sawUsage = false;
  let sawReasoning = false;

  const entryTimestamp = (entry: PiEntry): string => {
    const ts = entry.timestamp;
    if (typeof ts === "string" && isIsoDateTime(ts)) {
      lastTimestamp = ts;
      return ts;
    }
    const ms = entry.message?.timestamp;
    if (typeof ms === "number" && Number.isFinite(ms)) {
      const iso = msToIso(ms);
      lastTimestamp = iso;
      return iso;
    }
    return lastTimestamp ?? new Date(0).toISOString();
  };

  const emit = (
    type: AgentEventType,
    data: JsonValue,
    opts: { id: string; timestamp: string; parentId?: string },
  ): AgentEvent => {
    const event: AgentEvent = {
      id: opts.id,
      runId,
      timestamp: opts.timestamp,
      type,
      ...(opts.parentId !== undefined ? { parentId: opts.parentId } : {}),
      data,
    };
    events.push(event);
    lastEventId = event.id;
    return event;
  };

  const source = (
    entry: PiEntry,
    index: number,
    raw?: Record<string, unknown>,
  ): Record<string, JsonValue> => ({
    format: PI_SESSION_FORMAT,
    formatVersion: sessionVersion,
    entryType: entry.type,
    ...(entry.id !== undefined ? { entryId: entry.id } : {}),
    entryIndex: index,
    ...(raw !== undefined ? { raw: asJson(raw) } : {}),
  });

  // First timestamp available anywhere in the file (header fallback).
  const firstEntryTimestamp = lines
    .slice(1)
    .map((rawLine) => {
      try {
        const parsed = JSON.parse(rawLine) as PiEntry;
        if (
          typeof parsed.timestamp === "string" &&
          isIsoDateTime(parsed.timestamp)
        ) {
          return parsed.timestamp;
        }
        const ms = parsed.message?.timestamp;
        if (typeof ms === "number" && Number.isFinite(ms)) return msToIso(ms);
      } catch {
        // malformed lines are reported in the main loop
      }
      return undefined;
    })
    .find((ts): ts is string => ts !== undefined);

  // run.startedAt is the earliest observed timestamp: branched sessions keep
  // entries older than the file header's own creation time.
  const startedAt = [headerTimestamp, firstEntryTimestamp]
    .filter((ts): ts is string => ts !== undefined)
    .sort()[0];

  // ---- run.started ------------------------------------------------------
  emit(
    "run.started",
    {
      source: {
        format: PI_SESSION_FORMAT,
        formatVersion: sessionVersion,
        entryType: "session",
        entryIndex: 0,
        header: asJson(headerRaw),
      },
    },
    {
      id: "pi-run-start",
      timestamp: startedAt ?? firstEntryTimestamp ?? new Date(0).toISOString(),
    },
  );

  // ---- entries ----------------------------------------------------------
  for (const [index, rawLine] of lines.slice(1).entries()) {
    const lineNumber = index + 2;
    const entry = parseLine(rawLine, lineNumber);
    const ts = entryTimestamp(entry);
    const entryId = entry.id ?? `line-${lineNumber}`;

    const mappedMeta = () => ({
      source: source(entry, index + 1, messageRawMinusContent(entry.message)),
    });

    if (entry.type === "message") {
      const message = entry.message;
      const role = message?.role;

      if (role === "user") {
        emit(
          "message.input",
          {
            content: asJson(message?.content),
            ...mappedMeta(),
          },
          { id: `pi-${entryId}`, timestamp: ts, parentId: lastEventId },
        );
        continue;
      }

      if (role === "assistant") {
        const content = Array.isArray(message?.content)
          ? (message.content as Record<string, unknown>[])
          : [];
        const usage =
          typeof message?.usage === "object" && message.usage !== null
            ? (message.usage as Record<string, unknown>)
            : undefined;
        const meta: Record<string, unknown> = {};
        for (const key of [
          "api",
          "provider",
          "model",
          "responseModel",
          "responseId",
          "providerThinkingLevel",
          "usage",
          "stopReason",
          "rawStopReason",
          "errorMessage",
          "endTurn",
          "deferred",
          "diagnostics",
          "timestamp",
        ]) {
          if (message?.[key] !== undefined) meta[key] = message[key];
        }

        const stopReason =
          typeof message?.stopReason === "string"
            ? message.stopReason
            : undefined;
        const errorMessage =
          typeof message?.errorMessage === "string"
            ? message.errorMessage
            : undefined;
        if (stopReason !== undefined) lastStopReason = stopReason;
        if (errorMessage !== undefined) lastErrorMessage = errorMessage;
        if (typeof message?.model === "string" && model === undefined) {
          model = message.model;
        }
        if (usage !== undefined) {
          sawUsage = true;
          if (typeof usage.input === "number") inputTokens += usage.input;
          if (typeof usage.output === "number") outputTokens += usage.output;
          if (typeof usage.reasoning === "number") {
            reasoningTokens += usage.reasoning;
            sawReasoning = true;
          }
        }

        let emittedFreeEvent = false;
        const freeSource = (): Record<string, JsonValue> => {
          if (!emittedFreeEvent) {
            emittedFreeEvent = true;
            return source(entry, index + 1, meta);
          }
          return source(entry, index + 1);
        };

        content.forEach((block, blockIndex) => {
          const blockType = block?.type;
          const blockId = `pi-${entryId}-c${blockIndex}`;
          if (blockType === "text") {
            emit(
              "message.output",
              { text: asJson(block.text), source: freeSource() },
              { id: blockId, timestamp: ts, parentId: lastEventId },
            );
          } else if (blockType === "thinking") {
            emit(
              "reasoning.summary",
              {
                text: asJson(block.thinking),
                ...(block.redacted === true ? { redacted: true } : {}),
                source: freeSource(),
              },
              { id: blockId, timestamp: ts, parentId: lastEventId },
            );
          } else if (blockType === "toolCall") {
            const callId = block.id;
            const name = block.name;
            if (typeof callId !== "string" || callId === "") {
              fail(lineNumber, 'assistant toolCall block is missing "id"');
            }
            if (typeof name !== "string" || name === "") {
              fail(lineNumber, `toolCall "${callId}" is missing "name"`);
            }
            const args = block.arguments;
            const eventId = `pi-tool-${callId}`;
            if (toolCalls.has(callId)) {
              fail(lineNumber, `duplicate toolCall id "${callId}"`);
            }
            toolCalls.set(callId, {
              eventId,
              tool: name,
              input: args === undefined ? undefined : asJson(args),
              timestampMs:
                typeof message?.timestamp === "number"
                  ? message.timestamp
                  : undefined,
            });
            emit(
              "tool.started",
              args === undefined
                ? { tool: name }
                : { tool: name, input: asJson(args) },
              { id: eventId, timestamp: ts, parentId: lastEventId },
            );
          } else {
            unmapped.push({
              index: index + 1,
              entryType: `${entry.type}.content`,
              entry: asJson({ blockIndex, block }),
            });
          }
        });

        if (!emittedFreeEvent) {
          unmapped.push({
            index: index + 1,
            entryType: `${entry.type}.meta`,
            entry: asJson(meta),
          });
        }
        if (
          errorMessage !== undefined ||
          stopReason === "error" ||
          stopReason === "aborted"
        ) {
          emit(
            "error",
            {
              error: errorMessage ?? `assistant turn ${stopReason}`,
              ...(stopReason !== undefined ? { stopReason } : {}),
              source: source(entry, index + 1),
            },
            {
              id: `pi-${entryId}-error`,
              timestamp: ts,
              parentId: lastEventId,
            },
          );
        }
        continue;
      }

      if (role === "toolResult") {
        const toolCallId =
          typeof message?.toolCallId === "string" ? message.toolCallId : "";
        const linked = toolCalls.get(toolCallId);
        if (linked === undefined) {
          fail(
            lineNumber,
            `toolResult references unknown toolCallId "${toolCallId}"`,
          );
        }
        const isError = message?.isError === true;
        const toolName =
          typeof message?.toolName === "string" && message.toolName !== ""
            ? message.toolName
            : linked.tool;
        const output: Record<string, JsonValue> = {
          content: asJson(message?.content),
        };
        if (message?.details !== undefined) {
          output.details = asJson(message.details);
        }
        if (message?.usage !== undefined) {
          output.usage = asJson(message.usage);
        }
        const data: Record<string, JsonValue> = {
          tool: toolName,
          success: !isError,
          output,
        };
        if (linked.input !== undefined) data.input = linked.input;
        if (isError) {
          const content = message?.content;
          data.error = Array.isArray(content)
            ? (content as Record<string, unknown>[])
                .filter((b) => b?.type === "text")
                .map((b) => String(b.text))
                .join("\n") || `tool ${toolName} failed`
            : `tool ${toolName} failed`;
        }
        if (
          linked.timestampMs !== undefined &&
          typeof message?.timestamp === "number"
        ) {
          const durationMs = message.timestamp - linked.timestampMs;
          if (Number.isFinite(durationMs) && durationMs >= 0) {
            data.durationMs = durationMs;
          }
        }
        emit(isError ? "tool.failed" : "tool.completed", data, {
          id: `pi-${entryId}`,
          timestamp: ts,
          parentId: linked.eventId,
        });
        continue;
      }

      if (role === "bashExecution") {
        const command = asJson(message?.command);
        const callId = `pi-${entryId}-bash`;
        emit(
          "tool.started",
          { tool: "bash", input: { command } },
          { id: callId, timestamp: ts, parentId: lastEventId },
        );
        const exitCode =
          typeof message?.exitCode === "number" ? message.exitCode : undefined;
        const cancelled = message?.cancelled === true;
        const success = cancelled !== true && exitCode === 0;
        emit(
          success ? "tool.completed" : "tool.failed",
          {
            tool: "bash",
            input: { command },
            output: {
              output: asJson(message?.output),
              ...(exitCode !== undefined ? { exitCode } : {}),
              cancelled,
              truncated: message?.truncated === true,
            },
            success,
            ...(success
              ? {}
              : {
                  error: cancelled
                    ? "command cancelled"
                    : `command exited with code ${exitCode ?? "unknown"}`,
                }),
          },
          { id: `${callId}-result`, timestamp: ts, parentId: callId },
        );
        continue;
      }

      if (role === "custom") {
        emit(
          "message.input",
          {
            content: asJson(message?.content),
            ...mappedMeta(),
          },
          { id: `pi-${entryId}`, timestamp: ts, parentId: lastEventId },
        );
        continue;
      }

      if (role === "branchSummary" || role === "compactionSummary") {
        emit(
          "reasoning.summary",
          {
            text: asJson(message?.summary),
            source: source(
              entry,
              index + 1,
              messageRawMinusContent(entry.message),
            ),
          },
          { id: `pi-${entryId}`, timestamp: ts, parentId: lastEventId },
        );
        continue;
      }

      // Unknown or non-conversational message role.
      unmapped.push({
        index: index + 1,
        entryType: entry.type,
        entry: asJson(entry),
      });
      continue;
    }

    if (entry.type === "compaction" || entry.type === "branch_summary") {
      emit(
        "reasoning.summary",
        {
          text: asJson(entry.summary),
          source: source(entry, index + 1, entry),
        },
        { id: `pi-${entryId}`, timestamp: ts, parentId: lastEventId },
      );
      continue;
    }

    if (entry.type === "custom_message") {
      emit(
        "message.input",
        {
          content: asJson(entry.content),
          source: source(entry, index + 1, entry),
        },
        { id: `pi-${entryId}`, timestamp: ts, parentId: lastEventId },
      );
      continue;
    }

    if (entry.type === "model_change") {
      if (typeof entry.modelId === "string") model = entry.modelId;
      unmapped.push({
        index: index + 1,
        entryType: entry.type,
        entry: asJson(entry),
      });
      continue;
    }

    // usage, thinking_level_change, label, session_info, context_edit,
    // custom, and any unknown entry type: no AgentLens counterpart.
    unmapped.push({
      index: index + 1,
      entryType: entry.type,
      entry: asJson(entry),
    });
  }

  // ---- run status + terminal event --------------------------------------
  const status: RunStatus =
    lastStopReason === "error"
      ? "failed"
      : lastStopReason === "aborted"
        ? "cancelled"
        : "passed";

  const endedAt = lastTimestamp;
  const terminalData: Record<string, JsonValue> = {
    source: {
      format: PI_SESSION_FORMAT,
      formatVersion: sessionVersion,
      synthesized: true,
      ...(lastStopReason !== undefined ? { lastStopReason } : {}),
      ...(unmapped.length > 0 ? { unmappedEntries: asJson(unmapped) } : {}),
    },
  };
  if (status === "passed") {
    emit("run.completed", terminalData, {
      id: "pi-run-end",
      timestamp:
        endedAt ??
        startedAt ??
        firstEntryTimestamp ??
        events[0]?.timestamp ??
        new Date(0).toISOString(),
      parentId: lastEventId,
    });
  } else {
    emit(
      "run.failed",
      {
        error:
          lastErrorMessage ??
          (status === "cancelled"
            ? "session aborted"
            : "session ended with an error"),
        ...terminalData,
      },
      {
        id: "pi-run-end",
        timestamp:
          endedAt ??
          startedAt ??
          firstEntryTimestamp ??
          events[0]?.timestamp ??
          new Date(0).toISOString(),
        parentId: lastEventId,
      },
    );
  }

  const metrics: Record<string, number> = {
    toolCalls: events.filter((e) => e.type === "tool.started").length,
    failedToolCalls: events.filter((e) => e.type === "tool.failed").length,
  };
  if (sawUsage) {
    metrics.inputTokens = inputTokens;
    metrics.outputTokens = outputTokens;
  }
  if (sawReasoning) metrics.reasoningTokens = reasoningTokens;
  if (startedAt !== undefined && endedAt !== undefined) {
    const durationMs = Date.parse(endedAt) - Date.parse(startedAt);
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      metrics.durationMs = durationMs;
    }
  }

  if (startedAt === undefined && firstEntryTimestamp === undefined) {
    throw new AgentLensValidationError(
      "Invalid Pi session JSONL: no timestamp on the session header or any entry",
    );
  }

  try {
    return parseRun({
      id: runId,
      startedAt: startedAt ?? (firstEntryTimestamp as string),
      ...(endedAt !== undefined ? { endedAt } : {}),
      agent: "pi",
      ...(model !== undefined ? { model } : {}),
      status,
      events,
      metrics,
    });
  } catch (error) {
    throw new AgentLensValidationError(
      `Invalid Pi session JSONL: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof AgentLensValidationError ? error.issues : undefined,
    );
  }
}
