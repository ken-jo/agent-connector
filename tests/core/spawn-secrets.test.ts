/**
 * core/spawn — secret delivery through the `serve` wrapper.
 *
 *   • secretEnvFlags: `--secret-env NAME=<template>` per entry, sorted by NAME,
 *     templates carry `{secret:X}` placeholders (never `$`, never a value);
 *   • needsServeWrapper: telemetry wrap OR secrets → wrap (secrets force the
 *     wrapper even when telemetry is off / wrapForTelemetry:false);
 *   • buildServeWrapperCommand: the flags sit after --scope/--host/--data-dir
 *     and before `--`, and a wrapper without secrets is unchanged;
 *   • buildWrappedStdio: the adapters' shared path picks all of this up.
 */

import { describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import {
  buildServeWrapperCommand,
  buildWrappedStdio,
  needsServeWrapper,
  secretEnvFlags,
  shouldWrapForTelemetry,
} from "../../src/core/spawn.js";
import type { ServerDef } from "../../src/core/types.js";
import { HOME_BIN, buildCtx } from "../support/env.js";

const ON = { enabled: true };
const OFF = { enabled: false };

function stdio(extra: Partial<ServerDef> = {}): ServerDef {
  return { transport: "stdio", command: "npx", args: ["-y", "@acme/db-mcp"], ...extra };
}

describe("secretEnvFlags", () => {
  it("returns nothing for an absent or empty secretEnv", () => {
    expect(secretEnvFlags(undefined)).toEqual([]);
    expect(secretEnvFlags({})).toEqual([]);
  });

  it("emits one --secret-env NAME=<template> pair per entry, sorted by NAME, `$`-free", () => {
    const flags = secretEnvFlags({
      ZEBRA: "${secret:Z}",
      ALPHA: "Bearer ${secret:A}",
      MID: "${secret:M1}-${secret:M2}",
    });
    expect(flags).toEqual([
      "--secret-env",
      "ALPHA=Bearer {secret:A}",
      "--secret-env",
      "MID={secret:M1}-{secret:M2}",
      "--secret-env",
      "ZEBRA={secret:Z}",
    ]);
    // No `$` survives: Claude `${VAR}`, VS Code `${env:VAR}` and cmd.exe `%VAR%`
    // expansion can never touch the placeholder.
    expect(flags.join(" ")).not.toContain("$");
  });
});

describe("needsServeWrapper", () => {
  const secrets = { API_KEY: "${secret:API_KEY}" };

  it("wraps for secrets even when telemetry is off (shouldWrapForTelemetry says no)", () => {
    const server = stdio({ secretEnv: secrets });
    expect(shouldWrapForTelemetry(server, OFF)).toBe(false);
    expect(needsServeWrapper(server, OFF)).toBe(true);
  });

  it("wraps for secrets when the server opted out of telemetry wrapping", () => {
    expect(needsServeWrapper(stdio({ wrapForTelemetry: false, secretEnv: secrets }), ON)).toBe(true);
    expect(needsServeWrapper(stdio({ wrapForTelemetry: false }), ON)).toBe(false);
  });

  it("keeps the telemetry semantics unchanged without secrets", () => {
    expect(needsServeWrapper(stdio(), ON)).toBe(true);
    expect(needsServeWrapper(stdio(), OFF)).toBe(false);
    expect(needsServeWrapper(stdio({ secretEnv: {} }), OFF)).toBe(false);
  });

  it("never wraps a remote server or a stdio server without a command", () => {
    expect(
      needsServeWrapper(
        { transport: "http", url: "https://example.com/mcp", secretEnv: secrets },
        ON,
      ),
    ).toBe(false);
    expect(needsServeWrapper({ transport: "stdio", command: "", secretEnv: secrets }, OFF)).toBe(
      false,
    );
  });
});

describe("buildServeWrapperCommand + secretEnv", () => {
  it("places the --secret-env flags after the other flags and before `--`", () => {
    const out = buildServeWrapperCommand(
      HOME_BIN,
      "acme-db",
      "npx",
      ["-y", "@acme/db-mcp"],
      "user",
      "codex",
      "/data/root",
      { B: "${secret:B}", A: "x-${secret:A}" },
    );
    expect(out.command).toBe(HOME_BIN);
    expect(out.args).toEqual([
      "serve",
      "--connector",
      "acme-db",
      "--scope",
      "user",
      "--host",
      "codex",
      "--data-dir",
      "/data/root",
      "--secret-env",
      "A=x-{secret:A}",
      "--secret-env",
      "B={secret:B}",
      "--",
      "npx",
      "-y",
      "@acme/db-mcp",
    ]);
  });

  it("is unchanged when no secretEnv is given (regression)", () => {
    const out = buildServeWrapperCommand(HOME_BIN, "acme-db", "npx", ["-y", "@acme/db-mcp"], "user");
    expect(out.args).toEqual(["serve", "--connector", "acme-db", "--scope", "user", "--", "npx", "-y", "@acme/db-mcp"]);
  });
});

describe("buildWrappedStdio (the adapters' shared serve-wrap)", () => {
  it("wraps a telemetry-off connector whose server references a secret, placeholders only", () => {
    const connector = defineConnector({
      id: "acme-db",
      telemetry: { enabled: false },
      server: stdio({ env: { API_KEY: "${secret:API_KEY}", MODE: "prod" } }),
    });
    const ctx = buildCtx("/proj", connector, "user");
    const out = buildWrappedStdio(ctx, connector.server!, "codex", "npx", ["-y", "@acme/db-mcp"]);

    expect(out.command).toBe(HOME_BIN);
    expect(out.args.slice(0, 3)).toEqual(["serve", "--connector", "acme-db"]);
    const sep = out.args.indexOf("--");
    expect(out.args.slice(sep - 2, sep)).toEqual(["--secret-env", "API_KEY={secret:API_KEY}"]);
    expect(out.args.slice(sep + 1)).toEqual(["npx", "-y", "@acme/db-mcp"]);
    // --data-dir (non-default root from buildCtx) precedes the secret flags.
    expect(out.args.indexOf("--data-dir")).toBeLessThan(out.args.indexOf("--secret-env"));
    expect(out.args.join(" ")).not.toContain("${secret:");
    // The plain entry stays for the adapter to render as env; the secret does not.
    expect(connector.server!.env).toEqual({ MODE: "prod" });
  });

  it("leaves a telemetry-off, secret-free server unwrapped (regression)", () => {
    const connector = defineConnector({
      id: "acme-db",
      telemetry: { enabled: false },
      server: stdio({ env: { MODE: "prod" } }),
    });
    const ctx = buildCtx("/proj", connector, "user");
    expect(buildWrappedStdio(ctx, connector.server!, "codex", "npx", ["-y"])).toEqual({
      command: "npx",
      args: ["-y"],
    });
  });
});
