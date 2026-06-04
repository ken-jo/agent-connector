# agent-connector

> **Write your MCP server + hooks once. Ship them to every AI-agent platform —
> and finally see how many tokens your tools actually cost.**

![platforms](https://img.shields.io/badge/platforms-29-2563eb)
![surfaces](https://img.shields.io/badge/surfaces-MCP%20%7C%20hooks%20%7C%20commands%20%7C%20tools-2563eb)
![hook paradigms](https://img.shields.io/badge/hook%20paradigms-3-2563eb)
![install verified](https://img.shields.io/badge/install%20verified-29%2F29-22c55e)
![headless runtime](https://img.shields.io/badge/headless%20runtime-10%20CLIs%20activated-22c55e)
![marketplace](https://img.shields.io/badge/package-Claude%20plugin%20%2B%20marketplace-2563eb)
![tests](https://img.shields.io/badge/tests-832%20passing-22c55e)

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

> Status: **29 platforms, all 3 hook paradigms** (exceeds the
> [tokscale](https://github.com/junhoyeo/tokscale) token-leaderboard coverage).
>
> | Paradigm | Platforms |
> |---|---|
> | `json-stdio` (full hook dispatch) | Claude Code · Codex CLI · Cursor · VS Code Copilot · JetBrains Copilot · GitHub Copilot CLI · Gemini CLI · Qwen CLI · Kiro · Kimi CLI · Crush · Goose · Hermes · Antigravity · Antigravity CLI |
> | `mcp-only` (MCP registration only) | Warp · Kilo · Droid (Factory) · Roo Code · Trae · Zed · Amp · Codebuff · Mux · Pi |
> | `ts-plugin` (generated bridge module) | OpenCode · Kilo CLI · OMP · OpenClaw |
>
> …plus the telemetry core. Adding a platform = **one registry entry + one
> adapter**. (Google Antigravity is now fully supported, including the `agy` CLI,
> as Gemini CLI sunsets.) See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Verification

The full single-API contract is **install-verified across all 29 platforms**. A
sample connector declaring **all four surfaces** — MCP server **+** lifecycle
hooks **+** slash commands **+** tools (skills + subagents) — was installed into
an isolated environment for every adapter and inspected on disk:

- **29 / 29 platforms — zero missing, zero failed surfaces.** Each surface is
  written where the host supports it and gracefully *skip-warned* (never silently
  dropped) where it does not, across all three hook paradigms — JSON/TOML/YAML
  hook entries (`json-stdio`), synthesized + registered plugin modules
  (`ts-plugin`), and MCP-only graceful degradation.
- **Live hook dispatch + telemetry, proven end-to-end.** Hooks fire with the
  correct allow / deny / context decisions through the universal entrypoint, and
  the telemetry serve-proxy records per-MCP token usage in vivo — both the
  🔌 MCP/plugin and 🖥️ host/user leaderboards verified against real CLI logs.
- **Runtime-activated, headlessly — 10 real host CLIs.** **Claude Code · Codex ·
  OpenCode · Kilo CLI · OpenClaw · qwen-code · Hermes · Gemini CLI · GitHub
  Copilot CLI · Antigravity CLI (agy)** each genuinely loaded the config, spawned
  our telemetry serve-wrapper, completed the MCP handshake, and were captured *in
  vivo* by our own telemetry store. Most via their own `mcp list`/`reconnect` handshake with
  no API key, login, or model turn; Codex, Gemini CLI & Copilot CLI on real
  logged-in sessions (Codex/Gemini recorded actual tool-call rows). Each row now
  carries the correct `hostPlatform` (the install target is baked into the
  wrapper as `--host`). Kimi also spawned the server (its probe tears the pipe
  down before the row flushes). Login-gated CLIs not configured here (amp, goose,
  codebuff, omp), TUI-only Crush, the GUI-only Coder Mux, and the IDE/editor
  hosts are verified at the config-write layer and need the app itself for full
  runtime activation.
- **Clean uninstall + `--purge`.** Every installed surface reverses; `--purge`
  deregisters the connector record and tears down the home binary when no
  connectors remain (29 / 29).
- **832 tests passing** · `tsc` clean · build green.

Coverage was confirmed by **installing the real, not-yet-present agent CLIs into
isolated homes and observing their actual config** — which caught defects a
static code/web audit missed. See the reports under
[`docs/research/`](docs/research/).

## Quick start

```bash
npm i -g agent-connector

cd my-mcp-project        # contains agent-connector.config.mjs (see examples/)
agent-connector detect           # which platforms are installed here?
agent-connector install --dry-run  # preview every change, everywhere
agent-connector install            # deploy across all detected hosts
agent-connector telemetry report   # per-tool token footprint
agent-connector package            # OR emit a marketplace-installable plugin (below)
```

### Two ways to ship: direct install **or** a marketplace package

Same one definition, your choice of distribution:

- **Direct install** (above) — `install` writes each host's native MCP + plugin/
  extension config in place; no per-platform marketplace submission or review.
- **Marketplace package** — `agent-connector package` turns the connector into a
  **Claude Code plugin** (`.claude-plugin/plugin.json` + bundled commands, agents,
  skills, hooks, `.mcp.json`) **plus a `marketplace.json`**, so anyone can install
  it through the platform marketplace:

  ```bash
  agent-connector package --out ./dist-plugin   # emit plugin + marketplace.json
  # then, in Claude Code:
  #   /plugin marketplace add ./dist-plugin
  #   /plugin install <connector-id>@agent-connector
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
