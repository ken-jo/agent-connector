# Fleet surface-gap audit — completion status (2026-06-16)

Source of truth: `fleet-surface-gap-audit-2026-06-16.json` (46 raw) → `fleet-finding-verify-2026-06-16.json` (verified triage: 17 real / 10 non-gap / 4 unverifiable).

## DONE — merged PRs this pass (#58–#70)
Hook-event/nativeHooks arc + audit fixes:
- vscode-copilot PostToolUse block (#58); openclaw/nemoclaw `streamable-http` (#59); omp remote MCP `type` (#60); copilot-cli nativeHooks `ErrorOccurred` (#61); hermes HTTP MCP (#62); copilot-cli sse (#63); jetbrains-copilot SessionEnd+nativeHooks+transports (#64) + UserPromptSubmit/PostToolUse block (#65); **continue mcp-only → json-stdio Claude-compatible hooks + nativeHooks (#66)**; codebuff/cursor/amazon-q comments (#67); goose+qwen hooks-canonical (#68); qwen nativeHooks (#69); **windsurf commands+skills content surfaces (#70)**.

Real findings closed: vscode #56/#58, openclaw/nemoclaw/omp/hermes/copilot-cli mcp, copilot-cli/jetbrains/qwen nativeHooks, jetbrains/goose/qwen hooks-canonical, continue hooks-native, codebuff/cursor/amazon-q comments, windsurf commands+skills. **8 of 17 "real" + the earlier hook-event arc.**

## REMAINING — 5 ts-plugin findings (the delicate generated-source tail)
All need the SAME pattern: extend `buildPluginSource` (the AUTO-GENERATED plugin string template) to register the new event handler(s). The home-bin runtime already dispatches native events host-generically (runNativeHook) — only the generated plugin must register + `bridge()` them.

**Mechanism per host** (the generated plugin maps host-native event name → handler → `bridge("<canonicalOrNativeName>", payload)`):
- **omp** (`src/adapters/omp/index.ts` buildPluginSource ~602): a `handlers: string[]` array, hardcoded `pi.on("session_start"|"tool_call"|"tool_result"|"session_before_compact", …)` per canonical event. For nativeHooks: compute `nativeEvents = Object.keys(platforms.omp?.nativeHooks ?? {})`; append `pi.on("<nativeEvent>", (event) => { bridge("<nativeEvent>", {sessionId, projectDir, raw:event}); })` per native event; set `supportsNativeHooks:true`; combined install guard (canonical OR native ⇒ generate plugin); `hooks:false` disables canonical-only.
- **openclaw** (`api.on(event, handler)` + `bridge`, EVENT_TO_OPENCLAW ~160). Findings: (a) UserPromptSubmit→`before_prompt_build` canonical — CAUTION: `before_prompt_build` ALSO serves SessionStart context today, so a per-prompt event maps there; resolve the double-mapping (likely UserPromptSubmit is the more accurate semantic for before_prompt_build, SessionStart stays a one-time context inject — verify which fires when). (b) supportsNativeHooks via the generic api.on loop. **Covers nemoclaw** (extends OpenClawAdapter). Verified src: docs.openclaw.ai.
- **opencode** (`src/adapters/opencode/index.ts`, EVENT_TO_OPENCODE ~106, buildPluginSource ~724 — object-map `"tool.execute.before": async (input,output)=>{…bridge…}`). Findings: (a) **PermissionRequest** → add `EVENT_TO_OPENCODE['PermissionRequest']='permission.ask'` + a `"permission.ask"` handler that bridges and returns `{decision:'ask'|'deny'|'allow'}` (opencode permission.ask is decision-capable — anomalyco/opencode packages/plugin/src/index.ts:260-264); set `permissionRequest:true` + drift matrix + parseEvent/formatReply already handle PermissionRequest (verify). (b) supportsNativeHooks for the 25+ host events (chat.message/session.idle/permission.replied/command.execute.before/shell.env…) via a generic native-event loop in the object-map.
- **mimo-code** (OpenCode fork) hooks-canonical: UserPromptSubmit→`chat.message` (add to EVENT map + a chat.message handler in its buildPluginSource) + `userPromptSubmit:true` + drift matrix.

Each: + a `tests/adapters/<host>-*.test.ts` (assert the generated plugin source contains the new `pi.on/api.on("<event>")` registration + bridge; capability flags; drift). supportsNativeHooks is NOT in the drift tuple; canonical wirings (opencode PermissionRequest, mimo/openclaw UserPromptSubmit) DO need `site/hooks-matrix.ts` cell updates.

## DEFERRED — real but not cleanly implementable in this pass (documented, not silently dropped)
- **kimi/other (plugin system)**: real, but needs a NEW cross-cutting `plugins` SURFACE in AC's connector model (defineConnector/SPI/all adapters) — AC has none today — OR a `package` target. Architecture decision, out of per-adapter scope.
- **kilo/hooks-native**: verifier fixSpec was unverified/"pending confirmation" of the exact kilo event mapping (session.error/session.deleted). Needs primary-source confirmation before wiring.
- **opencode/hooks-canonical (SessionStart-via-surrogate)**: the verifier itself concluded "host limitation, not an adapter gap" — the experimental.chat.system.transform surrogate is the only injection point; the real fix is upstream (anomalyco/opencode).
- **codex/mcp (HTTP transport)**: codex DOES support config.toml streamable-HTTP, but the docs are SPA-redirect stubs — the exact config.toml shape (url/bearer_token_env_var/http_headers/rmcp_client) is not byte-verifiable from a reachable primary source. Defer until verifiable.

## REJECTED (non-gap, verified) — do NOT implement
amazon-q/hooks-native (real layer but per-agent-file, adapter honestly mcp-only), cline/hooks-canonical (plugin hooks are SDK/CLI-only, NOT the VS Code extension AC targets), cline/other (Cline CLI/SDK is a deliberately-deferred SEPARATE adapter), codex/hooks-native (notify is a single program, not per-event hooks), gemini-cli/hooks-canonical (AfterAgent is a validation/retry event, semantically NOT Stop), antigravity-cli plugin/skills, kilo-cli hooks-canonical/native, pi/hooks-native — see fleet-finding-verify JSON for each verdict+evidence.

## UNVERIFIABLE (defer) — JS-rendered docs, no reachable primary source
antigravity/hooks-native, antigravity/hooks-canonical, trae/hooks-native, trae/commands.
