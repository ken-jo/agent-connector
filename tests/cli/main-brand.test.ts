/**
 * tests/cli/main-brand — main(argv, { programName }) brands the usage/help text.
 *
 * Pure unit test over {@link main}: capture stdout/stderr and assert the brand
 * replaces "agentconnect" in the top-level usage title, the `usage:` line, the
 * per-command help footer, the `--version` line, and the unknown-command error —
 * while the DEFAULT still reads "agentconnect" with no opts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/app.js";

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

function captureStderr(): { restore: () => void; text: () => string } {
  let out = "";
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
  return { restore: () => spy.mockRestore(), text: () => out };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("main(argv, { programName }) branding", () => {
  it("brands the top-level usage string for --help", async () => {
    const cap = captureStdout();
    const code = await main(["--help"], { programName: "acme-db" });
    cap.restore();
    expect(code).toBe(0);
    const text = cap.text();
    expect(text).toContain("acme-db — write your MCP server");
    expect(text).toContain("usage: acme-db <command>");
    expect(text).toContain("Run `acme-db <command> --help`");
    expect(text).not.toContain("agentconnect");
  });

  it("brands --version and prints the real package version", async () => {
    const cap = captureStdout();
    const code = await main(["--version"], { programName: "acme-db" });
    cap.restore();
    expect(code).toBe(0);
    // brand + concrete semver — never just the name, never 0.0.0 fallback.
    expect(cap.text().trim()).toMatch(/^acme-db \d+\.\d+\.\d+$/);
    expect(cap.text()).not.toContain("0.0.0");
  });

  it("brands the unknown-command error on stderr", async () => {
    const cap = captureStderr();
    const code = await main(["nope-not-real"], { programName: "acme-db" });
    cap.restore();
    expect(code).toBe(2);
    expect(cap.text()).toContain('acme-db: unknown command "nope-not-real"');
    expect(cap.text()).not.toContain("agentconnect:");
  });

  it("brands fail() errors from command modules (not always agentconnect:)", async () => {
    const cap = captureStderr();
    // upgrade validates --channel via the shared fail() helper.
    const code = await main(["upgrade", "--channel", "bogus"], { programName: "acme-db" });
    cap.restore();
    expect(code).toBe(2);
    expect(cap.text()).toContain("acme-db: invalid --channel");
    expect(cap.text()).not.toContain("agentconnect:");
  });

  it("defaults to agentconnect when no programName is given (back-compat)", async () => {
    const cap = captureStdout();
    const code = await main(["--help"]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.text()).toContain("usage: agentconnect <command>");
  });
});
