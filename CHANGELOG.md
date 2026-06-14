# Changelog

## Unreleased

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
