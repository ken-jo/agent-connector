// Example agentconnect definition.
//
// Run from this directory:
//   agentconnect detect            # see which platforms are installed
//   agentconnect install --dry-run # preview what would be written, everywhere
//   agentconnect install           # deploy MCP + hooks across all detected hosts
//   agentconnect telemetry report  # per-tool token footprint, platform-independent
//
// Write it ONCE here; agentconnect renders it into each host's native dialect
// (Claude Code mcpServers JSON, Codex TOML [mcp_servers.*], Cursor mcp.json + hooks.json, …).

import { defineConnector } from "agentconnect";

export default defineConnector({
  id: "acme-db",
  displayName: "Acme DB Tools",
  version: "1.0.0",

  // The MCP server — declared once, transport-polymorphic.
  server: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@acme/db-mcp"],
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
