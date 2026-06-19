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
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
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
    note: "`agy plugin list` reads config offline (no mcp-list verb); turn is Google-OAuth-gated.",
  },
  "amazon-q": {
    bin: "q",
    // Resolves ~/.aws/amazonq off homedir → HOME isolation suffices.
    accept: { argv: ["mcp", "list"], kind: "list-id" },
    note: "`q mcp list` lists configured servers offline; turn is auth-gated.",
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
    // CORRECTED via live `openclaw mcp list` / `openclaw config validate`:
    // BOTH report "OpenClaw config is invalid … plugins: plugin: plugin manifest
    // requires configSchema" (exit 0, so an exit-0 "ok" lane would FALSELY pass).
    // Our adapter writes ~/.openclaw/extensions/<id>/openclaw.plugin.json
    // (wrapper-bridge manifest) WITHOUT the required `configSchema` field, so
    // openclaw's validator REJECTS the plugin entry. Placement + uninstall-clean
    // PASS, but the host will NOT load the plugin as written. Placement-only.
    placementOnly: true,
    note: "KNOWN ADAPTER GAP: `openclaw config validate` rejects our plugin entry — \"plugin manifest requires configSchema\" (our openclaw.plugin.json omits configSchema). Placement+uninstall-clean only; potential adapter fix (out of scope here).",
  },
  goose: {
    bin: "goose",
    // Resolves ~/.config/goose off homedir → HOME isolation suffices.
    accept: { argv: ["mcp", "list"], kind: "ok" },
    note: "Block goose; `goose mcp`/`goose info` reads config; turn is auth-gated.",
  },
  droid: {
    bin: "droid",
    // Factory CLI; resolves ~/.factory off homedir → HOME isolation suffices.
    accept: { argv: ["mcp", "list"], kind: "ok" },
    note: "Factory droid; `droid mcp list` reads config; turn is auth-gated.",
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
//   { kind: "script", url, bin, note }
//     installed via an official installer script. Best-effort: only run when the
//     installer is reachable AND installs to a controllable dir; otherwise the
//     host is reported install-failed honestly (never a forced pass).
//
// NETWORK INSTALL IS OPT-IN (`--install`), NOT the default — a deliberate safety
// decision: auto-downloading and EXECUTING third-party CLIs is untrusted-code
// integration that must be a conscious, authorized act, not a side effect of the
// default run. Without --install, a missing binary stays skip-not-fail and the
// host is covered headlessly by install-roundtrip.test.ts. (See INSTALL_NOTES.)
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
  // ── official installer scripts (best-effort; install-failed reported honestly) ──
  goose: { kind: "script", bin: "goose", note: "Block goose official install script (github.com/block/goose)" },
  droid: { kind: "script", bin: "droid", note: "Factory CLI official installer (app.factory.ai/cli)" },
};

// Hosts genuinely NOT live-verifiable on a headless Linux box, with the SPECIFIC
// reason. These are already covered by the binary-free install-roundtrip.test.ts
// (merged), so they are documented non-gaps, NOT unverified holes.
const UNINSTALLABLE_HERE = {
  cursor: "GUI editor",
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
  kimi: 'npm "kimi-cli" 0.0.2 is a front-end-tools generator — NOT the AI host (real Kimi may be pip)',
  pi: 'npm "pi-cli" 0.0.0 is an empty stub — identity unverified',
  nemoclaw: 'npm "nemoclaw" 0.1.0 has no bin — identity unverified (NVIDIA wraps openclaw)',
  omp: 'no known npm package ("omp" 1.0.0 is an unrelated "new" stub) — identity unverified',
};

// ─────────────────────────────────────────────────────────────────────────
// Small helpers.
// ─────────────────────────────────────────────────────────────────────────

/** The gitignored local toolchain prefix install missing host CLIs go into. */
const TOOLS_PREFIX = join(REPO_ROOT, ".verify-tools");
const TOOLS_BIN_DIR = join(TOOLS_PREFIX, "node_modules", ".bin");

/**
 * Resolve a binary: prefer the local toolchain prefix (a host we installed for
 * verification), then fall back to PATH. Returns the absolute path or null. No
 * shell (avoids DEP0190); Windows PATHEXT aware.
 */
function which(bin) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  // 1. Local toolchain prefix first (so a verification-only install is used
  //    even if a different/global build of the same bin is on PATH).
  for (const ext of exts) {
    const local = join(TOOLS_BIN_DIR, bin + ext);
    try {
      if (existsSync(local)) return local;
    } catch {
      /* ignore */
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

/**
 * Install a missing host CLI into the LOCAL prefix (never global) so it can be
 * live-verified. Returns { ok, bin?, reason }. npm hosts use
 * `npm install --prefix .verify-tools <pkg>`; script hosts are best-effort and
 * report install-failed honestly when the installer is unreachable / refuses.
 *
 * SECURITY: this DOWNLOADS AND WILL EXECUTE third-party code. It runs ONLY under
 * the explicit --install opt-in; the package identity for every npm host in
 * HOST_INSTALL was npm-probed to match the real host before being listed.
 */
function installHost(hostId) {
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

  // script-based installers are best-effort and only attempted under --install.
  // Without a controllable, reachable installer we DO NOT guess — report honestly.
  return {
    ok: false,
    reason: `script install not automated here (${spec.note}); install manually then re-run`,
  };
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

/** Run a command with stdin closed under a hard timeout; capture all output. */
function run(cmd, argv, env, timeoutMs) {
  const r = spawnSync(cmd, argv, {
    env,
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
      const res = installHost(hostId);
      if (res.ok) {
        binPath = res.bin;
        process.stderr.write(`[${hostId}] ${res.reason} → bin ${binPath}\n`);
      } else {
        process.stderr.write(`SKIP ${hostId}: install failed — ${res.reason}\n`);
        return skip("skipped-install-failed", `install failed: ${res.reason} — covered headlessly by install-roundtrip.test.ts`);
      }
    } else {
      const hint = spec
        ? install
          ? "install method known but produced no binary"
          : `binary "${lane.bin}" absent; pass --install to install ${spec.kind === "npm" ? spec.pkg : "via " + spec.note} into the local prefix`
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
    const acceptPass =
      lane.accept.kind === "list-id"
        ? acc.status === 0 && `${acc.stdout}\n${acc.stderr}`.includes(CONNECTOR_ID)
        : acc.status === 0;
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

// ─────────────────────────────────────────────────────────────────────────
// CLI entry.
// ─────────────────────────────────────────────────────────────────────────
function parseArgv(argv) {
  const opts = { scope: "user", keep: false, all: false, host: null, install: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") opts.all = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "--install") opts.install = true;
    else if (a === "--no-install") opts.install = false; // explicit; matches default
    else if (a === "--scope") opts.scope = argv[++i];
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

Drives a host's REAL CLI against the .acverify connector in an isolated HOME to
confirm the host ACCEPTS our written config (and fires our hook where auth-free).
Missing binaries / auth ceilings are SKIPS, never failures. Exit 1 only on a real
placement miss or uninstall residue. The real HOME is never touched.

  --install     for a missing binary with a known install method, install the
                host CLI into the gitignored local prefix .verify-tools (npm
                --prefix; never global) and live-verify it. OPT-IN because this
                DOWNLOADS AND EXECUTES third-party code — off by default. Without
                it (or with --no-install) a missing binary stays skip-not-fail.`;

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
