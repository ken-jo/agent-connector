/**
 * tests/cli/help — per-command `--help` + friendly bad-flag errors.
 *
 * No command module defines a --help flag (strict parseArgs would throw on it),
 * so the dispatcher answers it centrally from COMMAND_USAGE and converts
 * ERR_PARSE_ARGS_* throws into a branded one-line error + usage instead of a
 * raw stack trace — the root help explicitly tells users to run
 * `<command> --help`, so this path must never crash.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/app.js";

function capture(stream: "stdout" | "stderr"): { restore: () => void; text: () => string } {
  let out = "";
  const spy = vi
    .spyOn(process[stream], "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
  return { restore: () => spy.mockRestore(), text: () => out };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const EVERY_COMMAND = [
  "detect",
  "install",
  "uninstall",
  "upgrade",
  "sync",
  "update",
  "package",
  "doctor",
  "status",
  "telemetry",
  "usage",
  "leaderboard",
  "hook",
  "statusline",
  "serve",
];

describe("<command> --help", () => {
  it.each(EVERY_COMMAND)("`%s --help` prints a usage line and exits 0 (never a stack trace)", async (cmd) => {
    const out = capture("stdout");
    const code = await main([cmd, "--help"]);
    out.restore();
    expect(code).toBe(0);
    expect(out.text()).toContain("usage: agent-connector");
  });

  it("brands the per-command usage for an embedded CLI", async () => {
    const out = capture("stdout");
    const code = await main(["install", "--help"], { programName: "acme-db" });
    out.restore();
    expect(code).toBe(0);
    expect(out.text()).toContain("usage: acme-db install");
  });
});

describe("unknown flag → friendly error", () => {
  it("prints the parse message + usage instead of throwing (exit 2)", async () => {
    const errCap = capture("stderr");
    const code = await main(["install", "--no-such-flag"]);
    errCap.restore();
    expect(code).toBe(2);
    const text = errCap.text();
    expect(text).toContain("usage: agent-connector install");
    expect(text).toContain("agent-connector:"); // branded fail(), not a stack trace
  });
});
