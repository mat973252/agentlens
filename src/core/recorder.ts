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
  /** Where terminal runs are persisted (e.g. SqliteTraceStore). */
  store: { saveRun(input: unknown): unknown };
  /** Clock override for tests/demos. Defaults to `new Date().toISOString()`. */
  now?: () => string;
  /** Id generator override. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
}

/** Thrown for invalid Recorder lifecycle calls (emit after terminal, double complete, ...). */
export class AgentLensRecorderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLensRecorderError";
  }
}

/**
 * A single run being recorded. Events stay in memory until completeRun() or
 * failRun() persists the whole run (run row + ordered events) atomically via
 * the store — a still-running run is never half-written to the database.
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
  private state: RunHandleStatus = "active";
  private endedAt: string | undefined;

  constructor(recorder: Recorder, options: StartRunOptions) {
    this.recorder = recorder;
    this.run = {
      id: options.id ?? recorder.newId(),
      startedAt: options.startedAt ?? recorder.now(),
    };
    if (options.agent !== undefined) this.run.agent = options.agent;
    if (options.model !== undefined) this.run.model = options.model;
    this.eventList.push(
      this.buildEvent("run.started", options.data ?? null, {
        timestamp: this.run.startedAt,
      }),
    );
  }

  get id(): string {
    return this.run.id;
  }

  get status(): RunHandleStatus {
    return this.state;
  }

  get events(): readonly AgentEvent[] {
    return this.eventList;
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
    if (
      event.parentId !== undefined &&
      !this.eventList.some((e) => e.id === event.parentId)
    ) {
      throw new AgentLensValidationError(
        `event ${event.id}: parentId ${event.parentId} does not reference an earlier event in run ${this.run.id}`,
      );
    }
    this.eventList.push(event);
    return event;
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
      {},
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
    this.eventList.push(this.buildEvent(type, data, { timestamp: endedAt }));
    const run = this.buildRun(status, endedAt, metrics);
    this.recorder.persistRun(run);
    this.endedAt = endedAt;
    this.state = status === "passed" ? "completed" : "failed";
    return run;
  }

  private buildRun(
    status: RunStatus,
    endedAt: string | undefined,
    overrides: Partial<RunMetrics>,
  ): Run {
    const toolCalls = this.eventList.filter(
      (e) => e.type === "tool.completed" || e.type === "tool.failed",
    ).length;
    const failedToolCalls = this.eventList.filter(
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
      events: this.eventList,
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
  readonly now: () => string;
  readonly newId: () => string;

  constructor(options: RecorderOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => randomUUID());
  }

  /** Start a new run; emits the synthetic `run.started` event. */
  startRun(options: StartRunOptions = {}): RunHandle {
    const handle = new RunHandle(this, options);
    return handle;
  }

  /** @internal Persist a finished run; called by RunHandle. */
  persistRun(run: Run): void {
    this.store.saveRun(run);
  }
}
