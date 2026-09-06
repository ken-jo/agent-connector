// Verification probe connector: one stdio MCP server (acme_query) + lifecycle
// hooks that append marker lines to $ACME_PROBE_LOG. Used by the mock-model
// lane in scripts/README.md to raise docs/host-verification-results.csv tiers
// without any provider API key. Never published; needs a built dist/.
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConnector } from "../dist/sdk/index.js";

const SERVER = fileURLToPath(new URL("./verify-probe-mcp-server.mjs", import.meta.url));
const LOG = process.env.ACME_PROBE_LOG ?? fileURLToPath(new URL("../.acverify/probe.log", import.meta.url));
const mark = (line) => {
  try { appendFileSync(LOG, `hook ${line} ${new Date().toISOString()}\n`); } catch {}
};

export default defineConnector({
  id: "acme-db",
  displayName: "Acme DB (verification probe)",
  version: "0.0.1",
  server: {
    transport: "stdio",
    command: "node",
    args: [SERVER],
    env: { ACME_PROBE_LOG: LOG },
    tools: { include: ["*"] },
  },
  hooks: {
    SessionStart: { async handler(evt) { mark(`SessionStart host=${evt.hostPlatform}`); return { decision: "allow" }; } },
    UserPromptSubmit: { async handler(evt) { mark(`UserPromptSubmit host=${evt.hostPlatform}`); return { decision: "allow" }; } },
    PreToolUse: { async handler(evt) { mark(`PreToolUse host=${evt.hostPlatform} tool=${evt.toolName}`); return { decision: "allow" }; } },
    PostToolUse: { async handler(evt) { mark(`PostToolUse host=${evt.hostPlatform} tool=${evt.toolName}`); return { decision: "allow" }; } },
    Stop: { async handler(evt) { mark(`Stop host=${evt.hostPlatform}`); return { decision: "allow" }; } },
    SessionEnd: { async handler(evt) { mark(`SessionEnd host=${evt.hostPlatform}`); return { decision: "allow" }; } },
  },
  telemetry: { enabled: false },
  targets: "auto",
});
