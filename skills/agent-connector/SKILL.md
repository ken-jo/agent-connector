---
name: agent-connector
description: Two audiences. (A) MCP DEVELOPER — write an MCP server, lifecycle hooks, slash commands, Agent Skills, or subagents ONCE with defineConnector({...}), then install/sync/uninstall them across every detected AI-agent CLI (Claude Code, Codex, Cursor, Copilot, Gemini, OpenCode, Warp, and more — 29 registered deploy adapters) in each host's native config dialect, with default local-first per-tool token telemetry for YOUR OWN wrapped stdio server. (B) AGENT-CLI END USER — with NO connector at all, run `agent-connector usage` to see per-CLI / per-model token totals scanned read-only from each agent CLI's own session logs. Use this when a developer wants one integration to reach many agent hosts and to see which of their own server's tools cost the most context, OR when any agent-CLI user wants whole-conversation token totals per CLI/model with zero setup.
---

# agent-connector

agent-connector serves two distinct audiences and the work forks between them:

- **(A) MCP developer** — writes an integration once with `defineConnector()` and
  deploys their MCP server + lifecycle hooks (+ commands / skills / subagents) across
  every detected agent CLI. It solves two dev problems: (1) each agent host re-invents
  MCP registration + lifecycle hooks with incompatible config files, root keys, formats
  (JSON/JSONC/TOML/YAML/exported TS), and event names; (2) no host reports per-tool
  token usage back to an MCP server. Write the integration once; the CLI renders it into
  each installed host's native dialect and measures the developer's OWN wrapped stdio
  server's per-tool token footprint locally.
- **(B) Agent-CLI user** — has NOT authored a connector and just runs an agent CLI
  (Claude Code, Codex, Cursor, …). Their entire supported surface is one connector-free
  command, `agent-connector usage`, which reads each agent CLI's own session logs
  read-only to show per-CLI / per-model token totals. No `defineConnector`, no install,
  no config file.

The one accuracy-critical line between them: if you BUILD an MCP integration,
agent-connector deploys it everywhere and measures your own server's per-tool tokens.
If you just USE agent CLIs, agent-connector reads their logs to show you per-CLI /
per-model token totals — whole-conversation only, never itemized per MCP or per tool.

## When to reach for it

- **(A) MCP developer** wants to ship ONE MCP server (and/or hooks / slash commands /
  Agent Skills / subagents) across many agent CLIs without hand-authoring N config
  dialects → `defineConnector` + `install`.
- **(A) MCP developer** asks "which of MY OWN server's tools cost the most context?" →
  `telemetry report --by tool` / `telemetry leaderboard --by mcp|tool`. Requires a
  declared connector with a wrapped stdio server (per-tool counts exist only for the
  server your connector declares and wraps; remote http/sse/ws servers are not wrapped).
- **(B) Agent-CLI user (no connector needed)** wants to compare token spend across the
  agent CLIs on their machine → `usage` (alone). This reports WHOLE-CONVERSATION totals
  per CLI / model / project / session / day — it does NOT and cannot itemize cost per
  individual MCP server or per tool, because agent CLIs do not log per-tool token
  attribution. For per-MCP/per-tool numbers, that MCP must be deployed and wrapped via a
  connector (the developer track above).

Do NOT use it to author a brand-new MCP server protocol — it deploys + measures an
existing server command/URL and wraps lifecycle hooks; it does not implement tools.

## Write once: defineConnector({...})

Create `agent-connector.config.mjs` (or `.js` / `.json`) at the project root:

```ts
import { defineConnector } from "@ken-jo/agent-connector";

export default defineConnector({
  id: "acme-db",                 // required, kebab-case ^[a-z0-9][a-z0-9-]*$
  displayName: "Acme DB Tools",
  version: "1.0.0",

  // MCP server — declared once, transport-polymorphic. Omit for a hooks-only connector.
  server: {
    transport: "stdio",          // stdio | http | sse | ws
    command: "npx",              // stdio: command required; remote: url required
    args: ["-y", "@acme/db-mcp"],
    env: { ACME_DB_DSN: "${env:ACME_DB_DSN}" }, // universal ${env:VAR} / ${env:VAR:-default}
    tools: { include: ["*"] },
    timeoutMs: 30_000,
    // wrapForTelemetry defaults true for stdio when telemetry is on
  },

  // Lifecycle hooks — canonical event names; the framework synthesizes the right
  // entrypoint per host paradigm (json-stdio binary / ts-plugin module / skip on mcp-only).
  hooks: {
    PreToolUse: {
      matcher: "acme_write",     // regex on tool name; empty = all
      async handler(evt) {
        return evt.toolName === "acme_write"
          ? { decision: "ask", reason: "Confirm Acme DB write" } // allow|deny|modify|context|ask
          : { decision: "allow" };
      },
    },
    SessionStart: {
      async handler() {
        return { decision: "context", additionalContext: "Acme DB schema v12 loaded." };
      },
    },
  },

  // Content surfaces (all optional, content-only files; written where supported).
  commands: [
    { name: "db-report", description: "Summarize the schema", prompt: "Report on {{schema}}.", argumentHint: "[schema]" },
  ],
  skills: [
    { name: "db-helper", description: "Guides DB queries; use when the user asks about the schema.",
      body: "# DB helper\nUse acme_query first...", resources: { "references/api.md": "..." } },
  ],
  // subagents: [{ name: "db-auditor", description: "...", prompt: "..." }],

  telemetry: { enabled: true, modelFamilyHint: "auto", measureToolDefs: true }, // ON by default
  platforms: { warp: { hooks: false } },  // per-platform escape hatch / overrides
  targets: "auto",                        // "auto" = all detected, or e.g. ["claude-code","codex"]
});
```

A connector must declare at least one of `server`, `hooks`, `commands`, `skills`,
or `subagents`. `defineConnector` validates eagerly and throws `ConnectorConfigError`
on bad ids, non-function handlers, duplicate surface names, oversized skill
descriptions (>1024 chars), or unsafe skill `resources` paths.

## CLI workflow

```bash
npm install @ken-jo/agent-connector   # a dependency of your connector package — or run everything via npx @ken-jo/agent-connector
cd my-mcp-project

agent-connector detect                      # which hosts are installed + scope + capabilities + paradigm
agent-connector install --dry-run           # preview every change, everywhere (nothing written)
agent-connector install                     # deploy across detected hosts
agent-connector install --scope project --targets claude-code,codex   # narrow it
agent-connector doctor [--probe]            # health checks; --probe spawns the real stdio server: initialize → ping → tools/list; non-zero exit on FAIL
agent-connector status                      # glanceable install-state, ALWAYS exits 0 — doctor is the gate, status is the glance
agent-connector upgrade                     # ONE verb: re-render + heal stale pointers + managed-update guidance (aliases: sync, update)
agent-connector uninstall                   # full inverse — removes everything we wrote
agent-connector package                     # marketplace bundle, claude-plugin default (9 host formats)
agent-connector package --format mcp-server-json|mcpb   # official MCP Registry server.json / MCPB bundle — requires the connector's publish{} block; see /docs/packaging
```

`--scope` is `user` (default) or `project`. `--targets` is a comma-separated
PlatformId list. `--dry-run` works on install/upgrade/uninstall. `--connector <path>`
points at a config explicitly; otherwise it's found by walking up from the project.
Canonical flag-level reference: `llms-full.txt` §3 / the docs site `/docs/cli`.

## Telemetry, leaderboards, usage

There are two completely separate token-measurement axes, split by audience. They
measure DIFFERENT things and are NEVER summed.

**Axis 1 — `telemetry` / 🔌 (MCP-developer track, the developer's OWN wrapped server).**
Telemetry is ON by default: stdio servers are wrapped with `agent-connector serve` so
every `tools/call` is measured (args in, results out, plus the one-time `tools/list`
schema cost) and tokenized locally. This is the ONLY source of per-MCP and per-tool
numbers, and it exists only for a server a registered connector declares and wraps —
`serve` loads the connector by id and every record requires a connector id, so an
arbitrary third-party MCP the user didn't author produces nothing here. Wrapping is
stdio-only; remote (http/sse/ws) servers are registered but never wrapped. Every record
carries a confidence tag (`tokenizer-exact | tokenizer-calibrated | tokenizer-approx |
heuristic | host-native`).

```bash
agent-connector telemetry report --by tool --since 7d   # ranked per-tool footprint (also session|project)
agent-connector telemetry export --format csv --out tel.csv
agent-connector telemetry leaderboard --by mcp          # which of YOUR servers costs most (also --by tool | --by surface)
```

**Axis 2 — `usage` / 🖥️ (agent-CLI-user track, host-log scan, NO connector needed).**
Reads each agent CLI's OWN session logs/DBs read-only and aggregates WHOLE-CONVERSATION
totals. It groups ONLY by `platform | project | session | model | day` — there is NO
per-MCP or per-tool dimension, because agent CLIs do not log per-tool token attribution.
Use this for "which agent CLI / model is burning the most tokens?"; never read it as
"which MCP/tool costs the most." Local readers report host-logged counts; a few are
host-estimated (shown in the CONFIDENCE column); 5 "synced" platforms (cursor,
antigravity, antigravity-cli, trae, warp) are skipped as "requires sync" unless a local
cache already exists.

```bash
agent-connector usage report --by platform --since 7d   # whole-conversation totals from CLI logs (also project|session|model|day)
agent-connector usage leaderboard --by platform         # which CLI/host spent the most (also --by model)
agent-connector usage export --format csv --out usage.csv
```

The unified `agent-connector leaderboard` shows three origin-labeled boards with
DIFFERENT prerequisites — never summed: 🔌 per-MCP (needs a connector + serve traffic),
🛰️ live host-native turns (needs the opt-in usage hook, installed only by the Gemini CLI
and Antigravity adapters, and a connector at runtime), and 🖥️ host usage (the only board
that works with no setup — same whole-conversation, per-CLI/per-model scan as `usage`).
For a plain agent-CLI user with no connector, 🔌 and 🛰️ are empty; `usage` is the
primary end-user entry point precisely because only its data source is connector-free.

## Operating model

- **Home-dir single binary.** Runtime installs once under `~/.agent-connector`
  (override `AGENT_CONNECTOR_DATA_DIR`). Every host config we write is a thin
  pointer to that one stable binary, so one managed `agent-connector upgrade`
  propagates everywhere — never silent auto-update.
- **Per-project data.** Telemetry/state is keyed by project identity (git remote or
  normalized path), stored under the home data-root — survives `git clean`, shared
  across hosts opening the same project. Native host config files are never relocated.
- **Windows-first.** No symlinks, no POSIX-only assumptions.

## Privacy / opt-out

Aggregate counts only — raw tool arguments and results are never stored or
transmitted. Local-first, zero network egress by default. Opt out via
`AGENT_CONNECTOR_TELEMETRY=0` or `telemetry: { enabled: false }`. Network
calibration (Anthropic `count_tokens`) and host-native turn capture are opt-in only.
