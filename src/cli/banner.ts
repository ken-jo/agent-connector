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
 * The art is a hand-rolled COMPACT 5-row block font (no figlet dependency,
 * dependency-free) covering [A-Za-z0-9 ._-] — the connector-id charset — so a
 * kebab-case brand ("agent-connector") and an arbitrary SDK brand ("acme") both
 * render. When the rendered art would overflow the terminal width it degrades
 * gracefully (a single styled line) rather than mangling a wrap.
 */

/** Color capability the host terminal advertises, highest → lowest. */
export type ColorMode = "truecolor" | "ansi256" | "ansi16" | "none";

/** Inputs to {@link renderBrandBanner} — all injected, never read from process. */
export interface BannerOptions {
  /** Color capability to render at. "none" emits zero ANSI codes. */
  color: ColorMode;
  /** Terminal width in columns; the art degrades to one line when it overflows. */
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
// Compact block font (5 rows). Each glyph is 5 lines; widths vary so the art
// stays tight. Unknown chars fall back to the blank glyph. Charset chosen to
// cover a connector id: [A-Za-z0-9 ._-] (uppercased — lowercase reuses caps).
// ─────────────────────────────────────────────────────────────────────────

const GLYPH_ROWS = 5;

/** Glyph map: char → 5 rows drawn with half/full-block + space (caps + digits). */
const FONT: Record<string, readonly string[]> = {
  A: ["█▀█", "█▀█", "▀ ▀", "   ", "   "],
  B: ["█▀▄", "█▀▄", "▀▀ ", "   ", "   "],
  C: ["█▀▀", "█  ", "▀▀▀", "   ", "   "],
  D: ["█▀▄", "█ █", "▀▀ ", "   ", "   "],
  E: ["█▀▀", "█▀ ", "▀▀▀", "   ", "   "],
  F: ["█▀▀", "█▀ ", "▀  ", "   ", "   "],
  G: ["█▀▀", "█ █", "▀▀▀", "   ", "   "],
  H: ["█ █", "█▀█", "▀ ▀", "   ", "   "],
  I: ["█", "█", "▀", " ", " "],
  J: ["  █", "  █", "▀▀ ", "   ", "   "],
  K: ["█ █", "██ ", "▀ ▀", "   ", "   "],
  L: ["█  ", "█  ", "▀▀▀", "   ", "   "],
  M: ["█▄█", "█▀█", "▀ ▀", "   ", "   "],
  N: ["█▄█", "█ █", "▀ ▀", "   ", "   "],
  O: ["█▀█", "█ █", "▀▀▀", "   ", "   "],
  P: ["█▀█", "█▀▀", "▀  ", "   ", "   "],
  Q: ["█▀█", "█ █", "▀▀█", "   ", "   "],
  R: ["█▀█", "██ ", "▀ ▀", "   ", "   "],
  S: ["█▀▀", "▀▀█", "▀▀▀", "   ", "   "],
  T: ["▀█▀", " █ ", " ▀ ", "   ", "   "],
  U: ["█ █", "█ █", "▀▀▀", "   ", "   "],
  V: ["█ █", "█ █", " ▀ ", "   ", "   "],
  W: ["█ █", "█ █", "▀█▀", "   ", "   "],
  X: ["█ █", " █ ", "█ █", "   ", "   "],
  Y: ["█ █", " █ ", " █ ", "   ", "   "],
  Z: ["▀▀█", " █ ", "█▀▀", "   ", "   "],
  "0": ["█▀█", "█ █", "▀▀▀", "   ", "   "],
  "1": [" █", " █", " ▀", "  ", "  "],
  "2": ["▀▀█", "█▀▀", "▀▀▀", "   ", "   "],
  "3": ["▀▀█", " ▀█", "▀▀▀", "   ", "   "],
  "4": ["█ █", "▀▀█", "  ▀", "   ", "   "],
  "5": ["█▀▀", "▀▀█", "▀▀▀", "   ", "   "],
  "6": ["█▀▀", "█▀█", "▀▀▀", "   ", "   "],
  "7": ["▀▀█", "  █", "  ▀", "   ", "   "],
  "8": ["█▀█", "█▀█", "▀▀▀", "   ", "   "],
  "9": ["█▀█", "▀▀█", "▀▀▀", "   ", "   "],
  "-": ["   ", "▀▀▀", "   ", "   ", "   "],
  "_": ["   ", "   ", "▀▀▀", "   ", "   "],
  ".": [" ", " ", "▄", " ", " "],
  " ": ["  ", "  ", "  ", "  ", "  "],
};

/** The blank fallback used for any char outside the FONT charset. */
const BLANK = FONT[" "]!;

/**
 * Render the brand name into the compact block font as an array of GLYPH_ROWS
 * equal-length lines (glyphs joined with a single-column gap). Returns null when
 * the name has no renderable characters.
 */
function renderArtRows(name: string): string[] | null {
  const chars = [...name];
  if (chars.length === 0) return null;
  const rows: string[] = Array.from({ length: GLYPH_ROWS }, () => "");
  for (let ci = 0; ci < chars.length; ci++) {
    const ch = chars[ci]!;
    const glyph = FONT[ch.toUpperCase()] ?? BLANK;
    const gap = ci === 0 ? "" : " ";
    for (let r = 0; r < GLYPH_ROWS; r++) {
      rows[r] += gap + (glyph[r] ?? "");
    }
  }
  // Drop fully-blank bottom rows so short fonts don't pad the banner with empty
  // lines (the font reserves 5 rows for descenders; most glyphs use 3).
  while (rows.length > 1 && rows[rows.length - 1]!.trim() === "") rows.pop();
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// Color gradient. A static cyan → blue → magenta sweep left-to-right across
// each row, so the art reads "cool" without depending on the brand. Each tier
// emits the closest representable escape; "none" emits the bare char.
// ─────────────────────────────────────────────────────────────────────────

/** A point on the cyan→blue→magenta gradient as a 24-bit RGB triple. */
function gradientRGB(t: number): [number, number, number] {
  // t in [0,1]. Two-segment lerp: cyan(0,200,200) → blue(40,80,230) → magenta(200,40,200).
  const clamp = Math.max(0, Math.min(1, t));
  const stops: Array<[number, number, number]> = [
    [0, 200, 200],
    [40, 80, 230],
    [200, 40, 200],
  ];
  const seg = clamp >= 0.5 ? 1 : 0;
  const local = (clamp - seg * 0.5) / 0.5;
  const a = stops[seg]!;
  const b = stops[seg + 1]!;
  return [
    Math.round(a[0] + (b[0] - a[0]) * local),
    Math.round(a[1] + (b[1] - a[1]) * local),
    Math.round(a[2] + (b[2] - a[2]) * local),
  ];
}

/** Map a 0..1 gradient position to one of the cool 16-color fg codes. */
function ansi16At(t: number): number {
  // 96 = bright cyan, 94 = bright blue, 95 = bright magenta.
  if (t < 0.34) return 96;
  if (t < 0.67) return 94;
  return 95;
}

/** Map a 0..1 gradient position to a 256-color cube index (cool band). */
function ansi256At(t: number): number {
  // A hand-picked cool ramp: cyan → blue → magenta within the 16..231 cube.
  const ramp = [51, 45, 39, 33, 27, 63, 99, 129, 165, 201];
  const i = Math.min(ramp.length - 1, Math.max(0, Math.round(t * (ramp.length - 1))));
  return ramp[i]!;
}

const RESET = "\x1b[0m";

/**
 * Wrap a single grapheme `ch` at gradient position `t` in the SGR escape for the
 * given color tier. Whitespace is never colored (no point paying for an escape
 * around a space) and "none" returns the bare char.
 */
function colorChar(ch: string, t: number, color: ColorMode): string {
  if (color === "none" || ch.trim() === "") return ch;
  if (color === "truecolor") {
    const [r, g, b] = gradientRGB(t);
    return `\x1b[38;2;${r};${g};${b}m${ch}${RESET}`;
  }
  if (color === "ansi256") {
    return `\x1b[38;5;${ansi256At(t)}m${ch}${RESET}`;
  }
  return `\x1b[${ansi16At(t)}m${ch}${RESET}`;
}

/** Apply the left-to-right gradient across one art row (by visible column). */
function colorizeRow(row: string, color: ColorMode): string {
  if (color === "none") return row;
  const chars = [...row];
  const width = Math.max(1, chars.length - 1);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    out += colorChar(chars[i]!, i / width, color);
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
 * Render the full banner: the big block-font brand name with a cool cyan→blue→
 * magenta gradient, then a two-line dim footer directly below. Width-safe:
 *
 *   • Reads `columns` (injected) and, when the block art would overflow, degrades
 *     to a SINGLE styled line (`▌ <name>`) rather than a mangled wrap.
 *   • Under `color: "none"` (NO_COLOR / dumb term) the output carries zero ANSI
 *     escape codes — only the raw art + footer text.
 *
 * The result has NO trailing newline; the caller prints it with one.
 */
export function renderBrandBanner(name: string, opts: BannerOptions): string {
  const { color, columns } = opts;
  const art = renderArtRows(name);

  const footer = FOOTER_LINES.map((l) => dim(l, color)).join("\n");

  // Degrade to a single styled line when there is no art, or when the art is
  // wider than the terminal (a long brand name) — a mangled wrap is worse than a
  // compact one-liner. A 0/unknown `columns` is treated as "no constraint".
  const artWidth = art ? Math.max(...art.map((r) => [...r].length)) : 0;
  const fits = art != null && (columns <= 0 || artWidth <= columns);

  if (!fits) {
    const bar = color === "none" ? "" : colorChar("▌", 0, color) + " ";
    const lead = color === "none" ? "» " : bar;
    const line = color === "none" ? `${lead}${name}` : `${lead}${colorizeRow(name, color)}`;
    return `${line}\n${footer}`;
  }

  const body = art.map((row) => colorizeRow(row, color)).join("\n");
  return `${body}\n${footer}`;
}
