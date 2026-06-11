# Changelog

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
