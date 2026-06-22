/**
 * tests/cli/banner — the branded ASCII header + powered-by footer.
 *
 * Pure unit tests over the injected functions (no real TTY, no process.*):
 *   • renderBrandBanner(name, { color, columns, palette }) → the banner string
 *   • shouldShowBanner({ isTTY, noColor, json, quiet }) → gating boolean
 *   • resolveColorMode(...) → the color tier from the (injected) terminal env
 *
 * Covers: RESPONSIVE one-line font selection (WIDE ANSI-Shadow on a wide
 * terminal, the COMPACT 6-row solid-block on 80 cols, a `» name` degrade when
 * neither fits) — never stacked; distinct letters (M ≠ N ≠ W); the footer; the
 * palette-parameterized gradient (each {@link PALETTES} entry honored across the
 * truecolor→256→16 tiers); NO_COLOR = zero ANSI.
 */

import { describe, expect, it } from "vitest";

import {
  PALETTES,
  renderBrandBanner,
  resolveColorMode,
  shouldShowBanner,
} from "../../src/cli/banner.js";

/** Count visible columns of a string (grapheme/code-point count). */
function cols(line: string): number {
  return [...line].length;
}

/** Any ANSI SGR escape (color, dim, reset). */
const ANSI = /\x1b\[[0-9;]*m/;
/** The WIDE (ANSI-Shadow) font's 3D-shadow box-drawing glyphs. */
const SHADOW = /[╗╔╝╚║═]/;
/** Art rows only (drop the two footer lines). */
function artLines(out: string): string[] {
  return out
    .split("\n")
    .filter((l) => !l.startsWith("powered by") && !l.startsWith("more →"));
}

describe("renderBrandBanner — responsive font selection (one line, never stacked)", () => {
  it("uses the WIDE ANSI-Shadow font on a wide terminal (columns:140)", () => {
    const out = renderBrandBanner("agent-connector", { color: "none", columns: 140 });
    const art = artLines(out);
    // The ANSI-Shadow font is recognizable by its ╗╔╝╚║═ 3D shadow glyphs…
    expect(out).toMatch(SHADOW);
    // …it is 6 rows on ONE line (no stacking) and visibly WIDE (>100 cols).
    expect(art.length).toBe(6);
    expect(Math.max(...art.map(cols))).toBeGreaterThan(100);
    for (const line of art) expect(cols(line)).toBeLessThanOrEqual(140);
    expect(out).toContain("powered by @ken-jo/agent-connector");
    expect(out).toContain("more → https://github.com/ken-jo/agent-connector");
  });

  it("falls to the COMPACT 6-row font on an 80-column terminal", () => {
    const out = renderBrandBanner("agent-connector", { color: "none", columns: 80 });
    const art = artLines(out);
    // Compact solid-block art — NO ANSI-Shadow box-drawing — ONE 6-row block ≤80.
    expect(out).not.toMatch(SHADOW);
    expect(out).toMatch(/[█▀▄]/);
    expect(art.length).toBe(6);
    for (const line of art) expect(cols(line)).toBeLessThanOrEqual(80);
    expect(out).not.toContain("» ");
  });

  it("degrades to a single styled `» name` line on a very narrow terminal (columns:20)", () => {
    const out = renderBrandBanner("agent-connector", { color: "none", columns: 20 });
    const art = artLines(out);
    expect(art.length).toBe(1);
    expect(art[0]).toBe("» agent-connector");
    expect(out).toContain("powered by @ken-jo/agent-connector");
  });

  it("renders an SDK brand ('acme') — compact at 80, wide at 140", () => {
    expect(artLines(renderBrandBanner("acme", { color: "none", columns: 80 }))).toHaveLength(6);
    expect(renderBrandBanner("acme", { color: "none", columns: 140 })).toMatch(SHADOW);
  });

  it("renders distinct letters with DISTINCT art (legibility: M ≠ N ≠ W, A ≠ B)", () => {
    // Compare in the COMPACT font (80 cols) where the glyphs are hand-authored.
    const art = (s: string) =>
      artLines(renderBrandBanner(s, { color: "none", columns: 80 })).join("\n");
    expect(art("M")).not.toBe(art("N"));
    expect(art("N")).not.toBe(art("W"));
    expect(art("M")).not.toBe(art("W"));
    expect(art("A")).not.toBe(art("B"));
  });

  it("shows the powered-by footer on BOTH global and branded banners", () => {
    const global = renderBrandBanner("agent-connector", { color: "none", columns: 80 });
    const branded = renderBrandBanner("acme-db", { color: "none", columns: 80 });
    expect(global).toContain("powered by @ken-jo/agent-connector");
    expect(branded).toContain("powered by @ken-jo/agent-connector");
  });

  it("degrades (rather than throws) on an empty name", () => {
    const out = renderBrandBanner("", { color: "none", columns: 80 });
    expect(out).toContain("powered by @ken-jo/agent-connector");
  });
});

describe("renderBrandBanner — palette gradient", () => {
  it("emits NO ANSI color codes under color:'none' (NO_COLOR) for any palette", () => {
    for (const palette of PALETTES) {
      const out = renderBrandBanner("agent-connector", { color: "none", columns: 80, palette });
      expect(out).not.toContain("\x1b");
      expect(ANSI.test(out)).toBe(false);
    }
  });

  it("defaults to PALETTES[0] (Sunset) when no palette is passed (deterministic)", () => {
    const def = renderBrandBanner("acme", { color: "truecolor", columns: 80 });
    const sunset = renderBrandBanner("acme", { color: "truecolor", columns: 80, palette: PALETTES[0] });
    expect(def).toBe(sunset);
  });

  it("honors the Sunset palette: a per-column sweep spanning yellow → red", () => {
    const out = renderBrandBanner("acme", { color: "truecolor", columns: 140, palette: PALETTES[0] });
    expect(out).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    expect(out).toContain("\x1b[0m");
    const rgb = [
      ...new Set([...out.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m/g)].map((mm) => mm[1])),
    ].map((s) => s!.split(";").map(Number) as [number, number, number]);
    // A real sweep yields many distinct hues (not one solid color).
    expect(rgb.length).toBeGreaterThanOrEqual(6);
    // Sunset spans yellow-ish (R&G high, B low) → red-ish (R high, G&B low).
    expect(rgb.some(([r, g, b]) => r > 200 && g > 150 && b < 80)).toBe(true);
    expect(rgb.some(([r, g, b]) => r > 180 && g < 80 && b < 80)).toBe(true);
  });

  it("honors a cool palette (Ocean) distinctly from a warm one (Sunset)", () => {
    const firstHue = (palette: typeof PALETTES[number]) =>
      renderBrandBanner("acme", { color: "truecolor", columns: 140, palette }).match(
        /\x1b\[38;2;(\d+;\d+;\d+)m/,
      )?.[1];
    expect(firstHue(PALETTES[6]!)).not.toBe(firstHue(PALETTES[0]!)); // Ocean ≠ Sunset
    const ocean = renderBrandBanner("acme", { color: "truecolor", columns: 140, palette: PALETTES[6] });
    const rgb = [
      ...new Set([...ocean.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m/g)].map((mm) => mm[1])),
    ].map((s) => s!.split(";").map(Number) as [number, number, number]);
    expect(rgb.some(([, , b]) => b > 180)).toBe(true); // blue-dominant somewhere
  });

  it("exposes exactly 10 valid 3-stop palettes", () => {
    expect(PALETTES).toHaveLength(10);
    for (const p of PALETTES) {
      expect(p).toHaveLength(3);
      for (const stop of p) {
        expect(stop).toHaveLength(3);
        for (const ch of stop) expect(ch).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("derives 256-color (38;5;n) escapes from the palette under color:'ansi256'", () => {
    const out = renderBrandBanner("acme", { color: "ansi256", columns: 80, palette: PALETTES[2] });
    expect(out).toMatch(/\x1b\[38;5;\d+m/);
  });

  it("derives 16-color fg escapes from the palette under color:'ansi16'", () => {
    const out = renderBrandBanner("acme", { color: "ansi16", columns: 80, palette: PALETTES[2] });
    expect(out).toMatch(/\x1b\[9[0-7]m/);
  });
});

describe("shouldShowBanner", () => {
  it("is true ONLY for an interactive TTY with no json/quiet", () => {
    expect(shouldShowBanner({ isTTY: true, noColor: false, json: false, quiet: false })).toBe(true);
  });

  it("is false when stdout is not a TTY (piped/redirected)", () => {
    expect(shouldShowBanner({ isTTY: false, noColor: false, json: false, quiet: false })).toBe(false);
  });

  it("is false under --json (machine output)", () => {
    expect(shouldShowBanner({ isTTY: true, noColor: false, json: true, quiet: false })).toBe(false);
  });

  it("is false under --quiet", () => {
    expect(shouldShowBanner({ isTTY: true, noColor: false, json: false, quiet: true })).toBe(false);
  });

  it("still shows under NO_COLOR (color is dropped, not the banner)", () => {
    expect(shouldShowBanner({ isTTY: true, noColor: true, json: false, quiet: false })).toBe(true);
  });
});

describe("resolveColorMode", () => {
  it("returns 'none' under NO_COLOR even with a truecolor terminal", () => {
    expect(resolveColorMode({ noColor: true, colorterm: "truecolor", term: "xterm-256color" })).toBe("none");
  });

  it("returns 'truecolor' when COLORTERM advertises it", () => {
    expect(resolveColorMode({ noColor: false, colorterm: "truecolor", term: "xterm" })).toBe("truecolor");
    expect(resolveColorMode({ noColor: false, colorterm: "24bit", term: "xterm" })).toBe("truecolor");
  });

  it("returns 'ansi256' for a 256-color TERM", () => {
    expect(resolveColorMode({ noColor: false, term: "xterm-256color" })).toBe("ansi256");
  });

  it("returns 'ansi16' for a basic color TERM", () => {
    expect(resolveColorMode({ noColor: false, term: "xterm" })).toBe("ansi16");
  });

  it("returns 'none' for a dumb / absent terminal", () => {
    expect(resolveColorMode({ noColor: false, term: "dumb" })).toBe("none");
    expect(resolveColorMode({ noColor: false, term: "" })).toBe("none");
    expect(resolveColorMode({ noColor: false })).toBe("none");
  });
});
