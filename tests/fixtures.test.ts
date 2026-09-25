import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deserializeRunTrace, serializeRunTrace } from "../src/schema/trace.js";
import { SqliteTraceStore } from "../src/storage/sqlite/store.js";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures", import.meta.url));
const fixtureFiles = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("fixture traces", () => {
  it("ships at least 10 reusable fixtures", () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(10);
  });

  it.each(fixtureFiles)(
    "%s deserializes, validates and round-trips byte-for-byte",
    (file) => {
      const text = readFileSync(join(FIXTURES_DIR, file), "utf8");
      const doc = deserializeRunTrace(text);
      expect(doc.schemaVersion).toBe(1);
      expect(doc.run.events.length).toBeGreaterThan(0);

      const reparsed = deserializeRunTrace(serializeRunTrace(doc.run));
      expect(reparsed.run).toEqual(doc.run);
      expect(serializeRunTrace(reparsed.run)).toBe(serializeRunTrace(doc.run));
    },
  );

  it.each(fixtureFiles)(
    "%s writes to and reads back from SQLite preserving order and field values",
    (file) => {
      const text = readFileSync(join(FIXTURES_DIR, file), "utf8");
      const doc = deserializeRunTrace(text);
      const store = SqliteTraceStore.open(":memory:");
      try {
        store.saveRun(doc.run);
        const read = store.getRun(doc.run.id);

        expect(read.events.map((e) => e.id)).toEqual(
          doc.run.events.map((e) => e.id),
        );
        expect(read.events.map((e) => e.timestamp)).toEqual(
          doc.run.events.map((e) => e.timestamp),
        );
        expect(read).toEqual(doc.run);
        expect(serializeRunTrace(read)).toBe(serializeRunTrace(doc.run));
      } finally {
        store.close();
      }
    },
  );
});
