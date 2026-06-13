# Plugin / Marketplace Install Verification Matrix

Date: 2026-06-13. Owner mandate: confirm whether plugin-install and
marketplace-install verification has actually been performed per host/format,
and close every gap closable on this box.

## Verification levels

| Level | Meaning |
|---|---|
| **L1** | Bundle emitted by `agent-connector package` + the host's own validator passes |
| **L2** | The host's own CLI installs the bundle, lists/recognizes it, and uninstall reverses cleanly (zero residue) |
| **L3** | Full E2E through OUR CLI: `agent-connector install --method marketplace` (incl. uninstall reversal) |
| **docs-only** | Host binary absent on this box — emit verified where possible; what WOULD verify it is recorded |

Method used for every live lane: isolated `mkdtemp` HOME (+ the host's own
config-dir override env where one exists — `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
etc., confirmed in each adapter under `src/adapters/`), a tiny test connector
(stdio server `node -e` keepalive + 1 `SessionStart` hook + 1 command +
1 skill where the format carries them), `node dist/cli.js package --format
<fmt> --out <sandbox>` (dist confirmed current vs src), then the HOST's OWN
install/list/uninstall commands. Every host-CLI call was wrapped
`timeout 180 ... </dev/null` with capped output; only self-created sandbox
dirs were removed. Real homes were never touched.

## The matrix

| Host | Format | Level | Evidence summary | Host limits | Date |
|---|---|---|---|---|---|
| claude-code (v2.1.173) | claude-plugin | **L3** | Full E2E through our CLI: `install --method marketplace` → `claude plugin list` shows enabled → double-install guard fires → `doctor` clean → uninstall reverses with zero residue. Only host with a live marketplace driver in v1. | none blocking | prior session (recorded 2026-06-13) |
| codex (0.139.0) | codex-plugin | **L2** | `codex plugin marketplace add <bundle>` accepted the catalog at `.agents/plugins/marketplace.json`; `plugin add lane-codex-test@agent-connector` installed to versioned cache with ALL 5 payload files intact; `plugin list` → installed, enabled 0.0.1; double-add idempotent (exit 0); `plugin remove` + `marketplace remove` → 0 files, 0 config residue (only 2 empty dirs — codex quirk). Prior catalog-location fix RE-VERIFIED live against the current emitter. | Our CLI's marketplace driver is claude-code-only in v1, so L3 unreachable (our scope, not a codex defect). Runtime activation (MCP spawn / hook firing / slash command in-session) not exercised — needs an authenticated interactive session. Codex refuses PATH-alias helper bins when `CODEX_HOME` is under /tmp (warning only). `marketplace remove` leaves empty cache dirs. | 2026-06-13 |
| gemini (gemini-cli 0.36.0) | gemini-extension | **L2** | `gemini extensions validate` → "successfully validated" EXIT=0. `install --consent` → installed and enabled; install banner enumerated MCP server, GEMINI.md context, hooks warning, and the agent skill. `extensions list` → ✓ lane-gem-test (1.0.0), all surfaces recognized; all 5 bundle files copied verbatim. Double-install guarded ("already installed"). Uninstall → "No extensions installed", dir gone, enablement back to `{}`. | L3 unreachable (v1 driver scope). Runtime activation not verified (needs authenticated session). `extensions list` never enumerates hooks/commands — recognition for those is install-banner + file presence. Non-interactive installs require `--consent` (stdin EOF safely aborts). Host leaves a stale hash in its own `extension_integrity.json` after uninstall (host bookkeeping, not our files). | 2026-06-13 |
| agy (Antigravity CLI 1.0.7) | agy-plugin | **L2** | `agy plugin validate` → ok: skills 1, commands 1 (converted to skills), mcpServers 1 — but **hooks: skipped (not found)** as emitted (see Bug 1). `plugin install` → ok; `plugin list` → components [skills, commands, mcpServers]; files at `~/.gemini/config/plugins/<name>/` tracked in `import_manifest.json`. Uninstall → "No imported plugins.", 0 files, manifest `{"imports": null}`. FIX-PROOF: same bundle with `hooks.json` at the BUNDLE ROOT → validate AND install report "hooks: 1 processed", components include hooks; re-install idempotent; uninstall again clean. | L3 unreachable (v1 driver scope). Runtime firing not exercised (needs live session). agy copies even unrecognized files verbatim and IGNORES `hooks/hooks.json` silently — the bug is invisible unless you read the component list. Re-install is a silent idempotent overwrite (no double-install warning). No dedicated config-dir env; isolation via HOME override (agy roots at `~/.gemini/`). | 2026-06-13 |
| opencode (1.17.0) | npm-plugin | **L2** | L1: emitted package passes `node --check` + `npm pack --dry-run` (valid 5-file tarball); module contract verified (default-export factory → `experimental.chat.system.transform`; fail-open without home bin); LIVE bridge test spliced real SessionStart context through the home binary's dispatcher. L2: `opencode plugin --global file:///<dir>` → exit 0, written to `opencode.jsonc` plugin array; load proven via marker plugin factory-invoked at `opencode run` bootstrap, zero errors at DEBUG for our bundle. Bare absolute paths also accepted. Uninstall = empty the array (no remove verb); re-run confirmed no load. | Expected "registry-only `plugin` verb" limit does NOT hold on current versions — `file://` URLs AND bare absolute dir paths are accepted (research correction). Bundled `skills/` genuinely ignored by opencode (`debug skill` lists only built-ins) — emitter's documented limit is accurate. 1 command + MCP not bundled in this format (emitter prints honest notes). No uninstall verb — removal is manual config-array editing. | 2026-06-13 |
| kilo (7.3.16) | npm-plugin | **L2** | `kilo plugin --global file:///<dir>` → exit 0, written to `~/.config/kilo/opencode.json` plugin array; `kilo debug config` resolves the entry. DIRECT load proof from kilo's own logs at `kilo run --print-logs --log-level DEBUG`: `service=plugin path=file://... loading plugin` + marker factory fired. Uninstall: emptied the array; re-run shows zero plugin-load lines, no marker. | Same shape as opencode (fork): no remove verb; same npm-plugin format limits (skills/commands/MCP not carried). | 2026-06-13 |
| qwen (Qwen Code) | qwen-extension | **docs-only** (emit verified) | Binary absent on this box. Emit half of L1 done live today: `package --format qwen-extension` → `qwen-extension.json` (inline mcpServers + `contextFileName: QWEN.md`), `QWEN.md`, `commands/<n>.md`, `skills/<n>/SKILL.md`, `hooks/hooks.json`; manifest is valid JSON with the gemini-family shape (qwen is a gemini-cli fork; emitter shares `src/core/package-formats/gemini.ts`). | No host validator available without the binary. | 2026-06-13 |
| kimi (Kimi CLI) | kimi-plugin | **docs-only** (emit verified) | Binary absent. Emit half of L1 done live today: `package --format kimi-plugin` → `kimi.plugin.json` (`skills: "./skills/"` + inline mcpServers) + `skills/<n>/SKILL.md`; valid JSON. Emitter honestly drops commands/hooks with explicit notes ("Kimi plugins ignore commands/hooks") — skills + MCP only by design. | No host validator available without the binary. | 2026-06-13 |
| droid (Factory CLI) | factory-plugin | **docs-only** (emit verified) | Binary absent. Emit half of L1 done live today: `package --format factory-plugin` → `.factory-plugin/plugin.json`, `commands/`, `skills/`, `hooks/hooks.json`, `mcp.json`, plus repo-root `marketplace.json` catalog; all JSON valid. Packager prints the exact install commands (`droid plugin marketplace add <out>` then `droid plugin install <name>@agent-connector`). | No host validator available without the binary. | 2026-06-13 |
| cursor (Cursor IDE) | cursor-plugin | **docs-only** (emit + file-ops placement verified) | Binary/GUI absent. Emit half of L1 done live today: `.cursor-plugin/plugin.json` (pointer fields), `commands/`, `skills/`, `hooks/hooks.json`, `mcp.json`, `.cursor-plugin/marketplace.json`; all JSON valid. FILE-OPS check in a sandbox HOME: bundle copied to the documented `~/.cursor/plugins/local/lane-matrix-test/`; every plugin.json pointer (`commands`, `skills`, `hooks`, `mcpServers`) RESOLVES on disk relative to the plugin dir; removal left zero residue. | Activation is GUI-only ("Developer: Reload Window") — no headless validator exists, so even with Cursor installed the ceiling on a headless box is the file-ops check performed today. | 2026-06-13 |
| pi | npm-plugin (pi leg) | **docs-only** | Binary absent. The npm-plugin format itself is L1-verified (see opencode row: `node --check`, `npm pack --dry-run`, module-contract + live bridge test). | No pi-specific evidence. | 2026-06-13 |

## Emitter bugs found (exact fixes — route to the patch workflow; NOT fixed here per mandate)

### Bug 1 (confirmed, fix-proven): agy-plugin emits hooks.json where agy never looks

- **File**: `src/core/package-formats/agy.ts`, line 88:
  `if (hooksJson) emit(join(pluginDir, "hooks", "hooks.json"), json(hooksJson));`
- **Symptom**: agy 1.0.7 only reads `hooks.json` at the BUNDLE ROOT. As emitted,
  both `agy plugin validate` and `agy plugin install` report
  `hooks: skipped (not found)` and the hooks component never registers — silently
  (agy copies the file verbatim but ignores it).
- **Fix-proof**: the identical file moved to the bundle root →
  `hooks: 1 processed` on validate AND install, and `plugin list` components
  become `[skills, commands, mcpServers, hooks]`. The INNER schema (Claude-style
  `{ hooks: { SessionStart: [ { hooks: [ {type:"command",command:...} ] } ] } }`)
  was accepted unchanged — only the path is wrong.
- **Exact fix**: change line 88 to
  `if (hooksJson) emit(join(pluginDir, "hooks.json"), json(hooksJson));`
  AND correct the stale doc-comment at line 11 which claims
  `hooks/hooks.json` is the live-confirmed location (the prior research result
  that read "hooks 1 processed" evidently used the root layout).
- **STATUS: FIXED** (same day) — emitter + doc-comment + test updated, and the
  FIXED emitter's own output re-validated live against agy 1.0.7 in a sandbox
  HOME: `agy plugin validate` → `hooks: 1 processed` (plus skills 1,
  commands 1 → skills, mcpServers 1).

### Previously-found bug, now confirmed FIXED (no action)

- codex-plugin catalog location: codex rejects a catalog at
  `.codex-plugin/marketplace.json`. The current emitter
  (`src/core/package-formats/claude-family.ts:76-84`) emits it at
  `.agents/plugins/marketplace.json`, and codex 0.139.0's own
  `plugin marketplace add` accepted it live today. RE-VERIFIED against current
  emitter output.

### Not bugs (documented behavior, recorded for honesty)

- Every bundle embeds this machine's launcher path
  `/home/ubuntu/.agent-connector/bin/agent-connector` in hooks/MCP entries.
  Valid for local install; shared-marketplace consumers need agent-connector at
  the same home path or a per-machine repackage. The `package` command already
  prints this warning on every format.
- npm-plugin honestly drops commands and MCP (printed as notes); kimi-plugin
  honestly drops commands/hooks/subagents (printed as notes). These are format
  capabilities, not defects.

## What would upgrade each docs-only / capped row

| Row | Upgrade path |
|---|---|
| qwen → L1/L2 | Install Qwen Code CLI; in a sandbox HOME run `qwen extensions validate <bundle>` (gemini-fork validator expected) then `qwen extensions install <bundle> [--consent]` / `extensions list` / `uninstall`. The packager already prints the install command. |
| kimi → L1/L2 | Install Kimi CLI; sandbox HOME; `kimi plugin install <bundle>` / list / uninstall. Verify skills + MCP register (only surfaces this format carries). |
| droid → L1/L2 | Install Factory CLI (`droid`); sandbox HOME; `droid plugin marketplace add <out>` + `droid plugin install lane-matrix-test@agent-connector` / list / remove, mirroring the codex lane (same claude-family layout, repo-root catalog). |
| cursor → recognition | Needs the Cursor GUI on a desktop box: place bundle at `~/.cursor/plugins/local/<name>/`, run "Developer: Reload Window", confirm the plugin's commands/skills/MCP appear. No headless path exists. |
| pi → L2 | Install pi; check whether its npm-plugin consumption accepts a local `file:`/path spec like opencode/kilo do, or is genuinely registry-only; record the honest limit. |
| codex/gemini/agy/opencode/kilo → L3 | Requires marketplace drivers in OUR CLI beyond v1's claude-code-only scope (`src/core/marketplace-drivers/` ships `claude.ts` + `shared.ts`; `src/core/marketplace.ts` lists `claude-code` as the only live platform). The codex lane proved codex's native marketplace flow works end-to-end with our bundle, so a codex driver is the most closable L3 gap. Future work — explicitly out of scope for this verification workflow. |
| all L2 rows → runtime activation | Verifying the SessionStart hook actually fires / the MCP server spawns / the slash command resolves inside a live session needs an authenticated interactive host session (credentials + a model call) — beyond the install-recognition bar of this matrix on a headless CI-shared box. |

## Provenance

- claude-code L3: prior session, recorded per owner mandate ("do not redo, but RECORD").
- codex / gemini / agy / opencode+kilo L2: live lanes run 2026-06-13 in isolated
  mkdtemp sandboxes (details in the matrix evidence column); all sandboxes removed.
- qwen / kimi / droid / cursor emit checks + cursor file-ops placement: run
  2026-06-13 in sandbox `/tmp/lane-matrix.*` (removed after).
- Binary probe 2026-06-13: present = codex, gemini, agy, claude, opencode, kilo;
  absent = qwen, kimi, droid, cursor, factory, pi.
