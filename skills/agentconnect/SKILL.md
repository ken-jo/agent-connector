---
name: agentconnect
description: Write an MCP server, lifecycle hooks, slash commands, Agent Skills, or subagents ONCE with defineConnector({...}), then install/sync/uninstall them across every detected AI-agent CLI (Claude Code, Codex, Cursor, Copilot, Gemini, OpenCode, Warp, and ~25 more) in each host's native config dialect. Also gives default, platform-independent, local-first per-tool token telemetry and two leaderboards (per-MCP server bytes vs host CLI usage). Use this when a developer wants one integration to reach many agent hosts, or wants to know which of their MCP tools cost the most context.
---

# agentconnect

agentconnect is middleware that solves two problems every MCP/agent-tooling dev
hits: (1) each agent host re-invents MCP registration + lifecycle hooks with
incompatible config files, root keys, formats (JSON/JSONC/TOML/YAML/exported TS),
and event names; (2) no host reports per-tool token usage back to an MCP server.
Write the integration once; the CLI renders it into each installed host's native
dialect and measures your server's own token footprint locally.

## When to reach for it

- A dev wants to ship ONE MCP server (and/or hooks / slash commands / Agent Skills /
  subagents) across many agent CLIs without hand-authoring N config dialects.
- A dev asks "which of my tools cost the most context?" → per-tool token telemetry.
- A dev wants to compare token spend across the agent CLIs on their machine →
  `usage` + `leaderboard`.

Do NOT use it to author a brand-new MCP server protocol — it deploys + measures an
existing server command/URL and wraps lifecycle hooks; it does not implement tools.

## Write once: defineConnector({...})

Create `agentconnect.config.mjs` (or `.js` / `.json`) at the project root:

```ts
import { defineConnector } from "agentconnect";

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
npm i -g agentconnect
cd my-mcp-project

agentconnect detect                      # which hosts are installed + scope + capabilities + paradigm
agentconnect install --dry-run           # preview every change, everywhere (nothing written)
agentconnect install                     # deploy across detected hosts
agentconnect install --scope project --targets claude-code,codex   # narrow it
agentconnect doctor                      # per-platform health checks (non-zero exit on FAIL)
agentconnect sync                        # idempotent re-render after edits/upgrade; heals stale pointers
agentconnect uninstall                   # full inverse — removes everything we wrote
```

`--scope` is `user` (default) or `project`. `--targets` is a comma-separated
PlatformId list. `--dry-run` works on install/sync/uninstall. `--connector <path>`
points at a config explicitly; otherwise it's found by walking up from the project.

## Telemetry, leaderboards, usage

Telemetry is ON by default: stdio servers are wrapped with `agentconnect serve`
so every `tools/call` is measured (args in, results out, plus the one-time
`tools/list` schema cost) and tokenized locally. Every record carries a confidence
tag (`tokenizer-exact | tokenizer-approx | heuristic | host-native`).

```bash
agentconnect telemetry report --by tool --since 7d   # ranked per-tool footprint (also session|project)
agentconnect telemetry export --format csv --out tel.csv
agentconnect telemetry leaderboard --by mcp          # which MCP server costs most (or --by tool)
agentconnect usage report --by platform --since 7d   # host-native usage parsed read-only from CLI logs
agentconnect leaderboard                             # 🔌 per-MCP + 🖥️ host + 🛰️ live host-native turns
```

The MCP/telemetry numbers (server's own bytes) and the host/usage numbers
(whole-conversation usage from CLI logs) measure DIFFERENT things and are NEVER
summed.

## Operating model

- **Home-dir single binary.** Runtime installs once under `~/.agentconnect`
  (override `AGENTCONNECT_DATA_DIR`). Every host config we write is a thin
  pointer to that one stable binary, so one managed `agentconnect update`
  propagates everywhere — never silent auto-update.
- **Per-project data.** Telemetry/state is keyed by project identity (git remote or
  normalized path), stored under the home data-root — survives `git clean`, shared
  across hosts opening the same project. Native host config files are never relocated.
- **Windows-first.** No symlinks, no POSIX-only assumptions.

## Privacy / opt-out

Aggregate counts only — raw tool arguments and results are never stored or
transmitted. Local-first, zero network egress by default. Opt out via
`AGENTCONNECT_TELEMETRY=0` or `telemetry: { enabled: false }`. Network
calibration (Anthropic `count_tokens`) and host-native turn capture are opt-in only.
