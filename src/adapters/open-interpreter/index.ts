/**
 * adapters/open-interpreter — Open Interpreter (the new Rust `interpreter` / `i`
 * CLI) platform adapter for agent-connector.
 *
 * Open Interpreter is a FORK of OpenAI's Codex. The project's own README states
 * verbatim: "This is the new Rust version of Open Interpreter … Open Interpreter
 * is a fork of OpenAI's Codex, with a focus on emulating the agent harness that
 * gets the best performance out of low-cost models." (The original Python project
 * lives on as the community fork endolith/open-interpreter.) The repo at
 * github.com/openinterpreter/open-interpreter IS the codex-rs source tree, and
 * docs/open-interpreter-delta.md keeps the maintained delta to product identity,
 * installers and provider-neutral model config — the config and hook subsystems
 * are upstream Codex's. This adapter therefore EXTENDS CodexAdapter and overrides
 * only what the fork renames.
 *
 * Config HOME (byte-confirmed against codex-rs/utils/home-dir/src/lib.rs):
 *   - The `interpreter` binary deliberately does NOT honor $CODEX_HOME ("sharing
 *     the Codex home leaks Codex config, update caches, and credentials into the
 *     Interpreter identity"). The ONLY honored override is $INTERPRETER_HOME, and
 *     the default is ~/.openinterpreter. The install script
 *     (scripts/install/install-open-interpreter.sh) confirms both: it sets
 *     CODEX_COMMAND_NAME=interpreter and CODEX_HOME="${INTERPRETER_HOME:-$HOME/.openinterpreter}".
 *   - Project layer dir is `.openinterpreter` (codex-rs/config/src/loader/mod.rs:
 *     `Product::OpenInterpreter => ".openinterpreter"`), NOT `.codex`.
 *
 * MCP — inherited from codex: `[mcp_servers.<id>]` tables in <home>/config.toml
 *   (codex-rs/config/src/mcp_edit.rs); stdio { command, args, env }, streamable-
 *   HTTP { url, bearer_token_env_var?, http_headers? }. TOML has NO native
 *   interpolation, so `${env:VAR}` refs resolve to LITERALS at install time.
 *
 * HOOKS — json-stdio, VERIFIED 2026-09-07 (source + live run, v0.0.41):
 *   - `features.hooks` is `Stage::Stable, default_enabled: true`
 *     (codex-rs/features/src/lib.rs) and docs/hooks.md says "enabled by default".
 *   - Files: `~/.openinterpreter/hooks.json` (user) and `.openinterpreter/hooks.json`
 *     (trusted project), plus inline `[[hooks.<Event>]]` in config.toml; all
 *     matching sources run (docs/hooks.md "Where Hooks Live"). We write the
 *     Claude-compatible hooks.json exactly as the codex adapter does.
 *   - Live run against a local mock chat-completions provider fired, in order:
 *     SessionStart (source=startup), UserPromptSubmit, PreToolUse (tool_name
 *     "Bash" for exec_command), PostToolUse, Stop, SessionEnd — each with the
 *     Claude-shaped stdin JSON (`hook_event_name`, `session_id`, `cwd`, …).
 *     SessionEnd is therefore ADDED on top of CODEX_HOOK_EVENTS (its hook
 *     timeout is clamped to 3s by the host; the entry we write carries none).
 *   - Trust gate (shared with upstream Codex): non-managed command hooks run
 *     only after `/hooks` review in the TUI or `--dangerously-bypass-hook-trust`.
 *
 * CONTENT SURFACES (docs/skills.md, docs/agents_md.md, docs/subagents.md):
 *   - skills  → project `<projectDir>/.agents/skills/<name>/SKILL.md` (the
 *     tool-neutral location the docs tell users to use; `~/.openinterpreter/skills`
 *     is a legacy fallback) · user `~/.agents/skills/<name>/SKILL.md`.
 *   - memory  → `~/.openinterpreter/AGENTS.md` (global) / project AGENTS.md,
 *     with `AGENTS.override.md` shadowing per directory — codex's rule.
 *   - commands / subagents → NOT wired. Subagents are `[agents.<name>]` tables
 *     in config.toml (a different shape from codex's `agents/<name>.toml`), and
 *     no custom-prompts directory is documented for the interpreter product;
 *     both stay host-native-but-unwired until a path is byte-confirmed.
 *
 * DETECTION: keys on `<home>/config.toml` (or the home dir itself) under
 * $INTERPRETER_HOME || ~/.openinterpreter, and on a project `.openinterpreter`
 * dir — never on ~/.codex, so a Codex install is never misreported.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type {
  ChangeRecord,
  DetectedPlatform,
  HookParadigm,
  PlatformCapabilities,
  PlatformId,
} from "../../core/types.js";
import type { InstallContext, MemoryTarget } from "../spi.js";
import { CODEX_HOOK_EVENTS, CodexAdapter } from "../codex/index.js";

const HOST: PlatformId = "open-interpreter";

/** Codex's event table plus SessionEnd, which the interpreter product fires (live-verified). */
const OPEN_INTERPRETER_HOOK_EVENTS: readonly string[] = [...CODEX_HOOK_EVENTS, "SessionEnd"];

export class OpenInterpreterAdapter extends CodexAdapter {
  override readonly id: PlatformId = HOST;
  override readonly name = "Open Interpreter";
  override readonly paradigm: HookParadigm = "json-stdio";

  override readonly capabilities: PlatformCapabilities = {
    supportsMemory: true,
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    // Live-verified: the SessionEnd hook fires at process exit (host clamps its timeout to 3s).
    sessionEnd: true,
    userPromptSubmit: true,
    stop: true,
    notification: false,
    permissionRequest: true,
    subagentStart: true,
    subagentStop: true,
    postCompact: true,
    canModifyArgs: true,
    canModifyOutput: false,
    canInjectSessionContext: true,
    transports: ["stdio", "http"],
    // See header: skills are wired; commands and subagents stay unwired.
    supportsCommands: false,
    supportsSkills: true,
    supportsSubagents: false,
  };

  protected override get hookEventNames(): readonly string[] {
    return OPEN_INTERPRETER_HOOK_EVENTS;
  }

  protected override get hookHostLabel(): string {
    return "Open Interpreter";
  }

  // ── Detection ──────────────────────────────────────────────────────────

  override detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = this.userConfigDir();
    const projDir = join(projectDir, ".openinterpreter");
    const userCfg = join(userDir, "config.toml");
    const projCfg = join(projDir, "config.toml");

    const userInstalled = existsSync(userDir) || existsSync(userCfg);
    const projInstalled = existsSync(projDir) || existsSync(projCfg);
    const installed = userInstalled || projInstalled;
    const scope = projInstalled && !userInstalled ? "project" : "user";

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath: scope === "project" ? projCfg : userCfg,
      scope,
      reason: installed
        ? `Found Open Interpreter config dir (${scope})`
        : `No Open Interpreter config dir at ${userDir} or ${projDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ───────────────────────────────────────────────────────

  override getConfigDir(ctx: InstallContext): string {
    if (ctx.scope === "project") return join(ctx.projectDir, ".openinterpreter");
    return this.userConfigDir();
  }

  /** $INTERPRETER_HOME (tilde-expanded, then resolved) when set & non-empty,
   *  else ~/.openinterpreter. $CODEX_HOME is deliberately ignored (see header). */
  protected override userConfigDir(): string {
    const env = process.env.INTERPRETER_HOME;
    if (env && env.trim() !== "") {
      if (env.startsWith("~")) return join(homedir(), env.replace(/^~[/\\]?/, ""));
      return resolve(env);
    }
    return join(homedir(), ".openinterpreter");
  }

  /** Project skills live in the tool-neutral `.agents/skills` (docs/skills.md), not under `.openinterpreter`. */
  protected override skillDir(ctx: InstallContext, name: string): string {
    if (ctx.scope === "project") return join(ctx.projectDir, ".agents", "skills", name);
    return join(homedir(), ".agents", "skills", name);
  }

  // ── Memory: AGENTS.override.md > AGENTS.md per directory (codex rule, OI home) ─
  protected override memoryTargets(ctx: InstallContext): MemoryTarget[] {
    if (this.memoryOverride(ctx)?.path) return super.memoryTargets(ctx);
    if (ctx.scope !== "project" && ctx.scope !== "user") return [];
    const budgetBytes = 28 * 1024;
    const dir = ctx.scope === "project" ? ctx.projectDir : this.userConfigDir();
    const overrideMd = join(dir, "AGENTS.override.md");
    if (existsSync(overrideMd)) {
      return [
        {
          path: overrideMd,
          reason: "AGENTS.override.md shadows AGENTS.md on Open Interpreter (one doc per directory)",
          budgetBytes,
        },
      ];
    }
    return [
      {
        path: join(dir, "AGENTS.md"),
        reason:
          ctx.scope === "project"
            ? "AGENTS.md standard (project root; read root-down to cwd)"
            : "Open Interpreter global guidance ($INTERPRETER_HOME/AGENTS.md)",
        budgetBytes,
      },
    ];
  }

  // ── Unwired content surfaces (host-native, path not byte-confirmed) ──────

  override installCommands(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "commands unavailable (no custom-prompts directory is documented for Open Interpreter)",
      },
    ];
  }

  override uninstallCommands(_ctx: InstallContext): ChangeRecord[] {
    return [{ platform: this.id, action: "skip", detail: "commands unavailable" }];
  }

  override installSubagents(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail:
          "subagents unavailable (Open Interpreter defines roles as [agents.<name>] tables in config.toml; not wired)",
      },
    ];
  }

  override uninstallSubagents(_ctx: InstallContext): ChangeRecord[] {
    return [{ platform: this.id, action: "skip", detail: "subagents unavailable" }];
  }
}

export const adapter = new OpenInterpreterAdapter();
export default adapter;
