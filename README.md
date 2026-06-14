# agent-connector

> **If you BUILD an MCP integration:** write your server + hooks once with
> `defineConnector()`, deploy it to every detected AI-agent platform, and measure
> your own server's per-tool tokens.
> **If you just USE agent CLIs:** run `agent-connector usage` to read their logs
> and see per-CLI / per-model token totals — no connector, config, or install.

[![npm](https://img.shields.io/npm/v/@ken-jo/agent-connector?color=cb3837&logo=npm)](https://www.npmjs.com/package/@ken-jo/agent-connector)
[![license](https://img.shields.io/npm/l/@ken-jo/agent-connector?color=22c55e)](LICENSE)
![platforms](https://img.shields.io/badge/platforms-29-2563eb)
![surfaces](https://img.shields.io/badge/surfaces-MCP%20%7C%20hooks%20%7C%20commands%20%7C%20tools%20%7C%20memory-2563eb)
![hook paradigms](https://img.shields.io/badge/hook%20paradigms-3-2563eb)
![install verified](https://img.shields.io/badge/install%20verified-29%2F29-22c55e)
![headless runtime](https://img.shields.io/badge/headless%20runtime-10%20CLIs%20activated-22c55e)
![marketplace](https://img.shields.io/badge/package-9%20marketplace%20formats-2563eb)
![tests](https://img.shields.io/badge/tests-1438%20passing-22c55e)

## Who this is for

agent-connector serves **two distinct audiences** — pick your track:

- **I build an MCP integration** (MCP developer) → you write your server + hooks
  once and deploy them everywhere, then measure **your own server's** per-tool
  tokens. Start at [**Quick start → MCP developer**](#mcp-developer).
- **I just use agent CLIs and want to see token usage** (agent-CLI user) → you
  already run Claude Code / Codex / Cursor and haven't authored a connector; you
  just want per-CLI / per-model token totals. Run
  [**`agent-connector usage`**](#agent-cli-end-user) — no connector, config, or
  install required.

> The dividing line: the connector-free `usage` path reports **whole-conversation
> totals** per agent CLI / model / project / session / day. It does **not** itemize
> cost by individual MCP server or tool — agent CLIs don't log per-tool token
> attribution. Per-MCP and per-tool numbers come only from the serve-proxy
> telemetry that an MCP developer's own connector produces (the developer track).

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
   platform-independent answer to *"which of **your server's own tools** (the MCP
   your connector declares and wraps) cost the most context?"*, with **aggregate
   counts only, stored locally, zero egress by default.** Per-tool telemetry is
   automatic for **stdio** servers only; remote (`http`/`sse`/`ws`) servers are
   registered but **not wrapped** (the proxy cannot intercept remote transports),
   so they yield no per-tool telemetry.

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
sample connector declaring **all four launch surfaces** — MCP server **+**
lifecycle hooks **+** slash commands **+** tools (skills + subagents) — was
installed into an isolated environment for every adapter and inspected on disk:

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
- **1438 tests passing** · `tsc` clean · build green.

The 0.2.0 additions — the `memory` surface, the `nativeHooks` passthrough, and
`configPatch` — went through the same bar: dogfooded against real connector
migrations (context-mode, oh-my-claudecode) and verified in isolated-home
installs before landing (see [`CHANGELOG.md`](CHANGELOG.md)).

Coverage was confirmed by **installing the real, not-yet-present agent CLIs into
isolated homes and observing their actual config** — which caught defects a
static code/web audit missed. See the reports under
[`docs/research/`](docs/research/).

## Quick start

The Quick start forks by audience. Just want to see your agent CLIs' token
usage? **Agent-CLI end user** comes first — it needs no connector at all, and
those few lines are the entire track. Build an integration? Skip ahead to
**MCP developer** — everything from there to the end of the README is yours.

### Agent-CLI end user

> **Audience B** — you already run agent CLIs (Claude Code / Codex / Cursor / …)
> and have **not** authored a connector. You just want to know how many tokens
> your agent CLIs are burning.

**No connector, no config file, no install.** Run it straight from `npx`; it
reads your local agent-CLI session logs **read-only** and never writes any host
config:

```bash
# how many tokens are my agent CLIs burning, grouped by CLI/model/project/session/day?
npx @ken-jo/agent-connector usage report --by platform   # or model|project|session|day

# which agent CLI burned the most tokens?
npx @ken-jo/agent-connector usage leaderboard --by platform   # or --by model

# export the raw aggregate rows (counts only — never your prompts or results)
npx @ken-jo/agent-connector usage export --format csv --out usage.csv
```

> **What `usage` does — and doesn't — show.** It reports **whole-conversation
> totals** per agent CLI / model / project / session / day. It does **not** break
> down cost by individual MCP server or by tool — agent CLIs don't log per-tool
> token attribution, so the connector-free path can only see session totals.
> To get **per-MCP / per-tool** numbers for an MCP, that MCP must be deployed and
> wrapped via a connector (the MCP-developer track and its `telemetry` command).

> **Coverage caveats.** Local readers (claude-code, codex, gemini-cli, …) report
> host-logged exact counts; a few readers are host-estimated (labeled in the
> `CONFIDENCE` column). Five "synced" platforms — **cursor, antigravity,
> antigravity-cli, trae, warp** — are reported as skipped (`requires sync — no
> local cache found`) unless a local cache already exists, since agent-connector
> does not populate that cache.

> **That's the entire agent-CLI track.** Everything below this point is the
> MCP-developer track. ([back to top](#agent-connector))

### MCP developer

> **Audience A** — you write an MCP server + hooks once and deploy them across
> every detected host, measuring **your own server's** per-tool tokens.

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
acme-db install --dry-run  # preview every change across the detected hosts
acme-db install            # deploy across the hosts detected on this machine
acme-db doctor             # health-check every detected platform — add --probe for a live MCP handshake (initialize → ping → tools/list)
acme-db upgrade            # day 2: re-render configs + heal the home-binary pointer (aliases: sync, update)
acme-db leaderboard        # acme-db's token footprint vs the boards
acme-db package            # OR distribute: marketplace plugin (9 formats) — or --format mcp-server-json | mcpb for the MCP Registry / an MCPB bundle (see "Publish to the MCP ecosystem")
acme-db uninstall          # full inverse — removes everything install wrote; --purge clears framework state; --dry-run works here too

# 3b. …or just run it from the project with npx — still no global install:
npx @ken-jo/agent-connector detect
npx @ken-jo/agent-connector install
```

> `install` targets only the hosts actually **detected** on this machine (or an
> explicit `--targets` / `connector.targets` list), intersected with the
> 29-adapter registry — there is no "install to all 29 unconditionally" path.

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
  "dependencies": { "@ken-jo/agent-connector": "^0.2.0" }
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
acme-db install              # deploy acme-db across the detected hosts (no --connector)
acme-db upgrade              # bring everything current (alias: sync, update)
acme-db doctor               # health-check every detected platform for acme-db
acme-db leaderboard          # the 🔌 MCP/plugin section, scoped to acme-db
acme-db telemetry report --by tool   # per-tool tokens for acme-db's own wrapped server
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
- **Marketplace install** — `install --method marketplace` drives the host's own
  plugin flow end-to-end for **10 hosts**: Claude Code, Codex, OpenCode, Kilo
  (CLI + ext), Antigravity (CLI + IDE) — live-verified on Linux, Windows, and
  macOS — plus Droid and Qwen Code (driver shipped, pending a live host) and
  Gemini CLI (legacy — sunsetting toward Antigravity; driver kept for existing
  installs). It stages the bundle, registers a local marketplace where the host
  has one, then runs the host's plugin-install verb (or, for npm-plugin hosts,
  writes a local `file://` entry); headless and idempotent. `uninstall --method
  auto` reverses whichever method is installed, a guard refuses installing the
  same connector by BOTH methods, and `doctor` checks registration drift. Other
  marketplace-format hosts print the exact manual commands.
- **Marketplace package** — `agent-connector package` turns the connector into a
  marketplace/extension bundle (manifest + bundled commands, agents, skills,
  hooks, MCP) for **9 host formats** (plus 2 official MCP standard artifacts —
  see *Publish to the MCP ecosystem*) across the ecosystem, from one definition:
  `claude-plugin` (Claude Code · Codex · VS Code Copilot · OpenClaw · OMP) ·
  `codex-plugin` · `factory-plugin` (Droid) · `gemini-extension` (Gemini CLI) ·
  `qwen-extension` · `agy-plugin` (Antigravity CLI/IDE) · `cursor-plugin` ·
  `kimi-plugin` · `npm-plugin` (OpenCode / Kilo CLI / Pi). Hooks + MCP keep the
  telemetry serve-wrapper, so a marketplace-installed connector still reports
  per-tool tokens (for its stdio server).

  ```bash
  # emit all 9 host formats (mcp-server-json + mcpb are opt-in by name — they need publish{})
  agent-connector package --format all  --out ./dist-plugin
  agent-connector package --format gemini-extension --out ./ext   # or one
  # e.g. Claude Code:  /plugin marketplace add ./dist-plugin/claude-plugin
  #                    /plugin install <connector-id>@agent-connector
  # e.g. Gemini CLI:   gemini extensions install ./dist-plugin/gemini-extension/<id>
  ```

  > **Embedded-path caveat.** 8 of the 9 host bundles bake in the absolute
  > home-bin launcher path of the machine that ran `package`, so they're valid
  > for a **local install on that same machine/home**. For shared distribution use
  > `npm-plugin` or the 2 MCP standard artifacts, or re-run `package` per machine.

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

> **Native hooks escape hatch.** The normalized `hooks` API covers the 12
> cross-platform events. For host-only events — Claude Code alone ships 30
> (`TaskCompleted`, `TeammateIdle`, `WorktreeCreate`, …) — declare
> `platforms: { "claude-code": { nativeHooks: { TaskCompleted: { handler } } } }`:
> the handler receives the host's **raw** payload and whatever it returns is the
> **verbatim** JSON reply (exit 0 only — exit-2 blocking isn't modeled). Claude
> Code only for now; other hosts skip-warn, never silently.

> **Host-config key patches.** For host-exclusive *settings keys* no other
> surface reaches (Claude Code's `statusLine`, an experimental `env.*` flag),
> declare `platforms: { "claude-code": { configPatch: [{ key, value, reason }] } }`.
> Semantics are fixed: **set-if-absent + skip-warn on any conflict** — never
> overwrite, never deep-merge. Ownership is refcounted in a persisted ledger, so
> uninstall removes a key only when the last owning connector releases it and the
> value is untouched; security-relevant keys (`permissions*`, `apiKey*`,
> `env.ANTHROPIC_*`, token/secret env vars, …) are hard-refused. Claude Code only
> for now; other hosts skip-warn with the exact manual edit.

`agent-connector install` turns that into, e.g.:

| Host | What gets written |
|---|---|
| **Claude Code** | `~/.claude.json` → `mcpServers.acme-db` (+ hooks in `~/.claude/settings.json`) |
| **Codex CLI** | `~/.codex/config.toml` → `[mcp_servers.acme-db]` (+ `~/.codex/hooks.json`) |
| **Cursor** | `~/.cursor/mcp.json` → `mcpServers.acme-db` (+ `~/.cursor/hooks.json`) |

…each pointing hooks at a **single stable home binary**, so one update propagates
everywhere.

### Standing guidance (`memory`) — aligned with the AGENTS.md standard

Ship the rules every agent should follow when your MCP is installed:

```ts
memory: [
  {
    content:
      "Use the acme-db MCP tools for schema questions; never hand-edit migrations.",
  },
],
```

**Write the guidance once — it lands in the standard
[AGENTS.md](https://agents.md) on 27 of the 29 hosts** (the open, Linux
Foundation-stewarded "README for agents" format): project scope targets
`<projectDir>/AGENTS.md` — and where a host resolves its rules file
exclusively, the target is *probed* so the block lands in the file the host
actually reads (zed's first-match rules list, warp's `WARP.md` priority,
hermes' `.hermes.md`, opencode's `CLAUDE.md` fallback, codex's
`AGENTS.override.md`). User scope goes to the host's documented global memory
file (AGENTS.md where one exists, else the host's own file — `~/.qwen/QWEN.md`,
goose `.goosehints`, kilo/roo/kiro rules dirs).
The two hosts that don't read AGENTS.md are wired per their own official docs:

- **Claude Code** → the block goes in `CLAUDE.md` (the official memory docs are
  explicit: *"Claude Code reads CLAUDE.md, not AGENTS.md"*). Opt-in
  `platforms: { "claude-code": { memory: { mode: "agents-import" } } }` instead
  writes the canonical AGENTS.md block plus Anthropic's documented `@AGENTS.md`
  import line as a managed bridge in CLAUDE.md — opt-in because the import makes
  Claude read the *entire* AGENTS.md.
- **Gemini CLI** → `GEMINI.md`, unless the user's `context.fileName` setting
  already opts Gemini into AGENTS.md (probed and respected — never edited).

Writes are **surgical managed blocks** — marker-fenced
(`<!-- agent-connector:begin <id>/memory hash=… -->`), hash-stamped, multiple
connectors coexist in one file, and bytes outside your own markers are never
touched. If a user edits inside the block, the hash mismatch is detected and the
edit is *left intact* (sync warns; `install --force` overwrites after a backup).
Uninstall excises exactly your blocks and `doctor` verifies them (present /
hash-intact / user-edited / file missing). Hosts with no writable memory file at
a scope skip-warn, never silently.

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
| `install [--scope user\|project] [--targets …] [--dry-run] [--force]` | Render + write MCP + hooks + content surfaces (commands / skills / subagents / memory) across targets. `--force` overwrites user-edited memory blocks (after a backup). |
| `uninstall [--targets …]` | Full inverse — removes everything we wrote. |
| `upgrade [--channel stable\|latest]` | One verb (alias: `update`, `sync`) — re-render host config + heal stale pointers + refresh the home-binary pointer, printing managed-update guidance (never a silent self-update). |
| `doctor [--probe]` | Per-platform health checks with fixes; `--probe` runs a live MCP handshake (initialize → ping → tools/list) against the real server. |
| `status` | Light install-state: which connectors are present on which hosts (always exits 0). |
| `package [--format <fmt>\|all]` | Emit a host bundle, or an OFFICIAL standard artifact: `mcp-server-json` (registry) · `mcpb` (one-click bundle). |
| `telemetry report [--by tool\|session\|project] [--since 7d] [--connector <id>]` | **MCP-developer track.** Per-tool token footprint of **your connector's own wrapped server** (scope with `--connector`). Stdio servers only. |
| `telemetry export [--format csv\|json] [--connector <id>]` | Raw aggregate records for your wrapped server. |
| `usage report\|export\|leaderboard [--by platform\|model\|project\|session\|day]` | **Agent-CLI-user track (no connector needed).** Host-native token usage parsed read-only from each agent CLI's own logs — **whole-conversation totals per platform / model / project / session / day. Does NOT break down by individual MCP or tool** (agent CLIs don't log per-tool attribution). Never summed with `telemetry`. |
| `leaderboard [--since 7d] [--connector <id>] [--scope <slice>]` | Three origin-labeled boards with **different prerequisites** (counts are never summed across them): 🔌 MCP/plugin needs a connector + serve traffic; 🛰️ host-native turns need the opt-in usage hook (Gemini CLI / Antigravity only); 🖥️ host/user works with **no setup**. `--connector` filters the 🔌 board to one connector. |

> `hook` and `serve` also exist — internal entrypoints the written host configs
> point at; you never run them by hand. Full flag-level reference: the
> [docs site `/docs/dev/cli`](https://github.com/ken-jo/agent-connector) · `llms-full.txt` §3 (canonical, drift-guarded by tests).

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
