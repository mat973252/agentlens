import { z } from "zod";
import { type JsonValue, jsonValueSchema } from "./json.js";

/**
 * Data payload for `tool.completed` and `tool.failed` events.
 * `success` is required here: for a finished tool call the outcome must be
 * explicit (`tool.started` carries `toolCallStartedSchema` instead).
 */
export const toolCallEventSchema = z.strictObject({
  tool: z.string().min(1),
  input: jsonValueSchema.optional(),
  output: jsonValueSchema.optional(),
  durationMs: z.number().nonnegative().optional(),
  success: z.boolean(),
  error: z.string().optional(),
});

/** Data payload for `tool.started` events: no outcome yet. */
export const toolCallStartedSchema = z.strictObject({
  tool: z.string().min(1),
  input: jsonValueSchema.optional(),
});

export interface ToolCallEvent {
  tool: string;
  input?: JsonValue;
  output?: JsonValue;
  durationMs?: number;
  success: boolean;
  error?: string;
}

export interface ToolCallStarted {
  tool: string;
  input?: JsonValue;
}
