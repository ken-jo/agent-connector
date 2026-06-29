# Changelog

## 0.4.98 — 2026-06-30

Documentation and site polish for the beginner onboarding release.

### Added

- Added deeper beginner guide pages and a demo-lab path for first MCP server, host connection, hooks, HUD/statusline, actions, commands, skills, subagents, and memory concepts.
- Added a dedicated `/telemetry` page and header entry so token telemetry can be linked independently from the landing page.
- Added public coverage filtering that keeps the homepage focused on closed-source flagship hosts and 1k+ star open-source hosts while preserving the full registry in developer docs.

### Changed

- Renamed the header matrix entry to Coverage, simplified header navigation, and split the footer into a three-column layout.
- Refined docs sidebar typography, table/code-block spacing, and beginner copy structure for easier scanning.
- Expanded statusline and action surfaces across supported host CLIs with matching runtime and SDK tests.

### Fixed

- Removed stale public host-count copy after filtering lower-star adapters from public-facing coverage.
- Preserved package audit and release status checks across the site build after the docs and routing changes.

## 0.4.97 — 2026-06-29

Release preparation for the public docs and Windows-safe verification path.

### Added

- Added the beginner guide surface for agent-connector and MCP concepts, with room to expand host CLI roles, hooks, HUD behavior, actions, and special features.
- Added release status and package-audit generated surfaces used by the site and release checks.

### Fixed

- Made symlink-focused tests tolerate local environments that cannot create symlinks, while preserving the existing assertions when symlink setup is available.
- Isolated Windows `APPDATA` and `LOCALAPPDATA` in the shared test harness and registry roundtrip tests so adapter tests cannot read or write real user config roots.
- Kept framework backup files out of native placement assertions in install/uninstall roundtrip coverage.

## 0.4.91 — 2026-06-21

The **surface-broadening** release: **7 new host platforms (35 → 42)** plus wider coverage of
the statusline and actions surfaces. Every new host was verify-first (MCP path / root key / hook
format byte-confirmed from the host's official repo/docs); auth-gated hosts ship at the honest
placement ceiling. (12 PRs; **42 platforms, 3273 tests.**)

### Added — 7 new platforms

- **OpenHands** (All-Hands-AI) — MCP (`~/.openhands/mcp.json`) + Claude-compatible `.openhands/hooks.json` hooks. (#240)
- **Tencent CodeBuddy** — Claude Code fork; MCP + Claude-shaped hooks (byte-confirmed from the shipped bundle). (#241)
- **Grok CLI** (community `grok-dev`) — MCP (`~/.grok/user-settings.json`, nested `mcp.servers`) + Claude-shaped hooks. (#242)
- **Devin CLI** (Cognition) — MCP (`~/.config/devin/config.json`) + Claude-compatible hooks. (#243)
- **Open Interpreter** — Codex-fork; TOML MCP (`~/.openinterpreter/config.toml`, mcp-only). (#244)
- **JetBrains Junie** — MCP (`~/.junie/mcp/mcp.json`), mcp-only; distinct from `jetbrains-copilot`. (#245)
- **Mistral Vibe** — TOML `[[mcp_servers]]` array-of-tables MCP (`~/.vibe/config.toml`), mcp-only. (#246)

### Added — surface coverage

- **statusline** now covers **antigravity-cli** (agy) — first-party documented payload, live-verified against a real `agy` session (2 → 3 hosts). (#236)
- **actions** now covers **pi** (`pi.registerCommand` extension), **zed** (`tasks.json` exec tasks), and **kiro** (`.kiro/hooks` Manual-Trigger shell commands, project-scope) (5 → 8 hosts). (#237, #238, #239)

### Changed

- jetbrains-copilot: dropped the dead `workspace_roots` hook-input fallback (the VS Code `.github/hooks` surface sends only `cwd`; parity with vscode-copilot). (#234)

## 0.4.79 — 2026-06-21

Follow-up to the DX-honesty release — a codex telemetry fix, a remote-transport
telemetry signal, and live-smoke harness expansion. (4 PRs; **35 platforms, 3018 tests.**)

### Fixed

- **codex telemetry under an overridden data root.** codex strips the environment of MCP
  server children, so the telemetry serve-wrap's `agent-connector serve` child didn't inherit
  `AGENT_CONNECTOR_DATA_DIR` and died "Connector not registered" when the data root was
  overridden. The wrap now passes `serve --data-dir <root>` explicitly (gated on a non-default
  root, so default installs stay byte-identical); host-agnostic. Live-verified before/after on
  codex-cli 0.141.0. (#231)

### Added

- **install — note when a remote-transport server skips per-tool telemetry.** A remote
  (http/sse/ws) MCP server registered with telemetry enabled now emits an install-time `warn`
  ("telemetry not captured — stdio-only") instead of silently producing an empty ndjson. (#230)
- **`scripts/verify-host.mjs` — antigravity-cli (agy) + codex deep-verb live-smoke lanes.**
  Two more authed-runtime lanes for the MANUAL harness, each live-verified: agy fires
  PreToolUse/PostToolUse; codex fires all 5 events (via `--dangerously-bypass-hook-trust` —
  codex requires persisted hook trust). Not wired into CI. (#229, #232)

## 0.4.75 — 2026-06-20

The **DX-honesty** release: the framework now surfaces a visible signal everywhere a
host can't honor a declared surface — no more silent failures — plus a committed live-smoke
harness and a real copilot-cli hook-reply fix. (8 PRs; **35 platforms, 3003 tests.**)

### Fixed

- **copilot-cli — a PreToolUse `deny` now actually blocks the tool.** `formatReply` emitted
  a nested `hookSpecificOutput` shape, but Copilot CLI 1.0.63 reads the decision FLAT at the
  top level (`{permissionDecision, permissionDecisionReason, modifiedArgs?}`); and parseEvent
  read snake_case PreToolUse input while the host sends camelCase (`toolName`, JSON-string
  `toolArgs`). Both fixed and live-verified (the deny now blocks). `canInjectSessionContext`
  demoted to false (1.0.63 has no `additionalContext`). (#220)
- **Hooks — a declared event a host can't fire is never silently dropped.** It now surfaces a
  visible `skip` ChangeRecord (exit-0-preserving) instead of vanishing at install, centralized
  via a default-preserving `unmappedAction` seam; the never-silent invariant is enforced
  fleet-wide over all 13 events. (#224)
- **install — warns when an unset `${env:VAR}` would bake an empty secret** into a
  literal-resolving host config (gated by a new `nativeServerEnvInterpolation` capability on the
  5 native-interpolation hosts). (#225)
- **doctor — `doctor --connector <bad-path>` now errors loudly** (exit 2) instead of silently
  reporting on the registered connectors; the implicit auto-discovery fallback is preserved. (#227)

### Added

- **`agent-connector doctor --explain`** — a per-`(host, event)` honored/degraded/dropped
  diagnostic (simulate()-backed), with scope-aware exit semantics (a healthy `targets:auto`
  hooks connector exits 0; an explicitly-targeted *degraded* host exits non-zero). Also fixes
  `explain()`'s hooks **false-green** (it judged the surface by an OR across all events; now
  per-declared-event via `hostCanFireEvent`, which also fixed a latent `postCompact` omission). (#226)
- **`scripts/verify-host.mjs` deep-verb live-smoke lanes** — a committed, repeatable, MANUAL
  (not-CI) harness that drives real authed host CLIs to OBSERVE behavior: mcp tool-load/tool-call,
  per-tool telemetry capture, hook fire + reply-honored, content surfaces, and the full
  install/update/doctor/uninstall lifecycle — with an auth-preserving sandbox + a zero-dep MCP
  echo fixture. (#221)

### Docs

- Runnable `examples/acme-db` (real stub server + package.json), removed the fictional
  `@acme/db-mcp` reference, added a "write your MCP server" on-ramp + the context-mode dogfood
  evidence (~20,322 → ~76 LOC), fixed the version pin. (#222)
- Site: responsive "Two audiences, two tracks" / WHO IT'S FOR section on mobile. (#223)

## 0.4.67 — 2026-06-20

### Fixed

- **copilot-cli — hooks now actually fire.** The adapter wrote `matcher: ""` on every
  hook entry, but GitHub Copilot CLI's hook schema is `matcher: z.string().min(1).optional()`
  — an empty string **fails validation**, so the CLI discarded the *entire* hook file and
  registered zero hooks. Live-verified on CLI 1.0.63 (authenticated session): omitting the
  matcher makes the hook fire. The key is now omitted when empty (at all write sites + the
  uninstall rebuild), and uninstall deletes the empty stub. This was the real reason
  copilot-cli hooks never ran — the earlier camelCase event-key change (#216) is
  canonical-form cleanup, not the cause (both casings work; the hooks schema is
  `.passthrough()`). (#218, #216)
- **antigravity — read the real *nested* hook stdin shape** (`toolCall.name` / `toolCall.args`,
  `conversationId` → sessionId, `workspacePaths[0]` → projectDir, PostToolUse `error`),
  not the flat Claude-shaped fields the host never sends; `antigravity-cli` inherits the fix. (#215)
- **jetbrains-copilot — PostToolUse reads `tool_response`** (the VS Code `.github/hooks`
  dialect it aliases — not the terminal CLI's `tool_result`), dropping the dead
  `tool_output`/`error_message` fallbacks. (#217)
- **CLI uninstall — validate the connector id at the command boundary**, closing a narrow
  path-traversal window on the explicit `--targets` marketplace-uninstall path (the #197/#199
  security follow-up). (#214)

### Internal

- Sync `package-lock.json` to the released version. (#213)

**35 platforms, 2929 tests.**

## 0.4.61 — 2026-06-20

### Fixed — hook wire-contract "false friends" (12 adapters)

A deep, source-verified audit of every adapter's `parseEvent` uncovered a recurring bug
class: an adapter reading Claude Code-shaped hook-stdin field names that the host does
**not** actually emit, so user-facing data (tool output, the user prompt, subagent
identity, failure text) was silently dropped or left empty. Every fix was verified
against the host's **primary source** (its docs or source code) and independently
reviewed; the per-host byte-oracle suites confirm only the runtime parse changed.
Following **kimi** (0.4.44), this release corrects:

- **gemini-cli** — PostToolUse output lives in `tool_response` (`llmContent`/`returnDisplay`), not `tool_output`. (#198)
- **goose** — the UserPromptSubmit prompt rides on `message`, not `prompt`; now reads goose's real `HookContext` struct and drops the phantom fields. (#200)
- **copilot-cli** — VS Code dialect: `tool_result.text_result_for_llm`, `agent_name`, base `transcript_path`; removed the phantom Claude-shaped reads. (#201)
- **cursor** — SubagentStop `summary`, PostToolUseFailure bare `duration`; SessionStart sends no `source`. (#202)
- **hermes** — the host nests per-event kwargs under an `extra` envelope (tool result, subagent child id, session-end flags). (#204)
- **codex** — PostToolUse `tool_response` is a typed value; `is_error` is derived from it. (#205)
- **amp** — the ts-plugin bridge now projects `event.message`→prompt and `event.output`→toolOutput. (#206)
- **openclaw** — the ts-plugin bridge extracts `targetSessionKey` as the subagent_ended identity. (#207)
- **amazon-q** — no `session_id`/`source`/`stop_hook_active` on the wire (documented host gaps). (#208)
- **kiro** — Stop carries `assistant_response`, not `stop_hook_active`. (#209)
- **droid** — SubagentStop carries no `last_assistant_message`; phantom reads removed. (#210)
- **vscode-copilot** — PostToolUse is success-only; removed the phantom reads. (#211)

### Security

- Reject path-traversal connector ids before any record-path construction, and warn-skip
  symlinked write paths across the JSON/TOML/YAML config writers, managed-block files,
  the memory ledger, and framework state (home-bin, connector records, marketplace
  state, configPatch ledger). (#197, #199)

### Added

- **Contributor infrastructure**: `CONTRIBUTING.md` (the verify-first golden rule, the
  single-fork test discipline, the new-host checklist, and the cross-cutting-change
  policy), GitHub issue + PR templates (incl. a host-adapter-request form), and
  `SECURITY.md`. Repo settings refreshed (description, homepage, Discussions, labels,
  branch protection). (#191, #192)

### Internal

- Preserve Vite's auto workspace-root detection when extending Vitest `server.fs.allow`
  for generated temp fixtures (declares `vite` as a direct dev dep for the
  `searchForWorkspaceRoot` import — already a deduped transitive dep). (#203)

**35 platforms, 2916 tests.**

## 0.4.44 — 2026-06-20

### Fixed

- **kimi** — the hook-stdin parser (`parseEvent`) read three field names that don't
  match what Kimi Code actually emits, each silently producing empty/dropped data
  (verified against MoonshotAI/kimi-code source + independently reviewed):
  - **UserPromptSubmit** `prompt` is a `ContentPart[]` array (`[{type:'text',text}]`),
    not a string — the parser only accepted a string, so the prompt was always `""`.
  - **PostToolUse** sends tool output in `tool_output` (string), not `tool_response`
    (which has zero hits in Kimi's source — a Claude Code false-friend) — so the tool
    output was always dropped.
  - **PostToolUseFailure** `error` is a `KimiErrorPayload` object `{code,message,…}`,
    not a string — so the error was always `""`.

  Fix retypes `KimiHookInput` and adds `extractPromptText` / `extractErrorMessage`
  helpers (both keep a defensive string branch — SubagentStart's `prompt` and
  PermissionResult's `error` are genuinely strings). Regression tests cover all three
  shapes plus the empty/non-text/null branches. (#189)

## 0.4.43 — 2026-06-19

A per-host adapter correctness wave: a 35-host audit (dynamic workflow, every
finding adversarially verified against the host's PRIMARY source) surfaced real
bugs in 12 adapters, each fixed as its own PR with a regression test and an
independent review. The recurring lesson — verify, don't assume: roo-code, kiro,
kimi, goose, and codex all turned out DIFFERENT from the audit's surface guess.
**35 platforms**, **2839 tests**. Patch bump sized to the merged-PR count since
0.4.26 (26 + 17 PRs = 43).

### Adapter fixes — config that the host wouldn't load / silently no-op'd

- **cursor** — the package (marketplace/plugin-bundle) emitter wrote `hooks.json`
  in the Claude shape (PascalCase keys, nested entries, no `version`); now emits
  Cursor's flat shape, single-sourced from the install adapter so the two can't
  drift. (#173)
- **qwen-code** — `deny` on Stop / UserPromptSubmit / PostToolUse emitted
  `permissionDecision` (which the host ignores for those events) → silent no-op;
  now uses the top-level `{decision:"block"}` shape, verified against qwen's
  hooks.md. (#175)
- **roo-code** — remote MCP entry lacked the required `type`; Roo Code's schema
  uses the **hyphenated `"streamable-http"`** (not cline's camelCase) and rejects
  any untyped url config, so every remote server was rejected. (#180)
- **kiro** + **amazon-q** — the context reply emitted a fabricated
  `hookSpecificOutput` JSON envelope; both hosts actually read hook context as
  **plain stdout** (verified against kiro.dev and AWS docs), gated to
  agentSpawn/userPromptSubmit. (#181, #186)
- **goose** — advertised `sse`/`http` but always wrote a stdio entry (empty `cmd`
  for remote); now renders remote as Goose's live `streamable_http` (`uri`), drops
  the dead `sse` transport. (#184)
- **kimi** — install scope was incoherent; verified per-surface against the kimi
  source (mcp.json + skills are project-aware, config.toml is user-only) and made
  `getConfigDir`/`getHookConfigPath` consistent. (#182)

### Adapter fixes — paths, capabilities, residue

- **kilo-cli** + **crush** — honor `$XDG_CONFIG_HOME` for the user config dir
  (default case byte-identical); plus a test-harness fix so `freshProject` sandboxes
  `$XDG_CONFIG_HOME` (CI runners leak it). (#179, #183)
- **vscode-copilot** — uninstall deletes the empty connector hooks file + dir
  instead of leaving an orphan `{version,hooks:{}}` shell. (#177)
- **copilot-cli** — warn-skip capability-unsupported hook events (PostCompact)
  instead of writing a dead entry. (#178)
- **hermes** — clamp the per-hook timeout to the documented `[1, 300]`s range. (#185)
- **codex** — `canModifyArgs` enabled (PreToolUse `updatedInput` rewrite, release-
  verified stable since codex rust-v0.131.0, emitted as the required
  `permissionDecision:"allow"`+`updatedInput` pair) + `additionalContext` broadened
  to PreToolUse; `canModifyOutput` confirmed correctly false. (#187)

### Site + docs

- Landing "Coverage" wall grouped by **form factor** (CLI / IDE extension / app),
  with a registry-derived drift guard. (#168)
- Mobile horizontal-scroll fixed (`min-w-0` on three command boxes); the runtime
  Statusline/Actions surfaces set apart on the wall. (#169, #170)
- Dev-docs consistency sweep — 32 fixes + registry-derived drift guards so the
  counts/lists can't rot again. (#171)

## 0.4.26 — 2026-06-19

Post-0.4.8 wave: new host capabilities, correctness fixes surfaced by a fresh
full-host verification campaign, and the committed verification tooling itself.
**35 platforms**, **2794 tests**. Patch bump sized to the merged-PR count since
0.4.8 (8 + 18 PRs = 26).

### Host capabilities

- **Amazon Q — hooks surface** (mcp-only → json-stdio). The agent hook triggers
  (`agentSpawn` / `userPromptSubmit` / `preToolUse` / `postToolUse` / `stop`) are
  wired into the built-in `q_cli_default` agent file via the JSON-over-STDIN +
  exit-code contract (mirrors the sibling AWS host kiro). (#143, closes #22)
- **Amazon Q — agents content surface.** Connector subagents render to
  `cli-agents/<name>.json` agent definitions; the `tools`/`allowedTools` `*`
  wildcard asymmetry is honored and a reserved-name guard protects the hooks
  agent file. (#148)
- **MiMoCode — Stop.** Canonical `Stop` wired to the OpenCode-family `session.idle`
  event, matching the kilo/kilo-cli precedent. (#144)

### Fixes

- **openclaw** — the generated plugin manifest now emits the required
  `configSchema`, so `openclaw config validate` accepts the plugin (it was
  rejected before, so the plugin never loaded). (#147)
- **kimi config dir** — corrected `~/.kimi` → `~/.kimi-code` and dropped the
  non-existent `$KIMI_HOME` (official-docs-verified); the adapter writer and the
  Kimi Code CLI now resolve the same dir. (#151)
- **kimi usage reader** — now covers BOTH Moonshot products: Kimi CLI (`~/.kimi`,
  `StatusUpdate` snapshots, message-id dedup) and Kimi Code (`~/.kimi-code`,
  `usage.record` deltas, summed) — the latter parsed per the readable upstream
  source, with the Kimi CLI path kept byte-identical. (#152, #158)
- **content surfaces** — reject symlinked target paths. (#154)
- **statusline** — lazy-load the telemetry usage summary. (#161)

### Verification (tests + tooling)

- **install-roundtrip harness generalized to all 35 hosts** — a registry-driven
  `describe.each` drives the real `installConnector` → `uninstallConnector` into
  an isolated HOME for every adapter and asserts on-disk placement + zero residue
  (binary-free). (#145)
- **`scripts/verify-host.mjs`** — a committed live host-CLI driver plus
  reproducible pinned-binary install lanes; 20 host CLIs live-verified across the
  config-acceptance / live-hook-firing / install-placement tiers. (#146, #149, #150)

### Internal / docs

- marketplace drivers derived from the adapter registry. (#163)
- dev-dependency audit advisories cleared. (#159)
- surface-support descriptions + README refreshes — paradigm table, stale test
  count, and the verification section. (#156, #165, #166)

## 0.4.8 — 2026-06-18

The second consolidation wave. One user-facing correctness fix (codex
`$CODEX_HOME` resolution); everything else is **byte-identical** internal
dedup — every migrated host's existing test suite passes unchanged, and the
generated artifacts are verified equal to the prior output byte-for-byte.
**35 platforms**, **2710 tests**. No new host features, so the patch stays a
single increment (0.4.7 → 0.4.8).

### Fixes

- **codex `$CODEX_HOME` is now resolved consistently.** The codex config
  **writer** (where the MCP server entry is written) and the marketplace
  **detection probe** (where an existing install is found) previously resolved
  `$CODEX_HOME` with different rules, so a tilde (`~/cx`) or relative
  (`rel-codex`) value made them target different directories — the writer could
  land a `config.toml` somewhere the probe never looked. Both now route through
  one `codexConfigHome()` resolver (tilde-expanded, then resolved; empty/unset →
  `~/.codex`). Absolute, already-canonical `$CODEX_HOME` values are unaffected.
  (#138)

### Internal — shared engines, wave 2 (behavior-preserving)

Continuing the 0.4.7 consolidation: per-host logic that had been hand-rolled
across adapters is lifted into shared, audited helpers. Every migration is
**byte-identical**, verified by the host's own unedited test suite plus
independent review:

- **`renderSkillMd` / `renderSubagentMd`** — the skill- and subagent-markdown
  emitters, adopted across 22 hosts (rank 4). (#135)
- **`renderCommandMd` (parameterized) + `renderOpenCodeSubagentMd`** — the
  command-markdown emitter gains an `includeToolsAndModel` switch, and the
  OpenCode-shaped subagent renderer is shared (rank 5). (#136)
- **`core/host-paths.ts`** — shared OS user-config-base resolvers
  (`xdgConfigHome` / `roamingAppData` / `localAppData` / `codexConfigHome`),
  adopted in 4 hosts; the codex resolver also backs the fix above (rank 7).
  (#137)
- **`buildWrappedStdio`** — the telemetry serve-wrap decision (route a stdio
  command through `serve --connector` when telemetry is on, else pass through),
  lifted out of 31 adapters into one `core/spawn.ts` helper; each host keeps its
  own command/args seeding and entry shaping (rank 6). (#140)
- **`normalizeSessionSource`** — the SessionStart `source` normalizer, lifted
  into `claude-code/wire.ts` and shared by 15 hosts (rank 8). (#139)
- **`renderBridgePrelude`** — the byte-identical head of every ts-plugin host's
  generated plugin module (the `HOME_BIN`/`CONNECTOR_ID` consts + the cross-OS
  `bridge()` entrypoint), extracted into `core/ts-plugin-bridge.ts` and adopted
  by 6 ts-plugin hosts; `openclaw`'s wrapper-variant bridge is intentionally
  left as-is (rank 9). (#141)

This completes the commonization arc begun in 0.4.7 (ranks 1–9).

## 0.4.7 — 2026-06-18

A correctness fix plus a large internal consolidation. The one user-facing
behavior change is the malformed-root config guard (below); the engine
extractions are **byte-identical** refactors — every migrated host's existing
tests pass unchanged — and the rest is test-suite infrastructure.
**35 platforms**, **2701 tests**. No new host features, so the patch stays a
single increment (0.4.6 → 0.4.7).

### Fixes

- **Malformed config root keys no longer cause silent data loss or crashes.**
  When a user had hand-edited an MCP **server** config so the root key
  (`mcpServers` / `servers` / `mcp` / `context_servers` / …) was the wrong type —
  an array or a primitive — installing a server bolted a named property onto it
  that `JSON.stringify` silently dropped (reported as a false `create`), or threw
  under strict mode on a primitive. The same bug class lived on the **hook**
  config root and its per-event buckets. Both are now guarded across the whole
  fleet: JSON object-map hosts **warn-and-skip** (your file is left untouched with
  an actionable message); TOML/YAML hosts (codex, goose) coerce a malformed root
  to a fresh container — never throw, never silently drop. Well-formed configs are
  byte-for-byte unchanged. (#122, #123)

### Internal — shared engines (behavior-preserving)

The per-host config-write logic that had been hand-rolled across adapters is now
consolidated into shared, audited engines. Every migration is **byte-identical**,
verified by the host's own unedited test suite plus independent review:

- **`core/object-map.ts`** — a format-agnostic upsert/remove engine that owns the
  create/skip/update decision plus the overwrite- and malformed-root guards. The
  26 JSON server hosts bind it (on-disk output unchanged); **codex** (TOML) and
  **goose/hermes** (YAML) bind it through a codec, deleting their hand-rolled
  loops. (#124, #126)
- **`core/hook-array.ts` + a `HookMergeDescriptor` orchestration** — the
  hook-config merge (create/skip/update + inner-strip uninstall) for six hosts —
  **claude-code, droid, cursor, qwen-code, codex, goose** — now flows through one
  engine; each host supplies only a descriptor of its observable strings and
  ownership predicates. Hosts with genuinely divergent shapes (gemini-cli,
  antigravity(+cli), jetbrains-copilot, kimi) stay hand-rolled by design. (#127–#133)

### Tests

- **One file per host.** Every adapter now has a single
  `tests/adapters/<host>.test.ts` on a shared harness (`tests/support`), and the
  cross-cutting batch files were dissolved into **registry-driven contracts**
  (`tests/contracts/*.contract.test.ts`, `describe.each(ADAPTER_REGISTRY)`) so
  adding or removing an adapter auto-applies the same coverage. (#81–#121)
- New correctness contracts (`root-key-malformed`, `hook-root-malformed`) and
  per-host detail-string pins lock the fixes above against regression.
- Marketplace tests consolidated with install-verification; a headless CLI
  install smoke suite (`tests/integration/cli-install-smoke.test.ts`).

## 0.4.6 — 2026-06-17

The Tier 1–3 surface-gap supplementation — bundled into one PR (#78) but covering
**five distinct host-feature work-units**, so the patch jumps 0.4.1 → 0.4.6
(+1 per unit): codex HTTP MCP · amp ts-plugin · openclaw+nemoclaw hooks ·
kilo+kilo-cli hooks · codebuff subagents. Every change was verified against
a primary source — official docs or a **live host binary** — before implementation;
candidates that could not be verified are documented as honest defers, not guessed.
**35 platforms**, **2169 tests** (2170 on Windows). Final adversarial review vs
0.4.1 returned 0 blockers / 0 majors.

### MCP transport

- **codex** now registers **streamable-HTTP** MCP servers in `config.toml`
  (`[mcp_servers.<id>]` `{ url, bearer_token_env_var?, http_headers? }`, no
  explicit transport key — codex infers it from `url`). Previously every non-stdio
  transport was silently skip-warned despite the advertised `http` capability.
  Verified against a live `codex-cli 0.139.0` (`codex mcp add … --url …
  --bearer-token-env-var …`); `AuthSpec.bearerEnv → bearer_token_env_var`,
  `ServerDef.headers → http_headers`. sse/ws stay report-don't-drop skip-warns.

### Hooks

- **amp**: mcp-only → **ts-plugin**. Loads a generated `.amp/plugins/<id>.ts`
  wiring the five `amp.on` lifecycle events with a canonical analog —
  `session.start`→SessionStart (id = `event.thread.id`), `agent.start`→
  UserPromptSubmit, `tool.call`→PreToolUse (blocks via amp's documented
  `{ action: "reject-and-continue" }` union), `tool.result`→PostToolUse, and
  `agent.end`→Stop. No `session.end` exists, so SessionEnd is an honest gap.
  `tool.result`'s replacement object shape is undocumented, so PostToolUse is
  observe-only (`canModifyOutput:false`) rather than ship a guessed mutation.
  Verified against ampcode.com/manual.
- **openclaw + nemoclaw**: **UserPromptSubmit** (→ `before_prompt_build`, per-turn
  context injection, coexisting with the one-time SessionStart context) and
  `supportsNativeHooks`. nemoclaw inherits the whole machinery.
- **kilo + kilo-cli**: **UserPromptSubmit** (→ `chat.message`),
  **PermissionRequest** (→ `permission.ask`, mutates `output.status`), and
  **Stop** (→ `session.idle`, via the generic `event` hook). Verified against
  kilo.ai/docs.
- **opencode**: a forward-migration TODO for a native SessionStart hook
  (anomalyco/opencode #14808/#5409); the surrogate stays correct until then.

### Subagents

- **codebuff** now emits native `.agents/<id>.ts` AgentDefinition modules
  (`export default` object, no type-only import; `model`/`toolNames` omitted when
  the connector declares none — nothing fabricated). Verified against
  codebuff.com/docs.

### Verified non-gaps / honest defers (documented, not implemented)

- **windsurf actions** — Cascade workflows are manual-only prompt macros (already
  covered by `supportsCommands`); an "actions" surface would be a degraded
  duplicate.
- **kimi plugins** — covered by `package --format kimi-plugin`; a runtime install
  surface is below the ≥3-host promotion bar.
- **grok / droid-statusline / cursor-statusline** — need a live host binary to
  confirm the contract; deferred until that access exists.

## 0.4.1 — 2026-06-16

A hooks-depth release: the lifecycle-hook model is completed across every
paradigm, a full fleet surface-gap audit was primary-source-verified and its real
gaps supplemented (10 false-positives rejected with evidence), and **Continue**
graduates from mcp-only to a full hooks host. **35 platforms**, **2109 tests**,
verified end-to-end against real host CLIs.

### Continue — mcp-only → json-stdio hooks

- **continue** now installs a Claude-Code-compatible lifecycle-hook layer
  (`~/.continue/settings.json`, separate from the MCP `config.yaml`): the 12
  canonical events Continue supports + PreCompact, plus a nativeHooks passthrough
  for its 5 host-specific events (ConfigChange / TeammateIdle / TaskCompleted /
  WorktreeCreate / WorktreeRemove). The MCP install is byte-untouched
  (continuedev/continue PR #11029, primary-source verified).

### Hook-event model — completed across paradigms

- **PostCompact** joins the normalized union (13 canonical events).
- **vscode-copilot** / **jetbrains-copilot**: a post-execution / turn-control deny
  (PostToolUse / UserPromptSubmit / Stop / SubagentStop) now blocks via the
  top-level `{decision:"block"}` contract — a `permissionDecision` there was a
  silent no-op. jetbrains-copilot reaches full vscode-copilot parity (SessionEnd,
  UserPromptSubmit, ErrorOccurred nativeHook).
- **nativeHooks** opt-ins for host-specific events with no canonical analog:
  copilot-cli + jetbrains-copilot (`ErrorOccurred`), qwen-code (`TodoCreated` /
  `TodoCompleted` / `StopFailure`), and — via the generated ts-plugin bridge —
  omp (`agent_start` / `turn_*`) and opencode (25+ host events).
- **goose** (SessionEnd / UserPromptSubmit / Stop), **qwen-code** (PostCompact),
  **opencode** (PermissionRequest → `permission.ask`), and **mimo-code**
  (UserPromptSubmit → `chat.message`) wired.

### MCP transport correctness

- **openclaw** / **nemoclaw** emit the canonical `streamable-http` remote literal
  (the validator rejects a bare `http`); **omp** emits the required `type`
  discriminator (a type-less remote entry was mis-parsed as stdio); **hermes**
  registers remote HTTP servers (advertised but previously skipped); **copilot-cli**
  adds the legacy `sse` transport.

### Content surfaces

- **windsurf** commands (workflows: `.windsurf/workflows` + `~/.codeium/windsurf/
  global_workflows`) and skills (`.windsurf/skills` + the global dir), workspace +
  user scope, honoring the documented 12,000-char workflow limit.

### Surface-gap audit + verification

- A full fleet surface-gap audit (all hosts) was primary-source-verified before any
  fix: 17 real gaps supplemented, 10 false-positives **rejected with evidence**
  (e.g. amazon-q / cline hooks, gemini AfterAgent ≠ Stop), and the genuinely-
  deferred items documented under `docs/research/audits/`.
- A real-CLI runtime-verification harness validated hook dispatch end-to-end as
  real processes against installed host CLIs.
- Hardening: `hooks:false` now reliably disables canonical handlers on the ts-plugin
  hosts even when a plugin is synthesized for actions (openclaw/nemoclaw).

### Docs

- Adapter capability comments corrected (codebuff subagents, cursor native hooks,
  amazon-q agents/prompts); paradigm tables + event/platform counts synced across
  README, llms.txt, `types.ts`, and the hooks matrix.

## 0.4.0 — 2026-06-15

The largest release since the public launch: **29 → 31 platforms**, ten
host-gap content surfaces closed, three new declarable surfaces (statusline,
actions, plus the Connector SDK), and a HostCtx unification. Natively verified
on Linux, Windows, and macOS (**1727 tests**), with live install + activation
against real host CLIs.

### Platforms — 29 → 31 (MiMoCode + NVIDIA NemoClaw)

- **mimo-code** — Xiaomi MiMoCode (`@mimo-ai/cli`, bin `mimo`), an OpenCode
  fork. STANDALONE `ts-plugin` adapter (OpenCode's module-const HOST binding
  can't be cleanly subclassed): config `~/.config/mimocode/mimocode.json`, MCP
  root key `mcp`, bridge dispatches `hook mimo-code`.
- **nemoclaw** — NVIDIA NemoClaw, an orchestrator that wraps OpenClaw. Thin
  fork extending `OpenClawAdapter` (id/name/detection only); inherits the
  dual-registration into the wrapped `~/.openclaw/openclaw.json`.
- `OpenClawAdapter` hardened for a correct fork (zero-change for openclaw):
  `this.id` threaded through the server/hook/bridge/parseEvent paths (so a
  nemoclaw install routes to the nemoclaw id), and `detectInstalled` bows out
  when `~/.nemoclaw/` is present so the shared config is never double-targeted.
- Every config path/root-key was source-verified against the upstream repos
  before wiring (no guessed paths).

### Ten host-gap content surfaces closed (7 hosts)

- Now installed where the host natively reads them: **droid**
  commands/skills/subagents (`.factory/{commands,skills,droids}`), **roo-code**
  commands/skills (`.roo/…`), **trae** skills, **codebuff** skills
  (`.agents/skills`), **openclaw** skills (`<workspace>/skills`) → **nemoclaw
  inherits** it, **amp** skills (`~/.config/agents/skills`), **goose** skills.
  Each cell was contract-verified against primary sources before wiring.
- The remaining wall gaps are honest, documented non-gaps (no on-disk surface
  to write): warp commands, trae/openclaw subagents, amp hooks, amp subagents,
  codebuff subagents.

Three new surfaces, a Connector SDK, and a HostCtx unification.

### Statusline (HUD) surface

- Connectors declare a `statusline` function that receives a `StatuslineContext`
  (model, cost, token counters, session metadata) and returns a plain string or
  `{ text; tooltip? }` — rendered as a live status-bar HUD by each host that
  offers the affordance.
- `defineStatusline(fn)` is the typed authoring helper, exported from the root
  AND `/sdk`.
- Install wires the statusline on supporting hosts; `doctor` drift-checks the
  registered value; `explain()` lists it per-host.
- **v1 caveat**: `ctx.context` (`usedTokens`/`maxTokens`/`percent`) is reserved
  for a future AC-usage integration — it is not populated in v1. Use
  `ctx.cost?.totalUsd` or `ctx.model?.displayName` instead.

### Connector SDK (`/sdk` + `/sdk/test` subpaths)

- New `/sdk` subpath export with the full `define*` family:
  `defineConnector`, `defineStatusline`, `defineAction`,
  `defineHook`, `defineCommand`, `defineSkill`, `defineSubagent`,
  `defineMemory`, `defineConfigPatch`, `defineNativeHook`. The root
  export now carries the same full family (previously root-only was
  `defineConnector`).
- **Introspection helpers**: `capabilitiesOf(connector)` returns a
  `SurfaceName[]` of declared surfaces; `hostsSupporting(surface)`
  returns the host list that honors it. `SurfaceName` vocabulary:
  `server | hooks | commands | skills | subagents | memory | statusline |
  configPatch | nativeHooks | actions`.
- **Offline harness** (`/sdk/test`): `explain(connector)` prints a
  per-host surface/skip-warn table (including action rows — all
  skip-warned in v1); `simulate(connector, event, payload)` runs a
  hook or statusline call offline and returns the verdict without a live
  host. Actions are intentionally excluded from `simulate` (they take
  no host payload).
- `toolName(name)` and `style(text, style)` authoring helpers for
  consistent naming and formatting across hosts.

### Per-host `hosts:` override map

- Connectors can now supply per-host overrides under a `hosts` key:
  fine-grained hook handler overrides, a per-host `statusline` variant,
  and per-host `actions.run` overrides. This replaces the need to
  branch inside a single function on `ctx.host`.

### Actions surface — dispatch backbone (`action` verb)

- Connectors declare `actions?: ActionDef[]`. Each entry:
  `{ id: string; description?: string; run: (ctx: HostCtx) => ActionResult | void | Promise<…>; hosts?: per-host run override }`.
  `ActionResult = { message?: string }`.
- `defineAction({ id, run })` is the typed authoring helper.
- Universal CLI verb: `agent-connector action <platform> <actionId>
  --connector <id>` loads the connector and calls `run(ctx)`. Error
  semantics are user-triggered (not fail-silent): unknown action id or a
  thrown error → exit 1 + stderr.
- `actions` is part of the `SurfaceName` introspection vocabulary;
  `explain()` emits action rows (skip-warned on every host in v1 — the
  host affordance emitter, e.g. slash-command or keybinding generation,
  is a later phase). `simulate()` does not cover actions by design.
- **v1 is the dispatch backbone only**: `install` skip-warns on every
  host because no host affordance emitter exists yet. Document and use
  it via the `action` verb directly.

### HostCtx unification

- Hook events now carry `capabilities` (the host's `SurfaceName[]`),
  `scope` (project vs global), and `telemetry` metadata on the context
  object passed to every handler.
- `ctx.telemetry()` accessor returns the current session's
  `TelemetryUsageSummary` synchronously. `TelemetryAccessor` and
  `TelemetryUsageSummary` are exported types (root + `/sdk`).

### Verification

- Native full suite green on all three OSes: Linux (Node 18), Windows
  (Node 24), and macOS (Node 26) — **1727 tests**, `tsc` clean, build green.
  (The macOS run caught and fixed one latent macOS-only test-path bug in the
  zed usage reader fixture; the reader itself was correct.)
- Live install + activation against **real host CLIs** in isolated HOMEs
  (claude-code, codex, opencode, gemini) — each CLI loaded the connector via
  its own `mcp list` handshake; clean uninstall with no leak into real configs.
- Landing + guide pages re-synced to the shipped surface set (statusline /
  actions / the `/sdk` authoring subpath) ahead of release.

## 0.3.1 — 2026-06-14

Marketplace/plugin driver expansion — and the cross-OS hardening that came with
verifying it live on Linux, native Windows, AND macOS.

### Marketplace install — 4 → 10 drivable hosts (3 driver shapes)

- A `MarketplaceDriver` abstraction with three shapes drives each host's own
  plugin flow end-to-end: CATALOG (`claude-code`, `codex`, `droid`), DIRECT
  install-by-path (`antigravity`/`-cli`, `gemini-cli`, `qwen-code`), and the new
  NPM-LOCAL `file://` config-array entry (`opencode`, `kilo`, `kilo-cli`).
- **Live-verified end-to-end** against the real host binaries: claude-code,
  codex, antigravity on Linux + Windows + macOS; opencode (npm-local) on Linux +
  Windows; gemini-cli on Linux. `droid` + `qwen-code` ship the driver with
  mock-CLI tests, pending a live host (auto-promote when the binary is present).
- Left as honest manual-hint (not headless-drivable): cursor (GUI), pi
  (registry-only, no hook layer), vscode-copilot / openclaw / omp (no plugin CLI).

### Cross-OS path-canonicalization fixes (found by the Windows + macOS sweep)

- Hosts canonicalize the path they record differently per OS — none string-equal
  our staging path. **Windows**: codex's `\\?\C:\…` source + npm-local's
  `file:///C:/…` entries. **macOS**: codex's `/private/var/…` realpath for a
  `/var/folders/…` staging dir. Unified fix: `samePath` + the npm probe strip
  the win32 `\\?\` prefix, decode `file://` via `fileURLToPath`, then normalize
  both sides with `realpathSync.native` (symlink + 8.3 + case), lexical
  `resolve()` fallback. The `agy` import manifest is read at both its win32 and
  posix locations; `agy` hooks.json moved to the bundle root.
- `doctor` no longer false-FAILs a marketplace-installed connector (the surfaces
  are delivered via the plugin, not the direct config) — generalized to all
  drivable hosts.

### Gemini CLI marked legacy

- Gemini CLI is sunsetting toward Google Antigravity; the driver is KEPT for
  existing installs but labeled legacy throughout. gemini ≥ 0.41 adds a
  folder-trust prompt `--consent` doesn't cover — the driver degrades to an
  actionable warn (no hang), pointing at the one-time trust or the
  `security.folderTrust.enabled` setting.

## 0.3.0 — 2026-06-14

Everything below was dogfooded and verified in isolated-home installs — and,
for the marketplace drivers, end-to-end against the real host CLIs on both Linux
and native Windows.

### Marketplace install — now drives codex + agy, not just Claude Code

- **`install --method marketplace` drivers for codex and agy/Antigravity.** A new
  `MarketplaceDriver` abstraction (Claude Code refactored onto it, behavior
  unchanged) lets the marketplace method DRIVE each host's own plugin flow
  end-to-end. Drivable hosts: `claude-code`, `codex`, `antigravity`,
  `antigravity-cli`. codex mirrors the catalog flow (`codex plugin marketplace
  add` + `plugin add <id>@agent-connector`, state in `config.toml`); agy is a
  direct install-by-path driver (`agy plugin install <dir>` + `plugin uninstall
  <id>`, fully idempotent). `uninstall --method auto` reverses whichever is
  present; the bidirectional double-install guard and `doctor` cover all three.
  Mechanics confirmed live (codex-cli 0.139.0, agy 1.0.7) and re-verified on
  native Windows.
- **Windows fixes for the codex + agy drivers** (caught by native-Windows E2E):
  codex canonicalizes its config.toml marketplace `source` to the extended-length
  `\\?\C:\…` form — the registration probe now compares paths with a `\\?\`-aware
  `samePath()` instead of exact string equality. agy records its import manifest
  at `~/.gemini/config/import_manifest.json` on Windows vs `…/config/plugins/` on
  POSIX — the probe now reads both, with a plugin-dir fallback.
- **`doctor` no longer false-FAILs a marketplace-installed connector.** A
  marketplace install delivers its surfaces via the host's plugin, not the direct
  config the adapter's `doctor` inspects; doctor now skips the direct checks when
  a connector is marketplace-installed and reports health via per-host marketplace
  checks (generalized from claude-code to codex/agy). Fixes a pre-existing
  false-FAIL that affected Claude Code too.

### Host-native surfaces — closed the adapter gaps

- **kilo-cli** (an OpenCode fork) now wires `commands` (`.kilo/command/`),
  `skills` (`.kilo/skills/`), and `subagents` (`.kilo/agent/`, `mode:subagent`) —
  previously hooks-only.
- **kilo (Kilo Code VS Code ext)** 7.x is rebuilt on the Kilo CLI server: paradigm
  changed `mcp-only → ts-plugin`, adding `hooks` (`.kilo/plugin/`) and `skills`.
- **pi** gains a `commands` surface (prompt templates: `.pi/prompts/`,
  `~/.pi/agent/prompts/`) and a fixed user-scope skills path (`~/.pi/agent/skills/`,
  was the dead `~/.pi/skills/`); allowed-tools render space-delimited.
- **skills surface** wired for `warp`, `kiro`, `zed`, `qwen-code`, `kimi`.
- **agy-plugin** emits `hooks.json` at the bundle ROOT (agy 1.0.7 silently ignores
  `hooks/hooks.json`).
- **npm-plugin** README documents the live-verified local install path
  (`opencode plugin --global file:///<dir>` / `kilo …`).

### Site + SEO

- "Works with 29 agents" wall with 3-state per-surface chips (supported /
  host-has-it-we-don't / host-doesn't-offer-it), drift-guarded; mascot in the
  hero; SEO prerender (200 routes, sitemap, robots, per-route meta, og).

## 0.2.0 — 2026-06-11

The "every surface, every hook, standards-first" release. Everything below was
dogfooded against real migrations (context-mode, oh-my-claudecode) and verified
in isolated-home installs before landing.

### New surfaces

- **`memory` surface — AGENTS.md-first managed guidance blocks.** Declare
  standing guidance once (`memory: [{ content }]`); each host adapter writes it
  as a marker-fenced, hash-stamped managed block into the memory file that host
  actually reads — the standard `AGENTS.md` on the 27 hosts that read it,
  `CLAUDE.md` on Claude Code (which does not read AGENTS.md; an existing
  `@AGENTS.md` import is auto-respected, and an opt-in `agents-import` mode
  manages the bridge line), `GEMINI.md` on Gemini CLI. User edits inside a block
  are detected (hash) and never clobbered (`--force` overrides with a backup);
  uninstall restores files byte-identically; multiple connectors coexist in one
  file. Per-platform `path` override for custom placements (e.g. nested
  monorepo `packages/api/AGENTS.md`).
- **`configPatch` — ownership-tracked host-config key patches (claude-code
  v1).** Reach host-exclusive settings keys (e.g. `statusLine`) declaratively:
  dotted leaf path, fixed *set-if-absent + skip-warn* semantics (never
  overwrites, deletes, or deep-merges), refcounted ownership ledger so
  uninstall removes a key only when this connector created it and the value is
  unchanged, a sensitive-key denylist (`permissions*`, `apiKey*`,
  `env.*TOKEN*`, …), and doctor drift checks. Multi-verified against a survey
  of real MCP servers before building.

### Hooks

- **Normalized hook union 8 → 12**: `PermissionRequest` (allow-grant / deny /
  fall-through-to-dialog), `PostToolUseFailure` (feedback-only),
  `SubagentStart` (context into the subagent), `SubagentStop` (Stop semantics).
  Wired natively on every host with an analog (codex, cursor, vscode-copilot,
  copilot-cli, qwen-code, kimi, openclaw, droid, hermes, goose, …); skip-warned
  where absent.
- **`nativeHooks` passthrough**: wire ANY host hook event the union doesn't
  normalize — `platforms["claude-code"].nativeHooks` covers all 30 current
  Claude Code events (and future ones, with zero agent-connector releases):
  raw payload in, returned JSON out verbatim, fail-open. Collisions with
  normalized events are config errors; unsupported hosts skip-warn.
- **Fix: event-aware deny on Claude Code.** Stop / UserPromptSubmit /
  PostToolUse denies now emit the top-level `{"decision":"block"}` Claude
  honors (previously every deny rendered as `permissionDecision`, which Claude
  ignores outside PreToolUse — this silently broke Stop-blocking persistence
  loops like oh-my-claudecode's ralph).

### Fixes

- `doctor` respects connector-declared `targets` (no more red-flagging hosts a
  connector never targeted) and health checks only assert surfaces the
  connector declares — registry-wide (server entries, hooks files).
- `usage`/`leaderboard` no longer crash on large real-world host histories
  (reader merge used spread-args; now loop-merged — verified against a 50B-token
  log set).
- `./package.json` subpath export; Windows 8.3 short-path import guards.

### Docs & site

- Docs split into two clickable tracks at the route level —
  [/docs/dev](https://agent-connector.ai/docs/dev) (MCP developer) and
  [/docs/user](https://agent-connector.ai/docs/user) (agent-CLI user) — with a
  persona chooser at /docs and 1:1 legacy-URL redirects.
- Quick starts now teach the full lifecycle (install → doctor --probe →
  upgrade → uninstall) and the MCP-standard artifacts.

### Breaking

- None intended. All config additions are optional; existing connectors
  resolve and install unchanged. (The package was renamed to
  `@ken-jo/agent-connector` at 0.1.0; the unscoped `agent-connector` name
  remains as a deprecated redirect.)

## 0.1.0 — 2026-06-10

Initial public release: 29-platform deploy from one `defineConnector()`
(server / hooks / commands / skills / subagents), telemetry serve proxy +
`usage` host readers + three leaderboards, packaging (9 host formats + MCP
Registry `server.json` / `.mcpb`), branded CLIs via `createConnectorCli`.
