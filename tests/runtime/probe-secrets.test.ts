/**
 * runtime/probe — `doctor --probe` resolves stored secrets the way the serve
 * wrapper does: `${secret:NAME}` refs in `secretEnv` are read from the
 * keystore (file backend under a temp data root here) into the child env; a
 * missing secret is ONE fail diagnostic and the server is never spawned; an
 * unusable backend is a fail, not a throw.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openSecretStore } from "../../src/core/secrets.js";
import { probeStdioServer } from "../../src/runtime/probe.js";

const SAVED_KEYS = ["AGENT_CONNECTOR_DATA_DIR", "AGENT_CONNECTOR_SECRETS_BACKEND", "API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

let dir: string;
let marker: string;

beforeEach(() => {
  for (const k of SAVED_KEYS) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), "ac-probe-secrets-"));
  marker = join(dir, "server-started");
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, "data");
  process.env.AGENT_CONNECTOR_SECRETS_BACKEND = "file";
  delete process.env.API_KEY;
  openSecretStore({ connectorId: "acme", backend: "file", dataRoot: join(dir, "data") }).set(
    "API_KEY",
    "sk-test-123",
  );
});

afterEach(() => {
  for (const k of SAVED_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A fake MCP server that reports what API_KEY it received and marks that it started. */
function fakeServer(): string {
  const path = join(dir, "fake-server.mjs");
  writeFileSync(
    path,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "started");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === "initialize")
      reply(m.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Fake[" + (process.env.API_KEY ?? "unset") + "|" + (process.env.PLAIN ?? "unset") + "]", version: "1.0.0" } });
    else if (m.method === "ping") reply(m.id, {});
    else if (m.method === "tools/list") reply(m.id, { tools: [{ name: "a" }] });
  }
});
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
`,
    "utf8",
  );
  return path;
}

describe("probeStdioServer + secretEnv", () => {
  it("resolves `${secret:NAME}` refs from the store into the child env and probes normally", async () => {
    const results = await probeStdioServer(process.execPath, [fakeServer()], {
      label: "acme",
      connectorId: "acme",
      timeoutMs: 3000,
      env: { PLAIN: "visible" },
      secretEnv: { API_KEY: "${secret:API_KEY}" },
    });
    const init = results.find((r) => r.check === "acme: MCP initialize");
    expect(init?.status).toBe("pass");
    expect(init?.message).toContain("Fake[sk-test-123|visible]");
    expect(results.some((r) => r.status === "fail")).toBe(false);
    // Resolved only for the child: the probing process never learns the value.
    expect(process.env.API_KEY).toBeUndefined();
  });

  it("reports the missing names as ONE fail and never spawns the server", async () => {
    const results = await probeStdioServer(process.execPath, [fakeServer()], {
      label: "acme",
      connectorId: "acme",
      timeoutMs: 3000,
      secretEnv: { API_KEY: "${secret:API_KEY}", TOKEN: "${secret:TOKEN}" },
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "fail", check: "acme: MCP probe" });
    expect(results[0]!.message).toContain("secrets not set: TOKEN");
    expect(results[0]!.message).toContain("secrets set");
    expect(existsSync(marker)).toBe(false);
  });

  it("fails (does not throw) when the secrets backend is unusable", async () => {
    process.env.AGENT_CONNECTOR_SECRETS_BACKEND = "bogus-backend";
    const results = await probeStdioServer(process.execPath, [fakeServer()], {
      label: "acme",
      connectorId: "acme",
      timeoutMs: 3000,
      secretEnv: { API_KEY: "${secret:API_KEY}" },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("fail");
    expect(results[0]!.message).toContain("secrets unavailable:");
    expect(results[0]!.message).toContain("bogus-backend");
    expect(existsSync(marker)).toBe(false);
  });

  it("fails when secretEnv is given without a connectorId (secrets are per connector)", async () => {
    const results = await probeStdioServer(process.execPath, [fakeServer()], {
      label: "acme",
      timeoutMs: 3000,
      secretEnv: { API_KEY: "${secret:API_KEY}" },
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "fail", check: "acme: MCP probe" });
    expect(results[0]!.message).toContain("connectorId");
    expect(existsSync(marker)).toBe(false);
  });
});
