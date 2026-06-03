/**
 * core/jsonc — string-aware JSONC stripping + tolerant parse.
 *
 * stripJsonc must remove // line comments, /* *\/ block comments, and trailing
 * commas, WITHOUT corrupting comment-like or comma-like characters inside string
 * literals. parseJsonc must round-trip a commented config to a real object.
 */

import { describe, expect, it } from "vitest";

import { parseJsonc, stripJsonc } from "../../src/core/jsonc.js";

describe("stripJsonc", () => {
  it("removes // line comments outside strings", () => {
    const src = `{
      // a leading comment
      "a": 1, // trailing comment
      "b": 2
    }`;
    expect(parseJsonc(stripJsonc(src))).toEqual({ a: 1, b: 2 });
  });

  it("removes /* */ block comments outside strings", () => {
    const src = `{
      /* block
         comment */
      "a": 1,
      "b": /* inline */ 2
    }`;
    expect(parseJsonc(stripJsonc(src))).toEqual({ a: 1, b: 2 });
  });

  it("removes trailing commas before } and ]", () => {
    const src = `{
      "a": [1, 2, 3,],
      "b": { "c": 1, },
    }`;
    expect(parseJsonc(stripJsonc(src))).toEqual({ a: [1, 2, 3], b: { c: 1 } });
  });

  it("PRESERVES a // sequence inside a string value (http://x//y)", () => {
    const src = `{ "url": "http://x//y" }`;
    const out = stripJsonc(src);
    expect(out).toContain("http://x//y");
    expect(parseJsonc(out)).toEqual({ url: "http://x//y" });
  });

  it("PRESERVES a comma-before-bracket inside a string value (\"a,]\")", () => {
    const src = `{ "v": "a,]" }`;
    const out = stripJsonc(src);
    expect(JSON.parse(out)).toEqual({ v: "a,]" });
    // The in-string comma must survive verbatim.
    expect(out).toContain("a,]");
  });

  it("PRESERVES a /* sequence inside a string value", () => {
    const src = `{ "s": "/* not a comment */", "n": 1 }`;
    expect(parseJsonc(src)).toEqual({ s: "/* not a comment */", n: 1 });
  });

  it("does not treat an escaped quote as the end of a string", () => {
    const src = `{ "s": "he said \\"// hi\\", ok", "n": 1 }`;
    expect(parseJsonc(src)).toEqual({ s: 'he said "// hi", ok', n: 1 });
  });

  it("keeps a legitimate (non-trailing) comma between values", () => {
    expect(parseJsonc(`{ "a": 1, "b": 2 }`)).toEqual({ a: 1, b: 2 });
    expect(parseJsonc(`[1, 2]`)).toEqual([1, 2]);
  });
});

describe("parseJsonc", () => {
  it("parses a realistic commented + trailing-comma config", () => {
    const src = `{
      // MCP servers for the gateway
      "mcpServers": {
        "acme": {
          "command": "npx",
          "args": ["-y", "@x/y"], // server entry
        },
      },
      /* user theme */
      "theme": "dark",
    }`;
    expect(parseJsonc(src)).toEqual({
      mcpServers: { acme: { command: "npx", args: ["-y", "@x/y"] } },
      theme: "dark",
    });
  });

  it("throws on genuinely malformed input (not just JSONC)", () => {
    expect(() => parseJsonc(`{ "a": }`)).toThrow();
    expect(() => parseJsonc(`{ this is not json`)).toThrow();
  });
});
