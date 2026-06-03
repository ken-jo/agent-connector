import { describe, it, expect } from "vitest";

import {
  getTokenizer,
  inferModelFamily,
} from "../../src/telemetry/tokenizer.js";
import type { ModelFamily, TokenCount } from "../../src/telemetry/types.js";

/**
 * Tokenizer tests.
 *
 * gpt-tokenizer's o200k_base encoding is installed in this repo, so the default
 * tokenizer takes the real-BPE path: openai → "tokenizer-exact", everything else
 * → "tokenizer-approx". (If the encoder ever failed to load it would degrade to
 * "heuristic"; these tests assert the documented BPE behavior that ships today.)
 */
describe("getTokenizer().count", () => {
  const tok = getTokenizer();

  it("returns a positive integer token count for non-empty text", () => {
    const c = tok.count("the quick brown fox jumps over the lazy dog", "openai");
    expect(c.tokens).toBeGreaterThan(0);
    expect(Number.isInteger(c.tokens)).toBe(true);
  });

  it("returns 0-ish (non-positive) for empty text", () => {
    const c = tok.count("", "openai");
    expect(c.tokens).toBe(0);
    expect(Number.isInteger(c.tokens)).toBe(true);
  });

  it("scales monotonically: longer text yields at least as many tokens", () => {
    const short = tok.count("hello", "openai").tokens;
    const long = tok.count("hello hello hello hello hello", "openai").tokens;
    expect(long).toBeGreaterThanOrEqual(short);
    expect(long).toBeGreaterThan(0);
  });

  it("labels the openai family as tokenizer-exact", () => {
    const c = tok.count("some representative text", "openai");
    expect(c.source).toBe("tokenizer-exact");
  });

  it("labels the anthropic family as tokenizer-approx", () => {
    const c = tok.count("some representative text", "anthropic");
    expect(c.source).toBe("tokenizer-approx");
  });

  it("labels the generic family as tokenizer-approx", () => {
    const c = tok.count("some representative text", "generic");
    expect(c.source).toBe("tokenizer-approx");
  });

  it("uses the same underlying encoding across families (same token count)", () => {
    const text = "identical input across every model family";
    const openai = tok.count(text, "openai").tokens;
    const anthropic = tok.count(text, "anthropic").tokens;
    const generic = tok.count(text, "generic").tokens;
    expect(anthropic).toBe(openai);
    expect(generic).toBe(openai);
  });

  it("returns a shared singleton tokenizer", () => {
    expect(getTokenizer()).toBe(getTokenizer());
  });
});

describe("getTokenizer().countValue", () => {
  const tok = getTokenizer();

  it("serializes a non-string value (object) and counts its JSON", () => {
    const c = tok.countValue({ a: 1, b: "two", c: [3, 4, 5] }, "openai");
    expect(c.tokens).toBeGreaterThan(0);
    expect(c.source).toBe("tokenizer-exact");
  });

  it("serializes a number value", () => {
    const c = tok.countValue(123456, "openai");
    expect(c.tokens).toBeGreaterThan(0);
  });

  it("counts a string value the same as count() of that string", () => {
    const text = "plain string passed as a value";
    const viaValue = tok.countValue(text, "openai");
    const viaCount = tok.count(text, "openai");
    expect(viaValue.tokens).toBe(viaCount.tokens);
    expect(viaValue.source).toBe(viaCount.source);
  });

  it("treats undefined as the empty string (0 tokens)", () => {
    const c = tok.countValue(undefined, "openai");
    expect(c.tokens).toBe(0);
  });

  it("counts a larger object as more tokens than a smaller one", () => {
    const small = tok.countValue({ x: 1 }, "openai").tokens;
    const big = tok.countValue(
      { x: 1, y: 2, z: 3, nested: { a: "alpha", b: "beta", c: "gamma" } },
      "openai",
    ).tokens;
    expect(big).toBeGreaterThan(small);
  });
});

describe("inferModelFamily", () => {
  const cases: Array<[string, ModelFamily]> = [
    ["claude-3-5-sonnet", "anthropic"],
    ["Claude Code", "anthropic"],
    ["anthropic", "anthropic"],
    ["Anthropic SDK", "anthropic"],
    ["gpt-4o", "openai"],
    ["GPT-4", "openai"],
    ["codex-cli", "openai"],
    ["Codex", "openai"],
    ["openai", "openai"],
    ["OpenAI API", "openai"],
    ["gemini-1.5-pro", "generic"],
    ["Gemini CLI", "generic"],
    ["some-unknown-client", "generic"],
    ["", "generic"],
  ];

  for (const [name, expected] of cases) {
    it(`maps client name "${name}" → ${expected} under "auto"`, () => {
      expect(inferModelFamily(name, "auto")).toBe(expected);
    });
  }

  it("is case-insensitive when sniffing client names", () => {
    expect(inferModelFamily("CLAUDE-OPUS", "auto")).toBe("anthropic");
    expect(inferModelFamily("GpT-4O", "auto")).toBe("openai");
  });

  it("respects a non-auto hint outright, overriding the client name", () => {
    // Client name says anthropic, but an explicit hint must win.
    expect(inferModelFamily("claude-3", "openai")).toBe("openai");
    expect(inferModelFamily("gpt-4o", "anthropic")).toBe("anthropic");
    expect(inferModelFamily("gemini", "generic")).toBe("generic");
  });

  it("a non-auto hint wins even when the client name is empty", () => {
    expect(inferModelFamily("", "anthropic")).toBe("anthropic");
  });
});

// Type-level sanity: count() returns the TokenCount shape.
describe("TokenCount shape", () => {
  it("count() returns { tokens, source }", () => {
    const c: TokenCount = getTokenizer().count("x", "openai");
    expect(c).toHaveProperty("tokens");
    expect(c).toHaveProperty("source");
  });
});
