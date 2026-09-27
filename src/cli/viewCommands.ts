import type { Command } from "commander";
import { AgentLensValidationError } from "../core/errors.js";
import { defaultDbPath, SqliteTraceStore } from "../storage/sqlite/store.js";
import { formatRunDiff } from "./diffView.js";
import { relayEvidenceJson } from "./relayView.js";
import { formatRunInspect, formatRunsTable } from "./runView.js";
import { formatRunSummary } from "./summaryView.js";

const reportError = (error: unknown): void => {
  console.error(
    `agentlens: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
};

/**
 * `agentlens runs`: list recorded runs in stable order.
 * `agentlens inspect <run-id>`: metadata, tool calls, errors, metrics,
 * event timeline, rules-based possible-loop diagnostics and final result
 * for one run.
 * `agentlens diff <runA> <runB>`: deterministic comparison of two runs.
 * All read the store through SqliteTraceStore.openReadOnly: they never
 * create a missing database, modify rows, or run migrations.
 */
export function registerViewCommands(program: Command): void {
  program
    .command("runs")
    .description(
      "List recorded runs: id, status, agent/model, times and tool metrics",
    )
    .option("--db <path>", "SQLite database path", defaultDbPath())
    .action((options: { db: string }) => {
      try {
        const store = SqliteTraceStore.openReadOnly(options.db);
        try {
          process.stdout.write(formatRunsTable(store.listRuns()));
        } finally {
          store.close();
        }
      } catch (error) {
        reportError(error);
      }
    });

  program
    .command("inspect")
    .description(
      "Show one run: metadata, ordered events, tool calls, errors, metrics, possible-loop diagnostics and result",
    )
    .argument("<run-id>", "id of the run to inspect")
    .option("--db <path>", "SQLite database path", defaultDbPath())
    .option("--json", "emit machine-readable JSON instead of text")
    .option("--summary", "show a bounded summary with error event IDs")
    .action(
      (
        runId: string,
        options: { db: string; json?: boolean; summary?: boolean },
      ) => {
        try {
          if (options.summary && options.json) {
            throw new AgentLensValidationError(
              "--summary cannot be combined with --json",
            );
          }
          const store = SqliteTraceStore.openReadOnly(options.db);
          try {
            const run = store.getRun(runId);
            const evidence = store.getRelayEvidence(runId);
            if (options.json === true) {
              process.stdout.write(
                `${JSON.stringify(
                  {
                    schema: "agentlens.inspect/1",
                    run,
                    relayEvidence:
                      evidence === undefined
                        ? null
                        : relayEvidenceJson(run, evidence),
                  },
                  null,
                  2,
                )}\n`,
              );
            } else if (options.summary) {
              process.stdout.write(formatRunSummary(run, evidence));
            } else {
              process.stdout.write(formatRunInspect(run, evidence));
            }
          } finally {
            store.close();
          }
        } catch (error) {
          reportError(error);
        }
      },
    );

  program
    .command("diff")
    .description(
      "Compare two runs: metrics deltas, tool distribution, errors, outcome and timeline",
    )
    .argument("<runA>", "id of the first (baseline) run")
    .argument("<runB>", "id of the second (comparison) run")
    .option("--db <path>", "SQLite database path", defaultDbPath())
    .option("--json", "emit machine-readable JSON instead of text")
    .action(
      (runA: string, runB: string, options: { db: string; json?: boolean }) => {
        try {
          if (runA === runB) {
            throw new AgentLensValidationError(
              `Cannot diff run ${runA} with itself; provide two different run ids`,
            );
          }
          const store = SqliteTraceStore.openReadOnly(options.db);
          try {
            const a = store.getRun(runA);
            const b = store.getRun(runB);
            const aEvidence = store.getRelayEvidence(runA);
            const bEvidence = store.getRelayEvidence(runB);
            if (options.json === true) {
              process.stdout.write(
                `${JSON.stringify(
                  {
                    schema: "agentlens.diff/1",
                    a: { id: a.id, status: a.status },
                    b: { id: b.id, status: b.status },
                    relayEvidence: {
                      a:
                        aEvidence === undefined
                          ? null
                          : relayEvidenceJson(a, aEvidence),
                      b:
                        bEvidence === undefined
                          ? null
                          : relayEvidenceJson(b, bEvidence),
                    },
                  },
                  null,
                  2,
                )}\n`,
              );
            } else {
              process.stdout.write(formatRunDiff(a, b, aEvidence, bEvidence));
            }
          } finally {
            store.close();
          }
        } catch (error) {
          reportError(error);
        }
      },
    );
}
