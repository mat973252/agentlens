import type { Command } from "commander";
import { defaultDbPath, SqliteTraceStore } from "../storage/sqlite/store.js";
import { formatRunInspect, formatRunsTable } from "./runView.js";

const reportError = (error: unknown): void => {
  console.error(
    `agentlens: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
};

/**
 * `agentlens runs`: list recorded runs in stable order.
 * `agentlens inspect <run-id>`: metadata, tool calls, errors, metrics,
 * event timeline and final result for one run.
 * Both read the store through SqliteTraceStore.openReadOnly: they never
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
      "Show one run: metadata, ordered events, tool calls, errors, metrics and result",
    )
    .argument("<run-id>", "id of the run to inspect")
    .option("--db <path>", "SQLite database path", defaultDbPath())
    .action((runId: string, options: { db: string }) => {
      try {
        const store = SqliteTraceStore.openReadOnly(options.db);
        try {
          process.stdout.write(formatRunInspect(store.getRun(runId)));
        } finally {
          store.close();
        }
      } catch (error) {
        reportError(error);
      }
    });
}
