/**
 * adapters/omp — remote MCP `type` discriminator.
 *
 * OMP's mcp.json schema (docs/mcp-config.md) requires an explicit `type` on a
 * URL server — `type: "http"` (streamable HTTP) or `type: "sse"` — and treats an
 * entry with NO `type` as stdio ("stdio is the default when type is omitted").
 * AC's remote renderer previously emitted `{ url, headers? }` with no `type`, so
 * OMP would mis-parse a URL server as a stdio command. These tests lock the
 * discriminator (http → "http", sse → "sse") and confirm a stdio entry stays
 * type-less (it correctly relies on OMP's default).
 */
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector, Transport } from "../../src/core/types.js";

import ompAdapter from "../../src/adapters/omp/index.js";

const CONNECTOR_ID = "acme-remote";
const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";

function connector(transport: Transport, withCommand = false): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Remote",
    version: "1.0.0",
    server: withCommand
      ? { transport, command: "npx", args: ["-y", "@x/y"], tools: { include: ["*"] } }
      : {
          transport,
          url: "https://mcp.acme.example/endpoint",
          headers: { Authorization: "Bearer ${env:ACME_TOKEN}" },
          tools: { include: ["*"] },
        },
    telemetry: { enabled: false },
  });
}

function buildCtx(projectDir: string, c: ResolvedConnector): InstallContext {
  return { connector: c, scope: "project", projectDir, homeBinPath: HOME_BIN, dataRoot: projectDir, dryRun: false };
}

let saved: Record<string, string | undefined> = {};
const KEYS = ["HOME", "USERPROFILE", "AGENT_CONNECTOR_DATA_DIR", "ACME_TOKEN", "OMP_PROFILE", "PI_PROFILE"];
beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k]; });
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function freshHome(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  process.env.ACME_TOKEN = "tok-123";
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  return dir;
}

function installAndRead(transport: Transport, prefix: string, withCommand = false): Record<string, any> {
  const projectDir = freshHome(prefix);
  const ctx = buildCtx(projectDir, connector(transport, withCommand));
  ompAdapter.installServer!(ctx);
  const cfg = JSON.parse(readFileSync(ompAdapter.getServerConfigPath!(ctx), "utf8"));
  return cfg.mcpServers[CONNECTOR_ID];
}

describe("omp adapter — remote MCP type discriminator", () => {
  it("renders canonical http with the REQUIRED type:\"http\" discriminator", () => {
    const entry = installAndRead("http", "ac-omp-http-");
    expect(entry.type).toBe("http");
    expect(entry.url).toBe("https://mcp.acme.example/endpoint");
    expect(entry.headers.Authorization).toBe("Bearer tok-123");
    expect("command" in entry).toBe(false);
  });

  it("renders sse with type:\"sse\"", () => {
    const entry = installAndRead("sse", "ac-omp-sse-");
    expect(entry.type).toBe("sse");
    expect(entry.url).toBe("https://mcp.acme.example/endpoint");
  });

  it("stdio entry stays type-less (relies on OMP's documented stdio default)", () => {
    const entry = installAndRead("stdio", "ac-omp-stdio-", true);
    expect("type" in entry).toBe(false);
    expect(entry.command).toBeTruthy();
  });

  it("an unadvertised transport (ws) is WARNED, not silently downgraded, and renders best-effort as http", () => {
    const projectDir = freshHome("ac-omp-ws-");
    const ctx = buildCtx(projectDir, connector("ws"));
    const changes = ompAdapter.installServer!(ctx);
    expect(changes.some((c) => c.action === "warn" && /transport "ws" is not an OMP/.test(c.detail ?? ""))).toBe(true);
    const cfg = JSON.parse(readFileSync(ompAdapter.getServerConfigPath!(ctx), "utf8"));
    expect(cfg.mcpServers[CONNECTOR_ID].type).toBe("http"); // best-effort (OMP rejects an unknown type)
  });
});
