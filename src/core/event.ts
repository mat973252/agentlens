import { z } from "zod";
import { AgentLensValidationError } from "./errors.js";
import { type JsonValue, jsonValueSchema } from "./json.js";
import { toolCallEventSchema, toolCallStartedSchema } from "./tool.js";

export const AGENT_EVENT_TYPES = [
  "run.started",
  "message.input",
  "message.output",
  "reasoning.summary",
  "plan.created",
  "plan.updated",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "artifact.created",
  "artifact.updated",
  "verification.started",
  "verification.completed",
  "error",
  "run.completed",
  "run.failed",
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

/**
 * Envelope constraints per event type. Anything not listed keeps its `data`
 * fully opaque (any JSON value): AgentLens never reinterprets provider payloads.
 */
const EVENT_DATA_SCHEMAS: Partial<
  Record<AgentEventType, z.ZodType<JsonValue>>
> = {
  "tool.started": toolCallStartedSchema,
  "tool.completed": toolCallEventSchema,
  "tool.failed": toolCallEventSchema,
};

export const agentEventSchema = z
  .strictObject({
    id: z.string().min(1),
    runId: z.string().min(1),
    timestamp: z.iso.datetime({ offset: true }),
    type: z.enum(AGENT_EVENT_TYPES),
    parentId: z.string().min(1).optional(),
    data: jsonValueSchema,
  })
  .superRefine((event, ctx) => {
    const dataSchema = EVENT_DATA_SCHEMAS[event.type];
    if (!dataSchema) return;
    const result = dataSchema.safeParse(event.data);
    if (!result.success) {
      ctx.addIssue({
        code: "custom",
        path: ["data"],
        message: `data for ${event.type}: ${result.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      });
    }
  });

export interface AgentEvent {
  id: string;
  runId: string;
  timestamp: string;
  type: AgentEventType;
  parentId?: string;
  data: JsonValue;
}

export function parseAgentEvent(input: unknown): AgentEvent {
  const result = agentEventSchema.safeParse(input);
  if (!result.success) {
    throw new AgentLensValidationError(
      `Invalid AgentEvent: ${z.prettifyError(result.error)}`,
      result.error.issues,
    );
  }
  return result.data;
}
