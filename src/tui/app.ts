import type { TuiData } from "./model.js";
import {
  clampState,
  currentDetailItems,
  currentDiffLines,
  reducerCtx,
  renderFrame,
} from "./render.js";
import { type InputKey, initialState, reduce, type TuiState } from "./state.js";
import { type ColorMode, detectColorMode, Theme } from "./theme.js";

/**
 * TUI runtime: owns the terminal (alternate screen, raw mode, cursor hide),
 * parses input bytes into keys, feeds the pure reducer, and repaints the
 * whole frame on every key/resize. All writes go through a single string
 * per frame wrapped in a synchronized-update escape, so a resize or a slow
 * terminal cannot leave a half-painted screen. Restore runs on every exit
 * path — q, Ctrl+C (raw byte), SIGINT/SIGTERM/SIGHUP and unexpected errors.
 */

export interface TuiIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream & { columns?: number; rows?: number };
}

interface RawCapableInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
}

const ALT_SCREEN_ON = "\x1b[?1049h\x1b[?25l";
const ALT_SCREEN_OFF = "\x1b[?25h\x1b[?1049l";
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

/**
 * Minimal input parser replacing readline.emitKeypressEvents: that API
 * buffers a lone ESC indefinitely waiting for a sequence continuation, so a
 * plain Esc press only surfaces after the *next* key (and then as a
 * meta-key). We parse raw chunks ourselves: CSI/SS3 sequences, ESC with a
 * short deferral window, and everything else byte-wise.
 */
const CSI_KEYS: Record<string, InputKey["name"]> = {
  "\x1b[A": "up",
  "\x1bOA": "up",
  "\x1b[B": "down",
  "\x1bOB": "down",
  "\x1b[C": "right",
  "\x1bOC": "right",
  "\x1b[D": "left",
  "\x1bOD": "left",
  "\x1b[5~": "pageUp",
  "\x1b[6~": "pageDown",
  "\x1b[H": "home",
  "\x1bOH": "home",
  "\x1b[F": "end",
  "\x1bOF": "end",
  "\x1b[1~": "home",
  "\x1b[4~": "end",
  "\x1b[7~": "home",
  "\x1b[8~": "end",
  "\x1b[Z": "shiftTab",
};

const CSI_PREFIXES = Object.keys(CSI_KEYS);

/** Milliseconds a pending ESC waits for sequence bytes before becoming Esc. */
const ESC_DEFER_MS = 25;

export class KeyParser {
  private buf = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly emit: (key: InputKey) => void) {}

  feed(chunk: string | Buffer): void {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  /** Releases a buffered lone ESC (e.g. on teardown). */
  close(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.buf.startsWith("\x1b")) {
      this.buf = this.buf.slice(1);
      this.emit({ name: "esc" });
    }
    this.buf = "";
  }

  private deferEsc(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.buf.startsWith("\x1b")) {
        this.buf = this.buf.slice(1);
        this.emit({ name: "esc" });
        this.flush();
      }
    }, ESC_DEFER_MS);
    this.timer.unref?.();
  }

  private flush(): void {
    while (this.buf.length > 0) {
      if (this.buf.startsWith("\x1b")) {
        const hit = CSI_PREFIXES.find((seq) => this.buf.startsWith(seq));
        if (hit !== undefined) {
          this.buf = this.buf.slice(hit.length);
          this.emit({ name: CSI_KEYS[hit] ?? "other" });
          continue;
        }
        // a known sequence is still arriving, or a lone ESC — wait briefly
        if (
          this.buf.length === 1 ||
          CSI_PREFIXES.some((seq) => seq.startsWith(this.buf))
        ) {
          this.deferEsc();
          return;
        }
        // ESC + non-sequence bytes: emit Esc and reprocess the rest
        this.buf = this.buf.slice(1);
        this.emit({ name: "esc" });
        continue;
      }
      const cp = this.buf.codePointAt(0) ?? 0;
      const ch = this.buf.slice(0, cp > 0xffff ? 2 : 1);
      this.buf = this.buf.slice(ch.length);
      if (ch === "\r" || ch === "\n") this.emit({ name: "enter" });
      else if (ch === "\t") this.emit({ name: "tab" });
      else if (ch === "\x03") this.emit({ name: "ctrl-c" });
      else if (cp < 0x20 || cp === 0x7f) this.emit({ name: "other" });
      else this.emit({ name: "char", char: ch });
    }
  }
}

/**
 * Runs the interactive UI until the user quits. `data` is a fully-loaded,
 * read-only snapshot — the store is already closed before this is called.
 */
export async function runTui(
  data: TuiData,
  io: TuiIo,
  colorMode?: ColorMode,
): Promise<number> {
  const input = io.input as RawCapableInput;
  const output = io.output;
  const theme = new Theme(colorMode ?? detectColorMode());
  const state: TuiState = initialState(data.runs.length);

  const geom = () => ({
    cols: Math.max(1, output.columns ?? 80),
    rows: Math.max(1, output.rows ?? 24),
  });

  const paint = (): void => {
    clampState(state, data, geom());
    const lines = renderFrame(state, data, geom(), theme);
    // Home the cursor and rewrite every row; \x1b[K clears tail cells so
    // resize-shrink cannot leave stale glyphs. Synchronized-update markers
    // keep the frame atomic on terminals that support them.
    output.write(
      `${SYNC_START}\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\n")}${SYNC_END}`,
    );
  };

  const onKey = (input_: InputKey): void => {
    try {
      const ctx = reducerCtx(state, data, geom());
      if (
        input_.name === "enter" &&
        state.screen === "detail" &&
        state.detail !== null
      ) {
        const item = currentDetailItems(state, data)[state.detail.cursor];
        if (item?.detail !== undefined) {
          state.pager = {
            title: item.summary.replace(/\s+/g, " ").slice(0, 60),
            text: item.detail,
            scroll: 0,
            back: "detail",
          };
          state.screen = "pager";
        }
      } else if (input_.name === "enter" && state.screen === "diff") {
        const text = currentDiffLines(state, data)
          .map((l: { text: string }) => l.text)
          .join("\n");
        state.pager = {
          title: "diff (full, untruncated)",
          text,
          scroll: 0,
          back: "diff",
        };
        state.screen = "pager";
      } else {
        reduce(state, input_, ctx);
      }
      if (state.done) {
        finish(0);
        return;
      }
      paint();
    } catch (error) {
      finish(1, error);
    }
  };

  const onResize = (): void => {
    try {
      paint();
    } catch (error) {
      finish(1, error);
    }
  };

  let finished = false;
  let resolvePromise: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    resolvePromise = resolve;
  });

  const parser = new KeyParser(onKey);
  const onData = (chunk: string | Buffer): void => {
    try {
      parser.feed(chunk);
    } catch (error) {
      finish(1, error);
    }
  };

  const restore = (): void => {
    try {
      output.write(ALT_SCREEN_OFF);
    } catch {
      // best-effort: a dead output still must not hang shutdown
    }
    if (input.isTTY === true && typeof input.setRawMode === "function") {
      input.setRawMode(false);
    }
    input.removeListener("data", onData);
    parser.close();
    output.removeListener("resize", onResize);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.removeListener(sig, signalHandlers[sig]);
    }
    process.removeListener("uncaughtException", onCrash);
    input.pause();
  };

  const signalHandlers = {
    SIGINT: () => finish(130),
    SIGTERM: () => finish(143),
    SIGHUP: () => finish(129),
  };
  const onCrash = (error: unknown): void => finish(1, error);

  const finish = (code: number, error?: unknown): void => {
    if (finished) return;
    finished = true;
    restore();
    if (error !== undefined) {
      console.error(
        `agentlens ui: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    resolvePromise(code);
  };

  if (input.isTTY === true && typeof input.setRawMode === "function") {
    input.setRawMode(true);
  }
  input.on("data", onData);
  output.on("resize", onResize);
  process.on("SIGINT", signalHandlers.SIGINT);
  process.on("SIGTERM", signalHandlers.SIGTERM);
  process.on("SIGHUP", signalHandlers.SIGHUP);
  process.on("uncaughtException", onCrash);

  output.write(ALT_SCREEN_ON);
  input.resume();
  paint();
  return done;
}
