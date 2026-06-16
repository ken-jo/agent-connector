/**
 * adapters/cline — Cline (VS Code extension) platform adapter.
 *
 * Cline (`saoudrizwan.claude-dev`) is the most-installed AI coding VS Code
 * extension and the PARENT that Roo Code (`rooveterinaryinc.roo-cline`) and Kilo
 * Code (`kilocode.kilo-code`) forked. From agent-connector's perspective it is an
 * **mcp-only** host: it exposes no lifecycle hook / event-callback plugin API, so
 * MCP server registration is the only runtime surface we install and every hook
 * capability is reported false. This mirrors the Roo Code adapter (a Cline fork).
 *
 * SCOPE NOTE: this adapter targets the VS Code EXTENSION, NOT the newer Cline
 * CLI/SDK (which would live under ~/.cline and is a separate future adapter).
 *
 * MCP config (cline/cline `main`, disk.ts GlobalFileNames):
 *   - USER SCOPE ONLY → <vscodeUserDir>/globalStorage/saoudrizwan.claude-dev/
 *                       settings/cline_mcp_settings.json   (root key "mcpServers").
 *   There is NO project-scope MCP file — the VS Code extension only reads this
 *   single global path (so, unlike roo-code, there is no `.roo/mcp.json` branch
 *   and no legacy-filename probe: `cline_mcp_settings.json` is Cline's canonical,
 *   never-renamed settings file).
 *   Per-server shape: stdio { command, args?, env?, disabled? }; remote
 *   { url, type:"sse"|"streamableHttp" }. An untyped remote url defaults to sse
 *   in Cline, so we ALWAYS write `type` explicitly for remote entries.
 *
 * VS Code user-dir resolution (cross-OS) — reused VERBATIM from roo-code:
 *   - macOS   → ~/Library/Application Support/Code/User
 *   - Linux   → ~/.config/Code/User
 *   - Windows → %APPDATA%/Code/User  (falls back to ~/AppData/Roaming/Code/User)
 *
 * Memory / commands / skills (docs.cline.bot) — the `.clinerules` content tree:
 *   - memory   → project <projectDir>/.clinerules/agent-connector.md (DIRECTORY
 *                form); user ~/Documents/Cline/Rules/agent-connector.md. Markdown.
 *   - command  → project <projectDir>/.clinerules/workflows/<name>.md; user
 *                ~/Documents/Cline/Workflows/<name>.md. (Cline "Workflows" are the
 *                slash-command equivalent.) Plain markdown (frontmatter + body).
 *   - skill    → project <projectDir>/.clinerules/skills/<name>/SKILL.md;
 *                user ~/.cline/skills/<name>/SKILL.md (homedir/.cline, cross-OS)
 *                (SKILL.md-in-named-dir, YAML frontmatter; both scopes are
 *                documented in cline/cline docs/customization/skills.mdx).
 *
 * READ-ONLY interop (NEVER written under this adapter): Cline also reads
 * `.cursor/rules`, `AGENTS.md`, `.claude/skills`, `.agents/skills` for cross-tool
 * interop. Those are other tools' surfaces — AC owns only the `.clinerules`/
 * Documents-dir paths above.
 *
 * Env interpolation: Cline's settings file documents no native `${env:VAR}`
 * token, so every `${env:VAR}` reference is resolved to a literal at install time
 * (the no-native-token path, same as roo-code / gemini-cli).
 *
 * The hook "config path" is the SAME MCP settings file (there is no hook file),
 * so the generic doctor/backup behave sensibly.
 */

import { existsSync, statSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";

import { BaseAdapter } from "../base.js";
import type { Adapter, InstallContext, MemoryTarget } from "../spi.js";
import type {
  ChangeRecord,
  CommandDef,
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
import {
  buildServeWrapperCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "cline";
const MCP_ROOT_KEY = "mcpServers";

/** Cline extension id → its VS Code globalStorage folder. */
const CLINE_EXTENSION_ID = "saoudrizwan.claude-dev";
/** User-scope MCP settings filename — Cline's canonical, never-renamed name. */
const MCP_SETTINGS_FILE = "cline_mcp_settings.json";

/**
 * Native MCP server entry shapes Cline accepts under `mcpServers`. We write the
 * minimal stdio shape { command, args?, env?, disabled }; for remote servers we
 * ALWAYS emit `type` (Cline defaults an untyped url to sse, so the type must be
 * explicit to register a streamable-http server).
 */
interface ClineStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled: boolean;
}
interface ClineRemoteServer {
  url: string;
  type: "sse" | "streamableHttp";
  headers?: Record<string, string>;
  disabled: boolean;
}

/**
 * Resolve the cross-OS VS Code per-user data directory (the "User" folder that
 * contains `globalStorage`). REUSED VERBATIM from the roo-code adapter — Cline
 * is its parent and the published extension lives under the same stable "Code"
 * tree. See module header for the per-platform mapping.
 */
function vscodeUserDir(): string {
  const home = homedir();
  switch (osPlatform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Code", "User");
    case "win32": {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(appData, "Code", "User");
    }
    default:
      // Linux / other POSIX: XDG-style config dir.
      return join(home, ".config", "Code", "User");
  }
}

/**
 * Resolve the cross-OS user Documents directory. Cline's user-scope memory +
 * workflows live under `<documentsDir>/Cline/{Rules,Workflows}`.
 *
 * CAVEAT (documented, honest approximation — NOT a fabricated path): on Windows
 * the real Cline uses the MyDocuments known-folder, which a user CAN relocate
 * (we do not read the registry to discover a moved folder). `~/Documents` is the
 * Windows default and covers the common case. POSIX additionally honors
 * `XDG_DOCUMENTS_DIR` when set. The path SHAPE `Documents/Cline/{Rules,Workflows}`
 * is source-verified against docs.cline.bot.
 */
function documentsDir(): string {
  if (osPlatform() === "win32") {
    return join(homedir(), "Documents");
  }
  const xdg = process.env.XDG_DOCUMENTS_DIR;
  return xdg && xdg.trim() !== "" ? xdg : join(homedir(), "Documents");
}

export class ClineAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Cline";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: the `.clinerules` content tree (project
    // <projectDir>/.clinerules/agent-connector.md; user
    // ~/Documents/Cline/Rules/agent-connector.md) — overrides memoryTargets()
    // below (Cline does NOT use the AGENTS.md base default for its OWN file).
    supportsMemory: true,
    // Cline has no lifecycle hook system — every hook capability is false.
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
    // Cline registers stdio, SSE, and Streamable HTTP MCP servers.
    transports: ["stdio", "sse", "http"],
    // Content surfaces: Workflows (the slash-command equivalent) and AgentSkills.
    //   command → <clineRulesDir>/workflows/<name>.md  (md + optional frontmatter)
    //   skill   → <projectDir>/.clinerules/skills/<name>/SKILL.md (project only)
    supportsCommands: true,
    supportsSkills: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userSettings = this.userSettingsPath();
    const userExtDir = join(
      vscodeUserDir(),
      "globalStorage",
      CLINE_EXTENSION_ID,
    );
    // Project marker: the `.clinerules` content root (file OR directory form).
    const projectRules = join(projectDir, ".clinerules");

    const userMatch = existsSync(userSettings) || existsSync(userExtDir);
    const projectMatch = existsSync(projectRules);
    const installed = userMatch || projectMatch;

    // Prefer the user scope/path when present; otherwise surface the project one.
    const scope = userMatch || !projectMatch ? "user" : "project";
    const configPath = scope === "user" ? userSettings : projectRules;
    const reason = installed
      ? userMatch
        ? `found Cline globalStorage under ${userExtDir}`
        : `found Cline project rules at ${projectRules}`
      : `no Cline config at ${userExtDir} or ${projectRules}`;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  /** Absolute path to the user-scope MCP settings file (VS Code globalStorage). */
  private userSettingsPath(): string {
    return join(
      vscodeUserDir(),
      "globalStorage",
      CLINE_EXTENSION_ID,
      "settings",
      MCP_SETTINGS_FILE,
    );
  }

  /**
   * MCP config is USER-SCOPE ONLY (the VS Code ext reads one global file). At
   * project scope we still return the global path so a project-scope install
   * lands the server where Cline actually reads it.
   */
  getConfigDir(_ctx: InstallContext): string {
    return join(
      vscodeUserDir(),
      "globalStorage",
      CLINE_EXTENSION_ID,
      "settings",
    );
  }

  getServerConfigPath(_ctx: InstallContext): string {
    return this.userSettingsPath();
  }

  /**
   * Cline has no hook file — hooks are not a thing here. The hook "config path"
   * is the same MCP settings file so the generic doctor/backup behave sensibly.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return this.getServerConfigPath(ctx);
  }

  // ── Memory surface: the `.clinerules` content tree ───────────────────────
  // Cline uses .clinerules (NOT AGENTS.md) for its OWN rules, so this override
  // replaces the AGENTS.md base default entirely:
  //   project → <projectDir>/.clinerules/agent-connector.md  (DIRECTORY form)
  //   user    → ~/Documents/Cline/Rules/agent-connector.md
  // When `.clinerules` exists as a single FILE (the legacy single-file form),
  // we must NOT create a `.clinerules/agent-connector.md` underneath it — that
  // would throw ENOTDIR — so we return [] here and installMemory() emits a
  // precise skip-warn (see below) rather than clobbering the user's file.
  protected override memoryTargets(ctx: InstallContext): MemoryTarget[] {
    // An explicit platforms[cline].memory.path override wins (escape hatch).
    if (this.memoryOverride(ctx)?.path) return super.memoryTargets(ctx);
    if (ctx.scope === "project") {
      if (this.clineRulesIsFile(ctx.projectDir)) return [];
      return [
        {
          path: join(ctx.projectDir, ".clinerules", "agent-connector.md"),
          reason: "cline project rules dir (.clinerules/; agent-connector-owned file)",
        },
      ];
    }
    if (ctx.scope === "user") {
      return [
        {
          path: join(documentsDir(), "Cline", "Rules", "agent-connector.md"),
          reason: "cline user rules dir (~/Documents/Cline/Rules; agent-connector-owned file)",
        },
      ];
    }
    return [];
  }

  /**
   * Override installMemory ONLY to surface a precise warn when `.clinerules`
   * exists as a single FILE at project scope (so memoryTargets() returned []):
   * we never clobber the user's single-file rules. All other behavior delegates
   * to the base implementation.
   */
  override installMemory(ctx: InstallContext): ChangeRecord[] {
    if (
      ctx.scope === "project" &&
      !this.memoryOverride(ctx)?.path &&
      (ctx.connector.memory ?? []).length > 0 &&
      ctx.connector.platforms[this.id]?.memory !== false &&
      this.clineRulesIsFile(ctx.projectDir)
    ) {
      return [
        {
          platform: this.id,
          action: "warn",
          path: join(ctx.projectDir, ".clinerules"),
          detail:
            "existing .clinerules is a single file (legacy form); left untouched — " +
            "convert it to a .clinerules/ directory to receive agent-connector memory",
        },
      ];
    }
    return super.installMemory(ctx);
  }

  /** True when `<dir>/.clinerules` exists and is a regular FILE (not a directory). */
  private clineRulesIsFile(dir: string): boolean {
    const p = join(dir, ".clinerules");
    if (!existsSync(p)) return false;
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
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
            ? "server registration disabled for cline"
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

  /** Render a normalized ServerDef into Cline's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): ClineStdioServer | ClineRemoteServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

      // Transparent telemetry wrapping: route the real command through
      // `<homeBin> serve --connector <id> -- <command> <args...>`.
      if (shouldWrapForTelemetry(server, ctx.connector.telemetry)) {
        const wrapped = buildServeWrapperCommand(
          ctx.homeBinPath,
          ctx.connector.id,
          command,
          args,
          ctx.scope,
          this.id,
        );
        command = wrapped.command;
        args = wrapped.args;
      }

      // Cline documents no native interpolation token, so resolve every
      // ${env:VAR} to a literal at install time.
      const entry: ClineStdioServer = {
        command: resolveEnvRefsDeep(command),
        // Honor the per-call server's enabled flag — a server marked
        // enabled:false installs disabled (mirror roo-code).
        disabled: server.enabled === false,
      };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // sse / http (and any other remote transport) — Cline registers a URL. We
    // ALWAYS emit `type` (an untyped url defaults to sse in Cline, so streamable
    // http must be explicit): map our "http" transport to "streamableHttp".
    const entry: ClineRemoteServer = {
      url: resolveEnvRefsDeep(server.url ?? ""),
      type: transport === "http" ? "streamableHttp" : "sse",
      disabled: server.enabled === false,
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Cline documents no native interpolation token, so
   * resolve `${env:VAR}` references to literals at install time.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hooks (unavailable — Cline is mcp-only) ──────────────────────────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Cline is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Cline is mcp-only)",
      },
    ];
  }

  // ── Content surfaces: commands (Workflows) / skills ──────────────────────
  // CONTENT-ONLY: pure native-file writers. No runtime dispatch, no home-bin
  // pointer, no telemetry wrap. Each method is idempotent (byte-identical →
  // skip) via writeContentFile and reversible via removeContentFile. Honors
  // platforms["cline"] per-surface false to skip.
  //
  // Native locations (the `.clinerules` content tree + the Documents-dir):
  //   command → project <projectDir>/.clinerules/workflows/<name>.md
  //             user    ~/Documents/Cline/Workflows/<name>.md
  //   skill   → project <projectDir>/.clinerules/skills/<name>/SKILL.md
  //             user    (undocumented for the VS Code ext → skip-warn)

  /** The project-scope `.clinerules` content root. */
  private clineRulesDir(ctx: InstallContext): string {
    return join(ctx.projectDir, ".clinerules");
  }

  private commandPath(ctx: InstallContext, name: string): string {
    return ctx.scope === "project"
      ? join(this.clineRulesDir(ctx), "workflows", `${name}.md`)
      : join(documentsDir(), "Cline", "Workflows", `${name}.md`);
  }

  private skillDir(ctx: InstallContext, name: string): string {
    // User/global scope → ~/.cline/skills/<name> (homedir/.cline, cross-OS via
    // homedir(); primary-verified cline/cline docs/customization/skills.mdx).
    // Project scope → <projectDir>/.clinerules/skills/<name> (a documented
    // project skills location alongside .cline/skills; AC owns the .clinerules tree).
    if (ctx.scope !== "project") {
      return join(homedir(), ".cline", "skills", name);
    }
    return join(this.clineRulesDir(ctx), "skills", name);
  }

  // ── Commands (Workflows — both scopes) ────────────────────────────────────

  override installCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[this.id]?.commands === false) {
      return [{ platform: this.id, action: "skip", detail: "commands disabled for cline" }];
    }
    if (connector.commands.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no commands" }];
    }
    return connector.commands.map((cmd) =>
      this.writeContentFile(this.commandPath(ctx, cmd.name), this.renderCommand(cmd), ctx.dryRun),
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

  /** Render a command (Cline Workflow) to md + optional frontmatter. */
  private renderCommand(cmd: CommandDef): string {
    const frontmatter: Record<string, unknown> = {};
    if (cmd.description !== undefined) frontmatter.description = cmd.description;
    if (cmd.argumentHint !== undefined) frontmatter["argument-hint"] = cmd.argumentHint;
    if (cmd.extra) Object.assign(frontmatter, cmd.extra);
    return this.renderFrontmatterMd(frontmatter, cmd.prompt);
  }

  // ── Skills (project .clinerules/skills + user ~/.cline/skills) ────────────

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[this.id]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for cline" }];
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

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const mcpPath = this.getServerConfigPath(ctx);
    const connectorId = ctx.connector.id;
    return [
      {
        name: `${this.name}: MCP settings present`,
        check: () =>
          existsSync(mcpPath)
            ? { status: "OK", detail: mcpPath }
            : { status: "FAIL", detail: `not found: ${mcpPath}` },
      },
      {
        name: `${this.name}: server entry registered`,
        check: () => {
          // Only assert what the connector declares: a server-less connector —
          // e.g. a catalog-only bundle of skills/commands — never writes an
          // mcpServers entry, so its absence is healthy.
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const cfg = this.readJson<{ [k: string]: Record<string, unknown> }>(mcpPath);
          const bucket = cfg?.[MCP_ROOT_KEY];
          if (!cfg || !bucket) {
            return { status: "FAIL", detail: `no ${MCP_ROOT_KEY} in ${mcpPath}` };
          }
          return connectorId in bucket
            ? { status: "OK", detail: `${MCP_ROOT_KEY}.${connectorId} present` }
            : {
                status: "FAIL",
                detail: `no ${MCP_ROOT_KEY}.${connectorId} in ${mcpPath}`,
              };
        },
      },
    ];
  }
}

export const adapter = new ClineAdapter();
export default adapter;
