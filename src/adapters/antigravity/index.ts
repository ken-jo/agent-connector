/**
 * adapters/antigravity — Google Antigravity (IDE) platform adapter.
 *
 * Antigravity is a Gemini-family host that, as of the 2.0 line, exposes a real
 * lifecycle-hook system on top of MCP — so this adapter is `json-stdio` (not the
 * old `mcp-only` framing): the host pipes a JSON payload to a hook command on
 * stdin and reads a JSON control object back, the same paradigm as Claude Code /
 * Gemini CLI. It installs the MCP server, lifecycle hooks, slash-command
 * Workflows, and Agent Skills.
 *
 * CONFIRMED-BY-INSTALL (2026-06-03, docs/research/antigravity-paths-confirmed.md):
 * a real machine with Antigravity IDE + `agy` CLI v1.0.0 shows the canonical user
 * customization root is `~/.gemini/antigravity/` — `~/.gemini/antigravity/mcp_config.json`
 * EXISTS and `~/.gemini/config/mcp_config.json` does NOT. So the fresh-install
 * default user MCP path is `~/.gemini/antigravity/mcp_config.json` (candidate[0]);
 * the `config/` and `antigravity-cli/` paths remain probed fallbacks only (honored
 * when a pre-existing config is found there, never the fresh default).
 *
 * STILL MEDIUM-CONFIDENCE / PATH-PROBING: hooks.json and the global skills dir were
 * NOT present on the observed install, so those locations stay corroborated-but-not-
 * byte-verified. Every user-scope path is PROBED at runtime — prefer a candidate
 * that already exists on disk, else fall back to the canonical path — and the doctor
 * flags each probed path with "verify for your Antigravity version." We NEVER
 * hard-code a single guessed path, and any unsupported event or surface warn-skips
 * (never throws) at install time.
 *
 * Native config formats:
 *   - MCP config (JSONC; we WRITE plain JSON), root key "mcpServers". stdio is
 *     `{ command, args, env }`; a remote server is `{ serverUrl, headers }`
 *     (NOTE: the key is `serverUrl`, NOT `url` and NOT Gemini CLI's `httpUrl`).
 *       user scope    → prefer existing of:
 *                         ~/.gemini/antigravity/mcp_config.json   (CONFIRMED canonical)
 *                         ~/.gemini/config/mcp_config.json        (probed fallback)
 *                         ~/.gemini/antigravity-cli/mcp_config.json (probed fallback)
 *                       else default to candidate[0] (antigravity/).
 *       project scope → <projectDir>/.agents/mcp_config.json
 *   - Hooks: a SEPARATE hooks.json in the customization dir (NOT the mcp_config),
 *       project → <projectDir>/.agents/hooks.json
 *       user    → <resolvedUserConfigDir>/hooks.json
 *     Shape: { hooks: { <Event>: [ { matcher, hooks:[{ type:"command", command }] } ] } }.
 *     Supported events: PreToolUse, PostToolUse, SessionStart, Stop. All other
 *     normalized events warn-skip. I/O fields are camelCase (see parse/format).
 *   - Commands = "Workflows": markdown `.md` (body = the prompt; an optional
 *     leading description line). Project prefer existing <proj>/.agent/workflows
 *     or <proj>/.agents/workflows (default .agent/workflows per launch docs);
 *     user ~/.gemini/antigravity/global_workflows.
 *   - Skills = Agent Skills (uniform SKILL.md). Project
 *     <proj>/.agents/skills/<name>/SKILL.md; user PROBE
 *     ~/.gemini/antigravity-cli/skills then ~/.gemini/skills (NEVER
 *     ~/.gemini/antigravity/skills — reportedly broken). NOTE: the global skills
 *     dir was NOT present on the confirmed install, so it stays medium-confidence
 *     + doctor "verify for your version."
 *   - Subagents: declarative subagents exist only inside a plugin bundle, which
 *     agent-connector does not emit; supportsSubagents is false and the
 *     BaseAdapter skip/warn default applies.
 *
 * Env handling: Antigravity (Gemini family) documents no `${env:VAR}` token of
 * the framework's syntax, so env/header/url refs are resolved to literals at
 * install time via resolveEnvRefsDeep — the safe default matching the Gemini CLI
 * adapter.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
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
  PlatformCapabilities,
  PlatformId,
  PostToolUseEvent,
  PreToolUseEvent,
  ServerDef,
  SessionStartEvent,
  SkillDef,
  StopEvent,
  Transport,
} from "../../core/types.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildHomeBinHookCommand,
  buildServeWrapperCommand,
  buildUsageEventCommand,
  isHomeBinHookCommand,
  isHostNativeUsageEnabled,
  isUsageEventCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "antigravity";
const MCP_ROOT_KEY = "mcpServers";

/**
 * Known user-scope MCP config candidates, in preference order. We pick the first
 * that already exists on disk; otherwise we default to candidate[0]
 * (~/.gemini/antigravity/mcp_config.json — CONFIRMED canonical on a real install:
 * docs/research/antigravity-paths-confirmed.md). The `config/` and CLI-only
 * `antigravity-cli/` paths are kept ONLY as probed fallbacks so a pre-existing
 * config in either is still honored, but neither is ever the fresh-install default.
 */
const USER_CONFIG_CANDIDATES = [
  [".gemini", "antigravity", "mcp_config.json"],
  [".gemini", "config", "mcp_config.json"],
  [".gemini", "antigravity-cli", "mcp_config.json"],
] as const;

/**
 * Antigravity's supported lifecycle hook events. These happen to share the
 * normalized PascalCase names 1:1; everything else has no Antigravity equivalent
 * and is reported as a warn/skip at install time.
 */
const SUPPORTED_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "Stop",
]);

/**
 * Native hooks.json key for the OPT-IN host-native turn-usage hook (enricher 4a).
 * Antigravity shares the Gemini-family `AfterModel` model-turn hook, whose payload
 * carries `usageMetadata`. This is a host-native-only sink (no connector handler);
 * it is installed ONLY when host-native capture is enabled and records a DISTINCT
 * `model_turn` telemetry row that is never summed with the per-MCP `serve` rows.
 */
const USAGE_HOOK_EVENT = "AfterModel";

/** A single Antigravity native hook registration entry (nested, Claude-shaped). */
interface AntigravityHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** The shape of Antigravity's hooks.json (only the parts we touch). */
interface AntigravityHooksFile {
  hooks?: Record<string, AntigravityHookEntry[]>;
  [key: string]: unknown;
}

/**
 * Native MCP server entry shapes Antigravity accepts under `mcpServers`.
 * A stdio server is `{ command, args, env }`; a remote server is
 * `{ serverUrl, headers }` — the key is `serverUrl` (NOT `url`).
 */
interface AntigravityStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
interface AntigravityHttpServer {
  serverUrl: string;
  headers?: Record<string, string>;
}

/** Raw Antigravity hook stdin payload (camelCase wire fields). */
interface AntigravityWireInput {
  connector?: unknown;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  sessionId?: string;
  cwd?: string;
  source?: string;
  reason?: string;
  stopHookActive?: boolean;
}

export class AntigravityAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name: string = "Google Antigravity";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // Antigravity 2.0 fires PreToolUse / PostToolUse / SessionStart / Stop.
    preToolUse: true,
    postToolUse: true,
    sessionStart: true,
    stop: true,
    // No documented equivalents — kept false; the corresponding normalized
    // events warn-skip at install time.
    preCompact: false,
    sessionEnd: false,
    userPromptSubmit: false,
    notification: false,
    // Transform-category hooks can rewrite tool input and tool output; the
    // SessionStart hook can inject additional context.
    canModifyArgs: true,
    canModifyOutput: true,
    canInjectSessionContext: true,
    // Antigravity registers stdio, SSE, and Streamable HTTP MCP servers.
    transports: ["stdio", "sse", "http"],
    // Content surfaces: Workflows (markdown commands) + Agent Skills (SKILL.md).
    // Declarative subagents exist only inside a plugin bundle (not emitted), so
    // subagents are unsupported and inherit the BaseAdapter skip/warn default.
    supportsCommands: true,
    supportsSkills: true,
    supportsSubagents: false,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userConfig = this.resolveUserConfigPath();
    const userDir = join(homedir(), ".gemini");
    const projectConfig = join(projectDir, ".agents", "mcp_config.json");

    const userInstalled =
      existsSync(userDir) ||
      this.userConfigCandidates().some((parts) => existsSync(join(homedir(), ...parts)));
    const projInstalled = existsSync(projectConfig);
    const installed = userInstalled || projInstalled;

    // Report the scope/path that actually matched, so a project-only install
    // isn't misreported as a (non-existent) user install.
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projectConfig : userConfig;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? scope === "project"
          ? `found project Antigravity config at ${projectConfig}`
          : `found Antigravity config under ${userDir}`
        : `no Antigravity config at ${userDir} or ${projectConfig}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    if (ctx.scope === "project") return join(ctx.projectDir, ".agents");
    // User scope: parent dir of the resolved user mcp_config.json.
    return dirname(this.resolveUserConfigPath());
  }

  getServerConfigPath(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".agents", "mcp_config.json")
      : this.resolveUserConfigPath();
  }

  /**
   * Hooks live in a SEPARATE hooks.json in the customization dir — NOT the
   * mcp_config.json. Project → <proj>/.agents/hooks.json; user →
   * <resolvedUserConfigDir>/hooks.json (the dir holding the resolved user MCP
   * config). Path is medium-confidence and surfaced by the doctor.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "hooks.json");
  }

  /**
   * The user-scope MCP config candidates, in preference order. Overridable by
   * forks (e.g. the Antigravity CLI) that resolve a different user-scope root
   * while reusing resolveUserConfigPath's prefer-existing-else-candidate[0] logic.
   */
  protected userConfigCandidates(): ReadonlyArray<readonly string[]> {
    return USER_CONFIG_CANDIDATES;
  }

  /**
   * Pick the user-scope mcp_config.json: prefer a candidate that already exists,
   * else default to candidate[0] (the CONFIRMED canonical ~/.gemini/antigravity path).
   */
  protected resolveUserConfigPath(): string {
    const home = homedir();
    const candidates = this.userConfigCandidates();
    for (const parts of candidates) {
      const p = join(home, ...parts);
      if (existsSync(p)) return p;
    }
    const fallback = candidates[0];
    if (fallback === undefined) {
      // Defensive: a non-empty candidate list is an invariant, but never throw.
      return join(home, ".gemini", "antigravity", "mcp_config.json");
    }
    return join(home, ...fallback);
  }

  /**
   * Resolve the Workflows (slash-command) dir, prefer-existing-else-canonical.
   *   project → prefer existing <proj>/.agent/workflows or <proj>/.agents/workflows;
   *             default .agent/workflows (launch-era singular `.agent`).
   *   user    → ~/.gemini/antigravity/global_workflows.
   */
  protected resolveWorkflowsDir(ctx: InstallContext): string {
    if (ctx.scope === "project") {
      const singular = join(ctx.projectDir, ".agent", "workflows");
      const plural = join(ctx.projectDir, ".agents", "workflows");
      if (existsSync(singular)) return singular;
      if (existsSync(plural)) return plural;
      return singular;
    }
    return join(homedir(), ".gemini", "antigravity", "global_workflows");
  }

  /**
   * Resolve the Agent Skills dir, prefer-existing-else-canonical.
   *   project → <proj>/.agents/skills (plural — matches mcp/skills convention).
   *   user    → prefer existing ~/.gemini/antigravity-cli/skills, else
   *             ~/.gemini/skills. NEVER ~/.gemini/antigravity/skills
   *             (reportedly broken), so it is not a candidate.
   */
  protected resolveSkillsDir(ctx: InstallContext): string {
    if (ctx.scope === "project") {
      return join(ctx.projectDir, ".agents", "skills");
    }
    const home = homedir();
    const cliSkills = join(home, ".gemini", "antigravity-cli", "skills");
    const sharedSkills = join(home, ".gemini", "skills");
    if (existsSync(cliSkills)) return cliSkills;
    if (existsSync(sharedSkills)) return sharedSkills;
    return cliSkills;
  }

  // ── MCP server install / uninstall ───────────────────────────────────────

  installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    const override = connector.platforms[this.id]?.server;
    if (!connector.server || override === false) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail: connector.server
            ? `server registration disabled for ${this.id}`
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

  /** Render a normalized ServerDef into Antigravity's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): AntigravityStdioServer | AntigravityHttpServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

      // Transparent telemetry wrapping: route the real command through
      // `<homeBin> serve --connector <id> --scope <scope> -- <command> <args...>`.
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

      // Antigravity (Gemini family) has no documented native interpolation token,
      // so resolve every ${env:VAR} to a literal at install time.
      const entry: AntigravityStdioServer = { command: resolveEnvRefsDeep(command) };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // sse / http (and any other remote transport) — Antigravity registers a URL
    // under the `serverUrl` key (NOT `url`).
    const entry: AntigravityHttpServer = { serverUrl: resolveEnvRefsDeep(server.url ?? "") };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Antigravity documents no native interpolation
   * token, so resolve `${env:VAR}` references to literals at install time.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hook install / uninstall ─────────────────────────────────────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[this.id]?.hooks === false) {
      return [{ platform: this.id, action: "skip", detail: `hooks disabled for ${this.id}` }];
    }
    // The opt-in host-native usage hook (4a) needs no connector handler, so it may
    // be installed even when the connector declares no normalized hook events.
    const hostNative = isHostNativeUsageEnabled(connector.telemetry);
    if (connector.hookEvents.length === 0 && !hostNative) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no hooks" }];
    }

    const hooksPath = this.getHookConfigPath(ctx);
    // OVERWRITE GUARD: never clobber a present-but-unparseable hooks.json.
    if (this.isPresentButUnparseable(hooksPath)) {
      return [
        {
          platform: this.id,
          action: "warn",
          path: hooksPath,
          detail: `existing ${hooksPath} is not parseable; left untouched (back it up / fix it, then re-run)`,
        },
      ];
    }

    const file = this.readJson<AntigravityHooksFile>(hooksPath) ?? {};
    const hooks = (file.hooks ??= {});

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of connector.hookEvents) {
      if (!SUPPORTED_EVENTS.has(event)) {
        // No Antigravity equivalent for this normalized event — report.
        changes.push({
          platform: this.id,
          action: "warn",
          path: hooksPath,
          detail: `${event} has no Antigravity hook equivalent — skipped`,
        });
        continue;
      }

      const command = buildHomeBinHookCommand(ctx.homeBinPath, this.id, event, connector.id);
      const matcher = connector.hooks[event]?.matcher ?? "";
      const entry: AntigravityHookEntry = {
        matcher,
        hooks: [{ type: "command", command }],
      };

      const bucket = (hooks[event] ??= []);
      const existingIdx = bucket.findIndex((e) => this.entryHasOurCommand(e, ctx));

      if (existingIdx >= 0) {
        if (JSON.stringify(bucket[existingIdx]) === JSON.stringify(entry)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: hooksPath,
            detail: `hooks.${event} already registered`,
          });
          continue;
        }
        bucket[existingIdx] = entry;
        changes.push({
          platform: this.id,
          action: "update",
          path: hooksPath,
          detail: `hooks.${event}`,
        });
      } else {
        bucket.push(entry);
        changes.push({
          platform: this.id,
          action: "create",
          path: hooksPath,
          detail: `hooks.${event}`,
        });
      }
      mutated = true;
    }

    // OPT-IN host-native usage hook (4a): register the AfterModel `usage-event`
    // sink when enabled. Records a DISTINCT `model_turn` row (whole-conversation),
    // never summed with the per-MCP `serve`-proxy rows.
    if (hostNative) {
      if (this.installUsageHook(hooks, ctx, hooksPath, changes)) mutated = true;
    }

    if (mutated) this.writeJson(hooksPath, file, ctx.dryRun);
    return changes;
  }

  /**
   * Register the opt-in AfterModel host-native usage hook (4a) into `hooks`.
   * Idempotent (byte-identical → skip, drift → update); returns true on mutation.
   * The command is the hidden `usage-event` entrypoint (NOT a connector hook), so
   * it carries an empty matcher. Reads `this.id` so the CLI fork installs its own
   * `usage-event antigravity-cli …` variant.
   */
  private installUsageHook(
    hooks: Record<string, AntigravityHookEntry[]>,
    ctx: InstallContext,
    hooksPath: string,
    changes: ChangeRecord[],
  ): boolean {
    const command = buildUsageEventCommand(ctx.homeBinPath, this.id, ctx.connector.id);
    const entry: AntigravityHookEntry = {
      matcher: "",
      hooks: [{ type: "command", command }],
    };
    const bucket = (hooks[USAGE_HOOK_EVENT] ??= []);
    const existingIdx = bucket.findIndex((e) =>
      (e.hooks ?? []).some((h) => isUsageEventCommand(h.command, ctx.homeBinPath, ctx.connector.id)),
    );

    if (existingIdx >= 0) {
      if (JSON.stringify(bucket[existingIdx]) === JSON.stringify(entry)) {
        changes.push({
          platform: this.id,
          action: "skip",
          path: hooksPath,
          detail: `hooks.${USAGE_HOOK_EVENT} (host-native usage) already registered`,
        });
        return false;
      }
      bucket[existingIdx] = entry;
      changes.push({
        platform: this.id,
        action: "update",
        path: hooksPath,
        detail: `hooks.${USAGE_HOOK_EVENT} (host-native usage)`,
      });
    } else {
      bucket.push(entry);
      changes.push({
        platform: this.id,
        action: "create",
        path: hooksPath,
        detail: `hooks.${USAGE_HOOK_EVENT} (host-native usage)`,
      });
    }
    return true;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const hooksPath = this.getHookConfigPath(ctx);
    const file = this.readJson<AntigravityHooksFile>(hooksPath);
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

    for (const event of Object.keys(hooks)) {
      const bucket = hooks[event];
      if (!Array.isArray(bucket)) continue;

      // Strip our hook command from each entry; drop entries left empty so we
      // never remove another connector's (or the user's own) hook commands.
      const next: AntigravityHookEntry[] = [];
      let removed = 0;
      for (const e of bucket) {
        const innerBefore = e.hooks?.length ?? 0;
        const inner = (e.hooks ?? []).filter((h) => !this.isOurCommand(h.command, ctx));
        removed += innerBefore - inner.length;
        if (inner.length > 0) next.push({ matcher: e.matcher ?? "", hooks: inner });
      }

      if (removed > 0) {
        if (next.length > 0) hooks[event] = next;
        else delete hooks[event];
        changes.push({
          platform: this.id,
          action: "remove",
          path: hooksPath,
          detail: `hooks.${event} (${removed})`,
        });
        mutated = true;
      }
    }

    if (mutated) this.writeJson(hooksPath, file, ctx.dryRun);
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

  private entryHasOurCommand(entry: AntigravityHookEntry, ctx: InstallContext): boolean {
    return (entry.hooks ?? []).some((h) => this.isOurCommand(h.command, ctx));
  }

  /**
   * True when a hook command is ONE OF OURS for this connector — the universal
   * `hook` dispatcher OR the opt-in `usage-event` sink. Both are anchored on the
   * connector id (see isHomeBinHookCommand) so a shared-prefix id can't collide,
   * and so uninstall reverses the AfterModel usage hook too.
   */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return (
      isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id) ||
      isUsageEventCommand(command, ctx.homeBinPath, ctx.connector.id)
    );
  }

  // ── Content surfaces: commands (Workflows) / skills ───────────────────────
  // CONTENT-ONLY: pure native-file writers under the probed workflows / skills
  // dirs. No runtime dispatch, no home-bin pointer, no telemetry wrap. Each
  // method is idempotent (byte-identical → skip) via BaseAdapter.writeContentFile
  // and reversible via removeContentFile. Honors platforms["antigravity"]
  // per-surface false to skip. Commands are markdown Workflows (NOT TOML, unlike
  // gemini-cli); skills are the uniform Claude-compatible SKILL.md. Subagents are
  // unsupported (plugin-bundle-only) and inherit the BaseAdapter skip/warn.

  /** Native Workflow file path: <workflowsDir>/<name>.md. */
  private commandPath(ctx: InstallContext, name: string): string {
    return join(this.resolveWorkflowsDir(ctx), `${name}.md`);
  }
  /** Native skill dir: <skillsDir>/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.resolveSkillsDir(ctx), name);
  }

  // ── Commands (Workflows) ──────────────────────────────────────────────────

  override installCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[this.id]?.commands === false) {
      return [{ platform: this.id, action: "skip", detail: `commands disabled for ${this.id}` }];
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

  /**
   * Render a command to an Antigravity Workflow: a plain markdown `.md` whose
   * body is the command prompt, optionally preceded by a leading description
   * line. No frontmatter / TOML (unlike gemini-cli).
   */
  private renderCommand(cmd: CommandDef): string {
    const body = cmd.prompt.endsWith("\n") ? cmd.prompt : `${cmd.prompt}\n`;
    if (cmd.description !== undefined && cmd.description !== "") {
      return `${cmd.description}\n\n${body}`;
    }
    return body;
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[this.id]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: `skills disabled for ${this.id}` }];
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
      // Defense-in-depth: skip+warn on any key that escapes the skill dir.
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
   * allowed-tools, disable-model-invocation) + body. Uniform across platforms.
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
    const hooksPath = this.getHookConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const hookEvents = ctx.connector.hookEvents;
    const workflowsDir = this.resolveWorkflowsDir(ctx);
    const skillsDir = this.resolveSkillsDir(ctx);

    const checks: HealthCheck[] = [
      {
        name: `${this.name}: mcp_config.json present`,
        check: () =>
          existsSync(mcpPath)
            ? { status: "OK", detail: `${mcpPath} (path probed; verify for your Antigravity version)` }
            : { status: "FAIL", detail: `not found: ${mcpPath} (path probed; verify for your Antigravity version)` },
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
        name: `${this.name}: hooks.json hook command registered`,
        check: () => {
          if (hookEvents.length === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          const file = this.readJson<AntigravityHooksFile>(hooksPath);
          if (!file) {
            return {
              status: "FAIL",
              detail: `not found: ${hooksPath} (path probed; verify for your Antigravity version)`,
            };
          }
          const hooks = file.hooks ?? {};
          const registered = Object.values(hooks).some((entries) =>
            (entries ?? []).some((e) =>
              (e.hooks ?? []).some((h) =>
                isHomeBinHookCommand(h.command, homeBin, connectorId),
              ),
            ),
          );
          return registered
            ? { status: "OK", detail: `hook command present in ${hooksPath}` }
            : { status: "FAIL", detail: `no hook for ${connectorId} in ${hooksPath}` };
        },
      },
    ];

    // Content-surface checks: only assert presence of the files this connector
    // declares (skip silently for surfaces it never asked for). The probed dirs
    // are noted so doctor output makes the medium-confidence path explicit.
    for (const cmd of ctx.connector.commands) {
      const p = join(workflowsDir, `${cmd.name}.md`);
      checks.push({
        name: `${this.name}: workflow ${cmd.name} present`,
        check: () =>
          existsSync(p)
            ? { status: "OK", detail: `${p} (workflows dir probed; verify for your version)` }
            : { status: "FAIL", detail: `not found: ${p} (workflows dir probed; verify for your version)` },
      });
    }
    for (const skill of ctx.connector.skills) {
      const p = join(skillsDir, skill.name, "SKILL.md");
      checks.push({
        name: `${this.name}: skill ${skill.name} present`,
        check: () =>
          existsSync(p)
            ? { status: "OK", detail: `${p} (skills dir probed; verify for your version)` }
            : { status: "FAIL", detail: `not found: ${p} (skills dir probed; verify for your version)` },
      });
    }
    return checks;
  }

  // ── Runtime: parse Antigravity stdin JSON → normalized event ──────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as AntigravityWireInput;
    const connectorId = typeof input.connector === "string" ? input.connector : "";
    const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
    const projectDir = typeof input.cwd === "string" ? input.cwd : undefined;

    const base = {
      hostPlatform: this.id,
      connectorId,
      sessionId,
      raw,
      ...(projectDir !== undefined ? { projectDir } : {}),
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
          ...(input.toolOutput !== undefined ? { toolOutput: input.toolOutput } : {}),
          ...(input.isError === true ? { isError: true } : {}),
        };
        return ev;
      }
      case "SessionStart": {
        const ev: SessionStartEvent = {
          ...base,
          source: normalizeSessionSource(input.source),
        };
        return ev;
      }
      case "Stop": {
        const ev: StopEvent = {
          ...base,
          ...(typeof input.stopHookActive === "boolean"
            ? { stopHookActive: input.stopHookActive }
            : {}),
        };
        return ev;
      }
      default: {
        // Antigravity only delivers the four SUPPORTED_EVENTS. If the runtime
        // dispatches anything else, surface it loudly rather than mis-parse.
        throw new Error(`unsupported ${this.id} hook event: ${String(event)}`);
      }
    }
  }

  // ── Runtime: normalized response → Antigravity native hook reply ──────────

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const decision = response.decision ?? "allow";

    // deny → Antigravity blocks the action via a top-level `decision:"deny"` +
    // reason (the Decide category).
    if (decision === "deny") {
      return this.stdout({
        decision: "deny",
        reason: response.reason ?? "Blocked by hook",
      });
    }

    // ask → Antigravity has no native "ask"; degrade to deny to stay fail-safe.
    if (decision === "ask") {
      return this.stdout({
        decision: "deny",
        reason: response.reason ?? "Action requires user confirmation (security policy)",
      });
    }

    // modify → Transform category. camelCase: rewrite PreToolUse input via
    // updatedInput; rewrite PostToolUse output via updatedOutput.
    if (decision === "modify") {
      if (event === "PreToolUse" && response.updatedInput) {
        return this.stdout({ updatedInput: response.updatedInput });
      }
      if (event === "PostToolUse" && response.updatedOutput !== undefined) {
        return this.stdout({ updatedOutput: response.updatedOutput });
      }
      // Nothing to apply; fall through to allow.
    }

    // context → inject soft guidance via additionalContext (the SessionStart
    // context-injection path).
    if (decision === "context" && response.additionalContext) {
      return this.stdout({ additionalContext: response.additionalContext });
    }

    // allow / void / unsupported-degradation → pass through with exit 0.
    return { exitCode: 0 };
  }

  private stdout(payload: unknown): HookReply {
    return { exitCode: 0, stdout: JSON.stringify(payload) };
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

export const adapter = new AntigravityAdapter();
export default adapter;
