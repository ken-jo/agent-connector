/**
 * cli/banner — the branded ASCII-art header shown once atop install / uninstall
 * / upgrade / doctor.
 *
 * Two PURE functions drive everything (no process.* reads here — the command
 * wiring injects the real env so tests can call these directly without a TTY):
 *
 *   renderBrandBanner(name, { color, columns, palette })  → the banner string
 *   shouldShowBanner({ isTTY, noColor, json, quiet }) → whether to show it
 *
 * RESPONSIVE FONT (one line, NEVER stacked): two hand-authored fixed-width glyph
 * maps that tile cleanly. A WIDE 6-row "ANSI Shadow" font (solid `█` + `╗╔╝╚║═`
 * shadow, ~8 cols/char) is used when it fits the terminal; otherwise a COMPACT
 * 6-row solid-block font (`█`/`▀`/`▄`, ~4-5 cols/char) that fits 80 cols;
 * otherwise a one-line styled `» name` degrade. Both fonts cover the connector-id
 * charset [A-Za-z0-9 ._-] (uppercased — lowercase reuses caps).
 *
 * COLOR: a per-column gradient sweeps each row left-to-right between three RGB
 * stops (a {@link Palette}). The render is PURE and palette-parameterized — the
 * caller picks the palette (the impure app.ts wrapper rotates {@link PALETTES}
 * per run). truecolor→256→16→none tiers all honor the palette; NO_COLOR = zero
 * ANSI.
 */

/** Color capability the host terminal advertises, highest → lowest. */
export type ColorMode = "truecolor" | "ansi256" | "ansi16" | "none";

/** A 24-bit RGB triple. */
export type RGB = readonly [number, number, number];

/** A 3-stop gradient: the sweep lerps stop0 → stop1 → stop2 across the columns. */
export type Palette = readonly [RGB, RGB, RGB];

/**
 * The 10 rotation palettes. The impure {@link maybePrintBanner} wrapper picks one
 * at random per run so each real invocation shows a different color; the pure
 * renderer defaults to PALETTES[0] so direct callers + tests stay deterministic.
 */
export const PALETTES: readonly Palette[] = [
  [[255, 210, 0], [255, 110, 10], [220, 30, 25]], // Sunset
  [[255, 225, 90], [255, 120, 0], [200, 20, 20]], // Lava
  [[230, 30, 30], [255, 120, 0], [255, 220, 0]], // Fire
  [[255, 225, 120], [255, 170, 40], [225, 110, 20]], // Amber gold
  [[255, 205, 150], [255, 150, 130], [255, 120, 175]], // Peach pastel
  [[255, 80, 170], [200, 40, 200], [100, 60, 210]], // Berry
  [[0, 220, 180], [0, 160, 230], [60, 90, 230]], // Ocean
  [[80, 230, 140], [0, 200, 210], [150, 90, 235]], // Aurora
  [[170, 230, 90], [60, 200, 120], [20, 150, 140]], // Forest
  [[0, 200, 200], [40, 80, 230], [200, 40, 200]], // Synthwave
] as const;

/** Inputs to {@link renderBrandBanner} — all injected, never read from process. */
export interface BannerOptions {
  /** Color capability to render at. "none" emits zero ANSI codes. */
  color: ColorMode;
  /** Terminal width in columns; selects the font (wide → compact → degrade). */
  columns: number;
  /** The 3-stop gradient. Defaults to {@link PALETTES}[0] (Sunset) when omitted. */
  palette?: Palette;
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
// WIDE font — "ANSI Shadow" (6 rows). Hand-transcribed bold figlet glyphs —
// solid `█` with a `╗╔╝╚║═` 3D shadow — fixed-width per glyph so they TILE
// cleanly when concatenated (~8 cols/char → "agent-connector" ≈ 126 cols on
// one line). Used only when the terminal is wide enough.
// ─────────────────────────────────────────────────────────────────────────

const WIDE_FONT: Record<string, readonly string[]> = {
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  B: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██████╔╝", "╚═════╝ "],
  C: [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"],
  D: ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  F: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "██║     ", "╚═╝     "],
  G: [" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  H: ["██╗  ██╗", "██║  ██║", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
  J: ["     ██╗", "     ██║", "     ██║", "██   ██║", "╚█████╔╝", " ╚════╝ "],
  K: ["██╗  ██╗", "██║ ██╔╝", "█████╔╝ ", "██╔═██╗ ", "██║  ██╗", "╚═╝  ╚═╝"],
  L: ["██╗     ", "██║     ", "██║     ", "██║     ", "███████╗", "╚══════╝"],
  M: ["███╗   ███╗", "████╗ ████║", "██╔████╔██║", "██║╚██╔╝██║", "██║ ╚═╝ ██║", "╚═╝     ╚═╝"],
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
  O: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  P: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔═══╝ ", "██║     ", "╚═╝     "],
  Q: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║▄▄ ██║", "╚██████╔╝", " ╚══▀▀═╝ "],
  R: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██║  ██║", "╚═╝  ╚═╝"],
  S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
  T: ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
  U: ["██╗   ██╗", "██║   ██║", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  V: ["██╗   ██╗", "██║   ██║", "██║   ██║", "╚██╗ ██╔╝", " ╚████╔╝ ", "  ╚═══╝  "],
  W: ["██╗    ██╗", "██║    ██║", "██║ █╗ ██║", "██║███╗██║", "╚███╔███╔╝", " ╚══╝╚══╝ "],
  X: ["██╗  ██╗", "╚██╗██╔╝", " ╚███╔╝ ", " ██╔██╗ ", "██╔╝ ██╗", "╚═╝  ╚═╝"],
  Y: ["██╗   ██╗", "╚██╗ ██╔╝", " ╚████╔╝ ", "  ╚██╔╝  ", "   ██║   ", "   ╚═╝   "],
  Z: ["███████╗", "╚══███╔╝", "  ███╔╝ ", " ███╔╝  ", "███████╗", "╚══════╝"],
  "0": [" ██████╗ ", "██╔═████╗", "██║██╔██║", "████╔╝██║", "╚██████╔╝", " ╚═════╝ "],
  "1": [" ██╗", "███║", "╚██║", " ██║", " ██║", " ╚═╝"],
  "2": ["██████╗ ", "╚════██╗", " █████╔╝", "██╔═══╝ ", "███████╗", "╚══════╝"],
  "3": ["██████╗ ", "╚════██╗", " █████╔╝", " ╚═══██╗", "██████╔╝", "╚═════╝ "],
  "4": ["██╗  ██╗", "██║  ██║", "███████║", "╚════██║", "     ██║", "     ╚═╝"],
  "5": ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
  "6": [" ██████╗ ", "██╔════╝ ", "███████╗ ", "██╔═══██╗", "╚██████╔╝", " ╚═════╝ "],
  "7": ["███████╗", "╚════██║", "    ██╔╝", "   ██╔╝ ", "   ██║  ", "   ╚═╝  "],
  "8": [" █████╗ ", "██╔══██╗", "╚█████╔╝", "██╔══██╗", "╚█████╔╝", " ╚════╝ "],
  "9": [" █████╗ ", "██╔══██╗", "╚██████║", " ╚═══██║", " █████╔╝", " ╚════╝ "],
  "-": ["      ", "      ", "█████╗", "╚════╝", "      ", "      "],
  "_": ["       ", "       ", "       ", "       ", "███████╗", "╚══════╝"],
  ".": ["   ", "   ", "   ", "   ", "██╗", "╚═╝"],
  " ": ["    ", "    ", "    ", "    ", "    ", "    "],
};

// ─────────────────────────────────────────────────────────────────────────
// COMPACT (narrow) font — solid-block (6 rows). `█`/`▀`/`▄`, no 3D outline;
// ~4-5 cols/char so "agent-connector" fits one line under 80 cols. The taller
// box keeps ambiguous letters legible — N a full-height diagonal, M two peaks +
// center join, W two valleys.
// ─────────────────────────────────────────────────────────────────────────

const COMPACT_FONT: Record<string, readonly string[]> = {
  A: [" ██ ", "█  █", "█  █", "████", "█  █", "█  █"],
  B: ["███ ", "█  █", "███ ", "█  █", "█  █", "███ "],
  C: [" ███", "█   ", "█   ", "█   ", "█   ", " ███"],
  D: ["███ ", "█  █", "█  █", "█  █", "█  █", "███ "],
  E: ["████", "█   ", "███ ", "█   ", "█   ", "████"],
  F: ["████", "█   ", "███ ", "█   ", "█   ", "█   "],
  G: [" ███", "█   ", "█ ██", "█  █", "█  █", " ███"],
  H: ["█  █", "█  █", "████", "█  █", "█  █", "█  █"],
  I: ["███", " █ ", " █ ", " █ ", " █ ", "███"],
  J: ["  ██", "   █", "   █", "   █", "█  █", " ██ "],
  K: ["█  █", "█ █ ", "██  ", "██  ", "█ █ ", "█  █"],
  L: ["█   ", "█   ", "█   ", "█   ", "█   ", "████"],
  M: ["█   █", "██ ██", "█ █ █", "█   █", "█   █", "█   █"],
  N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █", "█   █"],
  O: [" ██ ", "█  █", "█  █", "█  █", "█  █", " ██ "],
  P: ["███ ", "█  █", "█  █", "███ ", "█   ", "█   "],
  Q: [" ██ ", "█  █", "█  █", "█  █", "█ ██", " ███"],
  R: ["███ ", "█  █", "█  █", "███ ", "█ █ ", "█  █"],
  S: [" ███", "█   ", " ██ ", "   █", "   █", "███ "],
  T: ["███", " █ ", " █ ", " █ ", " █ ", " █ "],
  U: ["█  █", "█  █", "█  █", "█  █", "█  █", " ██ "],
  V: ["█   █", "█   █", "█   █", "█   █", " █ █ ", "  █  "],
  W: ["█   █", "█   █", "█   █", "█ █ █", "██ ██", "█   █"],
  X: ["█   █", " █ █ ", "  █  ", "  █  ", " █ █ ", "█   █"],
  Y: ["█   █", " █ █ ", "  █  ", "  █  ", "  █  ", "  █  "],
  Z: ["████", "   █", "  █ ", " █  ", "█   ", "████"],
  "0": [" ██ ", "█  █", "█ ██", "██ █", "█  █", " ██ "],
  "1": [" █ ", "██ ", " █ ", " █ ", " █ ", "███"],
  "2": [" ██ ", "█  █", "  █ ", " █  ", "█   ", "████"],
  "3": ["███ ", "   █", " ██ ", "   █", "   █", "███ "],
  "4": ["█  █", "█  █", "████", "   █", "   █", "   █"],
  "5": ["████", "█   ", "███ ", "   █", "   █", "███ "],
  "6": [" ███", "█   ", "███ ", "█  █", "█  █", " ██ "],
  "7": ["████", "   █", "  █ ", " █  ", " █  ", " █  "],
  "8": [" ██ ", "█  █", " ██ ", "█  █", "█  █", " ██ "],
  "9": [" ██ ", "█  █", "█  █", " ███", "   █", "███ "],
  "-": ["    ", "    ", "████", "    ", "    ", "    "],
  "_": ["    ", "    ", "    ", "    ", "    ", "████"],
  ".": ["  ", "  ", "  ", "  ", "  ", "██"],
  " ": ["  ", "  ", "  ", "  ", "  ", "  "],
};

const GLYPH_ROWS = 6;

/** Visible column count of a string (full-block + box-drawing are 1 cell each). */
function vlen(s: string): number {
  return [...s].length;
}

/**
 * Render `name` into a fixed-width glyph `font` as GLYPH_ROWS lines. Glyphs are
 * concatenated with `gap` blank columns between them: the COMPACT font needs a
 * 1-column gap to breathe, while the ANSI-Shadow glyphs already carry their own
 * trailing shadow column and tile cleanly with NO gap (a gap would only bloat
 * the width). Returns null when the name has no renderable characters; each
 * font's glyphs are width-consistent per glyph, so the rows stay aligned.
 */
function renderWithFont(
  name: string,
  font: Record<string, readonly string[]>,
  gap: number,
): string[] | null {
  const chars = [...name];
  if (chars.length === 0) return null;
  const blank = font[" "]!;
  const sep = " ".repeat(gap);
  const rows: string[] = Array.from({ length: GLYPH_ROWS }, () => "");
  for (let ci = 0; ci < chars.length; ci++) {
    const glyph = font[chars[ci]!.toUpperCase()] ?? blank;
    const lead = ci === 0 ? "" : sep;
    for (let r = 0; r < GLYPH_ROWS; r++) {
      rows[r] += lead + (glyph[r] ?? "");
    }
  }
  // Drop any fully-blank bottom rows so a name built from narrower glyphs (e.g.
  // "." / "_") never pads the banner with trailing empty lines.
  while (rows.length > 1 && rows[rows.length - 1]!.trim() === "") rows.pop();
  return rows;
}

/** Max visible width across an art block's rows. */
function blockWidth(rows: string[]): number {
  return rows.length === 0 ? 0 : Math.max(...rows.map(vlen));
}

/**
 * Pick the art for `name` that fits `columns`, ONE line, never stacked: the WIDE
 * ANSI-Shadow font when it fits, else the COMPACT font when it fits, else null
 * (the caller degrades to a one-line styled `» name`). `columns <= 0` means "no
 * constraint" → the WIDE font.
 */
function selectArt(name: string, columns: number): string[] | null {
  const limit = columns > 0 ? columns : Infinity;
  // WIDE ANSI-Shadow tiles gap-free (glyphs self-space); COMPACT needs a 1-col gap.
  const wide = renderWithFont(name, WIDE_FONT, 0);
  if (wide != null && blockWidth(wide) <= limit) return wide;
  const compact = renderWithFont(name, COMPACT_FONT, 1);
  if (compact != null && blockWidth(compact) <= limit) return compact;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Palette-parameterized gradient. The sweep lerps the three palette stops
// across each row's columns (t∈[0,1]). truecolor uses the exact RGB; 256 and 16
// derive the nearest representable code FROM the same RGB, so every palette
// works in every tier. "none" emits the bare char.
// ─────────────────────────────────────────────────────────────────────────

/** The interpolated RGB of `palette` at gradient position t∈[0,1]. */
function gradientRGB(t: number, palette: Palette): RGB {
  const clamp = Math.max(0, Math.min(1, t));
  const seg = clamp >= 0.5 ? 1 : 0;
  const local = (clamp - seg * 0.5) / 0.5;
  const a = palette[seg]!;
  const b = palette[seg + 1]!;
  return [
    Math.round(a[0] + (b[0] - a[0]) * local),
    Math.round(a[1] + (b[1] - a[1]) * local),
    Math.round(a[2] + (b[2] - a[2]) * local),
  ];
}

/** Nearest xterm-256 cube index (16..231) for an RGB triple. */
function rgbTo256(r: number, g: number, b: number): number {
  const q = (v: number): number => (v < 48 ? 0 : v < 115 ? 1 : Math.round((v - 35) / 40));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** Nearest of the 8 bright 16-color fg codes (90..97) for an RGB triple. */
function rgbTo16(r: number, g: number, b: number): number {
  // Threshold each channel; map the on/off triple to its bright SGR code.
  const hi = (v: number): number => (v >= 128 ? 1 : 0);
  const key = (hi(r) << 2) | (hi(g) << 1) | hi(b);
  // index: RGB bits → code. 0:black(90) 1:blue(94) 2:green(92) 3:cyan(96)
  //        4:red(91) 5:magenta(95) 6:yellow(93) 7:white(97)
  return [90, 94, 92, 96, 91, 95, 93, 97][key]!;
}

const RESET = "\x1b[0m";

/**
 * Wrap a single grapheme `ch` at gradient position `t` in the SGR escape for the
 * given color tier + palette. Whitespace is never colored (no point paying for
 * an escape around a space) and "none" returns the bare char.
 */
function colorChar(ch: string, t: number, color: ColorMode, palette: Palette): string {
  if (color === "none" || ch.trim() === "") return ch;
  const [r, g, b] = gradientRGB(t, palette);
  if (color === "truecolor") return `\x1b[38;2;${r};${g};${b}m${ch}${RESET}`;
  if (color === "ansi256") return `\x1b[38;5;${rgbTo256(r, g, b)}m${ch}${RESET}`;
  return `\x1b[${rgbTo16(r, g, b)}m${ch}${RESET}`;
}

/** Apply the left-to-right gradient across one art row (by visible column). */
function colorizeRow(row: string, color: ColorMode, palette: Palette): string {
  if (color === "none") return row;
  const chars = [...row];
  const width = Math.max(1, chars.length - 1);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    out += colorChar(chars[i]!, i / width, color, palette);
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
 * Render the full banner: the responsive block-font brand name with a
 * palette-driven gradient, then a two-line dim footer directly below.
 *
 *   • Font is selected by width (WIDE ANSI-Shadow → COMPACT → one-line degrade),
 *     ALWAYS one line, never stacked. `columns <= 0` means "no constraint".
 *   • `palette` defaults to PALETTES[0] so direct callers + tests are
 *     deterministic; the impure app.ts wrapper rotates the palettes per run.
 *   • Under `color: "none"` (NO_COLOR / dumb term) the output carries zero ANSI
 *     escape codes — only the raw art + footer text.
 *
 * The result has NO trailing newline; the caller prints it with one.
 */
export function renderBrandBanner(name: string, opts: BannerOptions): string {
  const { color, columns } = opts;
  const palette = opts.palette ?? PALETTES[0]!;
  const footer = FOOTER_LINES.map((l) => dim(l, color)).join("\n");

  const art = selectArt(name, columns);
  if (art == null) {
    // Degrade to a single styled line when neither font fits (a very narrow
    // terminal) or the name has no renderable characters.
    const lead = color === "none" ? "» " : colorChar("▌", 0, color, palette) + " ";
    const line = color === "none" ? `» ${name}` : `${lead}${colorizeRow(name, color, palette)}`;
    return `${line}\n${footer}`;
  }

  const body = art.map((row) => colorizeRow(row, color, palette)).join("\n");
  return `${body}\n${footer}`;
}
