import { randomUUID } from "node:crypto";
import { AgentLensValidationError } from "./errors.js";
import {
  type AgentEvent,
  type AgentEventType,
  parseAgentEvent,
} from "./event.js";
import type { JsonValue } from "./json.js";
import type { RunMetrics } from "./metrics.js";
import { parseRun, type Run, type RunStatus } from "./run.js";

/**
 * Event types the Recorder owns. They are produced by startRun/completeRun/
 * failRun; emitting them directly would corrupt the run lifecycle.
 */
const RESERVED_EVENT_TYPES: readonly AgentEventType[] = [
  "run.started",
  "run.completed",
  "run.failed",
];

export type RunHandleStatus = "active" | "completed" | "failed";

export interface StartRunOptions {
  /** Explicit run id. Defaults to a random UUID. */
  id?: string;
  agent?: string;
  model?: string;
  /** Defaults to the recorder clock. */
  startedAt?: string;
  /** Payload for the synthetic `run.started` event. Defaults to null. */
  data?: JsonValue;
}

export interface EmitOptions {
  /** Explicit event id. Defaults to a random UUID. */
  id?: string;
  /** Must reference an earlier event in the same run. */
  parentId?: string;
  /** Defaults to the recorder clock. */
  timestamp?: string;
}

export interface RecorderOptions {
  /** Store writes must be atomic: throwing must leave the prior state intact. */
  store: {
    saveRun(input: unknown): unknown;
    appendRunEvent?(
      input: unknown,
      expectedEventCount: number,
      completion?: RunCompletion,
    ): void;
  };
  /** Opt in to committing start/emit/finish before each call returns. */
  persistence?: "on-finish" | "incremental";
  /** Clock override for tests/demos. Defaults to `new Date().toISOString()`. */
  now?: () => string;
  /** Id generator override. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
}

export interface RunCompletion {
  endedAt: string;
  metrics: RunMetrics;
}

/** Thrown for invalid Recorder lifecycle calls (emit after terminal, double complete, ...). */
export class AgentLensRecorderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLensRecorderError";
  }
}

/**
 * A single run being recorded. By default events stay in memory until finish.
 * Incremental mode commits every accepted event before changing the handle.
 */
export class RunHandle {
  private readonly recorder: Recorder;
  private readonly run: {
    id: string;
    startedAt: string;
    agent?: string;
    model?: string;
  };
  private readonly eventList: AgentEvent[] = [];
  private readonly eventsById = new Map<string, AgentEvent>();
  private state: RunHandleStatus = "active";
  private endedAt: string | undefined;
  private completedMetrics: RunMetrics | undefined;

  constructor(recorder: Recorder, options: StartRunOptions) {
    this.recorder = recorder;
    this.run = {
      id: options.id ?? recorder.newId(),
      startedAt: options.startedAt ?? recorder.now(),
    };
    if (options.agent !== undefined) this.run.agent = options.agent;
    if (options.model !== undefined) this.run.model = options.model;
    const started = this.buildEvent("run.started", options.data ?? null, {
      timestamp: this.run.startedAt,
    });
    this.eventList.push(started);
    this.eventsById.set(started.id, started);
  }

  get id(): string {
    return this.run.id;
  }

  get status(): RunHandleStatus {
    return this.state;
  }

  get events(): readonly AgentEvent[] {
    return this.recorder.persistence === "incremental"
      ? structuredClone(this.eventList)
      : this.eventList;
  }

  /**
   * Append an event to the run. `data` is validated against the event schema;
   * unknown fields and malformed tool payloads fail explicitly. `run.started`,
   * `run.completed` and `run.failed` are reserved for the lifecycle methods.
   */
  emit(
    type: AgentEventType,
    data: JsonValue = null,
    options: EmitOptions = {},
  ): AgentEvent {
    this.assertActive(`emit(${type})`);
    if (RESERVED_EVENT_TYPES.includes(type)) {
      throw new AgentLensRecorderError(
        `emit(${type}) is reserved for the run lifecycle; use startRun/completeRun/failRun`,
      );
    }
    const event = this.buildEvent(type, data, options);
    if (event.parentId !== undefined && !this.eventsById.has(event.parentId)) {
      throw new AgentLensValidationError(
        `event ${event.id}: parentId ${event.parentId} does not reference an earlier event in run ${this.run.id}`,
      );
    }
    this.recorder.persistEvent(event, this.eventList.length);
    this.eventList.push(event);
    this.eventsById.set(event.id, event);
    return this.recorder.persistence === "incremental"
      ? structuredClone(event)
      : event;
  }

  /**
   * Close the run as `passed`: appends `run.completed`, then persists the
   * whole run atomically. Returns the stored Run.
   */
  completeRun(metrics: Partial<RunMetrics> = {}): Run {
    this.assertActive("completeRun");
    return this.finish("run.completed", null, "passed", metrics);
  }

  /**
   * Close the run as `failed`: appends `run.failed`, then persists the whole
   * run atomically. `error` (string or Error) becomes `{ message }` payload.
   */
  failRun(error?: string | Error): Run {
    this.assertActive("failRun");
    const data =
      error === undefined
        ? null
        : { message: error instanceof Error ? error.message : error };
    return this.finish("run.failed", data, "failed", {});
  }

  /** Current run as an in-memory snapshot (running until a finish method runs). */
  toRun(): Run {
    return this.buildRun(
      this.state === "completed"
        ? "passed"
        : this.state === "failed"
          ? "failed"
          : "running",
      this.endedAt,
      this.completedMetrics ?? {},
    );
  }

  private buildEvent(
    type: AgentEventType,
    data: JsonValue,
    options: EmitOptions,
  ): AgentEvent {
    const candidate: Record<string, unknown> = {
      id: options.id ?? this.recorder.newId(),
      runId: this.run.id,
      timestamp: options.timestamp ?? this.recorder.now(),
      type,
      data,
    };
    if (options.parentId !== undefined) candidate.parentId = options.parentId;
    return parseAgentEvent(candidate);
  }

  private finish(
    type: "run.completed" | "run.failed",
    data: JsonValue,
    status: RunStatus,
    metrics: Partial<RunMetrics>,
  ): Run {
    const endedAt = this.recorder.now();
    const event = this.buildEvent(type, data, { timestamp: endedAt });
    const run = this.buildRun(status, endedAt, metrics, [
      ...this.eventList,
      event,
    ]);
    if (this.recorder.persistence === "incremental") {
      this.recorder.persistEvent(event, this.eventList.length, {
        endedAt,
        metrics: run.metrics,
      });
    } else {
      this.recorder.persistRun(run);
    }
    this.eventList.push(event);
    this.endedAt = endedAt;
    this.completedMetrics = { ...run.metrics };
    this.state = status === "passed" ? "completed" : "failed";
    return run;
  }

  private buildRun(
    status: RunStatus,
    endedAt: string | undefined,
    overrides: Partial<RunMetrics>,
    events: readonly AgentEvent[] = this.eventList,
  ): Run {
    const toolCalls = events.filter(
      (e) => e.type === "tool.completed" || e.type === "tool.failed",
    ).length;
    const failedToolCalls = events.filter(
      (e) => e.type === "tool.failed",
    ).length;
    const metrics: RunMetrics = { toolCalls, failedToolCalls };
    if (endedAt !== undefined) {
      metrics.durationMs = Math.max(
        0,
        Date.parse(endedAt) - Date.parse(this.run.startedAt),
      );
    }
    Object.assign(metrics, overrides);
    const run: Record<string, unknown> = {
      id: this.run.id,
      startedAt: this.run.startedAt,
      status,
      events,
      metrics,
    };
    if (endedAt !== undefined) run.endedAt = endedAt;
    if (this.run.agent !== undefined) run.agent = this.run.agent;
    if (this.run.model !== undefined) run.model = this.run.model;
    return parseRun(run);
  }

  private assertActive(method: string): void {
    if (this.state !== "active") {
      throw new AgentLensRecorderError(
        `${method} called on run ${this.run.id} which is already ${this.state}`,
      );
    }
  }
}

/**
 * Provider-neutral run recorder. Any agent harness calls startRun(), emits
 * normalized AgentLens events while it works, then completes or fails the run.
 * The Recorder never touches provider-specific concepts; `data` payloads are
 * kept verbatim.
 */
export class Recorder {
  readonly store: RecorderOptions["store"];
  readonly persistence: "on-finish" | "incremental";
  readonly now: () => string;
  readonly newId: () => string;

  constructor(options: RecorderOptions) {
    this.store = options.store;
    this.persistence = options.persistence ?? "on-finish";
    if (this.persistence === "incremental" && !this.store.appendRunEvent) {
      throw new AgentLensRecorderError(
        "Incremental recording requires store.appendRunEvent",
      );
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => randomUUID());
  }

  /** Start a new run; emits the synthetic `run.started` event. */
  startRun(options: StartRunOptions = {}): RunHandle {
    const handle = new RunHandle(this, options);
    if (this.persistence === "incremental") this.persistRun(handle.toRun());
    return handle;
  }

  /** @internal Persist a finished run; called by RunHandle. */
  persistRun(run: Run): void {
    this.store.saveRun(run);
  }

  /** @internal Commit one event before RunHandle updates its in-memory prefix. */
  persistEvent(
    event: AgentEvent,
    expectedEventCount: number,
    completion?: RunCompletion,
  ): void {
    if (this.persistence === "incremental") {
      this.store.appendRunEvent?.(event, expectedEventCount, completion);
    }
  }
}
