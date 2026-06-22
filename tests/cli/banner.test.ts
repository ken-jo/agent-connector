/**
 * tests/cli/banner — the branded ASCII header + powered-by footer.
 *
 * Pure unit tests over the two injected functions (no real TTY, no process.*):
 *   • renderBrandBanner(name, { color, columns }) → the banner string
 *   • shouldShowBanner({ isTTY, noColor, json, quiet }) → gating boolean
 *   • resolveColorMode(...) → the color tier from the (injected) terminal env
 *
 * Covers: the brand name renders recognizably, the footer is present, NO_COLOR/
 * "none" emits zero ANSI codes while color modes emit escapes, a long brand
 * degrades inside a narrow width, and both a kebab name ("agent-connector") and
 * an SDK brand ("acme") render.
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

describe("renderBrandBanner", () => {
  it("renders the kebab brand 'agent-connector' as block art with the footer", () => {
    const out = renderBrandBanner("agent-connector", { color: "none", columns: 80 });
    // Block art uses the full-block / upper-half glyphs (not a single plain line).
    expect(out).toMatch(/[█▀▄]/);
    // The art spans multiple rows above the two footer lines.
    expect(out.split("\n").length).toBeGreaterThan(3);
    // The powered-by attribution + the github link footer are present verbatim.
    expect(out).toContain("powered by @ken-jo/agent-connector");
    expect(out).toContain("more → https://github.com/ken-jo/agent-connector");
  });

  it("renders an SDK brand name ('acme') too", () => {
    const out = renderBrandBanner("acme", { color: "none", columns: 80 });
    expect(out).toMatch(/[█▀▄]/);
    expect(out).toContain("powered by @ken-jo/agent-connector");
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

  it("emits truecolor (38;2;r;g;b) escapes under color:'truecolor'", () => {
    const out = renderBrandBanner("acme", { color: "truecolor", columns: 80 });
    expect(out).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    expect(out).toContain("\x1b[0m"); // reset after each colored glyph
  });

  it("emits 256-color (38;5;n) escapes under color:'ansi256'", () => {
    const out = renderBrandBanner("acme", { color: "ansi256", columns: 80 });
    expect(out).toMatch(/\x1b\[38;5;\d+m/);
  });

  it("emits 16-color (cool fg) escapes under color:'ansi16'", () => {
    const out = renderBrandBanner("acme", { color: "ansi16", columns: 80 });
    expect(out).toMatch(/\x1b\[9[456]m/); // bright cyan/blue/magenta
  });

  it("keeps the 'agent-connector' art within an 80-column terminal", () => {
    const out = renderBrandBanner("agent-connector", { color: "none", columns: 80 });
    for (const line of out.split("\n")) {
      expect(cols(line)).toBeLessThanOrEqual(80);
    }
  });

  it("degrades a long brand to a single line in a narrow terminal (no mangled wrap)", () => {
    const longName = "super-long-brand-name-that-would-overflow";
    const out = renderBrandBanner(longName, { color: "none", columns: 20 });
    const artLines = out.split("\n").filter((l) => !l.startsWith("powered by") && !l.startsWith("more"));
    // The degraded form is ONE art line (a "» name" lead), not 5 wrapped rows.
    expect(artLines.length).toBe(1);
    expect(artLines[0]).toContain(longName);
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
