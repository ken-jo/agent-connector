/**
 * adapters/kilo — Kilo Code (VS Code extension) platform adapter.
 *
 * Kilo Code (`kilocode.kilo-code`) is a Roo/Cline-fork VS Code extension that
 * as of vsix 7.x was REBUILT on the Kilo CLI server and shares ONE backend with
 * the Kilo CLI (adapter id "kilo-cli"). Paradigm: **ts-plugin** (same plugin
 * layer the CLI uses).
 *
 * MCP config (vsix 7.3.28 — delegated to the kilo backend):
 *   - user scope    → ~/.config/kilo/kilo.json   (XDG: $XDG_CONFIG_HOME/kilo)
 *   - project scope → <projectDir>/.kilo/kilo.json
 *   Both are JSON, root key **"mcp"**, entry shape
 *     { type:"local", command:[exe,...args], environment:{} }  (array command).
 *   The legacy globalStorage `<vscodeUserDir>/globalStorage/kilocode.kilo-code/
 *   settings/mcp_settings.json` (root "mcpServers") is MIGRATION-ONLY in 7.3.28
 *   and is no longer the live write target — detectInstalled() still probes it so
 *   an older install is recognized, but we install into kilo.json.
 *
 * SHARED BACKEND NOTE: kilo.json (VS Code ext) AND kilo.jsonc (CLI) are MERGED
 * by the ONE shared backend at user / project-root / .kilo/ levels — 3-way merge
 * verified live. The two platform IDs remain distinct for collision tracking, but
 * they share the same config dir and the backend dedupes across both files.
 *
 * Env interpolation: {env:VARIABLE_NAME} is documented by the pi/kilo backend.
 * We still resolve env refs to literals at install time (the conservative path,
 * consistent with kilo-cli) to avoid any version dependency on the interpolation
 * feature being present at runtime.
 *
 * Hooks (ts-plugin — same layer as kilo-cli):
 *   The plugins doc banner reads "applies to current VSCode extension & CLI".
 *   Plugin dirs: project → <projectDir>/.kilo/plugin/, user → ~/.config/kilo/plugin/.
 *   Auto-discovery applies (as in the CLI ≥ 7.3.16), and we ALSO register the
 *   module path in kilo.json's `plugin` array for explicit load (both loaded).
 *   Event names: same as kilo-cli ("tool.execute.before", "tool.execute.after",
 *   "experimental.chat.system.transform"). Bridge shims to "kilo" (not "kilo-cli").
 *
 * Content surfaces:
 *   Commands  → .kilocode/commands (project) / ~/.kilocode/commands (user)
 *   Skills    → .kilo/skills/<name>/SKILL.md (project) / ~/.kilo/skills (user)
 *   Subagents → .kilocode/agents (project) / ~/.kilocode/agents (user)
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";

import { BaseAdapter } from "../base.js";
import type {
  Adapter,
  GeneratedPluginFile,
  HookReply,
  InstallContext,
  MemoryTarget,
  NormalizedEvent,
} from "../spi.js";
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
  PostToolUseEvent,
  PreToolUseEvent,
  ServerDef,
  SessionStartEvent,
  SkillDef,
  SubagentDef,
  Transport,
} from "../../core/types.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildServeWrapperCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "kilo";
/** vsix 7.3.28 root key in kilo.json (delegated kilo backend). */
const MCP_ROOT_KEY = "mcp";
/** kilo.json array of plugin module paths (also supports auto-discovery). */
const PLUGIN_ARRAY_KEY = "plugin";
/** Live config filename for the VS Code ext (DISTINCT from the CLI's kilo.jsonc). */
const CONFIG_FILE = "kilo.json";

/** Kilo Code extension id → its (legacy, migration-only) VS Code globalStorage folder. */
const KILO_EXTENSION_ID = "kilocode.kilo-code";
/**
 * Legacy globalStorage MCP settings filenames (MIGRATION-ONLY in 7.3.28). The
 * Cline-family alternative is probed during detection so an older install is
 * still recognized; we no longer WRITE there.
 */
const LEGACY_MCP_SETTINGS_FILE = "mcp_settings.json";
const LEGACY_CLINE_SETTINGS_FILE = "cline_mcp_settings.json";

/**
 * Canonical → Kilo (shared ts-plugin layer) event name map. Identical to the
 * kilo-cli mapping: the extension and CLI share the same plugin event model.
 */
const EVENT_TO_KILO: Partial<Record<HookEventName, string>> = {
  PreToolUse: "tool.execute.before",
  PostToolUse: "tool.execute.after",
  SessionStart: "experimental.chat.system.transform",
};

/** Raw payload the generated plugin posts to the universal hook entrypoint. */
interface KiloBridgePayload {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  sessionId?: string;
  projectDir?: string;
}

/**
 * Native MCP server entry shapes kilo.json accepts under `mcp` (the delegated
 * kilo backend). Local (stdio) servers use a SINGLE array command that folds the
 * executable and its args together; env lives under `environment`.
 */
interface KiloLocalServer {
  type: "local";
  command: string[];
  environment: Record<string, string>;
}
interface KiloRemoteServer {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
}

/**
 * Resolve the kilo backend user config dir: `$XDG_CONFIG_HOME/kilo` when set,
 * else `~/.config/kilo`. This is the SAME backend dir kilo-cli uses (the two
 * differ only by filename — kilo.json here vs kilo.jsonc for the CLI).
 */
function kiloConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base =
    xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".config");
  return join(base, "kilo");
}

/**
 * Resolve the cross-OS VS Code per-user data directory (the "User" folder that
 * contains `globalStorage`) — used ONLY to probe the legacy migration-only MCP
 * settings file during detection. See module header for the per-platform mapping.
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

export class KiloAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Kilo Code";
  readonly paradigm: HookParadigm = "ts-plugin";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block (project <projectDir>/AGENTS.md
    // via the base default; user scope → ~/.kilocode/rules/agent-connector.md below).
    supportsMemory: true,
    // Kilo Code 7.x shares the ts-plugin layer with the Kilo CLI — same events.
    preToolUse: true,
    postToolUse: true,
    preCompact: false,
    sessionStart: true,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    canModifyArgs: true,
    canModifyOutput: true,
    canInjectSessionContext: true,
    // Kilo Code registers stdio, SSE, and Streamable HTTP MCP servers.
    transports: ["stdio", "sse", "http"],
    // Content surfaces: commands, skills (since 7.x rebuild), and subagents.
    supportsCommands: true,
    supportsSkills: true,
    supportsSubagents: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userConfig = this.userConfigPath();
    const userBackendDir = kiloConfigDir();
    // Probe the legacy (migration-only) globalStorage MCP settings too so an
    // older install is still recognized; we never WRITE there anymore.
    const legacyExtDir = join(vscodeUserDir(), "globalStorage", KILO_EXTENSION_ID);
    const legacySettings = join(legacyExtDir, "settings", LEGACY_MCP_SETTINGS_FILE);
    const legacyClineSettings = join(
      legacyExtDir,
      "settings",
      LEGACY_CLINE_SETTINGS_FILE,
    );
    const projectConfig = join(projectDir, ".kilo", CONFIG_FILE);

    const userMatch =
      existsSync(userConfig) ||
      existsSync(userBackendDir) ||
      existsSync(legacySettings) ||
      existsSync(legacyClineSettings) ||
      existsSync(legacyExtDir);
    const projectMatch = existsSync(projectConfig);
    const installed = userMatch || projectMatch;

    // Prefer the user scope/path when present; otherwise surface the project one.
    const scope = userMatch || !projectMatch ? "user" : "project";
    const configPath = scope === "user" ? userConfig : projectConfig;
    const reason = installed
      ? userMatch
        ? `found Kilo Code config under ${userBackendDir}`
        : `found Kilo Code project config at ${projectConfig}`
      : `no Kilo Code config at ${userBackendDir} or ${projectConfig}`;

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

  /** Absolute path to the user-scope kilo.json (kilo backend, XDG dir). */
  private userConfigPath(): string {
    return join(kiloConfigDir(), CONFIG_FILE);
  }

  // ── Memory surface: global rules dir at user scope ──────────────────────
  // Project scope stays on the AGENTS.md base default. User scope targets a
  // dedicated agent-connector.md in the legacy-compatible ~/.kilocode/rules/
  // dir (always loaded; avoids JSONC `instructions` edits in kilo.jsonc; the
  // AC-created file is cleanly deletable on uninstall). Shared backend with
  // kilo-cli — the convergent write dedupes via the content hash.
  protected override memoryTargets(ctx: InstallContext): MemoryTarget[] {
    if (this.memoryOverride(ctx)?.path || ctx.scope !== "user") {
      return super.memoryTargets(ctx);
    }
    return [
      {
        path: join(homedir(), ".kilocode", "rules", "agent-connector.md"),
        reason: "kilo global rules dir (~/.kilocode/rules; agent-connector-owned file)",
      },
    ];
  }

  /**
   * MCP config dir. Note the project surface is `.kilo/` (kilo backend), NOT the
   * extension's `.kilocode/` content tree (which still hosts commands/subagents).
   */
  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilo")
      : kiloConfigDir();
  }

  getServerConfigPath(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilo", CONFIG_FILE)
      : this.userConfigPath();
  }

  /**
   * For ts-plugin hosts the "hook config path" is the generated plugin FILE.
   * The backend also supports auto-discovery from the plugin dir, but we ALSO
   * register the path in kilo.json's `plugin` array for explicit load (idempotent).
   */
  getHookConfigPath(ctx: InstallContext): string {
    return join(this.pluginDir(ctx), this.pluginFileName(ctx));
  }

  /** Plugin directory the synthesized module is written into, per scope. */
  private pluginDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilo", "plugin")
      : join(kiloConfigDir(), "plugin");
  }

  /** Plugin module file name (one per connector, kebab-case id). */
  private pluginFileName(ctx: InstallContext): string {
    return `${ctx.connector.id}.js`;
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
            ? "server registration disabled for kilo"
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

  /**
   * Render a normalized ServerDef into kilo.json's native `mcp` entry. Local
   * (stdio) servers fold the executable + args into a SINGLE `command` array and
   * carry env under `environment`; remote servers use a `type:"remote"` URL entry.
   */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): KiloLocalServer | KiloRemoteServer {
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

      // Resolve ${env:VAR} to literals at install time (conservative; consistent
      // with kilo-cli even though {env:VARIABLE_NAME} is documented).
      const argv: string[] = [
        resolveEnvRefsDeep(command),
        ...resolveEnvRefsDeep(args),
      ];
      const entry: KiloLocalServer = {
        type: "local",
        command: argv,
        environment: this.renderEnv(server.env) ?? {},
      };
      return entry;
    }

    // sse / http (and any other remote transport) — kilo registers a remote URL.
    const entry: KiloRemoteServer = {
      type: "remote",
      url: resolveEnvRefsDeep(server.url ?? ""),
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Resolve `${env:VAR}` references to literals at
   * install time for consistency with kilo-cli.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hook install / uninstall (ts-plugin + explicit `plugin` array) ────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const pluginPath = this.getHookConfigPath(ctx);
    const configPath = this.getServerConfigPath(ctx);

    if (ctx.connector.platforms[HOST]?.hooks === false) {
      return [
        { platform: this.id, action: "skip", path: pluginPath, detail: "hooks disabled for kilo" },
      ];
    }
    if (ctx.connector.hookEvents.length === 0) {
      return [
        { platform: this.id, action: "skip", path: pluginPath, detail: "connector declares no hooks" },
      ];
    }

    const changes: ChangeRecord[] = [];

    // 1. Write the synthesized plugin module.
    for (const file of this.synthesizePlugin(ctx)) {
      const before = existsSync(file.path) ? this.safeRead(file.path) : undefined;
      let action: ChangeRecord["action"];
      if (before === undefined) action = "create";
      else if (before === file.contents) action = "skip";
      else action = "update";

      if (action !== "skip" && !ctx.dryRun) {
        ensureDir(dirname(file.path));
        writeFileSync(file.path, file.contents, "utf8");
        chmodSync(file.path, file.executable ? 0o755 : 0o644);
      }
      changes.push({
        platform: this.id,
        action,
        path: file.path,
        detail: `kilo plugin module (${this.hookDetail(ctx)})`,
      });
    }

    // 2. Register the module path in kilo.json's `plugin` array. The backend also
    //    auto-discovers from the plugin dir, but explicit registration is idempotent
    //    and ensures loading even if auto-discovery is disabled.
    changes.push(this.upsertPluginInArray(configPath, pluginPath, ctx.dryRun));

    return changes;
  }

  /**
   * Human-facing summary of which declared events the synthesized module ACTUALLY
   * wires. Only events present in EVENT_TO_KILO are mapped/wired; any declared
   * event with no Kilo mapping is reported separately as "unsupported here".
   */
  private hookDetail(ctx: InstallContext): string {
    const declared = ctx.connector.hookEvents;
    const mapped = declared.filter((e) => EVENT_TO_KILO[e] !== undefined);
    const unsupported = declared.filter((e) => EVENT_TO_KILO[e] === undefined);
    const base = mapped.join(",");
    return unsupported.length > 0
      ? `${base}; unsupported here: ${unsupported.join(",")}`
      : base;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const pluginPath = this.getHookConfigPath(ctx);
    const configPath = this.getServerConfigPath(ctx);
    const changes: ChangeRecord[] = [];

    // 1. Deregister the module path from kilo.json's `plugin` array.
    changes.push(this.removePluginFromArray(configPath, pluginPath, ctx.dryRun));

    // 2. Remove the plugin module on disk.
    if (existsSync(pluginPath)) {
      if (!ctx.dryRun) rmSync(pluginPath, { force: true });
      changes.push({
        platform: this.id,
        action: "remove",
        path: pluginPath,
        detail: "kilo plugin module",
      });
    } else {
      changes.push({
        platform: this.id,
        action: "skip",
        path: pluginPath,
        detail: "no kilo plugin module present",
      });
    }

    // 3. Drop the now-empty plugin dir (only if WE own its full contents).
    changes.push(this.removeDirIfEmpty(this.pluginDir(ctx), ctx.dryRun));

    return changes;
  }

  /** Upsert the module path into kilo.json's top-level `plugin` array (idempotent). */
  private upsertPluginInArray(
    configPath: string,
    modulePath: string,
    dryRun: boolean,
  ): ChangeRecord {
    if (this.isPresentButUnparseable(configPath)) {
      return {
        platform: this.id,
        action: "warn",
        path: configPath,
        detail: `existing ${configPath} is not parseable; left untouched (back it up / fix it, then re-run)`,
      };
    }
    const cfg = this.readJson<Record<string, unknown>>(configPath) ?? {};
    const plugins = this.pluginArrayBucket(cfg);
    if (plugins.includes(modulePath)) {
      return {
        platform: this.id,
        action: "skip",
        path: configPath,
        detail: `${PLUGIN_ARRAY_KEY}[] already includes module`,
      };
    }
    plugins.push(modulePath);
    this.writeJson(configPath, cfg, dryRun);
    return {
      platform: this.id,
      action: "create",
      path: configPath,
      detail: `${PLUGIN_ARRAY_KEY}[] += module`,
    };
  }

  /** Remove the module path from kilo.json's `plugin` array. */
  private removePluginFromArray(
    configPath: string,
    modulePath: string,
    dryRun: boolean,
  ): ChangeRecord {
    if (this.isPresentButUnparseable(configPath)) {
      return {
        platform: this.id,
        action: "warn",
        path: configPath,
        detail: `existing ${configPath} is not parseable; left untouched (back it up / fix it, then re-run)`,
      };
    }
    const cfg = this.readJson<Record<string, unknown>>(configPath);
    const raw = cfg?.[PLUGIN_ARRAY_KEY];
    const plugins = Array.isArray(raw) ? (raw as unknown[]) : undefined;
    const idx = plugins ? plugins.indexOf(modulePath) : -1;
    if (!cfg || !plugins || idx < 0) {
      return {
        platform: this.id,
        action: "skip",
        path: configPath,
        detail: `${PLUGIN_ARRAY_KEY}[] does not include module`,
      };
    }
    plugins.splice(idx, 1);
    this.writeJson(configPath, cfg, dryRun);
    return {
      platform: this.id,
      action: "remove",
      path: configPath,
      detail: `${PLUGIN_ARRAY_KEY}[] -= module`,
    };
  }

  /** Get-or-create the top-level `plugin` array as a mutable string array. */
  private pluginArrayBucket(cfg: Record<string, unknown>): string[] {
    const existing = cfg[PLUGIN_ARRAY_KEY];
    const plugins = Array.isArray(existing)
      ? existing.filter((p): p is string => typeof p === "string")
      : [];
    cfg[PLUGIN_ARRAY_KEY] = plugins;
    return plugins;
  }

  // ── ts-plugin synthesis ────────────────────────────────────────────────

  /**
   * Build ONE self-contained ESM plugin module for Kilo Code (the VS Code
   * extension). Structurally identical to the kilo-cli plugin but bridges to
   * "kilo" (not "kilo-cli") so the dispatcher routes to the correct adapter.
   */
  synthesizePlugin(ctx: InstallContext): GeneratedPluginFile[] {
    const path = this.getHookConfigPath(ctx);
    const contents = this.buildPluginSource(ctx);
    return [{ path, contents, executable: false }];
  }

  /** Compose the generated plugin source with plain string concatenation. */
  private buildPluginSource(ctx: InstallContext): string {
    const homeBin = JSON.stringify(ctx.homeBinPath);
    const connectorId = JSON.stringify(ctx.connector.id);

    const events = ctx.connector.hookEvents.filter(
      (e): e is HookEventName => EVENT_TO_KILO[e] !== undefined,
    );
    const has = (e: HookEventName) => events.includes(e);

    const header = `/**
 * AUTO-GENERATED by agent-connector — DO NOT EDIT.
 *
 * Self-contained Kilo Code (VS Code extension) plugin bridge for connector ${ctx.connector.id}.
 * It imports nothing from agent-connector: every hook invocation shells out to
 * the stable home binary's universal entrypoint and JSON-parses the normalized
 * response. Fail-open: any bridge error degrades to "allow".
 *
 * Default export is the @kilocode/plugin PluginModule shape
 * ({ id, server: async (input) => Hooks }); the extension loads it via the
 * plugin dir auto-discovery and/or the "plugin" array in kilo.json.
 */
import { execFileSync, execSync } from "node:child_process";

const HOME_BIN = ${homeBin};
const CONNECTOR_ID = ${connectorId};

/**
 * Invoke the universal hook entrypoint for one event.
 * @param {string} event canonical event name (PreToolUse|PostToolUse|SessionStart)
 * @param {object} payload Kilo-shaped payload posted on stdin
 * @returns {object|null} normalized HookResponse, or null on any failure
 */
function bridge(event, payload) {
  try {
    // On Windows HOME_BIN is the agent-connector.cmd launcher: Node cannot
    // execFile a batch file, and shell+args is deprecated (DEP0190), so run one
    // quoted command line via a shell. POSIX keeps the direct execFile (no shell).
    const args = ["hook", "kilo", event, "--connector", CONNECTOR_ID];
    const opts = { input: JSON.stringify(payload), encoding: "utf8" };
    const stdout =
      process.platform === "win32"
        ? execSync([HOME_BIN, ...args].map((a) => '"' + a + '"').join(" "), opts)
        : execFileSync(HOME_BIN, args, opts);
    const text = (stdout || "").trim();
    if (text === "") return { decision: "allow" };
    return JSON.parse(text);
  } catch {
    // Fail-open — never wedge a tool call on a bridge error.
    return null;
  }
}
`;

    const handlers: string[] = [];

    if (has("PreToolUse")) {
      handlers.push(`    // PreToolUse → block (throw) / rewrite args (mutate output.args).
    "tool.execute.before": async (input, output) => {
      const payload = {
        toolName: input.tool ?? "",
        toolInput: (output && output.args) ?? {},
        sessionId: input.sessionID ?? "",
        projectDir: PROJECT_DIR,
      };
      const res = bridge("PreToolUse", payload);
      if (!res) return;
      // Kilo has no "ask" gate — degrade "ask" to a block (safe direction).
      if (res.decision === "deny" || res.decision === "ask") {
        throw new Error(res.reason || "Blocked by ${ctx.connector.id}");
      }
      if (res.updatedInput && output && output.args) {
        Object.assign(output.args, res.updatedInput);
      }
    },`);
    }

    if (has("PostToolUse")) {
      handlers.push(`    // PostToolUse → observe / rewrite tool output (mutate output.output).
    "tool.execute.after": async (input, output) => {
      const payload = {
        toolName: input.tool ?? "",
        toolInput: input.args ?? {},
        toolOutput: output ? output.output : undefined,
        sessionId: input.sessionID ?? "",
        projectDir: PROJECT_DIR,
      };
      const res = bridge("PostToolUse", payload);
      if (!res) return;
      if (typeof res.updatedOutput === "string" && output) {
        output.output = res.updatedOutput;
      }
    },`);
    }

    if (has("SessionStart")) {
      handlers.push(`    // SessionStart surrogate → inject context into the system prompt.
    // The extension has no real SessionStart hook; the system-prompt transform is
    // the verified injection point (mirrors OpenCode and kilo-cli).
    "experimental.chat.system.transform": async (input, output) => {
      const payload = {
        sessionId: (input && input.sessionID) ?? "",
        projectDir: PROJECT_DIR,
      };
      const res = bridge("SessionStart", payload);
      if (!res) return;
      if (res.additionalContext && output && Array.isArray(output.system)) {
        // Insert at index 1 (after the header) to preserve the prompt-cache fold
        // (header must remain system[0]).
        output.system.splice(1, 0, res.additionalContext);
      }
    },`);
    }

    const definition = `
const plugin = {
  id: CONNECTOR_ID,
  // @kilocode/plugin PluginModule: server(input) returns the Hooks object keyed
  // by the fork's event names. ctx.directory is the project root; fall back to cwd.
  server: async (input) => {
    const PROJECT_DIR =
      (input && (input.directory || (input.worktree && input.worktree.path))) ||
      process.cwd();

    return {
${handlers.join("\n")}
    };
  },
};

export default plugin;
`;

    return header + definition;
  }

  // ── Runtime: parse OUR bridge payload → normalized event ───────────────

  /**
   * `raw` is the payload OUR generated plugin posts (NOT a host-native shape):
   *   { toolName, toolInput, toolOutput?, isError?, sessionId, projectDir }
   * so this maps straight through.
   */
  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as KiloBridgePayload;
    const base = {
      hostPlatform: HOST,
      connectorId: "",
      sessionId: typeof input.sessionId === "string" ? input.sessionId : "",
      raw,
      ...(typeof input.projectDir === "string" ? { projectDir: input.projectDir } : {}),
    } as const;

    switch (event) {
      case "PreToolUse": {
        const ev: PreToolUseEvent = {
          ...base,
          toolName: input.toolName ?? "",
          toolInput: input.toolInput ?? {},
        };
        return ev;
      }
      case "PostToolUse": {
        const ev: PostToolUseEvent = {
          ...base,
          toolName: input.toolName ?? "",
          toolInput: input.toolInput ?? {},
          ...(typeof input.toolOutput === "string" ? { toolOutput: input.toolOutput } : {}),
          ...(typeof input.isError === "boolean" ? { isError: input.isError } : {}),
        };
        return ev;
      }
      case "SessionStart": {
        const ev: SessionStartEvent = { ...base, source: "startup" };
        return ev;
      }
      default:
        return { ...base, source: "startup" } satisfies SessionStartEvent;
    }
  }

  // ── Runtime: normalized response → reply the generated bridge parses ───

  /**
   * OUR generated bridge consumes this stdout directly. The reply body IS the
   * normalized HookResponse itself — the bridge JSON.parses it and reads
   * decision / updatedInput / updatedOutput / additionalContext.
   */
  formatReply(_event: HookEventName, response: HookResponse): HookReply {
    return {
      exitCode: 0,
      stdout: JSON.stringify(response ?? { decision: "allow" }),
    };
  }

  // ── Content surfaces: commands / skills / subagents ───────────────────
  // CONTENT-ONLY: pure native-file writers. No runtime dispatch, no home-bin
  // pointer, no telemetry wrap. Each method is idempotent (byte-identical →
  // skip) via BaseAdapter.writeContentFile and reversible via removeContentFile.
  // Honors platforms["kilo"] per-surface false to skip.
  //
  // NOTE on dirs: the .kilocode/ tree is the EXTENSION's legacy content surface
  // — kept SEPARATE from the MCP/hooks backend dir (~/.config/kilo). Commands
  // live under .kilocode/commands (project) / ~/.kilocode/commands (user);
  // subagents live under .kilocode/agents (project) / ~/.kilocode/agents (user).
  // Skills use the newer .kilo/skills tree (project) / ~/.kilo/skills (user).

  /** The extension's user-scope legacy content home (~/.kilocode). */
  private userContentDir(): string {
    return join(homedir(), ".kilocode");
  }

  /** Skills root: project → <projectDir>/.kilo/skills; user → ~/.kilo/skills. */
  private skillsRootDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilo", "skills")
      : join(homedir(), ".kilo", "skills");
  }

  /** Commands root: project → <projectDir>/.kilocode/commands; user → ~/.kilocode/commands. */
  private commandsDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilocode", "commands")
      : join(this.userContentDir(), "commands");
  }

  /** Subagents root: project → <projectDir>/.kilocode/agents; user → ~/.kilocode/agents. */
  private agentsDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilocode", "agents")
      : join(this.userContentDir(), "agents");
  }

  /** Native command file path: <commandsDir>/<name>.md. */
  private commandPath(ctx: InstallContext, name: string): string {
    return join(this.commandsDir(ctx), `${name}.md`);
  }

  /** Native skill dir: <skillsRootDir>/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsRootDir(ctx), name);
  }

  /** Native subagent file path: <agentsDir>/<name>.md. */
  private subagentPath(ctx: InstallContext, name: string): string {
    return join(this.agentsDir(ctx), `${name}.md`);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  override installCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.commands === false) {
      return [{ platform: this.id, action: "skip", detail: "commands disabled for kilo" }];
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

  /** Render a command to md+frontmatter (description, argument-hint, mode, model). */
  private renderCommand(cmd: CommandDef): string {
    const frontmatter: Record<string, unknown> = {};
    if (cmd.description !== undefined) frontmatter.description = cmd.description;
    if (cmd.argumentHint !== undefined) frontmatter["argument-hint"] = cmd.argumentHint;
    if (cmd.model !== undefined) frontmatter.model = cmd.model;
    if (cmd.extra) Object.assign(frontmatter, cmd.extra);
    return this.renderFrontmatterMd(frontmatter, cmd.prompt);
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for kilo" }];
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

  /**
   * Render a skill's SKILL.md: frontmatter (name, description + optional model,
   * allowed-tools, disable-model-invocation) + markdown body.
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

  // ── Subagents ───────────────────────────────────────────────────────────────

  override installSubagents(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.subagents === false) {
      return [{ platform: this.id, action: "skip", detail: "subagents disabled for kilo" }];
    }
    if (connector.subagents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no subagents" }];
    }
    return connector.subagents.map((agent) =>
      this.writeContentFile(
        this.subagentPath(ctx, agent.name),
        this.renderSubagent(agent),
        ctx.dryRun,
      ),
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
   * Render a subagent to md+frontmatter. Kilo Code's shape is
   * (description, mode:"subagent", model, permission) with the system prompt as
   * the body. `name` is NOT a frontmatter field — it comes from the filename.
   * `permission` is derived from the coarse `readonly` knob: a readonly agent
   * gets a per-tool deny map (edit/bash) so it cannot mutate the workspace.
   */
  private renderSubagent(agent: SubagentDef): string {
    const frontmatter: Record<string, unknown> = {
      description: agent.description,
      mode: "subagent",
    };
    if (agent.model !== undefined) frontmatter.model = agent.model;
    if (agent.readonly === true) {
      frontmatter.permission = { edit: "deny", bash: "deny" };
    }
    if (agent.extra) Object.assign(frontmatter, agent.extra);
    return this.renderFrontmatterMd(frontmatter, agent.prompt);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const mcpPath = this.getServerConfigPath(ctx);
    const pluginPath = this.getHookConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const hasHooks = ctx.connector.hookEvents.length > 0;

    const checks: HealthCheck[] = [
      {
        name: `${this.name}: kilo.json present`,
        check: () =>
          existsSync(mcpPath)
            ? { status: "OK", detail: mcpPath }
            : { status: "FAIL", detail: `not found: ${mcpPath}` },
      },
      {
        // The backend merges kilo.json AND kilo.jsonc at user/project/.kilo/ levels.
        name: `${this.name}: MCP delegated to kilo backend`,
        check: () => ({
          status: "OK",
          detail:
            ctx.scope === "user"
              ? `using ${CONFIG_FILE} under ${kiloConfigDir()} (merged with kilo.jsonc by shared backend)`
              : `project scope uses .kilo/${CONFIG_FILE} (merged with kilo.jsonc by shared backend)`,
        }),
      },
      {
        name: `${this.name}: server entry registered`,
        check: () => {
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
      {
        name: `${this.name}: plugin module present`,
        check: () => {
          if (!hasHooks) return { status: "OK", detail: "no hooks declared" };
          return existsSync(pluginPath)
            ? { status: "OK", detail: pluginPath }
            : { status: "FAIL", detail: `not found: ${pluginPath}` };
        },
      },
      {
        name: `${this.name}: plugin registered in ${PLUGIN_ARRAY_KEY}[]`,
        check: () => {
          if (!hasHooks) return { status: "OK", detail: "no hooks declared" };
          const cfg = this.readJson<Record<string, unknown>>(mcpPath);
          const raw = cfg?.[PLUGIN_ARRAY_KEY];
          const plugins = Array.isArray(raw) ? (raw as unknown[]) : undefined;
          return plugins && plugins.includes(pluginPath)
            ? { status: "OK", detail: `${PLUGIN_ARRAY_KEY}[] includes module` }
            : {
                status: "FAIL",
                detail: `module not in ${PLUGIN_ARRAY_KEY}[] of ${mcpPath}`,
              };
        },
      },
    ];

    // Content-surface checks.
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

  /** Read a file, returning undefined on any error (idempotency compare). */
  private safeRead(path: string): string | undefined {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  }
}

/** Create a directory (recursive) if it does not already exist. */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export const adapter = new KiloAdapter();
export default adapter;
