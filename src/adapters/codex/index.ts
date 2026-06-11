/**
 * adapters/codex — Codex CLI platform adapter for agent-connector.
 *
 * Codex CLI hook paradigm is "json-stdio": the host pipes a JSON payload to a
 * command on stdin and reads JSON/exit-code back — the same wire protocol as
 * Claude Code (PascalCase fields, `hookSpecificOutput` reply wrapper).
 *
 * Two native config files live under the Codex config dir
 * (`$CODEX_HOME` || `~/.codex`, mirrored to `<projectDir>/.codex` for project
 * scope):
 *   - config.toml  → `[mcp_servers.<id>]` MCP registration (TOML, NO native
 *     interpolation, so env-refs are resolved to literals at install time).
 *   - hooks.json   → Claude-compatible hook registration ({ matcher, hooks }).
 *
 * Grounded in context-mode's proven Codex adapter (configs/codex/{config.toml,
 * hooks.json}, src/adapters/codex/*) — exact TOML MCP shape + hook JSON schema.
 *
 * Known Codex limitations (upstream): PreToolUse deny works but updatedInput is
 * not yet honored (openai/codex#18491); PostToolUse updatedMCPToolOutput is
 * parsed-but-unsupported — hence canModifyArgs / canModifyOutput are false.
 *
 * E1 extension events (verified against developers.openai.com/codex/hooks):
 *   - PermissionRequest — native, decision-capable via the nested
 *     hookSpecificOutput.decision{behavior:"allow"|"deny", message?} envelope.
 *     Codex docs: updatedInput / updatedPermissions / interrupt FAIL CLOSED on
 *     this event, so they are never emitted here.
 *   - SubagentStart — native; hookSpecificOutput.additionalContext is injected
 *     as developer context for the subagent (not blockable).
 *   - SubagentStop — native; the documented continuation shape is the TOP-LEVEL
 *     {"decision":"block","reason"} (Stop semantics: keeps the subagent going).
 *   - PostToolUseFailure — NO Codex analog (PostToolUse only); declared hooks
 *     for it warn-skip at install and the capability flag stays unset.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import TOML from "@iarna/toml";

import type {
  ChangeRecord,
  CommandDef,
  DetectedPlatform,
  HealthCheck,
  HookEventName,
  HookParadigm,
  HookResponse,
  PlatformCapabilities,
  PlatformId,
  ServerDef,
  SkillDef,
  SubagentDef,
} from "../../core/types.js";
import { ensureDir } from "../../core/paths.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import { writeTomlString } from "../../core/toml.js";
import {
  buildHomeBinHookCommand,
  buildServeWrapperCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";
import { BaseAdapter } from "../base.js";
import type {
  HookReply,
  InstallContext,
  MemoryTarget,
  NormalizedEvent,
} from "../spi.js";

// ─────────────────────────────────────────────────────────────────────────
// Native shapes
// ─────────────────────────────────────────────────────────────────────────

/** Raw Codex hook payload (PascalCase event, snake_case fields — Claude-style). */
interface CodexHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  prompt?: string;
  is_error?: boolean;
  stop_hook_active?: boolean;
  trigger?: string;
  message?: string;
  // PostToolUseFailure-style failure field. Codex has NO failure event today;
  // parsed defensively only (the Claude-compatible wire would carry it).
  error?: string;
  // SubagentStart / SubagentStop (agent_type is the matcher subject).
  agent_id?: string;
  agent_type?: string;
  // SubagentStop only — the subagent's own transcript + final message.
  agent_transcript_path?: string;
  last_assistant_message?: string;
}

/** One hook entry inside hooks.json (Claude-compatible). */
interface CodexHookEntry {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string }>;
}

interface CodexHooksFile {
  hooks?: Record<string, CodexHookEntry[]>;
  [key: string]: unknown;
}

/** Rendered `[mcp_servers.<id>]` table — string env table, no interpolation. */
interface CodexMcpEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Codex hook events agent-connector registers, in the canonical → native order.
 * Codex uses the same PascalCase event names as Claude Code; the home-binary
 * hook command receives the lowercased event token.
 */
const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "UserPromptSubmit",
  "Stop",
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop",
] as const;

type CodexHookEventName = (typeof CODEX_HOOK_EVENTS)[number];

/**
 * Newer canonical events with NO Codex analog: Codex ships PostToolUse only —
 * there is no failure event on the live hooks page. Declared hooks for these
 * warn-skip at install so the degradation is reported, never silent. (The
 * legacy SessionEnd / Notification silent filter predates this convention and
 * is deliberately left untouched.)
 */
const WARN_SKIP_EVENTS: ReadonlySet<HookEventName> = new Set(["PostToolUseFailure"]);

/**
 * PreToolUse matcher — canonical Codex tool names + bare MCP tool names +
 * external MCP catch-all literal. Charset-clean ([A-Za-z0-9_|] only) so Codex's
 * Rust `regex` exact-matcher short-circuits (no look-around, which Codex
 * rejects at boot). Copied from context-mode's proven matcher.
 */
const PRE_TOOL_USE_MATCHER =
  "local_shell|shell|shell_command|exec_command|Bash|Shell|apply_patch|Edit|Write|grep_files|mcp__";

// ─────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────

export class CodexAdapter extends BaseAdapter {
  readonly id: PlatformId = "codex";
  readonly name = "Codex CLI";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block. memoryTargets below probes
    // AGENTS.override.md first (it shadows AGENTS.md per directory on codex).
    supportsMemory: true,
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    sessionEnd: false,
    userPromptSubmit: true,
    stop: true,
    notification: false,
    // E1 events: PermissionRequest (decision-capable) + SubagentStart/Stop are
    // Codex-native. postToolUseFailure stays unset — Codex has no failure event,
    // so a declared hook for it warn-skips at install.
    permissionRequest: true,
    subagentStart: true,
    subagentStop: true,
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: true,
    transports: ["stdio", "http"],
    // Content surfaces: Codex implements all three.
    //   command  → ~/.codex/prompts/<name>.md   (md+frontmatter, USER SCOPE ONLY)
    //   skill    → <codexDir>/skills/<name>/SKILL.md (+ resources)
    //   subagent → <codexDir>/agents/<name>.toml (TOML)
    supportsCommands: true,
    supportsSkills: true,
    supportsSubagents: true,
  };

  // ── Detection ──────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = this.userConfigDir();
    const projDir = join(projectDir, ".codex");
    const userCfg = join(userDir, "config.toml");
    const projCfg = join(projDir, "config.toml");

    const userInstalled = existsSync(userDir) || existsSync(userCfg);
    const projInstalled = existsSync(projDir) || existsSync(projCfg);
    const installed = userInstalled || projInstalled;
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projCfg : userCfg;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? `Found Codex config dir (${scope})`
        : `No .codex config dir at ${userDir} or ${projDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ───────────────────────────────────────────────────────

  override getConfigDir(ctx: InstallContext): string {
    if (ctx.scope === "project") return join(ctx.projectDir, ".codex");
    return this.userConfigDir();
  }

  override getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "config.toml");
  }

  override getHookConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "hooks.json");
  }

  // ── Memory surface: AGENTS.override.md probe + 32 KiB doc-cap budget ─────
  // Codex reads AGENTS.override.md > AGENTS.md per directory (one file per
  // directory), so when the override file exists OUR block must live there or
  // it is never loaded. Combined project docs are capped at 32 KiB
  // (`project_doc_max_bytes`), hence the ~28 KiB per-file budget warn.
  protected override memoryTargets(ctx: InstallContext): MemoryTarget[] {
    // An explicit path override keeps the base resolution (escape hatch wins).
    if (this.memoryOverride(ctx)?.path) return super.memoryTargets(ctx);
    if (ctx.scope !== "project" && ctx.scope !== "user") return [];
    const budgetBytes = 28 * 1024;
    const dir = ctx.scope === "project" ? ctx.projectDir : this.userConfigDir();
    const overrideMd = join(dir, "AGENTS.override.md");
    if (existsSync(overrideMd)) {
      return [
        {
          path: overrideMd,
          reason: "AGENTS.override.md shadows AGENTS.md on codex (one doc per directory)",
          budgetBytes,
        },
      ];
    }
    return [
      {
        path: join(dir, "AGENTS.md"),
        reason:
          ctx.scope === "project"
            ? "AGENTS.md standard (project root; codex is the format's originator)"
            : "codex global guidance ($CODEX_HOME/AGENTS.md)",
        budgetBytes,
      },
    ];
  }

  /** `$CODEX_HOME` || `~/.codex` for user scope. */
  private userConfigDir(): string {
    const env = process.env.CODEX_HOME;
    if (env && env.trim() !== "") {
      if (env.startsWith("~")) {
        return join(homedir(), env.replace(/^~[/\\]?/, ""));
      }
      return env;
    }
    return join(homedir(), ".codex");
  }

  // ── TOML config IO (override JSON helpers — config.toml is TOML) ─────────

  private readToml(path: string): Record<string, unknown> {
    if (!existsSync(path)) return {};
    try {
      return TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private writeToml(path: string, data: Record<string, unknown>, dryRun: boolean): void {
    if (dryRun) return;
    ensureDir(dirname(path));
    // @iarna/toml's stringify type wants its JsonMap; our object is structurally compatible.
    writeFileSync(path, TOML.stringify(data as never), "utf8");
  }

  // ── Install server (config.toml → [mcp_servers.<id>]) ───────────────────

  override installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const server = this.effectiveServer(ctx);
    const path = this.getServerConfigPath(ctx);

    if (!server) {
      return [{ platform: this.id, action: "skip", path, detail: "no server declared" }];
    }
    if (server.transport !== "stdio" || !server.command) {
      // Codex config.toml [mcp_servers] is stdio-only; remote transports skip here.
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: `transport "${server.transport}" not registrable in config.toml (stdio only)`,
        },
      ];
    }

    const entry = this.renderMcpEntry(ctx, server);

    const cfg = this.readToml(path);
    const bucket = this.tomlBucket(cfg, "mcp_servers");
    const before = JSON.stringify(bucket[connector.id]);
    const after = JSON.stringify(entry);

    let action: ChangeRecord["action"];
    if (before === undefined) action = "create";
    else if (before === after) action = "skip";
    else action = "update";

    if (action !== "skip") {
      bucket[connector.id] = entry as unknown as Record<string, unknown>;
      this.writeToml(path, cfg, dryRun);
    }
    return [{ platform: this.id, action, path, detail: `mcp_servers.${connector.id}` }];
  }

  override uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getServerConfigPath(ctx);
    const cfg = this.readToml(path);
    const bucket = cfg["mcp_servers"];
    if (
      !existsSync(path) ||
      typeof bucket !== "object" ||
      bucket === null ||
      !(connector.id in (bucket as Record<string, unknown>))
    ) {
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: `mcp_servers.${connector.id} absent`,
        },
      ];
    }
    delete (bucket as Record<string, unknown>)[connector.id];
    this.writeToml(path, cfg, dryRun);
    return [{ platform: this.id, action: "remove", path, detail: `mcp_servers.${connector.id}` }];
  }

  // ── Install hooks (hooks.json) ──────────────────────────────────────────

  override installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getHookConfigPath(ctx);
    const events = this.effectiveHookEvents(ctx);
    const dropped = this.warnSkipHookEvents(ctx);

    if (events.length === 0 && dropped.length === 0) {
      return [{ platform: this.id, action: "skip", path, detail: "no hooks declared" }];
    }

    const file = this.readHooksFile(path);
    const hooks = (file.hooks ??= {});
    const changes: ChangeRecord[] = [];

    // Declared events Codex cannot fire are reported, never silently dropped.
    for (const event of dropped) {
      changes.push({
        platform: this.id,
        action: "warn",
        path,
        detail: `${event} has no Codex hook equivalent — skipped`,
      });
    }

    for (const event of events) {
      const desired = this.renderHookEntry(ctx, event);
      const list = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
      const idx = list.findIndex((e) => this.isOurEntry(ctx, event, e));
      if (idx < 0) {
        list.push(desired);
        changes.push({ platform: this.id, action: "create", path, detail: `hooks.${event}` });
      } else if (JSON.stringify(list[idx]) !== JSON.stringify(desired)) {
        list[idx] = desired;
        changes.push({ platform: this.id, action: "update", path, detail: `hooks.${event}` });
      } else {
        changes.push({ platform: this.id, action: "skip", path, detail: `hooks.${event}` });
      }
    }

    // Only a real entry mutation rewrites the file (a warn-skip must not
    // create/touch hooks.json by itself).
    if (changes.some((c) => c.action === "create" || c.action === "update")) {
      this.writeJson(path, file, dryRun);
    }
    return changes;
  }

  override uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const path = this.getHookConfigPath(ctx);
    const file = this.readJson<CodexHooksFile>(path);
    const hooks = file?.hooks;
    if (!file || !hooks) {
      return [{ platform: this.id, action: "skip", path, detail: "no hooks.json" }];
    }

    const changes: ChangeRecord[] = [];
    let mutated = false;
    for (const event of CODEX_HOOK_EVENTS) {
      const list = hooks[event];
      if (!Array.isArray(list)) continue;
      const kept = list.filter((e) => !this.isOurEntry(ctx, event, e));
      if (kept.length === list.length) continue;
      mutated = true;
      if (kept.length > 0) hooks[event] = kept;
      else delete hooks[event];
      changes.push({ platform: this.id, action: "remove", path, detail: `hooks.${event}` });
    }

    if (mutated) this.writeJson(path, file, ctx.dryRun);
    if (changes.length === 0) {
      return [{ platform: this.id, action: "skip", path, detail: "no agent-connector hooks present" }];
    }
    return changes;
  }

  // ── Health checks (default doctor renders these) ────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const path = this.getServerConfigPath(ctx);
    const id = ctx.connector.id;
    const checks: HealthCheck[] = [
      {
        name: `${this.name}: config.toml exists`,
        check: () =>
          existsSync(path)
            ? { status: "OK", detail: path }
            : { status: "FAIL", detail: `not found: ${path}` },
      },
      {
        name: `${this.name}: mcp_servers.${id} registered`,
        check: () => {
          // Only assert what the connector declares (same rule as the
          // content-surface checks below): a server-less connector — e.g. a
          // catalog-only bundle of agents/skills/commands — never writes an
          // [mcp_servers.<id>] table, so its absence is healthy.
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const cfg = this.readToml(path);
          const bucket = cfg["mcp_servers"];
          const present =
            typeof bucket === "object" &&
            bucket !== null &&
            id in (bucket as Record<string, unknown>);
          return present
            ? { status: "OK", detail: `mcp_servers.${id}` }
            : { status: "FAIL", detail: `mcp_servers.${id} not found in ${path}` };
        },
      },
    ];

    // Content-surface checks: assert presence only for surfaces this connector
    // declares. Codex commands are user-scope only, so a project-scope install
    // won't have written them — only check command files in user scope.
    if (ctx.scope !== "project") {
      for (const cmd of ctx.connector.commands) {
        const p = this.commandPath(cmd.name);
        checks.push({
          name: `${this.name}: command ${cmd.name} present`,
          check: () =>
            existsSync(p) ? { status: "OK", detail: p } : { status: "FAIL", detail: `not found: ${p}` },
        });
      }
    }
    for (const skill of ctx.connector.skills) {
      const p = join(this.skillDir(ctx, skill.name), "SKILL.md");
      checks.push({
        name: `${this.name}: skill ${skill.name} present`,
        check: () =>
          existsSync(p) ? { status: "OK", detail: p } : { status: "FAIL", detail: `not found: ${p}` },
      });
    }
    for (const agent of ctx.connector.subagents) {
      const p = this.subagentPath(ctx, agent.name);
      checks.push({
        name: `${this.name}: subagent ${agent.name} present`,
        check: () =>
          existsSync(p) ? { status: "OK", detail: p } : { status: "FAIL", detail: `not found: ${p}` },
      });
    }
    return checks;
  }

  // ── Content surfaces: commands / skills / subagents ──────────────────────
  // CONTENT-ONLY: pure native-file writers. No runtime dispatch, no home-bin
  // pointer, no telemetry wrap. Each method is idempotent (byte-identical →
  // skip) via writeContentFile and reversible via removeContentFile. Honors
  // platforms["codex"] per-surface false to skip.
  //
  // Native locations:
  //   command  → ~/.codex/prompts/<name>.md   md+frontmatter(description,argument-hint)
  //              USER SCOPE ONLY — project scope yields a single "warn".
  //   skill    → <codexDir>/skills/<name>/SKILL.md (+ resources)
  //   subagent → <codexDir>/agents/<name>.toml  TOML via writeTomlString

  /** Command files always live under the USER codex dir: ~/.codex/prompts. */
  private commandPath(name: string): string {
    return join(this.userConfigDir(), "prompts", `${name}.md`);
  }
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.getConfigDir(ctx), "skills", name);
  }
  private subagentPath(ctx: InstallContext, name: string): string {
    return join(this.getConfigDir(ctx), "agents", `${name}.toml`);
  }

  // ── Commands (USER SCOPE ONLY) ───────────────────────────────────────────

  override installCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[this.id]?.commands === false) {
      return [{ platform: this.id, action: "skip", detail: "commands disabled for codex" }];
    }
    if (ctx.scope === "project") {
      return [{ platform: this.id, action: "warn", detail: "codex commands are user-scope only" }];
    }
    if (connector.commands.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no commands" }];
    }
    return connector.commands.map((cmd) =>
      this.writeContentFile(this.commandPath(cmd.name), this.renderCommand(cmd), ctx.dryRun),
    );
  }

  override uninstallCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (ctx.scope === "project") {
      return [{ platform: this.id, action: "warn", detail: "codex commands are user-scope only" }];
    }
    if (connector.commands.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no commands" }];
    }
    return connector.commands.map((cmd) =>
      this.removeContentFile(this.commandPath(cmd.name), ctx.dryRun),
    );
  }

  /** Render a command to md+frontmatter (description, argument-hint). */
  private renderCommand(cmd: CommandDef): string {
    const frontmatter: Record<string, unknown> = {};
    if (cmd.description !== undefined) frontmatter.description = cmd.description;
    if (cmd.argumentHint !== undefined) frontmatter["argument-hint"] = cmd.argumentHint;
    if (cmd.extra) Object.assign(frontmatter, cmd.extra);
    return this.renderFrontmatterMd(frontmatter, cmd.prompt);
  }

  // ── Skills ───────────────────────────────────────────────────────────────

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[this.id]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for codex" }];
    }
    if (connector.skills.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no skills" }];
    }
    const changes: ChangeRecord[] = [];
    for (const skill of connector.skills) {
      const dir = this.skillDir(ctx, skill.name);
      changes.push(
        this.writeContentFile(join(dir, "SKILL.md"), this.renderSkill(skill), ctx.dryRun),
      );
      // Bundle any resource files beside SKILL.md (relative path → contents).
      // Defense-in-depth: skip+warn on any key that escapes the skill dir
      // (config-time validation already rejects these, but never trust input).
      for (const [rel, contents] of Object.entries(skill.resources ?? {})) {
        const target = this.resolveWithin(dir, rel);
        if (target === null) {
          changes.push({
            platform: this.id,
            action: "warn",
            detail: `skill resource "${rel}" escapes the skill dir; skipped`,
          });
          continue;
        }
        changes.push(this.writeContentFile(target, contents, ctx.dryRun));
      }
    }
    return changes;
  }

  override uninstallSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.skills.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no skills" }];
    }
    const changes: ChangeRecord[] = [];
    for (const skill of connector.skills) {
      const dir = this.skillDir(ctx, skill.name);
      // Remove only the files we wrote (SKILL.md + declared resources), then the
      // skill dir itself when we own its full contents.
      changes.push(this.removeContentFile(join(dir, "SKILL.md"), ctx.dryRun));
      for (const rel of Object.keys(skill.resources ?? {})) {
        const target = this.resolveWithin(dir, rel);
        if (target === null) continue; // never delete outside the skill dir
        changes.push(this.removeContentFile(target, ctx.dryRun));
      }
      // Only remove the skill dir when WE own its full contents — never rm -rf a
      // dir that still holds user-added / sibling-tool / shared files.
      changes.push(this.removeDirIfEmpty(dir, ctx.dryRun));
    }
    return changes;
  }

  /**
   * Render a skill's SKILL.md: frontmatter (name, description + optional model,
   * allowed-tools, disable-model-invocation) + body. UNIFORM with every other
   * skill-supporting platform — only the parent dir differs.
   */
  private renderSkill(skill: SkillDef): string {
    const frontmatter: Record<string, unknown> = {
      name: skill.name,
      description: skill.description,
    };
    if (skill.model !== undefined) frontmatter.model = skill.model;
    const allow = skill.tools?.allow;
    if (allow && allow.length > 0) frontmatter["allowed-tools"] = allow.join(", ");
    if (skill.disableModelInvocation !== undefined) {
      frontmatter["disable-model-invocation"] = skill.disableModelInvocation;
    }
    if (skill.extra) Object.assign(frontmatter, skill.extra);
    return this.renderFrontmatterMd(frontmatter, skill.body);
  }

  // ── Subagents (TOML) ─────────────────────────────────────────────────────

  override installSubagents(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[this.id]?.subagents === false) {
      return [{ platform: this.id, action: "skip", detail: "subagents disabled for codex" }];
    }
    if (connector.subagents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no subagents" }];
    }
    return connector.subagents.map((agent) =>
      this.writeContentFile(this.subagentPath(ctx, agent.name), this.renderSubagent(agent), ctx.dryRun),
    );
  }

  override uninstallSubagents(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.subagents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no subagents" }];
    }
    return connector.subagents.map((agent) =>
      this.removeContentFile(this.subagentPath(ctx, agent.name), ctx.dryRun),
    );
  }

  /**
   * Render a subagent to a Codex agent TOML file:
   *   { name, description, developer_instructions: prompt, model }.
   * model is omitted when undefined so Codex applies its default.
   */
  private renderSubagent(agent: SubagentDef): string {
    const table: Record<string, unknown> = {
      name: agent.name,
      description: agent.description,
      developer_instructions: agent.prompt,
    };
    if (agent.model !== undefined) table.model = agent.model;
    if (agent.extra) Object.assign(table, agent.extra);
    return writeTomlString(table);
  }

  // ── Runtime dispatch ────────────────────────────────────────────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as CodexHookInput;
    const base = {
      hostPlatform: this.id,
      connectorId: "",
      sessionId: input.session_id ?? `pid-${process.ppid}`,
      projectDir: input.cwd ?? process.env.CODEX_PROJECT_DIR ?? process.cwd(),
      raw,
    };

    switch (event) {
      case "PreToolUse":
        return {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
        };
      case "PostToolUse":
        return {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          toolOutput: input.tool_response,
          isError: input.is_error ?? false,
        };
      case "SessionStart":
        return { ...base, source: this.normalizeSource(input.source) };
      case "SessionEnd":
        return { ...base, reason: input.message };
      case "UserPromptSubmit":
        return { ...base, prompt: input.prompt ?? "" };
      case "PreCompact":
        return { ...base, trigger: input.trigger === "manual" ? "manual" : "auto" };
      case "Stop":
        return { ...base, stopHookActive: input.stop_hook_active ?? false };
      case "Notification":
        return { ...base, message: input.message ?? "" };
      case "PermissionRequest":
        // Codex documents tool_name/tool_input (+tool_input.description); it has
        // no permission_suggestions field, so the normalized optional stays unset.
        return {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
        };
      case "PostToolUseFailure":
        // No Codex analog — never fired natively. Parsed defensively (Claude-
        // compatible wire) so a manual `hook codex PostToolUseFailure` invocation
        // still normalizes instead of throwing.
        return {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          error: input.error ?? "",
        };
      case "SubagentStart":
        return {
          ...base,
          ...(typeof input.agent_id === "string" ? { agentId: input.agent_id } : {}),
          ...(typeof input.agent_type === "string" ? { agentType: input.agent_type } : {}),
        };
      case "SubagentStop":
        // agent_id/agent_type stay optional — never depend on hosts populating
        // them on stop (the Claude-family SDK quirk).
        return {
          ...base,
          ...(typeof input.agent_id === "string" ? { agentId: input.agent_id } : {}),
          ...(typeof input.agent_type === "string" ? { agentType: input.agent_type } : {}),
          ...(typeof input.agent_transcript_path === "string"
            ? { agentTranscriptPath: input.agent_transcript_path }
            : {}),
          ...(typeof input.last_assistant_message === "string"
            ? { lastAssistantMessage: input.last_assistant_message }
            : {}),
          ...(typeof input.stop_hook_active === "boolean"
            ? { stopHookActive: input.stop_hook_active }
            : {}),
        };
    }
  }

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    // Codex (like Claude Code) reads a `hookSpecificOutput` JSON wrapper from
    // stdout; exit code 0 = allow. Fields the host cannot honor are dropped.

    // PermissionRequest uses Codex's nested decision{behavior} envelope and is
    // the ONE event where an EXPLICIT "allow" is an ACTIVE grant (suppresses the
    // approval prompt). ask/context/void → NO decision output: fall through to
    // the normal approval flow (the prompt IS the ask). Codex docs: updatedInput
    // / updatedPermissions / interrupt FAIL CLOSED on this event, so "modify"
    // also falls through — emitting a bare allow would grant the ORIGINAL input
    // the handler wanted rewritten.
    if (event === "PermissionRequest") {
      if (response.decision === "deny") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: {
                behavior: "deny",
                message: response.reason ?? "Blocked by hook",
              },
            },
          }),
        };
      }
      if (response.decision === "allow") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: { behavior: "allow" },
            },
          }),
        };
      }
      return { exitCode: 0 };
    }

    // SubagentStart is observe/context-only on Codex (continue:false is parsed
    // but does not stop the subagent): "context" injects additionalContext as
    // developer context for the SUBAGENT, and a "deny" DEGRADES to the same
    // shape carrying the reason.
    if (event === "SubagentStart") {
      const context =
        response.decision === "context"
          ? response.additionalContext
          : response.decision === "deny"
            ? response.reason ?? response.additionalContext
            : undefined;
      if (context) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "SubagentStart",
              additionalContext: context,
            },
          }),
        };
      }
      return { exitCode: 0 };
    }

    if (response.decision === "deny") {
      // PreToolUse deny is honored; other events fail-open to allow.
      if (event === "PreToolUse") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: response.reason ?? "Blocked by hook",
            },
          }),
        };
      }
      // SubagentStop deny = Stop semantics: the documented continuation shape is
      // the TOP-LEVEL {"decision":"block","reason"} (keeps the subagent going
      // with `reason` as its next instruction).
      if (event === "SubagentStop") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            decision: "block",
            reason: response.reason ?? "Blocked by hook",
          }),
        };
      }
      return { exitCode: 0 };
    }

    // Context injection: honored on SessionStart and PostToolUse (additionalContext).
    // (SubagentStop accepts only the common output fields — no additionalContext.)
    if (response.additionalContext && (event === "SessionStart" || event === "PostToolUse")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: event,
            additionalContext: response.additionalContext,
          },
        }),
      };
    }

    // "allow" / unsupported-on-Codex (modify, ask) → passthrough.
    return { exitCode: 0 };
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  /** Resolve the per-platform server override into an effective ServerDef. */
  private effectiveServer(ctx: InstallContext): ServerDef | undefined {
    const override = ctx.connector.platforms[this.id]?.server;
    if (override === false) return undefined;
    const base = ctx.connector.server;
    if (!base) return undefined;
    return override ? { ...base, ...override } : base;
  }

  /** Which canonical hook events to register for Codex, honoring overrides. */
  private effectiveHookEvents(ctx: InstallContext): CodexHookEventName[] {
    const override = ctx.connector.platforms[this.id]?.hooks;
    if (override === false) return [];
    return CODEX_HOOK_EVENTS.filter((e) => ctx.connector.hookEvents.includes(e));
  }

  /** Declared events Codex has no analog for — install reports a warn-skip. */
  private warnSkipHookEvents(ctx: InstallContext): HookEventName[] {
    const override = ctx.connector.platforms[this.id]?.hooks;
    if (override === false) return [];
    return ctx.connector.hookEvents.filter((e) => WARN_SKIP_EVENTS.has(e));
  }

  /**
   * Render the `[mcp_servers.<id>]` table. TOML has NO interpolation, so every
   * `${env:VAR}` is resolved to a literal at install time. The env table is a
   * plain string→string map. Honors the telemetry serve-wrapper.
   */
  private renderMcpEntry(ctx: InstallContext, server: ServerDef): CodexMcpEntry {
    let command = server.command as string;
    let args = [...(server.args ?? [])];

    if (shouldWrapForTelemetry(server, ctx.connector.telemetry)) {
      const wrapped = buildServeWrapperCommand(ctx.homeBinPath, ctx.connector.id, command, args, ctx.scope, this.id);
      command = wrapped.command;
      args = wrapped.args;
    }

    // Resolve env-refs to literals (TOML cannot interpolate).
    command = resolveEnvRefsDeep(command);
    args = resolveEnvRefsDeep(args);

    const entry: CodexMcpEntry = { command };
    if (args.length > 0) entry.args = args;

    if (server.env && Object.keys(server.env).length > 0) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(resolveEnvRefsDeep(server.env))) {
        env[k] = String(v);
      }
      entry.env = env;
    }
    return entry;
  }

  /** Render one hooks.json entry pointing at the stable home binary. */
  private renderHookEntry(ctx: InstallContext, event: CodexHookEventName): CodexHookEntry {
    const command = buildHomeBinHookCommand(
      ctx.homeBinPath,
      "codex",
      event,
      ctx.connector.id,
    );
    const entry: CodexHookEntry = { hooks: [{ type: "command", command }] };
    // PermissionRequest matches tool names exactly like PreToolUse (Bash,
    // apply_patch aliases, mcp__* names), so it carries the same charset-clean
    // matcher. Subagent* match agent_type — register "" (all agents) and let the
    // universal entrypoint apply the connector's own matcher at runtime.
    if (event === "PreToolUse" || event === "PermissionRequest") {
      entry.matcher = PRE_TOOL_USE_MATCHER;
    } else entry.matcher = "";
    return entry;
  }

  /** Does this hooks.json entry belong to this connector (by home-bin command)? */
  private isOurEntry(ctx: InstallContext, event: CodexHookEventName, entry: CodexHookEntry): boolean {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) return false;
    const ours = buildHomeBinHookCommand(ctx.homeBinPath, "codex", event, ctx.connector.id);
    const needle = ours.replace(/\\/g, "/");
    return entry.hooks.some((h) => (h.command ?? "").replace(/\\/g, "/") === needle);
  }

  private readHooksFile(path: string): CodexHooksFile {
    return this.readJson<CodexHooksFile>(path) ?? {};
  }

  /** Get-or-create a nested table inside a parsed TOML object. */
  private tomlBucket(cfg: Record<string, unknown>, key: string): Record<string, unknown> {
    const existing = cfg[key];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      return existing as Record<string, unknown>;
    }
    const fresh: Record<string, unknown> = {};
    cfg[key] = fresh;
    return fresh;
  }

  private normalizeSource(raw: string | undefined): "startup" | "compact" | "resume" | "clear" {
    switch (raw) {
      case "compact":
        return "compact";
      case "resume":
        return "resume";
      case "clear":
        return "clear";
      default:
        return "startup";
    }
  }
}

export const adapter = new CodexAdapter();
export default adapter;
