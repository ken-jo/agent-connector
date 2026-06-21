/**
 * adapters/zed — Zed editor platform adapter for agent-connector.
 *
 * Zed is an **mcp-only** host: it is an IDE, not a CLI with a hook pipeline, so
 * there is NO lifecycle hook system. MCP ("context servers") is the only
 * integration path, so this adapter installs only the MCP server and reports
 * hooks as unavailable — like Warp, it exercises the `mcp-only` paradigm.
 *
 * MCP config (one JSON-with-comments settings file, NOT a dedicated MCP file):
 *   - user scope → settings.json under Zed's OS-native config dir (Rust
 *     `dirs::config_dir()`):
 *       • Windows: %APPDATA%\Zed\settings.json  (Roaming, NOT %LOCALAPPDATA%)
 *       • macOS / Linux: ~/.config/zed/settings.json
 *   - project scope → <projectDir>/.zed/settings.json
 *   Root key is "context_servers" (NOT "mcpServers"). The same file holds the
 *   (non-existent) hook config — there is no separate hook file here.
 *
 * MERGE CONTRACT: Zed's settings.json is a large user-owned IDE config. We read
 * the whole file, set ONLY context_servers[<id>], and write it back — every
 * other top-level key and sibling context server is preserved. (Zed accepts
 * JSONC; we WRITE plain JSON, mirroring the other JSON-config adapters.)
 *
 * ENTRY SHAPE QUIRK (verified against context-mode's proven Zed adapter +
 * zed-industries/zed crates/settings_content/src/project.rs): Zed's
 * context_servers Stdio variant flattens ContextServerCommand and renames its
 * `path` field to the JSON key `command`. The accepted shape is therefore a
 * FLAT entry: { "command": "<exe>", "args": [...], "env": {...} }. The nested
 * { command: { path, args } } form fails to deserialize under Zed's
 * #[serde(untagged)] enum and is silently dropped (the server never loads).
 *
 * Zed documents no native ${env:VAR} interpolation token for context_servers,
 * so env refs are resolved to literals at install time (the no-native-token
 * path, same as Warp).
 *
 * Skills surface: Zed reads SKILL.md files from:
 *   project scope → <projectDir>/.agents/skills/<name>/SKILL.md
 *   user scope    → ~/.agents/skills/<name>/SKILL.md
 *
 * Actions surface: Zed reads `tasks.json` — a JSON ARRAY of tasks
 * `{ label, command, args?, … }` spawned in its integrated terminal and surfaced
 * in the command palette (`task: spawn`) / bindable (zed.dev/docs/tasks):
 *   user scope    → ~/.config/zed/tasks.json (%APPDATA%\Zed on Windows — the
 *                   SAME OS-native config dir as settings.json)
 *   project scope → <projectDir>/.zed/tasks.json
 * For each AC action we add ONE owned task whose `command` execs the home-bin
 * action verb. Zed runs `command` in a shell ("tasks act just like your shell"),
 * so the full `<homeBin> action zed <id> --connector <id>` line is a HEADLESS
 * exec (unlike Warp's paste-into-input semantics). tasks.json is a user-owned
 * ARRAY, so we array-merge: set-if-absent, keyed on OUR action command (the
 * isHomeBinActionCommand ownership predicate), idempotent, and uninstall removes
 * ONLY our entries — every foreign task survives.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BaseAdapter, type ActionTrigger } from "../base.js";
import type { Adapter, InstallContext, MemoryTarget } from "../spi.js";
import type {
  ChangeRecord,
  DetectedPlatform,
  HealthCheck,
  HookParadigm,
  PlatformCapabilities,
  PlatformId,
  ServerDef,
  SkillDef,
  Transport,
} from "../../core/types.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import { roamingAppData } from "../../core/host-paths.js";
import {
  buildWrappedStdio,
  isHomeBinActionCommand,
} from "../../core/spawn.js";
import { renderSkillMd } from "../claude-code/render.js";

const HOST: PlatformId = "zed";
const MCP_ROOT_KEY = "context_servers";

/**
 * Zed's context_servers Stdio entry. FLAT shape — `command` is a string, NOT a
 * nested { path, args } object (see file header). Remote transports are
 * represented as a URL-bearing entry.
 */
interface ZedStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
interface ZedHttpServer {
  url: string;
  headers?: Record<string, string>;
}

/**
 * One Zed task entry in tasks.json (zed.dev/docs/tasks). Zed accepts many
 * optional keys (env, cwd, reveal, …); we write only the minimal owned trio
 * { label, command } and preserve every key on FOREIGN entries untouched.
 */
interface ZedTask {
  label: string;
  command: string;
  [key: string]: unknown;
}

export class ZedAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Zed";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block. Zed's project rules file
    // is FIRST-MATCH across nine candidates — memoryTargets below probes that
    // order and writes into the file Zed will actually read; user scope is the
    // personal ~/.config/zed/AGENTS.md (%APPDATA%\Zed on Windows, base map).
    supportsMemory: true,
    // Zed has no lifecycle hook system — every hook capability is false.
    preToolUse: false,
    postToolUse: false,
    preCompact: false,
    sessionStart: false,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: false,
    // Zed registers stdio context servers; remote URLs are also accepted.
    transports: ["stdio", "sse", "http"],
    // Skills: Zed reads SKILL.md from .agents/skills/<name>/SKILL.md (project)
    // and ~/.agents/skills/<name>/SKILL.md (user).
    supportsSkills: true,
    // Actions: Zed reads tasks.json (a JSON ARRAY of { label, command, args? })
    // spawned in its integrated terminal + surfaced in the command palette
    // (zed.dev/docs/tasks). Each AC action becomes one owned task whose `command`
    // execs the home-bin action verb — a headless exec (zed runs it in a shell).
    // user → ~/.config/zed/tasks.json; project → <projectDir>/.zed/tasks.json.
    supportsActions: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = this.userConfigDir();
    const userSettings = this.userSettingsPath();
    const projDir = join(projectDir, ".zed");
    const projSettings = join(projDir, "settings.json");

    const userInstalled = existsSync(userDir) || existsSync(userSettings);
    const projInstalled = existsSync(projDir) || existsSync(projSettings);
    const installed = userInstalled || projInstalled;
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projSettings : userSettings;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? `found Zed config (${scope}) at ${configPath}`
        : `no Zed config at ${userSettings} or ${projSettings}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".zed")
      : this.userConfigDir();
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "settings.json");
  }

  /**
   * Zed has no hook file — hooks are not a thing here. The hook "config path"
   * is the same settings.json so the generic doctor/backup behave sensibly.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return this.getServerConfigPath(ctx);
  }

  /**
   * Zed's user config dir is OS-native (Rust `dirs::config_dir()`), NOT a
   * uniform ~/.config:
   *   - Windows: %APPDATA%\Zed  (Roaming, NOT Local/%LOCALAPPDATA%)
   *   - macOS / Linux: ~/.config/zed
   */
  private userConfigDir(): string {
    if (process.platform === "win32") {
      return join(roamingAppData(), "Zed");
    }
    return join(homedir(), ".config", "zed");
  }

  private userSettingsPath(): string {
    return join(this.userConfigDir(), "settings.json");
  }

  // ── Memory surface: first-match project rules probe ─────────────────────
  /**
   * Zed reads exactly ONE project rules file — the FIRST existing of these
   * worktree-root candidates (zed docs/src/ai/instructions.md order). A block
   * in AGENTS.md is silently ignored when e.g. `.cursorrules` exists, so the
   * probe targets the file Zed will actually pick; AGENTS.md is created only
   * when nothing shadows it.
   */
  private static readonly PROJECT_RULES_PROBE_ORDER = [
    ".rules",
    ".cursorrules",
    ".windsurfrules",
    ".clinerules",
    join(".github", "copilot-instructions.md"),
    "AGENT.md",
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
  ];

  protected override memoryTargets(ctx: InstallContext): MemoryTarget[] {
    if (this.memoryOverride(ctx)?.path || ctx.scope !== "project") {
      return super.memoryTargets(ctx); // user scope: personal AGENTS.md (base map)
    }
    for (const rel of ZedAdapter.PROJECT_RULES_PROBE_ORDER) {
      const candidate = join(ctx.projectDir, rel);
      if (existsSync(candidate)) {
        return [
          {
            path: candidate,
            reason: `zed first-match project rules file (${rel} shadows later candidates)`,
          },
        ];
      }
    }
    return [
      {
        path: join(ctx.projectDir, "AGENTS.md"),
        reason: "AGENTS.md (created; no zed first-match rules file present)",
      },
    ];
  }

  // ── MCP server install / uninstall ───────────────────────────────────────

  installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    const override = connector.platforms[HOST]?.server;
    if (!connector.server || override === false) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail: connector.server
            ? "server registration disabled for zed"
            : "connector declares no MCP server",
        },
      ];
    }

    // Shallow-merge any per-platform server override into the base ServerDef.
    const server: ServerDef =
      override && typeof override === "object"
        ? { ...connector.server, ...override }
        : connector.server;

    const serverPath = this.getServerConfigPath(ctx);
    const entry = this.renderServerEntry(ctx, server);

    // upsertServerInJson reads the WHOLE settings file, sets only
    // context_servers[<id>], and writes it back — preserving every other
    // top-level key and sibling context server (the merge contract).
    return [
      this.upsertServerInJson(serverPath, MCP_ROOT_KEY, connector.id, entry, ctx.dryRun),
    ];
  }

  uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const serverPath = this.getServerConfigPath(ctx);
    return [
      this.removeServerFromJson(serverPath, MCP_ROOT_KEY, ctx.connector.id, ctx.dryRun),
    ];
  }

  /** Render a normalized ServerDef into Zed's native context_servers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): ZedStdioServer | ZedHttpServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

      // Transparent telemetry wrapping: route the real command through
      // `<homeBin> serve --connector <id> -- <command> <args...>`.
      ({ command, args } = buildWrappedStdio(ctx, server, this.id, command, args));

      // Zed has no documented native interpolation token, so resolve every
      // ${env:VAR} to a literal at install time.
      // FLAT shape: `command` is a string, never a nested { path, args }.
      const entry: ZedStdioServer = { command: resolveEnvRefsDeep(command) };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // sse / http (and any other remote transport) — Zed registers a URL.
    const entry: ZedHttpServer = { url: resolveEnvRefsDeep(server.url ?? "") };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Zed documents no native interpolation token, so
   * resolve `${env:VAR}` references to literals at install time.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Skills surface ───────────────────────────────────────────────────────
  // Zed reads SKILL.md files from:
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
      return [{ platform: this.id, action: "skip", detail: "skills disabled for zed" }];
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
      changes.push(this.removeContentFile(join(dir, "SKILL.md"), ctx.dryRun));
      for (const rel of Object.keys(skill.resources ?? {})) {
        const target = this.resolveWithin(dir, rel);
        if (target === null) continue;
        changes.push(this.removeContentFile(target, ctx.dryRun));
      }
      changes.push(this.removeDirIfEmpty(dir, ctx.dryRun));
    }
    return changes;
  }

  private renderSkill(skill: SkillDef): string {
    return renderSkillMd(skill);
  }

  // ── Action surface (owned entries array-merged into tasks.json) ───────────
  // Zed reads tasks.json (zed.dev/docs/tasks): a JSON ARRAY of tasks
  // `{ label, command, args? }` spawned in the integrated terminal + invocable
  // from the command palette (`task: spawn`). Per AC action we add ONE task
  // whose `command` execs the home-bin action verb. Zed runs `command` in a
  // shell, so this is a HEADLESS exec (not Warp's paste-into-input).
  //
  // OWNERSHIP: tasks.json is a USER-OWNED array, so we never clobber it. We
  // read the whole array, upsert only OUR tasks (identity = isHomeBinActionCommand
  // on `command`, anchored to this connector id so a sibling connector's tasks
  // are foreign), and write back. Idempotent (byte-identical entry → skip).
  // Uninstall filters out ONLY our entries, leaving every foreign task intact.

  /** tasks.json path: <configDir>/tasks.json (~/.config/zed | <projectDir>/.zed). */
  private tasksPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "tasks.json");
  }

  /** Render the owned task entry: minimal { label, command }. */
  private renderTask(trigger: ActionTrigger): ZedTask {
    return { label: trigger.label, command: trigger.command };
  }

  override installActions(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    if (connector.platforms[HOST]?.actions === false) {
      return [{ platform: this.id, action: "skip", detail: "actions disabled for zed" }];
    }
    const triggers = this.actionTriggers(ctx);
    if (triggers.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no actions" }];
    }

    const path = this.tasksPath(ctx);
    const symlink = this.symlinkPathWarning(path);
    if (symlink) return [symlink];

    // Overwrite guard: a present-but-unparseable tasks.json must never be blanked
    // (symmetric with the settings.json merge contract — see review-fixes tests).
    if (this.isPresentButUnparseable(path)) {
      return [
        {
          platform: this.id,
          action: "warn",
          path,
          detail: `${path} is present but not parseable as JSON; left untouched (fix it, then re-run)`,
        },
      ];
    }

    // tasks.json IS a top-level array. A null parse means "absent" (create
    // fresh); a present non-array value was hand-edited to the wrong shape, so
    // warn-skip rather than clobber it (mirrors continue's mcpServers guard).
    const raw = this.readJson<unknown>(path);
    if (raw !== null && !Array.isArray(raw)) {
      return [
        {
          platform: this.id,
          action: "warn",
          path,
          detail: `${path} is not a JSON array of tasks; left untouched (fix it, then re-run)`,
        },
      ];
    }
    const list = (raw ?? []) as ZedTask[];

    const changes: ChangeRecord[] = [];
    let mutated = false;
    for (const trigger of triggers) {
      const entry = this.renderTask(trigger);
      // Identity is OUR action command (anchored to this connector id), NOT the
      // label — a user could relabel. Match the SPECIFIC action by its command,
      // which is unique per action id (one slot per action).
      const slot = list.findIndex(
        (t) => this.isOurTask(t, ctx) && t.command === entry.command,
      );
      if (slot < 0) {
        list.push(entry);
        mutated = true;
        changes.push({ platform: this.id, action: "create", path, detail: `tasks.json [${trigger.id}]` });
      } else if (JSON.stringify(list[slot]) === JSON.stringify(entry)) {
        changes.push({ platform: this.id, action: "skip", path, detail: `tasks.json [${trigger.id}]` });
      } else {
        list[slot] = entry;
        mutated = true;
        changes.push({ platform: this.id, action: "update", path, detail: `tasks.json [${trigger.id}]` });
      }
    }

    if (mutated && !dryRun) this.writeJson(path, list);
    return changes;
  }

  override uninstallActions(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    if (connector.actions.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no actions" }];
    }

    const path = this.tasksPath(ctx);
    const raw = this.readJson<unknown>(path);
    if (raw === null || !Array.isArray(raw)) {
      return [{ platform: this.id, action: "skip", detail: "tasks.json absent or not an array" }];
    }

    const list = raw as ZedTask[];
    const kept = list.filter((t) => !this.isOurTask(t, ctx));
    if (kept.length === list.length) {
      return [{ platform: this.id, action: "skip", detail: "no owned tasks in tasks.json" }];
    }
    if (!dryRun) this.writeJson(path, kept);
    return [
      {
        platform: this.id,
        action: "remove",
        path,
        detail: `tasks.json (${list.length - kept.length} owned task(s) removed)`,
      },
    ];
  }

  /**
   * True when a task entry is OURS — its `command` is the home-bin action verb
   * for exactly this connector id (anchored so a shared-prefix id can't collide,
   * and the ` action ` verb so a future hook/serve task is never misread).
   */
  private isOurTask(task: ZedTask | undefined, ctx: InstallContext): boolean {
    return isHomeBinActionCommand(task?.command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Hooks (unavailable — Zed is mcp-only) ────────────────────────────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Zed is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Zed is mcp-only)",
      },
    ];
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const settingsPath = this.getServerConfigPath(ctx);
    const connectorId = ctx.connector.id;
    return [
      {
        name: `${this.name}: settings.json present`,
        check: () =>
          existsSync(settingsPath)
            ? { status: "OK", detail: settingsPath }
            : { status: "FAIL", detail: `not found: ${settingsPath}` },
      },
      {
        name: `${this.name}: context server entry registered`,
        check: () => {
          // Only assert what the connector declares: a server-less connector —
          // e.g. a catalog-only bundle of agents/skills/commands — never writes
          // a context_servers entry, so its absence is healthy.
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const cfg = this.readJson<{ [k: string]: Record<string, unknown> }>(settingsPath);
          const bucket = cfg?.[MCP_ROOT_KEY];
          if (!cfg || !bucket) {
            return { status: "FAIL", detail: `no ${MCP_ROOT_KEY} in ${settingsPath}` };
          }
          return connectorId in bucket
            ? { status: "OK", detail: `${MCP_ROOT_KEY}.${connectorId} present` }
            : {
                status: "FAIL",
                detail: `no ${MCP_ROOT_KEY}.${connectorId} in ${settingsPath}`,
              };
        },
      },
    ];
  }
}

export const adapter = new ZedAdapter();
export default adapter;
