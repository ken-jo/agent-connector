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
 * The art is a hand-transcribed, dependency-free 6-row BOLD block font in the
 * "ANSI Shadow" figlet style (solid `█` glyphs with a `╗╔╝╚║═` 3D outline) over
 * [A-Za-z0-9 ._-] — the connector-id charset — so a kebab-case brand
 * ("agent-connector") and an arbitrary SDK brand ("acme") both render legibly,
 * with every letter unmistakable. A long name is STACKED at its separators
 * (`AGENT-` over `CONNECTOR`) so each big-font line fits the terminal; only a
 * single un-splittable token that is still too wide falls back to a one-line
 * styled degrade.
 */

/** Color capability the host terminal advertises, highest → lowest. */
export type ColorMode = "truecolor" | "ansi256" | "ansi16" | "none";

/** Inputs to {@link renderBrandBanner} — all injected, never read from process. */
export interface BannerOptions {
  /** Color capability to render at. "none" emits zero ANSI codes. */
  color: ColorMode;
  /** Terminal width in columns; long names stack/degrade to fit this. */
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
// ANSI Shadow font (6 rows). Hand-transcribed bold figlet glyphs — solid `█`
// blocks with a `╗╔╝╚║═` 3D shadow outline — covering the connector-id charset
// [A-Za-z0-9 ._-] (uppercased; lowercase reuses caps). Each glyph's 6 rows are
// internally width-consistent so the columns align when concatenated. Unknown
// chars fall back to the blank glyph.
// ─────────────────────────────────────────────────────────────────────────

const GLYPH_ROWS = 6;

/** Glyph map: char → 6 ANSI-Shadow rows (width-consistent within each glyph). */
const FONT: Record<string, readonly string[]> = {
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

/** The blank fallback used for any char outside the FONT charset. */
const BLANK = FONT[" "]!;

/** Visible column count of a string (full-block + box-drawing are 1 cell each). */
function vlen(s: string): number {
  return [...s].length;
}

/** Pad a glyph's rows to its own max width so concatenation stays column-aligned. */
function normalizeGlyph(rows: readonly string[]): string[] {
  const w = Math.max(...rows.map(vlen));
  return rows.map((r) => r + " ".repeat(w - vlen(r)));
}

/**
 * Render a SINGLE-LINE token (no separators) into the 6-row font as an array of
 * GLYPH_ROWS equal-length lines. The ANSI-Shadow glyphs already carry their own
 * side spacing (a trailing `╗`/space column), so they are concatenated with NO
 * extra inter-glyph gap — which keeps a 9-letter word like "connector" inside an
 * 80-column terminal while still reading cleanly. Returns null when the token
 * has no renderable characters.
 */
function renderTokenRows(token: string): string[] | null {
  const chars = [...token];
  if (chars.length === 0) return null;
  const rows: string[] = Array.from({ length: GLYPH_ROWS }, () => "");
  for (const ch of chars) {
    const glyph = normalizeGlyph(FONT[ch.toUpperCase()] ?? BLANK);
    for (let r = 0; r < GLYPH_ROWS; r++) {
      rows[r] += glyph[r] ?? "";
    }
  }
  return rows;
}

/** Max visible width across an art block's rows. */
function blockWidth(rows: string[]): number {
  return rows.length === 0 ? 0 : Math.max(...rows.map(vlen));
}

/** Right-pad every row of a block to a common width so rainbow columns line up. */
function padBlock(rows: string[], width: number): string[] {
  return rows.map((r) => r + " ".repeat(Math.max(0, width - vlen(r))));
}

/**
 * Split a brand name into render segments at its separators, KEEPING a trailing
 * separator on the segment it followed (so "agent-connector" → ["AGENT-",
 * "CONNECTOR"] renders the dash on the first stacked line). A leading/standalone
 * separator stays attached to the following token.
 */
function splitAtSeparators(name: string): string[] {
  // Split on a boundary AFTER each run of separators, keeping the separators.
  const segments: string[] = [];
  let cur = "";
  for (const ch of name) {
    cur += ch;
    if (ch === "-" || ch === "_" || ch === " ") {
      // Close the segment here only if it has a non-separator char before this
      // run (avoids empty leading segments for names starting with a separator).
      if (/[^\-_ ]/.test(cur)) {
        segments.push(cur);
        cur = "";
      }
    }
  }
  if (cur !== "") segments.push(cur);
  return segments.length > 0 ? segments : [name];
}

/**
 * Build the big-font art for `name`, fitting `columns`:
 *   • one line when it fits;
 *   • else STACKED at separators — each segment on its own 6-row block, blocks
 *     concatenated vertically (a blank spacer row between stacks), each block
 *     left-aligned and padded to the widest stacked block so the rainbow sweep
 *     stays column-consistent;
 *   • returns null when even the per-segment art can't be built (caller degrades).
 *
 * `columns <= 0` means "no constraint" (never stack).
 */
function renderArt(name: string, columns: number): string[] | null {
  const single = renderTokenRows(name);
  if (single == null) return null;
  const limit = columns > 0 ? columns : Infinity;
  if (blockWidth(single) <= limit) return single;

  // Too wide → stack at separators. Render each segment; if any single segment
  // is STILL too wide (an un-splittable long token), bail to the degrade path.
  const segments = splitAtSeparators(name);
  if (segments.length <= 1) return null;

  const blocks: string[][] = [];
  for (const seg of segments) {
    const rows = renderTokenRows(seg);
    if (rows == null) continue;
    if (blockWidth(rows) > limit) return null; // a lone token overflows → degrade
    blocks.push(rows);
  }
  if (blocks.length === 0) return null;

  const width = Math.max(...blocks.map(blockWidth));
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) out.push(" ".repeat(width)); // blank spacer between stacks
    out.push(...padBlock(blocks[i]!, width));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Vivid full-spectrum RAINBOW gradient. A smooth HSL hue sweep across the
// banner columns (red→orange→yellow→green→cyan→blue→violet) at max saturation,
// so adjacent letters show punchy, clearly-different colors. Each tier emits the
// closest representable escape; "none" emits the bare char.
// ─────────────────────────────────────────────────────────────────────────

/** HSL→RGB (h in [0,360), s/l in [0,1]) → 24-bit triple. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

/** Hue (degrees) at gradient position t∈[0,1]: red(0)→violet(300), vivid. */
function hueAt(t: number): number {
  return Math.max(0, Math.min(1, t)) * 300;
}

/** The vivid rainbow RGB at position t (max saturation, bright). */
function rainbowRGB(t: number): [number, number, number] {
  return hslToRgb(hueAt(t), 1, 0.55);
}

/** Map a rainbow position to one of the 16-color bright fg codes (6-hue wheel). */
function ansi16At(t: number): number {
  // 91 red · 93 yellow · 92 green · 96 cyan · 94 blue · 95 magenta — a full wheel.
  const wheel = [91, 93, 92, 96, 94, 95];
  const i = Math.min(wheel.length - 1, Math.max(0, Math.round(t * (wheel.length - 1))));
  return wheel[i]!;
}

/** Map a rainbow position to a 256-color cube index along the hue wheel. */
function ansi256At(t: number): number {
  // A vivid 256-cube rainbow ramp: red→orange→yellow→green→cyan→blue→violet.
  const ramp = [196, 202, 208, 214, 220, 226, 190, 118, 46, 48, 51, 45, 39, 33, 27, 57, 93, 129, 165, 201];
  const i = Math.min(ramp.length - 1, Math.max(0, Math.round(t * (ramp.length - 1))));
  return ramp[i]!;
}

const RESET = "\x1b[0m";

/**
 * Wrap a single grapheme `ch` at rainbow position `t` in the SGR escape for the
 * given color tier. Whitespace is never colored (no point paying for an escape
 * around a space) and "none" returns the bare char.
 */
function colorChar(ch: string, t: number, color: ColorMode): string {
  if (color === "none" || ch.trim() === "") return ch;
  if (color === "truecolor") {
    const [r, g, b] = rainbowRGB(t);
    return `\x1b[38;2;${r};${g};${b}m${ch}${RESET}`;
  }
  if (color === "ansi256") {
    return `\x1b[38;5;${ansi256At(t)}m${ch}${RESET}`;
  }
  return `\x1b[${ansi16At(t)}m${ch}${RESET}`;
}

/**
 * Apply the rainbow sweep across one art row by ABSOLUTE column, using a shared
 * `width` so every stacked line maps the same column to the same hue (a coherent
 * vertical rainbow). `width` is the widest row in the block.
 */
function colorizeRow(row: string, color: ColorMode, width: number): string {
  if (color === "none") return row;
  const chars = [...row];
  const span = Math.max(1, width - 1);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    out += colorChar(chars[i]!, i / span, color);
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
 * Render the full banner: the big ANSI-Shadow brand name with a vivid rainbow
 * hue sweep, then a two-line dim footer directly below. Width-safe:
 *
 *   • One line when it fits `columns`; else STACKED at separators (each segment
 *     a 6-row block on its own line, e.g. AGENT- over CONNECTOR).
 *   • A single un-splittable token still too wide → a one-line styled degrade
 *     (`▌ <name>`) rather than a mangled wrap.
 *   • Under `color: "none"` (NO_COLOR / dumb term) the output carries zero ANSI
 *     escape codes — only the raw art + footer text.
 *
 * The result has NO trailing newline; the caller prints it with one.
 */
export function renderBrandBanner(name: string, opts: BannerOptions): string {
  const { color, columns } = opts;
  const footer = FOOTER_LINES.map((l) => dim(l, color)).join("\n");

  const art = renderArt(name, columns);
  if (art == null) {
    // Degrade to a single styled line (no art, or an un-splittable over-wide
    // token). A 0/unknown `columns` is treated as "no constraint" upstream.
    const lead = color === "none" ? "» " : colorChar("▌", 0, color) + " ";
    const nameWidth = Math.max(1, vlen(name));
    const line = color === "none" ? `${lead}${name}` : `${lead}${colorizeRow(name, color, nameWidth)}`;
    return `${line}\n${footer}`;
  }

  const width = blockWidth(art);
  const body = art.map((row) => colorizeRow(row, color, width)).join("\n");
  return `${body}\n${footer}`;
}
