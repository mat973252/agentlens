import type { z } from "zod";

/** Thrown when input fails AgentLens schema or referential validation. */
export class AgentLensValidationError extends Error {
  readonly issues: z.core.$ZodIssue[] | undefined;

  constructor(message: string, issues?: z.core.$ZodIssue[]) {
    super(message);
    this.name = "AgentLensValidationError";
    this.issues = issues;
  }
}

/** Thrown for a trace document or database whose schema version is not supported. */
export class UnsupportedSchemaVersionError extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number, context = "trace") {
    super(
      `Unsupported ${context} schema version ${found}; this AgentLens supports version ${supported}.`,
    );
    this.name = "UnsupportedSchemaVersionError";
    this.found = found;
    this.supported = supported;
  }
}

/** Thrown for storage-level failures (missing run, constraint violation, corrupt row). */
export class AgentLensStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentLensStorageError";
  }
}
