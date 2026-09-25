import { z } from "zod";

export const runMetricsSchema = z.strictObject({
  durationMs: z.number().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative(),
  failedToolCalls: z.number().int().nonnegative(),
  filesRead: z.number().int().nonnegative().optional(),
  filesWritten: z.number().int().nonnegative().optional(),
});

export interface RunMetrics {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  toolCalls: number;
  failedToolCalls: number;
  filesRead?: number;
  filesWritten?: number;
}
