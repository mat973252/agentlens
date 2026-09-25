import { Command } from "commander";
import { registerImportCommand } from "./importCommand.js";
import { registerViewCommands } from "./viewCommands.js";

export const CLI_NAME = "agentlens";
export const CLI_VERSION = "0.0.1";

export function createProgram(): Command {
  const program = new Command();
  program
    .name(CLI_NAME)
    .description(
      "AgentLens — record, inspect and diff agent executions.\n" +
        "Implemented: import, runs, inspect. Not yet implemented: show, diff.",
    )
    .version(CLI_VERSION, "-v, --version", "print the version");
  registerImportCommand(program);
  registerViewCommands(program);
  return program;
}
