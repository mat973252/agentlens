import { createProgram } from "./program.js";

const program = createProgram();
if (process.argv.length <= 2) {
  program.outputHelp();
} else {
  void program.parseAsync(process.argv);
}
