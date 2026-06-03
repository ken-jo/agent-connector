/**
 * telemetry/tokenizer — the default {@link Tokenizer} implementation.
 *
 * Token counts are the only signal that is identical across every host: no host
 * reports a server's per-tool usage back to the server, so the framework
 * tokenizes its OWN bytes locally. We use gpt-tokenizer's `o200k_base` encoding
 * (the GPT-4o / o1 BPE) for all families:
 *   • openai    → exact BPE for the target family            → "tokenizer-exact"
 *   • anthropic → o200k_base used as a documented stand-in   → "tokenizer-approx"
 *   • generic   → o200k_base used as a generic approximation → "tokenizer-approx"
 *
 * gpt-tokenizer is loaded LAZILY on first use, inside a try/catch. If the module
 * (or its BPE data) fails to load we degrade to a chars/4 heuristic that never
 * throws, so telemetry can never break a host's tool call.
 *
 * Pure + side-effect-free apart from the one-time lazy encoder load. No IO.
 */

import { createRequire } from "node:module";

import type {
  ConfidenceSource,
  ModelFamily,
  TokenCount,
  Tokenizer,
} from "./types.js";

/**
 * A CommonJS `require` bound to this module's URL. gpt-tokenizer ships its
 * encoding entry points as CJS (the package `exports` `require` condition maps
 * `./encoding/*` to `./cjs/encoding/*.js`), so we resolve them synchronously via
 * createRequire — this keeps the {@link Tokenizer} surface synchronous and works
 * under ESM / NodeNext without baking an absolute path.
 */
const requireCjs = createRequire(import.meta.url);

/** Minimal shape we use from a gpt-tokenizer encoding module. */
interface EncodingModule {
  encode(text: string): number[];
}

/**
 * Lazy-load state for the shared o200k_base encoder.
 *   - undefined → not attempted yet
 *   - null      → load attempted and failed (stick to the heuristic)
 *   - object    → loaded encoder
 */
let encoderState: EncodingModule | null | undefined;

/** Average characters-per-token for the chars/4 fallback heuristic. */
const HEURISTIC_CHARS_PER_TOKEN = 4;

/**
 * Lazily import the o200k_base encoding. Returns the encoder, or null if the
 * module/data could not be loaded (in which case callers use the heuristic).
 *
 * The dynamic import resolves to `gpt-tokenizer/esm/encoding/o200k_base.js` via
 * the package `exports` map and exposes a named `encode(text) => number[]`.
 */
function loadEncoder(): EncodingModule | null {
  if (encoderState !== undefined) return encoderState;
  try {
    // Synchronous require keeps count() a sync function (per the Tokenizer
    // interface). The package's `require` export condition resolves this to
    // gpt-tokenizer/cjs/encoding/o200k_base.js, which exports a named `encode`.
    const mod = requireCjs("gpt-tokenizer/encoding/o200k_base") as {
      encode?: (text: string) => number[];
    };
    if (mod && typeof mod.encode === "function") {
      encoderState = { encode: mod.encode.bind(mod) };
    } else {
      encoderState = null;
    }
  } catch {
    encoderState = null;
  }
  return encoderState;
}

/** Heuristic chars/4 count — used when no encoder is available. Never throws. */
function heuristicCount(text: string): TokenCount {
  return {
    tokens: Math.ceil(text.length / HEURISTIC_CHARS_PER_TOKEN),
    source: "heuristic",
  };
}

/**
 * Confidence label for a successful BPE count: exact only for the OpenAI family
 * (the encoding actually matches), approximate for everything else.
 */
function bpeSource(family: ModelFamily): ConfidenceSource {
  return family === "openai" ? "tokenizer-exact" : "tokenizer-approx";
}

/**
 * The default tokenizer. A single shared instance is fine: the encoder is
 * stateless across calls and lazy-loaded once.
 */
class DefaultTokenizer implements Tokenizer {
  count(text: string, family: ModelFamily): TokenCount {
    const encoder = loadEncoder();
    if (!encoder) return heuristicCount(text);
    try {
      return { tokens: encoder.encode(text).length, source: bpeSource(family) };
    } catch {
      // A per-call encode failure (e.g. a pathological input) still degrades
      // gracefully rather than breaking the host's tool call.
      return heuristicCount(text);
    }
  }

  countValue(value: unknown, family: ModelFamily): TokenCount {
    return this.count(canonicalString(value), family);
  }
}

/**
 * Canonical string form of an arbitrary JSON value for counting.
 * `undefined` (and anything that JSON.stringify drops to undefined, e.g. a bare
 * function or symbol) serializes to the empty string.
 */
function canonicalString(value: unknown): string {
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  return json ?? "";
}

const SHARED_TOKENIZER: Tokenizer = new DefaultTokenizer();

/** Return the default {@link Tokenizer} (shared singleton). */
export function getTokenizer(): Tokenizer {
  return SHARED_TOKENIZER;
}

/**
 * Infer the {@link ModelFamily} for token counting.
 *
 * An explicit hint other than "auto" wins outright. Otherwise we sniff the
 * client/host name: Anthropic/Claude → anthropic, OpenAI/GPT/Codex → openai,
 * Gemini and everything unrecognized → generic.
 */
export function inferModelFamily(
  clientName: string,
  hint: "auto" | ModelFamily,
): ModelFamily {
  if (hint !== "auto") return hint;
  const name = clientName.toLowerCase();
  if (name.includes("claude") || name.includes("anthropic")) return "anthropic";
  if (
    name.includes("codex") ||
    name.includes("gpt") ||
    name.includes("openai")
  ) {
    return "openai";
  }
  // gemini and all others fall through to the generic approximation.
  return "generic";
}
