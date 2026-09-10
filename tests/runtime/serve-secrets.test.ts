/**
 * runtime/serve — stored secrets reach the REAL server's environment only.
 *
 * The host config carries `--secret-env NAME={secret:X}` placeholders (never a
 * value). runServe resolves them from the keystore (the file backend here,
 * under a temp data root) AFTER pinning --data-dir and BEFORE the proxy
 * spawns the child: the resolved values go into the child env passed to
 * runServeProxy, never into process.env, and a missing secret aborts the
 * launch (SecretResolutionError) instead of starting the server with an
 * empty value. A wrapper that exists only to deliver secrets (telemetry off,
 * or wrapForTelemetry:false) turns measurement off. The CLI `serve` command
 * is driven end-to-end for the flag parsing.
 *
 * Isolation mirrors serve-data-dir.test.ts: proxy/store/tokenizer mocked, a
 * real connector record registered under a temp root, env restored after.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunServeProxyOptions } from "../../src/telemetry/proxy.js";

const proxyMock = vi.fn(async (_opts: RunServeProxyOptions) => 0);
vi.mock("../../src/telemetry/proxy.js", () => ({
  runServeProxy: (opts: RunServeProxyOptions) => proxyMock(opts),
}));
vi.mock("../../src/telemetry/store.js", () => ({
  openStore: () => ({ append() {}, query: () => [], rollup: () => [], close() {} }),
}));
vi.mock("../../src/telemetry/tokenizer.js", () => ({ getTokenizer: () => ({}) }));

import { run as serveCommand } from "../../src/cli/commands/serve.js";
import { defineConnector } from "../../src/core/define-connector.js";
import { registerConnector } from "../../src/core/load-connector.js";
import { SecretResolutionError, openSecretStore } from "../../src/core/secrets.js";
import { runServe } from "../../src/runtime/serve.js";

const SAVED_KEYS = [
  "HOME",
  "USERPROFILE",
  "AGENT_CONNECTOR_DATA_DIR",
  "AGENT_CONNECTOR_SECRETS_BACKEND",
  "API_KEY",
  "AUTH",
] as const;
const saved: Record<string, string | undefined> = {};

let tmpHome: string;
let dataRoot: string;

const SERVER = { transport: "stdio" as const, command: "node", args: ["server.js"] };

function register(id: string, extra: Record<string, unknown>): void {
  const connector = defineConnector({ id, server: SERVER, ...extra });
  const modPath = join(dataRoot, `${id}.config.mjs`);
  writeFileSync(modPath, "export default {};\n", "utf8");
  registerConnector(connector, modPath);
}

beforeEach(() => {
  for (const k of SAVED_KEYS) saved[k] = process.env[k];
  tmpHome = mkdtempSync(join(tmpdir(), "ac-ss-home-"));
  dataRoot = mkdtempSync(join(tmpdir(), "ac-ss-data-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = dataRoot;
  // The plaintext file backend: no OS keystore prompt, no machine state.
  process.env.AGENT_CONNECTOR_SECRETS_BACKEND = "file";
  delete process.env.API_KEY;
  delete process.env.AUTH;

  register("secrets-demo", { telemetry: { enabled: true } });
  register("secrets-quiet", { telemetry: { enabled: false } });
  register("secrets-nowrap", {
    telemetry: { enabled: true },
    server: { ...SERVER, wrapForTelemetry: false },
  });
  register("secrets-hostwrap", {
    telemetry: { enabled: true },
    platforms: { codex: { server: { wrapForTelemetry: false } } },
  });
  openSecretStore({ connectorId: "secrets-demo", backend: "file", dataRoot }).set(
    "API_KEY",
    "sk-test-123",
  );
  openSecretStore({ connectorId: "secrets-quiet", backend: "file", dataRoot }).set(
    "API_KEY",
    "sk-quiet",
  );
  openSecretStore({ connectorId: "secrets-nowrap", backend: "file", dataRoot }).set(
    "API_KEY",
    "sk-nowrap",
  );
  openSecretStore({ connectorId: "secrets-hostwrap", backend: "file", dataRoot }).set(
    "API_KEY",
    "sk-host",
  );
  proxyMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of SAVED_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of [tmpHome, dataRoot]) rmSync(d, { recursive: true, force: true });
});

const lastProxyOpts = (): RunServeProxyOptions => proxyMock.mock.calls.at(-1)![0]!;

describe("runServe + secretEnv", () => {
  it("resolves `{secret:X}` placeholders into the CHILD env only, measurement on", async () => {
    // Simulate an env-stripping host: only --data-dir locates the root.
    delete process.env.AGENT_CONNECTOR_DATA_DIR;
    const code = await runServe({
      connectorId: "secrets-demo",
      serverCommand: "node",
      serverArgs: ["server.js"],
      hostPlatformOverride: "codex",
      dataDir: dataRoot,
      secretEnv: { API_KEY: "{secret:API_KEY}", AUTH: "Bearer {secret:API_KEY}" },
    });
    expect(code).toBe(0);
    expect(proxyMock).toHaveBeenCalledTimes(1);
    const opts = lastProxyOpts();
    expect(opts.env?.API_KEY).toBe("sk-test-123");
    expect(opts.env?.AUTH).toBe("Bearer sk-test-123");
    // The child inherits the wrapper's environment on top of the secrets…
    expect(opts.env?.HOME).toBe(tmpHome);
    // …but the wrapper's own process.env never learns the values.
    expect(process.env.API_KEY).toBeUndefined();
    expect(process.env.AUTH).toBeUndefined();
    expect(opts.measurementEnabled).toBe(true);
  });

  it("aborts BEFORE the proxy spawns anything when a referenced secret is not set", async () => {
    const attempt = runServe({
      connectorId: "secrets-demo",
      serverCommand: "node",
      serverArgs: ["server.js"],
      dataDir: dataRoot,
      secretEnv: { API_KEY: "{secret:API_KEY}", OTHER: "{secret:MISSING_ONE}" },
    });
    await expect(attempt).rejects.toBeInstanceOf(SecretResolutionError);
    await expect(attempt).rejects.toMatchObject({
      connectorId: "secrets-demo",
      missing: ["MISSING_ONE"],
    });
    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("turns measurement OFF for a secrets-only wrapper (telemetry disabled)", async () => {
    const code = await runServe({
      connectorId: "secrets-quiet",
      serverCommand: "node",
      serverArgs: ["server.js"],
      dataDir: dataRoot,
      secretEnv: { API_KEY: "{secret:API_KEY}" },
    });
    expect(code).toBe(0);
    const opts = lastProxyOpts();
    expect(opts.env?.API_KEY).toBe("sk-quiet");
    expect(opts.measurementEnabled).toBe(false);
  });

  it("turns measurement OFF when the server opted out of telemetry wrapping", async () => {
    await runServe({
      connectorId: "secrets-nowrap",
      serverCommand: "node",
      serverArgs: ["server.js"],
      dataDir: dataRoot,
      secretEnv: { API_KEY: "{secret:API_KEY}" },
    });
    const opts = lastProxyOpts();
    expect(opts.env?.API_KEY).toBe("sk-nowrap");
    expect(opts.measurementEnabled).toBe(false);
  });

  it("judges telemetry wrapping by the HOST's effective server (a per-host wrapForTelemetry:false override)", async () => {
    const serve = (host: "codex" | "claude-code") =>
      runServe({
        connectorId: "secrets-hostwrap",
        serverCommand: "node",
        serverArgs: ["server.js"],
        dataDir: dataRoot,
        hostPlatformOverride: host,
        secretEnv: { API_KEY: "{secret:API_KEY}" },
      });
    await serve("codex");
    expect(lastProxyOpts().env?.API_KEY).toBe("sk-host");
    expect(lastProxyOpts().measurementEnabled).toBe(false);
    await serve("claude-code");
    expect(lastProxyOpts().measurementEnabled).toBe(true);
    // No --host baked in: the base server decides; a runtime-detected host
    // never applies another host's override.
    await runServe({
      connectorId: "secrets-hostwrap",
      serverCommand: "node",
      serverArgs: ["server.js"],
      dataDir: dataRoot,
      secretEnv: { API_KEY: "{secret:API_KEY}" },
    });
    expect(lastProxyOpts().measurementEnabled).toBe(true);
  });

  it("without secretEnv the child env is the wrapper's env and measurement stays on", async () => {
    await runServe({
      connectorId: "secrets-demo",
      serverCommand: "node",
      serverArgs: ["server.js"],
      dataDir: dataRoot,
    });
    const opts = lastProxyOpts();
    expect(opts.env?.API_KEY).toBeUndefined();
    expect(opts.env?.HOME).toBe(tmpHome);
    expect(opts.measurementEnabled).toBe(true);
  });
});

describe("`serve` CLI — --secret-env flag parsing", () => {
  it("collects repeated --secret-env NAME=template flags and delivers them through runServe", async () => {
    // The command process.exit()s with the proxy's code after runServe returns.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await serveCommand([
      "--connector",
      "secrets-demo",
      "--host",
      "codex",
      "--data-dir",
      dataRoot,
      "--secret-env",
      "API_KEY={secret:API_KEY}",
      "--secret-env",
      "AUTH=Bearer {secret:API_KEY}",
      "--",
      "node",
      "server.js",
      "--flag",
    ]);
    expect(exit).toHaveBeenCalledWith(0);
    expect(proxyMock).toHaveBeenCalledTimes(1);
    const opts = lastProxyOpts();
    expect(opts.command).toBe("node");
    expect(opts.args).toEqual(["server.js", "--flag"]);
    expect(opts.env?.API_KEY).toBe("sk-test-123");
    expect(opts.env?.AUTH).toBe("Bearer sk-test-123");
    expect(opts.hostPlatform).toBe("codex");
  });

  it("fails (exit 2) on a malformed --secret-env instead of launching without the secret", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await serveCommand([
      "--connector",
      "secrets-demo",
      "--secret-env",
      "no-equals-sign",
      "--",
      "node",
      "server.js",
    ]);
    expect(code).toBe(2);
    expect(proxyMock).not.toHaveBeenCalled();
    const text = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("--secret-env expects NAME=template");
  });

  it("exits 1 with the `secrets set` hint, not a stack trace, when a referenced secret is not set", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const code = await serveCommand([
      "--connector",
      "secrets-demo",
      "--data-dir",
      dataRoot,
      "--secret-env",
      "API_KEY={secret:API_KEY}",
      "--secret-env",
      "MISSING={secret:nope}",
      "--",
      "node",
      "server.js",
    ]);
    expect(code).toBe(1);
    expect(exit).not.toHaveBeenCalled();
    expect(proxyMock).not.toHaveBeenCalled();
    const text = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("nope");
    expect(text).toContain("--connector-id secrets-demo");
    expect(text).not.toMatch(/\n\s+at /);
  });
});
