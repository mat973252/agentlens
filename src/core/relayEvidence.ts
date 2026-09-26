import { z } from "zod";
import { AgentLensValidationError } from "./errors.js";
import type { Run } from "./run.js";

/**
 * Relay effect-history evidence: the offline, read-only sidecar produced by
 * `relay effects --history --json` (schema `relay.effect-history/1`), paired
 * with a Pi session import via `agentlens import --format pi --relay-history`.
 *
 * Evidence is observed source data, never a normalized AgentEvent: it is
 * stored verbatim (allowlisted fields only), displayed under its own
 * heading, and never used to fabricate Run/Step/Recovery events or to
 * change run/tool status. `UNKNOWN` stays `UNKNOWN`.
 *
 * The only accepted association is an exact key match: a persisted
 * `relay_submit_action` tool call's `actionId` and `operationId` arguments
 * form the journal key `${actionId}:${operationId}`, with the MCP kind
 * `mcp:${actionId}` where available. A key match proves identity of the
 * journal key only — not exclusive ownership, session binding or causality;
 * keys may be reused across calls/sessions and the journal carries no Pi
 * identity. Matching is purely argument-string equality — no time, path or
 * prose heuristics.
 *
 * Allowlisted evidence fields: effect id/key/kind/status and snapshot
 * timestamps; transition seq/from/to/cause/time; coverage; provenance
 * hashes. Provider free-form fields (`reason`, `remoteRef`, `resultJson`,
 * `intentJson`, `requestHash`) and any other sidecar extras are validated
 * away and never persisted or rendered.
 */
export const RELAY_HISTORY_SCHEMA = "relay.effect-history/1";
export const RELAY_HISTORY_SCHEMA_VERSION = 1;
export const RELAY_SUBMIT_TOOL = "relay_submit_action";
export const RELAY_MCP_KIND_PREFIX = "mcp:";

export const EFFECT_STATUSES = [
  "PREPARED",
  "SUBMITTED",
  "UNKNOWN",
  "CONFIRMED",
  "FAILED",
] as const;
export type EffectStatus = (typeof EFFECT_STATUSES)[number];

export const TRANSITION_CAUSES = [
  "prepare",
  "submit",
  "execute",
  "reconcile",
  "unknown",
] as const;
export type TransitionCause = (typeof TRANSITION_CAUSES)[number];

export const HISTORY_COVERAGES = [
  "observed",
  "partial",
  "unavailable",
] as const;
export type HistoryCoverage = (typeof HISTORY_COVERAGES)[number];

export interface RelayEffectTransition {
  seq: number;
  effectId: string;
  key: string;
  kind: string;
  fromStatus?: EffectStatus;
  toStatus: EffectStatus;
  cause: TransitionCause;
  /** Journal wall-clock epoch milliseconds (the source's own clock). */
  at: number;
}

/** Latest-state snapshot of one effect row (allowlisted fields only). */
export interface RelayEffectSnapshot {
  id: string;
  key: string;
  kind: string;
  status: EffectStatus;
  createdAt: number;
  submittedAt?: number;
  settledAt?: number;
  updatedAt: number;
}

export interface RelayEffectHistory {
  record: RelayEffectSnapshot;
  /** Committed transitions in journal seq order. */
  events: RelayEffectTransition[];
  coverage: HistoryCoverage;
}

export interface RelayHistoryExport {
  schema: typeof RELAY_HISTORY_SCHEMA;
  histories: RelayEffectHistory[];
}

const transitionSchema = z.strictObject({
  seq: z.number().int().min(1),
  effectId: z.string().min(1),
  key: z.string().min(1),
  kind: z.string(),
  fromStatus: z.enum(EFFECT_STATUSES).optional(),
  toStatus: z.enum(EFFECT_STATUSES),
  cause: z.enum(TRANSITION_CAUSES),
  at: z.number().finite(),
});

/**
 * Latest-state record. Loose on purpose: real exports always carry
 * provider-controlled free-form fields (`reason`, `remoteRef`, `resultJson`,
 * `intentJson`, `requestHash`, `replay`) which are discarded here and never
 * persisted.
 */
const snapshotSchema = z
  .looseObject({
    id: z.string().min(1),
    key: z.string().min(1),
    kind: z.string().min(1),
    status: z.enum(EFFECT_STATUSES),
    createdAt: z.number().finite(),
    submittedAt: z.number().finite().optional(),
    settledAt: z.number().finite().optional(),
    updatedAt: z.number().finite(),
  })
  // Anything outside the allowlist is dropped here, so no free-form or
  // unexpected sidecar field can reach storage or rendering.
  .transform(
    (record): RelayEffectSnapshot => ({
      id: record.id,
      key: record.key,
      kind: record.kind,
      status: record.status,
      createdAt: record.createdAt,
      ...(record.submittedAt !== undefined
        ? { submittedAt: record.submittedAt }
        : {}),
      ...(record.settledAt !== undefined
        ? { settledAt: record.settledAt }
        : {}),
      updatedAt: record.updatedAt,
    }),
  );

const historySchema = z.strictObject({
  record: snapshotSchema,
  events: z.array(transitionSchema),
  coverage: z.enum(HISTORY_COVERAGES),
});

const exportSchema = z.strictObject({
  schema: z.literal(RELAY_HISTORY_SCHEMA),
  histories: z.array(historySchema),
});

const fail = (message: string): never => {
  throw new AgentLensValidationError(
    `Invalid Relay effect-history export: ${message}`,
  );
};

/**
 * Cross-checks a parsed export, mirroring Relay's own
 * `validateEffectEvidence` semantics: unique seq, event→record identity,
 * per-record chain, PREPARED/prepare first event, last observed transition
 * equals the latest-state snapshot, and declared coverage matching what the
 * event list actually contains (unavailable = none, observed = chain from
 * the insert, partial = chain starting mid-life).
 */
function crossCheck(exportDoc: RelayHistoryExport): void {
  const ids = new Set<string>();
  const keys = new Set<string>();
  const seqs = new Set<number>();
  for (const history of exportDoc.histories) {
    const { record, events, coverage } = history;
    if (ids.has(record.id)) fail(`duplicate effect id ${record.id}`);
    ids.add(record.id);
    if (keys.has(record.key)) fail(`duplicate effect key ${record.key}`);
    keys.add(record.key);

    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < sorted.length; i++) {
      const event = sorted[i] as RelayEffectTransition;
      if (seqs.has(event.seq)) fail(`duplicate transition seq ${event.seq}`);
      seqs.add(event.seq);
      if (event.effectId !== record.id) {
        fail(
          `transition seq ${event.seq} belongs to effect ${event.effectId}, not ${record.id}`,
        );
      }
      if (event.key !== record.key || event.kind !== record.kind) {
        fail(
          `transition seq ${event.seq} contradicts record identity for ${record.id}`,
        );
      }
      if (i === 0) {
        if (
          event.fromStatus === undefined &&
          (event.toStatus !== "PREPARED" || event.cause !== "prepare")
        ) {
          fail(`first transition of ${record.id} is not a prepare`);
        }
      } else if (event.fromStatus !== sorted[i - 1]?.toStatus) {
        fail(`broken transition chain for ${record.id} at seq ${event.seq}`);
      }
    }
    const last = sorted.at(-1);
    if (last !== undefined && last.toStatus !== record.status) {
      fail(
        `last observed transition for ${record.id} is ${last.toStatus}, but the latest-state snapshot is ${record.status}`,
      );
    }
    const derived: HistoryCoverage =
      sorted.length === 0
        ? "unavailable"
        : sorted[0]?.fromStatus === undefined
          ? "observed"
          : "partial";
    if (derived !== coverage) {
      fail(
        `declared coverage "${coverage}" contradicts the observed transitions for ${record.id} (expected "${derived}")`,
      );
    }
    history.events = sorted;
  }
}

/**
 * Validates an already-parsed effect-history document. Used both by
 * `parseRelayHistoryExport` (file input) and by the store when reading rows
 * back, so corrupt hand-edited tables fail the same way input does.
 */
export function validateRelayHistoryDoc(raw: unknown): RelayHistoryExport {
  const parsed = exportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentLensValidationError(
      `Invalid Relay effect-history export: ${z.prettifyError(parsed.error)}`,
      parsed.error.issues,
    );
  }
  const exportDoc = parsed.data as RelayHistoryExport;
  crossCheck(exportDoc);
  return exportDoc;
}

/**
 * Parses and validates a `relay effects --history --json` export.
 * Fails explicitly on malformed JSON, a wrong schema marker, invalid
 * statuses/causes, broken transition chains, contradictory coverage or
 * snapshot conflicts — before anything is written. Free-form record fields
 * are discarded, not stored.
 */
export function parseRelayHistoryExport(text: string): RelayHistoryExport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    fail(
      `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (typeof raw === "object" && raw !== null) {
    const schema = (raw as { schema?: unknown }).schema;
    if (typeof schema === "string" && schema !== RELAY_HISTORY_SCHEMA) {
      const match = /^relay\.effect-history\/(\d+)$/.exec(schema);
      fail(
        match !== null
          ? `unsupported schema version "${schema}"; this AgentLens reads "${RELAY_HISTORY_SCHEMA}"`
          : `unexpected schema marker "${schema}"; expected "${RELAY_HISTORY_SCHEMA}"`,
      );
    }
  }
  return validateRelayHistoryDoc(raw);
}

// ---------------------------------------------------------------------------
// Exact-key association between a normalized Run and observed effect evidence.
// ---------------------------------------------------------------------------

export type RelayCallMatchKind =
  | "matched"
  | "no-history"
  | "kind-mismatch"
  | "missing-arguments";

export interface RelayCallMatch {
  /** Event id of the `tool.started` call (`pi-tool-<toolCallId>` for Pi). */
  eventId: string;
  /** The persisted tool-call id, when recoverable from the event id. */
  toolCallId: string;
  kind: RelayCallMatchKind;
  /** `${actionId}:${operationId}` when both arguments are present. */
  expectedKey?: string;
  /** `mcp:${actionId}` when actionId is present. */
  expectedKind?: string;
  /** Kind recorded on the journal row when a key match exists. */
  journalKind?: string;
  /** Index into the export's histories when the link exists. */
  historyIndex?: number;
  /**
   * True when another call in this run resolves to the same key. A shared
   * key is never exclusive attribution — every match is unverified.
   */
  sharedKey: boolean;
}

export interface RelayEvidenceView {
  /** One entry per `relay_submit_action` tool call, in run order. */
  calls: RelayCallMatch[];
  /** Histories no call in this run matched — explicitly unassociated. */
  unassociated: RelayEffectHistory[];
}

const stripPiPrefix = (eventId: string): string =>
  eventId.startsWith("pi-tool-") ? eventId.slice("pi-tool-".length) : eventId;

/**
 * Associates a run's `relay_submit_action` calls with effect histories by
 * exact string match on persisted arguments only. Calls without usable
 * `actionId`/`operationId` arguments never link; a key whose journal row has
 * a different kind never links; histories no call matched stay unassociated.
 */
export function matchRelayEvidence(
  run: Run,
  histories: RelayEffectHistory[],
): RelayEvidenceView {
  const byKey = new Map<string, number[]>();
  histories.forEach((history, index) => {
    const list = byKey.get(history.record.key) ?? [];
    list.push(index);
    byKey.set(history.record.key, list);
  });

  const calls: RelayCallMatch[] = [];
  const matched = new Set<number>();
  for (const event of run.events) {
    if (event.type !== "tool.started") continue;
    const data = event.data as { tool?: unknown; input?: unknown };
    if (data?.tool !== RELAY_SUBMIT_TOOL) continue;
    const input =
      typeof data.input === "object" && data.input !== null
        ? (data.input as { actionId?: unknown; operationId?: unknown })
        : undefined;
    const actionId =
      typeof input?.actionId === "string" ? input.actionId : undefined;
    const operationId =
      typeof input?.operationId === "string" ? input.operationId : undefined;
    const base = { eventId: event.id, toolCallId: stripPiPrefix(event.id) };
    if (actionId === undefined || operationId === undefined) {
      calls.push({ ...base, kind: "missing-arguments", sharedKey: false });
      continue;
    }
    const expectedKey = `${actionId}:${operationId}`;
    const expectedKind = `${RELAY_MCP_KIND_PREFIX}${actionId}`;
    const hits = byKey.get(expectedKey) ?? [];
    const index = hits.find((i) => histories[i]?.record.kind === expectedKind);
    if (index === undefined) {
      calls.push(
        hits.length > 0
          ? {
              ...base,
              kind: "kind-mismatch",
              expectedKey,
              expectedKind,
              journalKind: histories[hits[0] as number]?.record.kind,
              sharedKey: false,
            }
          : {
              ...base,
              kind: "no-history",
              expectedKey,
              expectedKind,
              sharedKey: false,
            },
      );
      continue;
    }
    matched.add(index);
    calls.push({
      ...base,
      kind: "matched",
      expectedKey,
      expectedKind,
      journalKind: expectedKind,
      historyIndex: index,
      sharedKey: false,
    });
  }
  const keyUse = new Map<number, number>();
  for (const call of calls) {
    if (call.historyIndex !== undefined) {
      keyUse.set(call.historyIndex, (keyUse.get(call.historyIndex) ?? 0) + 1);
    }
  }
  for (const call of calls) {
    if (
      call.historyIndex !== undefined &&
      (keyUse.get(call.historyIndex) ?? 0) > 1
    ) {
      call.sharedKey = true;
    }
  }
  const unassociated = histories.filter((_, i) => !matched.has(i));
  return { calls, unassociated };
}

/** Latest-state label such as `CONFIRMED (observed)` or `UNKNOWN (partial)`. */
export const historyLabel = (history: RelayEffectHistory): string =>
  `${history.record.status} (${history.coverage} history)`;
