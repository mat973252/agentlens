import type { AgentEvent } from "./event.js";
import { toolCallStartedSchema } from "./tool.js";

/** The caller supplies only a parent already present in the same run prefix. */
export function eventRelationshipIssues(
  event: AgentEvent,
  parent?: AgentEvent,
): { path: string[]; message: string }[] {
  const issues: { path: string[]; message: string }[] = [];
  const toolResult =
    event.type === "tool.completed" || event.type === "tool.failed";
  if (event.parentId !== undefined) {
    if (!parent)
      issues.push({
        path: ["parentId"],
        message: `parentId ${event.parentId} does not reference an earlier event in this run`,
      });
    if (toolResult) {
      const toolName =
        typeof event.data === "object" &&
        event.data !== null &&
        "tool" in event.data
          ? String(event.data.tool)
          : undefined;
      const parentTool = toolCallStartedSchema.safeParse(parent?.data);
      if (!parent)
        issues.push({
          path: ["parentId"],
          message: `${event.type} must reference its tool.started event`,
        });
      else if (parent.type !== "tool.started")
        issues.push({
          path: ["parentId"],
          message: `${event.type} parent must be a tool.started event, got ${parent.type}`,
        });
      else if (
        toolName !== undefined &&
        parentTool.success &&
        toolName !== parentTool.data.tool
      ) {
        issues.push({
          path: ["parentId"],
          message: `${event.type} for tool ${toolName} references tool.started for ${parentTool.data.tool}`,
        });
      }
    }
  } else if (toolResult) {
    issues.push({
      path: ["parentId"],
      message: `${event.type} requires parentId of its tool.started event`,
    });
  }
  const success =
    typeof event.data === "object" &&
    event.data !== null &&
    "success" in event.data
      ? event.data.success
      : undefined;
  if (event.type === "tool.completed" && success === false)
    issues.push({
      path: ["data", "success"],
      message: "tool.completed must have success: true",
    });
  if (event.type === "tool.failed" && success === true)
    issues.push({
      path: ["data", "success"],
      message: "tool.failed must have success: false",
    });
  return issues;
}
