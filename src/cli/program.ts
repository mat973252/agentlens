import { Command } from "commander";

export const CLI_NAME = "agentlens";
export const CLI_VERSION = "0.0.1";

export function createProgram(): Command {
  const program = new Command();
  program
    .name(CLI_NAME)
    .description(
      "AgentLens — record, inspect and diff agent executions.\n" +
        "M0 skeleton: no commands are implemented yet. Planned V0.1 commands: runs, show, inspect, diff.",
    )
    .version(CLI_VERSION, "-v, --version", "print the version");
  return program;
}
