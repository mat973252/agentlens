import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Recorder } from "../src/core/recorder.js";
import { parseRelayHistoryExport } from "../src/core/relayEvidence.js";
import { SqliteTraceStore } from "../src/storage/sqlite/store.js";

const directories: string[] = [];
function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "agentlens-incremental-"));
  directories.push(directory);
  return join(directory, "trace.db");
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("incremental Recorder", () => {
  it("reads one committed snapshot when another connection finishes between queries", () => {
    const path = databasePath();
    const writer = SqliteTraceStore.open(path);
    writer.database.exec("PRAGMA journal_mode = WAL");
    const run = new Recorder({
      store: writer,
      persistence: "incremental",
    }).startRun();
    const before = run.toRun();
    const reader = SqliteTraceStore.openReadOnly(path);
    const prepare = reader.database.prepare.bind(reader.database);
    let finished = false;
    const spy = vi
      .spyOn(reader.database, "prepare")
      .mockImplementation((sql) => {
        if (!finished && sql.includes("FROM events WHERE run_id")) {
          finished = true;
          run.completeRun({ inputTokens: 7 });
        }
        return prepare(sql);
      });
    try {
      expect(reader.getRun(run.id)).toEqual(before);
      expect(finished).toBe(true);
      expect(reader.getRun(run.id)).toEqual(run.toRun());
    } finally {
      spy.mockRestore();
      reader.close();
      writer.close();
    }
  });

  it("releases failed reads without committing a caller's transaction", () => {
    const store = SqliteTraceStore.open(":memory:");
    try {
      const run = new Recorder({
        store,
        persistence: "incremental",
      }).startRun();
      expect(() => store.getRun("missing")).toThrow(/Run not found/);
      store.database.exec("BEGIN");
      store.database
        .prepare("UPDATE runs SET agent = 'uncommitted' WHERE id = ?")
        .run(run.id);
      expect(store.getRun(run.id).agent).toBe("uncommitted");
      expect(() => store.getRun("missing")).toThrow(/Run not found/);
      store.database.exec("ROLLBACK");
      expect(store.getRun(run.id).agent).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("does not let returned event objects change an already committed prefix", () => {
    const store = SqliteTraceStore.open(":memory:");
    try {
      const run = new Recorder({
        store,
        persistence: "incremental",
      }).startRun();
      const emitted = run.emit("message.output", { text: "original" });
      emitted.data = "changed through emit";
      const snapshot = run.events;
      const first = snapshot[1];
      if (first) first.data = "changed through events";
      const finished = run.completeRun();
      expect(finished.events[1]?.data).toEqual({ text: "original" });
      expect(store.getRun(run.id)).toEqual(finished);
    } finally {
      store.close();
    }
  });

  it("does not leave a partial run when start is rejected", () => {
    const store = SqliteTraceStore.open(":memory:");
    try {
      store.database.exec(
        "CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'start rejected'); END;",
      );
      expect(() =>
        new Recorder({ store, persistence: "incremental" }).startRun({
          id: "retry-start",
        }),
      ).toThrow(/start rejected/);
      expect(store.listRunIds()).toEqual([]);
      store.database.exec("DROP TRIGGER reject_event");
      const run = new Recorder({ store, persistence: "incremental" }).startRun({
        id: "retry-start",
      });
      expect(store.getRun(run.id).events).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("rejects stale writers and keeps their in-memory prefix unchanged", () => {
    const store = SqliteTraceStore.open(":memory:");
    try {
      const run = new Recorder({
        store,
        persistence: "incremental",
      }).startRun();
      const before = run.toRun();
      store.appendRunEvent(
        {
          id: "external",
          runId: run.id,
          timestamp: before.startedAt,
          type: "message.output",
          data: null,
        },
        1,
      );
      expect(() => run.emit("message.output", "stale")).toThrow(
        /event count changed/,
      );
      expect(run.toRun()).toEqual(before);
      expect(store.getRun(run.id).events).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("preserves attached UNKNOWN Relay evidence while appending and completing", () => {
    const store = SqliteTraceStore.open(":memory:");
    try {
      const run = new Recorder({ store }).startRun();
      const history = readFileSync(
        new URL(
          "../fixtures/pi-relay/relay-history-ambiguous.json",
          import.meta.url,
        ),
        "utf8",
      );
      store.saveRun(run.toRun(), {
        exportDoc: parseRelayHistoryExport(history),
        sessionSha256: "a".repeat(64),
        historySha256: "b".repeat(64),
        importedAt: run.toRun().startedAt,
      });
      const evidence = store.getRelayEvidence(run.id);
      expect(evidence?.histories[0]?.record.status).toBe("UNKNOWN");
      const event = run.emit("message.output", "done");
      store.appendRunEvent(event, 1);
      const terminal = {
        ...event,
        id: "terminal",
        type: "run.completed",
        data: null,
      };
      store.appendRunEvent(terminal, 2, {
        endedAt: event.timestamp,
        metrics: { toolCalls: 0, failedToolCalls: 0 },
      });
      expect(store.getRun(run.id).status).toBe("passed");
      expect(store.getRelayEvidence(run.id)).toEqual(evidence);
      expect(() => store.appendRunEvent({ ...event, id: "late" }, 3)).toThrow(
        /not running/,
      );
      expect(() => store.saveRun(run.toRun())).toThrow();
      expect(store.getRelayEvidence(run.id)).toEqual(evidence);
    } finally {
      store.close();
    }
  });

  it("keeps the default terminal-only behavior and requires an incremental store when opted in", () => {
    const store = SqliteTraceStore.open(":memory:");
    try {
      new Recorder({ store }).startRun();
      expect(store.listRunIds()).toEqual([]);
      expect(
        () =>
          new Recorder({ store: { saveRun() {} }, persistence: "incremental" }),
      ).toThrow(/appendRunEvent/);
    } finally {
      store.close();
    }
  });

  it("commits ordered running events and completes without rewriting earlier events", () => {
    const store = SqliteTraceStore.open(":memory:");
    try {
      const run = new Recorder({ store, persistence: "incremental" }).startRun({
        id: "live",
      });
      expect(store.getRun(run.id).events).toHaveLength(1);
      store.database.exec(`
        CREATE TRIGGER no_event_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'event rewritten'); END;
        CREATE TRIGGER no_event_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'event deleted'); END;
      `);
      const started = run.emit("tool.started", { tool: "read" });
      const completed = run.emit(
        "tool.completed",
        { tool: "read", success: true },
        { parentId: started.id },
      );
      const summary = run.emit("message.output", "result", {
        parentId: completed.id,
      });
      run.emit(
        "artifact.created",
        { path: "result.txt" },
        { parentId: summary.id },
      );
      expect(store.getRun(run.id)).toMatchObject({
        status: "running",
        metrics: { toolCalls: 1, failedToolCalls: 0 },
      });
      const finished = run.completeRun({ inputTokens: 7 });
      expect(store.getRun(run.id)).toEqual(finished);
      expect(finished.events).toHaveLength(6);
      expect(() =>
        new Recorder({ store, persistence: "incremental" }).startRun({
          id: "live",
        }),
      ).toThrow();
      expect(store.getRun(run.id)).toEqual(finished);
    } finally {
      store.close();
    }
  });

  it("rolls back a rejected append and terminal write before changing memory", () => {
    const store = SqliteTraceStore.open(":memory:");
    try {
      const run = new Recorder({
        store,
        persistence: "incremental",
      }).startRun();
      const before = store.getRun(run.id);
      store.database.exec(
        "CREATE TRIGGER reject_update BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
      );
      expect(() => run.emit("message.output", "must roll back")).toThrow(
        /disk failure/,
      );
      expect(run.toRun()).toEqual(before);
      expect(store.getRun(run.id)).toEqual(before);
      expect(() => run.completeRun()).toThrow(/disk failure/);
      expect(run.status).toBe("active");
      expect(store.getRun(run.id)).toEqual(before);
      store.database.exec("DROP TRIGGER reject_update");
      run.emit("message.output", "retry");
      const finished = run.failRun("finished with error");
      expect(store.getRun(run.id)).toEqual(finished);
      expect(store.getRun(run.id).events).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  it("rejects duplicate IDs and invalid tool relationships before committing them", () => {
    const store = SqliteTraceStore.open(":memory:");
    try {
      const run = new Recorder({
        store,
        persistence: "incremental",
      }).startRun();
      const tool = run.emit("tool.started", { tool: "read" }, { id: "tool" });
      const before = store.getRun(run.id);
      expect(() =>
        run.emit("message.output", "duplicate", { id: tool.id }),
      ).toThrow();
      expect(() =>
        run.emit("tool.completed", { tool: "read", success: true }),
      ).toThrow(/parentId/);
      expect(() =>
        run.emit(
          "tool.completed",
          { tool: "other", success: true },
          { parentId: tool.id },
        ),
      ).toThrow();
      expect(() =>
        run.emit(
          "tool.failed",
          { tool: "read", success: true },
          { parentId: tool.id },
        ),
      ).toThrow();
      expect(run.toRun()).toEqual(before);
      expect(store.getRun(run.id)).toEqual(before);
    } finally {
      store.close();
    }
  });

  it.each([
    { phase: "before-start", count: 0 },
    { phase: "after-start", count: 1 },
    { phase: "after-tool-return", count: 3 },
    { phase: "before-finish", count: 21 },
  ])(
    "reads the committed prefix after killing at $phase",
    async ({ phase, count }) => {
      const path = databasePath();
      const source = `
      import { Recorder, SqliteTraceStore } from './src/index.ts';
      import { writeFileSync } from 'node:fs';
      const store = SqliteTraceStore.open(${JSON.stringify(path)});
      const phase = ${JSON.stringify(phase)};
      if (phase !== 'before-start') {
        const run = new Recorder({ store, persistence: 'incremental' }).startRun({ id: 'killed' });
        if (phase === 'after-tool-return') {
          const started = run.emit('tool.started', { tool: 'local-write' });
          writeFileSync(${JSON.stringify(`${path}.effect`)}, 'one local effect');
          run.emit('tool.completed', { tool: 'local-write', success: true }, { parentId: started.id });
        }
        if (phase === 'before-finish') for (let i = 0; i < 20; i++) run.emit('message.output', { index: i });
      }
      process.send('committed');
      setInterval(() => {}, 1000);
    `;
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", source],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      const exited = once(child, "exit");
      let errors = "";
      child.stderr?.on("data", (chunk) => {
        errors += String(chunk);
      });
      try {
        const [message] = await once(child, "message", {
          signal: AbortSignal.timeout(15_000),
        });
        expect(message, errors).toBe("committed");
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
      const reader = SqliteTraceStore.openReadOnly(path);
      try {
        if (phase === "before-start") {
          expect(reader.listRunIds()).toEqual([]);
          return;
        }
        const run = reader.getRun("killed");
        expect(run.status).toBe("running");
        expect(run.endedAt).toBeUndefined();
        expect(run.events).toHaveLength(count);
        if (phase === "before-finish") {
          expect(run.events.slice(1).map((event) => event.data)).toEqual(
            Array.from({ length: 20 }, (_, index) => ({ index })),
          );
        }
        if (phase === "after-tool-return") {
          expect(run.events.map((event) => event.type)).toEqual([
            "run.started",
            "tool.started",
            "tool.completed",
          ]);
          expect(readFileSync(`${path}.effect`, "utf8")).toBe(
            "one local effect",
          );
          expect(reader.getRun("killed")).toEqual(run);
          expect(readFileSync(`${path}.effect`, "utf8")).toBe(
            "one local effect",
          );
        }
      } finally {
        reader.close();
      }
    },
    20_000,
  );
});
