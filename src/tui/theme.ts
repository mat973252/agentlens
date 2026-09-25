/**
 * M7 visual tokens. The palette adapts the public mat973252.github.io
 * scheme — ink #142121, paper #fbf9f8, mint #83cebe, muted #61706b,
 * supporting teal #4aab96 — to a dark terminal: primary text in paper,
 * accents in mint/teal, secondary labels in a lightened muted, and thin
 * rules in the original muted. Failure/warning tones are conventional
 * terminal colors (the site palette has no error token).
 *
 * Three degradation levels: truecolor (hex), 256-color (nearest cube) and
 * 16-color (ANSI base palette + reverse/bold for selection). NO_COLOR and
 * TERM=dumb disable all styling.
 */

export type ColorMode = "none" | "ansi16" | "ansi256" | "truecolor";

export type Token =
  | "paper" // primary text
  | "dim" // secondary labels (muted lightened toward paper)
  | "faint" // rules, least important text (original muted)
  | "mint" // primary accent: brand mint
  | "teal" // secondary accent: supporting teal
  | "bad" // failures / diff removals
  | "warn" // running / diff changes
  | "good" // pass / diff additions
  | "sel" // selected row
  | "tab" // active tab
  | "logo"; // M· mark

export const PALETTE = {
  ink: "#142121",
  paper: "#fbf9f8",
  mint: "#83cebe",
  muted: "#61706b",
  teal: "#4aab96",
  dim: "#8fa29c",
  fail: "#e0705a",
  warn: "#d9a848",
  selectBg: "#274642",
} as const;

interface TrueSpec {
  fg?: string;
  bg?: string;
  bold?: boolean;
  underline?: boolean;
}

const TRUECOLOR: Record<Token, TrueSpec> = {
  paper: { fg: PALETTE.paper },
  dim: { fg: PALETTE.dim },
  faint: { fg: PALETTE.muted },
  mint: { fg: PALETTE.mint, bold: true },
  teal: { fg: PALETTE.teal },
  bad: { fg: PALETTE.fail },
  warn: { fg: PALETTE.warn },
  good: { fg: PALETTE.mint },
  sel: { fg: PALETTE.paper, bg: PALETTE.selectBg, bold: true },
  tab: { fg: PALETTE.mint, bold: true, underline: true },
  logo: { fg: PALETTE.mint, bold: true },
};

/** ANSI base-palette fallback: token -> fg/attrs. */
const ANSI16: Record<
  Token,
  { fg?: number; bold?: boolean; underline?: boolean; reverse?: boolean }
> = {
  paper: { fg: 97 },
  dim: { fg: 37 },
  faint: { fg: 90 },
  mint: { fg: 36, bold: true },
  teal: { fg: 32 },
  bad: { fg: 91 },
  warn: { fg: 93 },
  good: { fg: 32 },
  sel: { fg: 97, bold: true, reverse: true },
  tab: { fg: 36, bold: true, underline: true },
  logo: { fg: 36, bold: true },
};

const hexRgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

const toCube = (v: number): number =>
  v < 48 ? 0 : v < 115 ? 1 : Math.round((v - 35) / 40);

const hexTo256 = (hex: string): number => {
  const [r = 0, g = 0, b = 0] = hexRgb(hex).map(toCube);
  return 16 + 36 * r + 6 * g + b;
};

const ESC = "\u001b";

/**
 * Chooses the color level from the environment. NO_COLOR wins over
 * everything except an explicit FORCE_COLOR; TERM=dumb disables colors;
 * Windows Terminal (WT_SESSION) and modern terminals get truecolor.
 */
export function detectColorMode(
  env: NodeJS.ProcessEnv = process.env,
): ColorMode {
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "0" && force !== "false")
    return "truecolor";
  if (env.NO_COLOR !== undefined) return "none";
  const term = env.TERM ?? "";
  if (term === "dumb") return "none";
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  const termProgram = env.TERM_PROGRAM ?? "";
  if (
    env.WT_SESSION !== undefined ||
    termProgram === "vscode" ||
    termProgram === "iTerm.app" ||
    /^(xterm-kitty|alacritty|wezterm|ghostty|foot|contour)/.test(term)
  )
    return "truecolor";
  if (/-256color/.test(term)) return "ansi256";
  if (term === "" && env.ConEmuANSI !== "ON" && process.platform !== "win32")
    return "none";
  return "ansi16";
}

export class Theme {
  private readonly open: Record<Token, string>;

  constructor(readonly mode: ColorMode) {
    this.open = {} as Record<Token, string>;
    for (const token of Object.keys(TRUECOLOR) as Token[]) {
      const codes: string[] = [];
      if (mode === "ansi16") {
        const spec = ANSI16[token];
        if (spec.bold) codes.push("1");
        if (spec.underline) codes.push("4");
        if (spec.reverse) codes.push("7");
        if (spec.fg !== undefined) codes.push(String(spec.fg));
      } else if (mode !== "none") {
        const spec = TRUECOLOR[token];
        if (spec.bold) codes.push("1");
        if (spec.underline) codes.push("4");
        if (spec.fg !== undefined) {
          if (mode === "truecolor") {
            const [r, g, b] = hexRgb(spec.fg);
            codes.push(`38;2;${r};${g};${b}`);
          } else {
            codes.push(`38;5;${hexTo256(spec.fg)}`);
          }
        }
        if (spec.bg !== undefined) {
          if (mode === "truecolor") {
            const [r, g, b] = hexRgb(spec.bg);
            codes.push(`48;2;${r};${g};${b}`);
          } else {
            codes.push(`48;5;${hexTo256(spec.bg)}`);
          }
        }
      }
      this.open[token] = codes.length > 0 ? `${ESC}[${codes.join(";")}m` : "";
    }
  }

  /** Wraps text in the token's SGR codes (no-op under "none"). */
  apply(token: Token, text: string): string {
    if (this.mode === "none" || text === "") return text;
    return `${this.open[token]}${text}${ESC}[0m`;
  }
}
