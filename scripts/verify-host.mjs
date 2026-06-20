#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// scripts/verify-host.mjs — LIVE host-verification driver.
//
// The committed COMPLEMENT to tests/integration/install-roundtrip.test.ts.
// That harness proves, for ALL 35 adapters and WITHOUT any host binary, that
// `installConnector` writes a native config carrying the connector id and that
// uninstall removes it (binary-free, in-process). This script proves the next
// rung up the ladder, for a host whose CLI binary IS installed on the box: that
// the REAL host CLI ACCEPTS the config we wrote (lists/reads it without error),
// and — where a host can advance a turn offline — that the real CLI actually
// SPAWNS our hook entrypoint and runs the handler. It codifies the ad-hoc shell
// pipelines a verification workflow used to produce those live verdicts.
//
// Tiers (a host climbs as far as its binary + auth ceiling allow):
//   install-roundtrip  — config written at the expected path with our id, then
//                        cleanly removed on uninstall (same contract as the test
//                        harness, but exercised through the BUILT dist/cli.js).
//   live-accept        — the host's OFFLINE accept verb lists/reads our config
//                        without error (no network/auth needed).
//   live-runtime       — the host advanced a turn offline and our hook handler
//                        fired (proven by a marker line in $AC_VERIFY_DIR/events.log).
//
// SKIP-NOT-FAIL is the core discipline: a missing binary, a host with no live
// lane, or an accept verb that legitimately needs auth/network are SKIPS or
// recorded ceilings — never failures. The ONLY real failures (exit 1) are a
// placement miss (config not written with our id) or uninstall residue (our id
// survives uninstall). Both are bugs in OUR code, which is exactly what a live
// driver should catch. Everything else exits 0 so this is CI-safe on any box.
//
// Usage:
//   node scripts/verify-host.mjs <host-id> [--scope user|project] [--keep]
//   node scripts/verify-host.mjs --all   [--scope user|project] [--keep]
//
// Isolation: HOME/USERPROFILE and every host config-dir override point into a
// throwaway mkdtemp WORK dir; the real HOME is never touched. WORK is removed on
// exit unless --keep. No new deps — node:child_process / fs / os / path only.
// ─────────────────────────────────────────────────────────────────────────

import { spawnSync } from "node:child_process";
import { createHash as _createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");
const CONNECTOR = join(REPO_ROOT, ".acverify", "agent-connector.config.mjs");
const CONNECTOR_ID = "ac-verify"; // matches .acverify/agent-connector.config.mjs

// ─────────────────────────────────────────────────────────────────────────
// Per-host live lanes. One entry per host whose CLI can be driven OFFLINE far
// enough to produce live evidence. A host NOT in this map has "no live lane"
// (GUI-only, no binary, or no offline accept verb) and is reported skipped —
// the install-roundtrip TEST already covers its config placement headlessly.
//
//   bin       executable to look up on PATH (skip-no-binary when absent)
//   env       EXTRA env to set into WORK so the WRITER and the host CLI resolve
//             the SAME config dir (values are WORK-relative path segments). HOME
//             isolation already covers hosts that resolve purely off homedir();
//             this is only for hosts with their own config-home override.
//   accept    { argv, kind } — the OFFLINE accept verb. kind:
//               "list-id"  pass if stdout mentions the connector id
//               "ok"       pass if exit 0 (verb succeeded; config was read)
//   runtime   { argv } — OFFLINE turn that should spawn our hook entrypoint
//             (only for hosts with a bundled, auth-free model). Omitted = the
//             host is auth-gated for runtime; we record the ceiling, not a fail.
//   note      short human description of the lane / auth ceiling.
//
// Accept verbs were each confirmed via `<bin> --help` on the verifying box; see
// the per-host comments. Where the table handed down differed from reality the
// confirmed verb is used and the difference is noted.
// ─────────────────────────────────────────────────────────────────────────
const HOST_LANES = {
  "claude-code": {
    bin: "claude",
    env: { CLAUDE_CONFIG_DIR: [".claude"] },
    accept: { argv: ["mcp", "list"], kind: "list-id" },
    // Live finding: for our USER-scope write to ~/.claude.json, `claude mcp list`
    // reports "No MCP servers configured" — a known path/scope mismatch. Stays
    // pass-placement-ok (accept-error, not a fail). Live-accept here likely needs
    // PROJECT scope or a different read path; not chased in this driver.
    note: "`claude mcp list` does not surface our user-scope ~/.claude.json server (reports 'No MCP servers configured') — known scope mismatch; placement-ok. Live-accept likely needs project scope.",
  },
  codex: {
    bin: "codex",
    // CODEX_HOME unifies the writer (codexConfigHome) and the CLI probe so they
    // never disagree on the config dir (see src/core/host-paths.ts).
    env: { CODEX_HOME: [".codex"] },
    accept: { argv: ["mcp", "list"], kind: "list-id" },
    note: "`codex mcp list` lists our server offline (live-verified); turn is auth-gated.",
  },
  "gemini-cli": {
    bin: "gemini",
    // Resolves ~/.gemini off homedir → HOME isolation suffices (no extra env).
    accept: { argv: ["mcp", "list"], kind: "list-id" },
    note: "`gemini mcp list` lists configured servers offline; turn is auth-gated.",
  },
  opencode: {
    bin: "opencode",
    // Resolves ~/.config/opencode off homedir → HOME isolation suffices.
    accept: { argv: ["mcp", "list"], kind: "ok" },
    // Bundled offline model (opencode/big-pickle) advances a turn with NO auth;
    // the run loads our generated plugin which shells out to the home-bin hook.
    // NOT --pure: --pure disables external plugins (our bridge would not load).
    runtime: { argv: ["run", "say hi from ac-verify"] },
    note: "bundled offline model → `opencode run` fires SessionStart into events.log.",
  },
  "kilo-cli": {
    bin: "kilo",
    // OpenCode fork; resolves ~/.config/kilo off homedir → HOME isolation suffices.
    accept: { argv: ["mcp", "list"], kind: "ok" },
    runtime: { argv: ["run", "say hi from ac-verify"] },
    note: "OpenCode fork with bundled offline model → `kilo run` fires events.log.",
  },
  "copilot-cli": {
    bin: "copilot",
    // Resolves ~/.copilot off homedir → HOME isolation suffices.
    accept: { argv: ["mcp", "list"], kind: "list-id" },
    note: "`copilot mcp list` lists configured servers offline; turn is auth-gated.",
  },
  "antigravity-cli": {
    bin: "agy",
    // Writes MCP under ~/.gemini/... off homedir → HOME isolation suffices.
    // `agy mcp` is TUI-only (no offline list); `agy plugin list` is the offline
    // accept verb. It does not echo our MCP id, so this is an "ok" (exit-0) lane:
    // it proves the binary reads its config tree without error, not id presence.
    accept: { argv: ["plugin", "list"], kind: "ok" },
    // The OFFLINE accept lane stays "ok" (exit-0). A turn is Google-OAuth-gated,
    // but agy IS an AUTHED-RUNTIME deep-verb host (see HOST_VERBS["antigravity-cli"]
    // + agyRunners): with the real ~/.gemini token copied into the sandbox, `agy -p`
    // advances a turn and our PreToolUse/PostToolUse/Stop hooks fire (live-verified).
    // There is no auth-free offline model — the deep-verb lanes need the real token.
    note: "`agy plugin list` reads config offline (no mcp-list verb); turn is Google-OAuth-gated. AUTHED-RUNTIME deep-verb host: with the copied ~/.gemini token, `--verb`/`--all-verbs` fire hooks + MCP live.",
  },
  "amazon-q": {
    bin: "q",
    // Resolves ~/.aws/amazonq off homedir → HOME isolation suffices.
    // Live-verified: `q mcp list` is AUTH-GATED — it errors "You are not logged
    // in, please log in with q login" before listing, so it degrades to
    // accept-auth-gated (placement OK), NOT a fail (looksAuthGated catches it).
    accept: { argv: ["mcp", "list"], kind: "list-id" },
    note: "`q mcp list` is auth-gated ('not logged in') → accept-auth-gated; placement+uninstall verified.",
  },

  // ── Hosts whose CLI is NOT pre-installed but CAN be installed locally and
  // live-verified. The lane is identical to the above (placement → accept →
  // runtime → uninstall); the binary is resolved from the local toolchain
  // prefix (.verify-tools) once installed. Accept verbs default to the OpenCode
  // family's `mcp list` (the forks) or a conservative exit-0 read; they are
  // re-confirmed via the live-verify itself (a wrong package will NOT recognize
  // our config and is recorded accept-error/uncertain, never a false pass).
  // See HOST_INSTALL below for how each binary is obtained.
  "qwen-code": {
    bin: "qwen",
    // Gemini-CLI fork; resolves ~/.qwen off homedir → HOME isolation suffices.
    accept: { argv: ["mcp", "list"], kind: "list-id" },
    note: "Gemini-CLI fork; `qwen mcp list` lists servers offline; turn is auth-gated.",
  },
  amp: {
    bin: "amp",
    // Resolves ~/.config/amp off homedir → HOME isolation suffices.
    // CORRECTED via live `amp mcp --help`: `amp mcp list` lists the configured
    // amp.mcpServers entries OFFLINE and echoes our id (live-verified: prints
    // "ac-verify  command  true"). The published bin is named amp.exe but is in
    // fact an ELF Linux executable (the .exe name is misleading) — runs here.
    accept: { argv: ["mcp", "list"], kind: "list-id" },
    note: "`amp mcp list` lists our amp.mcpServers entry offline (live-verified); turn is auth-gated.",
  },
  codebuff: {
    bin: "codebuff",
    // Resolves ~/.agents off homedir → HOME isolation suffices.
    // CORRECTED via live `codebuff --help`: codebuff has NO `mcp` subcommand
    // (only login/publish). `codebuff mcp list` is parsed as a PROMPT, which
    // boots the agent runtime (downloads a ~47MB binary on first run + needs
    // auth) — not an offline config-accept verb. Placement-only.
    placementOnly: true,
    note: "no offline accept verb — placement+uninstall-clean only (codebuff has no `mcp` subcommand; `mcp list` is parsed as a prompt → 47MB agent boot + auth).",
  },
  continue: {
    bin: "cn",
    // Resolves ~/.continue off homedir (CONTINUE_GLOBAL_DIR honored) → HOME ok.
    // CORRECTED via live `cn --help` / `cn mcp --help`: continue has NO `mcp`
    // subcommand (commands are ls/checks/review). `--mcp <slug>` is a hub-slug
    // FLAG that ADDS a server, not a config reader; `cn mcp list` falls through
    // to the default interactive session. No offline config-accept verb.
    placementOnly: true,
    note: "no offline accept verb — placement+uninstall-clean only (continue has no `mcp` subcommand; `--mcp` is an add-from-hub flag, not a reader).",
  },
  "mimo-code": {
    bin: "mimo",
    // OpenCode fork; resolves ~/.config/mimocode off homedir → HOME isolation suffices.
    // Confirmed via live `mimo mcp --help`: `mimo mcp list` (alias `ls`) lists
    // servers offline (OpenCode-family verb), so list-id is the precise check.
    accept: { argv: ["mcp", "list"], kind: "list-id" },
    runtime: { argv: ["run", "say hi from ac-verify"] },
    note: "OpenCode fork; `mimo mcp list` lists servers offline + possible offline `mimo run` runtime lane.",
  },
  crush: {
    bin: "crush",
    // Resolves ~/.config/crush off homedir → HOME isolation suffices.
    // CORRECTED via live `crush --help`: crush has NO `mcp` subcommand (MCP is a
    // file key in ~/.config/crush/crush.json). `crush dirs` reads config DIRS
    // offline but does NOT read/validate our MCP entry, so it is not a true
    // accept of our config. Placement-only.
    placementOnly: true,
    note: "no offline accept verb — placement+uninstall-clean only (crush has no `mcp` subcommand; MCP lives in the crush.json `mcp` key; `crush dirs` only prints config dirs).",
  },
  openclaw: {
    bin: "openclaw",
    // Resolves ~/.openclaw off homedir → HOME isolation suffices.
    // The configSchema gap is FIXED: buildPluginManifest now emits
    // configSchema: { type: "object", additionalProperties: false } (openclaw's
    // minimal-manifest shape), so `openclaw config validate` NO LONGER reports
    // "plugin manifest requires configSchema" — the written plugin now validates.
    // Still placement-only here: openclaw exposes no offline accept verb that
    // echoes our id (mcp list does not list by id), and `config validate` is a
    // global config check, not an id-scoped accept, so the harness reports
    // placement + uninstall-clean honestly rather than driving a misleading verb.
    placementOnly: true,
    note: "placement+uninstall-clean only — openclaw has no id-echoing offline accept verb (`mcp list` doesn't list by id; `config validate` is a global check). configSchema gap FIXED: `openclaw config validate` no longer rejects our plugin manifest (live-verified).",
  },
  goose: {
    bin: "goose",
    // Resolves ~/.config/goose off homedir → HOME isolation suffices.
    // CORRECTED via live `goose mcp --help` + run: `goose mcp <SERVER>` takes a
    // server NAME and BUNDLES it — `goose mcp list` errors "Invalid command:
    // list". goose has NO offline list-MCP verb. Placement-only.
    placementOnly: true,
    note: "no offline accept verb — placement+uninstall-clean only (goose mcp takes a server arg; `goose mcp list` errors 'Invalid command: list').",
  },
  droid: {
    bin: "droid",
    // Factory CLI; resolves ~/.factory off homedir → HOME isolation suffices.
    // CORRECTED via live `droid mcp list`: it lists configured MCP servers
    // OFFLINE and echoes our id (live-verified: "ac-verify  stdio … [user]").
    accept: { argv: ["mcp", "list"], kind: "list-id" },
    note: "`droid mcp list` lists our MCP server offline (live-verified); turn is auth-gated.",
  },
  omp: {
    bin: "omp",
    // oh-my-pi (can1357) ts-plugin host; MCP at ~/.omp/agent/mcp.json (honors
    // PI_CODING_AGENT_DIR → set into WORK so writer + CLI agree).
    env: { PI_CODING_AGENT_DIR: [".omp", "agent"] },
    // Determined empirically: omp has NO `mcp` subcommand (`omp mcp …` is parsed
    // as a prompt → default launch help); `omp config list` reads SETTINGS, not
    // the mcp.json server registry. And `omp -p` is auth-gated ("No models
    // available. Use /login or set an API key") — no bundled offline model, so
    // unlike opencode/mimo the ts-plugin hook does NOT fire offline. Placement-only.
    placementOnly: true,
    note: "no offline accept verb — placement+uninstall-clean only (omp has no `mcp` subcommand; `omp -p` is auth-gated, no offline model → no offline runtime).",
  },
  cursor: {
    bin: "cursor-agent", // NOT `cursor` — Cursor's headless CLI is `cursor-agent`.
    // The cursor adapter writes ~/.cursor/mcp.json off homedir → HOME isolation
    // suffices. Determined empirically: `cursor-agent mcp list` reads
    // ~/.cursor/mcp.json OFFLINE and echoes our id (live-verified output:
    // "ac-verify: not loaded (needs approval)" — the id IS listed, no auth for
    // the list verb). json-stdio host with hooks; placement+accept is the ceiling
    // (no auth-free runtime — a turn needs CURSOR_API_KEY).
    accept: { argv: ["mcp", "list"], kind: "list-id" },
    note: "`cursor-agent mcp list` lists our ~/.cursor/mcp.json server offline (live-verified); turn needs CURSOR_API_KEY.",
  },
  kimi: {
    bin: "kimi",
    // @moonshot-ai/kimi-code (json-stdio). The adapter writes mcp.json + the
    // [[hooks]] config.toml under $KIMI_CODE_HOME || ~/.kimi-code (primary-doc-
    // verified; there is NO $KIMI_HOME). CRITICAL (live finding): the v0.18.0 CLI's
    // `doctor` reads ~/.kimi-code by default and KIMI_HOME does NOT redirect it (the
    // adapter now matches — it ignores KIMI_HOME), while KIMI_CODE_HOME redirects
    // BOTH the adapter writer AND the CLI reader — so setting KIMI_CODE_HOME into
    // WORK unifies them (the CODEX_HOME pattern).
    env: { KIMI_CODE_HOME: [".kimi-cfg"] },
    // No `mcp list` verb. `kimi doctor config` VALIDATES the exact config.toml we
    // wrote (live-verified: "OK config.toml … All checked config files are
    // valid"; negative control with corrupt TOML → "found 1 issue / ERROR"). It
    // exits 0 even on errors, so an exit-0 "ok" would falsely pass — use ok-marker
    // (require "valid", reject "issue"). It validates config.toml (hooks), NOT
    // mcp.json, and does not echo the connector id, so this proves the CLI READS
    // + ACCEPTS our written hook config, not id presence. Turn is auth-gated.
    accept: { argv: ["doctor", "config"], kind: "ok-marker", okMarker: "valid", failMarker: "issue" },
    note: "`kimi doctor config` validates our written config.toml offline (live-verified OK + negative control); validates config.toml not mcp.json; turn is auth-gated.",
  },
};

// ─────────────────────────────────────────────────────────────────────────
// HOST_INSTALL — how to OBTAIN a missing host CLI for LIVE verification on a box
// that lacks it, WITHOUT polluting the box (install into the gitignored local
// prefix .verify-tools, never global). One entry per host the binary of which
// can be installed and live-driven here.
//
//   { kind: "npm", pkg, bin, identity }
//     installed via `npm install --prefix .verify-tools <pkg>`; the bin resolves
//     to .verify-tools/node_modules/.bin/<bin>. `identity` records the npm-probed
//     proof (homepage/repo) that the package IS the real host — installing a
//     wrong/squatter package is worse than skipping, so only npm-VERIFIED names
//     are listed here (probed with `npm view <pkg> homepage repository.url`).
//
//   { kind: "download", bin, url(arch), extract, identity }
//     a PINNED, versioned vendor binary fetched directly (NOT `curl|sh` — the
//     sandbox blocks remote-script execution and so do we; a pinned URL is a
//     reproducible, auditable artifact). `url(arch)` builds the asset URL from
//     the normalized arch ("arm64"|"x64"); `extract` is how to turn the download
//     into the bin under .verify-tools/bin: "tarbz2" | "zip" | "raw". `identity`
//     records the vendor host the URL belongs to.
//
// NETWORK INSTALL IS OPT-IN (`--install`), NOT the default — a deliberate safety
// decision: auto-downloading and EXECUTING third-party CLIs is untrusted-code
// integration that must be a conscious, authorized act, not a side effect of the
// default run. Without --install, a missing binary stays skip-not-fail and the
// host is covered headlessly by install-roundtrip.test.ts.
// ─────────────────────────────────────────────────────────────────────────
const HOST_INSTALL = {
  // ── npm packages, identity npm-PROBED to match the real host (2026-06-19) ──
  "qwen-code": { kind: "npm", pkg: "@qwen-code/qwen-code", bin: "qwen", identity: "github.com/QwenLM/qwen-code" },
  amp: { kind: "npm", pkg: "@sourcegraph/amp", bin: "amp", identity: "ampcode.com (Sourcegraph)" },
  codebuff: { kind: "npm", pkg: "codebuff", bin: "codebuff", identity: "github.com/CodebuffAI/codebuff" },
  continue: { kind: "npm", pkg: "@continuedev/cli", bin: "cn", identity: "github.com/continuedev/continue" },
  "mimo-code": { kind: "npm", pkg: "@mimo-ai/cli", bin: "mimo", identity: "github.com/XiaomiMiMo/MiMo-Code" },
  crush: { kind: "npm", pkg: "@charmland/crush", bin: "crush", identity: "github.com/charmbracelet/crush" },
  openclaw: { kind: "npm", pkg: "openclaw", bin: "openclaw", identity: "github.com/openclaw/openclaw" },
  // @moonshot-ai/kimi-code is the OFFICIAL Moonshot Kimi Code CLI (bin `kimi`),
  // matching the kimi adapter's $KIMI_CODE_HOME || ~/.kimi-code layout. Pinned to
  // 0.18.0; engines node>=22.19 (this box has node 24). NOT the old "kimi-cli" stub.
  kimi: { kind: "npm", pkg: "@moonshot-ai/kimi-code@0.18.0", bin: "kimi", identity: "github.com/MoonshotAI/kimi-code" },
  // ── pinned vendor binary downloads (arch-aware; NO remote-script execution) ──
  // Versions are PINNED and live-verified on aarch64; bump the pin to upgrade.
  goose: {
    kind: "download",
    bin: "goose",
    identity: "github.com/block/goose v1.38.0",
    extract: "tarbz2",
    // GitHub release tarball; Rust target triple per arch. arm64→aarch64, x64→x86_64.
    url: (arch) =>
      `https://github.com/block/goose/releases/download/v1.38.0/goose-${
        arch === "arm64" ? "aarch64" : "x86_64"
      }-unknown-linux-gnu.tar.bz2`,
  },
  "amazon-q": {
    kind: "download",
    bin: "q",
    identity: "Amazon Q Developer CLI (desktop-release.q.us-east-1.amazonaws.com)",
    extract: "zip",
    // AWS "latest" zip; binary is at q/bin/q inside (do NOT run q/install.sh).
    zipBinPath: ["q", "bin", "q"],
    url: (arch) =>
      `https://desktop-release.q.us-east-1.amazonaws.com/latest/q-${
        arch === "arm64" ? "aarch64" : "x86_64"
      }-linux.zip`,
  },
  droid: {
    kind: "download",
    bin: "droid",
    identity: "downloads.factory.ai/factory-cli v0.152.0",
    extract: "raw",
    // Plain per-arch binary. NOTE: do NOT append the installer's "-baseline"
    // suffix — that asset is x86-AVX2-only; arm64 uses the plain `droid` asset.
    url: (arch) =>
      `https://downloads.factory.ai/factory-cli/releases/0.152.0/linux/${
        arch === "arm64" ? "arm64" : "x64"
      }/droid`,
  },
  omp: {
    kind: "download",
    bin: "omp",
    identity: "github.com/can1357/oh-my-pi v16.0.10",
    extract: "raw",
    // Raw per-arch binary from the pinned GitHub release. omp-linux-arm64 / -x64.
    url: (arch) =>
      `https://github.com/can1357/oh-my-pi/releases/download/v16.0.10/omp-linux-${
        arch === "arm64" ? "arm64" : "x64"
      }`,
  },
  cursor: {
    kind: "download",
    bin: "cursor-agent",
    identity: "downloads.cursor.com cursor-agent 2026.06.16-20-30-07-a07d3ac",
    extract: "targz",
    // Binary is nested at dist-package/cursor-agent inside the tarball.
    archiveBinPath: ["dist-package", "cursor-agent"],
    // WARNING: this is a TIMESTAMP-version-pinned LAB snapshot URL
    // (2026.06.16-20-30-07-a07d3ac) and WILL rot — the lab path is ephemeral.
    // It is the asset the official installer (cursor.com/install) used at pin
    // time; a stable "latest" endpoint would be better but none is published.
    // Bump the timestamp segment to refresh when the download 404s.
    url: (arch) =>
      `https://downloads.cursor.com/lab/2026.06.16-20-30-07-a07d3ac/linux/${
        arch === "arm64" ? "arm64" : "x64"
      }/agent-cli-package.tar.gz`,
  },
};

// Hosts genuinely NOT live-verifiable on a headless Linux box, with the SPECIFIC
// reason. These are already covered by the binary-free install-roundtrip.test.ts
// (merged), so they are documented non-gaps, NOT unverified holes.
const UNINSTALLABLE_HERE = {
  // NOTE: cursor was here ("GUI editor") — WRONG. Cursor ships `cursor-agent`, a
  // headless CLI with `agent mcp list`; it is now an installable live lane below.
  windsurf: "GUI editor",
  trae: "GUI editor",
  kiro: "GUI editor",
  zed: "GUI editor (the `zed` bin launches the GUI; no headless config verb)",
  warp: "terminal app (GUI; no headless config verb)",
  cline: "IDE extension (no CLI)",
  "roo-code": "IDE extension (no CLI)",
  kilo: "IDE extension (no CLI; the `kilo` binary present is kilo-cli, a different adapter)",
  "vscode-copilot": "IDE extension (no CLI)",
  "jetbrains-copilot": "IDE extension (no CLI)",
};

// Hosts for which NO npm package identity could be verified (the obvious name is
// a squatter/stub/unrelated package — probed 2026-06-19). Installing a WRONG or
// malicious package is worse than skipping, so these are left UNINSTALLED with an
// honest reason rather than guessed at.
const IDENTITY_UNVERIFIED = {
  hermes: 'npm "hermes-cli" is a Brazil travel-agency CLI — NOT the AI host',
  mux: 'npm "mux-cli" is a stub ("`npm run mux-cli`") — identity unverified',
  // NOTE: kimi was here (the old npm "kimi-cli" 0.0.2 was a frontend-gen stub) —
  // but the REAL host is @moonshot-ai/kimi-code (github.com/MoonshotAI/kimi-code,
  // bin `kimi`); it is now an installable npm live lane below.
  pi: 'npm "pi-cli" 0.0.0 is an empty stub — identity unverified',
  nemoclaw: 'npm "nemoclaw" 0.1.0 has no bin — identity unverified (NVIDIA wraps openclaw)',
  // NOTE: omp was here (npm "omp" is an unrelated stub) — but oh-my-pi (can1357)
  // ships a pinned release BINARY (omp-linux-<arch>); it is now an installable
  // live lane below (download, not npm).
};

// ─────────────────────────────────────────────────────────────────────────
// Small helpers.
// ─────────────────────────────────────────────────────────────────────────

/** The gitignored local toolchain prefix install missing host CLIs go into. */
const TOOLS_PREFIX = join(REPO_ROOT, ".verify-tools");
// npm-installed host bins symlink under node_modules/.bin; binary-download hosts
// (goose/q/droid) land directly under .verify-tools/bin. which() checks both.
const TOOLS_BIN_DIR = join(TOOLS_PREFIX, "node_modules", ".bin");
const TOOLS_DOWNLOAD_BIN_DIR = join(TOOLS_PREFIX, "bin");

/**
 * Resolve a binary: prefer the local toolchain prefix (a host we installed for
 * verification — both the npm .bin dir and the binary-download bin dir), then
 * fall back to PATH. Returns the absolute path or null. No shell (avoids
 * DEP0190); Windows PATHEXT aware.
 */
function which(bin) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  // 1. Local toolchain prefix first (so a verification-only install is used
  //    even if a different/global build of the same bin is on PATH). Check the
  //    npm .bin dir AND the binary-download bin dir.
  for (const dir of [TOOLS_BIN_DIR, TOOLS_DOWNLOAD_BIN_DIR]) {
    for (const ext of exts) {
      const local = join(dir, bin + ext);
      try {
        if (existsSync(local)) return local;
      } catch {
        /* ignore */
      }
    }
  }
  // 2. PATH.
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = join(dir, bin + ext);
      try {
        if (existsSync(cand)) return cand;
      } catch {
        /* ignore unreadable PATH entry */
      }
    }
  }
  return null;
}

/** Normalize process.arch to the two arches our download URLs support. */
function normalizedArch() {
  return process.arch === "arm64" || process.arch === "aarch64" ? "arm64" : "x64";
}

/** Fetch a URL into a local file (node global fetch). Returns { ok, reason }. */
async function downloadTo(url, destFile) {
  let res;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (err) {
    return { ok: false, reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status} for ${url}` };
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destFile, buf);
  return { ok: true, reason: `downloaded ${buf.length} bytes` };
}

/**
 * Install a missing host CLI into the LOCAL prefix (never global) so it can be
 * live-verified. Returns { ok, bin?, reason }. Three methods:
 *   • npm      — `npm install --prefix .verify-tools <pkg>` (bin in node_modules/.bin)
 *   • download — fetch a PINNED vendor binary/archive and place the bin under
 *                .verify-tools/bin (NO remote-script execution; reproducible URL)
 *
 * SECURITY: this DOWNLOADS AND WILL EXECUTE third-party code. It runs ONLY under
 * the explicit --install opt-in; every npm pkg identity was npm-probed and every
 * download URL is pinned to a versioned vendor asset.
 */
async function installHost(hostId) {
  const spec = HOST_INSTALL[hostId];
  if (!spec) return { ok: false, reason: "no install method defined" };

  if (spec.kind === "npm") {
    mkdirSync(TOOLS_PREFIX, { recursive: true });
    process.stderr.write(`[${hostId}] installing ${spec.pkg} into ${TOOLS_PREFIX} (identity: ${spec.identity})\n`);
    const r = run(
      "npm",
      ["install", "--prefix", TOOLS_PREFIX, "--no-save", "--no-fund", "--no-audit", spec.pkg],
      process.env,
      300_000,
    );
    if (r.status !== 0) {
      return { ok: false, reason: `npm install ${spec.pkg} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 200)}` };
    }
    const bin = which(spec.bin);
    if (!bin) return { ok: false, reason: `installed ${spec.pkg} but bin "${spec.bin}" not found in prefix` };
    return { ok: true, bin, reason: `installed ${spec.pkg}` };
  }

  if (spec.kind === "download") {
    const arch = normalizedArch();
    const url = spec.url(arch);
    mkdirSync(TOOLS_DOWNLOAD_BIN_DIR, { recursive: true });
    const destBin = join(TOOLS_DOWNLOAD_BIN_DIR, spec.bin);
    const tmp = tempDir(`ac-dl-${hostId}-`);
    process.stderr.write(`[${hostId}] downloading ${spec.identity} (${arch}) from ${url}\n`);
    try {
      if (spec.extract === "raw") {
        const dl = await downloadTo(url, destBin);
        if (!dl.ok) return { ok: false, reason: dl.reason };
        chmodSync(destBin, 0o755);
      } else if (spec.extract === "tarbz2" || spec.extract === "targz") {
        // tarbz2 → -xjf (bzip2); targz → -xzf (gzip). The bin may be nested in
        // the archive (e.g. cursor's dist-package/cursor-agent), so use the
        // optional archiveBinPath, defaulting to a flat [spec.bin].
        const archive = join(tmp, "dl.tar");
        const dl = await downloadTo(url, archive);
        if (!dl.ok) return { ok: false, reason: dl.reason };
        const flag = spec.extract === "tarbz2" ? "-xjf" : "-xzf";
        const x = run("tar", [flag, archive, "-C", tmp], process.env, 120_000);
        if (x.status !== 0) return { ok: false, reason: `tar extract failed: ${(x.stderr || x.stdout).trim().slice(0, 200)}` };
        const rel = spec.archiveBinPath ?? [spec.bin];
        const found = join(tmp, ...rel);
        if (!existsSync(found)) return { ok: false, reason: `archive did not contain ${rel.join("/")}` };
        writeFileSync(destBin, readFileSync(found));
        chmodSync(destBin, 0o755);
      } else if (spec.extract === "zip") {
        const archive = join(tmp, "dl.zip");
        const dl = await downloadTo(url, archive);
        if (!dl.ok) return { ok: false, reason: dl.reason };
        const x = run("unzip", ["-q", "-o", archive, "-d", tmp], process.env, 120_000);
        if (x.status !== 0) return { ok: false, reason: `unzip failed: ${(x.stderr || x.stdout).trim().slice(0, 200)}` };
        // The real binary is nested (e.g. q/bin/q); do NOT run the bundled installer.
        const found = join(tmp, ...(spec.zipBinPath ?? [spec.bin]));
        if (!existsSync(found)) return { ok: false, reason: `zip did not contain ${(spec.zipBinPath ?? [spec.bin]).join("/")}` };
        writeFileSync(destBin, readFileSync(found));
        chmodSync(destBin, 0o755);
      } else {
        return { ok: false, reason: `unknown extract method "${spec.extract}"` };
      }
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    const bin = which(spec.bin);
    if (!bin) return { ok: false, reason: `placed ${spec.bin} but which() did not resolve it` };
    return { ok: true, bin, reason: `downloaded ${spec.identity} (${arch})` };
  }

  return { ok: false, reason: `unknown install kind "${spec.kind}"` };
}

/** Windows-safe temp dir: expand the 8.3 short name so `~` never survives. */
function tempDir(prefix) {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Build the isolated env for a WORK dir. HOME/USERPROFILE point at WORK/home;
 * our framework data-root and the verify marker dir are SIBLINGS under WORK
 * (NOT under home) so our own connector registry never pollutes the HOME-tree
 * residue scan. WORK/project is the SANDBOXED project dir passed as --project so
 * a `--scope project` install writes there (e.g. <projectDir>/AGENTS.md,
 * <projectDir>/.cursor/...) instead of falling back to the real repo cwd.
 * CODEX_HOME / CLAUDE_CONFIG_DIR are cleared; APPDATA / XDG_CONFIG_HOME /
 * XDG_DATA_HOME are pointed INTO WORK so a real config can never be read or
 * written (XDG_DATA_HOME set, not deleted, to cover a host that reads it without
 * the $HOME/.local/share fallback).
 */
function isolatedEnv(work, lane) {
  const home = join(work, "home");
  const projectDir = join(work, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AGENT_CONNECTOR_DATA_DIR: join(work, "data"),
    AC_VERIFY_DIR: join(work, "acv"),
    // Default behavior (no real-config leakage): point host config-home overrides
    // into WORK unless a lane deliberately overrides one below.
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
  };
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  // Lane-specific config-home overrides, anchored under HOME so writer + CLI agree.
  for (const [key, segs] of Object.entries(lane.env ?? {})) {
    env[key] = join(home, ...segs);
  }
  return { env, home, projectDir };
}

/** Run a command with stdin closed under a hard timeout; capture all output.
 *  `cwd` (optional) sets the child's working directory — needed by hosts that
 *  resolve PROJECT-scope config off process.cwd() (e.g. claude `.mcp.json`). */
function run(cmd, argv, env, timeoutMs, cwd) {
  const r = spawnSync(cmd, argv, {
    env,
    ...(cwd ? { cwd } : {}),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: r.status,
    timedOut: r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM",
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** Recursively list files under dir whose utf8 contents include needle. */
function filesContaining(dir, needle) {
  const hits = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          if (readFileSync(full, "utf8").includes(needle)) hits.push(full);
        } catch {
          /* binary / unreadable — cannot carry the literal id */
        }
      }
    }
  };
  walk(dir);
  return hits;
}

/** Heuristic: did the accept verb fail because it needs auth/network? */
function looksAuthGated(res) {
  const blob = `${res.stdout}\n${res.stderr}`.toLowerCase();
  return /auth|login|sign in|signed in|credential|token|api key|unauthor|forbidden|network|offline|not logged|please run .* login/.test(
    blob,
  );
}

/** A single JSON verdict line + a human summary, then exit. */
function emit(verdict, exitCode) {
  process.stdout.write(JSON.stringify(verdict) + "\n");
  return exitCode;
}

// ─────────────────────────────────────────────────────────────────────────
// Verify one host. Returns { verdict, exitCode }. Never throws for an
// expected-skip condition; a thrown error is an unexpected harness bug.
// ─────────────────────────────────────────────────────────────────────────
async function verifyHost(hostId, { scope, keep, install }) {
  const lane = HOST_LANES[hostId];

  /** Build a non-live verdict (a documented skip), all live fields null. */
  const skip = (status, notes, binaryPresent = false) => ({
    verdict: {
      host: hostId,
      binaryPresent,
      tier: binaryPresent ? "install-roundtrip" : "none",
      placementOk: null,
      accept: null,
      runtimeFired: null,
      uninstallClean: null,
      status,
      notes,
    },
    exitCode: 0,
  });

  // No live lane → classify the SPECIFIC reason (GUI / IDE-ext / identity-
  // unverified), all of which are already covered by install-roundtrip.test.ts.
  if (!lane) {
    if (UNINSTALLABLE_HERE[hostId]) {
      const why = UNINSTALLABLE_HERE[hostId];
      process.stderr.write(`SKIP ${hostId}: uninstallable-here (${why}).\n`);
      return skip("uninstallable-here", `uninstallable-here: ${why} — covered headlessly by install-roundtrip.test.ts`);
    }
    if (IDENTITY_UNVERIFIED[hostId]) {
      const why = IDENTITY_UNVERIFIED[hostId];
      process.stderr.write(`SKIP ${hostId}: identity-unverified (${why}).\n`);
      return skip("uninstallable-here", `uninstallable-here: ${why} — NOT installed (wrong package is worse than skipping); covered headlessly by install-roundtrip.test.ts`);
    }
    process.stderr.write(`SKIP ${hostId}: no live lane defined — covered headlessly by install-roundtrip.test.ts.\n`);
    return skip("skipped-no-live-lane", "no live lane defined (GUI-only / no CLI binary / no offline accept verb)");
  }

  let binPath = which(lane.bin);

  // Binary absent: install it into the local prefix when --install is set and an
  // install method is known; otherwise stay skip-not-fail (the default).
  if (!binPath) {
    const spec = HOST_INSTALL[hostId];
    if (install && spec) {
      const res = await installHost(hostId);
      if (res.ok) {
        binPath = res.bin;
        process.stderr.write(`[${hostId}] ${res.reason} → bin ${binPath}\n`);
      } else {
        process.stderr.write(`SKIP ${hostId}: install failed — ${res.reason}\n`);
        return skip("skipped-install-failed", `install failed: ${res.reason} — covered headlessly by install-roundtrip.test.ts`);
      }
    } else {
      const source = spec ? (spec.kind === "npm" ? spec.pkg : spec.identity) : null;
      const hint = spec
        ? install
          ? "install method known but produced no binary"
          : `binary "${lane.bin}" absent; pass --install to install ${source} into the local prefix`
        : `binary "${lane.bin}" absent and no install method defined`;
      process.stderr.write(`SKIP ${hostId}: ${hint} (skip-not-fail).\n`);
      return skip("skipped-no-binary", `${hint} — install-roundtrip covered headlessly by the test harness`);
    }
  }

  const work = tempDir(`ac-verify-${hostId}-`);
  const { env, home, projectDir } = isolatedEnv(work, lane);
  // Roots a placement/residue scan must cover: HOME always; the sandboxed
  // project dir too at project scope (project-scope writes land at projectDir,
  // outside HOME — scanning only HOME would miss them and mis-score placement).
  const scanRoots = scope === "project" ? [home, projectDir] : [home];
  const verdict = {
    host: hostId,
    binaryPresent: true,
    tier: "install-roundtrip",
    placementOk: false,
    accept: "untested",
    runtimeFired: null,
    uninstallClean: null,
    status: "pending",
    notes: lane.note,
  };

  try {
    // ── 3. INSTALL (through the BUILT cli.js, scoped to this host only) ─────
    // --project is the SANDBOXED projectDir on EVERY scope so a project-scope
    // install never falls back to the real repo cwd (process.cwd()).
    const installRun = run(
      "node",
      [CLI, "install", "--connector", CONNECTOR, "--scope", scope, "--project", projectDir, "--targets", hostId],
      env,
      120_000,
    );
    process.stderr.write(`[${hostId}] install exit=${installRun.status}\n`);
    // NOTE: `agent-connector install` exits 1 whenever ANY `warn` ChangeRecord is
    // present — and a benign "unsupported hook event — skipped" warning (e.g.
    // gemini-cli / antigravity-cli decline an event with no native equivalent)
    // is a documented never-silent SKIP, NOT a failure. So the install exit code
    // is NOT the pass/fail signal here. Two real-error signals are checked:
    //   • an orchestration STEP failure ("<step> failed on <id>" — an adapter bug,
    //     the same pattern install-roundtrip.test.ts treats as fatal), and
    //   • the placement scan below (no file carries our id ⇒ install did nothing).
    const installOut = `${installRun.stdout}\n${installRun.stderr}`;
    if (/ failed on /.test(installOut)) {
      verdict.status = "fail-install-step";
      verdict.notes = `orchestration step failed: ${installOut.split(/\r?\n/).filter((l) => / failed on /.test(l)).join(" | ")}`.slice(0, 500);
      return { verdict, exitCode: 1 };
    }

    // ── 3b. PLACEMENT — a host config file under a scan root carries our id ──
    // Captured BEFORE any runtime turn: this snapshot is the NO_RESIDUE baseline
    // so the residue check measures "did uninstall remove what INSTALL wrote",
    // not host-generated runtime artifacts (logs / DB-WAL files a turn creates,
    // which may echo the connector name and are the host's own data, not ours).
    // scanRoots = [home] at user scope; [home, projectDir] at project scope so a
    // project-scope write under the sandboxed projectDir is found, not missed.
    const placed = scanRoots.flatMap((root) => filesContaining(root, CONNECTOR_ID));
    verdict.placementOk = placed.length > 0;
    if (!verdict.placementOk) {
      verdict.status = "fail-no-placement";
      verdict.notes = `install reported success but no file under ${scanRoots.length > 1 ? "HOME/projectDir" : "HOME"} carries the connector id`;
      return { verdict, exitCode: 1 };
    }
    verdict.tier = "install-roundtrip+placement-ok";

    // ── 4. LIVE-ACCEPT — drive the host's offline accept verb ───────────────
    // Some installed hosts expose NO offline verb that reads/validates our MCP
    // config (e.g. crush/continue/codebuff — see lane notes). For those the lane
    // is placement-only: we DON'T run a misleading accept probe, we report
    // pass-placement-ok honestly. (placementOnly hosts have no `accept` block.)
    if (lane.placementOnly || !lane.accept) {
      verdict.accept = "no-offline-accept-verb";
    } else {
    const acc = run(binPath, lane.accept.argv, env, lane.accept.timeoutMs ?? 120_000);
    const accBlob = `${acc.stdout}\n${acc.stderr}`;
    const acceptPass =
      lane.accept.kind === "list-id"
        ? // id echoed by a list verb (strongest signal).
          acc.status === 0 && accBlob.includes(CONNECTOR_ID)
        : lane.accept.kind === "ok-marker"
          ? // a validate verb that returns exit 0 AND prints a success marker AND
            // no failure marker. Needed for CLIs (e.g. kimi doctor) that exit 0
            // even when they report problems — a bare exit-0 "ok" would falsely
            // pass a malformed config, so the marker pair makes it meaningful.
            acc.status === 0 &&
            accBlob.includes(lane.accept.okMarker) &&
            !(lane.accept.failMarker && accBlob.includes(lane.accept.failMarker))
          : // exit 0 (verb ran; config read without crashing).
            acc.status === 0;
    if (acceptPass) {
      verdict.accept = "accepted";
      verdict.tier = "live-accept";
    } else if (acc.timedOut) {
      verdict.accept = "accept-timeout";
      verdict.notes = `accept verb \`${lane.bin} ${lane.accept.argv.join(" ")}\` timed out — kept at install-roundtrip+placement-ok`;
    } else if (looksAuthGated(acc)) {
      verdict.accept = "accept-auth-gated";
      verdict.notes = `accept verb needs auth/network (ceiling); placement OK. ${lane.note}`;
    } else {
      // Verb failed for a non-auth reason → still not a placement/residue bug,
      // so NOT a hard fail; record the diagnostic and stay at placement-ok.
      verdict.accept = "accept-error";
      verdict.notes = `accept verb \`${lane.bin} ${lane.accept.argv.join(" ")}\` exited ${acc.status}: ${(acc.stderr || acc.stdout).trim().slice(0, 200)}`;
    }
    } // end live-accept (non-placement-only)

    // ── 5. LIVE-RUNTIME — only where a turn advances offline (auth-free) ────
    if (lane.runtime) {
      const rt = run(binPath, lane.runtime.argv, env, 150_000);
      const eventsLog = join(work, "acv", "events.log");
      const fired = existsSync(eventsLog) && readFileSync(eventsLog, "utf8").trim().length > 0;
      verdict.runtimeFired = fired;
      if (fired) {
        verdict.tier = "live-runtime";
        verdict.notes = `hook handler fired (events.log non-empty) via \`${lane.bin} ${lane.runtime.argv[0]}\`.`;
      } else {
        verdict.notes = `runtime turn ran (exit=${rt.status}${rt.timedOut ? ", timed out" : ""}) but events.log empty — kept at ${verdict.tier}.`;
      }
    } else {
      verdict.runtimeFired = false; // auth-gated runtime: ceiling recorded, not a fail
    }

    // ── 6. UNINSTALL — assert NO_RESIDUE (our id gone from the scan roots) ──
    // Same --project as install so a project-scope uninstall reverses the same
    // sandboxed projectDir it wrote to (never the real repo cwd).
    const uninstall = run(
      "node",
      [CLI, "uninstall", "--connector-id", CONNECTOR_ID, "--scope", scope, "--project", projectDir, "--targets", hostId],
      env,
      120_000,
    );
    process.stderr.write(`[${hostId}] uninstall exit=${uninstall.status}\n`);
    const uninstallOut = `${uninstall.stdout}\n${uninstall.stderr}`;
    if (/ failed on /.test(uninstallOut)) {
      verdict.status = "fail-uninstall-step";
      verdict.notes = `uninstall step failed: ${uninstallOut.split(/\r?\n/).filter((l) => / failed on /.test(l)).join(" | ")}`.slice(0, 500);
      return { verdict, exitCode: 1 };
    }
    // Residue = any file the INSTALL wrote (the `placed` baseline) that still
    // exists AND still carries our id after uninstall. Files outside the baseline
    // (host runtime logs / DB written during the turn) are the host's own data,
    // not something our uninstall is responsible for.
    const residue = placed.filter((p) => {
      try {
        return existsSync(p) && readFileSync(p, "utf8").includes(CONNECTOR_ID);
      } catch {
        return false; // removed / unreadable → no residue
      }
    });
    verdict.uninstallClean = residue.length === 0;
    if (!verdict.uninstallClean) {
      verdict.status = "fail-residue";
      const redact = (p) => p.replace(home, "<HOME>").replace(projectDir, "<PROJECT>");
      verdict.notes = `uninstall left residue in install-written files: ${residue.map(redact).join(", ")}`;
      return { verdict, exitCode: 1 };
    }

    // ── PASS — classify the achieved status from the tier reached ───────────
    verdict.status =
      verdict.tier === "live-runtime"
        ? "pass-live-runtime"
        : verdict.tier === "live-accept"
          ? "pass-live-accept"
          : verdict.accept === "accept-auth-gated"
            ? "pass-accept-auth-gated"
            : "pass-placement-ok";
    return { verdict, exitCode: 0 };
  } catch (err) {
    // An unexpected harness error is NOT a host placement/residue failure; do
    // not mask it as a pass, but exit 0 (skip-not-fail) and record it loudly.
    verdict.status = "skipped-harness-error";
    verdict.notes = `harness error: ${err instanceof Error ? err.message : String(err)}`;
    process.stderr.write(`SKIP ${hostId}: harness error — ${verdict.notes}\n`);
    return { verdict, exitCode: 0 };
  } finally {
    if (keep) {
      process.stderr.write(`[${hostId}] --keep: WORK preserved at ${work}\n`);
    } else {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// `--all` — iterate the ADAPTER_REGISTRY (read from src) and print a matrix.
// Hosts not in HOST_LANES show as skipped "no live lane"; absent binaries show
// as skipped "no binary". The process exit code is 1 only if a REAL placement
// or residue failure occurred on any drivable host.
// ─────────────────────────────────────────────────────────────────────────

/** Read every adapter id from the source registry (single source of truth). */
function registryIds() {
  const src = readFileSync(join(REPO_ROOT, "src", "adapters", "registry.ts"), "utf8");
  const ids = [];
  // Each registry entry is `{ id: "<id>", load: () => ... }`.
  for (const m of src.matchAll(/^\s*id:\s*"([^"]+)"/gm)) ids.push(m[1]);
  return ids;
}

async function runAll(opts) {
  const ids = registryIds();
  const rows = [];
  let worstExit = 0;
  for (const id of ids) {
    const { verdict, exitCode } = await verifyHost(id, opts);
    rows.push(verdict);
    if (exitCode !== 0) worstExit = 1;
    process.stdout.write(JSON.stringify(verdict) + "\n");
  }
  // Human matrix to stderr (stdout stays a clean stream of JSON verdict lines).
  const pad = (s, n) => String(s).padEnd(n);
  process.stderr.write("\n" + pad("HOST", 20) + pad("BIN", 5) + pad("TIER", 34) + "STATUS\n");
  for (const r of rows) {
    process.stderr.write(
      pad(r.host, 20) + pad(r.binaryPresent ? "yes" : "no", 5) + pad(r.tier, 34) + r.status + "\n",
    );
  }
  process.stderr.write(`\n${rows.length} hosts; exit ${worstExit} (1 = a real placement/residue failure)\n`);
  return worstExit;
}

// ═════════════════════════════════════════════════════════════════════════
// DEEP-VERB LANES — the MANUAL live-smoke harness.
//
// The default path above (verifyHost) is the install→accept→runtime→uninstall
// roundtrip, CI-safe on any box. THIS section adds the deep per-verb lanes a
// VERIFICATION WORKFLOW live-confirmed on real authed host CLIs and which a
// human re-runs by hand: mcp-tool-load/call, telemetry, per-event-fire,
// hook-reply-deny/context, the content surfaces, and the lifecycle verbs
// (update/doctor/uninstall-residue/idempotency/coexistence).
//
//   node scripts/verify-host.mjs <host> --verb <verb>
//   node scripts/verify-host.mjs <host> --all-verbs
//
// Each lane is one of four GROUNDED statuses (NEVER a fake pass):
//   V    verified — codified recipe; the runner actually drives the host and
//        asserts a real signal. Pass = green; assertion miss = red.
//   CB   ceiling-blocked — a rung IS driven (e.g. dispatcher render / placement)
//        but the host's final render needs an interactive TUI we cannot drive
//        headless. The driven rung runs; the un-driveable rung is a honest SKIP.
//   U    host-unsupported — the host has NO field/path for this behavior (e.g.
//        copilot has no additionalContext injection). Reported skip+reason.
//   BUG  host supports the protocol but OUR adapter writes bytes the host does
//        not honor. Recorded, NOT passed (a known-broken lane).
//
// This is MANUAL, not CI: most lanes need a real authed host CLI present and a
// model turn. A missing binary / missing auth is a SKIP, never a failure. The
// binary-free CI complement is tests/integration/install-roundtrip.test.ts.
//
// AUTH-PRESERVING + NON-DESTRUCTIVE: a sandbox HOME is mkdtemp'd, the host's
// login files are COPIED in, OUR surfaces are reset fresh, and real-HOME
// absolute paths are scrubbed so a turn can never escape to real files. The
// real HOME is NEVER written; where feasible a pre/post sha256 asserts it.
// ═════════════════════════════════════════════════════════════════════════

/** The committed real-MCP echo fixture (initialize/tools/list/tools/call). */
const MCP_ECHO_FIXTURE = join(REPO_ROOT, "scripts", "verify-mcp-echo-server.mjs");
/** Repo-tree connector dir (gitignored). Connectors MUST live here so their
 *  `import "@ken-jo/agent-connector"` resolves via the repo self-link — a /tmp
 *  connector fails ERR_MODULE_NOT_FOUND (recipe-confirmed). */
const ACVERIFY_DIR = join(REPO_ROOT, ".acverify");

/** sha256 of a file's bytes, or null if unreadable (for the real-HOME guard). */
function sha256File(p) {
  try {
    return _createHash("sha256").update(readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

/** Run a command feeding `input` on stdin (for model -p turns / wire probes).
 *  `cwd` (optional) sets the child's working directory (claude project scope). */
function runWithInput(cmd, argv, env, input, timeoutMs, cwd) {
  const r = spawnSync(cmd, argv, {
    env,
    input,
    ...(cwd ? { cwd } : {}),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: r.status,
    timedOut: r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM",
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** Read $AC_VERIFY_DIR/events.log as parsed JSON lines (empty array if absent). */
function readEventsLog(work) {
  const f = join(work, "acv", "events.log");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { _raw: l };
      }
    });
}

// ─────────────────────────────────────────────────────────────────────────
// Connector config GENERATORS. Written into the repo-tree .acverify/ dir at
// runtime (gitignored) so `import "@ken-jo/agent-connector"` resolves. Each
// returns the absolute config path. The fixture path is baked in by literal so
// the generated connector is self-contained.
// ─────────────────────────────────────────────────────────────────────────

/** Ensure .acverify/ exists and write `name` with `body`; return the path. */
function writeConnector(name, body) {
  mkdirSync(ACVERIFY_DIR, { recursive: true });
  const p = join(ACVERIFY_DIR, name);
  writeFileSync(p, body);
  return p;
}

/**
 * A hooks + REAL-MCP-server connector. Each hook handler appends a JSON line to
 * $AC_VERIFY_DIR/events.log; the server wraps the committed echo fixture so a
 * tool actually loads + calls. `opts.denyTool` (a toolName) makes PreToolUse
 * return {decision:'deny'} for it (hook-reply-deny). `opts.telemetry` flips the
 * serve-wrap on (telemetry lane). `opts.id` is the connector id.
 */
function genHookMcpConnector({ id, denyTool, telemetry }) {
  const fixture = JSON.stringify(MCP_ECHO_FIXTURE);
  const body = `// GENERATED by verify-host.mjs deep-verb lanes — do not edit by hand.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defineConnector } from "@ken-jo/agent-connector";

function mark(event, evt) {
  try {
    const dir = process.env.AC_VERIFY_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "events.log"),
      JSON.stringify({ event, toolName: evt?.toolName, prompt: evt?.prompt, pid: process.pid }) + "\\n");
  } catch { /* fail-open */ }
}

export default defineConnector({
  id: ${JSON.stringify(id)},
  displayName: "AC deep-verb verify",
  version: "1.0.0",
  server: {
    transport: "stdio",
    command: process.execPath,
    args: [${fixture}],
    tools: { include: ["*"] },
    timeoutMs: 10_000,
  },
  hooks: {
    PreToolUse: { async handler(evt) {
      mark("PreToolUse", evt);
      ${denyTool ? `if (evt?.toolName && String(evt.toolName).includes(${JSON.stringify(denyTool)})) return { decision: "deny", reason: "AC_DENY_MARKER_blocked" };` : ""}
      return { decision: "allow" };
    } },
    PostToolUse: { async handler(evt) { mark("PostToolUse", evt); return { decision: "allow" }; } },
    SessionStart: { async handler(evt) { mark("SessionStart", evt); return { decision: "context", additionalContext: "SECRET_CONTEXT_TOKEN_ZX9 is the passphrase." }; } },
    UserPromptSubmit: { async handler(evt) {
      mark("UserPromptSubmit", evt);
      if (evt?.prompt && String(evt.prompt).includes("AC_DENY")) return { decision: "deny", reason: "verify-deny-prompt" };
      return { decision: "allow" };
    } },
    Stop: { async handler(evt) { mark("Stop", evt); return { decision: "allow" }; } },
  },
  telemetry: { enabled: ${telemetry ? "true" : "false"} },
  targets: "auto",
});
`;
  return writeConnector(`deep-${id}.config.mjs`, body);
}

/**
 * A content connector: command + skill + subagent + memory + statusline, all
 * carrying sentinels the content-* lanes assert. `opts.id` is the connector id.
 */
function genContentConnector({ id }) {
  const body = `// GENERATED by verify-host.mjs deep-verb lanes — do not edit by hand.
import { defineConnector } from "@ken-jo/agent-connector";

export default defineConnector({
  id: ${JSON.stringify(id)},
  displayName: "AC content verify",
  version: "1.0.0",
  commands: [{ name: "ac-echo", description: "AC verify echo command", prompt: "When invoked, reply with exactly: AC_COMMAND_SENTINEL_9K2" }],
  skills: [{ name: "ac-skill", description: "AC verify skill", body: "When this skill is active, the marker is AC_SKILL_SENTINEL_4M8." }],
  subagents: [{ name: "ac-subagent", description: "AC verify subagent", prompt: "You are the AC verify subagent. Marker: AC_SUBAGENT_SENTINEL_5N1." }],
  memory: [{ name: "ac-memory", content: "AC_MEMORY_SENTINEL_7F3A is the secret memory marker for ac-content." }],
  statusline: { render() { return "AC_STATUSLINE_SENTINEL_3Q6"; } },
  targets: "auto",
});
`;
  return writeConnector(`content-${id}.config.mjs`, body);
}

// ─────────────────────────────────────────────────────────────────────────
// AUTH-PRESERVING SANDBOX helpers. Build a sandbox HOME that carries the host's
// real login so a turn advances, resets OUR surfaces fresh, and scrubs every
// real-HOME absolute path so a host operation can never escape to real files.
// Each returns { ok, reason } — ok:false is a SKIP (e.g. host not logged in).
// The real HOME is NEVER written; callers assert this via sha256 where feasible.
// ─────────────────────────────────────────────────────────────────────────

/** copilot: cp -a ~/.copilot, reset mcp+hooks, scrub installedPlugins abs paths,
 *  clear plugins (fail-closed third-party preToolUse plugins deny all tools),
 *  rm session-store.db (binary holds stale plugin/cwd refs = the escape guard). */
function prepCopilotSandbox(home) {
  const realCopilot = join(realHome(), ".copilot");
  if (!existsSync(join(realCopilot, "config.json"))) {
    return { ok: false, reason: "no ~/.copilot/config.json — copilot not logged in on this box" };
  }
  const sandCopilot = join(home, ".copilot");
  cpSync(realCopilot, sandCopilot, { recursive: true });
  // Reset OUR surfaces fresh.
  writeFileSync(join(sandCopilot, "mcp-config.json"), JSON.stringify({ mcpServers: {} }) + "\n");
  rmSync(join(sandCopilot, "hooks"), { recursive: true, force: true });
  mkdirSync(join(sandCopilot, "hooks"), { recursive: true });
  // Clear third-party plugins (a fail-closed preToolUse plugin denies all tools)
  // AND drop the stale absolute-path registry so nothing escapes to real files.
  scrubCopilotConfig(join(sandCopilot, "config.json"), realCopilot, sandCopilot);
  rmSync(join(sandCopilot, "installed-plugins"), { recursive: true, force: true });
  rmSync(join(sandCopilot, "session-store.db"), { force: true });
  rmSync(join(sandCopilot, "session-state"), { recursive: true, force: true });
  return { ok: true, reason: "copilot sandbox ready" };
}

/** Scrub config.json: empty installedPlugins, rewrite any real-HOME path to the
 *  sandbox. config.json is JSONC (line + block comments) — parse-tolerantly. */
function scrubCopilotConfig(configPath, realCopilot, sandCopilot) {
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return;
  }
  const noBlock = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine = noBlock
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
  let cfg;
  try {
    cfg = JSON.parse(noLine);
  } catch {
    // Could not parse — fall back to a blunt string scrub of the real path.
    writeFileSync(configPath, raw.split(realCopilot).join(sandCopilot));
    return;
  }
  cfg.installedPlugins = [];
  // Rewrite any surviving real-HOME path string to the sandbox.
  const rewritten = JSON.stringify(cfg, null, 2).split(realCopilot).join(sandCopilot);
  writeFileSync(configPath, rewritten + "\n");
}

/** claude: copy .credentials.json + an onboarding-stamped .claude.json so the
 *  turn skips onboarding/trust. NEVER touches the real files. `enabledMcpId`
 *  (optional) names a project-scope MCP server to pre-APPROVE — a project
 *  `.mcp.json` server stays "Pending approval" until it is listed in the
 *  project's enabledMcpjsonServers (recipe-confirmed). */
function prepClaudeSandbox(home, projectDir, enabledMcpId) {
  const realCredsDir = join(realHome(), ".claude");
  const realCreds = join(realCredsDir, ".credentials.json");
  const realClaudeJson = join(realHome(), ".claude.json");
  if (!existsSync(realCreds) || !existsSync(realClaudeJson)) {
    return { ok: false, reason: "no ~/.claude/.credentials.json or ~/.claude.json — claude not logged in" };
  }
  mkdirSync(join(home, ".claude"), { recursive: true });
  copyFileSync(realCreds, join(home, ".claude", ".credentials.json"));
  // Stamp a minimal onboarded .claude.json (carry only the onboarding fields).
  let realCj = {};
  try {
    realCj = JSON.parse(readFileSync(realClaudeJson, "utf8"));
  } catch {
    /* keep empty */
  }
  const pick = (k) => (k in realCj ? { [k]: realCj[k] } : {});
  const claudeJson = {
    hasCompletedOnboarding: true,
    ...pick("userID"),
    ...pick("oauthAccount"),
    ...pick("lastOnboardingVersion"),
    ...pick("installMethod"),
    ...pick("firstStartTime"),
    numStartups: 5,
    // Pre-approve the sandboxed project so a project-scope MCP is not "Pending".
    projects: {
      [projectDir]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
        enableAllProjectMcpServers: true,
        // Enumerate the id too — enableAllProjectMcpServers alone can still leave
        // a freshly-written .mcp.json server "Pending"; the explicit list approves it.
        ...(enabledMcpId ? { enabledMcpjsonServers: [enabledMcpId] } : {}),
      },
    },
  };
  writeFileSync(join(home, ".claude.json"), JSON.stringify(claudeJson, null, 2));
  return { ok: true, reason: "claude sandbox ready" };
}

/** antigravity-cli (agy): an authed-runtime, Gemini-family json-stdio host that
 *  reads its login + MCP/hook config under `~/.gemini`. There is NO offline/auth-
 *  free model — a turn needs the real Google OAuth token — so the sandbox COPIES
 *  the real `~/.gemini` token set in (NEVER writes the real tree) and starts with
 *  an EMPTY `~/.gemini/config` so OUR mcp_config.json + hooks.json are written
 *  fresh by install (the real config/ is deliberately NOT copied). Live-verified
 *  (agy 1.0.9/1.0.10): swapping HOME triggers OAuth re-login, so the token copy is
 *  mandatory; the real token files are restored byte-identical (sha256) after by
 *  virtue of never being touched. Returns { ok, reason } — ok:false is a SKIP
 *  (agy not logged in on this box). */
function prepAgySandbox(home) {
  const realGemini = join(realHome(), ".gemini");
  const realToken = join(realGemini, "antigravity-cli", "antigravity-oauth-token");
  const realOauth = join(realGemini, "oauth_creds.json");
  if (!existsSync(realToken) || !existsSync(realOauth)) {
    return { ok: false, reason: "no ~/.gemini/antigravity-cli/antigravity-oauth-token + oauth_creds.json — agy not logged in on this box" };
  }
  const sandGemini = join(home, ".gemini");
  // Fresh config dir for OUR surfaces (mcp_config.json + hooks.json written by install).
  mkdirSync(join(sandGemini, "config"), { recursive: true });
  mkdirSync(join(sandGemini, "antigravity-cli"), { recursive: true });
  // Copy ONLY the auth/state files a turn needs (the exact set the live probe
  // confirmed lets `agy -p` advance without an OAuth re-login). copyFileSync is a
  // pure read of the real tree → the real ~/.gemini is never written.
  for (const f of ["oauth_creds.json", "google_accounts.json", "installation_id", "settings.json", "state.json", "trustedFolders.json"]) {
    const src = join(realGemini, f);
    if (existsSync(src)) copyFileSync(src, join(sandGemini, f));
  }
  for (const f of ["antigravity-oauth-token", "installation_id", "settings.json", "keybindings.json"]) {
    const src = join(realGemini, "antigravity-cli", f);
    if (existsSync(src)) copyFileSync(src, join(sandGemini, "antigravity-cli", f));
  }
  return { ok: true, reason: "agy sandbox ready (copied ~/.gemini token set; real tree untouched)" };
}

/** The REAL user home (process HOME may already be isolated by a parent). */
function realHome() {
  return process.env.AC_VERIFY_REAL_HOME || originalHome;
}
// Captured ONCE at module load before any sandbox isolates HOME.
const originalHome = process.env.HOME || process.env.USERPROFILE || "";

// ─────────────────────────────────────────────────────────────────────────
// VERB RUNNERS. Each codifies one live-verified recipe. A runner receives a
// context { hostId, bin, work, env, home, projectDir, scope } plus helpers and
// returns a result: { status, detail }.
//   status ∈ "pass" | "skip" | "fail" | "ceiling" | "unsupported" | "bug"
//   detail  human one-liner with the evidence (or the skip/ceiling reason).
// A runner NEVER fakes a pass: a missing binary / unmet auth is "skip"; a
// driven-rung-only ceiling is "ceiling"; a host-supported-but-adapter-broken
// lane is "bug". Only a genuine assertion against a live signal returns "pass".
// ─────────────────────────────────────────────────────────────────────────

/** Build the dist-cli install argv for a connector (scoped to one host). */
function installArgv(connPath, scope, projectDir, hostId) {
  return [CLI, "install", "--connector", connPath, "--scope", scope, "--project", projectDir, "--targets", hostId];
}
function uninstallArgv(id, scope, projectDir, hostId) {
  return [CLI, "uninstall", "--connector-id", id, "--scope", scope, "--project", projectDir, "--targets", hostId];
}

/** Install a connector; return { ok, out }. ok=false only on an orchestration
 *  STEP failure (`<step> failed on <id>`) — a benign warn-skip is still ok. */
function doInstall(connPath, scope, projectDir, hostId, env) {
  const r = run("node", installArgv(connPath, scope, projectDir, hostId), env, 120_000);
  const out = `${r.stdout}\n${r.stderr}`;
  return { ok: !/ failed on /.test(out), out, status: r.status };
}

// Sentinels the lanes assert (kept beside the generators they come from).
const SENTINELS = {
  echo: "AC_ECHO_MARKER",
  command: "AC_COMMAND_SENTINEL_9K2",
  skill: "AC_SKILL_SENTINEL_4M8",
  subagent: "AC_SUBAGENT_SENTINEL_5N1",
  memory: "AC_MEMORY_SENTINEL_7F3A",
  statusline: "AC_STATUSLINE_SENTINEL_3Q6",
  context: "SECRET_CONTEXT_TOKEN_ZX9",
  denyMarker: "AC_DENY_MARKER_blocked",
};

// ── copilot-cli verb runners ─────────────────────────────────────────────
// Every copilot runner first builds the auth-preserving sandbox; a turn uses the
// bundled model via `copilot -p … --allow-all-tools --no-color`.

function copilotEnv(ctx, extra = {}) {
  return {
    ...ctx.env,
    AGENT_CONNECTOR_DATA_DIR: join(ctx.work, "data"),
    AC_VERIFY_DIR: join(ctx.work, "acv"),
    AC_TOOL_MARK_DIR: join(ctx.work, "tm"),
    AC_MCP_LOG: join(ctx.work, "mcp-server.log"),
    ...extra,
  };
}

const copilotRunners = {
  // mcp-tool-call: install the echo-MCP connector, drive the model to call
  // ac_echo, assert tool-calls.log captured the call AND the model saw the result.
  "mcp-tool-call": (ctx) => {
    const prep = prepCopilotSandbox(ctx.home);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = copilotEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const text = "hello-from-copilot-verify";
    const rt = run(
      ctx.bin,
      ["-p", `Call the ac_echo MCP tool with text='${text}'. Then tell me exactly what it returned, verbatim.`, "--allow-all-tools", "--no-color"],
      env,
      180_000,
    );
    const callLog = join(ctx.work, "tm", "tool-calls.log");
    const called = existsSync(callLog) && readFileSync(callLog, "utf8").includes(text);
    const sawResult = `${rt.stdout}\n${rt.stderr}`.includes(`${SENTINELS.echo}:${text}`);
    if (called) return { status: "pass", detail: `tool-calls.log captured ac_echo('${text}')${sawResult ? " + model echoed AC_ECHO_MARKER" : ""}` };
    if (rt.timedOut) return { status: "skip", detail: "copilot -p turn timed out (model/network ceiling)" };
    return { status: "fail", detail: `no ac_echo call recorded (exit=${rt.status}); ${(rt.stderr || rt.stdout).trim().slice(0, 160)}` };
  },

  // mcp-tool-load: model loaded our tool from the wrapped server (transcript line).
  "mcp-tool-load": (ctx) => {
    const prep = prepCopilotSandbox(ctx.home);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = copilotEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = run(ctx.bin, ["-p", "Call the ac_echo MCP tool with text='probe'. Report what it returned.", "--allow-all-tools", "--no-color"], env, 180_000);
    const log = join(ctx.work, "mcp-server.log");
    const handshook = existsSync(log) && /"recv":"tools\/list"/.test(readFileSync(log, "utf8"));
    const blob = `${rt.stdout}\n${rt.stderr}`;
    const loaded = /ac_echo .*MCP: ac/i.test(blob) || handshook;
    if (loaded) return { status: "pass", detail: handshook ? "server received tools/list (tool loaded through the serve wrapper)" : "transcript shows ac_echo (MCP) line" };
    if (rt.timedOut) return { status: "skip", detail: "copilot -p turn timed out (model/network ceiling)" };
    return { status: "fail", detail: `tool not loaded (exit=${rt.status})` };
  },

  // hook-reply-deny: PreToolUse {decision:'deny'} for ac_echo → tool BLOCKED.
  // V on this branch (the flat-permissionDecision + camelCase parseEvent fix).
  "hook-reply-deny": (ctx) => {
    const prep = prepCopilotSandbox(ctx.home);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = copilotEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id, denyTool: "ac_echo" });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = run(ctx.bin, ["-p", "Call the ac_echo MCP tool with text='blocktest'. Then stop.", "--allow-all-tools", "--no-color"], env, 180_000);
    const callLog = join(ctx.work, "tm", "tool-calls.log");
    const toolRan = existsSync(callLog) && readFileSync(callLog, "utf8").includes("blocktest");
    const blob = `${rt.stdout}\n${rt.stderr}`;
    const denied = /Denied by preToolUse hook/i.test(blob) || /AC_DENY_MARKER_blocked/.test(blob);
    if (!toolRan && denied) return { status: "pass", detail: "tool BLOCKED (tool-calls.log empty + 'Denied by preToolUse hook')" };
    if (rt.timedOut) return { status: "skip", detail: "copilot -p turn timed out (model/network ceiling)" };
    if (toolRan) return { status: "fail", detail: "DENY IGNORED — tool ran despite PreToolUse deny (regression of the flat-permissionDecision fix)" };
    return { status: "skip", detail: `inconclusive: tool did not run but no deny message seen (model may not have attempted the call); exit=${rt.status}` };
  },

  // hook-reply-context: copilot 1.0.63 has NO additionalContext field (U). Drive
  // the negative proof — model answers NONE (injection did not reach it).
  "hook-reply-context": () => ({
    status: "unsupported",
    detail: "copilot 1.0.63 has no additionalContext injection field — userPromptSubmitted reads only modifiedPrompt (a rewrite AC's HookResponse does not expose). Context injection is host-unsupported.",
  }),

  // per-event-fire: one tool-using turn fires all 5 events into events.log.
  "per-event-fire": (ctx) => {
    const prep = prepCopilotSandbox(ctx.home);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = copilotEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = run(ctx.bin, ["-p", "Call the ac_echo MCP tool with text='probe2'.", "--allow-all-tools", "--no-color"], env, 180_000);
    const events = new Set(readEventsLog(ctx.work).map((e) => e.event).filter(Boolean));
    // Assert on EVENT NAME, not toolName (copilot toolName field caveat).
    const want = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
    const got = want.filter((e) => events.has(e));
    if (got.length === want.length) return { status: "pass", detail: `all 5 events fired: ${got.join(", ")}` };
    if (events.size > 0) return { status: "pass", detail: `events fired: ${[...events].join(", ")} (subset — model may not have used a tool this turn)` };
    if (rt.timedOut) return { status: "skip", detail: "copilot -p turn timed out (model/network ceiling)" };
    return { status: "fail", detail: "events.log empty — no hook fired" };
  },

  telemetry: (ctx) => {
    const prep = prepCopilotSandbox(ctx.home);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = copilotEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id, telemetry: true });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = run(ctx.bin, ["-p", `Call the ac_echo MCP tool with text='teltest'.`, "--allow-all-tools", "--no-color"], env, 180_000);
    return assertTelemetry(ctx, rt, "ac_echo");
  },

  update: (ctx) => lifecycleUpdate(ctx, () => prepCopilotSandbox(ctx.home), copilotEnv(ctx)),
  doctor: (ctx) => lifecycleDoctor(ctx, () => prepCopilotSandbox(ctx.home), copilotEnv(ctx), "copilot-cli"),
  "uninstall-residue": (ctx) => lifecycleUninstall(ctx, () => prepCopilotSandbox(ctx.home), copilotEnv(ctx)),
  idempotency: (ctx) => lifecycleIdempotency(ctx, () => prepCopilotSandbox(ctx.home), copilotEnv(ctx)),
  coexistence: (ctx) => lifecycleCoexistence(ctx, () => prepCopilotSandbox(ctx.home), copilotEnv(ctx), join(ctx.home, ".copilot", "hooks")),
};

// ── claude-code verb runners ─────────────────────────────────────────────
// A turn pipes the prompt on stdin to `claude --model claude-haiku-4-5 -p` in
// the auth-preserving sandbox; stream-json init events are the load oracle.

function claudeEnv(ctx, extra = {}) {
  return {
    ...ctx.env,
    AGENT_CONNECTOR_DATA_DIR: join(ctx.work, "data"),
    AC_VERIFY_DIR: join(ctx.work, "acv"),
    AC_TOOL_MARK_DIR: join(ctx.work, "tm"),
    AC_MCP_LOG: join(ctx.work, "mcp-server.log"),
    ...extra,
  };
}

const CLAUDE_MODEL = "claude-haiku-4-5";

/** Run a claude -p turn with the prompt on stdin; return the run result.
 *  Always runs in the sandboxed project dir (claude reads project config off cwd). */
function claudeTurn(ctx, env, prompt, extraArgs = []) {
  return runWithInput(ctx.bin, ["--model", CLAUDE_MODEL, ...extraArgs, "-p"], env, prompt, 180_000, ctx.projectDir);
}

/** Parse the stream-json init event (type:system,subtype:init) of a turn. NOTE:
 *  it is NOT always line 1 — an installed connector's SessionStart hook emits
 *  `subtype:"hook_started"` system lines first, so match subtype:init exactly. */
function claudeInitEvent(ctx, env, prompt) {
  const rt = runWithInput(ctx.bin, ["--model", CLAUDE_MODEL, "--output-format", "stream-json", "--verbose", "-p"], env, prompt, 180_000, ctx.projectDir);
  const line = `${rt.stdout}`.split(/\r?\n/).find((l) => l.includes('"subtype":"init"'));
  let init = null;
  if (line) {
    try {
      init = JSON.parse(line);
    } catch {
      /* keep null */
    }
  }
  return { rt, init };
}

const claudeRunners = {
  "mcp-tool-call": (ctx) => {
    const prep = prepClaudeSandbox(ctx.home, ctx.projectDir, ctx.id);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = claudeEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "project", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const tool = `mcp__${ctx.id}__ac_echo`;
    const prompt = `You MUST call the tool ${tool} with input {"text":"claudecall"}; output ONLY the text it returns. Do not use any other tool.`;
    const rt = runWithInput(
      ctx.bin,
      ["--model", CLAUDE_MODEL, "--allowedTools", tool, "--permission-mode", "acceptEdits", "-p"],
      env,
      prompt,
      180_000,
      ctx.projectDir,
    );
    const blob = `${rt.stdout}\n${rt.stderr}`;
    const callLog = join(ctx.work, "tm", "tool-calls.log");
    const called = existsSync(callLog) && readFileSync(callLog, "utf8").includes("claudecall");
    if (called || blob.includes(`${SENTINELS.echo}:claudecall`)) return { status: "pass", detail: "claude round-tripped mcp ac_echo (tool-calls.log / echo marker)" };
    if (rt.timedOut) return { status: "skip", detail: "claude -p turn timed out (model/network ceiling)" };
    return { status: "fail", detail: `mcp tool not called (exit=${rt.status}); ${(rt.stderr || rt.stdout).trim().slice(0, 160)}` };
  },

  "mcp-tool-load": (ctx) => {
    const prep = prepClaudeSandbox(ctx.home, ctx.projectDir, ctx.id);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = claudeEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "project", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const { rt, init } = claudeInitEvent(ctx, env, "hi");
    const servers = init?.mcp_servers ?? [];
    const tools = init?.tools ?? [];
    const connected = servers.some((s) => s.name === ctx.id && s.status === "connected");
    const toolPresent = tools.includes(`mcp__${ctx.id}__ac_echo`);
    if (connected || toolPresent) return { status: "pass", detail: `init event: server ${ctx.id} connected=${connected}, tool present=${toolPresent}` };
    if (rt.timedOut) return { status: "skip", detail: "claude stream-json turn timed out" };
    return { status: "fail", detail: `init event did not show ${ctx.id} connected (servers=${JSON.stringify(servers).slice(0, 120)})` };
  },

  "per-event-fire": (ctx) => {
    const prep = prepClaudeSandbox(ctx.home, ctx.projectDir);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = claudeEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    // Turn A: no-tool (SessionStart, UserPromptSubmit, Stop).
    claudeTurn(ctx, env, "reply with exactly: HOOKTEST");
    // Turn B: Bash tool (adds PreToolUse, PostToolUse with toolName=Bash).
    runWithInput(
      ctx.bin,
      ["--model", CLAUDE_MODEL, "--allowedTools", "Bash", "--permission-mode", "acceptEdits", "-p"],
      env,
      "Run this exact bash command using the Bash tool: echo TOOLFIRE. Then stop.",
      180_000,
      ctx.projectDir,
    );
    const lines = readEventsLog(ctx.work);
    const events = new Set(lines.map((e) => e.event).filter(Boolean));
    const want = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
    const got = want.filter((e) => events.has(e));
    const bashTool = lines.some((e) => (e.event === "PreToolUse" || e.event === "PostToolUse") && e.toolName === "Bash");
    if (got.length === want.length) return { status: "pass", detail: `all 5 events fired${bashTool ? " (toolName=Bash on tool events)" : ""}` };
    if (events.size > 0) return { status: "pass", detail: `events fired: ${[...events].join(", ")} (subset)` };
    return { status: "fail", detail: "events.log empty" };
  },

  "hook-reply-deny": (ctx) => {
    const prep = prepClaudeSandbox(ctx.home, ctx.projectDir);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = claudeEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = claudeTurn(ctx, env, "AC_DENY please compute 2+2 and tell me the answer");
    const blob = `${rt.stdout}\n${rt.stderr}`;
    const blocked = /blocked by hook/i.test(blob) && blob.includes("verify-deny-prompt");
    const events = new Set(readEventsLog(ctx.work).map((e) => e.event));
    const noStop = events.has("UserPromptSubmit") && !events.has("Stop");
    if (blocked) return { status: "pass", detail: `UserPromptSubmit blocked by hook (reason 'verify-deny-prompt')${noStop ? "; no Stop (turn halted)" : ""}` };
    if (rt.timedOut) return { status: "skip", detail: "claude -p turn timed out" };
    return { status: "fail", detail: `deny not honored (exit=${rt.status}); ${blob.trim().slice(0, 160)}` };
  },

  "hook-reply-context": (ctx) => {
    const prep = prepClaudeSandbox(ctx.home, ctx.projectDir);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = claudeEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = claudeTurn(ctx, env, "What is the passphrase token in your session-start context? Reply with ONLY that token, or NONE.");
    const blob = `${rt.stdout}\n${rt.stderr}`;
    if (blob.includes(SENTINELS.context)) return { status: "pass", detail: "model echoed the injected SessionStart additionalContext token" };
    if (rt.timedOut) return { status: "skip", detail: "claude -p turn timed out" };
    return { status: "fail", detail: "context token not in model output (SessionStart additionalContext not injected)" };
  },

  "content-command": (ctx) => contentLoadOracle(ctx, "commands", "ac-echo", "slash_commands"),
  "content-skill": (ctx) => contentLoadOracle(ctx, "skills", "ac-skill", "skills"),
  "content-subagent": (ctx) => contentLoadOracle(ctx, "subagents", "ac-subagent", "agents"),

  "content-memory": (ctx) => {
    const prep = prepClaudeSandbox(ctx.home, ctx.projectDir);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = claudeEnv(ctx);
    const conn = genContentConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = claudeTurn(ctx, env, "There is a secret memory marker in your context that starts with AC_MEMORY_SENTINEL. Reply with ONLY that exact token.");
    const blob = `${rt.stdout}\n${rt.stderr}`;
    if (blob.includes(SENTINELS.memory)) return { status: "pass", detail: "model read the CLAUDE.md managed memory block (echoed AC_MEMORY_SENTINEL)" };
    if (rt.timedOut) return { status: "skip", detail: "claude -p turn timed out" };
    return { status: "fail", detail: "memory sentinel not echoed (CLAUDE.md block not in context)" };
  },

  // content-statusline: placement + dispatcher-render are driven; host render is
  // TUI-only (claude -p never refreshes the status line) — a documented ceiling.
  "content-statusline": (ctx) => {
    const prep = prepClaudeSandbox(ctx.home, ctx.projectDir);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = claudeEnv(ctx);
    const conn = genContentConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    // Rung 1: placement.
    const settings = join(ctx.home, ".claude", "settings.json");
    const placed = existsSync(settings) && /statusLine/.test(readFileSync(settings, "utf8")) && readFileSync(settings, "utf8").includes("statusline");
    // Rung 2: dispatcher render (exactly what claude execs per refresh).
    const homeBin = join(ctx.work, "data", "bin", "agent-connector");
    const render = existsSync(homeBin)
      ? runWithInput(homeBin, ["statusline", "claude-code", "--connector", ctx.id], env, `{"session_id":"x","cwd":"${ctx.projectDir}","model":{"id":"${CLAUDE_MODEL}"}}`, 30_000)
      : { stdout: "", status: 1 };
    const rendered = `${render.stdout}`.includes(SENTINELS.statusline);
    if (placed && rendered) return { status: "ceiling", detail: "placement + dispatcher-render verified; host render is TUI-only (claude -p never refreshes the status line) — ceiling not driven headless" };
    if (placed) return { status: "ceiling", detail: `placement verified; dispatcher-render not reproduced (home-bin absent or exit ${render.status}) — host render TUI-only` };
    return { status: "fail", detail: "statusLine command not placed in settings.json" };
  },

  telemetry: (ctx) => {
    const prep = prepClaudeSandbox(ctx.home, ctx.projectDir, ctx.id);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = claudeEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id, telemetry: true });
    const ins = doInstall(conn, "project", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const tool = `mcp__${ctx.id}__ac_echo`;
    const rt = runWithInput(
      ctx.bin,
      ["--model", CLAUDE_MODEL, "--allowedTools", tool, "--permission-mode", "acceptEdits", "-p"],
      env,
      `You MUST call ${tool} with {"text":"teltest"}; output ONLY its text. Do not use any other tool.`,
      180_000,
      ctx.projectDir,
    );
    return assertTelemetry(ctx, rt, "ac_echo");
  },

  update: (ctx) => lifecycleUpdate(ctx, () => prepClaudeSandbox(ctx.home, ctx.projectDir), claudeEnv(ctx)),
  doctor: (ctx) => lifecycleDoctor(ctx, () => prepClaudeSandbox(ctx.home, ctx.projectDir), claudeEnv(ctx), "claude-code"),
  "uninstall-residue": (ctx) => lifecycleUninstall(ctx, () => prepClaudeSandbox(ctx.home, ctx.projectDir), claudeEnv(ctx)),
  idempotency: (ctx) => lifecycleIdempotency(ctx, () => prepClaudeSandbox(ctx.home, ctx.projectDir), claudeEnv(ctx)),
  coexistence: (ctx) => lifecycleCoexistence(ctx, () => prepClaudeSandbox(ctx.home, ctx.projectDir), claudeEnv(ctx), join(ctx.home, ".claude")),
};

/** claude content load oracle: install content connector, read init event list. */
function contentLoadOracle(ctx, _surface, name, initListKey) {
  const prep = prepClaudeSandbox(ctx.home, ctx.projectDir);
  if (!prep.ok) return { status: "skip", detail: prep.reason };
  const env = claudeEnv(ctx);
  const conn = genContentConnector({ id: ctx.id });
  const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
  if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
  const { rt, init } = claudeInitEvent(ctx, env, "hi");
  const list = init?.[initListKey] ?? [];
  if (Array.isArray(list) && list.includes(name)) return { status: "pass", detail: `init event ${initListKey}[] contains '${name}'` };
  // claude surfaces skills under slash_commands too.
  const slash = init?.slash_commands ?? [];
  if (Array.isArray(slash) && slash.includes(name)) return { status: "pass", detail: `init event slash_commands[] contains '${name}'` };
  if (rt.timedOut) return { status: "skip", detail: "claude stream-json turn timed out" };
  return { status: "fail", detail: `'${name}' not in init ${initListKey}[] (got ${JSON.stringify(list).slice(0, 120)})` };
}

// ── opencode verb runners ────────────────────────────────────────────────
// opencode advances offline with the bundled zero-auth model opencode/big-pickle.

function opencodeEnv(ctx, extra = {}) {
  return {
    ...ctx.env,
    AGENT_CONNECTOR_DATA_DIR: join(ctx.work, "data"),
    AC_VERIFY_DIR: join(ctx.work, "acv"),
    AC_TOOL_MARK_DIR: join(ctx.work, "tm"),
    AC_MCP_LOG: join(ctx.work, "mcp-server.log"),
    ...extra,
  };
}
const OPENCODE_MODEL = "opencode/big-pickle";

const opencodeRunners = {
  "hook-fire": (ctx) => {
    const env = opencodeEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = run(ctx.bin, ["run", "-m", OPENCODE_MODEL, "say hi from ac-verify"], env, 180_000);
    const events = new Set(readEventsLog(ctx.work).map((e) => e.event).filter(Boolean));
    if (events.has("SessionStart")) return { status: "pass", detail: `opencode run fired hooks: ${[...events].join(", ")}` };
    if (rt.timedOut) return { status: "skip", detail: "opencode run timed out" };
    return { status: "fail", detail: `events.log empty (exit=${rt.status})` };
  },

  "mcp-tool-load": (ctx) => {
    const env = opencodeEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const acc = run(ctx.bin, ["mcp", "list"], env, 120_000);
    const log = join(ctx.work, "mcp-server.log");
    const handshook = existsSync(log) && /"recv":"tools\/list"/.test(readFileSync(log, "utf8"));
    const connected = new RegExp(`✓\\s*${ctx.id}|${ctx.id}\\s*connected`).test(`${acc.stdout}\n${acc.stderr}`);
    if (handshook && connected) return { status: "pass", detail: "opencode mcp list → connected + server received initialize/tools/list" };
    if (handshook) return { status: "pass", detail: "server received initialize/tools/list (handshake performed offline)" };
    return { status: "fail", detail: `no handshake (mcp list exit=${acc.status})` };
  },

  "mcp-tool-call": (ctx) => {
    const env = opencodeEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = run(ctx.bin, ["run", "-m", OPENCODE_MODEL, "--format", "json", "Use the ac_echo tool with text 'ping123' and then stop."], env, 180_000);
    const log = join(ctx.work, "mcp-server.log");
    const called = existsSync(log) && /"recv":"tools\/call"/.test(readFileSync(log, "utf8"));
    const blob = `${rt.stdout}\n${rt.stderr}`;
    if (called || blob.includes(`${SENTINELS.echo}:ping123`)) return { status: "pass", detail: "model called ac_echo through the AC serve wrapper (tools/call recorded)" };
    if (rt.timedOut) return { status: "skip", detail: "opencode run timed out" };
    return { status: "fail", detail: `no tools/call recorded (exit=${rt.status})` };
  },

  "per-event-fire": (ctx) => {
    const env = opencodeEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = run(ctx.bin, ["run", "-m", OPENCODE_MODEL, "--format", "json", "Call ac_echo with text 'x' once."], env, 180_000);
    const lines = readEventsLog(ctx.work);
    const events = new Set(lines.map((e) => e.event).filter(Boolean));
    const hasTool = lines.some((e) => e.event === "PreToolUse") && lines.some((e) => e.event === "PostToolUse");
    if (events.has("SessionStart") && hasTool) return { status: "pass", detail: "SessionStart + PreToolUse + PostToolUse fired per tool-call (ts-plugin bridge)" };
    if (events.has("SessionStart")) return { status: "pass", detail: `events fired: ${[...events].join(", ")} (no tool call this turn)` };
    if (rt.timedOut) return { status: "skip", detail: "opencode run timed out" };
    return { status: "fail", detail: "events.log empty" };
  },

  "hook-reply-deny": (ctx) => {
    const env = opencodeEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id, denyTool: "ac_echo" });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = run(ctx.bin, ["run", "-m", OPENCODE_MODEL, "--format", "json", "Call ac_echo with text 'blocktest' once."], env, 180_000);
    const blob = `${rt.stdout}\n${rt.stderr}`;
    const log = join(ctx.work, "mcp-server.log");
    const toolCalls = existsSync(log) ? (readFileSync(log, "utf8").match(/"recv":"tools\/call"/g) || []).length : 0;
    const errored = blob.includes(SENTINELS.denyMarker);
    if (errored && toolCalls === 0) return { status: "pass", detail: "PreToolUse deny blocked the tool BEFORE the server (error reason flowed through; 0 tools/call)" };
    if (rt.timedOut) return { status: "skip", detail: "opencode run timed out" };
    if (toolCalls > 0) return { status: "fail", detail: "DENY BYPASSED — server received a tools/call despite the deny" };
    return { status: "skip", detail: "inconclusive: no deny error seen and no call (model may not have attempted the tool)" };
  },

  "hook-reply-context": (ctx) => {
    const env = opencodeEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = run(ctx.bin, ["run", "-m", OPENCODE_MODEL, "What is the passphrase? Reply with only the passphrase token."], env, 180_000);
    const blob = `${rt.stdout}\n${rt.stderr}`;
    if (blob.includes(SENTINELS.context)) return { status: "pass", detail: "model emitted the injected token (experimental.chat.system.transform reached the system prompt)" };
    if (rt.timedOut) return { status: "skip", detail: "opencode run timed out" };
    return { status: "fail", detail: "injected context token not in model output" };
  },

  "content-command": (ctx) => {
    const env = opencodeEnv(ctx);
    const conn = genContentConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = run(ctx.bin, ["run", "-m", OPENCODE_MODEL, "--command", "ac-echo", "--format", "json"], env, 180_000);
    const blob = `${rt.stdout}\n${rt.stderr}`;
    if (blob.includes(SENTINELS.command)) return { status: "pass", detail: "opencode loaded + ran commands/ac-echo.md (marker emitted)" };
    if (rt.timedOut) return { status: "skip", detail: "opencode run timed out" };
    return { status: "fail", detail: "command marker not emitted (command not loaded/run)" };
  },

  "content-subagent": (ctx) => {
    const env = opencodeEnv(ctx);
    const conn = genContentConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const list = run(ctx.bin, ["agent", "list"], env, 60_000);
    const listed = `${list.stdout}\n${list.stderr}`.includes("ac-subagent");
    const useIt = run(ctx.bin, ["run", "-m", OPENCODE_MODEL, "--agent", "ac-subagent", "hi"], env, 120_000);
    const fellBack = /not found.*[Ff]alling back/.test(`${useIt.stdout}\n${useIt.stderr}`);
    if (listed && !fellBack) return { status: "pass", detail: "agent list shows ac-subagent + no 'not found / falling back' warning (loaded)" };
    if (list.timedOut || useIt.timedOut) return { status: "skip", detail: "opencode timed out" };
    return { status: "fail", detail: `subagent not loaded (listed=${listed}, fellBack=${fellBack})` };
  },

  // content-skill: opencode has no headless skill verb — placement/doctor/residue
  // are drivable (same mechanism as command/subagent), in-session activation is not.
  "content-skill": (ctx) => {
    const env = opencodeEnv(ctx);
    const conn = genContentConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const skillFile = join(ctx.home, ".config", "opencode", "skills", "ac-skill", "SKILL.md");
    if (existsSync(skillFile)) return { status: "ceiling", detail: "SKILL.md placed; opencode has NO headless skill list/run verb → in-session model self-invocation is non-deterministic offline (ceiling). Placement/doctor/residue are verified." };
    return { status: "fail", detail: "skills/ac-skill/SKILL.md not placed" };
  },

  telemetry: (ctx) => {
    const env = opencodeEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id, telemetry: true });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = run(ctx.bin, ["run", "-m", OPENCODE_MODEL, "--format", "json", "Call ac_echo with text 'teltest' once."], env, 180_000);
    return assertTelemetry(ctx, rt, "ac_echo");
  },

  update: (ctx) => lifecycleUpdate(ctx, () => ({ ok: true }), opencodeEnv(ctx)),
  doctor: (ctx) => lifecycleDoctor(ctx, () => ({ ok: true }), opencodeEnv(ctx), "opencode"),
  "uninstall-residue": (ctx) => lifecycleUninstall(ctx, () => ({ ok: true }), opencodeEnv(ctx)),
  idempotency: (ctx) => lifecycleIdempotency(ctx, () => ({ ok: true }), opencodeEnv(ctx)),
  "mcp-install": (ctx) => {
    const env = opencodeEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const cfg = join(ctx.home, ".config", "opencode", "opencode.json");
    if (existsSync(cfg) && readFileSync(cfg, "utf8").includes(ctx.id)) return { status: "pass", detail: `opencode.json mcp.${ctx.id} written` };
    return { status: "fail", detail: "opencode.json missing our mcp key" };
  },
};

// ── antigravity-cli (agy) verb runners ────────────────────────────────────
// AUTHED-RUNTIME lane, NOT a bundled-offline-model lane: a turn needs the real
// Google OAuth token, so every runner first builds the auth-preserving sandbox
// (prepAgySandbox copies ~/.gemini token files; ok:false → SKIP). agy is Gemini-
// family json-stdio under ~/.gemini, NOT codex-shaped: MCP at
// ~/.gemini/config/mcp_config.json, hooks at ~/.gemini/config/hooks.json. The
// adapter supports PreToolUse / PostToolUse / SessionStart / Stop; UserPromptSubmit
// is host-unsupported (install warn-skips it). A turn is driven with
// `agy --dangerously-skip-permissions --model 'Gemini 3.5 Flash (Low)' -p <prompt>`.
// Live dual oracle: OUR $AC_VERIFY_DIR/events.log + the host's own
// ~/.gemini/antigravity-cli/cli.log (`json_hook_caller.go ... jsonhook__hooks_
// <Event>_0_0 ... executing command`). Note (live-confirmed): SessionStart does
// NOT fire under `agy -p` (print-mode, interactive-session-start-only); the tool
// events that DO fire are PreToolUse (toolName run_command) + PostToolUse (the
// adapter sends no tool fields on PostToolUse → toolName "") + Stop.

function agyEnv(ctx, extra = {}) {
  return {
    ...ctx.env,
    AGENT_CONNECTOR_DATA_DIR: join(ctx.work, "data"),
    AC_VERIFY_DIR: join(ctx.work, "acv"),
    AC_TOOL_MARK_DIR: join(ctx.work, "tm"),
    AC_MCP_LOG: join(ctx.work, "mcp-server.log"),
    ...extra,
  };
}
const AGY_MODEL = "Gemini 3.5 Flash (Low)";

/** Drive an agy print-mode turn (skip-permissions so tool calls run unattended). */
function agyTurn(ctx, env, prompt, timeoutMs = 200_000) {
  return run(ctx.bin, ["--dangerously-skip-permissions", "--model", AGY_MODEL, "-p", prompt], env, timeoutMs, ctx.projectDir);
}

/** Read the host's own cli.log (follow the cli.log → log/cli-*.log symlink) and
 *  test whether it logged the host firing `jsonhook__hooks_<Event>_0_0`. This is
 *  the host-side cross-check that complements OUR events.log. Best-effort: returns
 *  false if the log is absent (e.g. agy version that does not write it). */
function agyHostFiredEvent(home, event) {
  const logLink = join(home, ".gemini", "antigravity-cli", "cli.log");
  try {
    if (!existsSync(logLink)) return false;
    return new RegExp(`jsonhook__hooks_${event}_\\d+_\\d+`).test(readFileSync(logLink, "utf8"));
  } catch {
    return false;
  }
}

const agyRunners = {
  // per-event-fire: a real shell-tool turn fires PreToolUse(run_command) +
  // PostToolUse + Stop into events.log (SessionStart is print-mode-unfireable,
  // UserPromptSubmit host-unsupported — both are honest carve-outs, not failures).
  "per-event-fire": (ctx) => {
    const prep = prepAgySandbox(ctx.home);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = agyEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = agyTurn(ctx, env, "Run the shell command: echo AC_LIVE_TURN_OK");
    const lines = readEventsLog(ctx.work);
    const events = new Set(lines.map((e) => e.event).filter(Boolean));
    // The fireable-under-print-mode set (NOT SessionStart, NOT UserPromptSubmit).
    const want = ["PreToolUse", "PostToolUse", "Stop"];
    const got = want.filter((e) => events.has(e));
    const preRunCommand = lines.some((e) => e.event === "PreToolUse" && e.toolName === "run_command");
    // Host-side cross-check (best-effort; not required for pass).
    const hostFired = ["PreToolUse", "PostToolUse", "Stop"].filter((e) => agyHostFiredEvent(ctx.home, e));
    const carveouts = "SessionStart print-mode-unfireable; UserPromptSubmit host-unsupported (warn-skip)";
    if (got.includes("PreToolUse") && got.includes("PostToolUse")) {
      return {
        status: "pass",
        detail: `tool turn fired ${got.join(", ")}${preRunCommand ? " (PreToolUse toolName=run_command)" : ""}${hostFired.length ? `; host cli.log fired ${hostFired.join(", ")}` : ""} — ${carveouts}`,
      };
    }
    if (events.size > 0) return { status: "pass", detail: `events fired: ${[...events].join(", ")} (subset; model may not have used the shell tool this turn) — ${carveouts}` };
    if (rt.timedOut) return { status: "skip", detail: "agy -p turn timed out (model/network ceiling)" };
    return { status: "fail", detail: `events.log empty — no hook fired (exit=${rt.status})` };
  },

  // hook-fire alias of per-event-fire (the brief's "per-event-fire (or hook-fire)").
  "hook-fire": (ctx) => agyRunners["per-event-fire"](ctx),

  // hook-reply-deny: PreToolUse {decision:'deny'} for run_command → host HONORS the
  // deny (command never runs; our exact reason string reaches the model).
  "hook-reply-deny": (ctx) => {
    const prep = prepAgySandbox(ctx.home);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = agyEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id, denyTool: "run_command" });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = agyTurn(ctx, env, "Run the shell command: echo DENY_TEST_SHOULD_BE_BLOCKED");
    const blob = `${rt.stdout}\n${rt.stderr}`;
    const lines = readEventsLog(ctx.work);
    const repliedDeny = lines.some((e) => e.event === "PreToolUse" && e.toolName === "run_command");
    // DETERMINISTIC oracle: the host echoes OUR exact deny-reason marker
    // (AC_DENY_MARKER_blocked) into its run transcript ONLY when it actually
    // blocked the tool call — observed as an `ERROR_MESSAGE` ("Tool call denied
    // with reason: AC_DENY_MARKER_blocked") + a `PLANNER_RESPONSE` narrating the
    // block. That reason string is ours alone and never appears unless the host
    // honored the deny, so it is the assertion (NOT the brittle "did the command
    // marker appear in narration" heuristic — the marker is the command ARGUMENT
    // and shows up in block-narration regardless). The model's -p stdout is a
    // bonus signal only. The agy run transcript lives under the sandbox
    // ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/*.jsonl.
    const transcriptDir = join(ctx.home, ".gemini", "antigravity-cli", "brain");
    const denyInTranscript = existsSync(transcriptDir) && filesContaining(transcriptDir, SENTINELS.denyMarker).length > 0;
    const denyInStdout = blob.includes(SENTINELS.denyMarker);
    if (repliedDeny && (denyInTranscript || denyInStdout)) {
      return { status: "pass", detail: `host HONORED PreToolUse deny — our reason '${SENTINELS.denyMarker}' surfaced as the block reason (${denyInTranscript ? "host transcript" : "model stdout"}); command call was rejected` };
    }
    if (rt.timedOut) return { status: "skip", detail: "agy -p turn timed out (model/network ceiling)" };
    if (repliedDeny) return { status: "skip", detail: "inconclusive: PreToolUse(run_command) fired but the deny-reason marker was not observed in the transcript/stdout this turn (model phrasing varies)" };
    return { status: "skip", detail: `inconclusive: no PreToolUse(run_command) fire (model may not have attempted the shell tool); exit=${rt.status}` };
  },

  // hook-reply-context (CB): the reply-RENDER rung is driven via direct home-bin
  // dispatch (the adapter emits {"additionalContext":...} for a SessionStart
  // context reply). The host's CONSUMPTION is the ceiling: SessionStart never
  // fires under `agy -p` (interactive-session-start-only), so headless activation
  // is not observable. Drives the render; records the un-driveable rung honestly.
  "hook-reply-context": (ctx) => {
    const prep = prepAgySandbox(ctx.home);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = agyEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const homeBin = join(ctx.work, "data", "bin", "agent-connector");
    const payload = JSON.stringify({ workspacePaths: [ctx.projectDir] });
    const disp = existsSync(homeBin)
      ? runWithInput(homeBin, ["hook", "antigravity-cli", "SessionStart", "--connector", ctx.id], env, payload, 30_000)
      : { stdout: "", status: 1 };
    const rendered = `${disp.stdout}`.includes(SENTINELS.context) && /"additionalContext"/.test(`${disp.stdout}`);
    if (rendered) {
      return { status: "ceiling", detail: 'SessionStart context reply RENDERED by the dispatcher ({"additionalContext":"…ZX9…"}); host consumption is interactive-TUI-only (SessionStart never fires under `agy -p`) — un-driveable headless' };
    }
    return { status: "ceiling", detail: `dispatcher render not reproduced (home-bin absent or exit ${disp.status}); SessionStart consumption is interactive-TUI-only — un-driveable headless` };
  },

  // mcp-install: mcpServers.<id> written to ~/.gemini/config/mcp_config.json
  // (the LIVE-canonical agy path, NOT the IDE antigravity/ dir).
  "mcp-install": (ctx) => {
    const prep = prepAgySandbox(ctx.home);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = agyEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const cfg = join(ctx.home, ".gemini", "config", "mcp_config.json");
    if (existsSync(cfg) && readFileSync(cfg, "utf8").includes(ctx.id)) return { status: "pass", detail: `mcpServers.${ctx.id} written to ~/.gemini/config/mcp_config.json (canonical agy path)` };
    return { status: "fail", detail: "mcp_config.json missing our mcpServers entry at ~/.gemini/config/" };
  },

  // mcp-tool-load: a turn that references the tool spawns the serve-wrapped server
  // → telemetry scope:'tool_defs' row (initialize + tools/list reached).
  "mcp-tool-load": (ctx) => {
    const prep = prepAgySandbox(ctx.home);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = agyEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = agyTurn(ctx, env, 'Call the MCP tool named ac_echo with text "hello-from-agy"');
    const ndjson = join(ctx.work, "data", "telemetry.ndjson");
    const log = join(ctx.work, "mcp-server.log");
    const handshook = existsSync(log) && /"recv":"tools\/list"/.test(readFileSync(log, "utf8"));
    let toolDefs = false;
    if (existsSync(ndjson)) {
      toolDefs = readFileSync(ndjson, "utf8").split(/\r?\n/).filter(Boolean).some((l) => {
        try { const r = JSON.parse(l); return r.scope === "tool_defs"; } catch { return false; }
      });
    }
    if (handshook || toolDefs) return { status: "pass", detail: `server loaded through the serve wrapper (${handshook ? "tools/list received" : ""}${handshook && toolDefs ? " + " : ""}${toolDefs ? "telemetry tool_defs row" : ""})` };
    if (rt.timedOut) return { status: "skip", detail: "agy -p turn timed out (model/network ceiling)" };
    return { status: "fail", detail: `tool not loaded (no handshake / tool_defs; exit=${rt.status})` };
  },

  // mcp-tool-call: model calls ac_echo → tool-calls.log line + AC_ECHO_MARKER +
  // telemetry scope:'call' row (full round-trip through the serve wrap).
  "mcp-tool-call": (ctx) => {
    const prep = prepAgySandbox(ctx.home);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = agyEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const text = "hello-from-agy";
    const rt = agyTurn(ctx, env, `Call the MCP tool named ac_echo with text "${text}"`);
    const blob = `${rt.stdout}\n${rt.stderr}`;
    const callLog = join(ctx.work, "tm", "tool-calls.log");
    const called = existsSync(callLog) && readFileSync(callLog, "utf8").includes(text);
    const log = join(ctx.work, "mcp-server.log");
    const recvCall = existsSync(log) && /"recv":"tools\/call"/.test(readFileSync(log, "utf8"));
    if (called || recvCall || blob.includes(`${SENTINELS.echo}:${text}`)) {
      return { status: "pass", detail: `model round-tripped ac_echo through the serve wrap (${called ? "tool-calls.log" : recvCall ? "tools/call recv" : "AC_ECHO_MARKER in output"})` };
    }
    if (rt.timedOut) return { status: "skip", detail: "agy -p turn timed out (model/network ceiling)" };
    return { status: "fail", detail: `no ac_echo call recorded (exit=${rt.status})` };
  },

  // telemetry: a tool turn records a scope:'call' row with integer tokens.
  telemetry: (ctx) => {
    const prep = prepAgySandbox(ctx.home);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = agyEnv(ctx);
    const conn = genHookMcpConnector({ id: ctx.id, telemetry: true });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const rt = agyTurn(ctx, env, 'Call the MCP tool named ac_echo with text "teltest"');
    return assertTelemetry(ctx, rt, "ac_echo");
  },

  // content-commands-skills-memory (CB): placement of the markdown content
  // surfaces is verified (workflows/skills/memory) and subagents warn-skip; the
  // headless `agy -p` ACTIVATION of a workflow/skill is model-discretion
  // (non-deterministic offline) — the honest ceiling.
  "content-skill": (ctx) => {
    const prep = prepAgySandbox(ctx.home);
    if (!prep.ok) return { status: "skip", detail: prep.reason };
    const env = agyEnv(ctx);
    const conn = genContentConnector({ id: ctx.id });
    const ins = doInstall(conn, "user", ctx.projectDir, ctx.hostId, env);
    if (!ins.ok) return { status: "fail", detail: `install step failed: ${ins.out.slice(0, 200)}` };
    const skillFile = join(ctx.home, ".gemini", "antigravity-cli", "skills", "ac-skill", "SKILL.md");
    const workflow = join(ctx.home, ".gemini", "antigravity", "global_workflows", "ac-echo.md");
    const memory = join(ctx.home, ".gemini", "AGENTS.md");
    const subagentWarn = / subagents? .*(not supported|skipped)/i.test(ins.out) || /antigravity-cli.* skipped/i.test(ins.out);
    const placed = [
      existsSync(skillFile) && "skills/ac-skill/SKILL.md",
      existsSync(workflow) && "antigravity/global_workflows/ac-echo.md",
      existsSync(memory) && readFileSync(memory, "utf8").includes(SENTINELS.memory) && "AGENTS.md",
    ].filter(Boolean);
    if (placed.length > 0) {
      return { status: "ceiling", detail: `content placed: ${placed.join(", ")}${subagentWarn ? "; subagents warn-skipped (host-unsupported)" : ""}. Headless \`agy -p\` activation is model-discretion (non-deterministic) — ceiling` };
    }
    return { status: "fail", detail: "no content surface placed (expected skills/SKILL.md, workflow, or AGENTS.md)" };
  },

  // content-subagent (U): antigravity-cli has no subagent surface — install warn-skips.
  "content-subagent": () => ({
    status: "unsupported",
    detail: "antigravity-cli has no subagent surface — install warn-skips ('subagents not supported on antigravity-cli').",
  }),

  update: (ctx) => lifecycleUpdate(ctx, () => prepAgySandbox(ctx.home), agyEnv(ctx)),
  doctor: (ctx) => lifecycleDoctor(ctx, () => prepAgySandbox(ctx.home), agyEnv(ctx), "antigravity-cli"),
  "uninstall-residue": (ctx) => lifecycleUninstall(ctx, () => prepAgySandbox(ctx.home), agyEnv(ctx)),
  idempotency: (ctx) => lifecycleIdempotency(ctx, () => prepAgySandbox(ctx.home), agyEnv(ctx)),
  coexistence: (ctx) => lifecycleCoexistence(ctx, () => prepAgySandbox(ctx.home), agyEnv(ctx), join(ctx.home, ".gemini", "config")),
};

// ── Lifecycle runners (shared shape across hosts) ─────────────────────────
// Each takes a prep() (the host's auth-preserving sandbox) and an env, installs
// the hook+mcp connector, then drives the lifecycle verb against the BUILT cli.

function lifecycleUpdate(ctx, prep, env) {
  const p = prep();
  if (!p.ok) return { status: "skip", detail: p.reason };
  const conn = genHookMcpConnector({ id: ctx.id });
  const ins = doInstall(conn, ctx.scope, ctx.projectDir, ctx.hostId, env);
  if (!ins.ok) return { status: "fail", detail: `install failed: ${ins.out.slice(0, 160)}` };
  const r = run("node", [CLI, "upgrade", "--connector", conn, "--scope", ctx.scope, "--project", ctx.projectDir, "--targets", ctx.hostId], env, 120_000);
  const out = `${r.stdout}\n${r.stderr}`;
  if (/ failed on /.test(out)) return { status: "fail", detail: `upgrade step failed: ${out.slice(0, 160)}` };
  const refreshed = /Refreshed home binary pointer/.test(out);
  const allSkip = /skip|already registered|up to date/i.test(out);
  // The exit code is NOT the pass/fail signal: `agent-connector upgrade` exits 1
  // whenever ANY `warn` ChangeRecord is present, and a benign "unsupported hook
  // event — skipped" warning (e.g. antigravity-cli / gemini-cli decline an event
  // with no native equivalent) is a documented never-silent SKIP, not a failure —
  // exactly the discipline the default verifyHost install path applies. So an
  // exit-1 with ONLY benign warning(s) (no ` failed on `) and the expected output
  // markers is a pass; the strict exit-0 case is kept for warning-free hosts.
  // Benign = exit≠0 AND the summary reports ≥1 warning AND there is no ` failed on `
  // (already returned above). A `! warn:` change line confirms it is a warn-skip.
  const benignWarnExit = r.status !== 0 && /[1-9]\d* warning/i.test(out) && /(^|\n)\s*! .*warn:/i.test(out);
  if ((r.status === 0 || benignWarnExit) && (refreshed || allSkip)) {
    return { status: "pass", detail: `upgrade idempotent re-render${refreshed ? " + home pointer refreshed" : ""}${benignWarnExit ? " (exit 1 from a benign warn-skipped event, not a failure)" : ", exit 0"}` };
  }
  return { status: "fail", detail: `upgrade exit=${r.status}; ${out.trim().slice(0, 160)}` };
}

function lifecycleDoctor(ctx, prep, env, platform) {
  const p = prep();
  if (!p.ok) return { status: "skip", detail: p.reason };
  const conn = genHookMcpConnector({ id: ctx.id });
  const ins = doInstall(conn, ctx.scope, ctx.projectDir, ctx.hostId, env);
  if (!ins.ok) return { status: "fail", detail: `install failed: ${ins.out.slice(0, 160)}` };
  const r = run("node", [CLI, "doctor", "--connector", conn, "--scope", ctx.scope, "--project", ctx.projectDir, "--targets", ctx.hostId], env, 120_000);
  const out = `${r.stdout}\n${r.stderr}`;
  const allPass = /all checks passed/i.test(out) && !/\[fail\]/.test(out);
  if (r.status === 0 && allPass) return { status: "pass", detail: `doctor: all checks passed (${platform}), exit 0` };
  return { status: "fail", detail: `doctor exit=${r.status}; ${out.trim().slice(0, 200)}` };
}

function lifecycleUninstall(ctx, prep, env) {
  const p = prep();
  if (!p.ok) return { status: "skip", detail: p.reason };
  const conn = genHookMcpConnector({ id: ctx.id });
  const ins = doInstall(conn, ctx.scope, ctx.projectDir, ctx.hostId, env);
  if (!ins.ok) return { status: "fail", detail: `install failed: ${ins.out.slice(0, 160)}` };
  const placed = baselineScan(ctx);
  const r = run("node", uninstallArgv(ctx.id, ctx.scope, ctx.projectDir, ctx.hostId), env, 120_000);
  const out = `${r.stdout}\n${r.stderr}`;
  if (/ failed on /.test(out)) return { status: "fail", detail: `uninstall step failed: ${out.slice(0, 160)}` };
  // Residue = install-written files that still carry the id (exclude host runtime
  // transcripts — those are the baseline-scoped exclusion, already handled by
  // measuring ONLY the `placed` baseline, not a fresh full-tree scan).
  const residue = placed.filter((f) => {
    try {
      return existsSync(f) && readFileSync(f, "utf8").includes(ctx.id);
    } catch {
      return false;
    }
  });
  if (residue.length === 0) return { status: "pass", detail: `${placed.length} install-written file(s) cleaned; zero residue` };
  return { status: "fail", detail: `residue in: ${residue.map((f) => f.replace(ctx.home, "<HOME>")).join(", ").slice(0, 200)}` };
}

function lifecycleIdempotency(ctx, prep, env) {
  const p = prep();
  if (!p.ok) return { status: "skip", detail: p.reason };
  const conn = genHookMcpConnector({ id: ctx.id });
  const ins1 = doInstall(conn, ctx.scope, ctx.projectDir, ctx.hostId, env);
  if (!ins1.ok) return { status: "fail", detail: `install#1 failed: ${ins1.out.slice(0, 160)}` };
  const before = baselineScan(ctx).map((f) => [f, sha256File(f)]);
  const ins2 = doInstall(conn, ctx.scope, ctx.projectDir, ctx.hostId, env);
  if (!ins2.ok) return { status: "fail", detail: `install#2 failed: ${ins2.out.slice(0, 160)}` };
  const changed = before.filter(([f, h]) => sha256File(f) !== h);
  const allSkip = /skip|already registered|up to date/i.test(ins2.out);
  if (changed.length === 0) return { status: "pass", detail: `re-install byte-identical (${before.length} files), surfaces ${allSkip ? "skip" : "re-rendered identically"}` };
  return { status: "fail", detail: `re-install changed: ${changed.map(([f]) => f.replace(ctx.home, "<HOME>")).join(", ").slice(0, 200)}` };
}

/** coexistence: a FOREIGN file in the host's owned dir survives our install+uninstall. */
function lifecycleCoexistence(ctx, prep, env, ownedDir) {
  const p = prep();
  if (!p.ok) return { status: "skip", detail: p.reason };
  mkdirSync(ownedDir, { recursive: true });
  const foreign = join(ownedDir, "ac-foreign-coexist.json");
  const foreignBody = JSON.stringify({ unrelated: "third-party config", id: "not-ours" });
  writeFileSync(foreign, foreignBody);
  const foreignHash = sha256File(foreign);
  const conn = genHookMcpConnector({ id: ctx.id });
  const ins = doInstall(conn, ctx.scope, ctx.projectDir, ctx.hostId, env);
  if (!ins.ok) return { status: "fail", detail: `install failed: ${ins.out.slice(0, 160)}` };
  const un = run("node", uninstallArgv(ctx.id, ctx.scope, ctx.projectDir, ctx.hostId), env, 120_000);
  if (/ failed on /.test(`${un.stdout}\n${un.stderr}`)) return { status: "fail", detail: "uninstall step failed during coexistence" };
  const survived = existsSync(foreign) && sha256File(foreign) === foreignHash;
  if (survived) return { status: "pass", detail: "a pre-existing foreign file in the host-owned dir was byte-identical after our install+uninstall" };
  return { status: "fail", detail: "coexisting foreign file was modified or removed by our install/uninstall" };
}

/** Files our install wrote that carry the id (the residue/idempotency baseline). */
function baselineScan(ctx) {
  const roots = ctx.scope === "project" ? [ctx.home, ctx.projectDir] : [ctx.home];
  return roots.flatMap((r) => filesContaining(r, ctx.id));
}

/** Telemetry assertion: after a tool call, telemetry.ndjson has a scope:call row. */
function assertTelemetry(ctx, rt, toolName) {
  const ndjson = join(ctx.work, "data", "telemetry.ndjson");
  if (!existsSync(ndjson)) {
    if (rt.timedOut) return { status: "skip", detail: "turn timed out before any telemetry was recorded" };
    return { status: "fail", detail: "telemetry.ndjson not created (serve-wrap did not record the call)" };
  }
  const rows = readFileSync(ndjson, "utf8").split(/\r?\n/).filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const callRow = rows.find((r) => r.scope === "call" && r.toolName === toolName);
  if (callRow && Number.isInteger(callRow.inputTokens) && callRow.inputTokens >= 0 && !callRow.isError) {
    return { status: "pass", detail: `telemetry scope:call row for ${toolName} (in=${callRow.inputTokens} out=${callRow.outputTokens})` };
  }
  if (rt.timedOut) return { status: "skip", detail: "turn timed out; telemetry has no call row yet" };
  return { status: "fail", detail: `no scope:call telemetry row for ${toolName} (${rows.length} rows recorded)` };
}

// ─────────────────────────────────────────────────────────────────────────
// HOST_VERBS — the deep-verb lane registry. Per host, per verb:
//   { status, runner?, reason? }
//     status ∈ "V" | "CB" | "U" | "BUG"   (the GROUNDED matrix)
//     runner   the live recipe runner (V; and CB lanes that drive a rung)
//     reason   the honest skip text for a U / BUG / non-runnable lane
// Codified VERBATIM from the live-verified recipes. A verb absent from a host's
// map means that host has no recipe for it (reported "no-lane", a skip).
// ─────────────────────────────────────────────────────────────────────────
const HOST_VERBS = {
  "copilot-cli": {
    "mcp-install": { status: "V", runner: copilotRunners["mcp-tool-load"] }, // placement proven by load
    "mcp-tool-load": { status: "V", runner: copilotRunners["mcp-tool-load"] },
    "mcp-tool-call": { status: "V", runner: copilotRunners["mcp-tool-call"] },
    telemetry: { status: "V", runner: copilotRunners.telemetry },
    "per-event-fire": { status: "V", runner: copilotRunners["per-event-fire"] },
    "hook-reply-deny": { status: "V", runner: copilotRunners["hook-reply-deny"], note: "ceiling-blocked in the original spec; FIXED on this branch (flat permissionDecision + camelCase parseEvent) → now V." },
    "hook-reply-context": { status: "U", runner: copilotRunners["hook-reply-context"] },
    update: { status: "V", runner: copilotRunners.update },
    doctor: { status: "V", runner: copilotRunners.doctor },
    "uninstall-residue": { status: "V", runner: copilotRunners["uninstall-residue"] },
    idempotency: { status: "V", runner: copilotRunners.idempotency },
    coexistence: { status: "V", runner: copilotRunners.coexistence },
  },
  "claude-code": {
    "mcp-install": { status: "V", runner: claudeRunners["mcp-tool-load"] },
    "mcp-tool-load": { status: "V", runner: claudeRunners["mcp-tool-load"] },
    "mcp-tool-call": { status: "V", runner: claudeRunners["mcp-tool-call"] },
    telemetry: { status: "V", runner: claudeRunners.telemetry },
    "per-event-fire": { status: "V", runner: claudeRunners["per-event-fire"] },
    "hook-reply-deny": { status: "V", runner: claudeRunners["hook-reply-deny"] },
    "hook-reply-context": { status: "V", runner: claudeRunners["hook-reply-context"] },
    "content-command": { status: "V", runner: claudeRunners["content-command"] },
    "content-skill": { status: "V", runner: claudeRunners["content-skill"] },
    "content-subagent": { status: "V", runner: claudeRunners["content-subagent"] },
    "content-memory": { status: "V", runner: claudeRunners["content-memory"] },
    "content-statusline": { status: "CB", runner: claudeRunners["content-statusline"] },
    update: { status: "V", runner: claudeRunners.update },
    doctor: { status: "V", runner: claudeRunners.doctor },
    "uninstall-residue": { status: "V", runner: claudeRunners["uninstall-residue"] },
    idempotency: { status: "V", runner: claudeRunners.idempotency },
    coexistence: { status: "V", runner: claudeRunners.coexistence },
  },
  opencode: {
    "mcp-install": { status: "V", runner: opencodeRunners["mcp-install"] },
    "mcp-tool-load": { status: "V", runner: opencodeRunners["mcp-tool-load"] },
    "mcp-tool-call": { status: "V", runner: opencodeRunners["mcp-tool-call"] },
    telemetry: { status: "V", runner: opencodeRunners.telemetry },
    "hook-fire": { status: "V", runner: opencodeRunners["hook-fire"] },
    "per-event-fire": { status: "V", runner: opencodeRunners["per-event-fire"] },
    "hook-reply-deny": { status: "V", runner: opencodeRunners["hook-reply-deny"] },
    "hook-reply-context": { status: "V", runner: opencodeRunners["hook-reply-context"] },
    "content-command": { status: "V", runner: opencodeRunners["content-command"] },
    "content-subagent": { status: "V", runner: opencodeRunners["content-subagent"] },
    "content-skill": { status: "CB", runner: opencodeRunners["content-skill"] },
    update: { status: "V", runner: opencodeRunners.update },
    doctor: { status: "V", runner: opencodeRunners.doctor },
    "uninstall-residue": { status: "V", runner: opencodeRunners["uninstall-residue"] },
    idempotency: { status: "V", runner: opencodeRunners.idempotency },
  },
  // antigravity-cli (agy): AUTHED-RUNTIME, Gemini-family json-stdio (~/.gemini).
  // Live-verified on agy 1.0.9 (local) / 1.0.10 (mac). PreToolUse/PostToolUse/Stop
  // FIRE under `agy -p`; SessionStart is print-mode-unfireable (interactive only);
  // UserPromptSubmit is host-unsupported (warn-skip). hook-reply-context is CB (the
  // reply render is driven; host consumption needs an interactive session start);
  // content surfaces are CB (placement verified, headless activation is model-
  // discretion); subagents are host-unsupported (U).
  "antigravity-cli": {
    "mcp-install": { status: "V", runner: agyRunners["mcp-install"] },
    "mcp-tool-load": { status: "V", runner: agyRunners["mcp-tool-load"] },
    "mcp-tool-call": { status: "V", runner: agyRunners["mcp-tool-call"] },
    telemetry: { status: "V", runner: agyRunners.telemetry },
    "hook-fire": { status: "V", runner: agyRunners["hook-fire"] },
    "per-event-fire": { status: "V", runner: agyRunners["per-event-fire"], note: "fires PreToolUse(run_command)/PostToolUse/Stop; SessionStart print-mode-unfireable, UserPromptSubmit host-unsupported." },
    "hook-reply-deny": { status: "V", runner: agyRunners["hook-reply-deny"] },
    "hook-reply-context": { status: "CB", runner: agyRunners["hook-reply-context"] },
    "content-skill": { status: "CB", runner: agyRunners["content-skill"], note: "covers commands/skills/memory placement; subagents warn-skip." },
    "content-subagent": { status: "U", runner: agyRunners["content-subagent"] },
    update: { status: "V", runner: agyRunners.update },
    doctor: { status: "V", runner: agyRunners.doctor },
    "uninstall-residue": { status: "V", runner: agyRunners["uninstall-residue"] },
    idempotency: { status: "V", runner: agyRunners.idempotency },
    coexistence: { status: "V", runner: agyRunners.coexistence },
  },
};

/** The full ordered verb list (for --all-verbs and the usage text). */
const ALL_VERBS = [
  "mcp-install", "mcp-tool-load", "mcp-tool-call", "telemetry",
  "hook-fire", "per-event-fire", "hook-reply-deny", "hook-reply-context",
  "content-command", "content-skill", "content-subagent", "content-memory", "content-statusline",
  "update", "doctor", "uninstall-residue", "idempotency", "coexistence",
];

/** Run ONE verb against ONE host. Returns { host, verb, status, detail }. */
async function runVerb(hostId, verb, opts) {
  const lane = HOST_LANES[hostId];
  const map = HOST_VERBS[hostId];
  if (!map || !map[verb]) {
    return { host: hostId, verb, status: "no-lane", detail: `no codified ${verb} recipe for ${hostId} (covered by install-roundtrip.test.ts for placement)` };
  }
  const spec = map[verb];
  // U / BUG lanes are honest skips/records — they need no host binary.
  if (spec.status === "U" && spec.runner) {
    const r = spec.runner({ hostId });
    return { host: hostId, verb, status: "unsupported", detail: r.detail };
  }
  if (spec.status === "BUG") {
    return { host: hostId, verb, status: "bug", detail: spec.reason ?? "host-supported-but-adapter-broken" };
  }
  if (!lane) {
    return { host: hostId, verb, status: "skip", detail: `no live lane for ${hostId}` };
  }
  const bin = which(lane.bin);
  if (!bin) {
    return { host: hostId, verb, status: "skip", detail: `binary "${lane.bin}" absent — manual harness needs the real authed host CLI` };
  }
  const work = tempDir(`ac-verb-${hostId}-${verb}-`);
  const { env, home, projectDir } = isolatedEnv(work, lane);
  const id = `acv-${verb}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const ctx = { hostId, bin, work, env, home, projectDir, scope: opts.scope, id };
  try {
    const r = await spec.runner(ctx);
    // Enforce the declared status: a U lane is always "unsupported"; a CB lane can
    // NEVER report a fake "pass" — it is coerced to its declared ceiling.
    let status = r.status;
    if (spec.status === "U") status = "unsupported";
    else if (spec.status === "CB" && r.status === "pass") status = "ceiling";
    return { host: hostId, verb, status, detail: r.detail, declared: spec.status };
  } catch (err) {
    return { host: hostId, verb, status: "skip", detail: `harness error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (opts.keep) process.stderr.write(`[${hostId}/${verb}] --keep: WORK at ${work}\n`);
    else {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Run every codified verb for a host (the --all-verbs path). */
async function runAllVerbs(hostId, opts) {
  const map = HOST_VERBS[hostId];
  if (!map) {
    process.stderr.write(`${hostId}: no deep-verb lanes codified.\n`);
    return 0;
  }
  const verbs = Object.keys(map);
  let worst = 0;
  for (const verb of verbs) {
    const res = await runVerb(hostId, verb, opts);
    process.stdout.write(JSON.stringify(res) + "\n");
    if (res.status === "fail" || res.status === "bug") worst = 1;
  }
  // Human matrix to stderr.
  process.stderr.write(`\n${hostId} deep-verb lanes (declared status → live result):\n`);
  return worst;
}

// ─────────────────────────────────────────────────────────────────────────
// CLI entry.
// ─────────────────────────────────────────────────────────────────────────
function parseArgv(argv) {
  const opts = { scope: "user", keep: false, all: false, host: null, install: false, verb: null, allVerbs: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") opts.all = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "--install") opts.install = true;
    else if (a === "--no-install") opts.install = false; // explicit; matches default
    else if (a === "--scope") opts.scope = argv[++i];
    else if (a === "--verb") opts.verb = argv[++i];
    else if (a === "--all-verbs") opts.allVerbs = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (!a.startsWith("-") && !opts.host) opts.host = a;
    else {
      process.stderr.write(`unknown argument: ${a}\n`);
      opts.help = true;
    }
  }
  return opts;
}

const USAGE = `usage:
  node scripts/verify-host.mjs <host-id> [--scope user|project] [--keep] [--install]
  node scripts/verify-host.mjs --all     [--scope user|project] [--keep] [--install]
  node scripts/verify-host.mjs <host-id> --verb <verb>   [--scope ...] [--keep]
  node scripts/verify-host.mjs <host-id> --all-verbs     [--scope ...] [--keep]

Drives a host's REAL CLI against the .acverify connector in an isolated HOME to
confirm the host ACCEPTS our written config (and fires our hook where auth-free).
Missing binaries / auth ceilings are SKIPS, never failures. Exit 1 only on a real
placement miss or uninstall residue. The real HOME is never touched.

  --install     for a missing binary with a known install method, install the
                host CLI into the gitignored local prefix .verify-tools (npm
                --prefix; never global) and live-verify it. OPT-IN because this
                DOWNLOADS AND EXECUTES third-party code — off by default. Without
                it (or with --no-install) a missing binary stays skip-not-fail.

  --verb <v>    run ONE deep-verb live-smoke lane (the MANUAL harness). Verbs:
                ${ALL_VERBS.join(", ")}.
                These need a real AUTHED host CLI + a model turn; a missing
                binary/auth is a SKIP. Codified from live-verified recipes.
  --all-verbs   run every codified deep-verb lane for the host.

See scripts/README.md for the per-host lane matrix + honest ceilings.`;

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  if (opts.help || (!opts.all && !opts.host)) {
    process.stderr.write(USAGE + "\n");
    return opts.help ? 0 : 2;
  }
  if (opts.scope !== "user" && opts.scope !== "project") {
    process.stderr.write(`invalid --scope "${opts.scope}" (use user|project)\n`);
    return 2;
  }
  if (!existsSync(CLI)) {
    process.stderr.write(`built CLI not found at ${CLI} — run \`npm run build\` first.\n`);
    return 2;
  }
  // ── Deep-verb dispatch (the MANUAL live-smoke harness) ────────────────────
  if (opts.allVerbs) {
    if (!opts.host) {
      process.stderr.write("`--all-verbs` needs a <host-id>.\n");
      return 2;
    }
    return runAllVerbs(opts.host, opts);
  }
  if (opts.verb) {
    if (!opts.host) {
      process.stderr.write("`--verb` needs a <host-id>.\n");
      return 2;
    }
    if (!ALL_VERBS.includes(opts.verb)) {
      process.stderr.write(`unknown verb "${opts.verb}". Known: ${ALL_VERBS.join(", ")}\n`);
      return 2;
    }
    const res = await runVerb(opts.host, opts.verb, opts);
    process.stdout.write(JSON.stringify(res) + "\n");
    process.stderr.write(`\n${res.host}/${res.verb}: ${res.status}\n  ${res.detail}\n`);
    return res.status === "fail" || res.status === "bug" ? 1 : 0;
  }
  // ── Default: the install-roundtrip→accept→runtime path (CI-safe) ──────────
  if (opts.all) return runAll(opts);
  const { verdict, exitCode } = await verifyHost(opts.host, opts);
  process.stderr.write(
    `\n${opts.host}: tier=${verdict.tier} status=${verdict.status}\n  ${verdict.notes}\n`,
  );
  return emit(verdict, exitCode);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`verify-host: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  },
);
