/**
 * cli/banner — the branded ASCII-art header shown once atop install / uninstall
 * / upgrade / doctor.
 *
 * Two PURE functions drive everything (no process.* reads here — the command
 * wiring injects the real env so tests can call these directly without a TTY):
 *
 *   renderBrandBanner(name, { color, columns })  → the banner string
 *   shouldShowBanner({ isTTY, noColor, json, quiet }) → whether to show it
 *
 * The art is a compact, dependency-free 3-row SOLID-block font (filled `█` plus
 * the half-blocks `▀`/`▄`, no 3D outline) over [A-Za-z0-9 ._-] — the
 * connector-id charset — a modest ~1.3× text-height banner. Glyphs are mostly 3
 * columns wide (M/N/W wider so they stay distinct), so the full 15-char
 * "agent-connector" fits on ONE line within an 80-column terminal (no stacking,
 * no wrap). Coloring is PER-LETTER: each whole glyph gets one solid SOFT-PASTEL
 * color from a curated muted palette (cycled so adjacent letters stay
 * distinguishable while the banner reads calm, not neon). Only a single token
 * genuinely too wide for the terminal degrades to a one-line styled `» name`.
 */

/** Color capability the host terminal advertises, highest → lowest. */
export type ColorMode = "truecolor" | "ansi256" | "ansi16" | "none";

/** Inputs to {@link renderBrandBanner} — all injected, never read from process. */
export interface BannerOptions {
  /** Color capability to render at. "none" emits zero ANSI codes. */
  color: ColorMode;
  /** Terminal width in columns; an un-fittable token degrades to one line. */
  columns: number;
}

/** Inputs to {@link shouldShowBanner} — the real env, injected by the caller. */
export interface BannerGate {
  /** process.stdout.isTTY (banner is suppressed entirely when not a TTY). */
  isTTY: boolean;
  /** NO_COLOR is set (the banner still shows, but with zero color codes). */
  noColor: boolean;
  /** A machine-readable --json was requested (suppress entirely). */
  json: boolean;
  /** An explicit --quiet was passed (suppress entirely). */
  quiet: boolean;
}

/**
 * Whether to print the banner at all. The banner is decorative, so it shows ONLY
 * for an interactive TTY and never when output is being consumed by a script or
 * pipeline: not when piped/redirected (`!isTTY`), not under `--json`, and not
 * under `--quiet`. `NO_COLOR` does NOT suppress it — the banner renders without
 * color in that case (handled by {@link resolveColorMode}).
 */
export function shouldShowBanner(gate: BannerGate): boolean {
  return gate.isTTY && !gate.json && !gate.quiet;
}

/**
 * Resolve the color tier from the (injected) terminal env. 24-bit when the
 * terminal advertises it (COLORTERM=truecolor|24bit), 256-color when TERM names
 * a 256 palette, else 16-color — and PLAIN (no color) under NO_COLOR or a dumb /
 * absent TERM.
 */
export function resolveColorMode(env: {
  noColor: boolean;
  colorterm?: string | undefined;
  term?: string | undefined;
}): ColorMode {
  if (env.noColor) return "none";
  const term = (env.term ?? "").toLowerCase();
  if (term === "" || term === "dumb") return "none";
  const colorterm = (env.colorterm ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if (term.includes("256")) return "ansi256";
  return "ansi16";
}

// ─────────────────────────────────────────────────────────────────────────
// Compact solid-block font: 3 rows per glyph (a modest ~1.3× text-height
// banner), built from `█` plus the half-blocks `▀`/`▄`, no outline. Glyphs are
// variable width (mostly 3 cols; M/N/W wider so they stay distinct), padded to
// their own max so columns align when concatenated with a single-column gap.
// Covers [A-Za-z0-9 ._-] (uppercased; lowercase reuses caps). The 15-char
// "agent-connector" fits one line under 80 cols. Unknown chars → the blank.
// ─────────────────────────────────────────────────────────────────────────

const GLYPH_ROWS = 3;

/**
 * Glyph map: char → 3 rows of compact solid-block art (full `█` blocks plus the
 * upper-/lower-half blocks `▀`/`▄` for stroke detail, no outline). Most glyphs
 * are 3 columns wide (narrow ones less), so the full 15-char "agent-connector"
 * fits one line under 80 cols. Covers [A-Za-z0-9 ._-] (uppercased; lowercase
 * reuses caps). M/N/W are drawn distinctly. Unknown chars → the blank glyph.
 */
const FONT: Record<string, readonly string[]> = {
  A: ["▄▀▄", "█▀█", "█ █"],
  B: ["█▀▄", "█▀▄", "▀▀ "],
  C: ["▄▀▀", "█  ", "▀▄▄"],
  D: ["█▀▄", "█ █", "▀▀ "],
  E: ["█▀▀", "█▀ ", "▀▀▀"],
  F: ["█▀▀", "█▀ ", "█  "],
  G: ["▄▀▀", "█ ▄", "▀▄▀"],
  H: ["█ █", "█▀█", "█ █"],
  I: ["█", "█", "█"],
  J: ["  █", "  █", "▀▀ "],
  K: ["█ ▄", "██ ", "█ ▀"],
  L: ["█  ", "█  ", "▀▀▀"],
  M: ["█▄ ▄█", "█ ▀ █", "█   █"],
  N: ["█▄ █", "█ ▀█", "█  █"],
  O: ["▄▀▄", "█ █", "▀▄▀"],
  P: ["█▀▄", "█▀ ", "█  "],
  Q: ["▄▀▄", "█ █", "▀▄▀▄"],
  R: ["█▀▄", "█▀▄", "█ ▀"],
  S: ["▄▀▀", "▀▀▄", "▀▄▀"],
  T: ["▀█▀", " █ ", " █ "],
  U: ["█ █", "█ █", "▀▄▀"],
  V: ["█ █", "█ █", " ▀ "],
  W: ["█   █", "█ ▄ █", "▀▄▀▄▀"],
  X: ["▀▄▀", " █ ", "▄▀▄"],
  Y: ["█ █", " ▀ ", " █ "],
  Z: ["▀▀█", " ▄▀", "█▄▄"],
  "0": ["▄▀▄", "█ █", "▀▄▀"],
  "1": ["▄█ ", " █ ", "▄█▄"],
  "2": ["▀▀▄", " ▄▀", "█▄▄"],
  "3": ["▀▀▄", " ▀▄", "▀▀ "],
  "4": ["█ █", "▀▀█", "  █"],
  "5": ["█▀▀", "▀▀▄", "▀▀ "],
  "6": ["▄▀▀", "█▀▄", "▀▄▀"],
  "7": ["▀▀█", " ▄▀", "▄▀ "],
  "8": ["▄▀▄", "▄▀▄", "▀▄▀"],
  "9": ["▄▀▄", "▀▄█", "▀▄▀"],
  "-": ["   ", "▄▄▄", "   "],
  "_": ["   ", "   ", "▄▄▄"],
  ".": [" ", " ", "▄"],
  " ": ["  ", "  ", "  "],
};

/** The blank fallback used for any char outside the FONT charset. */
const BLANK = FONT[" "]!;

/** Visible column count of a string (each `█`/space is one cell). */
function vlen(s: string): number {
  return [...s].length;
}

/** Pad a glyph's rows to its own max width so columns stay aligned. */
function normalizeGlyph(rows: readonly string[]): string[] {
  const w = Math.max(...rows.map(vlen));
  return rows.map((r) => r + " ".repeat(w - vlen(r)));
}

/**
 * Layout result: the 3 art rows PLUS, for each visible column, the index of the
 * letter it belongs to (-1 for an inter-glyph gap). The letter index drives the
 * per-letter solid pastel color.
 */
interface ArtLayout {
  rows: string[];
  /** letterIndex[col] = which glyph occupies column `col` (-1 = gap). */
  letterOf: number[];
}

/**
 * Render `name` into the 3-row solid-block font with per-column letter tags.
 * Glyphs are joined with a single blank gap column (tagged -1) so adjacent
 * letters get distinct colors. Returns null when the name has no renderable
 * characters.
 */
function layoutArt(name: string): ArtLayout | null {
  const chars = [...name];
  if (chars.length === 0) return null;
  const rows: string[] = Array.from({ length: GLYPH_ROWS }, () => "");
  const letterOf: number[] = [];
  for (let ci = 0; ci < chars.length; ci++) {
    const ch = chars[ci]!;
    const glyph = normalizeGlyph(FONT[ch.toUpperCase()] ?? BLANK);
    const gw = vlen(glyph[0] ?? "");
    if (ci > 0) {
      // One gap column between glyphs (tagged -1 so it stays uncolored).
      for (let r = 0; r < GLYPH_ROWS; r++) rows[r] += " ";
      letterOf.push(-1);
    }
    for (let r = 0; r < GLYPH_ROWS; r++) rows[r] += glyph[r] ?? "";
    for (let c = 0; c < gw; c++) letterOf.push(ci);
  }
  return { rows, letterOf };
}

/** Max visible width across the layout's rows. */
function artWidth(layout: ArtLayout): number {
  return Math.max(...layout.rows.map(vlen));
}

// ─────────────────────────────────────────────────────────────────────────
// Per-letter PASTEL palette. Each WHOLE letter gets one soft, muted color,
// cycled through a curated gentle set (rose → peach → soft yellow → mint → sky
// → periwinkle → lavender → soft lilac) so adjacent letters stay distinguishable
// while the whole banner reads CALM, not loud neon. No white highlight.
// ─────────────────────────────────────────────────────────────────────────

/** Curated soft pastel RGB palette (8 muted hues), cycled per letter. */
const PALETTE_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [244, 170, 190], // soft rose
  [247, 198, 165], // peach
  [243, 225, 168], // soft yellow
  [183, 223, 178], // mint
  [167, 214, 214], // soft aqua
  [170, 198, 240], // sky blue
  [183, 184, 232], // periwinkle
  [206, 184, 230], // lavender
];

/** 256-color cube indices approximating the pastel palette, cycled per letter. */
const PALETTE_256: readonly number[] = [218, 223, 229, 151, 152, 153, 147, 183];

/** 16-color (non-bright) fg codes approximating the pastels, cycled per letter. */
const PALETTE_16: readonly number[] = [35, 33, 33, 32, 36, 34, 34, 35];

const RESET = "\x1b[0m";

/** The SGR open-escape for a letter's solid pastel color at the given tier. */
function letterOpen(letterIndex: number, color: ColorMode): string {
  if (color === "truecolor") {
    const [r, g, b] = PALETTE_RGB[letterIndex % PALETTE_RGB.length]!;
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  if (color === "ansi256") {
    return `\x1b[38;5;${PALETTE_256[letterIndex % PALETTE_256.length]}m`;
  }
  return `\x1b[${PALETTE_16[letterIndex % PALETTE_16.length]}m`;
}

/**
 * Colorize ONE art row: each filled cell takes its letter's solid pastel color;
 * gap/space cells are emitted bare (no escape). Under "none" the row is returned
 * verbatim.
 */
function colorizeRow(row: string, letterOf: number[], color: ColorMode): string {
  if (color === "none") return row;
  const chars = [...row];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const li = letterOf[i] ?? -1;
    if (ch === " " || li < 0) {
      out += ch; // gap or empty cell — no color
      continue;
    }
    out += letterOpen(li, color) + ch + RESET;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Footer (engine attribution). Shown on BOTH the global and branded CLIs — the
// "powered by" wording is intentional.
// ─────────────────────────────────────────────────────────────────────────

const FOOTER_LINES = [
  "powered by @ken-jo/agent-connector",
  "more → https://github.com/ken-jo/agent-connector",
] as const;

/** Dim (de-emphasized) footer line; plain under "none". */
function dim(text: string, color: ColorMode): string {
  return color === "none" ? text : `\x1b[2m${text}${RESET}`;
}

/**
 * Render the full banner: the compact 3-row solid-block brand name with one
 * solid pastel color per letter, then a two-line dim footer directly below.
 * Width-safe:
 *
 *   • One line when it fits `columns` (which "agent-connector" does at 80 cols).
 *   • A token genuinely too wide → a one-line styled `» name` degrade rather
 *     than a mangled wrap. A 0/unknown `columns` is "no constraint".
 *   • Under `color: "none"` (NO_COLOR / dumb term) the output carries zero ANSI
 *     escape codes — only the raw art + footer text.
 *
 * The result has NO trailing newline; the caller prints it with one.
 */
export function renderBrandBanner(name: string, opts: BannerOptions): string {
  const { color, columns } = opts;
  const footer = FOOTER_LINES.map((l) => dim(l, color)).join("\n");

  const layout = layoutArt(name);
  const limit = columns > 0 ? columns : Infinity;
  if (layout == null || artWidth(layout) > limit) {
    // Degrade to a single styled line (no art, or an un-fittable token).
    const lead = color === "none" ? "» " : letterOpen(0, color) + "» " + RESET;
    const line =
      color === "none"
        ? `${lead}${name}`
        : `${lead}${letterOpen(0, color)}${name}${RESET}`;
    return `${line}\n${footer}`;
  }

  const { rows, letterOf } = layout;
  const body = rows.map((row) => colorizeRow(row, letterOf, color)).join("\n");
  return `${body}\n${footer}`;
}
