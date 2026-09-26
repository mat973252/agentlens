import { detectPossibleLoops } from "../core/loops.js";
import type { Run } from "../core/run.js";
import type { StoredRelayEvidence } from "../storage/sqlite/store.js";
import { errorMessage, preview } from "./eventDetails.js";

/** Bounded navigation aid; recorded signals are not a root-cause diagnosis. */
export function formatRunSummary(
  run: Run,
  evidence?: StoredRelayEvidence,
): string {
  const failures = run.events.filter(
    (e) =>
      e.type === "run.failed" || e.type === "tool.failed" || e.type === "error",
  );
  const selected = [
    ...failures.filter((e) => e.type === "run.failed"),
    ...failures.filter((e) => e.type !== "run.failed"),
  ].slice(0, 5);
  const finished = new Set(
    run.events
      .filter((e) => e.type === "tool.completed" || e.type === "tool.failed")
      .map((e) => e.parentId),
  );
  const started = run.events.filter((e) => e.type === "tool.started");
  const out = [
    `Run: ${JSON.stringify(run.id)}`,
    `Recorded status: ${run.status}`,
    `Recorded events: ${run.events.length}; tool starts: ${started.length}; starts without recorded outcome: ${started.filter((e) => !finished.has(e.id)).length}`,
    `Recorded error/failure signals: ${failures.length} (showing ${selected.length})`,
    ...selected.map(
      (e) =>
        `  ${e.type} event=${JSON.stringify(e.id)}${e.parentId === undefined ? "" : ` parent=${JSON.stringify(e.parentId)}`} ${preview(errorMessage(e), 180)}`,
    ),
  ];
  if (failures.length > selected.length)
    out.push(
      `  ${failures.length - selected.length} signals omitted; inspect the full run.`,
    );
  out.push(
    `Possible loop signals: ${detectPossibleLoops(run).totalSignalCount} (heuristics, not a diagnosis)`,
  );
  if (evidence !== undefined) {
    const unresolved = evidence.histories.filter((h) =>
      ["UNKNOWN", "SUBMITTED", "PREPARED"].includes(h.record.status),
    );
    out.push(
      `Attached Relay evidence: ${evidence.histories.length} effects; ${unresolved.length} recorded unresolved`,
    );
    for (const status of ["UNKNOWN", "SUBMITTED", "PREPARED"]) {
      out.push(
        `  ${status}: ${unresolved.filter((h) => h.record.status === status).length}`,
      );
    }
    out.push(
      "Relay evidence is independent of run status; ownership and recovery are unverified.",
    );
  }
  out.push(
    "Signals may include recovered errors; absence of signals does not prove health.",
    "Next: inspect the same run without --summary (or with --json), using the same --db, for event evidence.",
  );
  return `${out.join("\n")}\n`;
}
