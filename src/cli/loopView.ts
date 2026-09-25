import type { LoopReport } from "../core/loops.js";

/**
 * Renders the "Possible loops" diagnostics section for `agentlens inspect`.
 * Every signal is phrased as a possibility backed by event evidence;
 * a clean run states so explicitly instead of staying silent.
 */
export function formatLoopSection(report: LoopReport): string[] {
  const out: string[] = ["", "Possible loops"];
  if (report.totalSignalCount === 0) {
    out.push("  No loop signals detected.");
  } else {
    const truncated = report.signals.length < report.totalSignalCount;
    out.push(
      `  ${report.totalSignalCount} signal(s)` +
        (truncated
          ? ` — showing ${report.signals.length}, rest summarized in notes below`
          : "") +
        ":",
    );
    report.signals.forEach((signal, i) => {
      out.push(`  ${i + 1}. [${signal.rule}] ${signal.description}`);
      for (const line of signal.evidence) {
        out.push(`       evidence  ${line}`);
      }
      out.push(`       boundary  ${signal.caveat}`);
    });
  }
  for (const note of report.notes) {
    out.push(`  note: ${note}`);
  }
  return out;
}
