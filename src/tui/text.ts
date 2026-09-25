/**
 * Terminal text helpers: display-cell width (CJK/emoji aware), truncation
 * and wrapping. All payload text reaching the TUI is JSON-serialized first,
 * so these helpers only ever see printable text plus \n/\t.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const COMBINING =
  /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe00-\ufe0f\ufe20-\ufe2f\u{e0100}-\u{e01ef}]/u;

/** Wide ranges: CJK, fullwidth forms, emoji, supplementary CJK planes. */
const WIDE =
  /[\u1100-\u115f\u2329-\u232a\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{16fe0}-\u{16fe4}\u{17000}-\u{18fff}\u{1b000}-\u{1b2ff}\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;

const charWidth = (codePoint: number): number => {
  if (codePoint === 0x00ad) return 0; // soft hyphen
  if (codePoint === 0x200b || (codePoint >= 0x200e && codePoint <= 0x200f))
    return 0;
  if (codePoint >= 0x202a && codePoint <= 0x202e) return 0;
  const ch = String.fromCodePoint(codePoint);
  if (COMBINING.test(ch)) return 0;
  if (WIDE.test(ch)) return 2;
  return 1;
};

/** Display width in terminal cells. Wide chars count 2, combining marks 0. */
export function textWidth(text: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (segment.includes("\ufe0f"))
      width += 2; // emoji presentation selector
    else width += charWidth(segment.codePointAt(0) ?? 0);
  }
  return width;
}

/** Removes characters that would corrupt the frame (C0/C1 controls). */
export const sanitize = (text: string): string =>
  text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips terminal-breaking control bytes
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g, "")
    .replaceAll("\t", " ");

/** Truncates to `max` cells, adding "…" when content is dropped. */
export function truncateCells(text: string, max: number): string {
  if (max <= 0) return "";
  if (textWidth(text) <= max) return text;
  const budget = max - 1;
  let width = 0;
  let out = "";
  for (const { segment } of segmenter.segment(text)) {
    const w = segment.includes("\ufe0f")
      ? 2
      : charWidth(segment.codePointAt(0) ?? 0);
    if (width + w > budget) break;
    out += segment;
    width += w;
  }
  return `${out}…`;
}

/** Hard-breaks a single line to `max` cells, keeping whole graphemes. */
const hardWrap = (line: string, max: number): string[] => {
  const out: string[] = [];
  let current = "";
  let width = 0;
  for (const { segment } of segmenter.segment(line)) {
    const w = segment.includes("\ufe0f")
      ? 2
      : charWidth(segment.codePointAt(0) ?? 0);
    if (width + w > max && current !== "") {
      out.push(current);
      current = "";
      width = 0;
    }
    current += segment;
    width += w;
  }
  if (current !== "" || out.length === 0) out.push(current);
  return out;
};

/**
 * Word-wraps text to `max` cells per line (newlines preserved, overlong
 * words hard-broken). Width 0 returns [].
 */
export function wrapCells(text: string, max: number): string[] {
  if (max <= 0) return [];
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = sanitize(rawLine);
    if (line === "") {
      out.push("");
      continue;
    }
    const words = line.split(" ");
    let current = "";
    for (const word of words) {
      const candidate = current === "" ? word : `${current} ${word}`;
      if (textWidth(candidate) <= max) {
        current = candidate;
      } else {
        if (current !== "") out.push(current);
        current = "";
        if (textWidth(word) > max) {
          const pieces = hardWrap(word, max);
          out.push(...pieces.slice(0, -1));
          current = pieces.at(-1) ?? "";
        } else {
          current = word;
        }
      }
    }
    if (current !== "") out.push(current);
  }
  return out;
}
