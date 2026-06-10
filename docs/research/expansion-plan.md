I now have the existing conventions: `PlatformId` enum, `HookParadigm` = json-stdio|ts-plugin|mcp-only, the mcp-only reference (warp uses `working_directory`; kilo uses `mcp` root key + array command), and the ts-plugin reference (opencode synthesizes a bridge module shelling out to the home binary). I have enough to write a precise, codebase-grounded plan.

```markdown
# agentconnect — Platform Expansion Plan (9 → 26, tokscale parity)

Grounded in the existing SPI (`src/adapters/spi.ts`), `BaseAdapter` (JSON helpers, TOML/YAML override the JSON helpers entirely), `HookParadigm = "json-stdio" | "ts-plugin" | "mcp-only"`, and the registry (`ADAPTER_REGISTRY`, one entry + lazy `load()` per platform). Reference adapters to mirror: **claude-code** (json-stdio), **cursor/warp/kilo** (mcp-only + Cline-style JSON), **opencode** (ts-plugin synthesized bridge). agentconnect deploys MCP + hooks, so **MCP support is the hard gate for a deploy target**; no-MCP tools are telemetry-only and excluded from this build.

## 1. Platform Matrix (17 gap platforms)

| Platform | suggestedId | MCP? | paradigm | config path (user → project) + root key + format | hooks? | confidence |
|---|---|---|---|---|---|---|
| Qwen CLI | `qwen-code` | yes | json-stdio | `~/.qwen/settings.json` → `<proj>/.qwen/settings.json`; MCP `mcpServers`, hooks sibling `hooks` key (same file); JSONC | yes (5 wired) | high |
| Kiro | `kiro` | yes | json-stdio | MCP `~/.kiro/settings/mcp.json` → `<proj>/.kiro/settings/mcp.json` (`mcpServers`); hooks in `~/.kiro/agents/kiro_default.json` (`hooks` key); JSONC | yes (exit-code) | high |
| JetBrains Copilot | `jetbrains-copilot` | yes | json-stdio | MCP `servers` (IDE-UI mcp.json, not inspectable); hooks `<proj>/.github/hooks/context-mode.json` (`version:1`+flat); JSON | yes (matchers ignored) | high |
| Kimi CLI | `kimi` | yes | json-stdio | MCP `~/.kimi/mcp.json` (`mcpServers`, JSON); hooks `~/.kimi/config.toml` (`[[hooks]]`, TOML); honor `$KIMI_CODE_HOME` | yes (deny-only) | medium |
| Crush | `crush` | yes | json-stdio | `~/.config/crush/crush.json` / `%LOCALAPPDATA%\crush\crush.json` → `.crush.json`/`crush.json`; root `mcp`; hooks top-level `hooks`; JSON | yes (PreToolUse only) | high |
| OMP (Oh My Pi) | `omp` | yes | ts-plugin | `~/.omp/agent/mcp.json` → `<proj>/.omp/mcp.json`; `mcpServers`; JSON. Has native MCP so plugin is hook-only | yes (in-proc `pi.on`) | high |
| OpenClaw | `openclaw` | yes | ts-plugin | `~/.openclaw/openclaw.json`; MCP under `mcp.servers` (nested), plugin under `plugins.entries`; JSON5/JSONC | yes (TS plugin) | high |
| Kilo CLI | `kilo-cli` | yes | ts-plugin | `~/.config/kilo/kilo.jsonc` → `.kilo/kilo.jsonc`; root `mcp`; plugins in `plugin/` dirs; JSONC | yes (TS `event` bus) | high |
| Amp | `amp` | yes | mcp-only* | `~/.config/amp/settings.json` → `.amp/settings.json`; dotted key `amp.mcpServers`; JSONC | no host hooks | high |
| Codebuff | `codebuff` | yes | mcp-only* | `.agents/mcp.json` → `~/.agents/mcp.json`; `mcpServers`; JSON | no host hooks | high |
| Droid | `droid` | yes | mcp-only | `~/.factory/mcp.json` → `<proj>/.factory/mcp.json`; `mcpServers`; JSON | no | high |
| Mux | `mux` | yes | mcp-only | `~/.mux/mcp.jsonc` → `./.mux/mcp.jsonc`; root `servers`; **value = command STRING**; JSONC | no | high |
| Roo Code | `roo-code` | yes | mcp-only | globalStorage `…/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json` → `<proj>/.roo/mcp.json`; `mcpServers`; JSON | no | high |
| Trae | `trae` | yes | mcp-only | `~/.trae/mcp.json` (→ `.trae/mcp.json` beta); `mcpServers`; JSON | no | medium |
| Zed | `zed` | yes | mcp-only | `~/.config/zed/settings.json` (Win `%LOCALAPPDATA%\Zed`); root `context_servers`; **flat command string**; JSONC | no | high |
| Antigravity | `antigravity` | yes | mcp-only | `~/.gemini/antigravity/mcp_config.json` (probe 3 paths) → `<ws>/.agents/mcp_config.json`; `mcpServers`; JSONC | no | high |
| Hermes | `hermes` | yes | json-stdio (YAML) | `~/.hermes/config.yaml`; MCP `mcp_servers`, hooks `hooks`; **YAML** | yes (shell hooks) | high |
| Goose | `goose` | yes | json-stdio (YAML) | `~/.config/goose/config.yaml` (Win `%APPDATA%\Block\goose\config\config.yaml`); root `extensions`; **YAML**; hooks via `.agents/plugins/*/hooks/hooks.json` (JSON) | yes (Open Plugins) | high |
| Pi | `pi` | **no** | — | — (no native MCP, no mcp.json) | — | high |

\*Amp/Codebuff have a TS-plugin extension model but **no host lifecycle hooks reaching our bridge**; for agentconnect they are effectively mcp-only deploy targets (declare hook capabilities false).

## 2. Build Groups (one-by-one, by paradigm × difficulty)

### Group A — mcp-only, standard `mcpServers` JSON (EASIEST; mirror `cursor`/`warp`)
Pure `installServer` + `mcpServers` upsert via `BaseAdapter.upsertServerInJson`. `installHooks` returns one `"skip"`. Capabilities all false. No `parseEvent`/`formatReply`/`synthesizePlugin`.
- `droid` — `~/.factory/mcp.json`, `mcpServers`, JSON, `${VAR}` expansion. Cleanest of all.
- `roo-code` — `mcpServers`, JSON; resolve VS Code flavor for globalStorage user path; project `.roo/mcp.json`.
- `trae` — `~/.trae/mcp.json`, `mcpServers`, JSON (write object-keyed form). Confidence medium → verify path on target.
- `antigravity` — `mcpServers`, JSONC; **probe 3 user paths**, prefer existing, default-write `~/.gemini/antigravity/mcp_config.json`. Pair with `GEMINI.md` instruction file.

### Group B — mcp-only, NON-standard root key / value shape (EASY; mirror `warp`/`kilo` quirks)
Same as A but override the server-entry render. These already have precedent in-repo (warp `working_directory`, kilo `command:[...]` array).
- `zed` — root `context_servers`, **flat command string** (nested object silently dropped). Win path `%LOCALAPPDATA%\Zed`.
- `amp` — **dotted key** `amp.mcpServers` (not nested; one flat settings key). `${VAR_NAME}` interpolation. Pair with `AGENTS.md`.
- `codebuff` — `mcpServers`, JSON; stdio entry uses `type:"stdio"` default; merge chain project→parent→global; `$VAR` interpolation.
- `mux` — root `servers`, **value is a single shell-command STRING** (emit `"<cmd> <args...>"`), not an object. stdio-only.

### Group C — json-stdio JSON adapters (MEDIUM; mirror `claude-code`, full `parseEvent`/`formatReply`)
Real hook dispatch through the universal `<homeBin> hook <id> <event>` entrypoint + native wire parse/format.
- `qwen-code` — Claude-wire-compatible (hook scripts reusable). MCP `mcpServers` + sibling `hooks` key in `~/.qwen/settings.json`. Use **native Qwen tool names** in matchers. Full capabilities true.
- `kiro` — two surfaces: MCP `mcp.json` (`mcpServers`), hooks in **agent file** `kiro_default.json` under `hooks`. **Exit-code protocol** (0 allow / 2 block, agentSpawn returns `hookSpecificOutput.additionalContext`); cannot modify args → `canModifyArgs:false`.
- `jetbrains-copilot` — shares Copilot hook schema with existing `vscode-copilot`: subclass that base. Hooks `.github/hooks/context-mode.json` with mandatory `version:1`, **flat `{type,command}`**, matchers ignored (all fire). MCP `servers` key is IDE-UI-only → `doctor` WARN, not write.
- `kimi` — MCP JSON (`mcpServers` in `~/.kimi/mcp.json`) but **hooks in TOML** `config.toml` `[[hooks]]` → needs a TOML writer for the hook file only (MCP stays JSON). PreToolUse **deny-only**; `canModifyArgs/Output/InjectContext:false`. Honor `$KIMI_CODE_HOME`. Confidence medium (.kimi vs .kimi-code).
- `crush` — root `mcp` (not mcpServers), JSON; hooks top-level `hooks`, **PreToolUse only**, stdout JSON `{decision}`. `$(...)` runs at load (security note in render).

### Group D — ts-plugin adapters (HARD; mirror `opencode` synthesized bridge)
`synthesizePlugin` writes a self-contained module that shells out to `<homeBin> hook <id> <event> --connector <id>`. Do **not** import connector code into host runtime.
- `kilo-cli` — closest to opencode (OpenCode fork). MCP root `mcp` (array `command`, `enabled`), JSONC. Plugin = `@kilocode/plugin` default `{id,server}` returning Hooks; subscribe via the `event` bus (tool.execute.before/after, session events). Auto-discovered from `plugin/` dirs → just write the file. **strongest token observability** (usage on `message.updated`).
- `omp` — native MCP (`mcpServers` in `~/.omp/agent/mcp.json`) so write a **real mcp.json** AND a hook-only plugin. Plugin uses in-proc `pi.on(session_start/tool_call/tool_result/session_before_compact)`; loader reads `package.json` `omp||pi` field. `PI_CODING_AGENT_DIR` repoints agent dir. Distinct storage root from Pi (`~/.omp` vs `~/.pi`).
- `openclaw` — hardest. Plugin must appear in **BOTH** `plugins.entries` (loads plugin) **AND** `mcp.servers` (nested under `mcp`, surfaces tools) or zero tools reach the agent — doctor must FAIL entries-only. JSON5/JSONC (parse tolerantly, never strict `JSON.parse`). Plugin `register(api)` uses `api.registerHook`/`api.on`/`api.registerContextEngine`. Gateway reloads on SIGUSR1.

### Group E — non-JSON format (MEDIUM-HARD; new YAML writer; `BaseAdapter` JSON helpers don't apply)
`BaseAdapter` notes TOML/YAML adapters override the JSON helpers entirely → add a shared YAML read/merge/write util first.
- `goose` — YAML `config.yaml`, root `extensions`; stdio uses `type:stdio`, **`cmd` (not command)**, `args[]`, `envs{}`, `timeout`, `enabled`. Hooks are **separate**: Open-Plugins `hooks.json` (JSON) under `.agents/plugins/<name>/hooks/`. So: YAML for MCP, JSON for hooks.
- `hermes` — YAML `~/.hermes/config.yaml`, root `mcp_servers` (snake_case); shell hooks under `hooks` key (matcher/command/timeout, JSON-on-stdin). Single user-scope file. (Python plugins ignored — shell-hook path is sufficient.)

### Group F — DEFER / EXCLUDE
- **`pi` — EXCLUDE (no native MCP, no JSON-stdio hooks).** agentconnect deploys an MCP server + hook config; Pi exposes neither a writable mcp.json nor a JSON-stdio hook table — the only integration is copying a bespoke TS extension that itself spawns an MCP bridge child, which is out of scope for a config-deploy framework. **Future telemetry-only target**: Pi's `before_provider_response` exposes `usage`/`tokens`, so a tokscale-style reader could ingest its session DB without agentconnect deploying anything.
- **Path-confidence holds (build, don't defer):** `trae` and `kimi` are medium-confidence on *paths only* (root keys/format confirmed) — ship with runtime path-probing + `$KIMI_CODE_HOME`/path-verify, not deferred.
- **Note on Amp/Codebuff/Kilo-CLI/OpenClaw token telemetry:** none expose a host token-usage hook; telemetry comes from the deployed MCP server's own session logs — consistent with the rest of the fleet and not a blocker for the deploy target.

## 3. One-line implementer spec per buildable platform

- **droid** — id `droid`; `~/.factory/mcp.json` (user) / `<proj>/.factory/mcp.json`; root `mcpServers`; stdio `{type:"stdio",command,args,env,disabled}`; mcp-only.
- **roo-code** — id `roo-code`; `<flavor>/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json` / `<proj>/.roo/mcp.json`; root `mcpServers`; stdio `{command,args,env,disabled,alwaysAllow,timeout}`; mcp-only.
- **trae** — id `trae`; `~/.trae/mcp.json` / `.trae/mcp.json`; root `mcpServers`; stdio `{command,args,env}` (object-keyed); mcp-only.
- **antigravity** — id `antigravity`; probe `~/.gemini/{antigravity,config,antigravity-cli}/mcp_config.json`, default first / `<ws>/.agents/mcp_config.json`; root `mcpServers`; stdio `{command,args,env}`; mcp-only + `GEMINI.md`.
- **zed** — id `zed`; `~/.config/zed/settings.json` (Win `%LOCALAPPDATA%\Zed\settings.json`); root `context_servers`; **flat** `{command:"<exe>"}`; mcp-only + `AGENTS.md`.
- **amp** — id `amp`; `~/.config/amp/settings.json` / `.amp/settings.json`; **dotted key** `amp.mcpServers`; stdio `{command,args,env}` `${VAR}`; mcp-only + `AGENTS.md`.
- **codebuff** — id `codebuff`; `.agents/mcp.json` / `~/.agents/mcp.json`; root `mcpServers`; stdio `{type:"stdio",command,args,env}` `$VAR`; mcp-only.
- **mux** — id `mux`; `~/.mux/mcp.jsonc` / `./.mux/mcp.jsonc`; root `servers`; **value = command string** `"<exe> <args...>"`; mcp-only.
- **qwen-code** — id `qwen-code`; `~/.qwen/settings.json` / `<proj>/.qwen/settings.json`; MCP `mcpServers` + sibling `hooks`; stdio `{command,args,env}`; json-stdio, Claude-wire, native tool-name matchers, full caps.
- **kiro** — id `kiro`; MCP `~/.kiro/settings/mcp.json` / `<proj>/.kiro/settings/mcp.json` (`mcpServers`); hooks `~/.kiro/agents/kiro_default.json` (`hooks`); stdio `{command,args,env}`; json-stdio, **exit-code (0/2)**, `canModifyArgs:false`.
- **jetbrains-copilot** — id `jetbrains-copilot`; subclass Copilot base; MCP `servers` (IDE-UI, doctor WARN); hooks `<proj>/.github/hooks/context-mode.json` `version:1` flat `{type,command}`; json-stdio, matchers ignored.
- **kimi** — id `kimi`; MCP `~/.kimi/mcp.json` (`mcpServers`, JSON) / hooks `~/.kimi/config.toml` `[[hooks]]` (TOML); honor `$KIMI_CODE_HOME`; json-stdio, **deny-only**, mutate caps false.
- **crush** — id `crush`; `~/.config/crush/crush.json` (Win `%LOCALAPPDATA%\crush`) / `.crush.json`|`crush.json`; root `mcp`; hooks top-level `hooks` (**PreToolUse only**); stdio `{type:"stdio",command,args,env,timeout,disabled}`; json-stdio.
- **kilo-cli** — id `kilo-cli`; `~/.config/kilo/kilo.jsonc` / `.kilo/kilo.jsonc`; root `mcp`; stdio `{type:"local",command:[exe,...args],enabled,environment}` `{env:VAR}`; ts-plugin, write file into `plugin/` dir, subscribe `event` bus.
- **omp** — id `omp`; MCP `~/.omp/agent/mcp.json` / `<proj>/.omp/mcp.json` (`mcpServers`, real file); stdio `{command,args,env}`; ts-plugin (hook-only) via `pi.on`, plugin pkg field `omp||pi`; `PI_CODING_AGENT_DIR` override.
- **openclaw** — id `openclaw`; `~/.openclaw/openclaw.json` (JSON5, tolerant parse); MCP **nested** `mcp.servers.<name>={command,args,transport?}` + plugin in `plugins.entries`; ts-plugin (BOTH required); SIGUSR1 reload.
- **goose** — id `goose`; `~/.config/goose/config.yaml` (Win `%APPDATA%\Block\goose\config\config.yaml`); root `extensions`; stdio `{type:stdio,cmd,args,envs,timeout,enabled}` **YAML**; hooks `.agents/plugins/<name>/hooks/hooks.json` **JSON**; json-stdio.
- **hermes** — id `hermes`; `~/.hermes/config.yaml`; root `mcp_servers`; stdio `{command,args,env}` **YAML**; hooks under `hooks` key (matcher/command/timeout, JSON-stdin); json-stdio.

## 4. Recommended build order (easiest + highest-confidence first)

1. **droid** (high) — purest `mcpServers` JSON; validates the add-a-platform path end-to-end with zero quirks.
2. **roo-code** (high) — standard `mcpServers`, adds VS-Code-flavor path resolver (reused later).
3. **antigravity** (high) — `mcpServers` + multi-path probe + instruction file.
4. **codebuff** (high) — `mcpServers` + merge-chain + `$VAR`.
5. **zed** (high) — first non-standard shape: `context_servers` flat string.
6. **amp** (high) — dotted-key `amp.mcpServers`.
7. **mux** (high) — command-string value (most exotic mcp-only render).
8. **trae** (medium-path) — `mcpServers` with runtime path verify.
9. **qwen-code** (high) — first new json-stdio host; Claude-wire-compatible, lowest hook risk.
10. **crush** (high) — `mcp` root + single-event hooks.
11. **jetbrains-copilot** (high) — reuses `vscode-copilot` Copilot base; mostly subclass.
12. **kiro** (high) — exit-code hook protocol + split MCP/agent-file surfaces.
13. **kimi** (medium) — first TOML hook writer; deny-only.
14. **goose** (high) — first YAML adapter (build shared YAML util here).
15. **hermes** (high) — second YAML adapter, reuses the util; single-scope shell hooks.
16. **kilo-cli** (high) — first new ts-plugin (closest to opencode reference).
17. **omp** (high) — ts-plugin hook-only + native mcp.json.
18. **openclaw** (high) — hardest: dual-registration (plugins.entries + mcp.servers), JSON5, nested key.

**Net:** 17 buildable → **9 + 17 = 26 platforms** (tokscale parity). Excluded: **pi** (no MCP / no JSON-stdio hooks; future telemetry-only).