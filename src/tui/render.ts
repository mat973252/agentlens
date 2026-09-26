import { durationOf, formatDurationMs } from "../cli/eventDetails.js";
import type { Run } from "../core/run.js";
import {
  type CompareRow,
  compareRows,
  DETAIL_TABS,
  detailItems,
  diffText,
  type Item,
  runSummaryStrip,
  type TuiData,
} from "./model.js";
import type { ReducerCtx, TuiState } from "./state.js";
import { sanitize, textWidth, truncateCells, wrapCells } from "./text.js";
import type { Theme, Token } from "./theme.js";

/**
 * Frame renderer: (state, data, geometry) -> one styled string per row,
 * each exactly `cols` display cells wide. Pure and synchronous so tests
 * can snapshot frames at any size; the runtime just writes them.
 */

interface Seg {
  t: string;
  s?: Token;
}

const WIDE_MIN = 110;
const MIN_COLS = 50;
const MIN_ROWS = 12;

export interface Geom {
  cols: number;
  rows: number;
}

const bodyRows = (geom: Geom): number => Math.max(0, geom.rows - 3);

const STATUS_GLYPH: Record<Run["status"], { glyph: string; tone: Token }> = {
  passed: { glyph: "●", tone: "good" },
  failed: { glyph: "✗", tone: "bad" },
  running: { glyph: "◐", tone: "warn" },
  cancelled: { glyph: "○", tone: "faint" },
};

const statusTone = (run: Run): Token => STATUS_GLYPH[run.status].tone;

/** Cuts text to `max` cells keeping the *end* (for paths). */
const truncateLeft = (text: string, max: number): string => {
  if (max <= 0) return "";
  if (textWidth(text) <= max) return text;
  let width = 0;
  let out = "";
  const segments = [...text];
  for (let i = segments.length - 1; i >= 0; i--) {
    const ch = segments[i] ?? "";
    const w = textWidth(ch);
    if (width + w > max - 1) break;
    out = ch + out;
    width += w;
  }
  return `…${out}`;
};

/** Composes one row of styled text padded/cut to exactly `width` cells. */
function compose(segs: Seg[], width: number, theme: Theme): string {
  let out = "";
  let used = 0;
  for (const seg of segs) {
    const remaining = width - used;
    if (remaining <= 0) break;
    const clean = sanitize(seg.t);
    const piece =
      textWidth(clean) <= remaining ? clean : truncateCells(clean, remaining);
    out += seg.s !== undefined ? theme.apply(seg.s, piece) : piece;
    used += textWidth(piece);
  }
  if (used < width) out += " ".repeat(width - used);
  return out;
}

// ---------- shared layout ----------

interface HomeGeom {
  body: number;
  wide: boolean;
  listWidth: number;
  listRows: number;
  compareWidth: number;
  compareVisible: number;
}

function homeGeom(geom: Geom): HomeGeom {
  const body = bodyRows(geom);
  const wide = geom.cols >= WIDE_MIN;
  if (wide) {
    const listWidth = Math.min(66, Math.floor(geom.cols * 0.52));
    return {
      body,
      wide,
      listWidth,
      listRows: body,
      compareWidth: geom.cols - listWidth - 1,
      compareVisible: body,
    };
  }
  const listRows = Math.max(4, Math.floor(body * 0.5));
  return {
    body,
    wide,
    listWidth: geom.cols,
    listRows,
    compareWidth: geom.cols,
    compareVisible: Math.max(0, body - listRows - 1),
  };
}

const DETAIL_STRIP_ROWS = 4; // summary(2) + tabs(1) + rule gap(1)

const detailGeom = (geom: Geom) => {
  const body = bodyRows(geom);
  const wide = geom.cols >= WIDE_MIN;
  const items = Math.max(0, body - DETAIL_STRIP_ROWS);
  const listWidth = wide ? Math.floor(geom.cols * 0.46) : geom.cols;
  const previewWidth = wide ? geom.cols - listWidth - 1 : 0;
  return { body, wide, items, listWidth, previewWidth };
};

const wrapCache = new Map<string, string[]>();
const wrapCached = (text: string, width: number): string[] => {
  const key = `${width}:${text}`;
  const hit = wrapCache.get(key);
  if (hit !== undefined) return hit;
  const lines = wrapCells(text, width);
  wrapCache.set(key, lines);
  if (wrapCache.size > 64) {
    const first = wrapCache.keys().next().value;
    if (first !== undefined) wrapCache.delete(first);
  }
  return lines;
};

// ---------- content accessors shared by clamp + render + app ----------

export function currentDetailItems(state: TuiState, data: TuiData): Item[] {
  const d = state.detail;
  if (d === null) return [];
  const run = data.runs[d.runIndex];
  if (run === undefined) return [];
  return detailItems(
    run,
    DETAIL_TABS[d.tab] ?? "timeline",
    data.evidence.get(run.id),
  );
}

export function currentDiffLines(
  state: TuiState,
  data: TuiData,
): { text: string; section: boolean }[] {
  const a = state.a !== null ? data.runs[state.a] : undefined;
  const b = state.b !== null ? data.runs[state.b] : undefined;
  if (a === undefined || b === undefined) return [];
  return diffText(a, b, data.evidence.get(a.id), data.evidence.get(b.id)).lines;
}

export function currentPagerLines(state: TuiState, geom: Geom): string[] {
  if (state.pager === null) return [];
  return wrapCached(state.pager.text, geom.cols);
}

export function reducerCtx(
  state: TuiState,
  data: TuiData,
  geom: Geom,
): ReducerCtx {
  const sections: number[] = [];
  if (state.screen === "diff") {
    currentDiffLines(state, data).forEach((l, i) => {
      if (l.section) sections.push(i);
    });
  } else if (state.screen === "detail" && state.detail !== null) {
    const tab = DETAIL_TABS[state.detail.tab];
    if (tab === "inspect") {
      currentDetailItems(state, data).forEach((item, i) => {
        if (item.section) sections.push(i);
      });
    }
  }
  return {
    runCount: data.runs.length,
    bodyRows: bodyRows(geom),
    detailItemCount: currentDetailItems(state, data).length,
    sectionRows: sections,
  };
}

/** Clamps all cursor/scroll offsets against current content geometry. */
export function clampState(state: TuiState, data: TuiData, geom: Geom): void {
  const n = data.runs.length;
  state.cursor = Math.min(Math.max(state.cursor, 0), Math.max(0, n - 1));
  if (state.a !== null && state.a >= n) state.a = n - 1;
  if (state.b !== null && state.b >= n) state.b = n - 1;

  const hg = homeGeom(geom);
  const listVisible = Math.max(1, hg.listRows - 1); // minus "RUNS" header row
  // keep cursor visible in list viewport
  if (state.cursor < state.listScroll) state.listScroll = state.cursor;
  if (state.cursor >= state.listScroll + listVisible)
    state.listScroll = state.cursor - listVisible + 1;
  state.listScroll = Math.min(
    Math.max(state.listScroll, 0),
    Math.max(0, n - listVisible),
  );

  const a = state.a !== null ? (data.runs[state.a] ?? null) : null;
  const b = state.b !== null ? (data.runs[state.b] ?? null) : null;
  const compareContent = compareRows(a, b).length + 3; // header + section + hint
  state.compareScroll = Math.min(
    Math.max(state.compareScroll, 0),
    Math.max(0, compareContent - hg.compareVisible),
  );

  if (state.detail !== null) {
    const items = currentDetailItems(state, data);
    const dg = detailGeom(geom);
    state.detail.cursor = Math.min(
      Math.max(state.detail.cursor, 0),
      Math.max(0, items.length - 1),
    );
    if (state.detail.cursor < state.detail.scroll)
      state.detail.scroll = state.detail.cursor;
    if (state.detail.cursor >= state.detail.scroll + dg.items)
      state.detail.scroll = state.detail.cursor - dg.items + 1;
    state.detail.scroll = Math.min(
      Math.max(state.detail.scroll, 0),
      Math.max(0, items.length - dg.items),
    );
  }

  const diffMax = Math.max(
    0,
    currentDiffLines(state, data).length - bodyRows(geom),
  );
  state.diffScroll = Math.min(Math.max(state.diffScroll, 0), diffMax);

  if (state.pager !== null) {
    const total = currentPagerLines(state, geom).length;
    state.pager.scroll = Math.min(
      Math.max(state.pager.scroll, 0),
      Math.max(0, total - bodyRows(geom)),
    );
  }
}

// ---------- screen renderers ----------

const runRow = (
  run: Run,
  i: number,
  state: TuiState,
  width: number,
  theme: Theme,
): string => {
  const selected = state.focus === "list" && i === state.cursor;
  const tag = i === state.a ? "A" : i === state.b ? "B" : " ";
  const { glyph, tone } = STATUS_GLYPH[run.status];
  const duration = durationOf(run);
  const tools = `${run.metrics.toolCalls}${run.metrics.failedToolCalls > 0 ? `·${run.metrics.failedToolCalls}✗` : ""}`;
  const statusCol = run.status.padEnd(8);
  const durCol = (
    duration !== undefined ? formatDurationMs(duration) : "-"
  ).padEnd(6);
  const rightW =
    textWidth(statusCol) + textWidth(durCol) + textWidth(tools) + 3;
  const leftW = Math.max(4, width - rightW - 7);
  const id = truncateCells(run.id, leftW);
  const segs: Seg[] = [
    { t: i === state.cursor ? "›" : " ", s: "mint" },
    { t: " " },
    { t: tag, s: tag === " " ? undefined : "teal" },
    { t: " " },
    { t: glyph, s: tone },
    { t: " " },
    { t: id.padEnd(leftW), s: "paper" },
    { t: " " },
    { t: statusCol, s: tone },
    { t: " " },
    { t: durCol, s: "dim" },
    { t: " " },
    { t: tools, s: run.metrics.failedToolCalls > 0 ? "bad" : "dim" },
  ];
  if (selected) {
    const plain = segs.map((seg) => sanitize(seg.t)).join("");
    return compose([{ t: plain, s: "sel" }], width, theme);
  }
  return compose(segs, width, theme);
};

const LABEL_W = 17;

const compareRowLine = (
  row: CompareRow,
  width: number,
  theme: Theme,
): string => {
  if (row.section) {
    return compose([{ t: ` ${row.label}`, s: "faint" }], width, theme);
  }
  const valW = Math.max(8, Math.floor((width - LABEL_W - 4) / 3));
  return compose(
    [
      { t: ` ${row.label.padEnd(LABEL_W)}`, s: "dim" },
      { t: `${truncateCells(row.a, valW).padEnd(valW)} `, s: "paper" },
      { t: `${truncateCells(row.b, valW).padEnd(valW)} `, s: "paper" },
      { t: row.delta, s: "teal" },
    ],
    width,
    theme,
  );
};

function renderHomeBody(
  state: TuiState,
  data: TuiData,
  geom: Geom,
  theme: Theme,
): string[] {
  const hg = homeGeom(geom);
  const lines: string[] = [];
  const listRows: string[] = [];
  listRows.push(
    compose(
      [{ t: ` RUNS ${data.runs.length}`, s: "faint" }],
      hg.listWidth,
      theme,
    ),
  );
  if (data.runs.length === 0) {
    listRows.push(
      compose(
        [{ t: "  No runs recorded. Import one first:", s: "dim" }],
        hg.listWidth,
        theme,
      ),
      compose(
        [{ t: "  agentlens import <trace.jsonl>", s: "mint" }],
        hg.listWidth,
        theme,
      ),
    );
  }
  const start = state.listScroll;
  for (let i = 0; i < Math.max(0, hg.listRows - 1); i++) {
    const idx = start + i;
    const run = data.runs[idx];
    if (run === undefined) {
      listRows.push(" ".repeat(hg.listWidth));
      continue;
    }
    listRows.push(runRow(run, idx, state, hg.listWidth, theme));
  }

  // compare card
  const a = state.a !== null ? (data.runs[state.a] ?? null) : null;
  const b = state.b !== null ? (data.runs[state.b] ?? null) : null;
  const cmpRows = compareRows(a, b);
  const cmpLines: string[] = [];
  const cmpTitle =
    a !== null && b !== null
      ? ` COMPARE  A ${truncateCells(a.id, 18)} ⇄ B ${truncateCells(b.id, 18)}`
      : a !== null || b !== null
        ? " COMPARE  mark a second run: b"
        : " COMPARE  mark runs: a / b";
  cmpLines.push(
    compose(
      [
        { t: cmpTitle, s: "faint" },
        {
          t: state.focus === "compare" ? "  (focused)" : "",
          s: "teal",
        },
      ],
      hg.compareWidth,
      theme,
    ),
  );
  const body = cmpRows.flatMap((row) => {
    if (row.b === "" && !row.section) {
      // tool-path rows: the value wraps under the value column
      const valueCol = LABEL_W + 1;
      const wrapped = wrapCached(
        row.a,
        Math.max(4, hg.compareWidth - valueCol),
      );
      return wrapped.map((w, wi) =>
        compose(
          [
            { t: ` ${wi === 0 ? row.label : ""}`.padEnd(valueCol), s: "faint" },
            { t: w, s: "dim" },
          ],
          hg.compareWidth,
          theme,
        ),
      );
    }
    return [compareRowLine(row, hg.compareWidth, theme)];
  });
  cmpLines.push(...body);
  if (a !== null && b !== null && a !== b) {
    cmpLines.push(
      compose([{ t: " d for full diff", s: "faint" }], hg.compareWidth, theme),
    );
  }

  const cmpVisible = cmpLines.slice(
    state.compareScroll,
    state.compareScroll + hg.compareVisible,
  );
  if (hg.wide) {
    const rule = "│";
    for (let i = 0; i < hg.body; i++) {
      const left = listRows[i] ?? " ".repeat(hg.listWidth);
      const right = cmpVisible[i] ?? " ".repeat(hg.compareWidth);
      lines.push(`${left}${theme.apply("faint", rule)}${right}`);
    }
  } else {
    const rule = compose(
      [{ t: "─".repeat(geom.cols), s: "faint" }],
      geom.cols,
      theme,
    );
    lines.push(...listRows.slice(0, hg.listRows));
    lines.push(rule);
    lines.push(...cmpVisible.slice(0, hg.compareVisible));
  }
  return lines;
}

const TAB_LABELS: Record<string, string> = {
  timeline: "timeline",
  tools: "tools",
  errors: "errors",
  loops: "loops",
  relay: "relay",
  inspect: "inspect",
};

function renderDetailBody(
  state: TuiState,
  data: TuiData,
  geom: Geom,
  theme: Theme,
): string[] {
  const d = state.detail;
  const run = d !== null ? data.runs[d.runIndex] : undefined;
  const dg = detailGeom(geom);
  const lines: string[] = [];
  if (d === null || run === undefined) {
    lines.push(compose([{ t: " run not found", s: "bad" }], geom.cols, theme));
    return lines;
  }
  const strip = runSummaryStrip(run).split("\n");
  const tone = statusTone(run);
  lines.push(
    compose(
      [
        { t: ` ${STATUS_GLYPH[run.status].glyph} `, s: tone },
        { t: strip[0] ?? run.status, s: "paper" },
        { t: `  ${run.id}`, s: "dim" },
      ],
      geom.cols,
      theme,
    ),
  );
  lines.push(
    compose([{ t: `   ${strip[1] ?? ""}`, s: "dim" }], geom.cols, theme),
  );
  lines.push(
    compose([{ t: `   ${strip[2] ?? ""}`, s: "faint" }], geom.cols, theme),
  );
  const tabs: Seg[] = [{ t: "  ", s: undefined }];
  DETAIL_TABS.forEach((t, i) => {
    tabs.push({ t: ` ${TAB_LABELS[t] ?? t} `, s: i === d.tab ? "tab" : "dim" });
    tabs.push({ t: i < DETAIL_TABS.length - 1 ? "·" : "", s: "faint" });
  });
  lines.push(compose(tabs, geom.cols, theme));

  const items = currentDetailItems(state, data);
  const isInspect = (DETAIL_TABS[d.tab] ?? "timeline") === "inspect";
  const start = isInspect ? d.scroll : d.scroll;
  const visible = items.slice(start, start + dg.items);

  if (dg.wide) {
    // preview pane: selected item's full detail, wrapped
    const sel = items[d.cursor];
    const previewLines =
      sel?.detail !== undefined
        ? wrapCached(sel.detail, dg.previewWidth - 1)
        : [];
    for (let i = 0; i < dg.items; i++) {
      const item = visible[i];
      const idx = start + i;
      let left: string;
      if (item === undefined) {
        left = " ".repeat(dg.listWidth);
      } else {
        const selected = idx === d.cursor;
        const marker = selected ? "›" : item.section ? " " : " ";
        if (selected) {
          const plain = `${marker} ${item.summary}`;
          left = theme.apply(
            "sel",
            truncateCells(plain, dg.listWidth).padEnd(dg.listWidth),
          );
        } else {
          left = compose(
            [
              { t: `${marker} ` },
              { t: item.summary, s: item.section ? "mint" : item.tone },
            ],
            dg.listWidth,
            theme,
          );
        }
      }
      const right =
        i === 0
          ? compose(
              [{ t: " DETAIL (enter expands)", s: "faint" }],
              dg.previewWidth,
              theme,
            )
          : previewLines[i - 1] !== undefined
            ? compose(
                [{ t: ` ${previewLines[i - 1]}`, s: "paper" }],
                dg.previewWidth,
                theme,
              )
            : " ".repeat(dg.previewWidth);
      lines.push(`${left}${theme.apply("faint", "│")}${right}`);
    }
  } else {
    for (let i = 0; i < dg.items; i++) {
      const item = visible[i];
      const idx = start + i;
      if (item === undefined) {
        lines.push(" ".repeat(geom.cols));
        continue;
      }
      const selected = idx === d.cursor;
      if (selected) {
        lines.push(
          theme.apply(
            "sel",
            truncateCells(`› ${item.summary}`, geom.cols).padEnd(geom.cols),
          ),
        );
      } else {
        lines.push(
          compose(
            [
              { t: item.section ? "  " : "  " },
              { t: item.summary, s: item.section ? "mint" : item.tone },
            ],
            geom.cols,
            theme,
          ),
        );
      }
    }
  }
  return lines;
}

const diffLineTone = (text: string): Token => {
  if (text.startsWith("  -")) return "bad";
  if (text.startsWith("  +")) return "good";
  if (text.startsWith("  ~")) return "warn";
  if (text.startsWith("  =")) return "faint";
  if (text.startsWith("Diff ")) return "paper";
  return "paper";
};

function renderTextBody(
  lines: { text: string; section: boolean }[],
  scroll: number,
  geom: Geom,
  theme: Theme,
  opts: { diff?: boolean } = {},
): string[] {
  const body = bodyRows(geom);
  const visible = lines.slice(scroll, scroll + body);
  return visible.map((l) => {
    const tone = l.section
      ? "mint"
      : opts.diff
        ? diffLineTone(l.text)
        : "paper";
    return compose([{ t: l.text, s: tone }], geom.cols, theme);
  });
}

function renderPagerBody(state: TuiState, geom: Geom, theme: Theme): string[] {
  const p = state.pager;
  const body = bodyRows(geom);
  if (p === null)
    return Array.from({ length: body }, () => " ".repeat(geom.cols));
  const lines = wrapCached(p.text, geom.cols - 1);
  const visible = lines.slice(p.scroll, p.scroll + body - 1);
  const out: string[] = [
    compose(
      [
        { t: ` ⧉ ${p.title}`, s: "mint" },
        { t: `   ${p.scroll + 1}/${Math.max(1, lines.length)}`, s: "faint" },
      ],
      geom.cols,
      theme,
    ),
  ];
  for (const line of visible) {
    out.push(compose([{ t: ` ${line}`, s: "paper" }], geom.cols, theme));
  }
  return out;
}

const HELP_LINES: [string, string][] = [
  ["↑ / k, ↓ / j", "move cursor or scroll"],
  ["enter", "open run detail · expand item (full, untruncated)"],
  ["tab", "home: switch pane · elsewhere: next section"],
  ["shift+tab", "previous section / pane"],
  ["← / h, → / l", "detail: switch tab"],
  ["a / b / x", "mark run as A / B · swap A⇄B"],
  ["d", "diff A vs B"],
  ["g / G", "first / last"],
  ["esc", "back"],
  ["?", "this help"],
  ["q / ctrl+c", "quit"],
];

function renderHelpBody(geom: Geom, theme: Theme): string[] {
  const body = bodyRows(geom);
  const out: string[] = [
    compose([{ t: " KEYS", s: "mint" }], geom.cols, theme),
    compose([{ t: "", s: undefined }], geom.cols, theme),
  ];
  for (const [key, desc] of HELP_LINES) {
    out.push(
      compose(
        [
          { t: `  ${key.padEnd(16)}`, s: "mint" },
          { t: desc, s: "dim" },
        ],
        geom.cols,
        theme,
      ),
    );
  }
  out.push(compose([{ t: "", s: undefined }], geom.cols, theme));
  out.push(
    compose(
      [
        {
          t: " M· AgentLens is read-only: the database is never modified, and missing metrics show as unknown.",
          s: "faint",
        },
      ],
      geom.cols,
      theme,
    ),
  );
  while (out.length < body) out.push(" ".repeat(geom.cols));
  return out;
}

const FOOTER_HINTS: Record<string, string> = {
  home: "↑↓/jk move · tab pane · a/b mark · x swap · enter detail · d diff · ? keys · q quit",
  detail: "↑↓/jk move · ←→/hl tab · enter expand · esc runs · ? keys · q quit",
  diff: "↑↓/jk scroll · tab section · g/G ends · esc runs · ? keys · q quit",
  pager: "↑↓/jk scroll · g/G ends · esc/enter back · ? keys · q quit",
};

/** Renders the full frame: exactly geom.rows lines of geom.cols cells. */
export function renderFrame(
  state: TuiState,
  data: TuiData,
  geom: Geom,
  theme: Theme,
): string[] {
  const viewName =
    state.screen === "home"
      ? "runs"
      : state.screen === "detail"
        ? "inspect"
        : state.screen === "diff"
          ? "diff"
          : "view";
  const leftSegs: Seg[] = [
    { t: " M·", s: "logo" },
    { t: " AgentLens", s: "paper" },
    { t: `  ${viewName}`, s: "mint" },
    { t: "  local · read-only", s: "faint" },
  ];
  const leftWidth = leftSegs.reduce(
    (acc, seg) => acc + textWidth(sanitize(seg.t)),
    0,
  );
  const rightText = truncateLeft(
    `${data.runs.length} runs · ${data.dbPath}`,
    Math.max(0, geom.cols - leftWidth - 2),
  );
  const gap = Math.max(1, geom.cols - leftWidth - textWidth(rightText));
  const header = compose(
    [...leftSegs, { t: " ".repeat(gap) }, { t: rightText, s: "faint" }],
    geom.cols,
    theme,
  );

  let body: string[];
  if (geom.cols < MIN_COLS || geom.rows < MIN_ROWS) {
    body = Array.from({ length: bodyRows(geom) }, () => " ".repeat(geom.cols));
    body[Math.floor(body.length / 2)] = compose(
      [
        {
          t: ` terminal too small (${geom.cols}×${geom.rows}); need ≥ ${MIN_COLS}×${MIN_ROWS}, 80×24+ recommended`,
          s: "warn",
        },
      ],
      geom.cols,
      theme,
    );
  } else if (state.help) {
    body = renderHelpBody(geom, theme);
  } else if (state.screen === "home") {
    body = renderHomeBody(state, data, geom, theme);
  } else if (state.screen === "detail") {
    body = renderDetailBody(state, data, geom, theme);
  } else if (state.screen === "diff") {
    body = renderTextBody(
      currentDiffLines(state, data),
      state.diffScroll,
      geom,
      theme,
      { diff: true },
    );
  } else {
    body = renderPagerBody(state, geom, theme);
  }
  while (body.length < bodyRows(geom)) body.push(" ".repeat(geom.cols));
  body = body.slice(0, bodyRows(geom));

  const rule = compose(
    [{ t: "─".repeat(geom.cols), s: "faint" }],
    geom.cols,
    theme,
  );
  const footerText =
    state.notice ?? FOOTER_HINTS[state.help ? "home" : state.screen] ?? "";
  const dims = `${geom.cols}×${geom.rows}`;
  const footer = compose(
    [
      state.notice !== null
        ? { t: ` ${footerText}`, s: "warn" }
        : { t: ` ${footerText}`, s: "dim" },
      { t: " ", s: undefined },
      {
        t: dims.padStart(
          Math.max(0, geom.cols - textWidth(` ${footerText}`) - 1),
        ),
        s: "faint",
      },
    ],
    geom.cols,
    theme,
  );

  return [header, ...body, rule, footer];
}
