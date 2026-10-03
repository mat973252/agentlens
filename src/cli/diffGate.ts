import { AgentLensValidationError } from "../core/errors.js";
import type { Run } from "../core/run.js";
import { durationOf } from "./eventDetails.js";

const METRICS = [
  "durationMs",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "toolCalls",
  "failedToolCalls",
] as const;
type Metric = (typeof METRICS)[number];
type CheckName = Metric | "errors" | "status";
type GateStatus = "pass" | "regression" | "insufficient_data";
export interface GateRule {
  check: CheckName;
  maxIncrease?: number;
}
interface GateCheck extends GateRule {
  status: GateStatus;
  a: number | string | null;
  b: number | string | null;
  delta?: number;
  reason: string;
  eventIds?: { a: string[]; b: string[] };
}
export interface DiffGate {
  status: GateStatus;
  checks: GateCheck[];
}

export function parseGateRules(inputs: string[]): GateRule[] {
  if (inputs.length === 0)
    throw new AgentLensValidationError("At least one --check is required");
  const seen = new Set<string>();
  return inputs.map((input) => {
    const [name, value, extra] = input.split("=");
    const maxIncrease = value === undefined ? undefined : Number(value);
    if (
      name === undefined ||
      extra !== undefined ||
      (name !== "status" &&
        name !== "errors" &&
        !METRICS.some((m) => m === name)) ||
      (name === "status"
        ? value !== undefined
        : value === undefined ||
          value.trim() === "" ||
          !Number.isFinite(maxIncrease) ||
          (maxIncrease ?? -1) < 0)
    ) {
      throw new AgentLensValidationError(
        `Invalid --check ${JSON.stringify(input)}; use status or metric=nonnegative-max-increase (errors, ${METRICS.join(", ")})`,
      );
    }
    if (seen.has(name))
      throw new AgentLensValidationError(`Duplicate --check ${name}`);
    seen.add(name);
    return name === "status"
      ? { check: name }
      : { check: name as Metric | "errors", maxIncrease };
  });
}

const terminal = (run: Run) =>
  run.status === "passed" || run.status === "failed";
const errorIds = (run: Run) =>
  run.events
    .filter((e) => e.type === "error" || e.type === "tool.failed")
    .map((e) => e.id);

export function evaluateDiffGate(a: Run, b: Run, rules: GateRule[]): DiffGate {
  const checks: GateCheck[] = rules.map((rule) => {
    if (rule.check === "status") {
      const status: GateStatus =
        a.status !== "passed" || !terminal(b)
          ? "insufficient_data"
          : b.status === "failed"
            ? "regression"
            : "pass";
      return {
        ...rule,
        a: a.status,
        b: b.status,
        status,
        reason:
          status === "insufficient_data"
            ? "A must be passed and B must be passed or failed"
            : `Recorded status ${a.status} -> ${b.status}`,
      };
    }
    const eventIds =
      rule.check === "errors" ? { a: errorIds(a), b: errorIds(b) } : undefined;
    const value = (run: Run) =>
      rule.check === "durationMs"
        ? durationOf(run)
        : run.metrics[rule.check as Exclude<Metric, "durationMs">];
    const av = eventIds === undefined ? value(a) : eventIds.a.length;
    const bv = eventIds === undefined ? value(b) : eventIds.b.length;
    const base = {
      ...rule,
      a: av ?? null,
      b: bv ?? null,
      ...(eventIds === undefined ? {} : { eventIds }),
    };
    if (!terminal(a) || !terminal(b)) {
      return {
        ...base,
        status: "insufficient_data",
        reason: "Both runs must be passed or failed for a complete comparison",
      };
    }
    if (
      av === undefined ||
      bv === undefined ||
      !Number.isFinite(av) ||
      !Number.isFinite(bv) ||
      av < 0 ||
      bv < 0
    ) {
      return {
        ...base,
        status: "insufficient_data",
        reason: "Both runs must record a valid value; missing is not zero",
      };
    }
    const delta = bv - av;
    return {
      ...base,
      delta,
      status: delta > (rule.maxIncrease ?? 0) ? "regression" : "pass",
      reason: `B - A = ${delta}; allowed increase <= ${rule.maxIncrease}`,
    };
  });
  return {
    status: checks.some((c) => c.status === "regression")
      ? "regression"
      : checks.some((c) => c.status === "insufficient_data")
        ? "insufficient_data"
        : "pass",
    checks,
  };
}

export function formatDiffGate(gate: DiffGate): string {
  return `\nGate: ${gate.status}\n${gate.checks
    .map(
      (check) =>
        `  ${check.check}: ${check.status} — ${check.reason}${check.eventIds === undefined ? "" : `; event IDs A [${check.eventIds.a.join(", ")}] B [${check.eventIds.b.join(", ")}]`}`,
    )
    .join("\n")}\n`;
}
