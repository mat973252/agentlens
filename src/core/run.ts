import { z } from "zod";
import { AgentLensValidationError } from "./errors.js";
import { type AgentEvent, agentEventSchema } from "./event.js";
import { eventRelationshipIssues } from "./eventRelationships.js";
import { type RunMetrics, runMetricsSchema } from "./metrics.js";

export const RUN_STATUSES = [
  "running",
  "passed",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Terminal event types allowed per run status. */
const TERMINAL_EVENTS: Record<RunStatus, readonly string[]> = {
  running: [],
  passed: ["run.completed"],
  failed: ["run.failed"],
  cancelled: ["error", "run.failed"],
};

export const runSchema = z
  .strictObject({
    id: z.string().min(1),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }).optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    status: z.enum(RUN_STATUSES),
    events: z.array(agentEventSchema),
    metrics: runMetricsSchema,
  })
  .superRefine((run, ctx) => {
    if (run.metrics.failedToolCalls > run.metrics.toolCalls) {
      ctx.addIssue({
        code: "custom",
        path: ["metrics", "failedToolCalls"],
        message: "failedToolCalls cannot exceed toolCalls",
      });
    }

    const byId = new Map<string, AgentEvent>();
    run.events.forEach((event, i) => {
      const path = ["events", i];
      if (event.runId !== run.id) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "runId"],
          message: `event ${event.id} has runId ${event.runId}, expected ${run.id}`,
        });
      }
      if (byId.has(event.id)) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "id"],
          message: `duplicate event id ${event.id}`,
        });
      }
      const parent =
        event.parentId === undefined || event.parentId === event.id
          ? undefined
          : byId.get(event.parentId);
      for (const issue of eventRelationshipIssues(event, parent)) {
        ctx.addIssue({
          code: "custom",
          path: [...path, ...issue.path],
          message: issue.message,
        });
      }
      byId.set(event.id, event);
    });

    const last = run.events.at(-1);
    const allowed = TERMINAL_EVENTS[run.status];
    if (run.status !== "running" && last && !allowed.includes(last.type)) {
      ctx.addIssue({
        code: "custom",
        path: ["events", run.events.length - 1, "type"],
        message: `a ${run.status} run must end with ${allowed.join(" or ")}, got ${last.type}`,
      });
    }
    if (
      run.status === "running" &&
      last &&
      (last.type === "run.completed" || last.type === "run.failed")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["events", run.events.length - 1, "type"],
        message: `a running run cannot end with ${last.type}`,
      });
    }
  });

export interface Run {
  id: string;
  startedAt: string;
  endedAt?: string;
  agent?: string;
  model?: string;
  status: RunStatus;
  events: AgentEvent[];
  metrics: RunMetrics;
}

export function parseRun(input: unknown): Run {
  const result = runSchema.safeParse(input);
  if (!result.success) {
    throw new AgentLensValidationError(
      `Invalid Run: ${z.prettifyError(result.error)}`,
      result.error.issues,
    );
  }
  return result.data;
}
