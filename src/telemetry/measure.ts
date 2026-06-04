/**
 * telemetry/measure — pure measurement helpers over a single MCP tool call.
 *
 * The framework tokenizes its OWN bytes: the tool-call arguments going in, the
 * tool result coming out, and the fixed tool-definition schemas. These helpers
 * turn those into {@link TokenCount}s using the default {@link Tokenizer}.
 *
 * Honesty rules:
 *   • Binary modalities (image/audio/resource blobs) are NOT tokenized — base64
 *     would massively over-count. Each gets a flat per-modality estimate, and
 *     because that estimate is itself an approximation the combined confidence
 *     is pulled down to at least "tokenizer-approx".
 *   • When combining several counts, the reported confidence is the WORST
 *     (least-confident) of the inputs — never report "exact" for a mixed bag.
 *
 * Everything here is pure: no IO, no mutation of inputs.
 */

import { getTokenizer } from "./tokenizer.js";
import { worstConfidence } from "./types.js";
import type {
  ConfidenceSource,
  ModelFamily,
  TokenCount,
  Tokenizer,
} from "./types.js";

/** Per-call measurement: tokens in, tokens out, and combined confidence. */
export interface ToolCallMeasurement {
  inputTokens: number;
  outputTokens: number;
  source: ConfidenceSource;
}

/**
 * Flat token estimates for non-text content blocks. These mirror common host
 * accounting (an image tile is roughly ~85 tokens at low detail); they are
 * deliberately coarse — we never tokenize the underlying base64 payload.
 */
const MODALITY_ESTIMATE: Record<string, number> = {
  image: 85,
  audio: 85,
  resource: 85,
};
/** Fallback estimate for an unknown non-text block type. */
const UNKNOWN_BLOCK_ESTIMATE = 85;

// Confidence ordering + the worst-of comparison live in ./types (the single
// source of truth, imported as `worstConfidence` above). Re-exported here so
// callers that already import `worstConfidence` from this module keep working
// as a new ConfidenceSource value (e.g. tokenizer-calibrated) slots into the
// shared ordering.
export { worstConfidence };

/** Reduce a list of sources to the single worst (least-confident) one. */
function combineSources(sources: readonly ConfidenceSource[]): ConfidenceSource {
  // Default to the most-confident floor so an empty list combines to the only
  // other source it is paired with; in practice callers always pass ≥1 source.
  let worst: ConfidenceSource = "host-native";
  for (const s of sources) worst = worstConfidence(worst, s);
  return worst;
}

// ── Structural shapes we read from a tool result (kept local + narrow) ───────

/** A text content block: `{ type: "text", text: "..." }`. */
interface TextBlock {
  type: "text";
  text?: unknown;
}
/** Any content block; only text blocks expose a `text` field we tokenize. */
interface ContentBlock {
  type?: unknown;
  text?: unknown;
}
/** The portion of an MCP tool result we measure. */
interface ToolResultLike {
  content?: unknown;
  structuredContent?: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === "text";
}

/**
 * Measure one tool call.
 *
 * Input  = canonical JSON of `args`.
 * Output = tokens over the TEXTUAL parts of `result`:
 *   • If `result.content` is an array of blocks, text blocks are tokenized via
 *     their `text` field and non-text blocks add a flat per-modality estimate
 *     (no base64 tokenization).
 *   • `result.structuredContent`, when present, is tokenized as canonical JSON.
 *   • Anything else (string / arbitrary object) is tokenized as canonical JSON.
 *
 * The reported `source` is the worst of the input and output sources.
 */
export function measureToolCall(
  args: unknown,
  result: unknown,
  family: ModelFamily,
  tok: Tokenizer = getTokenizer(),
): ToolCallMeasurement {
  const input = tok.countValue(args, family);
  const output = measureResult(result, family, tok);
  return {
    inputTokens: input.tokens,
    outputTokens: output.tokens,
    source: worstConfidence(input.source, output.source),
  };
}

/** Tokenize the textual + structured parts of a tool result. */
function measureResult(
  result: unknown,
  family: ModelFamily,
  tok: Tokenizer,
): TokenCount {
  if (!isObject(result)) {
    // Plain string or scalar result — count its canonical form directly.
    return tok.countValue(result, family);
  }

  const res = result as ToolResultLike;
  const sources: ConfidenceSource[] = [];
  let tokens = 0;

  if (Array.isArray(res.content)) {
    for (const raw of res.content) {
      if (!isObject(raw)) continue;
      const block = raw as ContentBlock;
      if (isTextBlock(block)) {
        const text = typeof block.text === "string" ? block.text : "";
        const c = tok.count(text, family);
        tokens += c.tokens;
        sources.push(c.source);
      } else {
        // image / audio / resource / unknown → flat estimate, no base64 BPE.
        const key = typeof block.type === "string" ? block.type : "";
        tokens += MODALITY_ESTIMATE[key] ?? UNKNOWN_BLOCK_ESTIMATE;
        // A flat estimate is an approximation, never "exact".
        sources.push("tokenizer-approx");
      }
    }
  } else if (res.content !== undefined) {
    // content present but not an array (e.g. a bare string) → count it whole.
    const c = tok.countValue(res.content, family);
    tokens += c.tokens;
    sources.push(c.source);
  }

  if (res.structuredContent !== undefined) {
    const c = tok.countValue(res.structuredContent, family);
    tokens += c.tokens;
    sources.push(c.source);
  }

  // Nothing measurable found → count the whole object as a fallback so we never
  // silently report zero for a non-empty result.
  if (sources.length === 0) {
    return tok.countValue(result, family);
  }

  return { tokens, source: combineSources(sources) };
}

/**
 * Measure the fixed tool-definition overhead: tokenize the JSON of the entire
 * `tools/list` array once. `tools` is the raw array of tool descriptors as the
 * server advertises them (shape is host/SDK-specific, so it is treated as
 * opaque JSON here).
 */
export function measureToolDefs(
  tools: readonly unknown[],
  family: ModelFamily,
  tok: Tokenizer = getTokenizer(),
): TokenCount {
  return tok.countValue(tools, family);
}

/**
 * Measure one RUNTIME hook dispatch (the new `hook` developer-axis surface).
 *
 * Input  = canonical JSON of the inbound normalized event payload the handler
 *          reads (the host-provided fields: toolInput / prompt / raw / etc.).
 * Output = canonical JSON of what the handler RETURNS that becomes context or a
 *          decision the host consumes (additionalContext / updatedInput / reason
 *          and the rest of the normalized {@link HookResponse}).
 *
 * Uses the SAME tokenizer + worst-of confidence combination as the proxy. Pure:
 * no IO, no mutation. The two values are tokenized whole (a hook payload has no
 * binary content blocks to special-case, unlike a tool result).
 */
export function measureHook(
  eventPayload: unknown,
  handlerReturn: unknown,
  family: ModelFamily,
  tok: Tokenizer = getTokenizer(),
): ToolCallMeasurement {
  const input = tok.countValue(eventPayload, family);
  const output = tok.countValue(handlerReturn, family);
  return {
    inputTokens: input.tokens,
    outputTokens: output.tokens,
    source: worstConfidence(input.source, output.source),
  };
}
