/** Code snippets used across the docs. Mirrors llms-full.txt examples. */

/**
 * The primary install: agent-connector is an SDK you depend on, not a global
 * tool. Add it to your connector package, then either ship a branded CLI or run
 * it with npx.
 */
export const installSnippet = `npm install @ken-jo/agent-connector`;

/**
 * Ship a branded CLI: createConnectorCli wraps EVERY agent-connector subcommand
 * under your own bin name, auto-scoped to your connector. Your users never run a
 * global install and never type --connector.
 */
export const brandedCliSnippet = `#!/usr/bin/env node
// bin.mjs — your tool's bin, e.g. "acme-db"
import { fileURLToPath } from "node:url";
import { createConnectorCli } from "@ken-jo/agent-connector/cli";

createConnectorCli({
  name: "acme-db",
  connector: fileURLToPath(
    new URL("./agent-connector.config.mjs", import.meta.url),
  ),
}).run();`;

/**
 * Optional convenience only: install the CLI globally to try it directly,
 * outside of any connector package. Not required for the SDK/branded-CLI flow.
 */
export const globalInstallSnippet = `# optional — to try the CLI directly, outside a connector package
npm i -g @ken-jo/agent-connector
agent-connector --help`;

export const quickStartSnippet = `# 1. add agent-connector as a dependency of your connector package
npm install @ken-jo/agent-connector

# 2. write agent-connector.config.mjs (defineConnector — see below)

# 3a. ship a branded CLI so YOUR users drive it (auto-scoped, no --connector):
acme-db detect            # list installed hosts + paradigms
acme-db install --dry-run # preview the diff
acme-db install           # write native configs everywhere
acme-db leaderboard       # acme-db's token footprint vs the boards
acme-db telemetry report --by tool   # which of acme-db's tools cost the most tokens

# 3b. …or just run it from the project with npx — no global install:
npx @ken-jo/agent-connector detect
npx @ken-jo/agent-connector install`;

export const fromSourceSnippet = `npm install
npm run typecheck
npm test
npm run build
npm run dev -- detect             # run the CLI from source via tsx`;

/* ---- Agent-CLI user track: connector-free token usage (Audience B) ---- */

/**
 * The end-user entry point. NO defineConnector, NO config file, NO install.
 * `agent-connector usage` reads each agent CLI's OWN session logs read-only and
 * reports WHOLE-CONVERSATION totals — grouped by platform | model | project |
 * session | day. It never itemizes per-MCP or per-tool cost (agent CLIs don't
 * log per-tool token attribution) and never writes any host config.
 */
export const usageQuickStartSnippet = `# no install, no config, no defineConnector — just run it with npx:
npx @ken-jo/agent-connector usage report

# which agent CLI burned the most tokens? (ranks hosts)
npx @ken-jo/agent-connector usage leaderboard --by platform

# rank by model instead, scoped to the last 7 days:
npx @ken-jo/agent-connector usage leaderboard --by model --since 7d

# scope a report to a window / one platform; group however you like:
npx @ken-jo/agent-connector usage report --by day --since 7d
npx @ken-jo/agent-connector usage report --by model --platform claude-code

# export the raw aggregate rows (counts only — never prompts or results):
npx @ken-jo/agent-connector usage export --format csv --out usage.csv`;

/**
 * The shape of `usage report` output: whole-conversation totals per group, with
 * a CONFIDENCE column distinguishing host-logged exact counts from host-estimated
 * ones, and explicit skip notes for the 5 'synced' platforms that need a local
 * cache agent-connector does not populate. There is NO per-MCP / per-tool column.
 */
export const usageReportSnippet = `$ agent-connector usage report --by platform --since 7d

PLATFORM       IN       OUT      CACHE_R   CACHE_W   REASON      TOTAL     SESS      CONF
----------------------------------------------------------------------------------------------
claude-code    4.10M    0.62M    8.40M     1.10M     0.31M       14.53M    132       host-reported
codex          1.22M    0.18M    0.00      0.00      0.04M       1.44M     41        host-reported
gemini-cli     0.88M    0.21M    0.00      0.00      0.00        1.09M     27        host-reported
kiro           0.34M    0.09M    0.00      0.00      0.00        0.43M     12        host-estimated
----------------------------------------------------------------------------------------------
skipped: cursor, antigravity, antigravity-cli, trae, warp (requires sync — no local cache found)

# totals are WHOLE-CONVERSATION per agent CLI — NOT per-MCP or per-tool.
# agent CLIs don't log per-tool token attribution, so usage cannot itemize it.`;

export const defineConnectorSnippet = `import { defineConnector } from "@ken-jo/agent-connector";

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

/* ---- Embed it: ship a branded CLI on top of agent-connector ---- */

/**
 * The consumer package: agent-connector is a DEPENDENCY (not -g), and the
 * package ships its own bin. Installing it links `acme-db` onto the user's PATH.
 */
export const brandedPackageJsonSnippet = `{
  "name": "acme-db-tools",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "acme-db": "./bin.mjs"
  },
  "files": ["bin.mjs", "agent-connector.config.mjs"],
  "dependencies": {
    "@ken-jo/agent-connector": "0.1.0"
  }
}`;

/**
 * The branded bin. createConnectorCli({ name, connector }) returns a runner that
 * exposes every agent-connector subcommand under your brand, AUTO-SCOPED to the
 * connector shipped beside it — so the consumer never passes --connector.
 */
export const brandedBinSnippet = `#!/usr/bin/env node
// bin.mjs
import { fileURLToPath } from "node:url";
import { createConnectorCli } from "@ken-jo/agent-connector/cli";

const connector = fileURLToPath(
  new URL("./agent-connector.config.mjs", import.meta.url),
);

createConnectorCli({ name: "acme-db", connector })
  .run()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write(\`acme-db: fatal: \${err?.stack ?? err}\\n\`);
    process.exitCode = 1;
  });`;

/**
 * What the consumer of your package runs. Each command targets YOUR connector
 * without --connector: serve/hook still route through the one ~/.agent-connector
 * home binary; install/leaderboard/telemetry are scoped to acme-db.
 */
export const brandedUsageSnippet = `# the consumer installs YOUR package; the acme-db bin is linked.
# agent-connector itself is never installed globally.
npm install acme-db-tools

# deploy the acme-db connector across every detected agent platform.
acme-db install                 # auto-scoped — no --connector needed
acme-db install --dry-run       # preview the plan, nothing written
acme-db upgrade                 # bring everything current (alias: sync, update)
acme-db doctor                  # health-check every platform for acme-db

# telemetry + leaderboards, scoped to the acme-db connector:
acme-db leaderboard             # the 🔌 MCP/plugin section shows acme-db
acme-db telemetry report --by tool   # acme-db's per-tool token footprint
acme-db telemetry leaderboard        # which acme-db tool costs the most

# every agent-connector subcommand is available, branded as acme-db:
acme-db --help`;

/**
 * The auto-scoping equivalence: a branded subcommand is just the matching
 * agent-connector command with the developer's connector injected.
 */
export const brandedScopingSnippet = `# a branded command  ≈  the agent-connector command, connector pre-injected:
acme-db install        ≈  agent-connector install --connector ./agent-connector.config.mjs
acme-db leaderboard    ≈  agent-connector leaderboard --connector acme-db
acme-db telemetry report --by tool
                       ≈  agent-connector telemetry report --by tool --connector acme-db

# the consumer can still override the auto-scope explicitly when they need to —
# an explicit --connector / --connector-id always wins over the injected default.`;

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
// wrapForTelemetry (default for stdio) wraps the real command behind the
// home-bin serve proxy; \${env:VAR} is translated to Claude's native \${VAR}.
{
  "mcpServers": {
    "acme-db": {
      "type": "stdio",
      "command": "/home/you/.agent-connector/bin/agent-connector",
      "args": ["serve", "--connector", "acme-db", "--scope", "user",
               "--host", "claude-code", "--", "npx", "-y", "@acme/db-mcp"],
      "env": { "ACME_DB_DSN": "\${ACME_DB_DSN}" }
    }
  }
}
// + hooks registered in ~/.claude/settings.json`;

export const codexOutput = `# ~/.codex/config.toml
[mcp_servers.acme-db]
command = "/home/you/.agent-connector/bin/agent-connector"
args = ["serve", "--connector", "acme-db", "--scope", "user",
        "--host", "codex", "--", "npx", "-y", "@acme/db-mcp"]

[mcp_servers.acme-db.env]
# \${env:...} is resolved to a literal at install — TOML cannot interpolate;
# set the env var before \`install\` (unset → baked as "").
ACME_DB_DSN = "postgres://acme:…"

# + hooks registered in ~/.codex/hooks.json`;

export const cursorOutput = `// ~/.cursor/mcp.json
{
  "mcpServers": {
    "acme-db": {
      "command": "/home/you/.agent-connector/bin/agent-connector",
      "args": ["serve", "--connector", "acme-db", "--scope", "user",
               "--host", "cursor", "--", "npx", "-y", "@acme/db-mcp"],
      "env": { "ACME_DB_DSN": "\${env:ACME_DB_DSN}" }
    }
  }
}
// + hooks registered in ~/.cursor/hooks.json`;

export const vscodeOutput = `// .vscode/mcp.json
{
  "servers": {
    "acme-db": {
      "command": "/home/you/.agent-connector/bin/agent-connector",
      "args": ["serve", "--connector", "acme-db", "--scope", "user",
               "--host", "vscode-copilot", "--", "npx", "-y", "@acme/db-mcp"],
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

/**
 * Connector-scoped leaderboard: a branded `acme-db leaderboard` is exactly
 * `agent-connector leaderboard --connector acme-db`, so a connector developer
 * sees only THEIR connector's token usage in the 🔌 MCP/plugin section.
 */
export const connectorLeaderboardSnippet = `# as a connector developer, scope the leaderboard to YOUR connector:
$ acme-db leaderboard --since 7d
#  ≈  agent-connector leaderboard --connector acme-db --since 7d

🔌 MCP / Plugin            (origin: mcp-self · connector: acme-db)
  1. acme-db        12.4k calls   4.81M tok   tokenizer-exact
  #   ^ only acme-db rows — other connectors are filtered out

# per-tool, still scoped to acme-db:
$ acme-db telemetry leaderboard --by tool
#  ≈  agent-connector telemetry leaderboard --by tool --connector acme-db

# NOTE: the 🖥️ Host/User section stays connector-agnostic — host CLI logs carry
# no connector attribution, so only the 🔌 MCP/plugin (+ 🛰️ host-native) sections
# are filtered to acme-db.`;

export const packageSnippet = `# default format (claude-plugin) → <cwd>/dist-plugin
agent-connector package

# pick a format + output dir; preview without writing
agent-connector package --format gemini-extension --out ./dist --dry-run

# emit EVERY feasible format, each into <out>/<format>/
agent-connector package --format all --out ./dist

# an unknown format exits 2
agent-connector package --format bogus   # → invalid --format "bogus" (exit 2)`;

export const packageInstallSnippet = `# a claude-plugin bundle installs from a marketplace, two steps:
/plugin marketplace add ./dist-plugin
/plugin install my-connector@agent-connector

# the wrapped MCP entry in the bundle still routes through the home-bin:
#   agent-connector serve --connector my-connector --host claude-code -- <real cmd>
# so a marketplace-installed connector STILL reports per-tool tokens.`;

export const surfaceLeaderboardSnippet = `$ agent-connector telemetry leaderboard --by surface

SURFACE   NAME              IN      OUT    TOTAL  KIND
----------------------------------------------------------
server    query           4,210   9,880  14,090  runtime
hook      PreToolUse      1,120     640   1,760  runtime
skill     deep-research     980       0     980  static
command   deploy            612       0     612  static
subagent  reviewer          540       0     540  static
----------------------------------------------------------
TOTAL                     7,462  11,160  18,622

note: KIND=static rows are the tokenized FOOTPRINT a command/skill/subagent
imposes on a host that loads it as context — not intercepted usage rows.`;

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
