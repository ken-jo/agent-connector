/**
 * tests/cli/banner — the branded ASCII header + powered-by footer.
 *
 * Pure unit tests over the two injected functions (no real TTY, no process.*):
 *   • renderBrandBanner(name, { color, columns }) → the banner string
 *   • shouldShowBanner({ isTTY, noColor, json, quiet }) → gating boolean
 *   • resolveColorMode(...) → the color tier from the (injected) terminal env
 *
 * Covers: the compact 5-row solid-block art renders legibly (distinct letters
 * look different) and "agent-connector" fits ONE line at 80 cols (no stacking),
 * the footer is present, NO_COLOR/"none" emits zero ANSI codes, and in color
 * mode each whole letter is ONE solid vivid palette color (not a smooth
 * gradient) with a bright-WHITE top-row highlight; both a kebab name
 * ("agent-connector") and an SDK brand ("acme") render; a genuinely un-fittable
 * token degrades to one styled line.
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
  it("renders 'acme' as compact 5-row solid-block art with the footer", () => {
    const out = renderBrandBanner("acme", { color: "none", columns: 80 });
    expect(out).toMatch(ART_GLYPH);
    // A single-line name is exactly the font's 5 rows of art.
    expect(artLines(out).length).toBe(5);
    expect(out).toContain("powered by @ken-jo/agent-connector");
    expect(out).toContain("more → https://github.com/ken-jo/agent-connector");
  });

  it("renders distinct letters with DISTINCT art (legibility: M ≠ N, A ≠ B)", () => {
    const m = artLines(renderBrandBanner("M", { color: "none", columns: 80 })).join("\n");
    const n = artLines(renderBrandBanner("N", { color: "none", columns: 80 })).join("\n");
    const a = artLines(renderBrandBanner("A", { color: "none", columns: 80 })).join("\n");
    const b = artLines(renderBrandBanner("B", { color: "none", columns: 80 })).join("\n");
    expect(m).not.toBe(n);
    expect(a).not.toBe(b);
    // Every glyph is the full 5 rows tall.
    expect(artLines(renderBrandBanner("M", { color: "none", columns: 80 })).length).toBe(5);
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

  it("colors each WHOLE letter ONE solid vivid hue (distinct, not a gradient)", () => {
    const out = renderBrandBanner("acme", { color: "truecolor", columns: 80 });
    expect(out).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    expect(out).toContain("\x1b[0m"); // reset after each colored cell
    const lines = out.split("\n");
    // Row index 1 (a non-top row) of "acme": exactly 4 letters → 4 distinct
    // palette colors, one solid hue per whole letter (cycled, all different here).
    const row1 = lines[1]!;
    const colors = [...row1.matchAll(/38;2;(\d+;\d+;\d+)m/g)].map((mm) => mm[1]);
    const distinct = new Set(colors);
    expect(distinct.size).toBe(4);
    // The palette is vivid (a hot-pink-ish and a lime-ish letter both appear),
    // and is a curated set — far fewer than one-hue-per-column (no gradient).
    expect([...distinct]).toContain("255;45;149"); // hot pink (1st letter)
    expect([...distinct]).toContain("120;255;40"); // lime (3rd letter)
  });

  it("paints each glyph's TOP row bright WHITE (the glossy highlight)", () => {
    const out = renderBrandBanner("acme", { color: "truecolor", columns: 80 });
    const lines = out.split("\n");
    // Top art row is overpainted bright white; the rows below carry palette hues.
    expect(lines[0]).toContain("38;2;255;255;255m"); // white on the top row
    const below = lines.slice(1, 5).join("");
    expect(below).not.toContain("255;255;255"); // no white below the top row
  });

  it("emits 256-color palette + white highlight under color:'ansi256'", () => {
    const out = renderBrandBanner("acme", { color: "ansi256", columns: 80 });
    expect(out).toMatch(/\x1b\[38;5;\d+m/);
    expect(out).toContain("\x1b[38;5;231m"); // bright-white highlight
  });

  it("emits 16-color palette + white highlight under color:'ansi16'", () => {
    const out = renderBrandBanner("acme", { color: "ansi16", columns: 80 });
    expect(out).toMatch(/\x1b\[9[2-6]m/); // bright palette fg
    expect(out).toContain("\x1b[97m"); // bright-white highlight
  });

  it("renders 'agent-connector' on ONE line that fits an 80-column terminal", () => {
    const out = renderBrandBanner("agent-connector", { color: "none", columns: 80 });
    const art = artLines(out);
    // ONE 5-row block (no stacking, no wrap), every row within 80 cols.
    expect(art.length).toBe(5);
    for (const line of art) expect(cols(line)).toBeLessThanOrEqual(80);
    // Real block art (not the degraded "» name" line).
    expect(out).toMatch(ART_GLYPH);
    expect(out).not.toContain("» ");
  });

  it("renders a short name on the same single 5-row block", () => {
    const out = renderBrandBanner("acme", { color: "none", columns: 80 });
    expect(artLines(out).length).toBe(5);
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
