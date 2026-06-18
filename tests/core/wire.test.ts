/**
 * adapters/claude-code/wire — shared hook-wire helpers.
 *
 * normalizeSessionSource maps a host's raw session-start `source` string onto
 * the canonical SessionStartEvent source enum. This helper was lifted out of 15
 * byte-identical per-host copies, so it carries the cross-host contract for all
 * four branches — the per-host adapter suites only exercise the `startup`
 * default, leaving compact/resume/clear uncovered until now.
 */

import { describe, expect, it } from "vitest";

import { normalizeSessionSource } from "../../src/adapters/claude-code/wire.js";

describe("normalizeSessionSource", () => {
  it("maps the three recognized sources to themselves", () => {
    expect(normalizeSessionSource("compact")).toBe("compact");
    expect(normalizeSessionSource("resume")).toBe("resume");
    expect(normalizeSessionSource("clear")).toBe("clear");
  });

  it("maps the literal \"startup\" to \"startup\"", () => {
    expect(normalizeSessionSource("startup")).toBe("startup");
  });

  it("defaults an unrecognized source to \"startup\"", () => {
    expect(normalizeSessionSource("something-else")).toBe("startup");
  });

  it("defaults undefined to \"startup\"", () => {
    expect(normalizeSessionSource(undefined)).toBe("startup");
  });
});
