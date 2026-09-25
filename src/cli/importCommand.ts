import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  IMPORT_FORMAT_NAMES,
  importRun,
  isImportFormat,
} from "../adapters/index.js";
import { defaultDbPath, SqliteTraceStore } from "../storage/sqlite/store.js";

/**
 * `agentlens import <file>`: validate an input trace file and write it into
 * the local SQLite store. The input format is named explicitly with
 * `--format` — `agentlens-trace` (the M2 envelope, default), `generic`
 * (agentlens-generic line-per-event input) or `pi` (a Pi coding-agent
 * session JSONL file). Everything is processed locally; file contents never
 * leave the machine. The write is atomic — an invalid file or a duplicate
 * run id leaves the database untouched.
 */
export function registerImportCommand(program: Command): void {
  program
    .command("import")
    .description(
      "Import a run trace into local storage (formats: " +
        IMPORT_FORMAT_NAMES.join(", ") +
        ")",
    )
    .argument("<file>", "path to the input file")
    .option("--db <path>", "SQLite database path", defaultDbPath())
    .option(
      "--format <name>",
      `input format: ${IMPORT_FORMAT_NAMES.join("|")}`,
      "agentlens-trace",
    )
    .action((file: string, options: { db: string; format: string }) => {
      try {
        if (!isImportFormat(options.format)) {
          throw new Error(
            `Unknown import format "${options.format}"; expected one of: ${IMPORT_FORMAT_NAMES.join(", ")}`,
          );
        }
        const text = readFileSync(file, "utf8");
        const run = importRun(text, options.format);
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
