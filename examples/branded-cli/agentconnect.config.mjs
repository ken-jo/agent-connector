/**
 * acme-db-tools — the connector Acme ships inside its package.
 *
 * It declares everything once:
 *   • a stdio MCP server (wrapped for per-tool token telemetry),
 *   • a PreToolUse hook that guards destructive SQL, and
 *   • a slash command that documents the schema.
 *
 * `acme-db install` (via the branded CLI in bin.mjs) then deploys this across
 * every detected agent platform, AUTO-SCOPED to this connector so the consumer
 * never types `--connector`.
 */

import { fileURLToPath } from "node:url";

import { defineConnector } from "agentconnect";

// Resolve the bundled stub server to an ABSOLUTE path: host CLIs spawn MCP
// servers from their own CWD, so a relative "./..." path would not resolve.
const serverPath = fileURLToPath(
  new URL("./acme-db-mcp-server.mjs", import.meta.url),
);

export default defineConnector({
  id: "acme-db",
  displayName: "Acme DB Tools",
  version: "1.0.0",

  // ── MCP server (stdio) — wrapped for telemetry by default ──
  server: {
    transport: "stdio",
    command: "node",
    args: [serverPath],
    env: {
      ACME_DB_URL: "${env:ACME_DB_URL}",
    },
  },

  // ── A lifecycle hook — block obviously destructive SQL before it runs ──
  hooks: {
    PreToolUse: {
      matcher: "acme_query",
      handler(event) {
        const sql = String(
          (event.toolInput && event.toolInput["sql"]) ?? "",
        ).toLowerCase();
        if (/\bdrop\s+table\b|\btruncate\b|\bdelete\s+from\b/.test(sql)) {
          return {
            decision: "deny",
            reason: "acme-db: destructive SQL blocked by the acme-db guard hook.",
          };
        }
        return { decision: "allow" };
      },
    },
  },

  // ── A slash command — pure content, written natively per platform ──
  commands: [
    {
      name: "acme-schema",
      description: "Print the Acme DB schema overview.",
      prompt:
        "Summarize the Acme database schema: list the tables, their primary keys, " +
        "and the most important foreign-key relationships. Keep it under 20 lines.",
    },
  ],
});
