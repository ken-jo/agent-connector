# agent-connector

> **Write your MCP server + hooks once. Ship them to every AI-agent platform —
> and finally see how many tokens your tools actually cost.**

[![npm](https://img.shields.io/npm/v/@ken-jo/agent-connector?color=cb3837&logo=npm)](https://www.npmjs.com/package/@ken-jo/agent-connector)
[![license](https://img.shields.io/npm/l/@ken-jo/agent-connector?color=22c55e)](LICENSE)
![platforms](https://img.shields.io/badge/platforms-29-2563eb)
![surfaces](https://img.shields.io/badge/surfaces-MCP%20%7C%20hooks%20%7C%20commands%20%7C%20tools-2563eb)
![hook paradigms](https://img.shields.io/badge/hook%20paradigms-3-2563eb)
![install verified](https://img.shields.io/badge/install%20verified-29%2F29-22c55e)
![headless runtime](https://img.shields.io/badge/headless%20runtime-10%20CLIs%20activated-22c55e)
![marketplace](https://img.shields.io/badge/package-9%20marketplace%20formats-2563eb)
![tests](https://img.shields.io/badge/tests-951%20passing-22c55e)

Every agent host — Claude Code, Codex, Cursor, OpenCode, Copilot, Gemini, Warp,
… — re-invents the same two integration surfaces (**MCP registration** and
**lifecycle hooks**) with incompatible config files, root keys, formats (JSON /
JSONC / TOML / YAML / exported functions), transports, scopes, and event names.
Supporting them today means hand-authoring and maintaining *N* dialects and *N*
install flows, then chasing each platform's quirks.

agent-connector is the middleware that does it for you:

1. **One API, every platform.** Declare your server + hooks once with
   `defineConnector({...})`; the CLI detects every installed host and renders the
   right native config in each — install, uninstall, upgrade, doctor.
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
> | `json-stdio` (full hook dispatch) | Claude Code · Codex CLI · Cursor · VS Code Copilot · JetBrains Copilot · GitHub Copilot CLI · Gemini CLI · Qwen CLI · Kiro · Kimi CLI · Crush · Goose · Hermes · Droid (Factory) · Antigravity · Antigravity CLI |
> | `mcp-only` (MCP registration only) | Warp · Kilo · Roo Code · Trae · Zed · Amp · Codebuff · Mux · Pi |
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
- **951 tests passing** · `tsc` clean · build green.

Coverage was confirmed by **installing the real, not-yet-present agent CLIs into
isolated homes and observing their actual config** — which caught defects a
static code/web audit missed. See the reports under
[`docs/research/`](docs/research/).

## Quick start

agent-connector is an **SDK you depend on**, not a global tool. Add it to the
package that holds your connector, declare the connector once, then **either**
ship a branded CLI your users drive directly **or** run it with `npx`. No
separate global install is required.

```bash
# 1. add agent-connector as a DEPENDENCY of your connector package
npm install @ken-jo/agent-connector

# 2. write agent-connector.config.mjs (defineConnector — see "Define once" below)

# 3a. ship a branded CLI so YOUR users drive it (auto-scoped — no --connector):
acme-db detect             # which platforms are installed here?
acme-db install --dry-run  # preview every change, everywhere
acme-db install            # deploy across all detected hosts
acme-db leaderboard        # acme-db's token footprint vs the boards
acme-db package            # OR emit a marketplace-installable plugin (below)

# 3b. …or just run it from the project with npx — still no global install:
npx @ken-jo/agent-connector detect
npx @ken-jo/agent-connector install
```

> **Optional convenience.** A global `npm i -g @ken-jo/agent-connector` is **not**
> required for the flow above — `npx @ken-jo/agent-connector …` runs it straight from
> your project. Install it globally only if you want to poke at the CLI by hand
> outside any connector package.

### Embed it / ship a branded CLI

A connector developer adds agent-connector as a dependency and ships their
**own** bin. `createConnectorCli({ name, connector })` (from the
`agent-connector/cli` export) exposes **every** agent-connector subcommand under
your brand, fully delegated and **auto-scoped** to your connector — so your
users never install agent-connector globally or type `--connector`. See
[`examples/branded-cli`](examples/branded-cli) for the full, runnable package.

```jsonc
// package.json — agent-connector is a dependency (not -g); your package owns the bin
{
  "name": "acme-db-tools",
  "type": "module",
  "bin": { "acme-db": "./bin.mjs" },
  "dependencies": { "@ken-jo/agent-connector": "0.1.0" }
}
```

```js
#!/usr/bin/env node
// bin.mjs — every agent-connector subcommand, branded as `acme-db`
import { fileURLToPath } from "node:url";
import { createConnectorCli } from "@ken-jo/agent-connector/cli";

// run() resolves to the exit code and never calls process.exit
process.exitCode = await createConnectorCli({
  name: "acme-db",
  connector: fileURLToPath(
    new URL("./agent-connector.config.mjs", import.meta.url),
  ),
}).run();
```

After a consumer installs **your** package (`npm install acme-db-tools`), the
`acme-db` bin is on their PATH and every command is scoped to your connector:

```bash
acme-db install              # deploy the acme-db connector everywhere (no --connector)
acme-db upgrade              # bring everything current (alias: sync, update)
acme-db doctor               # health-check every platform for acme-db
acme-db leaderboard          # the 🔌 MCP/plugin section, scoped to acme-db
acme-db telemetry report --by tool   # acme-db's per-tool token footprint
acme-db --help               # every agent-connector subcommand, branded
```

**Auto-scoping is pure argument injection over the SAME single home binary.** A
branded subcommand is the matching agent-connector command with your connector
pre-injected — `acme-db leaderboard` ≈ `agent-connector leaderboard --connector
acme-db`, `acme-db install` ≈ `agent-connector install --connector
./agent-connector.config.mjs`. `serve` and `hook` still route through the one
`~/.agent-connector` home binary every host config points back to, so branded
tools share that infrastructure. An explicit `--connector` / `--connector-id`
always overrides the injected default.

### Two ways to ship: direct install **or** a marketplace package

Same one definition, your choice of distribution:

- **Direct install** (above) — `install` writes each host's native MCP + plugin/
  extension config in place; no per-platform marketplace submission or review.
- **Marketplace package** — `agent-connector package` turns the connector into a
  marketplace/extension bundle (manifest + bundled commands, agents, skills,
  hooks, MCP) for **9 host formats** (plus 2 official MCP standard artifacts —
  see *Publish to the MCP ecosystem*) across the ecosystem, from one definition:
  `claude-plugin` (Claude Code · Codex · VS Code Copilot · OpenClaw · OMP) ·
  `codex-plugin` · `factory-plugin` (Droid) · `gemini-extension` (Gemini CLI) ·
  `qwen-extension` · `agy-plugin` (Antigravity CLI/IDE) · `cursor-plugin` ·
  `kimi-plugin` · `npm-plugin` (OpenCode / Kilo CLI / Pi). Hooks + MCP keep the
  telemetry serve-wrapper, so a marketplace-installed connector still reports
  per-tool tokens.

  ```bash
  # emit all 9 host formats (mcp-server-json + mcpb are opt-in by name — they need publish{})
  agent-connector package --format all  --out ./dist-plugin
  agent-connector package --format gemini-extension --out ./ext   # or one
  # e.g. Claude Code:  /plugin marketplace add ./dist-plugin/claude-plugin
  #                    /plugin install <connector-id>@agent-connector
  # e.g. Gemini CLI:   gemini extensions install ./dist-plugin/gemini-extension/<id>
  ```

## Define once

```ts
import { defineConnector } from "@ken-jo/agent-connector";

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
  place. Updates are **explicit/managed** (`agent-connector upgrade`), never silent
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
| `uninstall [--targets …]` | Full inverse — removes everything we wrote. |
| `upgrade [--channel stable\|latest]` | One verb (alias: `update`, `sync`) — re-render host config + heal stale pointers + refresh the home-binary pointer, printing managed-update guidance (never a silent self-update). |
| `doctor [--probe]` | Per-platform health checks with fixes; `--probe` runs a live MCP handshake (initialize → ping → tools/list) against the real server. |
| `status` | Light install-state: which connectors are present on which hosts (always exits 0). |
| `package [--format <fmt>\|all]` | Emit a host bundle, or an OFFICIAL standard artifact: `mcp-server-json` (registry) · `mcpb` (one-click bundle). |
| `telemetry report [--by tool\|session\|project] [--since 7d] [--connector <id>]` | Token footprint (scope to your connector with `--connector`). |
| `telemetry export [--format csv\|json] [--connector <id>]` | Raw aggregate records. |
| `usage report\|export\|leaderboard` | Host-native token usage parsed read-only from each agent CLI's own logs; never summed with telemetry. |
| `leaderboard [--since 7d] [--connector <id>] [--scope <slice>]` | Three origin-labeled boards; `--connector` filters the 🔌 MCP/plugin section to one connector. |

> `hook` and `serve` also exist — internal entrypoints the written host configs
> point at; you never run them by hand. Full flag-level reference: the
> [docs site `/docs/cli`](https://github.com/ken-jo/agent-connector) · `llms-full.txt` §3 (canonical, drift-guarded by tests).

> A **branded CLI** auto-injects `--connector` for you: `<your-tool>
> leaderboard` ≈ `agent-connector leaderboard --connector <id>`, and
> `<your-tool> telemetry report` ≈ `agent-connector telemetry report --connector
> <id>` — so a connector developer sees **their** connector's token usage by
> default.

## Publish to the MCP ecosystem

Where the MCP standard already covers your server's functionality, agent-connector
**emits the standard exactly** so your already-standard work is portable — you
write the server, we carry the distribution:

- **`package --format mcp-server-json`** → an official **MCP Registry** `server.json`
  (schema `2025-12-11`). It describes your **real upstream server** (what a registry
  installer runs), not our telemetry wrapper. Publish it with the official
  `mcp-publisher` CLI.
- **`package --format mcpb`** → an official **MCPB** (`.mcpb`, formerly DXT) bundle
  `manifest.json` (`manifest_version 0.3`) for one-click local install in Claude
  Desktop and any MCPB host, with secrets routed through the host keychain
  (`user_config`).

Both read a `publish` block on your connector (the namespace you own + your
published package + author):

```ts
defineConnector({
  id: "acme-db",
  version: "1.2.0",
  server: { transport: "stdio", command: "npx", args: ["-y", "@acme/acme-db-mcp"] },
  publish: {
    registryNamespace: "io.github.acme", // a namespace YOU proved ownership of
    packageName: "@acme/acme-db-mcp",     // your REAL published package
    author: { name: "Acme Inc" },
  },
});
```

> **Config we write is the standard.** `install` writes each host's native MCP
> config in the de-facto canonical `mcpServers` shape — `{ command, args, env }`
> for stdio, `{ url, headers }` for remote — across every target in one call. The
> spec transport slug for streamable HTTP is `streamable-http` (registry
> `server.json`); host configs canonically use `http`. WebSocket (`ws`) is **not**
> an MCP spec transport and the standard artifacts reject it.

> **Forward-compatible by transport.** The `serve` proxy is **byte-transparent**:
> it forwards every JSON-RPC message verbatim and only tees a copy to count
> `tools/call` round-trips (+ the one-time `tools/list` overhead). So newer MCP
> features ride through untouched and uncounted — **MCP Apps** (the official
> `io.modelcontextprotocol/ui` extension: `ui://` resource templates, `_meta.ui`
> tool linkage, the bidirectional `ui/*` + `sampling` traffic) and **any
> reverse-DNS extension** negotiated at `initialize`. A connector whose server
> already speaks these deploys across every host and keeps its telemetry today,
> no agent-connector change required. (Authoring such a UI is the dev's own MCP
> server's job; we deploy + wrap it. `doctor --probe` offers the latest released
> protocol revision and accepts whatever a server negotiates.)

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

Apache-2.0 © 2026 KenJo
