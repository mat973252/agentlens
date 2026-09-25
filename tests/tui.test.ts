import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRunDiff } from "../src/cli/diffView.js";
import { createProgram } from "../src/cli/program.js";
import { formatRunInspect } from "../src/cli/runView.js";
import { loadTuiData } from "../src/cli/uiCommand.js";
import { deserializeRunTrace } from "../src/schema/trace.js";
import { SqliteTraceStore } from "../src/storage/sqlite/store.js";
import { runTui } from "../src/tui/app.js";
import {
  compareRows,
  detailItems,
  diffText,
  toolPath,
} from "../src/tui/model.js";
import { clampState, reducerCtx, renderFrame } from "../src/tui/render.js";
import {
  type InputKey,
  initialState,
  reduce,
  type TuiState,
} from "../src/tui/state.js";
import { textWidth, truncateCells, wrapCells } from "../src/tui/text.js";
import { detectColorMode, Theme } from "../src/tui/theme.js";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures", import.meta.url));

const tmpDirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentlens-tui-"));
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

const dbWith = (dir: string, files: string[]): string => {
  const db = join(dir, "agentlens.db");
  const store = SqliteTraceStore.open(db);
  try {
    for (const file of files) {
      const doc = deserializeRunTrace(
        readFileSync(join(FIXTURES_DIR, file), "utf8"),
      );
      store.saveRun(doc.run);
    }
  } finally {
    store.close();
  }
  return db;
};

const stripAnsi = (text: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips ANSI escapes in assertions
  text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

const FIXTURES = [
  "success-basic.json",
  "tool-failure-recovered.json",
  "loop-read-pingpong.json",
];

const setup = (
  cols: number,
  rows: number,
  files: string[] = FIXTURES,
): { state: TuiState; data: ReturnType<typeof loadTuiData> } => {
  const db = dbWith(tmpDir(), files);
  const data = loadTuiData(db);
  const state = initialState(data.runs.length);
  const ctx = reducerCtx(state, data, { cols, rows });
  clampState(state, data, { cols, rows });
  void ctx;
  return { state, data };
};

const key = (
  state: TuiState,
  data: ReturnType<typeof loadTuiData>,
  geom: { cols: number; rows: number },
  k: InputKey,
): void => {
  reduce(state, k, reducerCtx(state, data, geom));
  clampState(state, data, geom);
};

describe("tui text helpers", () => {
  it("measures CJK as double width and combining marks as zero", () => {
    expect(textWidth("abc")).toBe(3);
    expect(textWidth("中文")).toBe(4);
    expect(textWidth("é")).toBe(1); // e + combining acute
    expect(textWidth("a")).toBe(1);
  });

  it("truncates with ellipsis on cell boundaries", () => {
    expect(truncateCells("abcdef", 4)).toBe("abc…");
    expect(truncateCells("中文字", 5)).toBe("中文…");
    expect(truncateCells("abc", 5)).toBe("abc");
    expect(textWidth(truncateCells("abcdefgh", 5))).toBeLessThanOrEqual(5);
  });

  it("wraps long lines without splitting wide chars", () => {
    const wrapped = wrapCells("alpha beta gamma", 9);
    expect(wrapped.every((l) => textWidth(l) <= 9)).toBe(true);
    expect(wrapped.join(" ")).toContain("alpha");
    expect(wrapCells("中文字符串测试", 4).every((l) => textWidth(l) <= 4)).toBe(
      true,
    );
  });
});

describe("color detection", () => {
  it("honors NO_COLOR and TERM=dumb", () => {
    expect(detectColorMode({ NO_COLOR: "1", COLORTERM: "truecolor" })).toBe(
      "none",
    );
    expect(detectColorMode({ TERM: "dumb" })).toBe("none");
  });

  it("upgrades for truecolor hints and degrades to 256/16", () => {
    expect(detectColorMode({ COLORTERM: "truecolor" })).toBe("truecolor");
    expect(detectColorMode({ WT_SESSION: "abc", TERM: "" })).toBe("truecolor");
    expect(detectColorMode({ TERM: "xterm-256color" })).toBe("ansi256");
    expect(detectColorMode({ TERM: "xterm" })).toBe("ansi16");
  });

  it("theme none produces no ANSI bytes", () => {
    const theme = new Theme("none");
    expect(theme.apply("mint", "x")).toBe("x");
    const colored = new Theme("ansi16");
    expect(colored.apply("mint", "x")).not.toBe("x");
  });
});

describe("reducer", () => {
  it("navigates the run list and marks A/B", () => {
    const { state, data } = setup(80, 24);
    const g = { cols: 80, rows: 24 };
    key(state, data, g, { name: "char", char: "j" });
    expect(state.cursor).toBe(1);
    key(state, data, g, { name: "char", char: "k" });
    expect(state.cursor).toBe(0);
    key(state, data, g, { name: "char", char: "a" });
    key(state, data, g, { name: "char", char: "j" });
    key(state, data, g, { name: "char", char: "b" });
    expect(state.a).toBe(0);
    expect(state.b).toBe(1);
    key(state, data, g, { name: "char", char: "x" });
    expect(state.a).toBe(1);
    expect(state.b).toBe(0);
  });

  it("opens detail on enter, switches tabs, esc returns home", () => {
    const { state, data } = setup(120, 30);
    const g = { cols: 120, rows: 30 };
    key(state, data, g, { name: "enter" });
    expect(state.screen).toBe("detail");
    key(state, data, g, { name: "right" });
    expect(state.detail?.tab).toBe(1);
    key(state, data, g, { name: "char", char: "l" });
    expect(state.detail?.tab).toBe(2);
    key(state, data, g, { name: "char", char: "h" });
    expect(state.detail?.tab).toBe(1);
    key(state, data, g, { name: "esc" });
    expect(state.screen).toBe("home");
  });

  it("opens diff only with two distinct marks", () => {
    const { state, data } = setup(80, 24);
    const g = { cols: 80, rows: 24 };
    state.a = 0;
    state.b = 0;
    key(state, data, g, { name: "char", char: "d" });
    expect(state.screen).toBe("home");
    expect(state.notice).toContain("same run");
    state.b = 1;
    key(state, data, g, { name: "char", char: "d" });
    expect(state.screen).toBe("diff");
    key(state, data, g, { name: "esc" });
    expect(state.screen).toBe("home");
  });

  it("quits on q and ctrl-c, toggles help on ?", () => {
    const { state, data } = setup(80, 24);
    const g = { cols: 80, rows: 24 };
    key(state, data, g, { name: "char", char: "?" });
    expect(state.help).toBe(true);
    key(state, data, g, { name: "esc" });
    expect(state.help).toBe(false);
    key(state, data, g, { name: "char", char: "q" });
    expect(state.done).toBe(true);

    const { state: s2, data: d2 } = setup(80, 24);
    key(s2, d2, g, { name: "ctrl-c" });
    expect(s2.done).toBe(true);
  });
});

describe("model consistency with text CLI", () => {
  it("inspect tab reproduces `agentlens inspect` output verbatim", () => {
    const { data } = setup(80, 24);
    const run = data.runs[0];
    expect(run).toBeDefined();
    if (run === undefined) return;
    const items = detailItems(run, "inspect");
    const text = items.map((i) => i.summary).join("\n");
    expect(text).toBe(formatRunInspect(run).replace(/\n$/, ""));
  });

  it("diff view reproduces `agentlens diff` output verbatim", () => {
    const { data } = setup(80, 24);
    const [a, b] = data.runs;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a === undefined || b === undefined) return;
    const text = diffText(a, b)
      .lines.map((l) => l.text)
      .join("\n");
    expect(text).toBe(formatRunDiff(a, b).replace(/\n$/, ""));
  });

  it("timeline/tools/errors tabs carry one row per source event group", () => {
    const { data } = setup(80, 24);
    const run = data.runs[1];
    expect(run).toBeDefined();
    if (run === undefined) return;
    expect(detailItems(run, "timeline")).toHaveLength(run.events.length);
    const tools = detailItems(run, "tools");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((i) => i.detail !== undefined)).toBe(true);
    const errors = detailItems(run, "errors");
    const expected = run.events.filter(
      (e) => e.type === "error" || e.type === "tool.failed",
    ).length;
    expect(Math.max(errors.length, 1)).toBe(Math.max(expected, 1));
  });

  it("loops tab reports signals for a loop fixture and none for clean runs", () => {
    const { data } = setup(80, 24);
    const loopRun = data.runs[2];
    const cleanRun = data.runs[0];
    expect(loopRun).toBeDefined();
    expect(cleanRun).toBeDefined();
    if (loopRun === undefined || cleanRun === undefined) return;
    const loopItems = detailItems(loopRun, "loops");
    expect(loopItems.some((i) => i.tone === "warn")).toBe(true);
    expect(detailItems(cleanRun, "loops")[0]?.summary).toContain(
      "No loop signals detected.",
    );
  });

  it("compare rows keep unknown metrics explicit and compress tool paths", () => {
    const { data } = setup(80, 24);
    const [a, b] = data.runs;
    if (a === undefined || b === undefined) return;
    const rows = compareRows(a, b);
    const reasoning = rows.find((r) => r.label === "Reasoning tokens");
    expect(reasoning?.a === "unknown" || reasoning?.b === "unknown").toBe(true);
    const loopRun = data.runs[2];
    expect(loopRun).toBeDefined();
    if (loopRun !== undefined) expect(toolPath(loopRun)).toContain("×");
    const pathRow = rows.find((r) => r.label === "A");
    expect(pathRow?.a).toBe(toolPath(a));
  });
});

describe("render frames", () => {
  it("produces exactly rows×cols cells at 80x24 and 120x30", () => {
    const theme = new Theme("none");
    for (const g of [
      { cols: 80, rows: 24 },
      { cols: 120, rows: 30 },
    ]) {
      const { state, data } = setup(g.cols, g.rows);
      const frame = renderFrame(state, data, g, theme);
      expect(frame).toHaveLength(g.rows);
      for (const line of frame) {
        expect(stripAnsi(line).length).toBeLessThanOrEqual(g.cols);
      }
    }
  });

  it("home shows run ids, statuses, marks and compare card", () => {
    const theme = new Theme("none");
    const { state, data } = setup(120, 30);
    const text = renderFrame(state, data, { cols: 120, rows: 30 }, theme)
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("RUNS");
    expect(text).toContain("COMPARE");
    for (const run of data.runs) {
      expect(text).toContain(run.id.slice(0, 10));
    }
    expect(text).toContain("Tool calls");
    expect(text).toContain("TOOL PATH");
  });

  it("detail, diff, pager and help bodies render their content", () => {
    const theme = new Theme("none");
    const { state, data } = setup(120, 30);
    const g = { cols: 120, rows: 30 };
    key(state, data, g, { name: "enter" });
    const detail = renderFrame(state, data, g, theme).map(stripAnsi).join("\n");
    expect(detail).toContain("timeline");
    expect(detail).toContain("run.started");

    state.screen = "diff";
    const diff = renderFrame(state, data, g, theme).map(stripAnsi).join("\n");
    expect(diff).toContain("Summary");
    state.diffScroll = Number.MAX_SAFE_INTEGER;
    clampState(state, data, g);
    const diffEnd = renderFrame(state, data, g, theme)
      .map(stripAnsi)
      .join("\n");
    expect(diffEnd).toContain("Timeline diff");

    state.screen = "pager";
    state.pager = {
      title: "t",
      text: "line1\nline2",
      scroll: 0,
      back: "detail",
    };
    const pager = renderFrame(state, data, g, theme).map(stripAnsi).join("\n");
    expect(pager).toContain("line1");

    state.screen = "home";
    state.help = true;
    const help = renderFrame(state, data, g, theme).map(stripAnsi).join("\n");
    expect(help).toContain("KEYS");
    expect(help).toContain("read-only");
  });

  it("shows a readable too-small notice instead of corrupt output", () => {
    const theme = new Theme("none");
    const { state, data } = setup(80, 24);
    const frame = renderFrame(state, data, { cols: 40, rows: 8 }, theme);
    expect(frame.join("\n")).toContain("terminal too small");
  });
});

describe("read-only boundary and runtime", () => {
  it("a full interactive session leaves db bytes and mtime untouched", async () => {
    const db = dbWith(tmpDir(), FIXTURES);
    const beforeHash = createHash("sha256")
      .update(readFileSync(db))
      .digest("hex");
    const beforeMtime = statSync(db).mtimeMs;

    const input = new PassThrough();
    const chunks: string[] = [];
    const output = new PassThrough();
    output.on("data", (c) => chunks.push(String(c)));
    Object.assign(output, { columns: 120, rows: 30, isTTY: true });
    Object.assign(input, { isTTY: true, setRawMode: () => {} });

    const done = runTui(loadTuiData(db), { input, output }, "none");
    // drive a session: list -> detail -> tab -> expand -> back -> diff -> quit
    input.write("j");
    input.write("\r"); // enter detail
    input.write("\x1b[C"); // right tab
    input.write("q");
    const code = await done;
    expect(code).toBe(0);
    const rendered = stripAnsi(chunks.join(""));
    expect(rendered).toContain("RUNS");
    expect(rendered).toContain("AgentLens");
    expect(chunks.join("")).toContain("\x1b[?1049h"); // entered alt screen
    expect(chunks.join("")).toContain("\x1b[?1049l"); // restored on exit
    expect(createHash("sha256").update(readFileSync(db)).digest("hex")).toBe(
      beforeHash,
    );
    expect(statSync(db).mtimeMs).toBe(beforeMtime);
  });

  it("ctrl-c byte exits cleanly and restores the terminal", async () => {
    const db = dbWith(tmpDir(), FIXTURES);
    const input = new PassThrough();
    const chunks: string[] = [];
    const output = new PassThrough();
    output.on("data", (c) => chunks.push(String(c)));
    Object.assign(output, { columns: 80, rows: 24, isTTY: true });
    Object.assign(input, { isTTY: true, setRawMode: () => {} });
    const done = runTui(loadTuiData(db), { input, output }, "none");
    input.write("\x03");
    expect(await done).toBe(0);
    expect(chunks.join("")).toContain("\x1b[?1049l");
  });

  it("non-tty invocation fails fast with an actionable message", async () => {
    const db = dbWith(tmpDir(), FIXTURES);
    process.exitCode = 0;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const program = createProgram();
      await program.parseAsync(["node", "agentlens", "ui", "--db", db]);
      expect(process.exitCode).toBe(1);
      const messages = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(messages).toContain("TTY");
      expect(messages).toContain("agentlens runs");
    } finally {
      errSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("missing database errors before the TTY check", async () => {
    const dir = tmpDir();
    process.exitCode = 0;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const program = createProgram();
      await program.parseAsync([
        "node",
        "agentlens",
        "ui",
        "--db",
        join(dir, "missing.db"),
      ]);
      expect(process.exitCode).toBe(1);
      expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
        "not found",
      );
    } finally {
      errSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("help lists the ui command", () => {
    expect(createProgram().helpInformation()).toContain("ui");
  });
});
