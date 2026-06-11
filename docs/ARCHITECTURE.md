# agent-connector — Architecture

> Write your MCP server + hooks **once**. agent-connector detects every AI-agent
> platform on the machine, renders the right config in each one's native dialect,
> installs/syncs/uninstalls them, and gives you **default, platform-independent
> per-tool token telemetry** — the metric MCP developers actually want.

This document is the authoritative design. It is grounded in the understand-phase
report ([`docs/research/understand-report.md`](research/understand-report.md)),
which reverse-engineered context-mode's proven 15-platform adapter layer and the
real installed config formats across Claude Code, Codex, Cursor, OpenCode,
VS Code/JetBrains Copilot, Gemini, Warp, Hermes, and more.

---

## 1. Problem

Every AI-agent host re-invents the same two integration surfaces — **MCP server
registration** and **lifecycle hooks** — with mutually incompatible config files,
root keys, formats (JSON / JSONC / TOML / YAML / exported TS-or-Python functions),
transports, scopes, and event vocabularies. A developer who wants reach must
hand-author and maintain N dialects, N hook adapters, and N install flows, then
chase each platform's quirks (Cursor silently fails on a wrong root key; VS Code
uses `servers` not `mcpServers`; Codex uses TOML `[mcp_servers.x]`; OpenCode wants
an exported TS plugin function, not a hook table). context-mode paid this cost in
full for a single server. agent-connector generalizes that work into a reusable
framework.

Second, **no host reports per-tool token usage back to an MCP server** (the MCP
spec has no `usage` on `CallToolResult`). So "how much context does installing my
server actually cost, everywhere?" — the question MCP devs care most about — is
unanswerable today. agent-connector answers it by measuring the server's own
bytes and tokenizing them locally, identically across all hosts.

## 2. Two pillars

1. **Single-API multi-platform deployment.** One declarative + programmatic
   `defineConnector({...})` → adapters render it into each platform's native MCP
   registration and hook config; one CLI installs/syncs/uninstalls everywhere.
2. **Default per-MCP token telemetry.** Platform-independent, local-first,
   privacy-preserving (aggregate counts, never content). On by default, opt-out
   granular.

## 3. Operating model — home-dir-centric, single binary, per-project data

This is the baseline the user mandated (oh-my-claudecode style), refined after
critical review. Three rules:

### R1 — One home binary; everything routes through it
The framework installs **one** runtime in the home root:

```
~/.agent-connector/                 (override: AGENT_CONNECTOR_DATA_DIR)
  bin/agent-connector               single binary — CLI + universal hook entrypoint + telemetry runtime
  connectors/<id>/connector.json    each registered connector's resolved definition
  telemetry.db (or telemetry.ndjson) shared store, rows keyed by project — see R3
  backups/                          timestamped settings backups before each mutation
  logs/
```

Every platform config we write is a **thin pointer back to this one binary**:
- a hook command is `agent-connector hook <platform> <event> --connector <id>`
  (mirrors context-mode's proven `context-mode hook <platform> <name>` dispatch);
- an MCP server entry runs the connector's server, optionally wrapped by
  `agent-connector serve --connector <id> -- <real server cmd>` so telemetry is
  captured with zero work from the dev.

Because the pointers reference one stable home path, **updating that single binary
updates behavior in every platform at once** — exactly the requested ergonomic.

> **Critical adjustment #1 — stable path, managed update (NOT silent auto-update).**
> A forced/silent auto-update of a single binary means one bad release breaks
> *every project × every platform* simultaneously (maximum blast radius, lost
> reproducibility) — the `npx pkg@latest` failure mode. So: pointers reference a
> **stable** path (`~/.agent-connector/bin/agent-connector`), never a versioned
> cache dir (this also sidesteps the whole class of bug that forces context-mode's
> `cache-heal` SessionStart hook). Updates are **explicit/managed**
> (`agent-connector upgrade`, channel = stable|latest), with an optional
> **per-project version pin** override. One place to update — without global
> instant breakage.

### R2 — "Home-centric" cannot be absolute; platforms force project/global scopes
Cursor, VS Code Copilot, etc. require config files at platform-mandated locations
(`.cursor/mcp.json`, `.vscode/mcp.json`, `~/.codex/config.toml`, …). So:

> **Critical adjustment #2.** "Home-based" means the **binary + shared telemetry
> store live in home as the single source of truth**; the framework still writes
> the **minimal native pointer config wherever each platform mandates it**. Those
> pointers exec the one home binary — which is *how* "single-binary update"
> actually propagates to hosts that never read `~/.agent-connector`.

Native config files (settings.json, config.toml, mcp.json) are **never** relocated
by `AGENT_CONNECTOR_DATA_DIR` — only framework-owned state is. (Generalized from
context-mode's `resolveContextModeDataRoot` / issue #649.)

### R3 — Per-project data, keyed by project identity, retained under home
> **Critical adjustment #3.** Telemetry/state is keyed by a stable **project
> identity** — `gitRemote || normalizedAbsPath`, hashed — and stored under the home
> data-root (default), **not by code location**. This survives `git clean`, isn't
> committed, and lets multiple platforms opening the same project share one store
> (the cross-agent shared-DB mechanism). In-repo storage is **opt-in**. Concurrent
> writers (several hosts at once) are handled by append-atomic NDJSON (MVP) or
> SQLite WAL (upgrade). Data is partitioned by `project_key` column → both
> per-project retention *and* cross-project rollups.

### R4 — Native Windows correctness, no symlink installs
Single binary must resolve home via the right per-OS dir (`%USERPROFILE%` /
`%APPDATA%` / XDG / `homedir()`), no POSIX-only assumptions, no symlink-based
installs. The Windows-safe spawn/quoting helpers (`buildNodeCommand` /
`parseNodeCommand`, fixing context-mode bugs #369/#372/#548/#738) are mandatory.

## 4. The common abstraction model

Distilled from the union of platform behaviors (report §3).

- **`ServerDef`** — transport-polymorphic server descriptor (`stdio | http | sse |
  ws`; `command/args/env/cwd` or `url/headers/auth`; `tools`, `timeoutMs`,
  `enabled`). Adapters render it into each dialect; **the root key is a per-adapter
  constant** (`mcpServers` | `servers` | `mcp` | `mcp_servers`), as are field-name
  differences (`cwd` vs `working_directory`, `env` vs `environment`, scalar
  `command` vs `command:[]`).
- **Transport capability set** — an adapter may reject/downgrade a transport it
  can't honor and *report* it (never crash).
- **Scope** — normalized ordered enum `{ system, user, project, profile, managed }`;
  each adapter maps to a concrete path + knows precedence. Default install scope =
  `user`; `--scope project` opt-in.
- **Normalized lifecycle events** — `SessionStart`, `SessionEnd`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop`,
  `Notification`, `PermissionRequest`, `PostToolUseFailure`, `SubagentStart`,
  `SubagentStop` (12 canonical events — the last four are newer additions;
  hosts without a native analog mark them unsupported in capabilities and the
  install reports a skip-warn, never a silent drop). Mapped to each platform's names
  (`PreToolUse`↔`BeforeTool`↔`tool.execute.before`↔`pre_tool_call`). Normalized
  payload `{ toolName, toolInput, toolOutput?, isError?, sessionId, projectDir?,
  raw }`; normalized response `{ decision: allow|deny|modify|context|ask, reason?,
  updatedInput?, additionalContext?, updatedOutput? }`. The union is a floor, not
  a ceiling: host-only events (Claude Code alone ships 30) are reachable per
  platform via the `platforms.<id>.nativeHooks` passthrough — raw payload in,
  verbatim JSON reply out, exit 0 only; claude-code-only today
  (`supportsNativeHooks`), others skip-warn. An event is promoted into the union
  once ≥3 hosts ship a native analog (TaskCreated/TaskCompleted first candidates).
  Full contract: `llms-full.txt` §2.3.
- **Hook I/O paradigm taxonomy** (the deepest divergence — exactly three):
  - **`json-stdio`** (16) — Claude Code, Codex, Cursor, VS Code Copilot,
    JetBrains Copilot, Copilot CLI, Gemini CLI, Qwen, Kiro, Kimi, Crush, Goose,
    Hermes, Droid (Factory), Antigravity, Antigravity CLI. One universal hook
    entrypoint binary reads host JSON, the adapter normalizes it, the dev's
    handler runs, the adapter formats the reply.
  - **`ts-plugin`** (4) — OpenCode, Kilo CLI, OMP, OpenClaw. Framework
    *generates* an exported plugin module importing the dev's handler.
  - **`mcp-only`** (9) — Warp, Kilo, Roo Code, Trae, Zed, Amp, Codebuff, Mux,
    Pi. No hook layer; install only the MCP server; detection surfaces "hooks
    unavailable here."
- **`PlatformCapabilities`** flags (`preToolUse`, `postToolUse`, `preCompact`,
  `sessionStart`, `canModifyArgs`, `canModifyOutput`, `canInjectSessionContext`) —
  the single-API layer queries these and degrades gracefully.
- **Detection** — two layers: *install-time platform detection* (which hosts are
  installed: config-dir + marker files) and *runtime host detection* (which host is
  executing this hook now: env-var markers → config-dir → `clientInfo`). Generalized
  from context-mode's `registry.ts` + `detect.ts` (incl. fork-before-parent order &
  foreign-env scrubbing).
- **Escape hatch** — every adapter accepts `platforms.<id>.extra` passthrough so a
  dev reaches platform-exclusive features the core doesn't model. Thin universal
  core + fat per-adapter tail.

## 5. What we borrow vs. generalize from context-mode

**Borrow (the mechanical spine):** the `HookAdapter` SPI shape, single-source
`ADAPTER_REGISTRY` + matrix test, runtime detection + disambiguators, Windows
spawn/quoting helpers, `BaseAdapter`, the data-root override, the 3-paradigm
taxonomy, capability flags, the thunk-based doctor.

**Generalize away (context-mode domain logic, must not leak into the framework):**
the hardcoded `"context-mode"` identity → becomes the dev-supplied `id`/entrypoint
parameter; baked-in hook scripts → synthesized from the dev's handlers; session /
memory / instruction-file / FTS / `bytes_avoided` logic → deleted from the SPI;
context-mode's analytics schema → replaced by our own minimal telemetry schema; the
4-bytes/token heuristic → demoted from default to *fallback* (a real tokenizer is
the default).

## 6. Telemetry architecture

- **Measure the server's own bytes** — the only data identical across hosts.
  Intercept every `tools/call` at the server boundary (via `agent-connector serve`
  proxy or in-proc middleware). input = `params.arguments`; output =
  `result.content[]` + `structuredContent`. Also tokenize `tools/list` schemas once
  → the fixed "cost of merely defining my tools" per-turn overhead.
- **Default = real tokenizer** — `gpt-tokenizer` (pure-JS, no native build →
  Windows/single-binary safe): `o200k_base` for OpenAI/Codex-family (labeled
  `tokenizer-exact`), and the same `o200k_base` as a documented approximation
  for every other family (labeled `tokenizer-approx`; no offline Claude
  tokenizer ships). Family auto-selected from `initialize.clientInfo` or
  `modelFamilyHint`.
- **Fallback = heuristic** — `chars/4` with content-type multipliers; **labeled
  `heuristic`** so it's never mistaken for exact. Non-text blocks: per-modality
  formulas, never tokenize base64.
- **Confidence tag** on every record: `tokenizer-exact | tokenizer-calibrated | tokenizer-approx |
  heuristic | host-native`.
- **Opt-in enrichers** (never the hot path): Anthropic `count_tokens` as a
  rate-limited calibration sampler (sends content off-box → opt-in only); host-native
  usage where it exists (Gemini `AfterModel.usageMetadata.totalTokenCount`).
- **Store** — local, at data-root, **aggregate counts only — never raw
  args/results**. MVP = append-atomic NDJSON event log + derived rollups behind a
  `TelemetryStore` interface (SQLite/WAL is a drop-in upgrade). Rows keyed by
  `connectorId, toolName, scope(call|tool_defs|model_turn|hook), surfaceKind(server|hook|command|skill|subagent), hostPlatform, sessionId,
  projectKey, projectDir, inputTokens, outputTokens, confidenceSource, isError, ts`.
- **Surface** — `agent-connector telemetry report [--by tool|session|project]
  [--since 7d] [--json]` → ranked per-tool footprint, tool-def overhead line,
  input/output split, calls, tokens/call avg, per-session/project rollups, with a
  visible confidence label; plus `telemetry export --format csv|json`.
- **Privacy / opt-out** — local-first, zero egress by default; granular kill
  switches `AGENT_CONNECTOR_TELEMETRY=0` (global) + per-layer (measure / calibrate /
  upload); hashable aggregation keys; dashboards state numbers are estimates from
  the server's own I/O, not host-billed usage.

## 7. Public API (write once)

```ts
import { defineConnector } from "@ken-jo/agent-connector";

export default defineConnector({
  id: "acme-db",
  displayName: "Acme DB Tools",
  version: "1.0.0",

  server: {                                  // declared ONCE, transport-polymorphic
    transport: "stdio",
    command: "npx",
    args: ["-y", "@acme/db-mcp"],
    env: { ACME_DB_DSN: "${env:ACME_DB_DSN}" },   // universal ${env:VAR} / ${env:VAR:-default}
    tools: { include: ["*"] },
  },

  hooks: {                                   // normalized events; framework synthesizes per paradigm
    PreToolUse: {
      matcher: "acme_query|acme_write",
      async handler(evt) {
        if (evt.toolName === "acme_write") return { decision: "ask", reason: "Confirm write" };
        return { decision: "allow" };
      },
    },
  },

  telemetry: { enabled: true, modelFamilyHint: "auto", measureToolDefs: true },

  platforms: {                               // per-platform escape hatch / overrides
    warp: { hooks: false },                  // mcp-only host: skip hooks gracefully
  },
  targets: "auto",                           // or ["claude-code","codex","cursor"]
});
```

## 8. CLI

```
agent-connector detect                       # installed platforms + scope + capabilities + paradigm
agent-connector install [--scope user|project] [--targets a,b] [--connector path] [--dry-run]
agent-connector uninstall [--targets ...] [--purge]   # full inverse — removes server + hook registrations; --purge also drops the connector's home state record (+ the shared launcher when none remain)
agent-connector upgrade [--channel stable|latest]   # bring all current: re-render host config + heal pointer + managed update guidance (alias: update, sync)
agent-connector doctor [--probe]             # per-platform health checks; --probe = live MCP handshake (initialize → ping → tools/list)
agent-connector status                       # light install-state per host (always exits 0)
agent-connector package [--format <fmt>|all]      # 9 host bundle formats; mcp-server-json|mcpb = OFFICIAL MCP standard artifacts (opt-in by name)
agent-connector telemetry report|export [...]
agent-connector usage report|export|leaderboard [...]   # host-native usage from agent CLI logs (read-only)
agent-connector leaderboard [--since] [--scope] [--connector]   # 🔌 mcp-self + 🖥️ host-scan-logs + 🛰️ host-native-live (never summed)
agent-connector hook <platform> <event> --connector <id>   # universal hook entrypoint (internal)
agent-connector serve --connector <id> -- <server cmd...>   # telemetry-wrapping MCP proxy (internal)
```

> **Canonical CLI reference:** the docs site `/docs/cli` and `llms-full.txt` §3
> (kept current; drift-guarded by tests). This block is design context — when
> they disagree, the canonical reference wins.

Install per target: `backupSettings()` → render server config into native file →
if hooks & paradigm≠mcp-only: synthesize entrypoint + write hook config + set exec
bit → register in plugin registry where applicable → return change list. Everything
idempotent, reversible, `--dry-run`-able.

## 9. MVP scope & phasing

- **Phase 0 — core spine** (no platforms): contracts, `defineConnector` + validation,
  interpolation, registry/detection, spawn helpers, data-root/paths, doctor harness,
  CLI skeleton.
- **Phase 1 — MVP: 3 maximally-divergent, high-confidence platforms + telemetry core.**
  **Claude Code** (JSON, `mcpServers`, richest hooks), **Codex CLI** (TOML, env split,
  trust gates), **Cursor** (JSON + `${env:}` interpolation + `hooks.json` v1). This
  trio alone exercises JSON+TOML, three hook dialects, env-var detection, and the
  whole `json-stdio` path end-to-end. Ship telemetry core here (it's platform-
  independent by design).
- **Phase 2 — breadth on json-stdio + first host-native telemetry + first mcp-only:**
  VS Code Copilot, Copilot CLI, Gemini (wire `AfterModel` host-native enricher), Warp.
- **Phase 3 — `ts-plugin` paradigm:** OpenCode, Kilo, Hermes (the hard adapters).
- **Phase 4 — verification-gated long tail:** JetBrains, Pi, OpenClaw, zed/antigravity/
  kiro/qwen/kimi/omp.

## 10. Module layout

```
src/
  index.ts                 public API surface (defineConnector + types)
  core/
    types.ts               all shared contracts (ServerDef, events, config, scope, …)
    define-connector.ts    defineConnector() + validation + normalization
    interpolate.ts         ${env:VAR} / ${env:VAR:-default}
    paths.ts               home data-root, project key/identity, per-OS dirs
    spawn.ts               Windows-safe build/parseNodeCommand, runtime resolution
    spawn-child.ts         Windows-safe child_process.spawn wrapper
    mcp-standard.ts        pinned official-MCP literals + guards (server.json / MCPB / wire)
    package-formats/       per-host marketplace bundle renderers (claude-family, gemini, …)
    logger.ts
  adapters/
    spi.ts                 Adapter interface (generalized HookAdapter + MCP render)
    registry.ts            ADAPTER_REGISTRY single source of truth (+ matrix test)
    detect.ts              install-time + runtime detection
    base.ts                BaseAdapter shared impl
    claude-code/  codex/  cursor/      (Phase 1)
  telemetry/
    types.ts  tokenizer.ts  measure.ts  store.ts  report.ts  proxy.ts
  runtime/
    index.ts  hook-entrypoint.ts  serve.ts  probe.ts
  cli/
    index.ts  app.ts  sdk.ts   (sdk.ts = createConnectorCli for branded CLIs)
    commands/{detect,install,uninstall,upgrade,package,doctor,status,telemetry,
              usage,leaderboard,hook,serve,usage-event}.ts
```
