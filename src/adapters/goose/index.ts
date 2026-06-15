/**
 * adapters/goose — Block's Goose platform adapter for agent-connector.
 *
 * Goose is a json-stdio host, but its two config surfaces use DIFFERENT formats:
 *
 *   - MCP servers (Goose calls them "extensions") live in a YAML config under the
 *     root key `extensions`. The native stdio entry shape is Goose-specific:
 *       { type: "stdio", cmd: <exe>, args: [...], envs: {...}, timeout, enabled }
 *     NOTE the field is `cmd` (NOT `command`) and the env map is `envs` (NOT
 *     `env`). Because the file is YAML, the BaseAdapter JSON helpers do not apply
 *     — we merge via core/yaml's readYaml/writeYaml, preserving any other config.
 *
 *   - Hooks use Goose's Open Plugins system, which stores hook registrations in
 *     JSON at <root>/.agents/plugins/<plugin-name>/hooks/hooks.json (project root
 *     = <projectDir>/.agents; user root = ~/.agents):
 *       { hooks: { <Event>: [ { matcher?, hooks:[{ type:"command", command }] } ] } }
 *     The shape is the Claude-style NESTED rule (an optional `matcher` plus an
 *     inner `hooks` array), and there is NO top-level `version` key. This file is
 *     plain JSON, so the standard fs/JSON helpers are used for it.
 *
 * Wire protocol (parse) is Claude-compatible JSON on stdin, except Goose names
 * the working directory field `working_dir` (not `cwd`). The deny reply is
 * Goose's `{ decision: "block", reason }` (NOT Claude's hookSpecificOutput
 * permissionDecision shape).
 *
 * Native config locations (user scope):
 *   - Linux/macOS:        ~/.config/goose/config.yaml
 *   - Windows:            %APPDATA%/Block/goose/config/config.yaml
 */

import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { BaseAdapter } from "../base.js";
import type { Adapter, HookReply, InstallContext, MemoryTarget, NormalizedEvent } from "../spi.js";
import type {
  ChangeRecord,
  DetectedPlatform,
  HealthCheck,
  HookEventName,
  HookParadigm,
  HookResponse,
  NotificationEvent,
  PlatformCapabilities,
  PlatformId,
  PostToolUseEvent,
  PostToolUseFailureEvent,
  PreCompactEvent,
  PreToolUseEvent,
  SessionEndEvent,
  SessionStartEvent,
  ServerDef,
  SkillDef,
  StopEvent,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { ensureDir } from "../../core/paths.js";
import { readYaml, writeYaml } from "../../core/yaml.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildHomeBinHookCommand,
  buildServeWrapperCommand,
  isHomeBinHookCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "goose";
/** Root key under which Goose stores MCP servers ("extensions") in config.yaml. */
const MCP_ROOT_KEY = "extensions";

/**
 * Map each normalized hook event to the matching capability flag on this
 * adapter. The adapter's own `capabilities` literal is the single source of
 * truth for what Goose's Open-Plugins runtime delivers (PreToolUse/PostToolUse/
 * SessionStart/PostToolUseFailure); installHooks filters declared events
 * through this map so an unsupported event (e.g. UserPromptSubmit) is never
 * written verbatim into hooks.json — it is reported as a graceful warn/skip
 * instead.
 */
const EVENT_CAPABILITY: Record<HookEventName, keyof PlatformCapabilities> = {
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  UserPromptSubmit: "userPromptSubmit",
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  PreCompact: "preCompact",
  Stop: "stop",
  Notification: "notification",
  // Newer events. Goose's hooks system ships a dedicated PostToolUseFailure;
  // it has NO permission-dialog or subagent lifecycle events, so those three
  // flags stay unset on `capabilities` and warn-skip at install.
  PermissionRequest: "permissionRequest",
  PostToolUseFailure: "postToolUseFailure",
  SubagentStart: "subagentStart",
  SubagentStop: "subagentStop",
};

/**
 * Goose extension (MCP server) entry — note the Goose-specific field names:
 *   `cmd` (not `command`) and `envs` (not `env`).
 */
interface GooseStdioExtension {
  type: "stdio";
  cmd: string;
  args: string[];
  envs?: Record<string, string>;
  timeout: number;
  enabled: boolean;
}

/** One inner command entry inside a hook rule. */
interface GooseHookCommand {
  type: "command";
  command: string;
}

/**
 * One nested-rule entry under a hook event. Goose's Open Plugins spec uses the
 * Claude-shaped nested rule: an optional `matcher` plus an inner `hooks` array
 * of `{ type, command }` commands (NOT a flat list of commands).
 */
interface GooseHookRule {
  matcher?: string;
  hooks: GooseHookCommand[];
}

/**
 * Goose Open-Plugins hooks.json shape: `{ hooks: { <Event>: [ rule, ... ] } }`.
 * There is NO top-level `version` key in the spec.
 */
interface GooseHooksFile {
  hooks: Record<string, GooseHookRule[]>;
}

/** Raw Goose hook stdin payload (Claude-compatible JSON). */
interface GooseWireInput {
  session_id?: string;
  /** Goose names the working directory `working_dir`; `cwd` is a fallback. */
  working_dir?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  // PostToolUseFailure (Claude-compatible failure fields)
  tool_use_id?: string;
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
  source?: string;
  reason?: string;
  prompt?: string;
  trigger?: string;
  stop_hook_active?: boolean;
  message?: string;
  is_error?: boolean;
  /** Injected by the entrypoint so the runtime knows which connector to dispatch. */
  connector?: string;
}

export class GooseAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Goose";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block (project <projectDir>/AGENTS.md
    // via the base default — goose reads AGENTS.md AND .goosehints at each level,
    // .goosehints left untouched; user scope → the global .goosehints below).
    supportsMemory: true,
    preToolUse: true,
    postToolUse: true,
    preCompact: false,
    sessionStart: true,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    // Newer events: Goose ships a dedicated PostToolUseFailure hook (feedback
    // beside the error; the failure itself is not blockable). Goose has no
    // permission-dialog event and no subagent lifecycle hooks, so
    // permissionRequest / subagentStart / subagentStop stay unset — install
    // reports the standard skip-warn for them.
    postToolUseFailure: true,
    // Open Plugins documents PreToolUse/PostToolUse/SessionStart; argument
    // rewrite is not guaranteed across versions, so default to the safe value.
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: true,
    transports: ["stdio", "sse", "http"],
    // Content surfaces: goose reads SKILL.md from the cross-agent .agents dir
    //   skill → <projectDir>/.agents/skills/<name>/SKILL.md (project)
    //   skill → ~/.agents/skills/<name>/SKILL.md (user)
    // (NOT ~/.config/goose). Commands/subagents have no confirmed native dir, so
    // those flags stay unset and warn-skip via the BaseAdapter default.
    supportsSkills: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(_projectDir: string): DetectedPlatform {
    const configPath = this.userConfigPath();
    const configDir = dirname(configPath);
    const installed = existsSync(configDir) || existsSync(configPath);
    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope: "user",
      reason: installed
        ? `found Goose config at ${configPath}`
        : `no Goose config at ${configPath}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  override getConfigDir(_ctx: InstallContext): string {
    return dirname(this.userConfigPath());
  }

  /** MCP config: the YAML config.yaml (user scope). */
  override getServerConfigPath(_ctx: InstallContext): string {
    return this.userConfigPath();
  }

  /**
   * Hooks: Open-Plugins hooks.json under the `.agents/plugins/<plugin-name>/`
   * dir. The connector id is the plugin name. Project scope roots at
   * `<projectDir>/.agents`; user scope roots at `~/.agents`.
   */
  override getHookConfigPath(ctx: InstallContext): string {
    const root = ctx.scope === "project" ? ctx.projectDir : homedir();
    return join(root, ".agents", "plugins", ctx.connector.id, "hooks", "hooks.json");
  }

  /**
   * OS-correct user config.yaml path:
   *   - Windows: %APPDATA%/Block/goose/config/config.yaml
   *   - macOS/Linux: ~/.config/goose/config.yaml
   */
  private userConfigPath(): string {
    if (process.platform === "win32") {
      const appData =
        process.env.APPDATA && process.env.APPDATA.trim() !== ""
          ? process.env.APPDATA
          : join(homedir(), "AppData", "Roaming");
      return join(appData, "Block", "goose", "config", "config.yaml");
    }
    return join(homedir(), ".config", "goose", "config.yaml");
  }

  // ── Memory surface: global .goosehints at user scope ────────────────────
  // Project scope stays on the AGENTS.md base default (goose reads project
  // AGENTS.md and .goosehints at each level by default — one canonical copy in
  // the standard file; the user's .goosehints is never touched). User scope:
  // goose's only documented global memory file is the .goosehints next to
  // config.yaml (~/.config/goose/.goosehints; Windows under
  // %APPDATA%\Block\goose\config — adapter-corroborated, verify per version).
  protected override memoryTargets(ctx: InstallContext): MemoryTarget[] {
    if (this.memoryOverride(ctx)?.path || ctx.scope !== "user") {
      return super.memoryTargets(ctx);
    }
    return [
      {
        path: join(dirname(this.userConfigPath()), ".goosehints"),
        reason: "goose global hints file (.goosehints beside config.yaml)",
      },
    ];
  }

  // ── MCP server install / uninstall (YAML — merge via readYaml/writeYaml) ──

  override installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getServerConfigPath(ctx);
    const server = this.effectiveServer(ctx);

    if (!server) {
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: connector.server
            ? "server registration disabled for goose"
            : "connector declares no MCP server",
        },
      ];
    }

    const entry = this.renderExtension(ctx, server);

    // Merge into existing YAML, preserving every other config key + extension.
    const cfg = readYaml<Record<string, unknown>>(path) ?? {};
    const bucketRaw = cfg[MCP_ROOT_KEY];
    const bucket: Record<string, unknown> =
      bucketRaw && typeof bucketRaw === "object" && !Array.isArray(bucketRaw)
        ? (bucketRaw as Record<string, unknown>)
        : {};
    cfg[MCP_ROOT_KEY] = bucket;

    const before = JSON.stringify(bucket[connector.id]);
    const after = JSON.stringify(entry);
    let action: ChangeRecord["action"];
    if (before === undefined) action = "create";
    else if (before === after) action = "skip";
    else action = "update";

    if (action !== "skip") {
      bucket[connector.id] = entry;
      writeYaml(path, cfg, dryRun);
    }
    return [{ platform: this.id, action, path, detail: `${MCP_ROOT_KEY}.${connector.id}` }];
  }

  override uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getServerConfigPath(ctx);
    const cfg = readYaml<Record<string, unknown>>(path);
    const bucketRaw = cfg?.[MCP_ROOT_KEY];
    if (
      !cfg ||
      !bucketRaw ||
      typeof bucketRaw !== "object" ||
      Array.isArray(bucketRaw) ||
      !(connector.id in (bucketRaw as Record<string, unknown>))
    ) {
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: `${MCP_ROOT_KEY}.${connector.id} absent`,
        },
      ];
    }
    delete (bucketRaw as Record<string, unknown>)[connector.id];
    writeYaml(path, cfg, dryRun);
    return [
      { platform: this.id, action: "remove", path, detail: `${MCP_ROOT_KEY}.${connector.id}` },
    ];
  }

  /**
   * Render a normalized ServerDef into Goose's native extension entry. Goose has
   * no native env interpolation, so `${env:VAR}` refs are resolved to literals at
   * install time. Honors the telemetry serve-wrapper (cmd=homeBin, args=[serve…]).
   */
  private renderExtension(ctx: InstallContext, server: ServerDef): GooseStdioExtension {
    let cmd = server.command ?? "";
    let args = [...(server.args ?? [])];

    if (shouldWrapForTelemetry(server, ctx.connector.telemetry)) {
      const wrapped = buildServeWrapperCommand(
        ctx.homeBinPath,
        ctx.connector.id,
        cmd,
        args,
        ctx.scope,
        this.id,
      );
      cmd = wrapped.command;
      args = wrapped.args;
    }

    cmd = resolveEnvRefsDeep(cmd);
    args = resolveEnvRefsDeep(args);

    const timeoutMs = server.timeoutMs;
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0 ? Math.round(timeoutMs / 1000) : 300;

    const entry: GooseStdioExtension = {
      type: "stdio",
      cmd,
      args,
      timeout,
      enabled: server.enabled !== false,
    };

    if (server.env && Object.keys(server.env).length > 0) {
      const envs: Record<string, string> = {};
      for (const [k, v] of Object.entries(resolveEnvRefsDeep(server.env))) {
        envs[k] = String(v);
      }
      entry.envs = envs;
    }
    return entry;
  }

  // ── Hook install / uninstall (JSON Open-Plugins hooks.json) ───────────────

  override installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getHookConfigPath(ctx);

    if (connector.platforms[HOST]?.hooks === false) {
      return [{ platform: this.id, action: "skip", path, detail: "hooks disabled for goose" }];
    }
    const events = connector.hookEvents;
    if (events.length === 0) {
      return [{ platform: this.id, action: "skip", path, detail: "connector declares no hooks" }];
    }

    const file = this.readHooksFile(path);
    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of events) {
      // CAPABILITY FILTER: only write events Goose's Open-Plugins runtime
      // actually delivers. Derive support from THIS adapter's capabilities (the
      // single source of truth) so an event Goose does not support (e.g.
      // UserPromptSubmit) is reported as a graceful warn and never written
      // verbatim into hooks.json — mirroring the cursor adapter's pattern.
      if (this.capabilities[EVENT_CAPABILITY[event]] !== true) {
        changes.push({
          platform: this.id,
          action: "warn",
          path,
          detail: `${event} unsupported on goose — skipped`,
        });
        continue;
      }

      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, event, connector.id);
      const matcher = connector.hooks[event]?.matcher ?? "";
      const desired: GooseHookRule = {
        matcher,
        hooks: [{ type: "command", command }],
      };
      const bucket = (file.hooks[event] ??= []);
      const idx = bucket.findIndex((rule) => this.ruleHasOurCommand(rule, ctx));

      if (idx >= 0) {
        if (JSON.stringify(bucket[idx]) === JSON.stringify(desired)) {
          changes.push({ platform: this.id, action: "skip", path, detail: `hooks.${event}` });
          continue;
        }
        bucket[idx] = desired;
        changes.push({ platform: this.id, action: "update", path, detail: `hooks.${event}` });
      } else {
        bucket.push(desired);
        changes.push({ platform: this.id, action: "create", path, detail: `hooks.${event}` });
      }
      mutated = true;
    }

    if (mutated) this.writeHooksFile(path, file, dryRun);
    return changes;
  }

  override uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const path = this.getHookConfigPath(ctx);
    const file = this.readJson<GooseHooksFile>(path);
    if (!file || !file.hooks || typeof file.hooks !== "object") {
      return [{ platform: this.id, action: "skip", path, detail: "no hooks.json" }];
    }

    const changes: ChangeRecord[] = [];
    let mutated = false;
    for (const event of Object.keys(file.hooks)) {
      const bucket = file.hooks[event];
      if (!Array.isArray(bucket)) continue;

      // Strip our command from each rule's inner `hooks` array; drop rules left
      // empty so we never remove another connector's (or the user's own) hooks.
      const next: GooseHookRule[] = [];
      let removed = 0;
      for (const rule of bucket) {
        const innerBefore = rule.hooks?.length ?? 0;
        const inner = (rule.hooks ?? []).filter((h) => !this.isOurCommand(h.command, ctx));
        removed += innerBefore - inner.length;
        if (inner.length > 0) {
          next.push({ ...(rule.matcher !== undefined ? { matcher: rule.matcher } : {}), hooks: inner });
        }
      }

      if (removed === 0) continue;
      mutated = true;
      if (next.length > 0) file.hooks[event] = next;
      else delete file.hooks[event];
      changes.push({
        platform: this.id,
        action: "remove",
        path,
        detail: `hooks.${event} (${removed})`,
      });
    }

    if (mutated) this.writeHooksFile(path, file, ctx.dryRun);
    if (changes.length === 0) {
      return [{ platform: this.id, action: "skip", path, detail: "no matching hook entries" }];
    }
    return changes;
  }

  /** True when a hook command is ours (anchored home-bin + connector id). */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  /** True when any inner command of a nested rule is ours. */
  private ruleHasOurCommand(rule: GooseHookRule, ctx: InstallContext): boolean {
    return (rule.hooks ?? []).some((h) => this.isOurCommand(h.command, ctx));
  }

  private readHooksFile(path: string): GooseHooksFile {
    const existing = this.readJson<GooseHooksFile>(path);
    if (existing && existing.hooks && typeof existing.hooks === "object") {
      return { hooks: existing.hooks };
    }
    return { hooks: {} };
  }

  private writeHooksFile(path: string, file: GooseHooksFile, dryRun: boolean): void {
    if (dryRun) return;
    ensureDir(dirname(path));
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const serverPath = this.getServerConfigPath(ctx);
    const hookPath = this.getHookConfigPath(ctx);
    const id = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const hookEvents = ctx.connector.hookEvents;
    const checks: HealthCheck[] = [
      {
        name: `${this.name}: config.yaml present`,
        check: () =>
          existsSync(serverPath)
            ? { status: "OK", detail: serverPath }
            : { status: "FAIL", detail: `not found: ${serverPath}` },
      },
      {
        name: `${this.name}: ${MCP_ROOT_KEY}.${id} registered`,
        check: () => {
          if (!ctx.connector.server) return { status: "OK", detail: "no MCP server declared" };
          const cfg = readYaml<Record<string, unknown>>(serverPath);
          const bucket = cfg?.[MCP_ROOT_KEY];
          const present =
            typeof bucket === "object" &&
            bucket !== null &&
            !Array.isArray(bucket) &&
            id in (bucket as Record<string, unknown>);
          return present
            ? { status: "OK", detail: `${MCP_ROOT_KEY}.${id}` }
            : { status: "FAIL", detail: `${MCP_ROOT_KEY}.${id} not found in ${serverPath}` };
        },
      },
      {
        name: `${this.name}: hook command registered`,
        check: () => {
          if (hookEvents.length === 0) return { status: "OK", detail: "no hooks declared" };
          const file = this.readJson<GooseHooksFile>(hookPath);
          if (!file || !file.hooks) {
            return { status: "FAIL", detail: `cannot read ${hookPath}` };
          }
          const registered = Object.values(file.hooks).some((bucket) =>
            (bucket ?? []).some((rule) =>
              (rule.hooks ?? []).some((h) => isHomeBinHookCommand(h.command, homeBin, id)),
            ),
          );
          return registered
            ? { status: "OK", detail: "hook command present" }
            : { status: "FAIL", detail: `no hook for ${id} in ${hookPath}` };
        },
      },
    ];

    // Content-surface checks: assert presence only for skills this connector
    // declares (goose skills live under the .agents skills dir at either scope).
    for (const skill of ctx.connector.skills) {
      const p = join(this.skillDir(ctx, skill.name), "SKILL.md");
      checks.push({
        name: `${this.name}: skill ${skill.name} present`,
        check: () =>
          existsSync(p) ? { status: "OK", detail: p } : { status: "FAIL", detail: `not found: ${p}` },
      });
    }
    return checks;
  }

  // ── Content surface: skills ───────────────────────────────────────────────
  // CONTENT-ONLY: pure native-file writer. No runtime dispatch, no home-bin
  // pointer, no telemetry wrap. Idempotent (byte-identical → skip) via
  // writeContentFile and reversible via removeContentFile + removeDirIfEmpty.
  // Honors platforms["goose"].skills === false to skip.
  //
  // goose reads SKILL.md from the cross-agent .agents dir (NOT ~/.config/goose):
  //   project scope → <projectDir>/.agents/skills/<name>/SKILL.md
  //   user scope    → ~/.agents/skills/<name>/SKILL.md

  private skillsDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".agents", "skills")
      : join(homedir(), ".agents", "skills");
  }

  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for goose" }];
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

  // ── Runtime: parse Goose stdin JSON → normalized event ───────────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as GooseWireInput;
    // Goose sends the working directory as `working_dir`; fall back to `cwd`.
    const projectDir =
      typeof input.working_dir === "string"
        ? input.working_dir
        : typeof input.cwd === "string"
          ? input.cwd
          : undefined;
    const base = {
      hostPlatform: HOST,
      connectorId: typeof input.connector === "string" ? input.connector : "",
      sessionId: typeof input.session_id === "string" ? input.session_id : "",
      ...(projectDir !== undefined ? { projectDir } : {}),
      raw,
    } as const;

    switch (event) {
      case "PreToolUse": {
        const ev: PreToolUseEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
        };
        return ev;
      }
      case "PostToolUse": {
        const ev: PostToolUseEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          ...(toolResponseToString(input.tool_response) !== undefined
            ? { toolOutput: toolResponseToString(input.tool_response) }
            : {}),
          ...(typeof input.is_error === "boolean" ? { isError: input.is_error } : {}),
        };
        return ev;
      }
      case "SessionStart": {
        const ev: SessionStartEvent = { ...base, source: normalizeSource(input.source) };
        return ev;
      }
      case "SessionEnd": {
        const ev: SessionEndEvent = {
          ...base,
          ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
        };
        return ev;
      }
      case "UserPromptSubmit": {
        const ev: UserPromptSubmitEvent = {
          ...base,
          prompt: typeof input.prompt === "string" ? input.prompt : "",
        };
        return ev;
      }
      case "PreCompact": {
        const ev: PreCompactEvent = {
          ...base,
          ...(input.trigger === "auto" || input.trigger === "manual"
            ? { trigger: input.trigger }
            : {}),
        };
        return ev;
      }
      case "Stop": {
        const ev: StopEvent = {
          ...base,
          ...(typeof input.stop_hook_active === "boolean"
            ? { stopHookActive: input.stop_hook_active }
            : {}),
        };
        return ev;
      }
      case "Notification": {
        const ev: NotificationEvent = {
          ...base,
          message: typeof input.message === "string" ? input.message : "",
        };
        return ev;
      }
      case "PostToolUseFailure": {
        const ev: PostToolUseFailureEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          error: typeof input.error === "string" ? input.error : "",
          ...(typeof input.tool_use_id === "string"
            ? { toolUseId: input.tool_use_id }
            : {}),
          ...(typeof input.is_interrupt === "boolean"
            ? { isInterrupt: input.is_interrupt }
            : {}),
          ...(typeof input.duration_ms === "number"
            ? { durationMs: input.duration_ms }
            : {}),
        };
        return ev;
      }
      case "PermissionRequest":
      case "SubagentStart":
      case "SubagentStop": {
        // No Goose analog (no permission-dialog event, no subagent lifecycle
        // hooks). Install already skip-warns these via EVENT_CAPABILITY; a
        // runtime dispatch is a mis-route — fail loudly.
        throw new Error(`unsupported goose hook event: ${String(event)}`);
      }
      default: {
        const _never: never = event;
        throw new Error(`unsupported goose hook event: ${String(_never)}`);
      }
    }
  }

  // ── Runtime: normalized response → Goose native hook reply (Claude-shaped) ─

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const decision = response.decision ?? "allow";

    // PostToolUseFailure is feedback-only (the tool already failed, nothing is
    // blockable): "context" injects additionalContext beside the error, and a
    // "deny" DEGRADES to the same shape carrying the reason — it must never
    // render as `{ decision: "block" }`.
    if (event === "PostToolUseFailure") {
      const context =
        decision === "context"
          ? response.additionalContext
          : decision === "deny"
            ? response.reason ?? response.additionalContext
            : undefined;
      if (context) return this.stdout({ additionalContext: context });
      return { exitCode: 0 };
    }

    // deny → Goose blocks via `{ decision: "block", reason }` on stdout JSON
    // (NOT Claude's hookSpecificOutput.permissionDecision shape).
    if (decision === "deny") {
      return this.stdout({
        decision: "block",
        reason: response.reason ?? "Blocked by hook",
      });
    }

    // ask → Goose has no native "ask"; degrade to block to stay fail-safe.
    if (decision === "ask") {
      return this.stdout({
        decision: "block",
        reason: response.reason ?? "Confirmation required by hook",
      });
    }

    if (decision === "context" && response.additionalContext) {
      return this.stdout({ additionalContext: response.additionalContext });
    }

    // allow / modify (unsupported) / void → pass through.
    return { exitCode: 0 };
  }

  private stdout(payload: unknown): HookReply {
    return { exitCode: 0, stdout: JSON.stringify(payload) };
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** Resolve the per-platform server override into an effective ServerDef. */
  private effectiveServer(ctx: InstallContext): ServerDef | undefined {
    const override = ctx.connector.platforms[this.id]?.server;
    if (override === false) return undefined;
    const base = ctx.connector.server;
    if (!base) return undefined;
    return override && typeof override === "object" ? { ...base, ...override } : base;
  }
}

/** Coerce a Goose PostToolUse `tool_response` into a string. */
function toolResponseToString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeSource(raw: string | undefined): SessionStartEvent["source"] {
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

export const adapter = new GooseAdapter();
export default adapter;
