import { z } from "zod";
import {
  AgentLensValidationError,
  UnsupportedSchemaVersionError,
} from "../core/errors.js";
import { runMetricsSchema } from "../core/metrics.js";
import { parseRun, RUN_STATUSES, type Run } from "../core/run.js";

/**
 * AgentLens trace JSONL format: one run metadata line followed by one line
 * per event, in event order.
 *
 *   {"format":"agentlens-trace","formatVersion":1,"kind":"run","run":{"id":...,"startedAt":...,"status":...,"metrics":{...}}}
 *   {"format":"agentlens-trace","formatVersion":1,"kind":"event","event":{"id":...,"runId":...,"type":...,"data":...}}
 *
 * Rules:
 * - exactly one `kind:"run"` line, and it must be the first non-empty line;
 * - `run` carries run metadata only — `events` is not a valid run field;
 * - every subsequent line is `kind:"event"` with a full AgentEvent in
 *   `event` (ids, runId, parentId, timestamps and `data` preserved verbatim);
 * - unknown fields anywhere are rejected, never dropped or rewritten.
 */
export const TRACE_JSONL_FORMAT = "agentlens-trace";
export const TRACE_JSONL_FORMAT_VERSION = 1;

/** Run metadata as it appears inside a `kind:"run"` line (no events field). */
const jsonlRunCoreSchema = z.strictObject({
  id: z.string().min(1),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }).optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  status: z.enum(RUN_STATUSES),
  metrics: runMetricsSchema,
});

const jsonlLineSchema = z
  .strictObject({
    format: z.literal(TRACE_JSONL_FORMAT),
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

function parseLine(rawLine: string, lineNumber: number) {
  let raw: unknown;
  try {
    raw = JSON.parse(rawLine);
  } catch (error) {
    throw new AgentLensValidationError(
      `Invalid trace JSONL: line ${lineNumber} is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }

  if (typeof raw === "object" && raw !== null && "formatVersion" in raw) {
    const version = (raw as { formatVersion: unknown }).formatVersion;
    if (version !== TRACE_JSONL_FORMAT_VERSION) {
      throw new UnsupportedSchemaVersionError(
        Number(version),
        TRACE_JSONL_FORMAT_VERSION,
      );
    }
  }

  const parsed = jsonlLineSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentLensValidationError(
      `Invalid trace JSONL: line ${lineNumber}: ${z.prettifyError(parsed.error)}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export interface TraceJsonl {
  formatVersion: typeof TRACE_JSONL_FORMAT_VERSION;
  run: Run;
}

/**
 * Serialize a Run to the AgentLens trace JSONL format: run metadata line
 * first, then one line per event in order.
 */
export function serializeRunTraceJsonl(run: Run): string {
  const { events, ...core } = run;
  const lines = [
    {
      format: TRACE_JSONL_FORMAT,
      formatVersion: TRACE_JSONL_FORMAT_VERSION,
      kind: "run" as const,
      run: core,
    },
    ...events.map((event) => ({
      format: TRACE_JSONL_FORMAT,
      formatVersion: TRACE_JSONL_FORMAT_VERSION,
      kind: "event" as const,
      event,
    })),
  ];
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/**
 * Parse AgentLens trace JSONL. Fails explicitly — with a line number — on
 * malformed JSON, a missing/duplicated run line, events before the run line,
 * an unsupported formatVersion, unknown fields, or schema violations.
 * Returns the validated Run only when the whole file is well-formed.
 */
export function parseRunTraceJsonl(text: string): TraceJsonl {
  const lines = text.split("\n");
  // A single trailing newline is allowed; anything else empty is an error.
  if (lines.at(-1) === "") lines.pop();

  let runCore: z.infer<typeof jsonlRunCoreSchema> | undefined;
  const events: unknown[] = [];

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    if (rawLine.trim() === "") {
      throw new AgentLensValidationError(
        `Invalid trace JSONL: unexpected empty line ${lineNumber}`,
      );
    }

    const line = parseLine(rawLine, lineNumber);

    if (line.kind === "run") {
      if (runCore !== undefined) {
        throw new AgentLensValidationError(
          `Invalid trace JSONL: duplicate run line at line ${lineNumber}`,
        );
      }
      if (events.length > 0) {
        throw new AgentLensValidationError(
          `Invalid trace JSONL: run line must precede events (line ${lineNumber})`,
        );
      }
      const core = jsonlRunCoreSchema.safeParse(line.run);
      if (!core.success) {
        throw new AgentLensValidationError(
          `Invalid trace JSONL: line ${lineNumber} run metadata: ${z.prettifyError(core.error)}`,
          core.error.issues,
        );
      }
      runCore = core.data;
    } else {
      if (runCore === undefined) {
        throw new AgentLensValidationError(
          `Invalid trace JSONL: event at line ${lineNumber} appears before the run line`,
        );
      }
      events.push(line.event);
    }
  }

  if (runCore === undefined) {
    throw new AgentLensValidationError(
      "Invalid trace JSONL: missing run metadata line",
    );
  }

  try {
    const run = parseRun({ ...runCore, events });
    return { formatVersion: TRACE_JSONL_FORMAT_VERSION, run };
  } catch (error) {
    throw new AgentLensValidationError(
      `Invalid trace JSONL: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof AgentLensValidationError ? error.issues : undefined,
    );
  }
}
