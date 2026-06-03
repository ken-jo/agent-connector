# agent-connector

> **Write your MCP server + hooks once. Ship them to every AI-agent platform —
> and finally see how many tokens your tools actually cost.**

Every agent host — Claude Code, Codex, Cursor, OpenCode, Copilot, Gemini, Warp,
… — re-invents the same two integration surfaces (**MCP registration** and
**lifecycle hooks**) with incompatible config files, root keys, formats (JSON /
JSONC / TOML / YAML / exported functions), transports, scopes, and event names.
Supporting them today means hand-authoring and maintaining *N* dialects and *N*
install flows, then chasing each platform's quirks.

agent-connector is the middleware that does it for you:

1. **One API, every platform.** Declare your server + hooks once with
   `defineConnector({...})`; the CLI detects every installed host and renders the
   right native config in each — install, sync, uninstall, doctor.
2. **Token telemetry, by default.** No host reports per-tool usage back to an MCP
   server. agent-connector measures your server's *own* bytes (args in, results
   out, tool schemas) and tokenizes them locally — so you get a
   platform-independent answer to *"which of my tools cost the most context?"*,
   with **aggregate counts only, stored locally, zero egress by default.**

> Status: **26 platforms, all 3 hook paradigms** (parity with the
> [tokscale](https://github.com/junhoyeo/tokscale) token-leaderboard coverage).
>
> | Paradigm | Platforms |
> |---|---|
> | `json-stdio` (full hook dispatch) | Claude Code · Codex CLI · Cursor · VS Code Copilot · JetBrains Copilot · GitHub Copilot CLI · Gemini CLI · Qwen CLI · Kiro · Kimi CLI · Crush · Goose · Hermes |
> | `mcp-only` (MCP registration only) | Warp · Kilo · Droid (Factory) · Roo Code · Trae · Antigravity · Zed · Amp · Codebuff · Mux |
> | `ts-plugin` (generated bridge module) | OpenCode · OMP · OpenClaw |
>
> …plus the telemetry core. Adding a platform = **one registry entry + one
> adapter**. (Pi is excluded — it exposes no writable MCP config; it's a future
> telemetry-only target.) See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quick start

```bash
npm i -g agent-connector

cd my-mcp-project        # contains agent-connector.config.mjs (see examples/)
agent-connector detect           # which platforms are installed here?
agent-connector install --dry-run  # preview every change, everywhere
agent-connector install            # deploy across all detected hosts
agent-connector telemetry report   # per-tool token footprint
```

## Define once

```ts
import { defineConnector } from "agent-connector";

export default defineConnector({
  id: "acme-db",
  server: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@acme/db-mcp"],
    env: { ACME_DB_DSN: "${env:ACME_DB_DSN}" },
  },
  hooks: {
    PreToolUse: {
      matcher: "acme_write",
      async handler(evt) {
        return evt.toolName === "acme_write"
          ? { decision: "ask", reason: "Confirm write" }
          : { decision: "allow" };
      },
    },
  },
  // telemetry is on by default
});
```

`agent-connector install` turns that into, e.g.:

| Host | What gets written |
|---|---|
| **Claude Code** | `~/.claude.json` → `mcpServers.acme-db` (+ hooks in `~/.claude/settings.json`) |
| **Codex CLI** | `~/.codex/config.toml` → `[mcp_servers.acme-db]` (+ `~/.codex/hooks.json`) |
| **Cursor** | `~/.cursor/mcp.json` → `mcpServers.acme-db` (+ `~/.cursor/hooks.json`) |

…each pointing hooks at a **single stable home binary**, so one update propagates
everywhere.

## How it works (operating model)

- **Home-dir, single binary.** The runtime installs once under
  `~/.agent-connector` (override `AGENT_CONNECTOR_DATA_DIR`). Every platform
  config we write is a thin pointer back to that one binary — update it in one
  place. Updates are **explicit/managed** (`agent-connector update`), never silent
  auto-update, so one bad release can't break every project at once.
- **Per-project data, kept.** Telemetry/state is keyed by a stable project
  identity (git remote or normalized path), partitioned per project, stored under
  the home data-root — surviving `git clean`, shared across hosts opening the same
  project.
- **Native config stays native.** We never relocate a host's own settings files;
  only framework-owned state lives under the data-root.
- **Windows-first correctness.** No symlinks, no POSIX-only assumptions.

## CLI

| Command | Purpose |
|---|---|
| `detect` | List installed platforms, scopes, capabilities, hook paradigm. |
| `install [--scope user\|project] [--targets …] [--dry-run]` | Render + write MCP + hooks across targets. |
| `sync` | Idempotent re-render after edits/upgrade; heals stale pointers. |
| `uninstall [--targets …]` | Full inverse — removes everything we wrote. |
| `doctor` | Per-platform health checks with fixes. |
| `update [--channel stable\|latest]` | Managed update of the single home binary. |
| `telemetry report [--by tool\|session\|project] [--since 7d]` | Token footprint. |
| `telemetry export [--format csv\|json]` | Raw aggregate records. |

## Telemetry & privacy

- Default tokenizer: `gpt-tokenizer` (pure-JS, no native build) — `o200k_base`
  for OpenAI/Codex-family, used as a documented approximation for Anthropic
  (labeled `tokenizer-approx`). Falls back to a `chars/4` heuristic (labeled
  `heuristic`) if the tokenizer can't load. Every record carries a confidence tag.
- **Aggregate counts only** — raw tool arguments and results are never stored or
  transmitted. Local-first; zero network egress by default.
- Off switch: `AGENT_CONNECTOR_TELEMETRY=0`, or `telemetry: { enabled: false }`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev -- detect     # run the CLI from source via tsx
```

## License

MIT © KenJo
