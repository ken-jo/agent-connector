# Marketplace/plugin driver expansion — research + buildable spec

Researched 2026-06-14 (live re-verified the present binaries; official-docs for
the absent ones). Goal: expand `install --method marketplace` driving beyond
`{claude-code, codex, antigravity, antigravity-cli}`.

## Expandable list (verdict per host)

| Host | Format | Binary here | Verdict | Driver shape |
|---|---|---|---|---|
| gemini-cli | gemini-extension | ✓ 0.36.0 | **DRIVABLE-NOW** | direct |
| opencode | npm-plugin | ✓ 1.17.0 | **DRIVABLE-NOW** | npm-local (NEW) |
| kilo | npm-plugin | ✓ 7.3.16 | **DRIVABLE-NOW** | npm-local |
| kilo-cli | npm-plugin | ✓ (kilo alias) | **DRIVABLE-NOW** | npm-local |
| droid | factory-plugin | ✗ | DRIVABLE-DOCS | catalog (like codex) |
| qwen-code | qwen-extension | ✗ | DRIVABLE-DOCS | direct (gemini fork) |
| cursor | cursor-plugin | ✗ | NOT-DRIVABLE | none (GUI-gated) |
| pi | npm-plugin | ✗ | NOT-DRIVABLE | none (registry-only; no hook layer) |
| vscode-copilot / openclaw / omp | claude-plugin | ✗ | NOT-DRIVABLE | none (no plugin CLI; format-map entry is emit-only) |
| kimi | kimi-plugin | ✗ | NOT-DRIVABLE-YET | promotable to direct once a binary confirms an uninstall verb |

## Driver mechanics (confirmed)

### gemini-cli — DIRECT (model on agy.ts, standalone `geminiDriver`)
- install: `gemini extensions install <pluginDir> --consent` (`--consent` REQUIRED non-interactive; install-by-LOCAL-PATH confirmed; `gemini extensions validate <dir>` advisory)
- uninstall: `gemini extensions uninstall <id>`; list: `gemini extensions list`
- probe: `existsSync(~/.gemini/extensions/<id>/gemini-extension.json)` (HOME-only isolation, no config-dir env)
- idempotency: ALL exits 0 even on logical failure → **probe-first mandatory**. Re-install REFUSES ("already installed… uninstall first") — NOT an overwrite (unlike agy). Uninstall-absent is a no-op. → driveUpdate = uninstall-then-install (no overwrite path).

### opencode / kilo / kilo-cli — NPM-LOCAL (NEW shape; `makeNpmLocalDriver(platform, opts)`)
- install: `<bin> plugin --global file://<absDir>` (stage npm-plugin bundle at `<npmStagingRoot>/<id>`, then run; NO npm publish, NO marketplace registration). Bare absolute paths also accepted.
- uninstall: **NO host verb** (`<bin> uninstall` removes the HOST ITSELF — never call it). Removal = EDIT the config `plugin` array, drop the matching `file://<absDir>` entry, delete the `plugin` key when empty.
- config / probe: opencode → `$XDG_CONFIG_HOME/opencode/opencode.jsonc` (also opencode.json/config.json; JSONC — tolerate comments); kilo/kilo-cli → `$XDG_CONFIG_HOME/kilo/opencode.json` (dir `kilo`, file `opencode.json`, plain JSON). installed = `plugin` array has an entry whose value, after stripping a leading `file://`, path-equals the staged pluginDir.
- idempotency: re-install idempotent (no dupe, exit 0); array-edit uninstall naturally idempotent.
- **two gotchas**: (1) host CLIs MUST run from a NEUTRAL cwd (running in a project dir pollutes `./.opencode/opencode.json`) → add a `cwd` option to `runHostCommand`/`spawnChild`, pass the staging root / homedir; (2) `samePath()` does NOT strip `file://` — strip it before comparing; and marketplace-state.ts is a spawn/shared-free LEAF — inline a tiny posix-resolve compare there, don't import shared.ts.

### droid — CATALOG (DOCS-only; direct copy of codex.ts)
- register `droid plugin marketplace add <stagingRoot>` · install `droid plugin install <id>@agent-connector` · uninstall `droid plugin uninstall <id>@agent-connector` · de-register `droid plugin marketplace remove agent-connector`
- catalog: factory shape, repo-root `marketplace.json` (claude-family.ts factory spec) — pin the path from the emitter; staged-plugin marker `<dir>/.factory-plugin/plugin.json`
- probe: `~/.factory/settings.json` (JSON) — `enabledPlugins['<id>@agent-connector']===true`; collision = `extraKnownMarketplaces['agent-connector'].source`
- Mark idempotency DOCS-only (no binary here).

### qwen-code — DIRECT (DOCS-only; near-clone of gemini.ts)
- install `qwen extensions install <pluginDir>` (NO `--consent` documented — confirm live later) · uninstall `qwen extensions uninstall <id>` · update `qwen extensions update <id>`
- probe: `existsSync(~/.qwen/extensions/<id>/qwen-extension.json)`; NOT idempotent either way (throws) → probe-first. Mark DOCS-only.

## Implementation plan (3 batches, ordering = lowest template-reuse-risk first)

- **BATCH 1 — gemini.ts** (direct, live-verifiable). New state: `geminiStagingRoot`, `geminiConfigDir`, `geminiExtensionInstalled`.
- **BATCH 2 — npm-local.ts** (`makeNpmLocalDriver` + opencode/kilo/kilo-cli). Add the `cwd` option to `runHostCommand`/`spawnChild` FIRST (regression-test existing drivers unchanged — they pass no cwd). New state: `npmStagingRoot`, `opencodeConfigDir`/`kiloConfigDir` (XDG-aware), `npmPluginInstalled(platform,id)`, `npmPluginArrayEntry`, `npmConfigFilePath`, `stripFileScheme`.
- **BATCH 3 — qwen.ts (clone gemini) + droid.ts (clone codex)**, DOCS-only with mock-CLI unit tests + conditional integration tests that auto-run when `command -v qwen`/`droid` exists.
- **Cross-cutting per batch (same change-set):** `registry.ts` getMarketplaceDriver cases (+memoized npm-local map like the agy map), `marketplace.ts` DRIVABLE_MARKETPLACE_PLATFORMS, and `marketplaceEvidence` cases — never ahead of the driver (out-of-sync set → silent manual-hint fallthrough).

## Not worth driving (leave manual-hint, honest)
cursor (GUI reload only), pi (registry-only npm + no hook layer to load it), vscode-copilot/openclaw/omp (no plugin CLI; the claude-plugin format-map entry is emit-only and arguably misleading — consider making those emit direct-only), kimi (no confirmed uninstall/list verb — promote to a direct driver once a binary verifies reversal).
