I now have complete verification of all flagged adapters against the actual source code. I have confirmed every correction in the observation set against the live code. I have all the evidence needed to produce the decisive report.

# AgentConnect Coverage Verification — Confirmed-Grade Report

This report cross-checks every platform observation (live install or source-confirmed) against the **actual adapter source** in `/home/ubuntu/workspace/github/agentconnect/src/adapters/`. Every "matches-adapter?" verdict below was re-derived by reading the adapter file, not taken on faith from the observation set.

---

## 1. Confirmed-Grade Matrix

| Platform | Paradigm (confirmed) | Config path + root key | Grade | Matches adapter? |
|---|---|---|---|---|
| **qwen-code** | json-stdio | `~/.qwen/settings.json` · `mcpServers` (+ sibling `hooks`) | live | ❌ — `canModifyOutput`/`updatedMCPToolOutput` overclaim |
| **kimi** | json-stdio (mcp.json) + toml (config.toml) | `~/.kimi-code/mcp.json` · `mcpServers`; hooks `~/.kimi-code/config.toml` | live | ⚠️ functionally correct; under-declares caps + `hasPlugins` |
| **amp** | mcp-only | `~/.config/amp/settings.json` · `amp.mcpServers` | live | ✅ |
| **codebuff** | mcp-only | `~/.agents/mcp.json` · `mcpServers` | live | ✅ |
| **openclaw** | ts-plugin | `~/.openclaw/openclaw.json` · `mcp.servers` + `plugins.entries` | live | ❌ — `plugins.entries.<id>.module` is rejected by validate |
| **goose** | json-stdio (YAML mcp) | `~/.config/goose/config.yaml` · `extensions` | live | ❌ — hooks shape/path, deny field, stdin field all wrong |
| **crush** | json-stdio | `~/.config/crush/crush.json` · `mcp` | live | ✅ |
| **droid** | json-stdio (hooks) | `~/.factory/mcp.json` · `mcpServers`; hooks `~/.factory/hooks.json` | live | ❌ — adapter is mcp-only; misses entire hooks system |
| **mux** | mcp-only | `~/.mux/mcp.jsonc` · `servers` | live | ✅ (string form valid) |
| **hermes** | json-stdio | `~/.hermes/config.yaml` · `mcp_servers` | source | ✅ |
| **omp** | ts-plugin | `~/.omp/agent/mcp.json` · `mcpServers` | live | ✅ |
| **pi** | mcp-only (skills surface) | `~/.pi/skills/` (no writable MCP config) | source | ✅ |
| **kilo-cli** | **ts-plugin** (OpenCode fork) | `~/.config/kilo/kilo.jsonc` · `mcp` (+ `plugin` array) | live (parent fork = Kilo CLI binary) | ❌ — **declared mcp-only; must become ts-plugin (P0)** |
| **kilo** (VS Code ext) | mcp-only | **`~/.config/kilo/kilo.json` · `mcp`** (NOT globalStorage/`mcpServers`) | source (vsix 7.3.28) | ❌ — wrong path + wrong root key + wrong entry shape |
| **roo-code** | mcp-only | `<globalStorage>/…/settings/mcp_settings.json` · `mcpServers` | source (vsix 3.54.0) | ❌ — filename is `cline_mcp_settings.json` (renamed) |
| **trae** | mcp-only | `~/.trae/mcp.json` · `mcpServers` (unverified) | unverified | ✅ (cannot confirm/deny) |
| **zed** | mcp-only | `~/.config/zed/settings.json` · `context_servers` | source | ❌ — Windows path uses LOCALAPPDATA, should be APPDATA |
| **kiro** | json-stdio | `~/.kiro/settings/mcp.json` · `mcpServers`; hooks in agent file | source | ❌ — missing the documented `Stop` hook |

---

## 2. Required Corrections to `src/adapters/*` (file-by-file, exact change)

### 🔴 P0 — `src/adapters/kilo-cli/index.ts` → convert from mcp-only to ts-plugin (OpenCode fork)

The Kilo CLI (`kilo` binary) is a **live-confirmed OpenCode fork** that loads `@kilocode/plugin` modules (`PluginModule = { server: (input) => Promise<Hooks> }`). The current adapter is mcp-only and synthesizes no plugin — this is the single most consequential miss. Mirror the OpenCode adapter (`src/adapters/opencode/index.ts`), adapting for Kilo's plugin contract and explicit config registration.

Concrete changes to `KiloCliAdapter`:

1. **`paradigm`**: `"mcp-only"` → `"ts-plugin"`.
2. **`capabilities`**: set `preToolUse: true, postToolUse: true, sessionStart: true, canModifyArgs: true, canModifyOutput: true, canInjectSessionContext: true` (match the OpenCode capability surface; degrade `ask` → block).
3. **Add `EVENT_TO_KILO` map** mirroring `EVENT_TO_OPENCODE` (`PreToolUse → tool.execute.before`, `PostToolUse → tool.execute.after`, `SessionStart → experimental.chat.system.transform`), confirming live against the installed fork's event vocabulary.
4. **`getHookConfigPath`**: stop returning `getServerConfigPath`; return the generated plugin module path, e.g. `~/.config/kilo/plugin/<id>.js` (user) / `<projectDir>/.kilo/plugin/<id>.js` (project) — confirm the fork's plugin dir name.
5. **`installHooks` / `uninstallHooks`**: replace the always-skip bodies with the OpenCode synthesize-and-write flow PLUS register the module in the config **`plugin` array** (Kilo, unlike OpenCode, does NOT auto-discover by directory for this fork per the instruction — it reads a `plugin` array in `kilo.jsonc`). Add `upsertPluginInArray`/`removePluginFromArray` helpers (array of module paths or `@kilocode/plugin` specifiers).
6. **`synthesizePlugin` / `buildPluginSource`**: generate a self-contained ESM module exporting `{ server: async (input) => ({ "tool.execute.before": …, "tool.execute.after": …, … }) }` — the `@kilocode/plugin` `PluginModule` shape — whose handlers `execFileSync(HOME_BIN, ["hook", "kilo-cli", event, "--connector", id], {input: JSON.stringify(payload)})` and JSON.parse the reply (fail-open), exactly as OpenCode's bridge does.
7. **Add `parseEvent` + `formatReply`** identical in spirit to OpenCode's (bridge payload maps straight through; `formatReply` returns the normalized `HookResponse` as stdout JSON).
8. **`getHealthChecks`**: add a "plugin module present" + "registered in `plugin` array" check alongside the existing MCP checks.
9. MCP half is already correct (`mcp` root key, `kilo.jsonc`, `command:[...]` array, `environment`) — keep it.

### 🟠 P1 corrections (live-confirmed bugs)

**`src/adapters/droid/index.ts`** — adapter is `mcp-only` but droid has a full Claude-compatible hooks system.
- `paradigm` `"mcp-only"` → `"json-stdio"`.
- `capabilities`: `preToolUse/postToolUse/userPromptSubmit/stop: true`, `canInjectSessionContext: true` (Claude-shaped).
- `getHookConfigPath`: return `join(getConfigDir(ctx), "hooks.json")` (separate from `mcp.json`).
- Implement `installHooks`/`uninstallHooks` writing `{ hooks: { Event: [{ matcher?, hooks:[{type:"command", command}] }] } }` (nested-rule, like goose/kiro — NOT crush's flat shape). Add `parseEvent` (Claude `hook_event_name`/snake_case) + `formatReply` (Claude `hookSpecificOutput`). Model on the kiro/qwen adapters.

**`src/adapters/goose/index.ts`** — three live bugs in the hooks half (the MCP/YAML half is correct):
- **Hook file shape** (`installHooks`/`readHooksFile`/`GooseHooksFile`): change to `{ hooks: { <Event>: [{ matcher?, hooks: [{ type, command }] }] } }`. Commands must be nested inside a rule object's inner `hooks` array; **drop the top-level `version` key** (not in the Open Plugins spec).
- **Hook path** (`getHookConfigPath`): the path is correct in spirit but must live under `.agents/plugins/<plugin-name>/hooks/hooks.json` — confirm `<plugin-name>` resolution; also support the `~/.agents/...` user-scope variant.
- **`formatReply`**: goose deny is **`{ decision: "block", reason }`** (or exit-2+stderr), NOT `hookSpecificOutput.permissionDecision: "deny"`. Replace the `stdout({hookSpecificOutput…})` deny/ask branches with the goose `{decision:"block"}` shape.
- **`GooseWireInput`/`parseEvent`**: goose sends **`working_dir`**, not `cwd`. Read `working_dir` (keep `cwd` as fallback) so `projectDir` is populated.

**`src/adapters/openclaw/index.ts`** — `plugins.entries.<id>` writes a `module` field that **fails `openclaw config validate`**.
- `OpenClawPluginEntry`: remove `module`; entry becomes `{ enabled: true }` only.
- `upsertPluginEntry`: write `plugins.entries.<id> = { enabled: true }` AND add `plugins.load.paths: ['<plugin-dir>']` (the dir containing the synthesized module + an `openclaw.plugin.json` manifest) so the gateway discovers/loads it.
- `synthesizePlugin`: additionally emit an `openclaw.plugin.json` manifest beside `index.mjs`.
- `removePluginEntry`: also remove the dir from `plugins.load.paths`.
- `getHealthChecks` dual-registration check: keep, but assert `plugins.load.paths` instead of `entries.<id>.module`.

**`src/adapters/qwen-code/index.ts`** — `updatedMCPToolOutput` does not exist in qwen 0.17.1 source.
- `capabilities.canModifyOutput`: `true` → `false`.
- `formatReply`: remove the `event === "PostToolUse"` `updatedMCPToolOutput` branch (let it fall through to allow).
- Update the module-header comment claiming qwen "CAN rewrite already-emitted tool output."

### 🟡 P2 corrections (source-confirmed; GUI/IDE hosts)

**`src/adapters/kilo/index.ts`** (VS Code extension) — vsix 7.3.28 delegates MCP to the kilo backend; `mcp_settings.json` is migration-only.
- User-scope path: change from `<globalStorage>/kilocode.kilo-code/settings/mcp_settings.json` to **`~/.config/kilo/kilo.json`** (XDG `XDG_CONFIG_HOME/kilo`); project scope `<projectDir>/.kilo/kilo.json`.
- `MCP_ROOT_KEY`: `"mcpServers"` → **`"mcp"`**.
- Entry shape: `{type:"local", command:[exe,...args], environment:{}}` (array command), NOT `{command, args, env, disabled}`. (This makes `kilo` and `kilo-cli` nearly converge on config — keep distinct platformIds, but note the dialect is now shared.)

**`src/adapters/roo-code/index.ts`** — vsix 3.54.0 renamed the user-scope file.
- `userSettingsPath()`: `cline_mcp_settings.json` → **`mcp_settings.json`**. Probe both during detection (extension migrates the old name at startup). Project scope `.roo/mcp.json` + `mcpServers` stay correct.

**`src/adapters/zed/index.ts`** — Windows path is wrong.
- `userConfigDir()` win32 branch: `process.env.LOCALAPPDATA` → **`process.env.APPDATA`** (Roaming), fallback `AppData/Roaming`. Fix the module-header comment that says "%LOCALAPPDATA%…(Local, NOT %APPDATA%)" — it's the inverse. `context_servers` + flat `{command,args,env}` stay correct.

**`src/adapters/kiro/index.ts`** — missing the documented `Stop` hook.
- `capabilities.stop`: `false` → `true`.
- `KIRO_EVENT`: add `stop: "stop"`; `EVENT_MAP`: add `Stop: "stop"`.
- `parseEvent`: add a `Stop` case (same shape as `UserPromptSubmit` minus `prompt`).
- `formatReply`: handle `Stop` (deny → exit 2; otherwise exit 0). Note: the `kiro_default.json` agent filename remains MEDIUM-confidence (docs only confirm `~/.kiro/agents/`).

### 🟢 P3 corrections (non-functional / accuracy)

**`src/adapters/kimi/index.ts`** — functionally correct but the metadata under-declares:
- Caps intentionally narrow (PreToolUse-only) — acceptable, but worth a header note that kimi supports far more (`Stop`, `UserPromptSubmit`, `PostToolUse`, `SessionStart/End`, `PreCompact/PostCompact`, `Notification`, `SubagentStart/Stop`).
- The adapter has no plugin surface; observation notes kimi **has** a plugin system (`KIMI_CODE_HOME/plugins/<name>/kimi.plugin.json`) and skills (`~/.kimi-code/skills/`). Not a bug, but coverage is incomplete — flag for a future skills/plugins surface.
- TOML round-trip via `@iarna/toml` is compatible with kimi's smol-toml flat-array `hooks = [...]` — no change required.

**`src/adapters/mux/index.ts`** — no change required. String command form is valid; the richer object form is optional.

---

## 3. Platforms Whose Paradigm/Config We Got Wrong (with corrected values)

| Platform | Adapter said | Confirmed truth |
|---|---|---|
| **kilo-cli** | paradigm `mcp-only`, no plugin | **`ts-plugin`** — OpenCode fork loading `@kilocode/plugin` (`{server:(input)=>Promise<Hooks>}`), registered in `kilo.jsonc` `plugin` array. MCP half (`mcp` key, command-array) was already right. |
| **kilo** (ext) | `~/.../globalStorage/kilocode.kilo-code/settings/mcp_settings.json`, root `mcpServers`, `{command,args,env,disabled}` | `~/.config/kilo/kilo.json` (proj `.kilo/kilo.json`), root **`mcp`**, entry `{type:"local", command:[...], environment:{}}`. globalStorage path is legacy migration-only. |
| **droid** | `mcp-only`, hooks skipped | **`json-stdio`** with a full Claude-compatible hooks system in `~/.factory/hooks.json` (nested-rule shape). |
| **goose** | hooks: `{version,hooks:{E:[{type,command}]}}`, deny via `hookSpecificOutput`, reads `cwd` | nested-rule `{hooks:{E:[{matcher?,hooks:[{type,command}]}]}}` (no `version`); deny `{decision:"block"}`; stdin field `working_dir`. |
| **openclaw** | `plugins.entries.<id>={enabled,module}` | `plugins.entries.<id>={enabled:true}` + `plugins.load.paths:[dir]` (dir w/ `openclaw.plugin.json`). `module` field is invalid. |
| **qwen-code** | `canModifyOutput:true`, emits `updatedMCPToolOutput` | `canModifyOutput:false`; no PostToolUse output rewrite exists in 0.17.1. |
| **roo-code** | user file `cline_mcp_settings.json` | `mcp_settings.json` (renamed in 3.54.0). |
| **zed** | Windows `%LOCALAPPDATA%\Zed` | `%APPDATA%\Zed` (Roaming, via `dirs::config_dir()`). |
| **kiro** | `stop:false`, no Stop mapping | `stop` is a documented Kiro hook; needs full Stop wiring. |

---

## 4. Confirmed CORRECT (coverage provably verified)

These adapters were read in full and **match the live/source-confirmed reality** — no changes needed:

- **amp** ✅ live — `~/.config/amp/settings.json`, flat dotted root `amp.mcpServers`, no `type` field, no hooks/plugins. Adapter exact.
- **codebuff** ✅ live — `~/.agents/mcp.json`, `mcpServers`, optional `type:"stdio"` (adapter writes it; valid). Path cascade matches.
- **crush** ✅ live — `~/.config/crush/crush.json`, root `mcp`, flat hook rule `{matcher,command}`, deny via stdout JSON, avoids `$(...)`. Adapter exact.
- **mux** ✅ live — `~/.mux/mcp.jsonc`, `servers`, command-string entry. Adapter exact (string form valid; object form optional).
- **hermes** ✅ source — `~/.hermes/config.yaml`, `mcp_servers`, `EVENT_TO_HERMES` mapping (`pre_tool_call`/`post_tool_call`/`on_session_start`/`on_session_end`) correct, entry shapes correct.
- **omp** ✅ live — `~/.omp/agent/mcp.json`, `mcpServers`, ts-plugin via `extensions/` + `pi.on()`, `omp`/`pi` manifest field. Adapter exact.
- **pi** ✅ source — skills-only surface at `~/.pi/skills/<name>/SKILL.md`; correctly mcp-skip/hooks-skip. The `@mariozechner/pi` npm package (vLLM pod manager) is a different product; adapter targets the legacy pi coding agent — no contradiction.
- **kimi** ✅ (functional) live — MCP + hooks install paths, schemas, deny shape, and TOML round-trip all correct; only metadata is conservative (see P3).

Registry (`src/adapters/registry.ts`) correctly registers all 30 adapters including both `kilo` and `kilo-cli` as distinct platformIds, with fork-ordering comments intact.

---

## 5. Still UNVERIFIED (honest gaps)

- **trae** — *unverified, not confirmable.* ByteDance proprietary GUI IDE; Linux unavailable, no downloadable binary, the two open-vsx extensions are 1.5KB URI stubs, GitHub repo is README-only. The adapter's `~/.trae/mcp.json` + `mcpServers` claim **could not be confirmed or denied**. Adapter is internally consistent but rests on an unverified path. Treat as best-effort until a Trae install can be observed on a supported OS.
- **kilo-cli plugin specifics** — the **paradigm** (OpenCode fork, `@kilocode/plugin`, `{server:(input)=>Promise<Hooks>}`) is live-confirmed, but the exact plugin **directory name**, whether the `plugin` array takes file paths vs package specifiers, and the precise event vocabulary the fork exposes still need a live install pass to lock down before the P0 rewrite ships.
- **kilo (ext) project root key** — `~/.config/kilo/kilo.json` + root `mcp` confirmed from vsix 7.3.28 source; the **project** `.kilo/kilo.json` is source-inferred from the same `configPath()`, not live-observed against a running extension.
- **kiro `kiro_default.json`** — MCP paths and the `Stop` hook are doc-confirmed, but the **default-agent filename** (`kiro_default`) is not confirmed by public docs (only `~/.kiro/agents/` is). Verify against a real Kiro CLI install.
- **roo-code / zed** — both source-confirmed from vsix/GitHub, not live-installed (GUI hosts). High confidence, but no runtime observation.

**Bottom line:** 8 adapters are provably correct, 9 need corrections (1 P0 rewrite, 4 P1 live-confirmed bugs, 4 P2 source-confirmed fixes, 1 P3 metadata), and trae remains genuinely unverifiable on this platform. The P0 kilo-cli ts-plugin conversion is the highest-impact change and should mirror `src/adapters/opencode/index.ts` with the `@kilocode/plugin` `server`-input contract and an explicit `plugin`-array registration in `kilo.jsonc`.