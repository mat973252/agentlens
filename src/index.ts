/**
 * AgentLens SDK: provider-neutral Recorder plus schema and storage access.
 * Everything is local-first — traces are written to a local SQLite database
 * or serialized to JSONL; nothing is uploaded.
 */

export {
  GENERIC_JSONL_FORMAT,
  GENERIC_JSONL_FORMAT_VERSION,
  parseGenericJsonl,
} from "./adapters/generic.js";
export {
  IMPORT_FORMAT_NAMES,
  IMPORT_FORMATS,
  type ImportFormat,
  importRun,
  isImportFormat,
} from "./adapters/index.js";
export {
  PI_SESSION_FORMAT,
  PI_SESSION_FORMAT_VERSION,
  parsePiSession,
} from "./adapters/pi.js";
export {
  AgentLensStorageError,
  AgentLensValidationError,
  UnsupportedSchemaVersionError,
} from "./core/errors.js";
export {
  AGENT_EVENT_TYPES,
  type AgentEvent,
  type AgentEventType,
} from "./core/event.js";
export type { JsonValue } from "./core/json.js";
export {
  detectPossibleLoops,
  LOOP_RULE_THRESHOLDS,
  type LoopReport,
  type LoopRule,
  type LoopSignal,
} from "./core/loops.js";
export type { RunMetrics } from "./core/metrics.js";
export {
  AgentLensRecorderError,
  type EmitOptions,
  Recorder,
  type RecorderOptions,
  RunHandle,
  type RunHandleStatus,
  type StartRunOptions,
} from "./core/recorder.js";
export {
  EFFECT_STATUSES,
  type EffectStatus,
  HISTORY_COVERAGES,
  type HistoryCoverage,
  matchRelayEvidence,
  parseRelayHistoryExport,
  RELAY_HISTORY_SCHEMA,
  RELAY_SUBMIT_TOOL,
  type RelayCallMatch,
  type RelayEffectHistory,
  type RelayEffectSnapshot,
  type RelayEffectTransition,
  type RelayEvidenceView,
  type RelayHistoryExport,
  TRANSITION_CAUSES,
  type TransitionCause,
  validateRelayHistoryDoc,
} from "./core/relayEvidence.js";
export { RUN_STATUSES, type Run, type RunStatus } from "./core/run.js";
export type { ToolCallEvent, ToolCallStarted } from "./core/tool.js";
export {
  deserializeRunTrace,
  SCHEMA_VERSION,
  serializeRunTrace,
  type TraceDocument,
} from "./schema/trace.js";
export {
  parseRunTraceJsonl,
  serializeRunTraceJsonl,
  TRACE_JSONL_FORMAT,
  TRACE_JSONL_FORMAT_VERSION,
  type TraceJsonl,
} from "./schema/traceJsonl.js";
export {
  defaultDbPath,
  type RelayEvidenceAttachment,
  SqliteTraceStore,
  type StoredRelayEvidence,
} from "./storage/sqlite/store.js";
