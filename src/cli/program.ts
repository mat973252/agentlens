import { Command } from "commander";
import { registerImportCommand } from "./importCommand.js";
import { registerUiCommand } from "./uiCommand.js";
import { registerViewCommands } from "./viewCommands.js";

export const CLI_NAME = "agentlens";
export const CLI_VERSION = "0.0.1";

export function createProgram(): Command {
  const program = new Command();
  program
    .name(CLI_NAME)
    .description(
      "AgentLens — record, inspect and diff agent executions.\n" +
        "Implemented: import, runs, inspect, diff, ui. Not yet implemented: show.",
    )
    .version(CLI_VERSION, "-v, --version", "print the version");
  registerImportCommand(program);
  registerViewCommands(program);
  registerUiCommand(program);
  return program;
}
