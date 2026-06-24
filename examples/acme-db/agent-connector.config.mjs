// Example agent-connector definition.
//
// Package-first path:
//   package.json name/mcpName/bin/version define the identity.
//   Users run the package bin, e.g. `acme-db-example install`, `doctor`,
//   and `telemetry report`; a published package can expose the same flow as
//   `npx @acme/acme-db-mcp install`.
//
// Framework fallback from this directory, for local development/debug only:
//   npx @ken-jo/agent-connector detect
//   npx @ken-jo/agent-connector install --dry-run
//
// Write it ONCE here; agent-connector renders it into each host's native dialect
// (Claude Code mcpServers JSON, Codex TOML [mcp_servers.*], Cursor mcp.json + hooks.json, …).
//
// This example ships a real runnable stub server (acme-db-mcp-server.mjs).
// For your own connector, replace the server block with your real MCP server.
// See https://modelcontextprotocol.io/quickstart/server for the official SDK quickstart.

import { fileURLToPath } from "node:url";
import { defineConnector } from "@ken-jo/agent-connector/sdk";

// Resolve the bundled stub server to an absolute path: host CLIs spawn MCP
// servers from their own CWD, so a relative path would not resolve correctly.
const serverPath = fileURLToPath(
  new URL("./acme-db-mcp-server.mjs", import.meta.url),
);

export default defineConnector({
  // The MCP server — declared once, transport-polymorphic.
  // Replace `node [serverPath]` with your own server's command when you ship the real thing.
  server: {
    transport: "stdio",
    command: "node",
    args: [serverPath],
    env: {
      // Universal env-ref syntax; resolved or translated per host so the secret
      // is never baked into a config file where the host supports interpolation.
      ACME_DB_DSN: "${env:ACME_DB_DSN}",
    },
    tools: { include: ["*"] },
    timeoutMs: 30_000,
  },

  // Lifecycle hooks — normalized events; the framework synthesizes the right
  // entrypoint per paradigm (json-stdio binary, ts-plugin module, or skips on
  // mcp-only hosts).
  hooks: {
    PreToolUse: {
      matcher: "acme_write",
      async handler(evt) {
        // Gate destructive writes behind a confirmation, on every platform.
        if (evt.toolName === "acme_write") {
          return { decision: "ask", reason: "Confirm Acme DB write" };
        }
        return { decision: "allow" };
      },
    },
    SessionStart: {
      async handler() {
        return { decision: "context", additionalContext: "Acme DB schema v12 is loaded." };
      },
    },
  },

  // Telemetry is ON by default; this block just makes the defaults explicit.
  telemetry: {
    enabled: true,
    modelFamilyHint: "auto",
    measureToolDefs: true,
  },

  // Per-platform escape hatch. Warp is mcp-only — skip hooks there gracefully.
  platforms: {
    warp: { hooks: false },
  },

  // "auto" = every detected platform. Or pin: ["claude-code", "codex", "cursor"].
  targets: "auto",
});
