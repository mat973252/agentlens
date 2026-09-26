import type { JsonValue } from "../core/json.js";
import {
  historyLabel,
  matchRelayEvidence,
  type RelayEffectHistory,
  type RelayEvidenceView,
} from "../core/relayEvidence.js";
import type { Run } from "../core/run.js";
import type { StoredRelayEvidence } from "../storage/sqlite/store.js";

/**
 * Read-only renderer for observed Relay effect evidence. Output is kept
 * separate from Run/tool metrics everywhere: it reports what the offline
 * journal export recorded — nothing is synthesized or inferred.
 */

const iso = (ms: number | undefined): string =>
  ms === undefined ? "-" : new Date(ms).toISOString();

const pad = (text: string, width: number) => text.padEnd(width);

/** Word-wraps a note to stay readable in an 80-column terminal. */
const wrapNote = (text: string, indent: string, width = 78): string[] => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (`${indent}${line} ${word}`.length <= width) line += ` ${word}`;
    else {
      lines.push(`${indent}${line}`);
      line = word;
    }
  }
  if (line !== "") lines.push(`${indent}${line}`);
  return lines;
};

export const RELAY_ASSOCIATION_NOTE =
  "Association is an exact key match only: key = actionId:operationId from " +
  "persisted relay_submit_action arguments (kind mcp:<actionId>). It proves " +
  "identity of the journal key, not exclusive ownership, session binding or " +
  "causality — keys may be reused across calls/sessions and the journal " +
  "carries no Pi identity. Every match is ownership-unverified.";

export const RELAY_TIMESTAMP_NOTE =
  "Transition times are the Relay journal's own clock, preserved as " +
  "recorded; no causal ordering against Pi timestamps is claimed.";

export const RELAY_RECOVERY_NOTE =
  "Recovery: no recovery source exists in this evidence — recovery state is " +
  'unknown/unrecorded for every effect, never "none".';

const transitionLine = (e: RelayEffectHistory["events"][number]): string =>
  `#${e.seq} ${e.fromStatus ?? "-"} -> ${e.toStatus} (${e.cause}) at ${iso(e.at)}`;

const coverageCounts = (histories: RelayEffectHistory[]): string => {
  const counts = { observed: 0, partial: 0, unavailable: 0 };
  for (const h of histories) counts[h.coverage]++;
  return `${counts.observed} observed / ${counts.partial} partial / ${counts.unavailable} unavailable`;
};

const describeHistory = (h: RelayEffectHistory, indent: string): string[] => {
  const out: string[] = [];
  const r = h.record;
  out.push(
    `${indent}${pad("Latest", 12)}${historyLabel(h)} · kind ${r.kind} · id ${r.id}`,
  );
  out.push(
    `${indent}${pad("Snapshot", 12)}created ${iso(r.createdAt)} · submitted ${iso(r.submittedAt)} · settled ${iso(r.settledAt)} · updated ${iso(r.updatedAt)}`,
  );
  if (h.events.length === 0) {
    out.push(
      `${indent}${pad("Transitions", 12)}(history unavailable — no observed transitions; not backfilled)`,
    );
  } else {
    out.push(`${indent}Transitions`);
    for (const e of h.events) out.push(`${indent}  ${transitionLine(e)}`);
  }
  return out;
};

const describeCalls = (view: RelayEvidenceView, indent: string): string[] => {
  const out: string[] = [];
  if (view.calls.length === 0) {
    out.push(
      `${indent}No relay_submit_action tool calls were recorded in this run.`,
    );
    return out;
  }
  out.push(`${indent}relay_submit_action calls:`);
  for (const call of view.calls) {
    const ref = `${call.toolCallId} (event ${call.eventId})`;
    if (call.kind === "matched" && call.historyIndex !== undefined) {
      const shared = call.sharedKey
        ? " · shared key — not exclusive attribution"
        : "";
      out.push(
        `${indent}  ${ref} -> effect #${call.historyIndex + 1} key ${call.expectedKey} (exact match, ownership unverified${shared})`,
      );
    } else if (call.kind === "kind-mismatch") {
      out.push(
        `${indent}  ${ref} -> NOT linked: journal kind ${call.journalKind ?? "?"} != expected ${call.expectedKind ?? "?"} for key ${call.expectedKey ?? "?"}`,
      );
    } else if (call.kind === "no-history") {
      out.push(
        `${indent}  ${ref} -> NOT linked: no journal row for key ${call.expectedKey ?? "?"}`,
      );
    } else {
      out.push(
        `${indent}  ${ref} -> NOT linked: missing actionId/operationId arguments`,
      );
    }
  }
  return out;
};

/**
 * `inspect` evidence section lines (without the blank separator). Returns
 * undefined when no evidence was imported for the run.
 */
export function formatRelayEvidenceSection(
  run: Run,
  evidence: StoredRelayEvidence | undefined,
): string[] | undefined {
  if (evidence === undefined) return undefined;
  const view = matchRelayEvidence(run, evidence.histories);
  const out: string[] = ["Relay effect evidence"];
  out.push(
    `  Source      ${evidence.schema} · ${evidence.histories.length} effect(s) (${coverageCounts(evidence.histories)})`,
  );
  out.push(`  Imported    ${evidence.importedAt}`);
  out.push(`  Hashes      session sha256 ${evidence.sessionSha256}`);
  out.push(`              history sha256 ${evidence.historySha256}`);
  out.push(...wrapNote(RELAY_ASSOCIATION_NOTE, "  "));
  out.push(...wrapNote(RELAY_TIMESTAMP_NOTE, "  "));
  out.push(...wrapNote(RELAY_RECOVERY_NOTE, "  "));
  out.push("", "  Effects");
  if (evidence.histories.length === 0) {
    out.push("    (none in the export)");
  }
  evidence.histories.forEach((history, i) => {
    out.push(`    ${i + 1}. key ${history.record.key}`);
    out.push(...describeHistory(history, "       "));
  });
  out.push("");
  out.push(...describeCalls(view, "  "));
  if (view.unassociated.length > 0) {
    out.push("");
    out.push(
      "  Unassociated evidence (no relay_submit_action call in this run matched):",
    );
    for (const history of view.unassociated) {
      out.push(
        `    ${history.record.key}  ${historyLabel(history)} — observed but not linked to this run`,
      );
    }
  }
  return out;
}

/**
 * Structured evidence view for `inspect --json` / `diff --json`: the stored
 * histories verbatim (allowlisted fields only) plus the computed exact-key
 * association and the limitation notes — same information as the text
 * section, machine-readable.
 */
export function relayEvidenceJson(
  run: Run,
  evidence: StoredRelayEvidence,
): JsonValue {
  const view = matchRelayEvidence(run, evidence.histories);
  return {
    calls: view.calls.map((c) => ({
      eventId: c.eventId,
      toolCallId: c.toolCallId,
      kind: c.kind,
      expectedKey: c.expectedKey ?? null,
      expectedKind: c.expectedKind ?? null,
      journalKind: c.journalKind ?? null,
      historyIndex: c.historyIndex ?? null,
      sharedKey: c.sharedKey,
    })),
    schema: evidence.schema,
    provenance: {
      sessionSha256: evidence.sessionSha256,
      historySha256: evidence.historySha256,
      importedAt: evidence.importedAt,
    },
    limitations: [
      RELAY_ASSOCIATION_NOTE,
      RELAY_TIMESTAMP_NOTE,
      RELAY_RECOVERY_NOTE,
    ],
    effects: evidence.histories.map((history, index) => ({
      effectId: history.record.id,
      key: history.record.key,
      kind: history.record.kind,
      latestStatus: history.record.status,
      coverage: history.coverage,
      observedTransitionCount: history.events.length,
      snapshot: {
        createdAt: history.record.createdAt,
        submittedAt: history.record.submittedAt ?? null,
        settledAt: history.record.settledAt ?? null,
        updatedAt: history.record.updatedAt,
      },
      transitions: history.events.map((e) => ({
        seq: e.seq,
        fromStatus: e.fromStatus ?? null,
        toStatus: e.toStatus,
        cause: e.cause,
        at: e.at,
      })),
      linkedCalls: view.calls
        .filter((c) => c.kind === "matched" && c.historyIndex === index)
        .map((c) => ({
          eventId: c.eventId,
          toolCallId: c.toolCallId,
          sharedKey: c.sharedKey,
          ownership: "unverified",
        })),
      recovery: "unknown (unrecorded — no recovery source in this evidence)",
    })),
    unassociatedKeys: view.unassociated.map((h) => h.record.key),
  };
}

const compactLabel = (h: RelayEffectHistory): string => {
  const coverage =
    h.coverage === "observed"
      ? "observed"
      : h.coverage === "partial"
        ? "partial"
        : "history unavailable";
  return `${h.record.status} (${coverage}, ${h.events.length} transition(s))`;
};

const evidenceSummary = (
  evidence: StoredRelayEvidence | undefined,
  run: Run | null,
): { label: string; view: RelayEvidenceView | null } => {
  if (evidence === undefined || run === null) {
    return { label: "no evidence imported", view: null };
  }
  const view = matchRelayEvidence(run, evidence.histories);
  const matched = view.calls.filter((c) => c.kind === "matched").length;
  return {
    label: `${evidence.histories.length} effect(s) (${coverageCounts(evidence.histories)}); ${matched}/${view.calls.length} call(s) key-matched`,
    view,
  };
};

/**
 * `diff` evidence section lines, comparing each run's attached evidence
 * separately from run/tool metrics — observed statuses and coverage only.
 */
export function formatRelayEvidenceDiffSection(
  a: Run,
  b: Run,
  aEvidence: StoredRelayEvidence | undefined,
  bEvidence: StoredRelayEvidence | undefined,
): string[] {
  const out: string[] = ["Relay effect evidence"];
  out.push(...wrapNote(RELAY_ASSOCIATION_NOTE, "  "));
  const aSum = evidenceSummary(aEvidence, a);
  const bSum = evidenceSummary(bEvidence, b);
  out.push(`  A ${aSum.label}`);
  out.push(`  B ${bSum.label}`);
  if (aEvidence === undefined && bEvidence === undefined) {
    return out;
  }
  const keys = new Map<
    string,
    { a?: RelayEffectHistory; b?: RelayEffectHistory }
  >();
  for (const h of aEvidence?.histories ?? []) {
    keys.set(h.record.key, { ...keys.get(h.record.key), a: h });
  }
  for (const h of bEvidence?.histories ?? []) {
    keys.set(h.record.key, { ...keys.get(h.record.key), b: h });
  }
  const rows = [...keys.entries()].sort(([x], [y]) => (x < y ? -1 : 1));
  if (rows.length === 0) {
    out.push("  (no effects in either import)");
    return out;
  }
  out.push("");
  out.push(`  ${pad("KEY", 44)} ${pad("A", 30)} B`);
  for (const [key, row] of rows) {
    out.push(
      `  ${pad(key, 44)} ${pad(row.a !== undefined ? compactLabel(row.a) : "-", 30)} ${row.b !== undefined ? compactLabel(row.b) : "-"}`,
    );
  }
  return out;
}
