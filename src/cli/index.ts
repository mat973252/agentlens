import { createProgram } from "./program.js";

const program = createProgram();
if (process.argv.length <= 2) {
  program.outputHelp();
} else {
  program.parse(process.argv);
}
