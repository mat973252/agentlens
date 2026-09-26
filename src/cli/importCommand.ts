import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  IMPORT_FORMAT_NAMES,
  importRun,
  isImportFormat,
} from "../adapters/index.js";
import { parseRelayHistoryExport } from "../core/relayEvidence.js";
import { defaultDbPath, SqliteTraceStore } from "../storage/sqlite/store.js";

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * `agentlens import <file>`: validate an input trace file and write it into
 * the local SQLite store. The input format is named explicitly with
 * `--format` — `agentlens-trace` (the M2 envelope, default), `generic`
 * (agentlens-generic line-per-event input) or `pi` (a Pi coding-agent
 * session JSONL file). Everything is processed locally; file contents never
 * leave the machine. The write is atomic — an invalid file or a duplicate
 * run id leaves the database untouched.
 *
 * `--relay-history <file>` attaches offline Relay effect-history evidence
 * (`relay effects --history --json`, schema `relay.effect-history/1`) to a
 * Pi import. It requires `--format pi` and is rejected for any other
 * format. The export is validated before any write: schema version,
 * statuses, ids/keys, transition chain/order, last observed state versus
 * the latest snapshot and coverage must all agree. Only allowlisted
 * evidence fields plus the source file SHA-256 hashes are persisted —
 * provider free-form fields (reason, remoteRef, result payloads, intent)
 * and other sidecar extras are discarded, never stored.
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
    .option(
      "--relay-history <file>",
      "offline Relay effect-history JSON export to attach as evidence (requires --format pi)",
    )
    .action(
      (
        file: string,
        options: { db: string; format: string; relayHistory?: string },
      ) => {
        try {
          if (!isImportFormat(options.format)) {
            throw new Error(
              `Unknown import format "${options.format}"; expected one of: ${IMPORT_FORMAT_NAMES.join(", ")}`,
            );
          }
          if (options.relayHistory !== undefined && options.format !== "pi") {
            throw new Error(
              `--relay-history is only supported with --format pi (a Pi session file); got --format ${options.format}`,
            );
          }
          const text = readFileSync(file, "utf8");
          const run = importRun(text, options.format);

          let evidence:
            | {
                exportDoc: ReturnType<typeof parseRelayHistoryExport>;
                sessionSha256: string;
                historySha256: string;
                importedAt: string;
              }
            | undefined;
          if (options.relayHistory !== undefined) {
            const historyText = readFileSync(options.relayHistory, "utf8");
            evidence = {
              exportDoc: parseRelayHistoryExport(historyText),
              sessionSha256: sha256(text),
              historySha256: sha256(historyText),
              importedAt: new Date().toISOString(),
            };
          }

          const store = SqliteTraceStore.open(options.db);
          try {
            store.saveRun(run, evidence);
          } finally {
            store.close();
          }
          const evidenceNote =
            evidence !== undefined
              ? ` + ${evidence.exportDoc.histories.length} relay effect(s) (observed evidence, unverified association)`
              : "";
          console.log(
            `Imported run ${run.id}: ${run.events.length} events, status ${run.status}${evidenceNote} -> ${options.db}`,
          );
        } catch (error) {
          console.error(
            `agentlens: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exitCode = 1;
        }
      },
    );
}
