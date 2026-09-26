import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePiSession } from "../src/adapters/pi.js";
import { createProgram } from "../src/cli/program.js";
import type { JsonValue } from "../src/core/json.js";
import {
  matchRelayEvidence,
  parseRelayHistoryExport,
  type RelayHistoryExport,
} from "../src/core/relayEvidence.js";
import type { Run } from "../src/core/run.js";
import { SqliteTraceStore } from "../src/storage/sqlite/store.js";
import { detailItems } from "../src/tui/model.js";

const fixture = (rel: string) =>
  fileURLToPath(new URL(`../${rel}`, import.meta.url));
const sessionFile = (name: string) =>
  fixture(`fixtures/pi-relay/session-${name}.jsonl`);
const historyFile = (name: string) =>
  fixture(`fixtures/pi-relay/relay-history-${name}.json`);

const tmpDirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentlens-m8-"));
  tmpDirs.push(dir);
  return dir;
};

afterEach(() => {
  let dir = tmpDirs.pop();
  while (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = tmpDirs.pop();
  }
});

const must = <T>(value: T | undefined | null, what: string): T => {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
};

const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const runCli = async (args: string[]): Promise<string> => {
  process.exitCode = 0;
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await createProgram().parseAsync(["node", "agentlens", ...args]);
  } finally {
    spy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return writes.join("");
};

const cliErrors = async (args: string[]): Promise<string> => {
  process.exitCode = 0;
  const errors: string[] = [];
  const errSpy = vi.spyOn(console, "error").mockImplementation((chunk) => {
    errors.push(String(chunk));
  });
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await createProgram().parseAsync(["node", "agentlens", ...args]);
  } finally {
    errSpy.mockRestore();
    logSpy.mockRestore();
  }
  return errors.join("");
};

const importPi = async (dir: string, session: string, history?: string) => {
  const db = join(dir, "agentlens.db");
  const args = ["import", sessionFile(session), "--db", db, "--format", "pi"];
  if (history !== undefined) args.push("--relay-history", historyFile(history));
  await runCli(args);
  return db;
};

const allRows = (db: string): Record<string, number> => {
  const raw = new DatabaseSync(db, { readOnly: true });
  try {
    const out: Record<string, number> = {};
    for (const table of [
      "runs",
      "events",
      "relay_evidence_imports",
      "relay_effects",
      "relay_effect_events",
    ]) {
      out[table] = (
        raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      ).n;
    }
    return out;
  } finally {
    raw.close();
  }
};

const evidenceTableDump = (db: string): string => {
  const raw = new DatabaseSync(db, { readOnly: true });
  try {
    return JSON.stringify({
      imports: raw.prepare("SELECT * FROM relay_evidence_imports").all(),
      effects: raw.prepare("SELECT * FROM relay_effects").all(),
      events: raw.prepare("SELECT * FROM relay_effect_events").all(),
    });
  } finally {
    raw.close();
  }
};

const loadHistoryJson = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(historyFile(name), "utf8")) as Record<
    string,
    unknown
  >;

const writeHistory = (dir: string, name: string, doc: unknown): string => {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(doc));
  return path;
};

describe("relay effect-history export validation", () => {
  it("parses a real relay.effect-history/1 export and discards free-form fields", () => {
    const doc = parseRelayHistoryExport(
      readFileSync(historyFile("success"), "utf8"),
    );
    expect(doc.schema).toBe("relay.effect-history/1");
    expect(doc.histories).toHaveLength(1);
    const history = doc.histories[0];
    expect(history?.record.status).toBe("CONFIRMED");
    expect(history?.coverage).toBe("observed");
    expect(history?.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(history?.events.at(-1)?.toStatus).toBe("CONFIRMED");
    // free-form fields are validated away before storage
    expect(Object.keys(history?.record ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "key",
      "kind",
      "settledAt",
      "status",
      "submittedAt",
      "updatedAt",
    ]);
  });

  it("rejects an unsupported schema version", () => {
    expect(() =>
      parseRelayHistoryExport(
        JSON.stringify({
          schema: "relay.effect-history/2",
          histories: [],
        }),
      ),
    ).toThrow(/unsupported schema version/);
  });

  it("rejects an invalid status", () => {
    const doc = loadHistoryJson("success");
    must(
      (doc.histories as { record: { status: string } }[])[0],
      "history",
    ).record.status = "BOGUS";
    expect(() => parseRelayHistoryExport(JSON.stringify(doc))).toThrow(
      /Invalid Relay effect-history export/,
    );
  });

  it("rejects a broken transition chain", () => {
    const doc = loadHistoryJson("success") as unknown as {
      histories: { events: { fromStatus?: string }[] }[];
    };
    must(must(doc.histories[0], "history").events[2], "event").fromStatus =
      "PREPARED";
    expect(() => parseRelayHistoryExport(JSON.stringify(doc))).toThrow(
      /broken transition chain/,
    );
  });

  it("rejects a last-state/snapshot conflict", () => {
    const doc = loadHistoryJson("success") as unknown as {
      histories: { record: { status: string } }[];
    };
    must(doc.histories[0], "history").record.status = "SUBMITTED";
    expect(() => parseRelayHistoryExport(JSON.stringify(doc))).toThrow(
      /last observed transition.*latest-state/,
    );
  });

  it("rejects contradictory coverage", () => {
    const doc = loadHistoryJson("success") as unknown as {
      histories: { coverage: string }[];
    };
    must(doc.histories[0], "history").coverage = "unavailable";
    expect(() => parseRelayHistoryExport(JSON.stringify(doc))).toThrow(
      /coverage "unavailable" contradicts/,
    );
  });

  it("rejects a duplicate transition seq", () => {
    const doc = loadHistoryJson("two-calls") as unknown as {
      histories: { events: { seq: number }[] }[];
    };
    must(must(doc.histories[1], "history").events[0], "event").seq = 1;
    expect(() => parseRelayHistoryExport(JSON.stringify(doc))).toThrow(
      /duplicate transition seq 1/,
    );
  });

  it("accepts a legacy record with no events as history-unavailable, never backfilled", () => {
    const doc = {
      schema: "relay.effect-history/1",
      histories: [
        {
          record: {
            id: "eff-legacy",
            key: "counter-increment:legacy-1",
            kind: "mcp:counter-increment",
            status: "PREPARED",
            createdAt: 1000,
            updatedAt: 1000,
          },
          events: [],
          coverage: "unavailable",
        },
      ],
    };
    const parsed = parseRelayHistoryExport(JSON.stringify(doc));
    expect(parsed.histories[0]?.coverage).toBe("unavailable");
    expect(parsed.histories[0]?.events).toHaveLength(0);
    expect(parsed.histories[0]?.record.status).toBe("PREPARED");
  });
});

describe("exact-key matching", () => {
  const mkRun = (
    calls: { id: string; input?: Record<string, string> }[],
  ): Run => ({
    id: "r-relay",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "passed",
    metrics: { toolCalls: calls.length, failedToolCalls: 0 },
    events: [
      ...calls.map((call, i) => ({
        id: `pi-tool-${call.id}`,
        runId: "r-relay",
        timestamp: `2026-01-01T00:00:0${i}.000Z`,
        type: "tool.started" as const,
        data: (call.input === undefined
          ? { tool: "relay_submit_action" }
          : { tool: "relay_submit_action", input: call.input }) as JsonValue,
      })),
      {
        id: "e-end",
        runId: "r-relay",
        timestamp: "2026-01-01T00:00:09.000Z",
        type: "run.completed" as const,
        data: null,
      },
    ],
  });

  const histories = parseRelayHistoryExport(
    readFileSync(historyFile("success"), "utf8"),
  ).histories;
  const key = must(histories[0], "history").record.key;
  const [actionId, operationId] = key.split(":") as [string, string];

  it("links a call with exact actionId/operationId arguments", () => {
    const view = matchRelayEvidence(
      mkRun([{ id: "c1", input: { actionId, operationId, intent: "x" } }]),
      histories,
    );
    expect(view.calls[0]?.kind).toBe("matched");
    expect(view.calls[0]?.historyIndex).toBe(0);
    expect(view.unassociated).toHaveLength(0);
  });

  it("never links a call missing arguments", () => {
    const view = matchRelayEvidence(
      mkRun([{ id: "c1", input: {} }, { id: "c2" }]),
      histories,
    );
    expect(view.calls.every((c) => c.kind === "missing-arguments")).toBe(true);
    expect(view.unassociated).toHaveLength(1);
  });

  it("never links on a key match with a mismatched journal kind", () => {
    const mutated: RelayHistoryExport = JSON.parse(
      JSON.stringify({ schema: "relay.effect-history/1", histories }),
    );
    const record = must(mutated.histories[0], "history").record;
    record.kind = "mcp:other-action";
    const view = matchRelayEvidence(
      mkRun([{ id: "c1", input: { actionId, operationId } }]),
      mutated.histories,
    );
    expect(view.calls[0]?.kind).toBe("kind-mismatch");
    expect(view.calls[0]?.journalKind).toBe("mcp:other-action");
  });

  it("flags repeated keys as shared, never exclusive attribution", () => {
    const view = matchRelayEvidence(
      mkRun([
        { id: "c1", input: { actionId, operationId } },
        { id: "c2", input: { actionId, operationId } },
      ]),
      histories,
    );
    expect(view.calls.map((c) => c.kind)).toEqual(["matched", "matched"]);
    expect(view.calls.every((c) => c.sharedKey)).toBe(true);
  });
});

describe("agentlens import --relay-history", () => {
  it("imports a success run plus evidence atomically and inspect shows it", async () => {
    const dir = tmpDir();
    const db = await importPi(dir, "success", "success");
    const store = SqliteTraceStore.openReadOnly(db);
    try {
      const run = store.listRuns()[0];
      const evidence = store.getRelayEvidence(must(run, "run").id);
      expect(evidence?.schema).toBe("relay.effect-history/1");
      expect(evidence?.histories[0]?.record.status).toBe("CONFIRMED");
      expect(evidence?.histories[0]?.events).toHaveLength(3);
      expect(evidence?.sessionSha256).toBe(sha256(sessionFile("success")));
      expect(evidence?.historySha256).toBe(sha256(historyFile("success")));

      const out = await runCli(["inspect", must(run, "run").id, "--db", db]);
      expect(out).toContain("Relay effect evidence");
      expect(out).toContain("CONFIRMED (observed history)");
      expect(out).toContain("exact key match only");
      expect(out).toContain("ownership unverified");
      expect(out).toContain("unknown/unrecorded");
      expect(out).toContain(must(evidence, "evidence").sessionSha256);
      expect(out).toContain("PREPARED -> SUBMITTED (submit)");
    } finally {
      store.close();
    }
  });

  it("keeps UNKNOWN visible even when the Pi tool result succeeded", async () => {
    const dir = tmpDir();
    const db = await importPi(dir, "ambiguous", "ambiguous");
    const store = SqliteTraceStore.openReadOnly(db);
    try {
      const run = must(store.listRuns()[0], "run");
      expect(run.status).toBe("passed");
      const toolEnd = run.events.find((e) => e.type === "tool.completed");
      expect(toolEnd).toBeDefined();
      const evidence = must(store.getRelayEvidence(run.id), "evidence");
      expect(must(evidence.histories[0], "history").record.status).toBe(
        "UNKNOWN",
      );

      const out = await runCli(["inspect", run.id, "--db", db]);
      expect(out).toContain("UNKNOWN (observed history)");
      expect(out).not.toContain('"reason"');
    } finally {
      store.close();
    }
  });

  it("stores and reports two key-matched effects from one session", async () => {
    const dir = tmpDir();
    const db = await importPi(dir, "two-calls", "two-calls");
    const store = SqliteTraceStore.openReadOnly(db);
    try {
      const run = must(store.listRuns()[0], "run");
      const evidence = must(store.getRelayEvidence(run.id), "evidence");
      const view = matchRelayEvidence(run, evidence.histories);
      expect(evidence.histories).toHaveLength(2);
      expect(view.calls.map((c) => c.kind)).toEqual(["matched", "matched"]);
      expect(view.unassociated).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("rejects --relay-history with a non-pi format and writes nothing", async () => {
    const dir = tmpDir();
    const db = join(dir, "agentlens.db");
    const errors = await cliErrors([
      "import",
      sessionFile("success"),
      "--db",
      db,
      "--format",
      "generic",
      "--relay-history",
      historyFile("success"),
    ]);
    expect(process.exitCode).toBe(1);
    expect(errors).toContain(
      "--relay-history is only supported with --format pi",
    );
    expect(() => statSync(db)).toThrow();
  });

  it("rejects an invalid sidecar before writing and leaves no partial rows", async () => {
    const dir = tmpDir();
    const db = join(dir, "agentlens.db");
    const doc = loadHistoryJson("success") as unknown as {
      histories: { events: { fromStatus?: string }[] }[];
    };
    must(must(doc.histories[0], "history").events[1], "event").fromStatus =
      "CONFIRMED";
    const bad = writeHistory(dir, "broken", doc);
    const errors = await cliErrors([
      "import",
      sessionFile("success"),
      "--db",
      db,
      "--format",
      "pi",
      "--relay-history",
      bad,
    ]);
    expect(process.exitCode).toBe(1);
    expect(errors).toContain("broken transition chain");
    // Validation happens before the store is opened, so no database is even
    // created — there is nothing partial to clean up.
    expect(() => statSync(db)).toThrow();

    // With an existing database the same rejection must leave it unchanged.
    const existing = await importPi(dir, "ambiguous", "ambiguous");
    const before = allRows(existing);
    await cliErrors([
      "import",
      sessionFile("success"),
      "--db",
      existing,
      "--format",
      "pi",
      "--relay-history",
      bad,
    ]);
    expect(process.exitCode).toBe(1);
    expect(allRows(existing)).toEqual(before);
  });

  it("duplicate import fails and leaves the earlier run+evidence intact", async () => {
    const dir = tmpDir();
    const db = await importPi(dir, "success", "success");
    const before = allRows(db);
    const errors = await cliErrors([
      "import",
      sessionFile("success"),
      "--db",
      db,
      "--format",
      "pi",
      "--relay-history",
      historyFile("success"),
    ]);
    expect(process.exitCode).toBe(1);
    expect(errors).toContain("Failed to save run");
    expect(allRows(db)).toEqual(before);
    const store = SqliteTraceStore.openReadOnly(db);
    try {
      const run = must(store.listRuns()[0], "run");
      expect(store.getRelayEvidence(run.id)?.histories).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("rolls back the run when evidence rows violate constraints", async () => {
    const dir = tmpDir();
    const db = join(dir, "agentlens.db");
    const run = parsePiSession(readFileSync(sessionFile("success"), "utf8"));
    const store = SqliteTraceStore.open(db);
    try {
      // Bypass the export parser to force an insert-time constraint failure
      // mid-transaction: the run insert must roll back with it.
      const bogus = {
        schema: "relay.effect-history/1",
        histories: [
          {
            record: {
              id: "eff-x",
              key: "k:x",
              kind: "mcp:k",
              status: "BOGUS",
              createdAt: 1,
              updatedAt: 1,
            },
            events: [],
            coverage: "unavailable",
          },
        ],
      } as unknown as RelayHistoryExport;
      expect(() =>
        store.saveRun(run, {
          exportDoc: bogus,
          sessionSha256: "0".repeat(64),
          historySha256: "0".repeat(64),
          importedAt: new Date().toISOString(),
        }),
      ).toThrow(/Failed to save run/);
    } finally {
      store.close();
    }
    const raw = new DatabaseSync(db, { readOnly: true });
    try {
      expect(
        (raw.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number })
          .n,
      ).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("never persists provider free-form fields or arbitrary extras", async () => {
    const dir = tmpDir();
    const db = join(dir, "agentlens.db");
    const doc = loadHistoryJson("success") as {
      histories: { record: Record<string, unknown> }[];
    };
    const record = must(doc.histories[0], "history").record;
    record.reason = "SENTINEL_REASON_A1";
    record.remoteRef = "SENTINEL_REMOTEREF_B2";
    record.resultJson = "SENTINEL_RESULT_C3";
    record.intentJson = "SENTINEL_INTENT_D4";
    record.requestHash = "SENTINEL_REQHASH_E5";
    record.arbitraryExtra = "SENTINEL_EXTRA_F6";
    const seeded = writeHistory(dir, "seeded", doc);
    const errors = await cliErrors([
      "import",
      sessionFile("success"),
      "--db",
      db,
      "--format",
      "pi",
      "--relay-history",
      seeded,
    ]);
    expect(process.exitCode).toBe(0);
    expect(errors).toBe("");
    const dump = evidenceTableDump(db);
    for (const sentinel of [
      "SENTINEL_REASON_A1",
      "SENTINEL_REMOTEREF_B2",
      "SENTINEL_RESULT_C3",
      "SENTINEL_INTENT_D4",
      "SENTINEL_REQHASH_E5",
      "SENTINEL_EXTRA_F6",
    ]) {
      expect(dump).not.toContain(sentinel);
    }
    const store = SqliteTraceStore.openReadOnly(db);
    try {
      const run = must(store.listRuns()[0], "run");
      const out = await runCli(["inspect", run.id, "--db", db]);
      const json = await runCli(["inspect", run.id, "--db", db, "--json"]);
      expect(out + json).not.toMatch(/SENTINEL_/);
    } finally {
      store.close();
    }
  });

  it("keeps unmatched calls and unassociated evidence explicit", async () => {
    const dir = tmpDir();
    // session-success calls counter-increment:probe-success-… while the
    // two-calls export only holds probe-alpha/probe-beta keys.
    const db = await importPi(dir, "success", "two-calls");
    const store = SqliteTraceStore.openReadOnly(db);
    try {
      const run = must(store.listRuns()[0], "run");
      const evidence = must(store.getRelayEvidence(run.id), "evidence");
      const view = matchRelayEvidence(run, evidence.histories);
      expect(view.calls.map((c) => c.kind)).toEqual(["no-history"]);
      expect(view.unassociated).toHaveLength(2);
      const out = await runCli(["inspect", run.id, "--db", db]);
      expect(out).toContain("NOT linked: no journal row");
      expect(out).toContain("Unassociated evidence");
      expect(out).toContain("not linked to this run");
    } finally {
      store.close();
    }
  });

  it("does not link a key whose journal kind differs from mcp:<actionId>", async () => {
    const dir = tmpDir();
    const doc = loadHistoryJson("success") as {
      histories: {
        record: { kind: string };
        events: { kind: string }[];
      }[];
    };
    for (const h of doc.histories) {
      h.record.kind = "mcp:other-action";
      for (const e of h.events) e.kind = "mcp:other-action";
    }
    const mutated = writeHistory(dir, "kindmut", doc);
    const db = join(dir, "agentlens.db");
    await runCli([
      "import",
      sessionFile("success"),
      "--db",
      db,
      "--format",
      "pi",
      "--relay-history",
      mutated,
    ]);
    const store = SqliteTraceStore.openReadOnly(db);
    try {
      const run = must(store.listRuns()[0], "run");
      const evidence = must(store.getRelayEvidence(run.id), "evidence");
      const view = matchRelayEvidence(run, evidence.histories);
      expect(view.calls[0]?.kind).toBe("kind-mismatch");
      expect(view.unassociated).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("imports a legacy empty-history export as unavailable evidence", async () => {
    const dir = tmpDir();
    const db = join(dir, "agentlens.db");
    const legacy = writeHistory(dir, "legacy", {
      schema: "relay.effect-history/1",
      histories: [
        {
          record: {
            id: "eff-legacy",
            key: "counter-increment:probe-success-52c03b40",
            kind: "mcp:counter-increment",
            status: "PREPARED",
            createdAt: 1,
            updatedAt: 1,
          },
          events: [],
          coverage: "unavailable",
        },
      ],
    });
    await runCli([
      "import",
      sessionFile("success"),
      "--db",
      db,
      "--format",
      "pi",
      "--relay-history",
      legacy,
    ]);
    const store = SqliteTraceStore.openReadOnly(db);
    try {
      const run = must(store.listRuns()[0], "run");
      const out = await runCli(["inspect", run.id, "--db", db]);
      expect(out).toContain("PREPARED (unavailable history)");
      expect(out).toContain("history unavailable");
      expect(out).toContain("not backfilled");
    } finally {
      store.close();
    }
  });

  it("leaves inspect output unchanged for runs imported without a sidecar", async () => {
    const dir = tmpDir();
    const db = await importPi(dir, "success");
    const store = SqliteTraceStore.openReadOnly(db);
    try {
      const run = must(store.listRuns()[0], "run");
      const out = await runCli(["inspect", run.id, "--db", db]);
      expect(out).not.toContain("Relay effect evidence");
      const json = JSON.parse(
        await runCli(["inspect", run.id, "--db", db, "--json"]),
      ) as { relayEvidence: unknown };
      expect(json.relayEvidence).toBeNull();
    } finally {
      store.close();
    }
  });

  it("emits JSON for inspect and diff covering evidence states", async () => {
    const dir = tmpDir();
    const db = await importPi(dir, "success", "success");
    await runCli([
      "import",
      sessionFile("ambiguous"),
      "--db",
      db,
      "--format",
      "pi",
      "--relay-history",
      historyFile("ambiguous"),
    ]);
    const store = SqliteTraceStore.openReadOnly(db);
    try {
      const ids = store.listRunIds();
      const inspectJson = JSON.parse(
        await runCli(["inspect", must(ids[0], "run id"), "--db", db, "--json"]),
      ) as {
        schema: string;
        relayEvidence: {
          effects: { latestStatus: string; coverage: string }[];
          calls: { kind: string }[];
          provenance: { historySha256: string };
        };
      };
      expect(inspectJson.schema).toBe("agentlens.inspect/1");
      expect(inspectJson.relayEvidence.effects[0]?.latestStatus).toBe(
        "CONFIRMED",
      );
      expect(inspectJson.relayEvidence.calls[0]?.kind).toBe("matched");

      const diffJson = JSON.parse(
        await runCli([
          "diff",
          must(ids[0], "run id"),
          must(ids[1], "run id"),
          "--db",
          db,
          "--json",
        ]),
      ) as {
        schema: string;
        relayEvidence: {
          a: { effects: { latestStatus: string }[] };
          b: { effects: { latestStatus: string }[] };
        };
      };
      expect(diffJson.schema).toBe("agentlens.diff/1");
      expect(diffJson.relayEvidence.a.effects[0]?.latestStatus).toBe(
        "CONFIRMED",
      );
      expect(diffJson.relayEvidence.b.effects[0]?.latestStatus).toBe("UNKNOWN");

      const text = await runCli([
        "diff",
        must(ids[0], "run id"),
        must(ids[1], "run id"),
        "--db",
        db,
      ]);
      expect(text).toContain("Relay effect evidence");
      expect(text).toContain("CONFIRMED (observed");
      expect(text).toContain("UNKNOWN (observed");
    } finally {
      store.close();
    }
  });

  it("leaves input files byte-identical (sha256 and mtime) after import/inspect/diff", async () => {
    const dir = tmpDir();
    const inputs = [sessionFile("success"), historyFile("success")];
    const before = inputs.map((p) => ({
      sha: sha256(p),
      mtime: statSync(p).mtimeMs,
    }));
    const db = await importPi(dir, "success", "success");
    const store = SqliteTraceStore.openReadOnly(db);
    const runId = must(store.listRunIds()[0], "run id");
    store.close();
    await runCli(["inspect", runId, "--db", db]);
    await runCli(["inspect", runId, "--db", db, "--json"]);
    inputs.forEach((p, i) => {
      expect(sha256(p)).toBe(must(before[i], "hash").sha);
      expect(statSync(p).mtimeMs).toBe(must(before[i], "hash").mtime);
    });
  });

  it("exposes a relay detail tab and evidence diff section to the TUI model", async () => {
    const dir = tmpDir();
    const db = await importPi(dir, "ambiguous", "ambiguous");
    const store = SqliteTraceStore.openReadOnly(db);
    try {
      const run = must(store.listRuns()[0], "run");
      const evidence = store.getRelayEvidence(run.id);
      const items = detailItems(run, "relay", evidence);
      const text = items.map((i) => i.summary).join("\n");
      expect(text).toContain("Relay effect evidence");
      expect(text).toContain("UNKNOWN (observed history)");
      expect(items[0]?.section).toBe(true);

      const noEvidence = detailItems(run, "relay", undefined);
      expect(noEvidence[0]?.summary).toContain("no relay effect evidence");
    } finally {
      store.close();
    }
  });
});
