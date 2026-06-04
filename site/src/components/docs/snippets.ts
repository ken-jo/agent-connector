/** Code snippets used across the docs. Mirrors llms-full.txt examples. */

export const installSnippet = `npm i -g agent-connector`;

export const quickStartSnippet = `cd my-mcp-project                 # contains agent-connector.config.mjs
agent-connector detect            # list installed hosts + paradigms
agent-connector install --dry-run # preview the diff
agent-connector install           # write native configs everywhere
agent-connector telemetry report  # per-tool token footprint`;

export const fromSourceSnippet = `npm install
npm run typecheck
npm test
npm run build
npm run dev -- detect             # run the CLI from source via tsx`;

export const defineConnectorSnippet = `import { defineConnector } from "agent-connector";

export default defineConnector({
  id: "acme-db",
  displayName: "Acme DB Tools",
  version: "1.0.0",
  server: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@acme/db-mcp"],
    env: { ACME_DB_DSN: "\${env:ACME_DB_DSN}" },
    tools: { include: ["*"] },
    timeoutMs: 30_000,
  },
  hooks: {
    PreToolUse: {
      matcher: "acme_write",
      async handler(evt) {
        if (evt.toolName === "acme_write")
          return { decision: "ask", reason: "Confirm Acme DB write" };
        return { decision: "allow" };
      },
    },
    SessionStart: {
      async handler() {
        return {
          decision: "context",
          additionalContext: "Acme DB schema v12 is loaded.",
        };
      },
    },
  },
  telemetry: { enabled: true, modelFamilyHint: "auto", measureToolDefs: true },
  platforms: { warp: { hooks: false } }, // Warp is mcp-only: skip hooks
  targets: "auto",
});`;

export const serverDefSnippet = `interface ServerDef {
  transport: "stdio" | "http" | "sse" | "ws";
  // stdio transport:
  command?: string;                 // required for stdio
  args?: string[];
  env?: Record<string, string>;     // \${env:VAR} / \${env:VAR:-default}
  cwd?: string;
  // remote (http | sse | ws) transport:
  url?: string;                     // required for remote
  headers?: Record<string, string>;
  auth?: AuthSpec;                  // { type, bearerEnvVar? }
  // common:
  tools?: ToolFilter;              // { include?: string[]; exclude?: string[] }
  timeoutMs?: number;
  enabled?: boolean;               // default true
  wrapForTelemetry?: boolean;      // default true for stdio
}`;

/* Per-dialect outputs of `agent-connector install` for the server above. */

export const claudeCodeOutput = `// ~/.claude.json
{
  "mcpServers": {
    "acme-db": {
      "command": "npx",
      "args": ["-y", "@acme/db-mcp"],
      "env": { "ACME_DB_DSN": "\${env:ACME_DB_DSN}" }
    }
  }
}
// + hooks registered in ~/.claude/settings.json`;

export const codexOutput = `# ~/.codex/config.toml
[mcp_servers.acme-db]
command = "npx"
args = ["-y", "@acme/db-mcp"]

[mcp_servers.acme-db.env]
ACME_DB_DSN = "\${env:ACME_DB_DSN}"

# + hooks registered in ~/.codex/hooks.json`;

export const cursorOutput = `// ~/.cursor/mcp.json
{
  "mcpServers": {
    "acme-db": {
      "command": "npx",
      "args": ["-y", "@acme/db-mcp"],
      "env": { "ACME_DB_DSN": "\${env:ACME_DB_DSN}" }
    }
  }
}
// + hooks registered in ~/.cursor/hooks.json`;

export const vscodeOutput = `// .vscode/mcp.json
{
  "servers": {
    "acme-db": {
      "command": "npx",
      "args": ["-y", "@acme/db-mcp"],
      "env": { "ACME_DB_DSN": "\${env:ACME_DB_DSN}" }
    }
  }
}`;

export const hooksConfigSnippet = `interface HooksConfig {
  SessionStart?:     HookDefinition<"SessionStart">;
  SessionEnd?:       HookDefinition<"SessionEnd">;
  UserPromptSubmit?: HookDefinition<"UserPromptSubmit">;
  PreToolUse?:       HookDefinition<"PreToolUse">;
  PostToolUse?:      HookDefinition<"PostToolUse">;
  PreCompact?:       HookDefinition<"PreCompact">;
  Stop?:             HookDefinition<"Stop">;
  Notification?:     HookDefinition<"Notification">;
}

interface HookDefinition<E> {
  matcher?: string;  // regex on tool name; empty = match all
  handler(event: EventPayloadMap[E]):
    HookResponse | void | Promise<HookResponse | void>;
}`;

export const hookHandlerSnippet = `hooks: {
  PreToolUse: {
    matcher: "acme_write",
    async handler(evt) {
      // evt: { hostPlatform, connectorId, sessionId, projectDir?, raw,
      //        toolName, toolInput }
      if (evt.toolName === "acme_write")
        return { decision: "ask", reason: "Confirm Acme DB write" };
      return { decision: "allow" };
    },
  },
}`;

export const commandSnippet = `commands: [
  {
    name: "deploy",
    description: "Deploy the current service to an environment.",
    argumentHint: "[environment]",
    prompt: "Deploy {{args}} using the project's release runbook.",
    tools: { allow: ["Bash", "Read"] },
  },
],
skills: [
  {
    name: "db-triage",
    description:
      "Triage a failing query. Use when a SQL error or slow query is reported.",
    body: "# DB triage\\nInspect the plan, check indexes, suggest a fix.",
    resources: { "references/indexes.md": "..." },
  },
],
subagents: [
  {
    name: "schema-reviewer",
    description: "Reviews migrations for backwards-compatibility.",
    prompt: "You are a careful schema reviewer...",
    readonly: true,
  },
],`;

export const telemetrySnippet = `telemetry: {
  enabled: true,            // AGENT_CONNECTOR_TELEMETRY=0 kills it
  modelFamilyHint: "auto",  // auto | openai | anthropic | generic
  measureToolDefs: true,    // tokenize tools/list once → per-turn overhead
  hostNativeUsage: false,   // opt-in; AGENT_CONNECTOR_HOST_NATIVE=1
  store: "ndjson",          // or "sqlite"
}`;

export const serveSnippet = `# a wrapped MCP entry runs the real server behind the telemetry proxy:
agent-connector serve --connector acme-db -- npx -y @acme/db-mcp`;

export const platformOverrideSnippet = `platforms: {
  warp:   { hooks: false },                 // mcp-only host: skip hooks
  cursor: { scope: "project" },             // force project scope here
  codex:  { server: { timeoutMs: 60_000 } },// shallow-merge into ServerDef
  "claude-code": {
    extra: { /* verbatim native fields the core doesn't model */ },
  },
}`;

export const leaderboardSnippet = `$ agent-connector leaderboard --since 7d

🔌 MCP / Plugin            (origin: mcp-self)
  1. acme-db        12.4k calls   4.81M tok   tokenizer-exact
  2. weather         3.1k calls   0.92M tok   tokenizer-exact
  3. github          2.7k calls   0.74M tok   tokenizer-approx

🖥️  Host / User            (origin: host-scan-logs)
  1. claude-code @ macbook   18.2k   5.10M tok   host-reported
  2. cursor @ macbook         4.4k   1.12M tok   host-estimated

🛰️  Host-native turns       (origin: host-native-live)
  1. gemini-cli @ devbox      1.2k   2.04M tok   host-native

# the three boards measure DIFFERENT things — never summed.`;

export const addPlatformSnippet = `// 1. src/adapters/registry.ts — one lazily-loaded entry
{ id: "myhost", load: () => import("./myhost/index.js") },

// 2. src/adapters/myhost/index.ts — one adapter
export class MyHostAdapter extends BaseAdapter {
  id = "myhost";
  name = "My Host";
  readonly paradigm = "json-stdio";   // or "ts-plugin" | "mcp-only"
  capabilities = { /* per-event booleans, transports, … */ };
  detect() { /* config-dir + marker files */ }
  installServer() { /* render ServerDef into the native dialect */ }
  // hook install per paradigm (or inherit the mcp-only skip),
  // optional content-surface writers, and doctor() health checks.
}`;

export const operatingModelSnippet = `~/.agent-connector/
  bin/agent-connector              single binary: CLI + hook entrypoint + telemetry
  connectors/<id>/connector.json   each registered connector's resolved definition
  telemetry.ndjson (or .db)        shared telemetry store, rows keyed by project
  backups/                         timestamped settings backups before each mutation
  logs/`;
