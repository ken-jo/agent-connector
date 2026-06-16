# Tier 1–3 candidate resolution — verify-first pass (2026-06-16)

Goal: `/goal 티어 1부터 3까지 해결` — drive every Tier 1–3 candidate (from the
2026-06-16 next-implementation-candidates list) to a resolution: implement the
ones a PRIMARY source verifies, document the rest with the exact blocker. NO
candidate implemented on a guessed contract (honesty bar: never invent a
config key / event name; DEFER rather than guess).

The earlier ground-truth workflow over-stated open work — re-reading the source
showed several candidates were **already shipped**. Each item below is
classified against the *current* `main` + a primary source.

## ALREADY DONE (workflow assessment was stale)
| Item | Finding |
|---|---|
| cursor native-hooks comment | `cursor/index.ts:215-224` already enumerates all 11 hooks (incl. beforeTabFileRead/afterTabFileEdit/workspaceOpen). |
| SDK `defineStatusline`/`defineAction` | The full `define*` family already exists in `core/define-connector.ts` and is exported from `/sdk` + root. |
| amazon-q skills/agents comment | `amazon-q/index.ts:4-12,131-136` already accurately documents the per-agent hooks layer + prompts/agents content surfaces as deferred (not absent). |

## IMPLEMENTED THIS PASS (primary-source verified)
| Item | Source of truth | What shipped |
|---|---|---|
| **codex HTTP MCP** | LIVE codex-cli 0.139.0 (`codex mcp add --url … --bearer-token-env-var …` on `ssh my-window`) | `[mcp_servers.<id>]` `{ url, bearer_token_env_var?, http_headers? }`, no transport key. `AuthSpec.bearerEnv→bearer_token_env_var`, `headers→http_headers`. sse/ws stay skip-warn. |
| **opencode SessionStart** | in-repo + anomalyco/opencode #14808 | forward-migration TODO (surrogate stays correct until upstream native hook). |
| **kilo + kilo-cli hooks** | kilo.ai/docs/automate/extending/plugins | `chat.message`→UserPromptSubmit, `permission.ask`→PermissionRequest, `session.idle`(via `event` hook)→Stop. SessionEnd unmapped (no clean analog). |
| **openclaw + nemoclaw UserPromptSubmit** | raw.githubusercontent.com/openclaw/openclaw…/hooks.md | `before_prompt_build` (per-turn) → UserPromptSubmit, coexisting with one-time SessionStart context; + `supportsNativeHooks`. Context-inject only (no block). |
| **amp hooks** | ampcode.com/manual | mcp-only→ts-plugin: `session.start`→SessionStart, `agent.start`→UserPromptSubmit, `tool.call`→PreToolUse, `tool.result`→PostToolUse, `agent.end`→Stop. No `session.end` (SessionEnd unsupported). |
| **codebuff subagents** | codebuff.com/docs/agents/creating-new-agents | emit `.agents/<id>.ts` `export default` AgentDefinition (id/displayName/model/instructionsPrompt/toolNames…); no type-import, omit absent fields. |

## DEFERRED / NON-GAP (verified — NOT implemented, with the precise reason)
| Item | Disposition | Blocker / reason |
|---|---|---|
| **windsurf actions** | NON-GAP | Cascade workflows are **manual-only** prompt macros (docs.windsurf.com/cascade/workflows: "Cascade will never invoke a workflow automatically"; no shell-exec step) and already covered by `supportsCommands`. An "actions" surface would be a degraded duplicate. |
| **statusline ×5 (hermes/warp/omp/openclaw)** | NON-GAP / mis-scoped | `statusline-hud-surface-design.md`: the statusline is a 3-host **Class-A command-stdin** surface (claude-code ✅, cursor, droid). warp=open FR #8795, hermes=`display.show_cost` toggle only, openclaw=app-managed — none expose a command-stdin renderer. omp/pi = a possible *future Class-B* (in-process TS API) effort, a different mechanism. |
| **kimi plugins install-surface** | DEFER (package-path covers it) | `package --format kimi-plugin` already emits `kimi.plugin.json`. A runtime `installPlugins` surface is below the ≥3-host promotion bar (kimi is the only plugin-system host) — would bloat the SPI for one host. Manifest verified (kimi.com/code/docs…/plugins.html) if revisited. |
| **amp subagents** | DEFER (experimental) | `amp.experimental.createAgent` is a runtime plugin API explicitly marked "Experimental … may change"; no stable on-disk author-file surface. |
| **grok-build adapter** | DEFER (no binary) | xAI docs have no MCP TOML table; needs a live `grok` binary to confirm the plugin-carrier vs config-inherit paradigm. No grok binary on the verify hosts. |
| **droid statusline** | DEFER (no binary) | Class-A ready, but needs a live authenticated droid stdin capture (Factory publishes no payload schema). No droid binary on the verify hosts. |
| **cursor statusline** | DEFER (no binary) | Class-A ready, but the `/statusline` stdin contract is sourced from a community tool — needs a live `cursor-agent` capture. No cursor-agent binary on the verify hosts. |

Verify hosts available this pass: `ssh my-window` / `ssh my-mac` carry claude/codex/agy/gemini/opencode — NOT grok/droid/cursor-agent, so those three statusline/adapter items cannot be live-verified here. They unblock the moment that host access exists.

Related: [[fleet-finding-verify-2026-06-16.json]] · [[REMAINING-WORK-2026-06-16.md]]
