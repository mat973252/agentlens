import { z } from "zod";
import { AgentLensValidationError } from "./errors.js";
import { type AgentEvent, agentEventSchema } from "./event.js";
import { type RunMetrics, runMetricsSchema } from "./metrics.js";
import { toolCallStartedSchema } from "./tool.js";

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

    const byId = new Map<
      string,
      { index: number; type: string; tool?: string }
    >();
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
      const parsedStarted = toolCallStartedSchema.safeParse(event.data);
      byId.set(event.id, {
        index: i,
        type: event.type,
        tool: parsedStarted.success ? parsedStarted.data.tool : undefined,
      });

      if (event.parentId !== undefined) {
        const parent = byId.get(event.parentId);
        if (!parent || parent.index >= i) {
          ctx.addIssue({
            code: "custom",
            path: [...path, "parentId"],
            message: `parentId ${event.parentId} does not reference an earlier event in this run`,
          });
        }
        if (event.type === "tool.completed" || event.type === "tool.failed") {
          const toolName =
            typeof event.data === "object" &&
            event.data !== null &&
            "tool" in event.data
              ? String(event.data.tool)
              : undefined;
          if (!parent) {
            ctx.addIssue({
              code: "custom",
              path: [...path, "parentId"],
              message: `${event.type} must reference its ${"tool.started"} event`,
            });
          } else if (parent.type !== "tool.started") {
            ctx.addIssue({
              code: "custom",
              path: [...path, "parentId"],
              message: `${event.type} parent must be a tool.started event, got ${parent.type}`,
            });
          } else if (
            toolName !== undefined &&
            parent.tool !== undefined &&
            toolName !== parent.tool
          ) {
            ctx.addIssue({
              code: "custom",
              path: [...path, "parentId"],
              message: `${event.type} for tool ${toolName} references tool.started for ${parent.tool}`,
            });
          }
        }
      } else if (
        event.type === "tool.completed" ||
        event.type === "tool.failed"
      ) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "parentId"],
          message: `${event.type} requires parentId of its tool.started event`,
        });
      }

      const success =
        typeof event.data === "object" &&
        event.data !== null &&
        "success" in event.data
          ? event.data.success
          : undefined;
      if (event.type === "tool.completed" && success === false) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "data", "success"],
          message: "tool.completed must have success: true",
        });
      }
      if (event.type === "tool.failed" && success === true) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "data", "success"],
          message: "tool.failed must have success: false",
        });
      }
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
