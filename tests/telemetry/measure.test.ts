import { describe, it, expect } from "vitest";

import {
  measureToolCall,
  measureToolDefs,
  worstConfidence,
} from "../../src/telemetry/measure.js";
import { getTokenizer } from "../../src/telemetry/tokenizer.js";
import type {
  ConfidenceSource,
  ModelFamily,
  TokenCount,
  Tokenizer,
} from "../../src/telemetry/types.js";

/**
 * measure tests.
 *
 * These exercise the real default tokenizer (gpt-tokenizer is installed) for the
 * happy paths, and a controllable fake Tokenizer for the confidence-combination
 * and "no base64 tokenization" guarantees, so assertions don't depend on exact
 * BPE counts where the contract is structural.
 */

const FAMILY: ModelFamily = "openai";

/**
 * A fake tokenizer that returns 1 token per character with a fixed source. Lets
 * us assert "a huge base64 blob did NOT get tokenized" by checking the byte
 * length never leaked into the count, and lets us drive confidence combination.
 */
function fakeTokenizer(source: ConfidenceSource): Tokenizer {
  const make = (text: string): TokenCount => ({ tokens: text.length, source });
  return {
    count: (text: string) => make(text),
    countValue: (value: unknown) =>
      make(typeof value === "string" ? value : JSON.stringify(value) ?? ""),
  };
}

describe("worstConfidence", () => {
  it("orders heuristic < tokenizer-approx < tokenizer-exact < host-native", () => {
    expect(worstConfidence("heuristic", "host-native")).toBe("heuristic");
    expect(worstConfidence("tokenizer-exact", "tokenizer-approx")).toBe(
      "tokenizer-approx",
    );
    expect(worstConfidence("host-native", "tokenizer-exact")).toBe(
      "tokenizer-exact",
    );
    expect(worstConfidence("tokenizer-approx", "heuristic")).toBe("heuristic");
  });

  it("returns the same source when both are equal", () => {
    expect(worstConfidence("tokenizer-exact", "tokenizer-exact")).toBe(
      "tokenizer-exact",
    );
  });
});

describe("measureToolCall — input args", () => {
  it("counts input args and output text as positive integers", () => {
    const m = measureToolCall(
      { query: "select * from users where id = 42" },
      { content: [{ type: "text", text: "returned 1 row of user data" }] },
      FAMILY,
    );
    expect(m.inputTokens).toBeGreaterThan(0);
    expect(m.outputTokens).toBeGreaterThan(0);
    expect(Number.isInteger(m.inputTokens)).toBe(true);
    expect(Number.isInteger(m.outputTokens)).toBe(true);
    expect(m.source).toBe("tokenizer-exact");
  });

  it("larger args produce more input tokens", () => {
    const small = measureToolCall({ a: 1 }, {}, FAMILY).inputTokens;
    const big = measureToolCall(
      { a: 1, b: "a long string value here", c: [1, 2, 3, 4, 5, 6, 7, 8] },
      {},
      FAMILY,
    ).inputTokens;
    expect(big).toBeGreaterThan(small);
  });

  it("counts input args via the canonical JSON of the args value", () => {
    const tok = getTokenizer();
    const args = { tool: "x", nested: { deep: [1, 2, 3] } };
    const m = measureToolCall(args, {}, FAMILY);
    const expected = tok.countValue(args, FAMILY).tokens;
    expect(m.inputTokens).toBe(expected);
  });
});

describe("measureToolCall — output text blocks", () => {
  it("sums the text of multiple text content blocks", () => {
    const tok = getTokenizer();
    const a = "first block of textual output";
    const b = "second block with more words to count";
    const combined = measureToolCall(
      {},
      { content: [{ type: "text", text: a }, { type: "text", text: b }] },
      FAMILY,
    ).outputTokens;
    const sum = tok.count(a, FAMILY).tokens + tok.count(b, FAMILY).tokens;
    expect(combined).toBe(sum);
  });

  it("counts a bare-string content field as whole JSON", () => {
    const m = measureToolCall({}, { content: "plain string content" }, FAMILY);
    expect(m.outputTokens).toBeGreaterThan(0);
  });

  it("tokenizes structuredContent in addition to content text", () => {
    const withStructured = measureToolCall(
      {},
      {
        content: [{ type: "text", text: "hello" }],
        structuredContent: { rows: [{ id: 1 }, { id: 2 }, { id: 3 }] },
      },
      FAMILY,
    ).outputTokens;
    const textOnly = measureToolCall(
      {},
      { content: [{ type: "text", text: "hello" }] },
      FAMILY,
    ).outputTokens;
    expect(withStructured).toBeGreaterThan(textOnly);
  });

  it("measures a plain-string (non-object) result directly", () => {
    const m = measureToolCall({}, "just a string result", FAMILY);
    expect(m.outputTokens).toBeGreaterThan(0);
  });

  it("falls back to counting the whole object when nothing measurable is found", () => {
    // No content/structuredContent → measured as the whole object, not zero.
    const m = measureToolCall({}, { someOtherKey: "value", more: 1 }, FAMILY);
    expect(m.outputTokens).toBeGreaterThan(0);
  });

  it("treats a text block with non-string text as empty (0 added tokens)", () => {
    // text is a number, not a string → coerced to "" → 0 tokens for that block.
    const m = measureToolCall(
      {},
      { content: [{ type: "text", text: 12345 }] },
      FAMILY,
    );
    expect(m.outputTokens).toBe(0);
  });
});

describe("measureToolCall — non-text (image) blocks do NOT tokenize base64", () => {
  // A huge base64 blob. If the impl tokenized it, the count would explode.
  const HUGE_BASE64 = "A".repeat(200_000);

  it("an image block contributes only a small, bounded amount", () => {
    const m = measureToolCall(
      {},
      {
        content: [
          { type: "image", data: HUGE_BASE64, mimeType: "image/png" },
        ],
      },
      FAMILY,
    );
    // Flat per-modality estimate (~85), NOT ~tens-of-thousands of tokens.
    expect(m.outputTokens).toBeLessThan(1000);
    expect(m.outputTokens).toBeGreaterThan(0);
  });

  it("does not vary with the size of the base64 payload", () => {
    const tiny = measureToolCall(
      {},
      { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
      FAMILY,
    ).outputTokens;
    const huge = measureToolCall(
      {},
      {
        content: [
          { type: "image", data: HUGE_BASE64, mimeType: "image/png" },
        ],
      },
      FAMILY,
    ).outputTokens;
    // Same flat estimate regardless of blob size → base64 is never tokenized.
    expect(huge).toBe(tiny);
  });

  it("pulls combined confidence down to at least tokenizer-approx for an image", () => {
    // Even with an openai (exact) family, a flat image estimate is approx.
    const m = measureToolCall(
      { q: "x" },
      {
        content: [
          { type: "image", data: HUGE_BASE64, mimeType: "image/png" },
        ],
      },
      FAMILY,
    );
    expect(m.source).toBe("tokenizer-approx");
  });

  it("mixing a text block and an image block keeps text tokens but bounds the image", () => {
    const text = "a short caption for the image below";
    const m = measureToolCall(
      {},
      {
        content: [
          { type: "text", text },
          { type: "image", data: HUGE_BASE64, mimeType: "image/png" },
        ],
      },
      FAMILY,
    );
    const textTokens = getTokenizer().count(text, FAMILY).tokens;
    // text tokens + ~85 image estimate, NOT 200k.
    expect(m.outputTokens).toBeGreaterThanOrEqual(textTokens);
    expect(m.outputTokens).toBeLessThan(textTokens + 1000);
  });

  it("uses a fake 1-token-per-char tokenizer to prove the base64 never reaches the tokenizer", () => {
    // With this fake, tokenizing 200k chars would yield 200k tokens. The image
    // path must bypass it entirely → small bounded estimate.
    const m = measureToolCall(
      {},
      {
        content: [
          { type: "image", data: HUGE_BASE64, mimeType: "image/png" },
        ],
      },
      FAMILY,
      fakeTokenizer("tokenizer-exact"),
    );
    expect(m.outputTokens).toBeLessThan(1000);
  });

  it("an unknown non-text block type also gets a small flat estimate", () => {
    const m = measureToolCall(
      {},
      {
        content: [
          { type: "weird-modality", blob: HUGE_BASE64 },
        ],
      },
      FAMILY,
      fakeTokenizer("tokenizer-exact"),
    );
    expect(m.outputTokens).toBeLessThan(1000);
    expect(m.outputTokens).toBeGreaterThan(0);
    expect(m.source).toBe("tokenizer-approx");
  });
});

describe("measureToolCall — combined source is the least-confident of the parts", () => {
  it("a heuristic input combined with an exact output reports heuristic", () => {
    // input source = heuristic (from the fake), output source = heuristic too
    const m = measureToolCall(
      { a: 1 },
      { content: [{ type: "text", text: "out" }] },
      FAMILY,
      fakeTokenizer("heuristic"),
    );
    expect(m.source).toBe("heuristic");
  });

  it("an exact input combined with an approx output reports approx", () => {
    // Text output is exact, but the image estimate forces approx overall.
    const m = measureToolCall(
      { a: 1 },
      {
        content: [
          { type: "text", text: "exact-text" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      },
      FAMILY,
      fakeTokenizer("tokenizer-exact"),
    );
    expect(m.source).toBe("tokenizer-approx");
  });

  it("all-exact parts report exact", () => {
    const m = measureToolCall(
      { a: 1 },
      { content: [{ type: "text", text: "all exact here" }] },
      FAMILY,
      fakeTokenizer("tokenizer-exact"),
    );
    expect(m.source).toBe("tokenizer-exact");
  });
});

describe("measureToolDefs", () => {
  it("tokenizes a tools array to a positive integer count", () => {
    const tools = [
      {
        name: "acme_query",
        description: "Run a read-only query against the Acme DB.",
        inputSchema: {
          type: "object",
          properties: { sql: { type: "string" } },
          required: ["sql"],
        },
      },
      {
        name: "acme_write",
        description: "Write a record to the Acme DB.",
        inputSchema: {
          type: "object",
          properties: { table: { type: "string" }, row: { type: "object" } },
        },
      },
    ];
    const c = measureToolDefs(tools, FAMILY);
    expect(c.tokens).toBeGreaterThan(0);
    expect(Number.isInteger(c.tokens)).toBe(true);
    expect(c.source).toBe("tokenizer-exact");
  });

  it("equals the tokenizer's countValue of the whole array", () => {
    const tools = [{ name: "t1" }, { name: "t2" }];
    const expected = getTokenizer().countValue(tools, FAMILY).tokens;
    expect(measureToolDefs(tools, FAMILY).tokens).toBe(expected);
  });

  it("more tools yield at least as many tokens", () => {
    const one = measureToolDefs([{ name: "t1", description: "d" }], FAMILY).tokens;
    const two = measureToolDefs(
      [
        { name: "t1", description: "d" },
        { name: "t2", description: "another description" },
      ],
      FAMILY,
    ).tokens;
    expect(two).toBeGreaterThan(one);
  });

  it("an empty tools array still produces a small non-negative count", () => {
    const c = measureToolDefs([], FAMILY);
    expect(c.tokens).toBeGreaterThanOrEqual(0);
  });

  it("labels anthropic-family tool-def measurement as tokenizer-approx", () => {
    const c = measureToolDefs([{ name: "t" }], "anthropic");
    expect(c.source).toBe("tokenizer-approx");
  });
});
