/**
 * tests/cli/banner — the branded ASCII header + powered-by footer.
 *
 * Pure unit tests over the two injected functions (no real TTY, no process.*):
 *   • renderBrandBanner(name, { color, columns }) → the banner string
 *   • shouldShowBanner({ isTTY, noColor, json, quiet }) → gating boolean
 *   • resolveColorMode(...) → the color tier from the (injected) terminal env
 *
 * Covers: the bold 6-row ANSI-Shadow art renders legibly (distinct letters look
 * different), the footer is present, NO_COLOR/"none" emits zero ANSI codes while
 * color modes emit a VIVID RAINBOW (many distinct hues), a long name STACKS at
 * separators to fit the width while a single un-splittable token degrades, and
 * both a kebab name ("agent-connector") and an SDK brand ("acme") render.
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
/** The block / box-drawing glyphs the bold ANSI-Shadow art is built from. */
const ART_GLYPH = /[█╗╔╝╚║═▄▀]/;
/** Art rows only (drop the two footer lines). */
function artLines(out: string): string[] {
  return out
    .split("\n")
    .filter((l) => !l.startsWith("powered by") && !l.startsWith("more →"));
}

describe("renderBrandBanner", () => {
  it("renders 'acme' as bold 6-row block art with the footer", () => {
    const out = renderBrandBanner("acme", { color: "none", columns: 80 });
    expect(out).toMatch(ART_GLYPH);
    // A single-line name is exactly the font's 6 rows of art.
    expect(artLines(out).length).toBe(6);
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
    // Every glyph is the full 6 rows tall.
    expect(artLines(renderBrandBanner("M", { color: "none", columns: 80 })).length).toBe(6);
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

  it("emits a VIVID RAINBOW (many distinct truecolor hues) under color:'truecolor'", () => {
    const out = renderBrandBanner("acme", { color: "truecolor", columns: 80 });
    expect(out).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    expect(out).toContain("\x1b[0m"); // reset after each colored glyph
    const triples = [...out.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((mm) =>
      mm.slice(1).join(","),
    );
    const distinct = new Set(triples);
    // A real spectrum sweep yields many different colors (not a 2-3-stop gradient).
    expect(distinct.size).toBeGreaterThanOrEqual(8);
    // It spans warm → cool: a red-dominant AND a blue-dominant color both appear.
    const rgb = [...distinct].map((s) => s.split(",").map(Number) as [number, number, number]);
    expect(rgb.some(([r, , b]) => r > 180 && b < 120)).toBe(true); // red/orange end
    expect(rgb.some(([, , b]) => b > 180)).toBe(true); // blue/violet end
  });

  it("emits 256-color (38;5;n) escapes under color:'ansi256'", () => {
    const out = renderBrandBanner("acme", { color: "ansi256", columns: 80 });
    expect(out).toMatch(/\x1b\[38;5;\d+m/);
  });

  it("emits 16-color rainbow-wheel fg escapes under color:'ansi16'", () => {
    const out = renderBrandBanner("acme", { color: "ansi16", columns: 80 });
    expect(out).toMatch(/\x1b\[9[1-6]m/); // bright red..magenta wheel
  });

  it("STACKS 'agent-connector' at its separator to fit an 80-column terminal", () => {
    const out = renderBrandBanner("agent-connector", { color: "none", columns: 80 });
    const art = artLines(out);
    // Stacked = two 6-row blocks + a blank spacer row between them = 13 lines,
    // not the un-stacked single 6-row line that would overflow 80 cols.
    expect(art.length).toBe(13);
    for (const line of art) expect(cols(line)).toBeLessThanOrEqual(80);
    // And it is still real block art (not the degraded "» name" line).
    expect(out).toMatch(ART_GLYPH);
    expect(out).not.toContain("» ");
  });

  it("renders a short name on ONE big-font line (no stacking)", () => {
    const out = renderBrandBanner("acme", { color: "none", columns: 80 });
    expect(artLines(out).length).toBe(6); // single 6-row block, never stacked
  });

  it("degrades a single un-splittable over-wide token to one styled line", () => {
    // No separators → cannot stack; too wide for the column count → degrade.
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
