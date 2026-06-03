/**
 * telemetry/calibration — the OPT-IN Anthropic count_tokens calibration enricher
 * (4b). Asserts the load-bearing contracts:
 *
 *   • applyCalibration multiplies an anthropic `tokenizer-approx` count by a
 *     stored factor and relabels it `tokenizer-calibrated`; passes through
 *     unchanged (still `tokenizer-approx`) when the family is not anthropic, when
 *     no factor is stored, or when the factor record has zero samples.
 *   • CONFIDENCE_RANK orders heuristic < approx < calibrated < exact < host-native
 *     and worstConfidence picks the least-confident of two.
 *   • isCalibrationEnabled is a hard AND-gate (AGENT_CONNECTOR_CALIBRATE includes
 *     "anthropic" AND ANTHROPIC_API_KEY non-empty) — the privacy-safe default off.
 *   • countTokensAnthropic is fail-open: a mocked global fetch returning non-200,
 *     a non-numeric body, or a thrown network error all resolve to null — never
 *     throws into the data path.
 *
 * Isolation: AGENT_CONNECTOR_DATA_DIR is redirected to a fresh mkdtemp dir so the
 * factor store (dataRoot/calibration.json) never touches the real home; every
 * mutated env + the global fetch stub are saved and restored in afterEach.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyCalibration,
  calibrationPath,
  countTokensAnthropic,
  isCalibrationEnabled,
} from "../../src/telemetry/calibration.js";
import type { CalibrationFactors } from "../../src/telemetry/calibration.js";
import {
  CONFIDENCE_RANK,
  rankOf,
  worstConfidence,
} from "../../src/telemetry/types.js";
import type { ConfidenceSource } from "../../src/telemetry/types.js";

// ─────────────────────────────────────────────────────────────────────────
// Isolation: temp data-root + saved env + restorable global fetch
// ─────────────────────────────────────────────────────────────────────────

let tmp: string;

const SAVED = {
  HOME: process.env.HOME,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  CALIBRATE: process.env.AGENT_CONNECTOR_CALIBRATE,
  API_KEY: process.env.ANTHROPIC_API_KEY,
  TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ac-calib-"));
  process.env.HOME = tmp;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmp;
  delete process.env.AGENT_CONNECTOR_CALIBRATE;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AGENT_CONNECTOR_TELEMETRY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** Seed the on-disk factor store under the (temp) data-root. */
function seedFactors(factors: CalibrationFactors): void {
  writeFileSync(calibrationPath(), `${JSON.stringify(factors, null, 2)}\n`, "utf8");
}

// ─────────────────────────────────────────────────────────────────────────
// applyCalibration
// ─────────────────────────────────────────────────────────────────────────

describe("applyCalibration", () => {
  it("scales an anthropic approx count by a stored factor and labels it calibrated", () => {
    // factor passed explicitly so the test is independent of the on-disk store.
    const factors: CalibrationFactors = { anthropic: { factor: 1.5, samples: 8 } };
    const out = applyCalibration(100, "anthropic", factors);
    expect(out.tokens).toBe(150); // 100 * 1.5
    expect(out.source).toBe("tokenizer-calibrated");
  });

  it("rounds to the nearest integer (never a fractional token)", () => {
    const factors: CalibrationFactors = { anthropic: { factor: 1.234, samples: 5 } };
    const out = applyCalibration(10, "anthropic", factors);
    expect(out.tokens).toBe(12); // round(12.34)
    expect(Number.isInteger(out.tokens)).toBe(true);
    expect(out.source).toBe("tokenizer-calibrated");
  });

  it("reads the factor from the on-disk store when none is passed", () => {
    seedFactors({ anthropic: { factor: 2, samples: 3 } });
    const out = applyCalibration(40, "anthropic");
    expect(out.tokens).toBe(80);
    expect(out.source).toBe("tokenizer-calibrated");
  });

  it("PASSES THROUGH (approx) for a non-anthropic family even with a factor present", () => {
    const factors: CalibrationFactors = { anthropic: { factor: 1.5, samples: 8 } };
    for (const family of ["openai", "generic"] as const) {
      const out = applyCalibration(100, family, factors);
      expect(out.tokens).toBe(100); // unchanged
      expect(out.source).toBe("tokenizer-approx");
    }
  });

  it("PASSES THROUGH (approx) for anthropic when NO factor is stored", () => {
    const out = applyCalibration(100, "anthropic", {});
    expect(out.tokens).toBe(100);
    expect(out.source).toBe("tokenizer-approx");
  });

  it("PASSES THROUGH (approx) when the stored factor has zero samples", () => {
    const factors: CalibrationFactors = { anthropic: { factor: 9, samples: 0 } };
    const out = applyCalibration(100, "anthropic", factors);
    expect(out.tokens).toBe(100); // not yet trustworthy → no scaling
    expect(out.source).toBe("tokenizer-approx");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CONFIDENCE_RANK + worstConfidence
// ─────────────────────────────────────────────────────────────────────────

describe("CONFIDENCE_RANK ordering + worstConfidence", () => {
  it("orders heuristic < approx < calibrated < exact < host-native", () => {
    const order: ConfidenceSource[] = [
      "heuristic",
      "tokenizer-approx",
      "tokenizer-calibrated",
      "tokenizer-exact",
      "host-native",
    ];
    for (let i = 1; i < order.length; i++) {
      const lo = order[i - 1] as ConfidenceSource;
      const hi = order[i] as ConfidenceSource;
      expect(CONFIDENCE_RANK[lo]).toBeLessThan(CONFIDENCE_RANK[hi]);
      expect(rankOf(lo)).toBeLessThan(rankOf(hi));
    }
    // calibrated sits strictly between approx and exact (the load-bearing claim).
    expect(CONFIDENCE_RANK["tokenizer-approx"]).toBeLessThan(
      CONFIDENCE_RANK["tokenizer-calibrated"],
    );
    expect(CONFIDENCE_RANK["tokenizer-calibrated"]).toBeLessThan(
      CONFIDENCE_RANK["tokenizer-exact"],
    );
  });

  it("worstConfidence picks the least-confident (min-rank) of two", () => {
    expect(worstConfidence("tokenizer-exact", "tokenizer-approx")).toBe(
      "tokenizer-approx",
    );
    expect(worstConfidence("tokenizer-approx", "tokenizer-exact")).toBe(
      "tokenizer-approx",
    );
    expect(worstConfidence("host-native", "tokenizer-calibrated")).toBe(
      "tokenizer-calibrated",
    );
    expect(worstConfidence("tokenizer-calibrated", "heuristic")).toBe("heuristic");
    // calibrated vs exact → calibrated is the worse of the two.
    expect(worstConfidence("tokenizer-calibrated", "tokenizer-exact")).toBe(
      "tokenizer-calibrated",
    );
    // identical inputs are returned as-is.
    expect(worstConfidence("host-native", "host-native")).toBe("host-native");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// isCalibrationEnabled — the opt-in AND-gate
// ─────────────────────────────────────────────────────────────────────────

describe("isCalibrationEnabled", () => {
  it("is OFF by default (neither switch set)", () => {
    expect(isCalibrationEnabled()).toBe(false);
  });

  it("is OFF when only AGENT_CONNECTOR_CALIBRATE=anthropic is set (no key)", () => {
    process.env.AGENT_CONNECTOR_CALIBRATE = "anthropic";
    expect(isCalibrationEnabled()).toBe(false);
  });

  it("is OFF when only ANTHROPIC_API_KEY is set (no allowlist)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(isCalibrationEnabled()).toBe(false);
  });

  it("is OFF when the allowlist does not include anthropic", () => {
    process.env.AGENT_CONNECTOR_CALIBRATE = "openai";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(isCalibrationEnabled()).toBe(false);
  });

  it("is OFF when the key is blank/whitespace", () => {
    process.env.AGENT_CONNECTOR_CALIBRATE = "anthropic";
    process.env.ANTHROPIC_API_KEY = "   ";
    expect(isCalibrationEnabled()).toBe(false);
  });

  it("is ON when BOTH switches are set", () => {
    process.env.AGENT_CONNECTOR_CALIBRATE = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(isCalibrationEnabled()).toBe(true);
  });

  it("is ON when anthropic is one of several comma-separated allowlist families", () => {
    process.env.AGENT_CONNECTOR_CALIBRATE = "openai, anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(isCalibrationEnabled()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// countTokensAnthropic — fail-open over a mocked global fetch
// ─────────────────────────────────────────────────────────────────────────

describe("countTokensAnthropic fail-open", () => {
  beforeEach(() => {
    // A key must be present or the function short-circuits before any fetch.
    process.env.ANTHROPIC_API_KEY = "sk-test";
  });

  it("returns null (never throws) when there is no API key, without calling fetch", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(countTokensAnthropic("hello world")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the integer count on a 200 with a numeric input_tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ input_tokens: 42 }),
      })),
    );
    await expect(countTokensAnthropic("hello world")).resolves.toBe(42);
  });

  it("returns null (never throws) on a non-200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: "rate limited" }),
      })),
    );
    await expect(countTokensAnthropic("hello world")).resolves.toBeNull();
  });

  it("returns null (never throws) when fetch itself rejects (network error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(countTokensAnthropic("hello world")).resolves.toBeNull();
  });

  it("returns null on a 200 whose body has a non-numeric / missing input_tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ input_tokens: "lots" }),
      })),
    );
    await expect(countTokensAnthropic("hello world")).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    await expect(countTokensAnthropic("hello world")).resolves.toBeNull();
  });

  it("returns null when the JSON body itself throws while parsing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new Error("unexpected end of JSON input");
        },
      })),
    );
    await expect(countTokensAnthropic("hello world")).resolves.toBeNull();
  });
});
