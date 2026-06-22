/**
 * tests/cli/banner — the branded ASCII header + powered-by footer.
 *
 * Pure unit tests over the two injected functions (no real TTY, no process.*):
 *   • renderBrandBanner(name, { color, columns }) → the banner string
 *   • shouldShowBanner({ isTTY, noColor, json, quiet }) → gating boolean
 *   • resolveColorMode(...) → the color tier from the (injected) terminal env
 *
 * Covers: the brand name renders recognizably as compact 6-row solid-block art
 * (distinct letters look different — M ≠ N ≠ W), "agent-connector" fits ONE line
 * at 80 cols, the footer is present, NO_COLOR/"none" emits zero ANSI codes while
 * the cyan→blue→magenta gradient tiers emit escapes, a long brand degrades inside
 * a narrow width, and both a kebab name ("agent-connector") and an SDK brand
 * ("acme") render.
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
/** Art rows only (drop the two footer lines). */
function artLines(out: string): string[] {
  return out
    .split("\n")
    .filter((l) => !l.startsWith("powered by") && !l.startsWith("more →"));
}

describe("renderBrandBanner", () => {
  it("renders 'agent-connector' as compact 6-row block art with the footer", () => {
    const out = renderBrandBanner("agent-connector", { color: "none", columns: 80 });
    // Block art uses the full-block / upper-half glyphs (not a single plain line).
    expect(out).toMatch(/[█▀▄]/);
    // A single-line name is exactly the font's 6 rows of art.
    expect(artLines(out).length).toBe(6);
    // The powered-by attribution + the github link footer are present verbatim.
    expect(out).toContain("powered by @ken-jo/agent-connector");
    expect(out).toContain("more → https://github.com/ken-jo/agent-connector");
  });

  it("renders an SDK brand name ('acme') too — also 6 rows", () => {
    const out = renderBrandBanner("acme", { color: "none", columns: 80 });
    expect(out).toMatch(/[█▀▄]/);
    expect(artLines(out).length).toBe(6);
    expect(out).toContain("powered by @ken-jo/agent-connector");
  });

  it("renders distinct letters with DISTINCT art (legibility: M ≠ N ≠ W, A ≠ B)", () => {
    const art = (s: string) =>
      artLines(renderBrandBanner(s, { color: "none", columns: 80 })).join("\n");
    expect(art("M")).not.toBe(art("N"));
    expect(art("N")).not.toBe(art("W"));
    expect(art("M")).not.toBe(art("W"));
    expect(art("A")).not.toBe(art("B"));
    // Every glyph is the full 6 rows tall.
    expect(artLines(renderBrandBanner("N", { color: "none", columns: 80 })).length).toBe(6);
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

  it("sweeps a cyan→blue→magenta gradient (per-column hues) under color:'truecolor'", () => {
    const out = renderBrandBanner("acme", { color: "truecolor", columns: 80 });
    expect(out).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    expect(out).toContain("\x1b[0m"); // reset after each colored glyph
    const hues = new Set(
      [...out.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m/g)].map((mm) => mm[1]),
    );
    // A per-column sweep yields many distinct hues (NOT one solid color).
    expect(hues.size).toBeGreaterThanOrEqual(6);
    const rgb = [...hues].map((s) => s!.split(";").map(Number) as [number, number, number]);
    // It spans cyan-ish (low R, high G+B) → magenta-ish (high R+B, low G).
    expect(rgb.some(([r, g, b]) => r < 60 && g > 150 && b > 150)).toBe(true);
    expect(rgb.some(([r, g, b]) => r > 150 && g < 80 && b > 150)).toBe(true);
  });

  it("emits 256-color (38;5;n) escapes under color:'ansi256'", () => {
    const out = renderBrandBanner("acme", { color: "ansi256", columns: 80 });
    expect(out).toMatch(/\x1b\[38;5;\d+m/);
  });

  it("emits 16-color (cool fg) escapes under color:'ansi16'", () => {
    const out = renderBrandBanner("acme", { color: "ansi16", columns: 80 });
    expect(out).toMatch(/\x1b\[9[456]m/); // bright cyan/blue/magenta
  });

  it("fits 'agent-connector' on ONE 6-row block within an 80-column terminal", () => {
    const out = renderBrandBanner("agent-connector", { color: "none", columns: 80 });
    const art = artLines(out);
    // ONE 6-row block (no stacking, no wrap), every row within 80 cols.
    expect(art.length).toBe(6);
    for (const line of art) expect(cols(line)).toBeLessThanOrEqual(80);
    // Real block art, not the degraded "» name" line.
    expect(out).not.toContain("» ");
  });

  it("degrades a long brand to a single line in a narrow terminal (no mangled wrap)", () => {
    const longName = "super-long-brand-name-that-would-overflow";
    const out = renderBrandBanner(longName, { color: "none", columns: 20 });
    const art = artLines(out);
    // The degraded form is ONE art line (a "» name" lead), not the 6 wrapped rows.
    expect(art.length).toBe(1);
    expect(art[0]).toContain(longName);
    // Footer still shown.
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
