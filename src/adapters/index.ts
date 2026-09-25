import type { Run } from "../core/run.js";
import { parseRunTraceJsonl } from "../schema/traceJsonl.js";
import { parseGenericJsonl } from "./generic.js";
import { parsePiSession } from "./pi.js";

/**
 * Import formats supported by `agentlens import --format`. Every adapter is
 * explicit — the caller names the format, there is no content sniffing.
 * Each adapter validates the whole input and returns one normalized Run;
 * the store then performs the atomic write.
 */
export const IMPORT_FORMATS = {
  "agentlens-trace": (text: string) => parseRunTraceJsonl(text).run,
  generic: (text: string) => parseGenericJsonl(text),
  pi: (text: string) => parsePiSession(text),
} as const;

export type ImportFormat = keyof typeof IMPORT_FORMATS;

export const IMPORT_FORMAT_NAMES = Object.keys(IMPORT_FORMATS);

export function isImportFormat(name: string): name is ImportFormat {
  return name in IMPORT_FORMATS;
}

export function importRun(text: string, format: ImportFormat): Run {
  return IMPORT_FORMATS[format](text);
}
