import { z } from "zod";
import {
  AgentLensValidationError,
  UnsupportedSchemaVersionError,
} from "../core/errors.js";
import { parseRun, type Run } from "../core/run.js";

/** Current trace schema version. Bump alongside storage migrations. */
export const SCHEMA_VERSION = 1;

export const traceDocumentSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  run: z.unknown(),
});

export interface TraceDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  run: Run;
}

export function serializeRunTrace(run: Run): string {
  return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, run }, null, 2)}\n`;
}

/**
 * Deserialize a trace document. Fails explicitly on malformed JSON, an
 * unsupported schemaVersion, or any schema violation — never drops data.
 */
export function deserializeRunTrace(text: string): TraceDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AgentLensValidationError(
      `Invalid trace document: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  if (typeof raw === "object" && raw !== null && "schemaVersion" in raw) {
    const version = (raw as { schemaVersion: unknown }).schemaVersion;
    if (version !== SCHEMA_VERSION) {
      throw new UnsupportedSchemaVersionError(Number(version), SCHEMA_VERSION);
    }
  }

  const doc = traceDocumentSchema.safeParse(raw);
  if (!doc.success) {
    throw new AgentLensValidationError(
      `Invalid trace document: ${z.prettifyError(doc.error)}`,
      doc.error.issues,
    );
  }
  return { schemaVersion: SCHEMA_VERSION, run: parseRun(doc.data.run) };
}
