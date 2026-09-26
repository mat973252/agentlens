import type { Command } from "commander";
import { AgentLensValidationError } from "../core/errors.js";
import { defaultDbPath, SqliteTraceStore } from "../storage/sqlite/store.js";
import { runTui } from "../tui/app.js";
import type { TuiData } from "../tui/model.js";
import { type ColorMode, detectColorMode } from "../tui/theme.js";

/**
 * `agentlens ui`: the M7 interactive TUI. Loads the full run list through
 * the same SqliteTraceStore.openReadOnly path as `runs`/`inspect`/`diff`
 * (never creates or migrates a database), then hands a closed snapshot to
 * the UI — the database file is not touched again for the whole session.
 */
export function loadTuiData(dbPath: string): TuiData {
  const store = SqliteTraceStore.openReadOnly(dbPath);
  try {
    return {
      dbPath,
      runs: store.listRuns(),
      evidence: store.listRelayEvidence(),
    };
  } finally {
    store.close();
  }
}

const COLOR_MODES = ["auto", "truecolor", "ansi256", "ansi16", "none"] as const;
type ColorOption = (typeof COLOR_MODES)[number];

const parseColorOption = (value: string): ColorOption => {
  if ((COLOR_MODES as readonly string[]).includes(value)) {
    return value as ColorOption;
  }
  throw new AgentLensValidationError(
    `Unknown --color mode "${value}" (expected ${COLOR_MODES.join("|")})`,
  );
};

/**
 * The color mode a `ui` run uses: `NO_COLOR` wins over `--color`, an
 * explicit mode wins over environment detection, and `auto` asks
 * `detectColorMode`.
 */
export function resolveColorMode(
  requested: string,
  env: NodeJS.ProcessEnv = process.env,
): ColorMode {
  if (env.NO_COLOR !== undefined) return "none";
  if (requested === "auto") return detectColorMode(env);
  return requested as ColorMode;
}

export function registerUiCommand(program: Command): void {
  program
    .command("ui")
    .description(
      "Interactive terminal UI: run list, detail tabs (timeline/tools/errors/loops/inspect), A/B compare and full diff. Read-only; needs a real terminal.",
    )
    .option("--db <path>", "SQLite database path", defaultDbPath())
    .option(
      "--color <mode>",
      `color level: ${COLOR_MODES.join("|")} (NO_COLOR forces none)`,
      "auto",
    )
    .action(async (options: { db: string; color: string }) => {
      try {
        const requested = parseColorOption(options.color);
        // DB errors (missing/corrupt/future schema) must surface even in a
        // non-TTY invocation, so load before the TTY check.
        const data = loadTuiData(options.db);
        if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
          throw new AgentLensValidationError(
            "`agentlens ui` needs an interactive terminal (stdin and stdout must both be TTYs). " +
              "Use `agentlens runs`, `agentlens inspect <run>` or `agentlens diff <a> <b>` for non-interactive output.",
          );
        }
        const colorMode = resolveColorMode(requested);
        const code = await runTui(
          data,
          { input: process.stdin, output: process.stdout },
          colorMode,
        );
        if (code !== 0) process.exitCode = code;
      } catch (error) {
        console.error(
          `agentlens: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      }
    });
}
