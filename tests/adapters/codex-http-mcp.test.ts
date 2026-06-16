/**
 * adapters/codex-http-mcp — remote streamable-HTTP MCP server registration.
 *
 * Codex config.toml registers stdio sidecars AND streamable-HTTP servers under
 * the SAME [mcp_servers.<id>] table: stdio as {command,args,env}, HTTP as
 * {url, bearer_token_env_var?, http_headers?} with NO explicit transport key
 * (codex infers the transport from `url`). VERIFIED against a live codex-cli
 * 0.139.0: `codex mcp add <id> --url <U> --bearer-token-env-var <E>` writes
 *   [mcp_servers.<id>]
 *   url = "…"
 *   bearer_token_env_var = "…"
 * The adapter advertised transports ["stdio","http"] but installServer
 * previously skip-warned every non-stdio transport, so HTTP servers were never
 * emitted. These tests lock the HTTP render + the stdio regression + the
 * report-don't-drop posture for an unsupported transport (sse).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import TOML from "@iarna/toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector, ServerDef, Transport } from "../../src/core/types.js";

import codexAdapter from "../../src/adapters/codex/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-codex-http";

function connectorWith(server: ServerDef): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Codex HTTP",
    version: "1.0.0",
    server,
    telemetry: { enabled: false },
  });
}

function buildCtx(projectDir: string, c: ResolvedConnector): InstallContext {
  return { connector: c, scope: "user", projectDir, homeBinPath: HOME_BIN, dataRoot: projectDir, dryRun: false };
}
function readServers(projectDir: string, c: ResolvedConnector): Record<string, any> {
  const path = codexAdapter.getServerConfigPath!(buildCtx(projectDir, c));
  const cfg = TOML.parse(readFileSync(path, "utf8")) as Record<string, any>;
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
  const dir = mkdtempSync(join(tmpdir(), "ac-codex-http-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.ACME_TOKEN = "tok-123";
  return dir;
}

describe("codex adapter — remote streamable-HTTP MCP", () => {
  it("installServer writes a streamable-HTTP entry { url, bearer_token_env_var } (no command/transport key)", () => {
    const projectDir = freshProject();
    const c = connectorWith({
      transport: "http",
      url: "https://mcp.acme.example/mcp",
      auth: { type: "bearerEnv", bearerEnvVar: "ACME_TOKEN" },
      tools: { include: ["*"] },
    });
    const changes = codexAdapter.installServer(buildCtx(projectDir, c));
    expect(changes[0]?.action).toBe("create");
    const entry = readServers(projectDir, c)[CONNECTOR_ID];
    expect(entry.url).toBe("https://mcp.acme.example/mcp");
    expect(entry.bearer_token_env_var).toBe("ACME_TOKEN");
    expect("command" in entry).toBe(false);
    expect("transport" in entry).toBe(false);
    expect("type" in entry).toBe(false);
  });

  it("http headers render as http_headers with env refs resolved to literals", () => {
    const projectDir = freshProject();
    const c = connectorWith({
      transport: "http",
      url: "https://mcp.acme.example/mcp",
      headers: { "X-Acme": "Bearer ${env:ACME_TOKEN}" },
      tools: { include: ["*"] },
    });
    codexAdapter.installServer(buildCtx(projectDir, c));
    const entry = readServers(projectDir, c)[CONNECTOR_ID];
    expect(entry.http_headers["X-Acme"]).toBe("Bearer tok-123");
    expect("bearer_token_env_var" in entry).toBe(false);
  });

  it("a bare http server renders just { url } (no empty headers/bearer keys)", () => {
    const projectDir = freshProject();
    const c = connectorWith({ transport: "http", url: "https://mcp.acme.example/mcp", tools: { include: ["*"] } });
    codexAdapter.installServer(buildCtx(projectDir, c));
    const entry = readServers(projectDir, c)[CONNECTOR_ID];
    expect(entry.url).toBe("https://mcp.acme.example/mcp");
    expect("http_headers" in entry).toBe(false);
    expect("bearer_token_env_var" in entry).toBe(false);
  });

  it("stdio servers still render as { command, args } (regression)", () => {
    const projectDir = freshProject();
    const c = connectorWith({ transport: "stdio", command: "npx", args: ["-y", "@x/y"], tools: { include: ["*"] } });
    codexAdapter.installServer(buildCtx(projectDir, c));
    const entry = readServers(projectDir, c)[CONNECTOR_ID];
    expect(entry.command).toBe("npx");
    expect("url" in entry).toBe(false);
  });

  it("an unsupported transport (sse — codex has no streamable-http analog) is skip-warned, not written", () => {
    const projectDir = freshProject();
    const c = connectorWith({ transport: "sse" as Transport, url: "https://mcp.acme.example/sse", tools: { include: ["*"] } });
    const changes = codexAdapter.installServer(buildCtx(projectDir, c));
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toMatch(/transport "sse" not registrable/);
  });
});
