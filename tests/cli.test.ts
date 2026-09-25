import { describe, expect, it } from "vitest";
import { CLI_NAME, CLI_VERSION, createProgram } from "../src/cli/program.js";

describe("agentlens CLI", () => {
  it("shows the project name and entry point in help", () => {
    const help = createProgram().helpInformation();
    expect(help).toContain(`Usage: ${CLI_NAME}`);
    expect(help).toContain("AgentLens");
    expect(help).toContain("--help");
  });

  it("does not expose unimplemented commands", () => {
    const program = createProgram();
    expect(program.commands).toHaveLength(0);
  });

  it("exposes a version", () => {
    expect(createProgram().version()).toBe(CLI_VERSION);
  });
});
