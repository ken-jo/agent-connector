/**
 * adapters/nemoclaw — remote MCP transport literal.
 *
 * OpenClaw's config validator accepts a remote `transport` of "sse" |
 * "streamable-http" and REJECTS a bare "http" (verified against OpenClaw 2026.6.1
 * + docs.openclaw.ai/gateway/configuration-reference). AC's canonical "http"
 * (streamable HTTP) must therefore render as the literal "streamable-http", not
 * "http". NemoClaw is a fork that inherits renderServerEntry unchanged, so this
 * test locks that mapping for nemoclaw and confirms an sse server stays "sse".
 * (The openclaw row of this suite has moved to adapters/openclaw.test.ts; this
 * file finishes the nemoclaw migration in a later PR.)
 *
 * Remote servers are never telemetry-wrapped (shouldWrapForTelemetry is stdio-
 * only), so the remote branch always runs — the literal is live regardless of
 * telemetry.
 */
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { Adapter, InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector, Transport } from "../../src/core/types.js";

import nemoclawAdapter from "../../src/adapters/nemoclaw/index.js";

const CONNECTOR_ID = "acme-remote";
const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";

function remoteConnector(transport: Transport): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Remote",
    version: "1.0.0",
    server: {
      transport,
      url: "https://mcp.acme.example/endpoint",
      headers: { Authorization: "Bearer ${env:ACME_TOKEN}" },
      tools: { include: ["*"] },
    },
  });
}

function buildCtx(projectDir: string, connector: ResolvedConnector): InstallContext {
  return {
    connector,
    scope: "project",
    projectDir,
    homeBinPath: HOME_BIN,
    dataRoot: projectDir,
    dryRun: false,
  };
}

let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedDataDir: string | undefined;
let savedToken: string | undefined;
let savedOcConfig: string | undefined;
let savedOcState: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  savedToken = process.env.ACME_TOKEN;
  savedOcConfig = process.env.OPENCLAW_CONFIG_PATH;
  savedOcState = process.env.OPENCLAW_STATE_DIR;
});
afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedUserProfile);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
  restore("ACME_TOKEN", savedToken);
  restore("OPENCLAW_CONFIG_PATH", savedOcConfig);
  restore("OPENCLAW_STATE_DIR", savedOcState);
});
function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshHome(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  process.env.ACME_TOKEN = "tok-123";
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_STATE_DIR;
  return dir;
}

/** Install a remote server and return the written native entry. */
function installAndRead(
  adapter: Adapter,
  transport: Transport,
  prefix: string,
): Record<string, any> {
  const projectDir = freshHome(prefix);
  const ctx = buildCtx(projectDir, remoteConnector(transport));
  adapter.installServer!(ctx);
  const cfg = JSON.parse(readFileSync(adapter.getServerConfigPath!(ctx), "utf8"));
  return cfg.mcp.servers[CONNECTOR_ID];
}

describe.each([
  ["nemoclaw", nemoclawAdapter],
])("%s adapter — remote MCP transport literal", (name, adapter) => {
  it("renders canonical http as OpenClaw's accepted literal 'streamable-http' (NOT 'http')", () => {
    const entry = installAndRead(adapter as Adapter, "http", `ac-${name}-http-`);
    expect(entry.transport).toBe("streamable-http");
    expect(entry.transport).not.toBe("http");
    expect(entry.url).toBe("https://mcp.acme.example/endpoint");
    // headers carried + env ref resolved to a literal (no native ${env:} token).
    expect(entry.headers.Authorization).toBe("Bearer tok-123");
    // remote sidecar is NOT telemetry-wrapped → no stdio command shape.
    expect("command" in entry).toBe(false);
  });

  it("renders sse as 'sse'", () => {
    const entry = installAndRead(adapter as Adapter, "sse", `ac-${name}-sse-`);
    expect(entry.transport).toBe("sse");
    expect(entry.url).toBe("https://mcp.acme.example/endpoint");
  });
});
