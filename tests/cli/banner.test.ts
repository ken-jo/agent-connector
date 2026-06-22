/**
 * tests/cli/banner — the branded ASCII header + powered-by footer.
 *
 * Pure unit tests over the two injected functions (no real TTY, no process.*):
 *   • renderBrandBanner(name, { color, columns }) → the banner string
 *   • shouldShowBanner({ isTTY, noColor, json, quiet }) → gating boolean
 *   • resolveColorMode(...) → the color tier from the (injected) terminal env
 *
 * Covers: the compact 3-row solid-block art renders legibly (distinct letters
 * look different) and "agent-connector" fits ONE line at 80 cols (no stacking),
 * the footer is present, NO_COLOR/"none" emits zero ANSI codes, and in color
 * mode each whole letter is ONE solid soft-PASTEL color (no white-highlight row);
 * both a kebab name ("agent-connector") and an SDK brand ("acme") render; a
 * genuinely un-fittable token degrades to one styled line.
 */

import { describe, expect, it } from "vitest";

import {
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
/** The solid-block glyph the compact art is built from. */
const ART_GLYPH = /█/;
/** Art rows only (drop the two footer lines). */
function artLines(out: string): string[] {
  return out
    .split("\n")
    .filter((l) => !l.startsWith("powered by") && !l.startsWith("more →"));
}

describe("renderBrandBanner", () => {
  it("renders 'acme' as compact 3-row solid-block art with the footer", () => {
    const out = renderBrandBanner("acme", { color: "none", columns: 80 });
    expect(out).toMatch(ART_GLYPH);
    // A single-line name is exactly the font's 3 rows of art.
    expect(artLines(out).length).toBe(3);
    expect(out).toContain("powered by @ken-jo/agent-connector");
    expect(out).toContain("more → https://github.com/ken-jo/agent-connector");
  });

  it("renders distinct letters with DISTINCT art (legibility: M ≠ N ≠ W, A ≠ B)", () => {
    const art = (s: string) =>
      artLines(renderBrandBanner(s, { color: "none", columns: 80 })).join("\n");
    expect(art("M")).not.toBe(art("N"));
    expect(art("N")).not.toBe(art("W"));
    expect(art("M")).not.toBe(art("W"));
    expect(art("A")).not.toBe(art("B"));
    // Every glyph is the full 3 rows tall.
    expect(artLines(renderBrandBanner("M", { color: "none", columns: 80 })).length).toBe(3);
  });

  it("shows the powered-by footer on BOTH global and branded banners", () => {
    const global = renderBrandBanner("agent-connector", { color: "none", columns: 80 });
    const branded = renderBrandBanner("acme-db", { color: "none", columns: 80 });
    expect(global).toContain("powered by @ken-jo/agent-connector");
    expect(branded).toContain("powered by @ken-jo/agent-connector");
  });

  it("emits NO ANSI color codes under color:'none' (NO_COLOR)", () => {
    const out = renderBrandBanner("agent-connector", { color: "none", columns: 80 });
    expect(out).not.toContain("\x1b");
    expect(ANSI.test(out)).toBe(false);
  });

  it("colors each WHOLE letter ONE solid SOFT-PASTEL hue (no white highlight)", () => {
    const out = renderBrandBanner("acme", { color: "truecolor", columns: 80 });
    expect(out).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    expect(out).toContain("\x1b[0m"); // reset after each colored cell
    // The white-highlight row is GONE — no bright-white anywhere in the art.
    expect(out).not.toContain("255;255;255");
    // Row 0 of "acme": exactly 4 letters → 4 distinct palette colors, one solid
    // hue per whole letter (cycled, all different here).
    const row0 = out.split("\n")[0]!;
    const colors = [...row0.matchAll(/38;2;(\d+;\d+;\d+)m/g)].map((mm) => mm[1]);
    const distinct = new Set(colors);
    expect(distinct.size).toBe(4);
    // PASTEL = soft/muted: every channel of every art color is high (>=140),
    // i.e. nothing saturated/neon (which would push a channel near 0).
    const rgb = [...distinct].map((s) => s!.split(";").map(Number) as [number, number, number]);
    expect(rgb.every(([r, g, b]) => Math.min(r, g, b) >= 140)).toBe(true);
    expect([...distinct]).toContain("244;170;190"); // soft rose (1st letter)
  });

  it("emits 256-color pastel palette (and NO white) under color:'ansi256'", () => {
    const out = renderBrandBanner("acme", { color: "ansi256", columns: 80 });
    expect(out).toMatch(/\x1b\[38;5;\d+m/);
    expect(out).not.toContain("\x1b[38;5;231m"); // no bright-white highlight
  });

  it("emits 16-color pastel palette (and NO white) under color:'ansi16'", () => {
    const out = renderBrandBanner("acme", { color: "ansi16", columns: 80 });
    expect(out).toMatch(/\x1b\[3[2-6]m/); // non-bright palette fg
    expect(out).not.toContain("\x1b[97m"); // no bright-white highlight
  });

  it("renders 'agent-connector' on ONE line that fits an 80-column terminal", () => {
    const out = renderBrandBanner("agent-connector", { color: "none", columns: 80 });
    const art = artLines(out);
    // ONE 3-row block (no stacking, no wrap), every row within 80 cols.
    expect(art.length).toBe(3);
    for (const line of art) expect(cols(line)).toBeLessThanOrEqual(80);
    // Real block art (not the degraded "» name" line).
    expect(out).toMatch(ART_GLYPH);
    expect(out).not.toContain("» ");
  });

  it("renders a short name on the same single 3-row block", () => {
    const out = renderBrandBanner("acme", { color: "none", columns: 80 });
    expect(artLines(out).length).toBe(3);
  });

  it("degrades a single genuinely-un-fittable token to one styled line", () => {
    // A token wider than the column budget → the last-resort one-line degrade.
    const out = renderBrandBanner("supercalifragilistic", { color: "none", columns: 20 });
    const art = artLines(out);
    expect(art.length).toBe(1);
    expect(art[0]).toContain("supercalifragilistic");
    expect(art[0]).toContain("»"); // the styled degrade lead
    expect(out).toContain("powered by @ken-jo/agent-connector");
  });

  it("degrades (rather than throws) on an empty name", () => {
    const out = renderBrandBanner("", { color: "none", columns: 80 });
    expect(out).toContain("powered by @ken-jo/agent-connector");
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
