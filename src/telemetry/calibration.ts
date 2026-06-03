/**
 * telemetry/calibration — OPT-IN Anthropic count_tokens calibration.
 *
 * The default tokenizer counts every family with the OpenAI o200k_base BPE, so
 * an Anthropic session's counts are an honest-but-approximate stand-in
 * ("tokenizer-approx"). This module lets a developer OPT IN to calibrating that
 * approximation against Anthropic's real `count_tokens` endpoint: we sample a
 * tiny fraction of tool calls off-box, learn a per-family correction factor
 * (rolling mean of exact/approx), and apply it to the locally-tokenized counts
 * so they land much closer to the host's real numbers — labeled honestly as
 * "tokenizer-calibrated".
 *
 * PRIVACY + SAFETY — load-bearing invariants:
 *   • OPT-IN only. Nothing here runs unless BOTH AGENT_CONNECTOR_CALIBRATE
 *     contains "anthropic" AND ANTHROPIC_API_KEY is set (see isCalibrationEnabled).
 *   • Sampling only — shouldSample() rate-limits hard so we never hammer the API.
 *   • Content leaves the box ONLY on a sampled call, ONLY when opted in. We store
 *     a single scalar factor + sample count — NEVER the sampled text itself.
 *   • Fail-open everywhere: a network/parse/IO error returns null / passes the
 *     approximation through unchanged and NEVER throws into a tool call or hook.
 *
 * No new dependencies: uses Node's global fetch (Node >= 18) and node:fs.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataRoot, ensureDir } from "../core/paths.js";
import type { ConfidenceSource, ModelFamily } from "./types.js";

// ── Env switches ──────────────────────────────────────────────────────────

/**
 * Is opt-in Anthropic calibration enabled for this process?
 *
 * Requires BOTH:
 *   • AGENT_CONNECTOR_CALIBRATE — a comma-separated allowlist that INCLUDES
 *     `anthropic` (so a future `AGENT_CONNECTOR_CALIBRATE=openai,anthropic` can
 *     opt other families in without touching this gate), and
 *   • ANTHROPIC_API_KEY — a non-empty key to authenticate the off-box call.
 *
 * Either missing → disabled (the privacy-safe default).
 */
export function isCalibrationEnabled(): boolean {
  const families = (process.env.AGENT_CONNECTOR_CALIBRATE || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const key = (process.env.ANTHROPIC_API_KEY || "").trim();
  return families.includes("anthropic") && key !== "";
}

// ── Factor store (dataRoot/calibration.json) ────────────────────────────────

/** One learned correction factor for a model family: factor + sample count. */
export interface CalibrationFactor {
  /** Multiply an approx count by this to estimate the real count. */
  factor: number;
  /** How many samples have folded into the rolling mean. */
  samples: number;
}

/** The on-disk factor map, keyed by model family. */
export type CalibrationFactors = Partial<Record<ModelFamily, CalibrationFactor>>;

/** Path to the learned-factor store: dataRoot()/calibration.json. */
export function calibrationPath(): string {
  return join(dataRoot(), "calibration.json");
}

/**
 * Clamp a measured exact/approx ratio into a sane range. A pathological sample
 * (e.g. an empty-string approx of 0 → Infinity, or a parse glitch) must never
 * poison the rolling mean, so ratios are pinned to [0.2, 5].
 */
const RATIO_MIN = 0.2;
const RATIO_MAX = 5;

function clampRatio(ratio: number): number | null {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  if (ratio < RATIO_MIN) return RATIO_MIN;
  if (ratio > RATIO_MAX) return RATIO_MAX;
  return ratio;
}

/**
 * Load the learned factors from disk. Fail-open: a missing/unreadable/malformed
 * file returns an empty map rather than throwing.
 */
export function loadFactors(): CalibrationFactors {
  const path = calibrationPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") return {};
    const out: CalibrationFactors = {};
    for (const [family, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== "object") continue;
      const rec = value as Record<string, unknown>;
      const factor = rec["factor"];
      const samples = rec["samples"];
      if (
        typeof factor === "number" &&
        Number.isFinite(factor) &&
        factor > 0 &&
        typeof samples === "number" &&
        Number.isFinite(samples) &&
        samples >= 0
      ) {
        (out as Record<string, CalibrationFactor>)[family] = {
          factor,
          samples,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Fold one observed exact/approx `ratio` into the rolling mean for `family` and
 * persist it. A running average converges to the true mean while staying cheap
 * and stateless across processes (each writer reads the prior count, blends in
 * the new sample, writes back). Fail-open: any read/write/clamp problem leaves
 * the store untouched and never throws.
 */
export function recordSample(family: ModelFamily, ratio: number): void {
  const clamped = clampRatio(ratio);
  if (clamped === null) return;
  try {
    const factors = loadFactors();
    const prior = factors[family];
    let next: CalibrationFactor;
    if (prior === undefined || prior.samples <= 0) {
      next = { factor: clamped, samples: 1 };
    } else {
      const samples = prior.samples + 1;
      // Running average: new mean = old mean + (sample - old mean) / n.
      const factor = prior.factor + (clamped - prior.factor) / samples;
      next = { factor, samples };
    }
    const updated: CalibrationFactors = { ...factors, [family]: next };
    const path = calibrationPath();
    ensureDir(dataRoot());
    writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  } catch {
    /* fail-open: a calibration write must never break a tool call */
  }
}

// ── Anthropic count_tokens (off-box, sampled, fail-open) ─────────────────────

/** Default model used for count_tokens when no family→model map applies. */
const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-sonnet-latest";

/** Anthropic count_tokens endpoint. */
const COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";

/** The single field we read out of a successful response. */
interface CountTokensResponse {
  input_tokens?: unknown;
}

/**
 * Ask Anthropic's `count_tokens` endpoint for the exact token count of `text`
 * under `model`. Returns the integer count, or `null` on ANY failure (no key,
 * non-200, network error, unparseable body) — fail-open by contract.
 *
 * Only ever called on a SAMPLED tool call when calibration is opted in, so the
 * sampled text leaves the box only under explicit operator consent.
 */
export async function countTokensAnthropic(
  text: string,
  model: string = DEFAULT_ANTHROPIC_MODEL,
): Promise<number | null> {
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (apiKey === "") return null;
  try {
    const res = await fetch(COUNT_TOKENS_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as CountTokensResponse;
    const n = body.input_tokens;
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) {
      return n;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Sampling (rate-limit so we never hammer the API) ─────────────────────────

/**
 * Sample roughly 1 in {@link SAMPLE_EVERY} calls, with a hard per-minute cap so
 * a burst of tool calls can never fan out into a burst of API calls. Both
 * counters are in-memory (per process) — calibration is a best-effort,
 * low-volume background signal, not a per-call requirement.
 */
const SAMPLE_EVERY = 20;
const MAX_SAMPLES_PER_MINUTE = 10;

let callCounter = 0;
let windowStartMs = 0;
let samplesThisWindow = 0;

/**
 * Should THIS call fire an off-box count_tokens sample? Combines a 1-in-N
 * counter with a rolling per-minute cap. Pure in-memory bookkeeping; never
 * throws, never blocks.
 */
export function shouldSample(now: number = Date.now()): boolean {
  // Roll the per-minute window.
  if (now - windowStartMs >= 60_000) {
    windowStartMs = now;
    samplesThisWindow = 0;
  }
  callCounter += 1;
  if (callCounter % SAMPLE_EVERY !== 0) return false;
  if (samplesThisWindow >= MAX_SAMPLES_PER_MINUTE) return false;
  samplesThisWindow += 1;
  return true;
}

/** Reset the in-memory sampling counters. Test-only seam; cheap + side-effect-free. */
export function _resetSamplingForTest(): void {
  callCounter = 0;
  windowStartMs = 0;
  samplesThisWindow = 0;
}

// ── Apply a learned factor to a local approximation ──────────────────────────

/** Result of {@link applyCalibration}: the adjusted count + its honest source. */
export interface CalibratedCount {
  tokens: number;
  source: Extract<ConfidenceSource, "tokenizer-approx" | "tokenizer-calibrated">;
}

/**
 * Adjust a locally-tokenized `approxTokens` count by the learned factor for
 * `family`. When a stored factor exists for the anthropic family, return the
 * scaled count labeled "tokenizer-calibrated"; otherwise pass the approximation
 * through unchanged as "tokenizer-approx". Pure: reads the factor store but
 * mutates nothing.
 */
export function applyCalibration(
  approxTokens: number,
  family: ModelFamily,
  factors: CalibrationFactors = loadFactors(),
): CalibratedCount {
  if (family === "anthropic") {
    const f = factors[family];
    if (f !== undefined && f.samples > 0 && Number.isFinite(f.factor) && f.factor > 0) {
      return {
        tokens: Math.max(0, Math.round(approxTokens * f.factor)),
        source: "tokenizer-calibrated",
      };
    }
  }
  return { tokens: approxTokens, source: "tokenizer-approx" };
}

/** The model used for a family's count_tokens sample (anthropic → default model). */
export function modelForFamily(_family: ModelFamily): string {
  return DEFAULT_ANTHROPIC_MODEL;
}
