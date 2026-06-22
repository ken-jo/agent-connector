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
 * The art is a compact, dependency-free 5-row SOLID-block font (filled `█`
 * blocks, bold strokes, no 3D outline) over [A-Za-z0-9 ._-] — the connector-id
 * charset. Each glyph is 4 columns + a 1-column gap (~5 cols/char), so the full
 * 15-char "agent-connector" fits on ONE line within an 80-column terminal (no
 * stacking, no wrap). Coloring is PER-LETTER: each whole glyph gets one bright
 * color from a curated vivid palette (cycled so adjacent letters pop), with a
 * bright-white highlight on each glyph's top row for a glossy "shine". Only a
 * single token genuinely too wide for the terminal falls back to a one-line
 * styled `» name` degrade.
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
// Compact solid-block font: 5 rows × 4 columns per glyph, filled `█` with bold
// strokes (no outline). Each glyph's 5 rows are exactly 4 chars wide so columns
// align when concatenated with a single-column gap. Covers [A-Za-z0-9 ._-]
// (uppercased; lowercase reuses caps). Unknown chars fall back to the blank.
// ─────────────────────────────────────────────────────────────────────────

const GLYPH_ROWS = 5;
const GLYPH_COLS = 4;

/** Glyph map: char → 5 rows of 4-wide solid-block art (bold, no outline). */
const FONT: Record<string, readonly string[]> = {
  A: ["████", "█  █", "████", "█  █", "█  █"],
  B: ["███ ", "█  █", "███ ", "█  █", "███ "],
  C: ["████", "█   ", "█   ", "█   ", "████"],
  D: ["███ ", "█  █", "█  █", "█  █", "███ "],
  E: ["████", "█   ", "███ ", "█   ", "████"],
  F: ["████", "█   ", "███ ", "█   ", "█   "],
  G: ["████", "█   ", "█ ██", "█  █", "████"],
  H: ["█  █", "█  █", "████", "█  █", "█  █"],
  I: ["███", " █ ", " █ ", " █ ", "███"],
  J: ["████", "   █", "   █", "█  █", "████"],
  K: ["█  █", "█ █ ", "██  ", "█ █ ", "█  █"],
  L: ["█   ", "█   ", "█   ", "█   ", "████"],
  M: ["█  █", "████", "█  █", "█  █", "█  █"],
  N: ["█  █", "██ █", "█ ██", "█  █", "█  █"],
  O: ["████", "█  █", "█  █", "█  █", "████"],
  P: ["████", "█  █", "████", "█   ", "█   "],
  Q: ["████", "█  █", "█  █", "█ ██", "████"],
  R: ["███ ", "█  █", "███ ", "█ █ ", "█  █"],
  S: ["████", "█   ", "████", "   █", "████"],
  T: ["███", " █ ", " █ ", " █ ", " █ "],
  U: ["█  █", "█  █", "█  █", "█  █", "████"],
  V: ["█  █", "█  █", "█  █", " ██ ", " ██ "],
  W: ["█  █", "█  █", "█  █", "████", "█  █"],
  X: ["█  █", " ██ ", " ██ ", " ██ ", "█  █"],
  Y: ["█  █", " ██ ", " █ ", " █ ", " █ "],
  Z: ["████", "  █ ", " █  ", "█   ", "████"],
  "0": ["████", "█  █", "█  █", "█  █", "████"],
  "1": [" █ ", "██ ", " █ ", " █ ", "███"],
  "2": ["████", "   █", "████", "█   ", "████"],
  "3": ["████", "   █", " ███", "   █", "████"],
  "4": ["█  █", "█  █", "████", "   █", "   █"],
  "5": ["████", "█   ", "████", "   █", "████"],
  "6": ["████", "█   ", "████", "█  █", "████"],
  "7": ["████", "   █", "  █ ", " █  ", " █  "],
  "8": ["████", "█  █", "████", "█  █", "████"],
  "9": ["████", "█  █", "████", "   █", "████"],
  "-": ["    ", "    ", "████", "    ", "    "],
  "_": ["    ", "    ", "    ", "    ", "████"],
  ".": ["  ", "  ", "  ", "  ", "██"],
  " ": ["  ", "  ", "  ", "  ", "  "],
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
 * Layout result: the 5 art rows PLUS, for each visible column, the index of the
 * letter it belongs to (-1 for an inter-glyph gap). The letter index drives the
 * per-letter solid color; the first art row is the white highlight row.
 */
interface ArtLayout {
  rows: string[];
  /** letterIndex[col] = which glyph occupies column `col` (-1 = gap). */
  letterOf: number[];
}

/**
 * Render `name` into the 5-row solid-block font with per-column letter tags.
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
// Per-letter vivid palette. Each WHOLE letter gets one solid bright color,
// cycled through a curated punchy set (hot pink → orange → yellow → lime →
// cyan → blue → violet) so adjacent letters are clearly different and POP. This
// reads as "vivid distinct colors", NOT a smooth rainbow gradient. The top row
// of every glyph is overpainted bright WHITE for a glossy shine.
// ─────────────────────────────────────────────────────────────────────────

/** Curated vivid RGB palette (8 punchy hues), cycled per letter. */
const PALETTE_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [255, 45, 149], // hot pink
  [255, 122, 0], // orange
  [255, 214, 0], // yellow
  [120, 255, 40], // lime
  [0, 230, 160], // teal-green
  [0, 200, 255], // cyan
  [70, 110, 255], // blue
  [185, 80, 255], // violet
];

/** 256-color cube indices matching the vivid palette, cycled per letter. */
const PALETTE_256: readonly number[] = [198, 208, 220, 118, 48, 45, 63, 135];

/** 16-color bright fg codes matching the palette, cycled per letter. */
const PALETTE_16: readonly number[] = [95, 93, 93, 92, 92, 96, 94, 95];

const RESET = "\x1b[0m";
const WHITE_RGB = "\x1b[38;2;255;255;255m";
const WHITE_256 = "\x1b[38;5;231m";
const WHITE_16 = "\x1b[97m";

/** The SGR open-escape for a letter's solid color at the given tier. */
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

/** The bright-white highlight open-escape for the given tier. */
function whiteOpen(color: ColorMode): string {
  if (color === "truecolor") return WHITE_RGB;
  if (color === "ansi256") return WHITE_256;
  return WHITE_16;
}

/**
 * Colorize ONE art row. `top` = render the filled cells in bright white (the
 * glossy highlight, used for each glyph's top row); otherwise each filled cell
 * takes its letter's solid palette color. Gap/space cells are emitted bare (no
 * escape). Under "none" the row is returned verbatim.
 */
function colorizeRow(
  row: string,
  letterOf: number[],
  color: ColorMode,
  top: boolean,
): string {
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
    out += (top ? whiteOpen(color) : letterOpen(li, color)) + ch + RESET;
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
 * Render the full banner: the compact solid-block brand name with per-letter
 * vivid colors + a bright-white top-row shine, then a two-line dim footer
 * directly below. Width-safe:
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
    const lead = color === "none" ? "» " : whiteOpen(color) + "» " + RESET;
    const line =
      color === "none"
        ? `${lead}${name}`
        : `${lead}${letterOpen(0, color)}${name}${RESET}`;
    return `${line}\n${footer}`;
  }

  const { rows, letterOf } = layout;
  const body = rows
    .map((row, r) => colorizeRow(row, letterOf, color, r === 0))
    .join("\n");
  return `${body}\n${footer}`;
}
