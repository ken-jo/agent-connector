/**
 * adapters/hermes-http-mcp — remote HTTP MCP server registration.
 *
 * Hermes Agent (NousResearch/hermes-agent) registers stdio sidecars AND remote
 * HTTP servers under the SAME `mcp_servers` key — stdio as {command,args,env},
 * HTTP as {url, headers?} with NO transport/type discriminator (docs:
 * website/docs/user-guide/features/mcp.md "HTTP servers"). Hermes has no SSE
 * transport. The adapter advertised transports ["stdio","http"] but installServer
 * previously skip-warned every non-stdio transport, so HTTP servers were never
 * emitted. These tests lock the HTTP render + the stdio regression + the
 * report-don't-drop posture for an unsupported transport.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { readYaml } from "../../src/core/yaml.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector, Transport } from "../../src/core/types.js";

import hermesAdapter from "../../src/adapters/hermes/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-hermes-http";

function connector(transport: Transport): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Hermes HTTP",
    version: "1.0.0",
    server:
      transport === "stdio"
        ? { transport, command: "npx", args: ["-y", "@x/y"], tools: { include: ["*"] } }
        : {
            transport,
            url: "https://mcp.acme.example/mcp",
            headers: { Authorization: "Bearer ${env:ACME_TOKEN}" },
            tools: { include: ["*"] },
          },
    telemetry: { enabled: false },
  });
}

function buildCtx(projectDir: string, c: ResolvedConnector): InstallContext {
  return { connector: c, scope: "user", projectDir, homeBinPath: HOME_BIN, dataRoot: projectDir, dryRun: false };
}
function configPath(projectDir: string): string {
  return join(projectDir, ".hermes", "config.yaml");
}
function readServers(projectDir: string): Record<string, any> {
  const cfg = readYaml<Record<string, any>>(configPath(projectDir)) ?? {};
  return (cfg.mcp_servers ?? {}) as Record<string, any>;
}

let saved: Record<string, string | undefined> = {};
const KEYS = ["HOME", "USERPROFILE", "ACME_TOKEN"];
beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k]; });
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-hermes-http-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.ACME_TOKEN = "tok-123";
  return dir;
}

describe("hermes adapter — remote HTTP MCP", () => {
  it("installServer writes a remote HTTP entry { url, headers } (no command/transport key)", () => {
    const projectDir = freshProject();
    const changes = hermesAdapter.installServer(buildCtx(projectDir, connector("http")));
    expect(changes[0]?.action).toBe("create");
    const entry = readServers(projectDir)[CONNECTOR_ID];
    expect(entry.url).toBe("https://mcp.acme.example/mcp");
    expect(entry.headers.Authorization).toBe("Bearer tok-123"); // env ref resolved to a literal
    expect("command" in entry).toBe(false);
    expect("transport" in entry).toBe(false);
    expect("type" in entry).toBe(false);
  });

  it("a headerless http server renders just { url } (no empty headers key)", () => {
    const projectDir = freshProject();
    const c = defineConnector({
      id: CONNECTOR_ID,
      server: { transport: "http", url: "https://mcp.acme.example/mcp", tools: { include: ["*"] } },
      telemetry: { enabled: false },
    });
    hermesAdapter.installServer(buildCtx(projectDir, c));
    const entry = readServers(projectDir)[CONNECTOR_ID];
    expect(entry.url).toBe("https://mcp.acme.example/mcp");
    expect("headers" in entry).toBe(false);
  });

  it("stdio servers still render as { command, args } (regression)", () => {
    const projectDir = freshProject();
    hermesAdapter.installServer(buildCtx(projectDir, connector("stdio")));
    const entry = readServers(projectDir)[CONNECTOR_ID];
    expect(entry.command).toBeTruthy();
    expect("url" in entry).toBe(false);
  });

  it("an unsupported transport (sse — Hermes has none) is skip-warned, not written", () => {
    const projectDir = freshProject();
    const changes = hermesAdapter.installServer(buildCtx(projectDir, connector("sse")));
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toMatch(/transport "sse" not registrable/);
    expect(readServers(projectDir)[CONNECTOR_ID]).toBeUndefined();
  });
});
