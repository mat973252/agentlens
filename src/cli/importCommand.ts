import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { parseRunTraceJsonl } from "../schema/traceJsonl.js";
import { defaultDbPath, SqliteTraceStore } from "../storage/sqlite/store.js";

/**
 * `agentlens import <file>`: validate an AgentLens trace JSONL file and write
 * it into the local SQLite store. Everything is processed locally; file
 * contents never leave the machine. The write is atomic — an invalid file or
 * a duplicate run id leaves the database untouched.
 */
export function registerImportCommand(program: Command): void {
  program
    .command("import")
    .description(
      "Import a run trace in the agentlens-trace JSONL format into local storage",
    )
    .argument("<file>", "path to a trace.jsonl file")
    .option("--db <path>", "SQLite database path", defaultDbPath())
    .action((file: string, options: { db: string }) => {
      try {
        const text = readFileSync(file, "utf8");
        const { run } = parseRunTraceJsonl(text);
        const store = SqliteTraceStore.open(options.db);
        try {
          store.saveRun(run);
        } finally {
          store.close();
        }
        console.log(
          `Imported run ${run.id}: ${run.events.length} events, status ${run.status} -> ${options.db}`,
        );
      } catch (error) {
        console.error(
          `agentlens: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      }
    });
}
