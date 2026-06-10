I have a complete picture. The detection cascade derives from the registry and delegates to each adapter's `detectInstalled()`, so adding a platform is just a registry entry plus the adapter file. Now I'll produce the decisive plan.

# Plan: Full Antigravity (IDE + CLI) Support for agent-connector

## TL;DR decisions
- **Upgrade the existing `antigravity` adapter** from `mcp-only` → `json-stdio` with full content surfaces (hooks + commands/workflows + skills + subagents). The "mcp-only / no hooks" framing is stale as of Antigravity 2.0.
- **Add ONE new platform: `antigravity-cli`** (`agy`). It is a distinct binary with its own global dir and its own usage store, so it gets its own adapter + PlatformId + usage reader. The two adapters **share rendering logic** (same JSON/`hooks.json`/SKILL.md formats) but **differ in user-scope paths** and runtime markers.
- **Keep `gemini-cli` exactly as-is.** Enterprise + API-key users persist past the 2026-06-18 consumer cutoff. Only document the shared-`~/.gemini` caveats.
- **Fix two confirmed bugs in the current adapter regardless of scope decisions:** the remote-server key (`url` → `serverUrl`) and the stale-first user MCP path order.
- Antigravity is fast-moving and its docs render JS-only (research confidence = **medium**). Every user-scope path and every "new in 2.0" surface must be **path-probed at runtime with doctor reporting**, never hard-coded to a single guess.

---

## 1. Config paths + formats (corrected/confirmed), with confidence

### MCP config
Format for both IDE and CLI: **plain JSON**, root key `"mcpServers"`. stdio = `{ command, args, env }`. Remote = `{ "serverUrl": "...", "headers": {...} }` — **NOT `url`**, and **not** Gemini CLI's `httpUrl`. No `${workspaceFolder}` / native env-token support → keep resolving env refs to literals at install time (`resolveEnvRefsDeep`). [confidence: MCP shape HIGH; exact paths MEDIUM]

| Scope | IDE (`antigravity`) | CLI (`antigravity-cli`) | Confidence |
|---|---|---|---|
| User/global | `~/.gemini/config/mcp_config.json` (canonical shared, current 2.0) | same `~/.gemini/config/mcp_config.json`, plus CLI-only alt `~/.gemini/antigravity-cli/mcp_config.json` | MEDIUM |
| Legacy user | `~/.gemini/antigravity/mcp_config.json` (Nov-2025 launch path; still read by older builds) | — | MEDIUM |
| Project | `<proj>/.agents/mcp_config.json` (**plural** `.agents`) | `<proj>/.agents/mcp_config.json` | HIGH |
| Generated (DO NOT WRITE) | `~/.gemini/antigravity-ide/mcp/` | `~/.gemini/antigravity-cli/mcp/` | — |

**WRONG in current adapter — must change:**
- **BUG 1 (remote key).** `AntigravityHttpServer` + `renderServerEntry` emit `{ url }`. Antigravity uses `serverUrl`. Fix the interface to `{ serverUrl: string; headers? }` and the render to `serverUrl`. (The current `transports: ["stdio","sse","http"]` is otherwise fine.)
- **BUG 2 (user path order).** `USER_CONFIG_CANDIDATES[0]` is the **legacy** `.gemini/antigravity/` path, and `resolveUserConfigPath()` falls back to `candidate[0]` on a fresh install → writes to the stale path. **Reorder so candidate[0] = `.gemini/config/mcp_config.json`** (canonical shared), then `.gemini/antigravity/` (legacy), then `.gemini/antigravity-cli/mcp_config.json` (CLI-only). Keep "prefer an existing candidate, else default to the new candidate[0]." The CLI adapter's candidate list = `[.gemini/config/, .gemini/antigravity-cli/]`.

### Hooks (NEW — was incorrectly false)
**SUPPORTED** as of Antigravity 2.0. Declared as JSON in a `hooks.json` file in the customization dir: project `<proj>/.agents/hooks.json` or global `~/.gemini/config/hooks.json` (and at plugin roots). Shape:
```json
{ "hooks": { "<Event>": [ { "matcher": "<regex>", "hooks": [ { "type": "command", "command": "..." } ] } ] } }
```
Events: `PreToolUse`, `PostToolUse`, `SessionStart`, `Stop` (matcher-based); `PreInvocation`, `PostInvocation` (handler list directly under event, matcher ignored). I/O is stdin/stdout JSON, **camelCase** fields. Categories: Inspect (read-only), Decide (blocking approve/deny), Transform (modifying). [confidence: MEDIUM — event names corroborated by secondary sources + official doc URL, not quoted from live docs]

### Commands / Skills / Subagents
- **Commands = "Workflows":** markdown `.md`. Project `<proj>/.agent/workflows/*.md` (note **singular** `.agent` in launch-era docs), global `~/.gemini/antigravity/global_workflows/*.md`. CLI also surfaces skills-as-slash-commands. [MEDIUM]
- **Skills = Agent Skills (`SKILL.md`)**, Claude-compatible. Project `<proj>/.agents/skills/<name>/SKILL.md` (plural). Global (CLI) `~/.gemini/antigravity-cli/skills/<name>/SKILL.md`; shared 2.0 `~/.gemini/skills/`. **Official `~/.gemini/antigravity/skills/` reportedly does NOT work — avoid it.** [skill format HIGH; global dir MEDIUM-LOW]
- **Subagents:** two flavors. (a) runtime/dynamic (orchestrator-defined, not user files — out of scope). (b) declarative, **only inside a plugin bundle** at `<plugin>/agents/`. There is **no documented standalone top-level subagents dir** outside the plugin model. [MEDIUM]

**`.agent` (singular) vs `.agents` (plural) quirk:** skills/plugins/mcp use **plural** `.agents`; rules/workflows in launch-era docs use **singular** `.agent`. Both appear in the wild. Handle both via probing (see §5).

---

## 2. Paradigm + surfaces each adapter should support

Both `antigravity` (IDE) and `antigravity-cli` get the **same** capability profile (they share the harness and formats):

- **paradigm:** `json-stdio` (was `mcp-only`).
- **MCP:** yes — stdio + remote (`serverUrl`). `transports: ["stdio","sse","http"]`.
- **Hooks (`installHooks`/`uninstallHooks` + `parseEvent`/`formatReply`):** write to `hooks.json` (NOT the mcp_config.json). Capability flags:
  - `preToolUse: true`, `postToolUse: true`, `sessionStart: true`, `stop: true`.
  - `preCompact: false`, `sessionEnd: false`, `userPromptSubmit: false`, `notification: false` (no documented equivalents — keep false; warn-skip like gemini-cli does for `Stop`).
  - `canModifyArgs: true`, `canModifyOutput: true` (Transform category), `canInjectSessionContext: true` (SessionStart).
  - Map normalized events → Antigravity events (1:1 for the four supported; everything else warn-skips). camelCase stdout payload; `parseEvent` reads camelCase stdin.
- **Commands:** `supportsCommands: true` — write Workflows `.md` under the workflows dir (markdown body; no TOML, unlike gemini-cli).
- **Skills:** `supportsSkills: true` — uniform `SKILL.md` writer (reuse `renderSkill`/`writeContentFile`, same as gemini-cli/pi).
- **Subagents:** **`supportsSubagents: false` for v1.** Declarative subagents only exist *inside a plugin bundle*; agent-connector does not currently emit plugin bundles, and there is no standalone subagent dir. Inherit BaseAdapter skip/warn. Revisit if/when a plugin-bundle writer is added.

This is a real upgrade: the adapter moves from the Warp-style mcp-only template to the gemini-cli-style json-stdio + content-surface template.

**LOW-CONFIDENCE GUARD:** because hook event names and the exact `hooks.json` location are MEDIUM confidence, gate hook + workflow installation behind path-probing and emit doctor warnings rather than silently writing to a guessed path (§5).

---

## 3. Is `antigravity-cli` distinct? — YES, new adapter + PlatformId + usage reader

Decision: **distinct platform.** Rationale:
- Different binary (`agy`, Go) vs the IDE/desktop app; sunsets Gemini CLI separately.
- Different **user-scope** install root (`~/.gemini/antigravity-cli/` and the CLI-only `mcp_config.json` alt) and different **runtime markers** for `detectRuntimeHost` (the universal hook entrypoint must know which host injected the stdin payload). A single adapter cannot report two distinct `installed`/`scope` answers or two distinct usage stores.
- Different **usage store** (`~/.gemini/antigravity-cli/brain|history.jsonl|conversations`), which the IDE doesn't own in the same shape.

They **share** project scope (`<proj>/.agents/…`) and all rendering formats, so factor the shared render/parse logic into a small internal module (or have `AntigravityCliAdapter extends AntigravityAdapter`, overriding only `name`, `id`, user-scope path resolution, and detection markers). Keep the IDE adapter's id `antigravity`; add `antigravity-cli`.

---

## 4. gemini-cli disposition — KEEP AS-IS (confirmed)

No code change. Enterprise + API-key users keep Gemini CLI past 2026-06-18; the Apache-2.0 repo persists. Caveats to **document only**:
- Gemini CLI and both Antigravity adapters share `~/.gemini/`. `~/.gemini/GEMINI.md` is read/written by both (gemini-cli issue #16058 conflict) — agent-connector doesn't write GEMINI.md, so no direct collision, but note it.
- gemini-cli writes MCP into `~/.gemini/settings.json` under `mcpServers`; the Antigravity adapters write into `~/.gemini/config/mcp_config.json` (+ tool-specific dirs). **Different files** → no clobber. Keep them separate; do not let the Antigravity adapter touch `settings.json`.
- A user with all three installed will get three separate registrations under one `~/.gemini` tree; that is correct and intended.

---

## 5. Concrete build task list

### A. Core type/registry plumbing
1. **`src/core/types.ts`** — add `"antigravity-cli"` to the `PlatformId` union (near `antigravity`). Update the `mcp-only` paradigm comment (line ~62) to drop `antigravity` from the mcp-only list.
2. **`src/adapters/registry.ts`** — add an `antigravity-cli` factory entry. **Order:** place `antigravity-cli` *before* `antigravity` and both after `gemini-cli` (registry order drives runtime-host detection; the more-specific CLI marker must be checked before the IDE/parent).
3. **`src/usage/registry.ts`** — add an `antigravity-cli` reader entry in the synced/cloud (U4) group (`format: "synced-cache"`, `kind: "synced"`) OR `kind: "local"` if reading the native `~/.gemini/antigravity-cli/` store directly (see task C).
4. **`src/usage/paths.ts`** — add a `case "antigravity-cli":` in `hostRoots` (and fix/extend `antigravity` — see C). Honors the existing `AGENT_CONNECTOR_ANTIGRAVITY_CLI_DIR` env override automatically via the existing `envOverride` machinery.

### B. Upgrade `src/adapters/antigravity/index.ts` (IDE)
5. Rewrite header comment (remove "mcp-only / no hooks"; state 2.0 hooks + surfaces, and that paths are probed because docs are JS-rendered/medium-confidence).
6. `paradigm: "json-stdio"`; flip capability flags per §2.
7. **Fix BUG 1:** `AntigravityHttpServer { serverUrl: string; headers? }`; `renderServerEntry` emits `serverUrl`. (Keep stdio rendering + telemetry wrap unchanged.)
8. **Fix BUG 2:** reorder `USER_CONFIG_CANDIDATES` → `config/` first, then `antigravity/` (legacy), then `antigravity-cli/`.
9. Add `getHookConfigPath` → `hooks.json` in the customization dir (project `<proj>/.agents/hooks.json`; user `<resolvedUserConfigDir>/hooks.json`), **separate from** mcp_config.json (currently it aliases mcp_config — change it).
10. Implement `installHooks`/`uninstallHooks` writing the `{ hooks: { Event: [{matcher, hooks:[{type:"command",command}]}] } }` shape (reuse `buildHomeBinHookCommand`, the gemini-cli upsert/strip pattern, the `isHomeBinHookCommand` guard). Warn-skip unsupported events.
11. Implement `parseEvent` (camelCase stdin → normalized) and `formatReply` (normalized → camelCase stdout: Decide deny/approve, Transform modify-args/output, SessionStart context inject).
12. Add content surfaces: `installCommands`/`uninstallCommands` (Workflows `.md` under probed workflows dir), `installSkills`/`uninstallSkills` (`SKILL.md`, reuse base helpers). Leave subagents to BaseAdapter default (unsupported v1).
13. Extend `getHealthChecks`: mcp_config present + server entry; hooks.json present + our hook command; workflow/skill file presence (mirror gemini-cli's per-surface checks). Add doctor warnings noting "path probed; verify against your Antigravity version."
14. **Path-probing helpers (guard for medium confidence):** a `resolveWorkflowsDir()` and `resolveSkillsDir()` that prefer an existing `.agents`/`.agent` (or global `antigravity-cli/skills` vs `skills`) variant and default to the documented current-2.0 path when none exists. Same prefer-existing-else-canonical pattern already used for `resolveUserConfigPath`.

### C. New `src/adapters/antigravity-cli/index.ts`
15. `class AntigravityCliAdapter extends AntigravityAdapter` (or shared-module composition). Override: `id="antigravity-cli"`, `name="Antigravity CLI"`; user-scope `USER_CONFIG_CANDIDATES = [.gemini/config/mcp_config.json, .gemini/antigravity-cli/mcp_config.json]`; global skills dir → `~/.gemini/antigravity-cli/skills/`; `detectInstalled` probes `~/.gemini/antigravity-cli/` (and the `agy` binary in `~/.local/bin`). Project scope identical (`.agents`).
16. `export default new AntigravityCliAdapter()`.

### D. Usage readers
17. **`src/usage/readers/antigravity.ts` (fix location).** Current reader targets `~/.config/tokscale/antigravity-cache` + `~antigravity*` dirs — that's a tokscale-cache indirection, not Antigravity's real store. **Decision:** keep the tokscale-cache path as a fallback (defensible: reads a tokscale mirror) BUT add the native root `~/.gemini/antigravity-ide/brain/**/transcript*.jsonl`. Update the header to say "reads tokscale cache AND native brain transcripts." The existing JSONL row schema (`session_meta`/`usage`) and alias table are reusable; **note** native transcripts embed tokens in `usage_metadata` per-turn (prompt/candidate/cached/thinking), which is a **different shape** than the tokscale `{input,output,cacheRead,...}` rows — a native parser path may be needed (guard: if native shape, map `usage_metadata`; the `.pb` protobuf has no public schema → skip).
18. **New `src/usage/readers/antigravity-cli.ts`.** Reads `~/.gemini/antigravity-cli/brain/<conv>/transcript*.jsonl` + `history.jsonl` index; skip `.pb`. Same alias table (factor out the shared `MODEL_ALIASES` + `parseUsageRow` into a shared helper to avoid duplication). Fail-open when absent. Mark confidence honestly: native JSONL shape = MEDIUM; treat `usage_metadata` extraction as best-effort.

### E. Tests
19. **`tests/adapters/wave1-render.test.ts`** — move antigravity out of the mcp-only block; assert `serverUrl` (not `url`) for remote, and the corrected user path order.
20. **`tests/adapters/phase2-render.test.ts`** (json-stdio block) — add antigravity + antigravity-cli: hooks.json round-trip, `parseEvent`/`formatReply` for PreToolUse/PostToolUse/SessionStart/Stop, warn-skip for unsupported events.
21. **`tests/adapters/surfaces-s1.test.ts`** — add workflow `.md` + `SKILL.md` write/idempotent/uninstall for both adapters; assert subagents warn-skip.
22. **`tests/usage/u4-readers.test.ts`** (or u1 if reclassified local) — add antigravity-cli reader fixtures (synthetic `transcript.jsonl`), and a native-brain fixture for the updated antigravity reader. Assert fail-open on empty.
23. New `tests/adapters/antigravity-paths.test.ts` — exercise the prefer-existing-else-canonical probing for user MCP, hooks.json, workflows (`.agent` vs `.agents`), and global skills dirs.

### What is LOW-CONFIDENCE and MUST be guarded (not hard-coded)
- **Exact hook event names + `hooks.json` location** (MEDIUM): probe for an existing `hooks.json` (project `.agents/` then `.agent/`, user `config/`); default to `.agents/hooks.json` only when none exists; doctor prints the resolved path + a "verify for your version" note. Unsupported normalized events warn-skip (never throw at install).
- **Global skills dir** (the documented `~/.gemini/antigravity/skills/` reportedly broken): prefer existing `~/.gemini/antigravity-cli/skills/` or `~/.gemini/skills/`; never write to `~/.gemini/antigravity/skills/`.
- **`.agent` vs `.agents`** for workflows/rules: probe both, prefer existing, default to the 2.0 plural for skills/mcp and singular `.agent/workflows` for workflows per launch-era docs (doctor reports which was chosen).
- **User MCP canonical path**: prefer existing candidate; the reordered default (`.gemini/config/`) is a best-guess for fresh installs.
- **Native usage store shape** (`transcript.jsonl` `usage_metadata` vs tokscale rows; `.pb` opaque): best-effort parse, skip protobuf, fail-open to `[]`.
- **Subagents**: deliberately unsupported v1 (plugin-bundle-only model) — documented, not guessed.

### Files touched (absolute paths)
- Edit: `/home/ubuntu/workspace/github/agent-connector/src/core/types.ts`
- Edit: `/home/ubuntu/workspace/github/agent-connector/src/adapters/registry.ts`
- Edit: `/home/ubuntu/workspace/github/agent-connector/src/adapters/antigravity/index.ts`
- Create: `/home/ubuntu/workspace/github/agent-connector/src/adapters/antigravity-cli/index.ts`
- Edit: `/home/ubuntu/workspace/github/agent-connector/src/usage/registry.ts`
- Edit: `/home/ubuntu/workspace/github/agent-connector/src/usage/paths.ts`
- Edit: `/home/ubuntu/workspace/github/agent-connector/src/usage/readers/antigravity.ts`
- Create: `/home/ubuntu/workspace/github/agent-connector/src/usage/readers/antigravity-cli.ts`
- Edit tests: `/home/ubuntu/workspace/github/agent-connector/tests/adapters/wave1-render.test.ts`, `/home/ubuntu/workspace/github/agent-connector/tests/adapters/phase2-render.test.ts`, `/home/ubuntu/workspace/github/agent-connector/tests/adapters/surfaces-s1.test.ts`, `/home/ubuntu/workspace/github/agent-connector/tests/usage/u4-readers.test.ts`
- No change: `/home/ubuntu/workspace/github/agent-connector/src/adapters/gemini-cli/index.ts` (keep as-is; document shared `~/.gemini` caveats only).