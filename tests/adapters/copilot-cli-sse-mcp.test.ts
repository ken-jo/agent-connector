/**
 * adapters/copilot-cli-sse-mcp — remote MCP transport `type` (http + sse).
 *
 * GitHub Copilot CLI's mcp-config.json `type` accepts stdio (written "local"),
 * `http` (Streamable HTTP) and `sse` (legacy) per GitHub's add-mcp-servers docs.
 * AC previously advertised only ["stdio","http"] and always wrote type:"http"
 * for remote servers. These tests lock sse → type:"sse" and http → type:"http".
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector, Transport } from "../../src/core/types.js";

import copilotCliAdapter from "../../src/adapters/copilot-cli/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-copilot-remote";

function remote(transport: Transport): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    server: { transport, url: "https://mcp.acme.example/endpoint", tools: { include: ["*"] } },
    telemetry: { enabled: false },
  });
}
function buildCtx(projectDir: string, c: ResolvedConnector): InstallContext {
  return { connector: c, scope: "user", projectDir, homeBinPath: HOME_BIN, dataRoot: projectDir, dryRun: false };
}

let savedHome: string | undefined;
let savedUP: string | undefined;
beforeEach(() => { savedHome = process.env.HOME; savedUP = process.env.USERPROFILE; });
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedUP === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUP;
});
function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-copilot-sse-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return dir;
}
function readEntry(ctx: InstallContext): Record<string, any> {
  const file = JSON.parse(readFileSync(copilotCliAdapter.getServerConfigPath!(ctx), "utf8"));
  return file.mcpServers[CONNECTOR_ID];
}

describe("copilot-cli adapter — remote MCP transport type (http + sse)", () => {
  it("advertises sse alongside stdio + http", () => {
    expect(copilotCliAdapter.capabilities.transports).toContain("sse");
    expect(copilotCliAdapter.capabilities.transports).toContain("http");
  });

  it("renders an sse server as type:\"sse\"", () => {
    const projectDir = freshHome();
    const ctx = buildCtx(projectDir, remote("sse"));
    copilotCliAdapter.installServer(ctx);
    const entry = readEntry(ctx);
    expect(entry.type).toBe("sse");
    expect(entry.url).toBe("https://mcp.acme.example/endpoint");
  });

  it("still renders an http server as type:\"http\" (regression)", () => {
    const projectDir = freshHome();
    const ctx = buildCtx(projectDir, remote("http"));
    copilotCliAdapter.installServer(ctx);
    expect(readEntry(ctx).type).toBe("http");
  });
});
