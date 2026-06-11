/**
 * adapters/jetbrains-copilot — JetBrains Copilot platform adapter for agent-connector.
 *
 * JetBrains Copilot shares the Copilot hook paradigm with VS Code Copilot
 * (Claude-compatible json-stdio), but diverges on MCP registration:
 *
 *   - MCP servers: JetBrains stores MCP server registration via the IDE Settings
 *     UI (Settings > Tools > GitHub Copilot > MCP > Configure), NOT in any file
 *     we can reliably write — the runtime owns the `servers` key behind the UI.
 *     So `installServer` writes NOTHING and returns a "warn" ChangeRecord telling
 *     the user to add the server via the JetBrains MCP settings UI. Writing a
 *     bogus file would be ignored at best and corrupt real UI state at worst.
 *     `getHealthChecks` surfaces this as a WARN (not FAIL).
 *
 *   - Hooks (Copilot Preview hooks): file-based and identical in shape to VS Code
 *     Copilot. We write one per-connector file at
 *     <projectDir>/.github/hooks/<connector-id>.json shaped as:
 *       { "version": 1, "hooks": { <Event>: [ { "type": "command", "command" } ] } }
 *     The top-level `version: 1` is REQUIRED — the Copilot hooks runtime rejects a
 *     version-less file and no hooks fire. Each entry is a FLAT { type, command }
 *     object (no Claude-style { matcher, hooks:[...] } wrapper). JetBrains parses
 *     matchers but IGNORES them — ALL hooks fire on ALL tools — so we omit the
 *     matcher entirely rather than persist an advisory one that never applies.
 *
 *   - Reply: Claude-compatible JSON on stdout (exit 0), a `hookSpecificOutput`
 *     object keyed by the PascalCase `hookEventName` carrying permissionDecision
 *     (deny|ask) + permissionDecisionReason and additionalContext. This mirrors
 *     vscode-copilot/claude-code exactly EXCEPT JetBrains cannot rewrite tool
 *     input (canModifyArgs:false), so a "modify" decision degrades to allow.
 *
 * Env interpolation: GitHub Copilot does not document a portable native env
 * token for the hooks file, and the hooks file only ever carries our home-bin
 * hook command (no secrets), so there is nothing to interpolate here. MCP env
 * interpolation is moot because we never write the MCP file.
 */

import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { BaseAdapter } from "../base.js";
import type { Adapter, HookReply, InstallContext, NormalizedEvent } from "../spi.js";
import type {
  ChangeRecord,
  CommandDef,
  DetectedPlatform,
  HealthCheck,
  HookEventName,
  HookParadigm,
  HookResponse,
  NotificationEvent,
  PlatformCapabilities,
  PlatformId,
  PostToolUseEvent,
  PreCompactEvent,
  PreToolUseEvent,
  SessionEndEvent,
  SessionStartEvent,
  SkillDef,
  StopEvent,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import {
  buildHomeBinHookCommand,
  isHomeBinHookCommand,
} from "../../core/spawn.js";

const HOST: PlatformId = "jetbrains-copilot";

/** Top-level version the Copilot hooks runtime requires; a version-less file is rejected. */
const JETBRAINS_HOOKS_VERSION = 1;

/**
 * JetBrains Copilot reads PascalCase hook event names from its hooks file —
 * identical to VS Code Copilot / Claude Code. Only the events JetBrains actually
 * delivers are registered; everything else has no Copilot equivalent and is
 * reported as a warn/skip at install time.
 */
const EVENT_MAP: Partial<Record<HookEventName, string>> = {
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  PreCompact: "PreCompact",
  SessionStart: "SessionStart",
};

/** A single JetBrains Copilot native hook entry — a flat command object. */
interface JetBrainsHookEntry {
  type: "command";
  command: string;
}

/** The shape of a JetBrains Copilot .github/hooks/<connector>.json file. */
interface JetBrainsHooksFile {
  version?: number;
  hooks?: Record<string, JetBrainsHookEntry[]>;
}

/** Raw JetBrains Copilot hook stdin payload (Claude-compatible snake_case fields). */
interface JetBrainsWireInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  workspace_roots?: string[];
  hook_event_name?: string;

  // tool events
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_output?: string;
  error_message?: string;

  // SessionStart
  source?: string;
  // SessionEnd
  reason?: string;
  // UserPromptSubmit
  prompt?: string;
  // PreCompact
  trigger?: string;
  // Stop
  stop_hook_active?: boolean;
  // Notification
  message?: string;

  /** Injected by the entrypoint so the runtime knows which connector to dispatch. */
  connector?: string;
}

export class JetBrainsCopilotAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "JetBrains Copilot";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // JetBrains Copilot's Preview hooks runtime delivers Pre/PostToolUse,
    // PreCompact, and SessionStart (the four events its schema documents) —
    // same surface as VS Code Copilot.
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    // Newer events: the JetBrains Copilot Preview hooks runtime documents no
    // permission-dialog, tool-failure, or subagent lifecycle events, so
    // permissionRequest / postToolUseFailure / subagentStart / subagentStop
    // stay unset — install reports the standard skip-warn for them.
    // Per the JetBrains spec this host is deny/ask-only: a PreToolUse hook
    // CANNOT rewrite tool input, and PostToolUse cannot rewrite tool output.
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: true,
    // MCP is managed via the IDE Settings UI; the only transport that surfaces
    // there is a local stdio server.
    transports: ["stdio"],
    // Content surfaces: JetBrains Copilot consumes the GitHub Copilot .github/
    // files (it has no distinct authoring location), so it is an ALIAS of the
    // vscode-copilot writer for prompt files and Agent Skills. It has no native
    // subagent/chat-mode surface, so subagents stay unsupported (BaseAdapter
    // returns the skip/warn default).
    supportsCommands: true,
    supportsSkills: true,
    supportsSubagents: false,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    // JetBrains Copilot integration is observable through two markers:
    //   • the project hooks tree (<projectDir>/.github/hooks) we write to, and
    //   • our per-connector hooks file specifically.
    // There is no reliable user-profile MCP file to probe (the UI owns it), so
    // detection is project-scoped and keyed on the hooks footprint.
    const githubDir = join(projectDir, ".github");
    const hooksDir = join(githubDir, "hooks");
    const installed = existsSync(hooksDir) || existsSync(githubDir);
    const configPath = hooksDir;
    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope: "project",
      reason: installed
        ? `found JetBrains Copilot hooks tree at ${hooksDir}`
        : `no JetBrains Copilot hooks tree at ${hooksDir}`,
      confidence: installed ? "medium" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  /** Hooks live under the workspace .github tree for both scopes. */
  getConfigDir(ctx: InstallContext): string {
    return join(ctx.projectDir, ".github");
  }

  /**
   * MCP server registration has NO writable file on JetBrains — the IDE owns it
   * behind the Settings UI. We still return a stable path (the hooks file) so the
   * base-adapter `doctor`/`backupSettings` helpers have a sensible target rather
   * than a nonexistent/bogus MCP path. `installServer` never writes here.
   */
  getServerConfigPath(ctx: InstallContext): string {
    return this.getHookConfigPath(ctx);
  }

  /**
   * Hook registration lives in the workspace-discovered .github/hooks tree, which
   * JetBrains Copilot scans for *.json hook files. We write one file per connector
   * so installs/uninstalls never clobber another connector's hooks. Anchored on
   * projectDir for both scopes — .github/hooks is a workspace concept (there is no
   * user-profile equivalent in the Copilot hooks schema).
   */
  getHookConfigPath(ctx: InstallContext): string {
    return join(ctx.projectDir, ".github", "hooks", `${ctx.connector.id}.json`);
  }

  // ── MCP server install / uninstall ───────────────────────────────────────

  /**
   * JetBrains MCP registration is UI-only. We never write a file: a bogus file is
   * ignored at best and corrupts real UI-managed state at worst. Emit a "warn"
   * ChangeRecord that tells the user exactly where to add the server by hand.
   */
  installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    const override = connector.platforms[HOST]?.server;
    if (!connector.server || override === false) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail: connector.server
            ? "server registration disabled for jetbrains-copilot"
            : "connector declares no MCP server",
        },
      ];
    }

    return [
      {
        platform: this.id,
        action: "warn",
        detail:
          `JetBrains Copilot manages MCP servers via the IDE Settings UI — ` +
          `add "${connector.id}" manually under Settings > Tools > GitHub Copilot ` +
          `> MCP > Configure (no file is written here).`,
      },
    ];
  }

  /**
   * Nothing was written for the MCP server, so there is nothing to remove. Mirror
   * the install-time guidance as a "warn" so an uninstall report is honest about
   * the UI-managed entry the user may still want to remove by hand.
   */
  uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (!connector.server || connector.platforms[HOST]?.server === false) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail: "no MCP server was registered for jetbrains-copilot",
        },
      ];
    }
    return [
      {
        platform: this.id,
        action: "warn",
        detail:
          `JetBrains Copilot MCP servers are UI-managed — if "${connector.id}" was ` +
          `added manually, remove it under Settings > Tools > GitHub Copilot > MCP.`,
      },
    ];
  }

  // ── Hook install / uninstall ─────────────────────────────────────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.hooks === false) {
      return [
        { platform: this.id, action: "skip", detail: "hooks disabled for jetbrains-copilot" },
      ];
    }
    if (connector.hookEvents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no hooks" }];
    }

    const hooksPath = this.getHookConfigPath(ctx);
    const file = this.readJson<JetBrainsHooksFile>(hooksPath) ?? {};
    const hooks = (file.hooks ??= {});

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of connector.hookEvents) {
      const jetbrainsEvent = EVENT_MAP[event];
      if (!jetbrainsEvent) {
        // No JetBrains Copilot equivalent for this normalized event — report+skip.
        changes.push({
          platform: this.id,
          action: "warn",
          path: hooksPath,
          detail: `${event} has no JetBrains Copilot hook equivalent — skipped`,
        });
        continue;
      }

      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, event, connector.id);
      // Matchers are IGNORED by JetBrains (all hooks fire on all tools), so we omit
      // the matcher entirely — a flat { type, command } entry.
      const entry: JetBrainsHookEntry = { type: "command", command };

      const bucket = (hooks[jetbrainsEvent] ??= []);
      const existingIdx = bucket.findIndex((e) => this.isOurCommand(e.command, ctx));

      if (existingIdx >= 0) {
        if (JSON.stringify(bucket[existingIdx]) === JSON.stringify(entry)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: hooksPath,
            detail: `hooks.${jetbrainsEvent} already registered`,
          });
          continue;
        }
        bucket[existingIdx] = entry;
        changes.push({
          platform: this.id,
          action: "update",
          path: hooksPath,
          detail: `hooks.${jetbrainsEvent}`,
        });
      } else {
        bucket.push(entry);
        changes.push({
          platform: this.id,
          action: "create",
          path: hooksPath,
          detail: `hooks.${jetbrainsEvent}`,
        });
      }
      mutated = true;
    }

    if (mutated) {
      // The top-level version is REQUIRED — a version-less file is rejected and
      // no hooks fire. Always (re)assert it when we write.
      file.version = JETBRAINS_HOOKS_VERSION;
      this.writeJson(hooksPath, file, ctx.dryRun);
    }
    return changes;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const hooksPath = this.getHookConfigPath(ctx);
    const file = this.readJson<JetBrainsHooksFile>(hooksPath);
    const hooks = file?.hooks;
    if (!file || !hooks) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: hooksPath,
          detail: "no hooks section present",
        },
      ];
    }

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const jetbrainsEvent of Object.keys(hooks)) {
      const bucket = hooks[jetbrainsEvent];
      if (!Array.isArray(bucket)) continue;

      const before = bucket.length;
      // Only strip OUR connector's home-bin commands — never another connector's
      // (isHomeBinHookCommand is id-anchored against a shared-prefix collision).
      const next = bucket.filter((e) => !this.isOurCommand(e.command, ctx));
      const removed = before - next.length;
      if (removed > 0) {
        if (next.length > 0) hooks[jetbrainsEvent] = next;
        else delete hooks[jetbrainsEvent];
        changes.push({
          platform: this.id,
          action: "remove",
          path: hooksPath,
          detail: `hooks.${jetbrainsEvent} (${removed})`,
        });
        mutated = true;
      }
    }

    if (mutated) {
      // The hooks file is connector-OWNED (<connector-id>.json), so when our
      // strip leaves it with NO hooks we must DELETE the whole file rather than
      // rewrite a `{ "hooks": {}, "version": 1 }` shell — an empty shell is an
      // orphan per-connector file that lingers after uninstall. A non-empty
      // result still belongs to us, so we rewrite it as before. dryRun reports
      // the would-be remove without mutating the filesystem.
      if (Object.keys(hooks).length === 0) {
        if (!ctx.dryRun) rmSync(hooksPath, { force: true });
        changes.push({
          platform: this.id,
          action: "remove",
          path: hooksPath,
          detail: "removed empty connector hooks file",
        });
        // Clean up the parent .github/hooks dir only when it is now empty (it is
        // a per-connector tree; leave it in place if other connectors' files
        // remain).
        changes.push(this.removeDirIfEmpty(dirname(hooksPath), ctx.dryRun));
      } else {
        this.writeJson(hooksPath, file, ctx.dryRun);
      }
    }
    if (changes.length === 0) {
      changes.push({
        platform: this.id,
        action: "skip",
        path: hooksPath,
        detail: "no matching hook entries",
      });
    }
    return changes;
  }

  /** True when a hook command references our home binary AND this connector id
   *  (anchored so a shared-prefix id can't collide — see isHomeBinHookCommand). */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Content surfaces: commands / skills ──────────────────────────────────
  // CONTENT-ONLY: pure native-file writers under the workspace .github/ tree
  // ({prompts,skills}). No runtime dispatch, no home-bin pointer, no telemetry
  // wrap. Each method is idempotent (byte-identical → skip) via
  // BaseAdapter.writeContentFile and reversible via removeContentFile. Honors
  // platforms["jetbrains-copilot"] per-surface false to skip.
  //
  // ALIAS of vscode-copilot: JetBrains consumes the GitHub Copilot .github/
  // files and has no distinct authoring location, so the rendered content +
  // paths here are IDENTICAL to the vscode-copilot writer.
  //
  // SHARED .github TREE: vscode-copilot, copilot-cli, and jetbrains-copilot all
  // write under the SAME project <projectDir>/.github tree. The rendered content
  // is identical and idempotent across those connectors, and uninstall here only
  // removes the files THIS connector declared — never another writer's files.
  //
  // SCOPE NOTE: .github is a workspace concept and this adapter is project-
  // scoped (no user-profile .github authoring location exists in the Copilot
  // prompt/skill discovery), so the content root is always the project .github
  // tree — the same dir getConfigDir already anchors on.

  /** Root of the content tree — the project .github tree (see getConfigDir). */
  private contentRootDir(ctx: InstallContext): string {
    return this.getConfigDir(ctx);
  }

  private promptsDir(ctx: InstallContext): string {
    return join(this.contentRootDir(ctx), "prompts");
  }
  private skillsDir(ctx: InstallContext): string {
    return join(this.contentRootDir(ctx), "skills");
  }

  /** Native command file path: <ghDir>/prompts/<name>.prompt.md. */
  private commandPath(ctx: InstallContext, name: string): string {
    return join(this.promptsDir(ctx), `${name}.prompt.md`);
  }
  /** Native skill dir: <ghDir>/skills/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  override installCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.commands === false) {
      return [{ platform: this.id, action: "skip", detail: "commands disabled for jetbrains-copilot" }];
    }
    if (connector.commands.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no commands" }];
    }
    return connector.commands.map((cmd) =>
      this.writeContentFile(
        this.commandPath(ctx, cmd.name),
        this.renderCommand(cmd),
        ctx.dryRun,
      ),
    );
  }

  override uninstallCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.commands.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no commands" }];
    }
    return connector.commands.map((cmd) =>
      this.removeContentFile(this.commandPath(ctx, cmd.name), ctx.dryRun),
    );
  }

  /** Render a Copilot prompt file: md+frontmatter(description, tools, model, argument-hint). */
  private renderCommand(cmd: CommandDef): string {
    const frontmatter: Record<string, unknown> = {};
    if (cmd.description !== undefined) frontmatter.description = cmd.description;
    // Copilot prompt files express tool access as a `tools` array, sourced from
    // the portable tools.allow policy.
    const allow = cmd.tools?.allow;
    if (allow && allow.length > 0) frontmatter.tools = [...allow];
    if (cmd.model !== undefined) frontmatter.model = cmd.model;
    if (cmd.argumentHint !== undefined) frontmatter["argument-hint"] = cmd.argumentHint;
    if (cmd.extra) Object.assign(frontmatter, cmd.extra);
    return this.renderFrontmatterMd(frontmatter, cmd.prompt);
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for jetbrains-copilot" }];
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
   * Render a skill's SKILL.md — the uniform Agent Skills format: frontmatter
   * (name, description + optional model, allowed-tools, disable-model-invocation)
   * + body. Byte-identical to the other .github-sharing connectors so a shared
   * skill folder never thrashes.
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

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const hooksPath = this.getHookConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const hookEvents = ctx.connector.hookEvents;
    const hasServer =
      ctx.connector.server != null &&
      ctx.connector.platforms[HOST]?.server !== false;
    const checks: HealthCheck[] = [
      {
        // MCP cannot be verified from disk — JetBrains owns it behind the UI.
        // BaseAdapter.doctor maps != OK to a hard FAIL, but an unverifiable
        // UI-managed surface must NOT hard-fail doctor (that contradicts the
        // install-time WARN). Return OK with a verify-in-UI detail instead.
        name: `${this.name}: MCP server (UI-managed)`,
        check: () =>
          hasServer
            ? {
                status: "OK",
                detail:
                  "MCP is UI-managed — verify in Settings > Tools > GitHub Copilot > MCP",
              }
            : { status: "OK", detail: "connector declares no MCP server" },
      },
      {
        name: `${this.name}: hook command registered`,
        check: () => {
          if (hookEvents.length === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          const file = this.readJson<JetBrainsHooksFile>(hooksPath);
          if (!file) return { status: "FAIL", detail: `not found: ${hooksPath}` };
          if (file.version !== JETBRAINS_HOOKS_VERSION) {
            return {
              status: "FAIL",
              detail: `${hooksPath} missing required "version": ${JETBRAINS_HOOKS_VERSION} — Copilot rejects it`,
            };
          }
          const registered = Object.values(file.hooks ?? {}).some((entries) =>
            (entries ?? []).some((e) =>
              isHomeBinHookCommand(e.command, homeBin, connectorId),
            ),
          );
          return registered
            ? { status: "OK", detail: "hook command present" }
            : { status: "FAIL", detail: `no hook for ${connectorId} in ${hooksPath}` };
        },
      },
    ];

    // Content-surface checks: only assert presence of the files this connector
    // declares (skip silently for surfaces it never asked for). Subagents are
    // unsupported here, so they are never checked.
    for (const cmd of ctx.connector.commands) {
      const p = this.commandPath(ctx, cmd.name);
      checks.push({
        name: `${this.name}: command ${cmd.name} present`,
        check: () =>
          existsSync(p) ? { status: "OK", detail: p } : { status: "FAIL", detail: `not found: ${p}` },
      });
    }
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

  // ── Runtime: parse JetBrains Copilot stdin JSON → normalized event ────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as JetBrainsWireInput;
    const connectorId = typeof input.connector === "string" ? input.connector : "";
    const sessionId = extractSessionId(input);
    const projectDir = this.getProjectDir(input);

    const base = {
      hostPlatform: HOST,
      connectorId,
      sessionId,
      raw,
      ...(projectDir !== undefined ? { projectDir } : {}),
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
        const toolOutput =
          toolResponseToString(input.tool_response) ??
          input.tool_output ??
          input.error_message;
        const ev: PostToolUseEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          ...(toolOutput !== undefined ? { toolOutput } : {}),
          ...(input.error_message ? { isError: true } : {}),
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
      case "SessionStart": {
        const ev: SessionStartEvent = {
          ...base,
          source: normalizeSessionSource(input.source ?? input.trigger),
        };
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
      case "PermissionRequest":
      case "PostToolUseFailure":
      case "SubagentStart":
      case "SubagentStop": {
        // No JetBrains Copilot analog — its Preview hooks runtime documents no
        // permission-dialog, tool-failure, or subagent lifecycle events.
        // Install already skip-warns these via EVENT_MAP; a runtime dispatch is
        // a mis-route — fail loudly.
        throw new Error(`unsupported jetbrains-copilot hook event: ${String(event)}`);
      }
      default: {
        // Exhaustive guard — every HookEventName is handled above. (JetBrains only
        // delivers the four it declares; the rest are handled defensively so a
        // mis-dispatch stays inert rather than crashing.)
        const _never: never = event;
        throw new Error(`unsupported jetbrains-copilot hook event: ${String(_never)}`);
      }
    }
  }

  /** Resolve the project dir from the wire payload, preferring the explicit cwd. */
  private getProjectDir(input: JetBrainsWireInput): string | undefined {
    return input.cwd ?? input.workspace_roots?.[0] ?? undefined;
  }

  // ── Runtime: normalized response → JetBrains Copilot native hook reply ────

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const hookEventName = event;
    const decision = response.decision ?? "allow";

    // deny → block the action with a reason (exit 0; JSON carries the decision).
    // JetBrains Copilot is Claude-compatible: the decision lives inside
    // `hookSpecificOutput`, keyed by the PascalCase event name.
    if (decision === "deny") {
      return this.stdout({
        hookSpecificOutput: {
          hookEventName,
          permissionDecision: "deny",
          permissionDecisionReason: response.reason ?? "Blocked by hook",
        },
      });
    }

    // ask → prompt the user to confirm.
    if (decision === "ask") {
      return this.stdout({
        hookSpecificOutput: {
          hookEventName,
          permissionDecision: "ask",
          permissionDecisionReason:
            response.reason ?? "Confirmation required by hook",
        },
      });
    }

    // modify → unsupported on JetBrains (canModifyArgs:false): a PreToolUse hook
    // cannot rewrite tool input here, so degrade to allow rather than emit an
    // updatedInput the host will ignore.

    // context → inject soft guidance (also the SessionStart context path).
    if (decision === "context" && response.additionalContext) {
      return this.stdout({
        hookSpecificOutput: { hookEventName, additionalContext: response.additionalContext },
      });
    }

    // allow / void / modify-degradation / unsupported → pass through with exit 0.
    return { exitCode: 0 };
  }

  private stdout(payload: unknown): HookReply {
    return { exitCode: 0, stdout: JSON.stringify(payload) };
  }
}

/**
 * Extract a stable session id from a JetBrains Copilot wire payload. Priority
 * mirrors the Claude-compatible wire: transcript UUID > session_id > "" (the
 * framework uses "" when no id is available — no ppid fabrication here).
 */
function extractSessionId(input: JetBrainsWireInput): string {
  if (typeof input.transcript_path === "string") {
    const m = input.transcript_path.match(/([a-f0-9-]{36})\.jsonl$/);
    if (m && m[1]) return m[1];
  }
  if (typeof input.session_id === "string" && input.session_id !== "") {
    return input.session_id;
  }
  return "";
}

/** Coerce a Claude-compatible PostToolUse `tool_response` into a string. */
function toolResponseToString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeSessionSource(source: string | undefined): SessionStartEvent["source"] {
  switch (source) {
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

export const adapter = new JetBrainsCopilotAdapter();
export default adapter;
