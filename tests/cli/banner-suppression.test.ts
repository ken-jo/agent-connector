/**
 * tests/cli/banner-suppression — the decorative banner never contaminates the
 * scripted/piped output of install / uninstall / upgrade / doctor.
 *
 * The banner is wired at the TOP of each of the four commands, but it is gated
 * (see cli/banner.shouldShowBanner) so it shows ONLY for an interactive TTY and
 * never under --json / --quiet. These tests assert the gate end-to-end through
 * main():
 *   • the default test runner has a non-TTY stdout → NO banner art appears, and
 *     each command's existing key output line is intact (no regression to the
 *     friendly renderer just merged);
 *   • forcing stdout.isTTY=true makes the banner appear (proving the wiring),
 *     while adding --quiet (all four) or --json (doctor) suppresses it again.
 *
 * Hermetic: every command runs --dry-run against an empty temp project (the
 * tool-only / no-target branches), so nothing is written.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/app.js";

/** Any block-art glyph the banner uses — the unambiguous "banner is here" marker. */
const ART = /[█╗╔╝╚║═▄▀]/;
const POWERED_BY = "powered by @ken-jo/agent-connector";

function captureStdout(): { restore: () => void; text: () => string } {
  let out = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
  return { restore: () => spy.mockRestore(), text: () => out };
}

/** Run main() with stdout.isTTY forced to `tty`, restoring it afterward. */
async function runWithTTY(tty: boolean, argv: string[]): Promise<string> {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
  const cap = captureStdout();
  try {
    await main(argv);
  } finally {
    cap.restore();
    if (desc) Object.defineProperty(process.stdout, "isTTY", desc);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
  return cap.text();
}

function emptyProject(): string {
  return mkdtempSync(join(tmpdir(), "ac-banner-"));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("banner suppression — piped/non-TTY output is unchanged (no regression)", () => {
  it("upgrade (non-TTY): no banner art, tool-only output intact", async () => {
    const text = await runWithTTY(false, ["upgrade", "--dry-run", "--project", emptyProject()]);
    expect(ART.test(text)).toBe(false);
    expect(text).not.toContain(POWERED_BY);
    // The existing tool-only refresh output is byte-present (former `update`).
    expect(text).toContain("no connector config found");
    expect(text).toContain("managed (explicit) updates");
  });

  it("doctor (non-TTY): no banner art, the diagnose/no-target line intact", async () => {
    const text = await runWithTTY(false, ["doctor", "--targets", "claude-code", "--project", emptyProject()]);
    expect(ART.test(text)).toBe(false);
    expect(text).not.toContain(POWERED_BY);
    // doctor still produces its normal report tail.
    expect(text).toMatch(/doctor: (all checks passed|one or more checks FAILED)\.|no target platforms/);
  });

  it("doctor --json (forced TTY): NO banner, output is valid JSON", async () => {
    const text = await runWithTTY(true, [
      "doctor",
      "--json",
      "--targets",
      "claude-code",
      "--project",
      emptyProject(),
    ]);
    expect(ART.test(text)).toBe(false);
    expect(text).not.toContain(POWERED_BY);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it.each(["install", "uninstall", "upgrade", "doctor"])(
    "%s --quiet (forced TTY): banner suppressed",
    async (cmd) => {
      const proj = emptyProject();
      const argv =
        cmd === "doctor"
          ? ["doctor", "--quiet", "--targets", "claude-code", "--project", proj]
          : [cmd, "--quiet", "--dry-run", "--project", proj];
      const text = await runWithTTY(true, argv);
      expect(ART.test(text)).toBe(false);
      expect(text).not.toContain(POWERED_BY);
    },
  );
});

describe("banner appears for an interactive TTY (wiring proof)", () => {
  it("upgrade (forced TTY, no --quiet): banner art + footer present", async () => {
    const prevNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR; // ensure the gate isn't side-stepped by env
    try {
      const text = await runWithTTY(true, ["upgrade", "--dry-run", "--project", emptyProject()]);
      expect(ART.test(text)).toBe(true);
      expect(text).toContain(POWERED_BY);
      // The original command output still follows the banner.
      expect(text).toContain("no connector config found");
    } finally {
      if (prevNoColor != null) process.env.NO_COLOR = prevNoColor;
    }
  });

  it("doctor (forced TTY, no --json/--quiet): banner present", async () => {
    const prevNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      const text = await runWithTTY(true, [
        "doctor",
        "--targets",
        "claude-code",
        "--project",
        emptyProject(),
      ]);
      expect(ART.test(text)).toBe(true);
      expect(text).toContain(POWERED_BY);
    } finally {
      if (prevNoColor != null) process.env.NO_COLOR = prevNoColor;
    }
  });
});
