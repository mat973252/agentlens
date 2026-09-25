import { DETAIL_TABS } from "./model.js";

/**
 * Pure UI state + key reducer for the TUI. Keeping every transition pure
 * (no I/O) lets tests drive the whole interaction model without a pty.
 * Rendering-side clamping (scroll bounds that depend on content height)
 * lives in render.ts as clampState.
 */

export type KeyName =
  | "up"
  | "down"
  | "left"
  | "right"
  | "pageUp"
  | "pageDown"
  | "home"
  | "end"
  | "enter"
  | "tab"
  | "shiftTab"
  | "esc"
  | "char"
  | "ctrl-c"
  | "other";

export interface InputKey {
  name: KeyName;
  char?: string;
}

export type Screen = "home" | "detail" | "diff" | "pager";

export interface DetailState {
  runIndex: number;
  /** Index into DETAIL_TABS. */
  tab: number;
  cursor: number;
  scroll: number;
}

export interface PagerState {
  title: string;
  text: string;
  /** First visible row of the *wrapped* text. */
  scroll: number;
  back: "detail" | "diff" | "home";
}

export interface TuiState {
  screen: Screen;
  /** Overlay help visible (independent of screen). */
  help: boolean;
  /** Set when the app should exit. */
  done: boolean;
  /** Transient footer message, cleared by the next key. */
  notice: string | null;
  cursor: number;
  a: number | null;
  b: number | null;
  focus: "list" | "compare";
  listScroll: number;
  compareScroll: number;
  detail: DetailState | null;
  diffScroll: number;
  pager: PagerState | null;
}

export function initialState(runCount: number): TuiState {
  return {
    screen: "home",
    help: false,
    done: false,
    notice: null,
    cursor: 0,
    a: runCount >= 2 ? runCount - 2 : null,
    b: runCount >= 2 ? runCount - 1 : null,
    focus: "list",
    listScroll: 0,
    compareScroll: 0,
    detail: null,
    diffScroll: 0,
    pager: null,
  };
}

export interface ReducerCtx {
  runCount: number;
  /** Body rows available for scrolling content (for page keys). */
  bodyRows: number;
  /** Items on the current detail tab (for cursor bounds). */
  detailItemCount: number;
  /** Section row indexes on the current scrollable text view. */
  sectionRows: number[];
}

/**
 * Applies one key. Pure: callers clamp scroll offsets afterwards via
 * render.clampState, since bounds depend on rendered content height.
 * The reducer clears `notice` at entry — notices survive exactly one frame.
 */
export function reduce(state: TuiState, key: InputKey, ctx: ReducerCtx): void {
  const { runCount, bodyRows } = ctx;
  const page = Math.max(1, bodyRows - 1);
  state.notice = null;

  if (key.name === "ctrl-c") {
    state.done = true;
    return;
  }
  if (key.name === "char" && key.char === "?") {
    state.help = !state.help;
    return;
  }
  if (state.help) {
    if (key.name === "esc") state.help = false;
    else if (key.name === "char" && key.char === "q") state.done = true;
    return;
  }
  if (key.name === "char" && key.char === "q") {
    state.done = true;
    return;
  }

  const line = (delta: number): void => {
    switch (state.screen) {
      case "home":
        if (state.focus === "list") {
          state.cursor = Math.min(
            Math.max(state.cursor + delta, 0),
            Math.max(0, runCount - 1),
          );
        } else {
          state.compareScroll += delta;
        }
        break;
      case "detail": {
        const d = state.detail;
        if (d !== null) {
          d.cursor = Math.min(
            Math.max(d.cursor + delta, 0),
            Math.max(0, ctx.detailItemCount - 1),
          );
        }
        break;
      }
      case "diff":
        state.diffScroll += delta;
        break;
      case "pager":
        if (state.pager !== null) state.pager.scroll += delta;
        break;
    }
  };

  const toStart = (): void => {
    if (state.screen === "home") {
      if (state.focus === "list") state.cursor = 0;
      else state.compareScroll = 0;
    } else if (state.screen === "detail" && state.detail !== null) {
      state.detail.cursor = 0;
    } else if (state.screen === "diff") {
      state.diffScroll = 0;
    } else if (state.pager !== null) {
      state.pager.scroll = 0;
    }
  };

  const toEnd = (): void => {
    if (state.screen === "home") {
      if (state.focus === "list") state.cursor = Math.max(0, runCount - 1);
      else state.compareScroll = Number.MAX_SAFE_INTEGER;
    } else if (state.screen === "detail" && state.detail !== null) {
      state.detail.cursor = Math.max(0, ctx.detailItemCount - 1);
    } else if (state.screen === "diff") {
      state.diffScroll = Number.MAX_SAFE_INTEGER;
    } else if (state.pager !== null) {
      state.pager.scroll = Number.MAX_SAFE_INTEGER;
    }
  };

  const jumpSection = (dir: 1 | -1): void => {
    const rows = ctx.sectionRows;
    if (rows.length === 0) return;
    const current =
      state.screen === "diff"
        ? state.diffScroll
        : state.pager !== null
          ? state.pager.scroll
          : (state.detail?.scroll ?? 0);
    const target =
      dir === 1
        ? (rows.find((r) => r > current) ?? rows[0])
        : ([...rows].reverse().find((r) => r < current) ?? rows.at(-1));
    if (target === undefined) return;
    if (state.screen === "diff") state.diffScroll = target;
    else if (state.pager !== null) state.pager.scroll = target;
    else if (state.detail !== null) state.detail.scroll = target;
  };

  const back = (): void => {
    if (state.screen === "pager" && state.pager !== null) {
      state.screen = state.pager.back;
      state.pager = null;
    } else if (state.screen !== "home") {
      state.screen = "home";
    }
  };

  switch (key.name) {
    case "up":
      line(-1);
      break;
    case "down":
      line(1);
      break;
    case "pageUp":
      line(-page);
      break;
    case "pageDown":
      line(page);
      break;
    case "home":
      toStart();
      break;
    case "end":
      toEnd();
      break;
    case "left":
      if (state.screen === "detail" && state.detail !== null) {
        const d = state.detail;
        d.tab = (d.tab - 1 + DETAIL_TABS.length) % DETAIL_TABS.length;
        d.cursor = 0;
        d.scroll = 0;
      }
      break;
    case "right":
      if (state.screen === "detail" && state.detail !== null) {
        const d = state.detail;
        d.tab = (d.tab + 1) % DETAIL_TABS.length;
        d.cursor = 0;
        d.scroll = 0;
      }
      break;
    case "tab":
      if (state.screen === "home") {
        state.focus = state.focus === "list" ? "compare" : "list";
      } else {
        jumpSection(1);
      }
      break;
    case "shiftTab":
      if (state.screen === "home") {
        state.focus = state.focus === "list" ? "compare" : "list";
      } else {
        jumpSection(-1);
      }
      break;
    case "enter":
      if (state.screen === "home" && runCount > 0) {
        state.detail = { runIndex: state.cursor, tab: 0, cursor: 0, scroll: 0 };
        state.screen = "detail";
      }
      // detail/pager enter expansion is resolved by the app layer via openPager.
      break;
    case "esc":
      back();
      break;
    case "char": {
      const c = key.char;
      if (c === "j") line(1);
      else if (c === "k") line(-1);
      else if (c === "g") toStart();
      else if (c === "G") toEnd();
      else if (state.screen === "detail" && c === "h") {
        reduce(state, { name: "left" }, ctx);
      } else if (state.screen === "detail" && c === "l") {
        reduce(state, { name: "right" }, ctx);
      } else if (state.screen === "home" && c === "a" && runCount > 0) {
        state.a = state.cursor;
      } else if (state.screen === "home" && c === "b" && runCount > 0) {
        state.b = state.cursor;
      } else if (state.screen === "home" && c === "x") {
        const t = state.a;
        state.a = state.b;
        state.b = t;
      } else if (state.screen === "home" && c === "d") {
        if (state.a === null || state.b === null) {
          state.notice =
            runCount < 2
              ? "need two recorded runs to diff"
              : "mark runs first: a = Run A, b = Run B";
        } else if (state.a === state.b) {
          state.notice = "A and B are the same run; mark two different runs";
        } else {
          state.screen = "diff";
          state.diffScroll = 0;
        }
      }
      break;
    }
    default:
      break;
  }
}
