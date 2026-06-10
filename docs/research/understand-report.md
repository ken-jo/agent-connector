I now have the real adapter architecture (the `context_mode_adapter_architecture` field was null in the JSON, but I just read the actual code). I have everything needed to write a deeply grounded report. Writing it now.

# agent-connector — Design-Input Report

## 1. Executive Summary

**Problem.** The AI-agent tooling ecosystem has fractured into 15+ host platforms (Claude Code, Codex CLI, Cursor, OpenCode, Kilo, VS Code Copilot, Copilot CLI, Gemini CLI, Warp, Hermes, plus niche targets pi/openclaw/omp/zed/kiro/qwen/kimi/antigravity). Each one re-invents the same two integration surfaces — **MCP server registration** and **lifecycle hooks** — with mutually incompatible config files, key names, formats (JSON / JSONC / TOML / YAML / exported TS functions), transports, scopes, and event vocabularies. An MCP/hook developer who wants broad reach today must hand-author and maintain N config dialects, N hook adapters, and N install/uninstall flows, then chase each platform's quirks (Cursor's silent failure on a misspelled `mcpServers` root key; VS Code using `servers` not `mcpServers`; Codex using TOML `[mcp_servers.x]`; OpenCode using exported TS plugin functions instead of a hook table). This is exactly the cost context-mode already paid: it ships a 15-adapter layer (`src/adapters/`) precisely to hide this fragmentation for one server.

**Opportunity.** Generalize context-mode's *proven* per-platform adapter layer into a standalone framework so a developer **writes once** against a single declarative + programmatic API and agent-connector **detects installed platforms, translates, installs, syncs, and uninstalls** the MCP registration + hooks everywhere. The adapter contract, platform detection registry, cross-platform spawn/quoting helpers, normalized hook event model, and storage-root override in context-mode are all directly reusable as the framework's spine.

**Second pillar — telemetry.** No host today reports per-tool token attribution back to an MCP server (the MCP spec has no `usage` field on `CallToolResult`, and even `sampling/createMessage` returns no usage block). So agent-connector ships a **default, platform-independent, local-first per-MCP token-usage estimator**: it measures the *server's own bytes* (tool args in, tool result out, tool-definition schemas), tokenizes them with a bundled BPE tokenizer (heuristic fallback), and writes aggregate counts to local storage keyed by tool/session/project. Because it measures bytes the server controls, the number is identical regardless of host — delivering the "what does installing my server cost in context, everywhere" metric devs actually want, with zero network egress by default.

---

## 2. Platform Integration Matrix

| Platform | MCP config path & format | Transports | Scope levels | Hooks? (mechanism) | Plugin system | Native token usage exposed to server/hooks? | Confidence |
|---|---|---|---|---|---|---|---|
| **Claude Code** (Anthropic) | `.mcp.json` (project), `~/.claude.json` (user/local under `projects.<path>.mcpServers`), plugin `.mcp.json`, `managed-mcp.json`; **JSON**. Root key `mcpServers`. | stdio, http (streamable-http alias), sse (deprecated), ws | local > project > user > plugin > connectors (no field merge) | **Yes** — `hooks` object in `settings.json` (NOT `.mcp.json`). ~30 events (SessionStart, PreToolUse, PostToolUse, PreCompact, Stop, …). Handler types: command/http/mcp_tool/prompt/agent. stdin JSON, exit-code + JSON control. | Yes — first-class; installs from marketplaces to `~/.claude/plugins/cache/`; bundles MCP + hooks + skills. `${CLAUDE_PLUGIN_ROOT}` expansion. | **No.** Hook stdin has no token fields; servers get no usage. (Has `MAX_MCP_OUTPUT_TOKENS` output cap + `_meta["anthropic/maxResultSizeChars"]` — limits, not reporting.) | high |
| **Codex CLI** (OpenAI) | `~/.codex/config.toml` (user), `.codex/config.toml` (project, **trusted only**), `$CODEX_HOME/<profile>.config.toml`; **TOML**. `[mcp_servers.<id>]`. | stdio, streamable-http | user/global, project (trusted), profile, managed/MDM | **Yes** — `hooks.json` or inline `[hooks]` in config.toml. Events: SessionStart, PreToolUse, PostToolUse, PreCompact/PostCompact, UserPromptSubmit, Stop, … Layers **accumulate** (no override). Plus legacy `notify=[...]` (agent-turn-complete only). `commandWindows` for OS-specific cmd. | Yes (newer) — plugins bundle hooks via manifest/`hooks/hooks.json`; trust-review flow; sha256 trust hashes. | **No.** `notify` payload + hooks carry no token/usage fields. | high |
| **Cursor** (Anysphere) | `~/.cursor/mcp.json` (global), `.cursor/mcp.json` (project); **JSON**. Root key `mcpServers`. `${env:VAR}`/`${workspaceFolder}` interpolation. | stdio, http, sse (deprecated) | global (user), project | **Yes** (v1.7, Oct 2025) — `hooks.json` (`{version:1,hooks:{...}}`). Events: beforeShellExecution, before/afterMCPExecution, afterFileEdit, sessionStart/End, preToolUse/postToolUse, stop, … enterprise > team > project > user. stdio JSON both ways. | Yes — VS Code extension model via **Open VSX** (`.vsix`); plus Rules/Commands/Skills/Hooks; `vscode.cursor.mcp.registerServer()` API. | **No** to hooks/servers (hook input has model metadata, no token counts). User sees usage in dashboard/status bar. | high |
| **VS Code Copilot** (Microsoft/GitHub) | `.vscode/mcp.json` (workspace), user-profile mcp.json (via "MCP: Open User Configuration"), devcontainer.json; **JSONC**. Root key **`servers`** (not `mcpServers`) + sibling `inputs[]`. | stdio, http, sse | workspace, user profile, remote/devcontainer | **Yes** (Preview, ~v1.110, early 2026) — `{hooks:{PreToolUse:[{type:'command',...}]}}`. Discovered from `.github/hooks/*.json` **and Claude-compatible `.claude/settings.json` + `~/.claude/settings.json`**, `~/.copilot/hooks`, agent frontmatter, plugin hooks. `chat.hookFilesLocations` configurable. | Yes — classic extensions (Marketplace) + **Agent Plugins** (Preview, shared format with Copilot CLI; marketplace.json repos). | **No.** Hook input has `transcript_path`, no token metrics. | high |
| **GitHub Copilot CLI** (GitHub) | `~/.copilot/mcp-config.json` (user-global only); **JSON**. Root key `mcpServers`; stdio type written as **`local`** (`stdio` also accepted). `tools:["*"]`. | local/stdio, http, sse (deprecated) | user/global, org/enterprise (registry+allowlists) | **Yes** — `{version:1,hooks:{...}}` files. From `.github/hooks/*.json`, `~/.copilot/hooks/*.json`, settings. Event names accept **camelCase or PascalCase** (PascalCase = Claude/VS Code-compatible, portable). Types: command/http/prompt. preToolUse fail-closed. | Yes — **Agent Plugins** (same format as VS Code) + `.agent.md` custom agents. Built-in GitHub MCP server. | **No.** Hooks get session/tool context, no token usage. | high |
| **Gemini CLI** (Google) | `~/.gemini/settings.json` (user), `.gemini/settings.json` (project), `/etc/gemini-cli/settings.json` (system); **JSON**. `mcpServers` keyed; transport selected by key: `command`→stdio, `url`→SSE, `httpUrl`→Streamable HTTP. Separate `mcp` object for allow/exclude. | stdio, SSE, Streamable HTTP | system, user, project, extension | **Yes** — top-level `hooks` key in settings.json. Events: SessionStart/End, Before/AfterAgent, Before/AfterModel, BeforeToolSelection, Before/AfterTool, PreCompress, Notification. Only `type:'command'`. `$GEMINI_PROJECT_DIR`. `/hooks`, `/reload`. | Yes — **Extensions** (bundle MCP + `.toml` slash commands + hooks). | **YES (partial).** `AfterModel` hook payload carries `usageMetadata.totalTokenCount` (per-LLM-call). NOT in AfterAgent/SessionEnd. | high |
| **OpenCode** (SST) | `~/.config/opencode/opencode.json[c]` (global), `<root>/opencode.json[c]` (project); **JSON/JSONC**. Top-level `mcp` key; `type:"local"` (`command:[exe,...args]`, `environment` obj) vs `type:"remote"` (`url`). | local/stdio, remote (Streamable HTTP + SSE) | remote-defaults < global < custom(env) < project < `.opencode` < inline < managed | **Yes, but plugin-based** — JS/TS module **exports async fn returning a hooks object**. Local files in `.opencode/plugin(s)/` or npm pkgs in top-level `plugin:[...]` array. 25+ events: tool.execute.before/after, chat.message, session.*, etc. **No JSON hook table.** | Yes — first-class JS/TS plugin runtime ({project, client, $, directory, worktree}); npm plugins auto-installed via Bun. | **No** documented hook payload. Reachable in practice via SDK client message objects (usage data exists in data model). | high |
| **Kilo Code** (Kilo Org) | **Two generations.** Legacy: `.kilocode/mcp.json` + global `mcp_settings.json` (root `mcpServers`, scalar `command`+`args`+`env`). New: `~/.config/kilo/kilo.jsonc` + `.kilo/kilo.jsonc` (root `mcp`, `type` local/remote, `command:[]`, `environment`); **JSON/JSONC**. Project overrides global. | local/stdio, sse, streamable-http (legacy) / remote (new) | global, project | **No** programmatic lifecycle hooks. Only declarative Rules/Modes/Workflows (`.kilo/commands/*.md`)/Skills. Session-hooks are an open feature request. | **No** JS plugin runtime; extends only via MCP + declarative customization. | **YES to user/billing** (per-interaction tokensIn/Out/cache/cost in UI + dashboard) but **NOT** to MCP/hooks (no hooks exist). | medium |
| **Warp** (Warp.dev) | UI (Settings > Agents > MCP); files `~/.warp/.mcp.json` (global), `<root>/.warp/.mcp.json` (project); can auto-import Claude/Codex configs; **JSON**. Root `mcpServers`; stdio uses **`working_directory`** (not `cwd`). | stdio, SSE, Streamable HTTP | global, project (per-session approval), personal (Warp Drive) | **No** lifecycle hook system (open FR #7834). Config-edit approval gates only; Rules/Workflows/Cloud-Agent event triggers instead. | **No** general plugin SDK; MCP *is* the extensibility mechanism ("MCP servers act as plugins"). | **No.** Usage abstracted as "credits"; not exposed. | high |
| **Hermes Agent** (Nous Research) | `~/.hermes/config.yaml` (`mcp_servers` key); `cli-config.yaml` for shell hooks; **YAML**. stdio (`command`+`args`+`env`) / HTTP (`url`+`headers` or `auth:oauth`). `/reload-mcp` hot-reload. | stdio, Streamable HTTP (static headers or OAuth 2.1). No SSE. | user/global | **Yes** — (1) shell hooks in `cli-config.yaml` `hooks:` (scripts in `~/.hermes/agent-hooks/`, consent allowlist) or (2) Python `ctx.register_hook()`. Events: pre/post_tool_call, pre/post_llm_call, on_session_*, transform_* (rewrite results/output). | Yes — first-class Python plugins (`~/.hermes/plugins/`, `register(ctx)`); opt-in via `plugins.enabled`. Also `hermes mcp serve` (server mode). | **No.** post_llm_call payload has content/model/platform, **no** token/cost breakdown. | high |
| **JetBrains Copilot** (JetBrains) | `~/.config/JetBrains/…`; **JSON**. Root key **`servers`** (like VS Code). | stdio | user | **Yes** — `hooks.json` `type:'command'`; CLI pattern `context-mode hook jetbrains-copilot <name>`. PreToolUse/PostToolUse/PreCompact/SessionStart. | Cursor-style plugin structure adapted; discovery undocumented in installed files. | **No.** | high (from context-mode adapter) / medium (upstream docs) |
| **OpenClaw** (niche) | `~/.openclaw/config.json` or project `openclaw.json`; **JSON**. Structured: `plugins.entries`, `plugins.slots` (e.g. `contextEngine`), `mcp.servers`. | stdio | user, project | **No** traditional hooks; tool **`contracts`** in plugin manifest instead. | Rich plugin system: sandbox mode, permissions, contract-based tool exposure. | **No** (sandbox may track internally). | high (config), medium (behavior) |
| **Pi** (niche) | `~/.pi/context-mode/` cache only; no concrete MCP config files found. **Unknown** format. (context-mode pins storage to `~/.pi/` via PiAdapter; uses an MCP bridge + extension wrapper.) | none confirmed | user | **No** configs found. | None found (cache dirs only). | n/a | **low** |
| *(also in context-mode registry: antigravity, zed, kiro, qwen-code, kimi, omp)* | Per registry `sessionDirSegments`: `.gemini`, `.config/zed`, `.kiro`, `.qwen`, `.kimi-code`, `.omp`. | mostly stdio | user/project | varies (zed/antigravity ≈ MCP-only) | varies | mostly No | low–medium |

---

## 3. Common Abstraction Model

The union of platform behaviors collapses into a small set of cross-platform concepts. context-mode already validated most of these in `src/adapters/types.ts`.

### 3.1 Core concepts agent-connector must model

**(a) Server Definition (transport-polymorphic).** A normalized server descriptor:
```
ServerDef { id, transport: stdio|http|sse|ws,
            command?, args?[], env?{}, cwd?,        # stdio
            url?, headers?{}, auth?(oauth|bearerEnv),# remote
            tools?(include/exclude), timeoutMs?, enabled? }
```
Adapters render this into each dialect: stdio→`{command,args,env}` (Claude/Cursor/Codex) vs `command:[exe,...args]`+`environment` (OpenCode/Kilo-new) vs TOML table (Codex) vs YAML (Hermes) vs `working_directory` (Warp) vs `httpUrl` key (Gemini). **The root key itself is a per-adapter constant** (`mcpServers` | `servers` | `mcp` | `mcp_servers`).

**(b) Transport capability set.** Not all platforms support all transports (Hermes has no SSE; Claude has ws nobody else has). The model must let an adapter *reject or downgrade* a requested transport and report it (e.g. "platform X supports stdio only → http server skipped with warning").

**(c) Scope.** Normalize to an ordered enum `{ system, user/global, project, profile, managed }`. Each adapter maps the abstract scope to a concrete path and knows its **precedence** (Claude: local>project>user>plugin; Codex hooks *accumulate*; OpenCode merges many layers). Default install scope = `user/global`; `--scope project` opt-in.

**(d) Normalized hook/lifecycle events.** context-mode already proved the minimal portable set. Canonical events:
`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `Stop`, `SubagentStart/Stop`, `Notification`. Each maps to platform-specific names (`PreToolUse`↔`BeforeTool`↔`tool.execute.before`↔`preToolUse`↔`pre_tool_call`). Normalized event payloads (from context-mode): `{toolName, toolInput, toolOutput?, isError?, sessionId, projectDir?, raw}`. Normalized responses: `{decision: allow|deny|modify|context|ask, reason?, updatedInput?, additionalContext?, updatedOutput?}`.

**(e) Hook I/O paradigm (the deepest divergence).** context-mode names exactly three, and they are the right taxonomy:
- **`json-stdio`** — Claude Code, Codex, Cursor, VS Code Copilot, Copilot CLI, Gemini CLI, JetBrains. (stdin JSON → exit-code/stdout JSON.) Framework ships *one* universal hook entrypoint binary that reads the host's JSON, normalizes via the adapter's parser, runs the dev's handler, formats the response via the adapter's formatter.
- **`ts-plugin`** — OpenCode, Kilo (when hooks land), Hermes(Python variant), OpenClaw-contracts, Pi/OMP wrappers. Framework must *generate* an exported plugin module that imports the dev's handler.
- **`mcp-only`** — Warp, zed, antigravity, Kilo-today, Pi. No hook layer at all; only the MCP server is installed. Capability detection must surface "hooks unavailable here."

**(f) Capability detection & platform detection.** Two layers: (1) **install-time platform detection** (which hosts are installed on this machine — config-dir existence + known marker files) and (2) **runtime host detection** (which host is *executing* the hook right now — env-var markers, then config-dir, then MCP `clientInfo`). context-mode's `ADAPTER_REGISTRY` + `detect.ts` are a complete, battle-tested implementation of (2), including fork-before-parent ordering (cursor/antigravity before vscode) and the `installed_plugins.json` disambiguator for "Claude Code inside a VS Code terminal."

**(g) PlatformCapabilities flags** (already in context-mode): `preToolUse`, `postToolUse`, `preCompact`, `sessionStart`, `canModifyArgs`, `canModifyOutput`, `canInjectSessionContext`. The single-API layer queries these to decide what a given platform can honor and degrades gracefully.

### 3.2 Where platforms diverge irreconcilably → per-adapter escape hatches

- **Format**: JSON vs JSONC vs **TOML** (Codex) vs **YAML** (Hermes) vs **exported TS/Python functions** (OpenCode/Hermes) — no single serializer. Each adapter owns read/write.
- **Root key + field names**: `mcpServers`/`servers`/`mcp`/`mcp_servers`; `cwd` vs `working_directory`; `env` vs `environment` vs `env_vars` (Codex forward-by-name vs literal); `disabled:true` vs `enabled:false`; `command` scalar vs `command:[]` array. **Per-adapter constants, not config.**
- **Hook event vocabulary & semantics**: superset events exist on some platforms only (Gemini's `BeforeModel`, Hermes' `transform_*` rewriters, Claude's ~30 events). Expose advanced events behind an **adapter-specific extension block** (`platforms.<id>.extra`) the framework passes through verbatim.
- **Trust/approval gates**: Codex trusted_hash, Cursor enterprise OS-paths, Warp per-session approval, Hermes consent allowlist. Install can *write* config but may report "requires user approval to activate."
- **Token exposure**: only Gemini's `AfterModel` surfaces real usage — a per-adapter *host-native enricher*, never the core path.
- **Pi/OpenClaw oddities**: Pi needs an MCP bridge + extension wrapper; OpenClaw uses `contracts`/`slots`. These remain bespoke adapters with their own install logic.

The right shape: **a thin universal core + a fat per-adapter tail**, with an `extra`/passthrough escape hatch on every adapter so a dev can reach platform-exclusive features without the framework needing to model them.

---

## 4. What to Borrow vs. Generalize from context-mode's Adapter Layer

The `context_mode_adapter_architecture` field came back null in the research JSON, but the code is present and is the canonical proof-of-concept. Verified files: `src/adapters/{types,base,registry,detect,client-map}.ts` and 15 `src/adapters/<id>/` dirs.

### 4.1 Borrow almost verbatim (these *are* the framework spine)

1. **The `HookAdapter` interface** (`types.ts`) — the contract is already platform-agnostic: `parse*Input`/`format*Response` per event, `getSettingsPath/getConfigDir/getSessionDir/getMemoryDir`, `generateHookConfig`, `configureAllHooks`/`unconfigureHooks` (install/uninstall symmetry), `validateHooks`/`getHealthChecks`/`checkPluginRegistration` (doctor), `backupSettings`, `updatePluginRegistry`. This is essentially the agent-connector adapter SPI minus context-mode-specific naming.
2. **The single-source-of-truth `ADAPTER_REGISTRY`** (`registry.ts`) — `{id, sessionDirSegments, envVars, load(lazy)}` per platform, with **load-bearing order** (forks before parents) and a matrix test asserting every `src/adapters/<id>/` dir has an entry. This solved context-mode's "added platform #16, forgot to register it in 4 places → silent data leak (#473)." Generalize directly.
3. **Runtime platform detection** (`detect.ts`) — env-var tier → config-dir tier → fallback; the `installed_plugins.json` disambiguator (#539: Claude inside VS Code terminal); `EnvVarRole` split (`workspace` vs `identification`) with `detect:false` for consumer-set vars (#542); `foreignIdentificationEnv()` scrubbing when one host spawns a child under another (#561). All of this is generic platform-disambiguation logic.
4. **Cross-platform spawn/quoting helpers** (`base.ts`/`types.ts`): `buildNodeCommand`/`buildHookRuntimeCommand`/`parseNodeCommand` — fix real Windows bugs (#369 bare-node PATH failure, #372 MSYS path rewriting, #548 doubled-path when plugin root contains spaces, #738 Bun runtime swap). These are pure infrastructure; keep them.
5. **`BaseAdapter`** shared impl (`getSessionDir`, `getConfigDir`, `getMemoryDir`, `backupSettings`) with override points — the inheritance shape (home-rooted default + project-scoped overrides) is exactly right.
6. **Storage-root override pattern** (`resolveContextModeDataRoot`, #649): a single env var (`CONTEXT_MODE_DATA_DIR`) relocates framework-owned state **but never platform-native config** (settings.json/config.toml stay where the host's own tooling expects them). Generalize as `AGENT_CONNECTOR_DATA_DIR`. **Critical telemetry insight**: this same key is the cross-agent shared-DB mechanism — telemetry storage should key by data-root, not code location.
7. **Three-paradigm taxonomy** (`json-stdio` / `ts-plugin` / `mcp-only`) and `PlatformCapabilities` flags — directly reusable.
8. **Doctor/health-check pattern** — `getHealthChecks?()` thunks rendered by a generic doctor with no per-adapter wiring; `existsSync` probes instead of regex on hook commands (avoids #548 class). Keep.

### 4.2 Couplings that MUST be removed to generalize

1. **context-mode is the only payload.** Adapters hardcode `"context-mode"` as plugin id, `"context-mode/sessions"` storage segment, `context-mode hook <platform> <name>` CLI dispatch, `enabledPlugins["context-mode@context-mode"]`. **Generalize**: the *served package identity* (id, hook entrypoint command, plugin manifest name) becomes a **parameter** supplied by the dev's `agent-connector.config`, not a constant.
2. **One hook script set baked in.** context-mode ships its own hook `.mjs` scripts. The framework must instead **register the developer's handlers** and synthesize the entrypoint (json-stdio binary or ts-plugin module) per platform.
3. **Session/memory/instruction-file semantics are context-mode domain logic.** `getMemoryDir`, `getInstructionFiles` (CLAUDE.md/AGENTS.md/GEMINI.md), auto-memory scanning, FTS5 content store, `session_resume` snapshots, `bytes_avoided` accounting — **all context-mode application logic, not framework concern.** Strip from the adapter SPI; keep only config/hook registration + the *generic* storage-dir resolution.
4. **Single global SQLite schema** (`session_events`, `tool_calls`, content.db) is context-mode's analytics, not the framework's. agent-connector defines its **own minimal telemetry schema** (Section 6). The 4-bytes/token heuristic context-mode uses is fine as a *fallback* but is **not** the framework default (Section 6 upgrades to a real tokenizer).
5. **In-process plugin special-cases** (`IN_PROCESS_PLUGIN_PLATFORMS = {opencode, kilo}`, jsRuntime injection) are wired ad-hoc. Generalize into the `ts-plugin` paradigm with a declared runtime, rather than a hardcoded set.
6. **Pi bridge / OMP / openclaw bespoke logic** lives inside context-mode adapters. Keep these as opt-in "extended adapters" but don't let their idiosyncrasies leak into the core SPI.

**Net**: borrow the *adapter SPI, registry, detection, spawn helpers, doctor, storage-root override, paradigm taxonomy, capability flags* (≈ the entire mechanical layer); remove the *context-mode application identity and domain logic* (memory, FTS, session-resume, byte accounting) and replace them with developer-supplied parameters + a fresh telemetry core.

---

## 5. Single-API Design Sketch

### 5.1 Developer-facing declaration (write once)

A single config module — `agent-connector.config.ts` (TS for type-safety + programmatic handlers; JSON/YAML accepted for static-only servers):

```ts
import { defineConnector } from "agent-connector";

export default defineConnector({
  // ── Identity (replaces context-mode's hardcoded "context-mode") ──
  id: "acme-db",
  displayName: "Acme DB Tools",
  version: "1.0.0",

  // ── MCP server: declared ONCE, transport-polymorphic ──
  server: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@acme/db-mcp"],
    env: { ACME_DB_DSN: "${env:ACME_DB_DSN}" },   // universal ${env:VAR}; adapters re-render
    // For remote instead:
    // transport: "http", url: "${env:ACME_URL:-https://api.acme.com}/mcp",
    // headers: { Authorization: "Bearer ${env:ACME_KEY}" },
    tools: { include: ["*"] },
    timeoutMs: 30_000,
  },

  // ── Hooks: normalized events; framework synthesizes per-paradigm ──
  hooks: {
    PreToolUse: {
      matcher: "acme_query|acme_write",
      async handler(evt /* normalized */) {
        if (evt.toolName === "acme_write" && isProd(evt.toolInput))
          return { decision: "ask", reason: "Confirm production write" };
        return { decision: "allow" };
      },
    },
    SessionStart: {
      async handler() {
        return { decision: "context", additionalContext: "Acme DB schema v12 loaded." };
      },
    },
  },

  // ── Telemetry: ON by default; opt-out granular ──
  telemetry: {
    enabled: true,                  // AGENT_CONNECTOR_TELEMETRY=0 to kill globally
    modelFamilyHint: "auto",        // auto | openai | anthropic | generic
    measureToolDefs: true,          // fixed per-turn tool-schema overhead
    calibration: { anthropicCountTokens: false }, // opt-in network enricher
  },

  // ── Escape hatch for platform-exclusive features ──
  platforms: {
    "claude-code": { extra: { server: { alwaysLoad: true } } },
    codex:         { extra: { server: { startup_timeout_sec: 20 } } },
    // exclude where it makes no sense:
    warp:          { hooks: false },   // mcp-only host
  },

  // Optional restriction; default = all detected platforms
  targets: "auto",                  // or ["claude-code","cursor","codex"]
});
```

Key properties: **one server block, one hook map, one telemetry block.** Universal `${env:VAR}` / `${env:VAR:-default}` interpolation, re-rendered to each host's native syntax. Adapters that can't honor a feature (e.g. http on a stdio-only host, hooks on a `mcp-only` host) **skip + warn**, never crash.

### 5.2 CLI / commands

```
agent-connector detect            # list installed platforms + scope + capabilities (json-stdio/ts-plugin/mcp-only, hooks?, transports)
agent-connector install [--scope user|project] [--targets a,b] [--dry-run]
                                  # for each target: render server config into native file (mcpServers/servers/mcp/TOML/YAML),
                                  # synthesize hook entrypoint (binary for json-stdio, plugin module for ts-plugin),
                                  # back up settings first, set exec perms, register, report changes
agent-connector sync              # re-render after config edit / framework upgrade; idempotent; heals stale paths (cf. context-mode cache-heal)
agent-connector uninstall [--targets ...]
                                  # inverse: remove server entries + hook registrations from shared host configs
                                  # (uses adapter.unconfigureHooks — context-mode learned uninstall must be explicit, else host keeps loading)
agent-connector doctor            # per-platform health checks: config present? hook entrypoint exists? exec bit? plugin registered? transport supported?
agent-connector telemetry report [--by tool|session|project] [--since 7d] [--json]
agent-connector telemetry export --format csv|json [--out file]
```

Install algorithm (per detected target): `backupSettings()` → `renderServerConfig(serverDef, extra)` → `writeNative()` → if hooks & paradigm≠mcp-only: `synthesizeHookEntrypoint()` + `generateHookConfig()` + `writeHooks()` + `setHookPermissions()` → `updatePluginRegistry()` (where applicable) → return change list. Everything idempotent and reversible; `--dry-run` prints the diff without writing.

### 5.3 Concrete render examples (same input → N dialects)

For the `stdio` server above, agent-connector emits:
- **Claude Code** `~/.claude.json`/`.mcp.json`: `{"mcpServers":{"acme-db":{"type":"stdio","command":"npx","args":["-y","@acme/db-mcp"],"env":{"ACME_DB_DSN":"${ACME_DB_DSN}"}}}}`
- **VS Code Copilot** `.vscode/mcp.json`: `{"servers":{"acme-db":{"type":"stdio","command":"npx","args":[...]}},"inputs":[...]}` (root key `servers`)
- **Codex** `~/.codex/config.toml`: `[mcp_servers.acme-db]\ncommand="npx"\nargs=["-y","@acme/db-mcp"]\nenv={ACME_DB_DSN="..."}`
- **OpenCode** `opencode.json`: `{"mcp":{"acme-db":{"type":"local","command":["npx","-y","@acme/db-mcp"],"environment":{...}}}}`
- **Hermes** `~/.hermes/config.yaml`: `mcp_servers:\n  acme-db:\n    command: npx\n    args: [-y, @acme/db-mcp]`
- **Warp** `~/.warp/.mcp.json`: `{"mcpServers":{"acme-db":{"command":"npx","args":[...],"working_directory":"..."}}}` (no hooks — mcp-only)

The `PreToolUse` handler becomes a generated `json-stdio` binary for Claude/Cursor/Codex/Gemini/Copilot, and a generated `tool.execute.before` plugin module for OpenCode.

---

## 6. Telemetry Architecture

**Goal**: a *default*, *platform-independent*, *local-first* per-MCP token-usage estimate, because no host reports per-tool usage to the server (MCP `CallToolResult` has no `usage`; `sampling/createMessage` returns no usage block).

### 6.1 Measurement (default + fallback)

Measure the **server's own bytes** — the only data identical across every host:
1. **Intercept every `tools/call`** at the server boundary (a thin wrapper around the dev's MCP server, or an in-proc shim the framework injects).
2. **Serialize** the exact wire form: input = `params.arguments`; output = `CallToolResult.content[]` + `structuredContent`.
3. **Tokenize (default = real BPE)**: bundled WASM **tiktoken** — `o200k_base` for OpenAI/Codex-family, `cl100k_base` for older GPT; for Anthropic-family, use `o200k_base` as a *documented approximation* (Anthropic ships no offline Claude tokenizer). Model family auto-selected from `initialize.clientInfo` or `modelFamilyHint`.
4. **Fallback (heuristic)**: if the tokenizer can't load (edge runtime/arch) or family is unknown → `chars/4` with content-type multipliers (~3 chars/tok for code/dense JSON). **Label the value `heuristic`.** (This is context-mode's 4-bytes/token method, demoted from default to fallback.)
5. **Non-text blocks** (image/audio/PDF/embedded resource): per-modality formulas (tile-based for images), **never tokenize the base64 blob.**
6. **Tool-definition overhead**: tokenize `tools/list` schemas once → the fixed per-turn "cost of just defining my tools" metric devs explicitly want.
7. **Confidence/source tag** on every record: `tokenizer-exact | tokenizer-approx | heuristic | host-native`.

**Opt-in enrichers** (never the hot path): (a) Anthropic `count_tokens` API as a *periodic calibration sampler* (RPM-limited, sends content off-box → opt-in only); (b) host-native usage where it exists — **Gemini's `AfterModel.usageMetadata.totalTokenCount`** is the one real signal today; opportunistically read any future `result._meta` usage field.

### 6.2 Attribution

Per record: `tool_name`, `input_tokens`, `output_tokens`, `session_id`, `project_dir`, `host_platform` (from runtime detection), `confidence_source`, `ts`. Tool-def overhead attributed once per session (`scope='tool_defs'`). Distinguish JSON-RPC protocol errors (no tokens produced) from `isError:true` tool errors (tokens were produced). Borrow context-mode's per-event attribution fields (`project_dir`, `attribution_source`, `attribution_confidence`).

### 6.3 Storage (local-first)

Local SQLite at `${AGENT_CONNECTOR_DATA_DIR:-<platform-dir>}/agent-connector/telemetry.db`. **Storage keyed by data-root, not code location** (the cross-agent shared-DB mechanism). **Aggregate counts only — never raw args/results/content.** Minimal schema:

```sql
-- one row per tool call (aggregate counts, no content)
tool_events(
  id, ts, server_id, tool_name, scope,            -- scope: 'call' | 'tool_defs'
  host_platform, session_id, project_dir,
  input_tokens INT, output_tokens INT,
  confidence_source TEXT,                          -- tokenizer-exact|approx|heuristic|host-native
  is_error INT
);
-- rollup for fast reports (per server/tool/session/project)
tool_rollup(server_id, tool_name, session_id, project_dir,
            calls INT, input_tokens INT, output_tokens INT,
            total_tokens INT, last_ts);
```

### 6.4 Surfacing

`agent-connector telemetry report` →
- **Ranked per-tool breakdown** (which of MY tools cost the most context),
- **Total context footprint** of the server over a period,
- **Tool-definition overhead** (separate line, paid every turn),
- **Input vs output split** + **calls** + **tokens/call avg** (find verbose tools),
- **Per-session / per-project rollups**,
- a visible **confidence label** (so heuristic ≠ exact is never implied).
Plus `--json` and `telemetry export --format csv|json`.

### 6.5 Privacy posture & opt-out

- **Aggregate counts only**; raw content never stored or transmitted.
- **Local-first**; zero network egress unless dev explicitly opts into an enricher/upload.
- The Anthropic `count_tokens` calibration ships content off-box → **opt-in, documented, sampled, ZDR-respecting**.
- Per-call estimation runs **in-process** with the local tokenizer (default path never crosses the server boundary).
- **Granular kill switches**: `AGENT_CONNECTOR_TELEMETRY=0` (global), plus per-layer opt-out (measurement / calibration / upload) via env + config — consistent with OMC kill-switch conventions (`DISABLE_*`).
- Aggregation keys (session id, project path) are themselves identifying → support hashing/anonymizing before any optional upload.
- Dashboards state explicitly: numbers are **estimates from the server's own I/O**, not the host's billed usage.

---

## 7. Risks, Unknowns, and Open Questions

**Low-confidence findings needing verification:**
1. **Pi** (low confidence) — only cache dirs found; no concrete MCP config format. context-mode pins Pi via an MCP bridge + extension wrapper (`pi/mcp-bridge.ts`, `pi/extension.ts`). **Verify** Pi's real registration mechanism before claiming Pi support; likely needs a bespoke adapter or deferral.
2. **Kilo** (medium) — **two config generations** (legacy `.kilocode/mcp.json` `mcpServers` vs new `kilo.jsonc` `mcp`). Must detect installed generation at runtime; issue #7079 shows MCP servers can get auto-written to the wrong file. Hooks don't exist yet (open FR) → treat as `mcp-only` today.
3. **OpenClaw** (high config / medium behavior) — `contracts`/`slots` model is unusual; sandbox permissions may interfere. Verify how an externally-declared MCP server interacts with `plugins.slots`.
4. **JetBrains Copilot** — high confidence from context-mode's adapter, but upstream-doc confidence is lower; the plugin discovery mechanism is undocumented in installed files.
5. **VS Code Copilot & Copilot CLI hooks/Agent Plugins are Preview (early 2026)** — format may shift; both deliberately read `.claude/settings.json`, which is both an opportunity (reuse Claude hook files) and a footgun (double-firing if Claude is also installed).

**Architectural risks:**
6. **TS/Python plugin synthesis** (OpenCode/Hermes) is materially harder than writing JSON — the framework must generate, install (Bun/npm/pip), and version a code module, not just a config file. Highest-effort adapter class.
7. **Telemetry interception point.** Measuring the server's bytes requires wrapping the dev's MCP server. Clean for servers the framework launches; harder if the dev ships a pre-built binary. Open question: ship an MCP **proxy/gateway** shim vs an in-proc SDK middleware vs both.
8. **Anthropic tokenizer approximation drift** — `o200k_base` for Claude is "within a few percent for prose, more for code." Must be labeled `tokenizer-approx`, and calibration offered.
9. **Trust/approval gates** (Codex hashes, Cursor enterprise OS-paths, Warp per-session, Hermes consent) mean *install ≠ active*. The CLI must report "written, pending host approval" honestly.
10. **Windows correctness** — context-mode hit real bugs (#369/#372/#548/#738); the spawn-command helpers are mandatory, not optional. Native-Windows, no POSIX-only assumptions, no symlink installs.
11. **Idempotency & conflict** — re-install must not duplicate entries; uninstall must fully remove (context-mode learned `unconfigureHooks` is required or hosts keep loading the server). Field-merge semantics differ per host (Claude doesn't merge; OpenCode merges layers).

**Open questions for architecture phase:** Should telemetry be a separable package (usable without the connector)? Should the dev write handlers in TS only, or also Python (for Hermes parity)? Where does the hook entrypoint binary live per host, and how is it versioned across host auto-updates (cf. context-mode's cache-heal)? Single shared telemetry DB across all hosts on a machine (via data-root) vs per-host?

---

## 8. Recommended MVP Scope and Phasing

**Guiding principle**: ship the *spine* (adapter SPI + registry + detection + render/install + telemetry core) against the **highest-leverage, best-documented, structurally diverse** platforms first, proving the abstraction handles real divergence before scaling to 15.

### Phase 0 — Core spine (no platforms yet)
- Lift & de-couple from context-mode: `HookAdapter` SPI, `ADAPTER_REGISTRY` shape, `detect.ts`, spawn/quoting helpers, `BaseAdapter`, storage-root override (`AGENT_CONNECTOR_DATA_DIR`), paradigm taxonomy, capability flags, doctor harness. Strip context-mode identity/domain logic.
- `defineConnector` config schema + universal `${env:...}` interpolation + render pipeline interface.
- CLI skeleton: `detect`, `install --dry-run`, `uninstall`, `doctor`.

### Phase 1 — MVP: 3 platforms + telemetry core
Pick three that are **(a) widely used, (b) well-documented (high confidence), (c) maximally divergent** so the abstraction is stress-tested:
1. **Claude Code** — JSON, `mcpServers`, richest hooks, plugin system (the reference; context-mode's primary).
2. **Codex CLI** — **TOML** + `env`/`env_vars` split + trust gates (proves non-JSON format + accumulating hooks).
3. **Cursor** — JSON but `${env:}` interpolation + `hooks.json` v1 + silent-fail root-key footgun (proves a second json-stdio dialect + a distinct hook file).

Plus the **telemetry core**: tools/call interception, WASM tiktoken default + chars/4 fallback, local SQLite (data-root keyed), `telemetry report`/`export`, granular opt-out. This trio already spans JSON+TOML, three hook dialects, env-var detection, and the json-stdio paradigm end-to-end.

### Phase 2 — Breadth on json-stdio + first remote/format variety
Add **VS Code Copilot** (`servers` key, JSONC, reads `.claude/settings.json`), **GitHub Copilot CLI** (portable PascalCase hooks, shared Agent Plugin format), **Gemini CLI** (3-transport-key selection + the *one* host-native token signal via `AfterModel` → wire the host-native enricher), and **Warp** (`mcp-only`, `working_directory` — proves graceful hook-absence + no-plugin path). Validates the `mcp-only` paradigm and the host-native telemetry enricher.

### Phase 3 — ts-plugin paradigm
Add **OpenCode** (and **Kilo** as its fork/new-config sibling) — generate/install/version an exported TS plugin module via Bun; and **Hermes** (YAML + shell-hook *and* Python-plugin variants). Highest-effort adapters; do after json-stdio is rock-solid.

### Phase 4 — Niche / verification-required
**JetBrains Copilot**, then the low-confidence set behind verification: **Pi** (bridge mechanism), **OpenClaw** (`contracts`/`slots`), **zed/antigravity/kiro/qwen/kimi/omp** (mostly mcp-only). Each gated on a source-confirmed config format.

**Sequencing rationale**: Phases 1–2 deliver the value (10 of the most-used hosts on the json-stdio + mcp-only path + telemetry) on the well-documented platforms; Phase 3 absorbs the genuinely hard `ts-plugin` synthesis once the core is proven; Phase 4 is verification-gated long tail. Telemetry ships in Phase 1 because it is platform-independent by design and shouldn't wait on adapter breadth.

---

**Relevant source files (context-mode proof-of-concept to generalize):** `/home/ubuntu/workspace/github/context-mode/src/adapters/types.ts` (HookAdapter SPI, paradigm taxonomy, capability flags, spawn helpers), `/home/ubuntu/workspace/github/context-mode/src/adapters/base.ts` (BaseAdapter + `resolveContextModeDataRoot` storage-root override), `/home/ubuntu/workspace/github/context-mode/src/adapters/registry.ts` (single-source-of-truth ADAPTER_REGISTRY), `/home/ubuntu/workspace/github/context-mode/src/adapters/detect.ts` (runtime platform detection + disambiguators), and the 15 `/home/ubuntu/workspace/github/context-mode/src/adapters/<id>/` directories (per-platform config/hooks renderers).