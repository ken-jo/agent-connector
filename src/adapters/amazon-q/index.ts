/**
 * adapters/amazon-q — Amazon Q Developer CLI platform adapter.
 *
 * Amazon Q Developer CLI (`q` / `qchat`) is a **json-stdio** host. It exposes a
 * real hooks layer (agentSpawn / userPromptSubmit / preToolUse / postToolUse /
 * stop, JSON-over-STDIN, exit-code 0/2 contract — primary-verified via
 * aws.github.io/amazon-q-developer-cli agent-format → Hooks Field). The hook
 * STDIN+exit contract is IDENTICAL to the sibling AWS host kiro; only the WRITE
 * shape differs (see below).
 *
 * Hooks live ONLY in per-agent config JSON files — there is NO global hooks.json:
 *   user    → ~/.aws/amazonq/cli-agents/<name>.json
 *   project → <projectDir>/.amazonq/cli-agents/<name>.json
 * Because hooks have no global file, AC must target a SPECIFIC agent file. We
 * mirror kiro's per-agent selection rule and write the built-in default agent
 * file — `cli-agents/q_cli_default.json`. Amazon Q auto-loads the built-in
 * `q_cli_default` agent for a new chat session (the built-in default is otherwise
 * in-memory); a file literally named `default.json` would be an INACTIVE custom
 * agent named `default` the user must explicitly select (`q chat --agent default`),
 * so hooks there would never fire — exactly the trap kiro avoids with
 * `kiro_default.json`. Primary-verified via the agent-format default
 * knowledge-base dir `~/.aws/amazonq/knowledge_bases/q_cli_default/`.
 *   A PROJECT install writes a project-scoped `q_cli_default` agent file
 *   (<projectDir>/.amazonq/cli-agents/q_cli_default.json) that SHADOWS the
 *   user-global one — a local `q_cli_default` takes precedence and auto-loads.
 *
 * The `hooks` field is an OBJECT keyed by trigger name (NOT kiro's matcher-grouped
 * array). Each entry is `{ command, matcher? }` — NO `type` field; `matcher` is
 * only meaningful for preToolUse/postToolUse:
 *   "hooks": {
 *     "agentSpawn":       [{ "command": "<cmd>" }],
 *     "userPromptSubmit": [{ "command": "<cmd>" }],
 *     "preToolUse":       [{ "command": "<cmd>", "matcher": "<toolNamePattern?>" }],
 *     "postToolUse":      [{ "command": "<cmd>", "matcher": "<optional>" }],
 *     "stop":             [{ "command": "<cmd>" }]
 *   }
 * AC MERGES into this object: it preserves ALL other agent fields (name /
 * description / mcpServers / tools / resources / user hooks) and only upserts its
 * own home-bin command into each mapped trigger array, identified by the command
 * string for idempotent re-install and clean uninstall (an emptied trigger key is
 * dropped). The shared object-map hook-array merge engine (base.ts
 * upsertHookEntries / removeHookEntries) handles this FLAT object-of-arrays shape
 * directly — the descriptor renders a flat `{ command, matcher? }` entry.
 *
 * Canonical AC event → Amazon Q trigger:
 *   SessionStart     → agentSpawn
 *   UserPromptSubmit → userPromptSubmit
 *   PreToolUse       → preToolUse
 *   PostToolUse      → postToolUse
 *   Stop             → stop
 * Events with no Amazon Q trigger (PreCompact / SessionEnd / Notification and the
 * E1 extension events) warn-skip at install time.
 *
 * Hook protocol is EXIT-CODE based (identical to kiro): exit 0 = allow, exit 2 =
 * block (preToolUse only; STDERR is returned to the LLM). Amazon Q cannot rewrite
 * tool args or output, so canModifyArgs / canModifyOutput are false.
 *
 * MCP config (legacy files, primary-verified via AWS docs) — UNCHANGED by the
 * hooks wiring; the MCP server surface still targets the global/workspace mcp.json:
 *   - user scope    → ~/.aws/amazonq/mcp.json   (global; applies to all workspaces)
 *   - project scope → <projectDir>/.amazonq/mcp.json   (local workspace)
 *   Both are JSON, root key "mcpServers". Amazon Q reads BOTH when both exist
 *   and merges them (union); workspace wins on same-name conflict with a warning.
 *
 * Server entry shape (primary-verified):
 *   - stdio: { command: string; args?: string[]; env?: { [k: string]: string };
 *              timeout?: number }   (timeout in MILLISECONDS, e.g. 60000;
 *              transport inferred from presence of `command` — no `type` key)
 *   - http:  { type: "http"; url: string }
 *             (the remote/HTTP shape is written with an explicit `type: "http"`
 *              discriminator + `url`, per command-line-mcp-config-CLI.html. No
 *              `headers` field — Amazon Q remote auth is OAuth, not static
 *              headers — and no `disabled` flag.)
 *
 * Path resolution — NOTE the nested user scope:
 *   - user:    join(homedir(), ".aws", "amazonq")  (two path segments)
 *   - project: join(projectDir, ".amazonq")         (single dotDir, no .aws)
 *   homedir() handles USERPROFILE on Windows automatically; no manual branch.
 *
 * Env interpolation: Amazon Q has no documented native ${env:VAR} token;
 * resolve all references to literals at install time (the safe path, same as
 * droid/crush).
 *
 * Memory / rules (primary-verified — docs.aws.amazon.com context-project-rules):
 *   Project rules are plain Markdown files in <projectDir>/.amazonq/rules; Amazon
 *   Q "will automatically use them as context whenever a developer chats with
 *   Amazon Q within your project". NO frontmatter required. We write a DEDICATED
 *   agent-connector-owned file there (`.amazonq/rules/agent-connector.md`),
 *   mirroring the cline `.clinerules/agent-connector.md` approach: memoryTargets()
 *   points at the dedicated file and the base managed-block engine performs the
 *   surgical, hash-stamped, uninstall-reversible write. PROJECT SCOPE ONLY — the
 *   AWS docs do not cleanly document a user/global rules directory for the CLI
 *   (a `~/.aws/amazonq/.../rules` path is unverified), so user scope returns [] →
 *   the base installMemory skip-warns rather than writing into an unread path.
 *
 * Hook config path targets the built-in default agent file
 * (cli-agents/q_cli_default.json), which is a DIFFERENT file from the MCP mcp.json
 * (getHookConfigPath ≠ getServerConfigPath), mirroring kiro's split surfaces.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BaseAdapter, type HookMergeDescriptor } from "../base.js";
import type { Adapter, HookReply, InstallContext, MemoryTarget, NormalizedEvent } from "../spi.js";
import type {
  ChangeRecord,
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
  StopEvent,
  Transport,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildWrappedStdio,
  isHomeBinHookCommand,
} from "../../core/spawn.js";
import { normalizeSessionSource } from "../claude-code/wire.js";

const HOST: PlatformId = "amazon-q";
const MCP_ROOT_KEY = "mcpServers";

/**
 * The built-in default agent file AC registers hooks on. Amazon Q auto-loads the
 * built-in `q_cli_default` agent for a new chat session (the built-in default is
 * otherwise in-memory). A file literally named `default.json` would be an INACTIVE
 * custom agent named `default` that the user must explicitly select
 * (`q chat --agent default`), so hooks merged there would never fire — we register
 * on `q_cli_default.json` instead (mirrors kiro's `kiro_default.json` selection;
 * primary-verified via the agent-format default knowledge-base dir
 * `knowledge_bases/q_cli_default/`).
 */
const DEFAULT_AGENT_FILE = "q_cli_default.json";

/**
 * Amazon Q native hook trigger names (the keys under an agent file's `hooks`
 * object). Only the triggers Amazon Q fires for the json-stdio command paradigm.
 */
const Q_TRIGGER = {
  preToolUse: "preToolUse",
  postToolUse: "postToolUse",
  agentSpawn: "agentSpawn",
  userPromptSubmit: "userPromptSubmit",
  stop: "stop",
} as const;

/**
 * Map canonical event names → Amazon Q's native trigger names. Only mapped
 * events are present; PreCompact / SessionEnd / Notification and the E1
 * extension events have no Amazon Q equivalent → warn-skip at install time.
 */
const EVENT_MAP: Partial<Record<HookEventName, string>> = {
  SessionStart: Q_TRIGGER.agentSpawn,
  UserPromptSubmit: Q_TRIGGER.userPromptSubmit,
  PreToolUse: Q_TRIGGER.preToolUse,
  PostToolUse: Q_TRIGGER.postToolUse,
  Stop: Q_TRIGGER.stop,
};

/** Triggers whose `matcher` is meaningful (tool-name pattern). Others omit it. */
const MATCHER_TRIGGERS: ReadonlySet<string> = new Set([
  Q_TRIGGER.preToolUse,
  Q_TRIGGER.postToolUse,
]);

/**
 * A single Amazon Q native hook entry: FLAT `{ command, matcher? }` (NO `type`
 * field — unlike kiro's matcher-grouped nested shape).
 */
interface AmazonQHookEntry {
  command: string;
  matcher?: string;
}

/** The shape of an Amazon Q agent file (only the parts we touch). */
interface AmazonQAgentFile {
  hooks?: Record<string, AmazonQHookEntry[]>;
  [key: string]: unknown;
}

/** Raw Amazon Q CLI hook stdin payload (snake_case wire fields, == kiro's). */
interface AmazonQWireInput {
  connector?: unknown;
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  source?: string;
  prompt?: string;
  stop_hook_active?: boolean;
}

/**
 * Native MCP server entry shapes Amazon Q accepts under `mcpServers`.
 *   - stdio: BARE shape — NO `type` discriminator and NO `disabled` flag; the
 *     transport is inferred from the presence of `command`. timeout is in
 *     MILLISECONDS (pass timeoutMs through unchanged, do NOT divide).
 *   - http: REMOTE shape — explicit `type: "http"` + `url`
 *     (command-line-mcp-config-CLI.html). NO `headers` (remote auth is OAuth,
 *     not static headers) and NO `disabled` flag.
 */
interface AmazonQStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
}
interface AmazonQHttpServer {
  type: "http";
  url: string;
}

export class AmazonQAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Amazon Q Developer CLI";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: WIRED. Amazon Q reads `.amazonq/rules` (NOT AGENTS.md), so
    // the AGENTS.md-first BaseAdapter default does not apply — memoryTargets()
    // below overrides it to write a DEDICATED agent-connector-owned file
    // (<projectDir>/.amazonq/rules/agent-connector.md, plain Markdown, no
    // frontmatter — auto-applied as context per the AWS docs). Project scope
    // only; user scope skip-warns (no verified user/global rules dir).
    supportsMemory: true,
    //
    // Hooks: Amazon Q fires agentSpawn / userPromptSubmit / preToolUse /
    // postToolUse / stop (mapped from SessionStart / UserPromptSubmit /
    // PreToolUse / PostToolUse / Stop). It has no PreCompact / SessionEnd /
    // Notification equivalent, nor the E1 extension events (PermissionRequest /
    // PostToolUseFailure / SubagentStart / SubagentStop) — those warn-skip.
    preToolUse: true,
    postToolUse: true,
    preCompact: false,
    sessionStart: true,
    sessionEnd: false,
    userPromptSubmit: true,
    stop: true,
    notification: false,
    // Exit-code protocol only — a hook can allow (0) or block (2), but it CANNOT
    // rewrite tool args or output.
    canModifyArgs: false,
    canModifyOutput: false,
    // agentSpawn returns additionalContext via JSON stdout (mirrors kiro).
    canInjectSessionContext: true,
    // Amazon Q registers stdio + Streamable HTTP MCP servers (primary-verified).
    transports: ["stdio", "http"],
    // Content surfaces: Amazon Q DOES have user-authored surfaces — agents
    // (per-agent JSON in ~/.aws/amazonq/cli-agents/*.json or project
    // .amazonq/cli-agents/*.json: name/description/prompt/tools/hooks/resources;
    // agent-format.md) and a prompt library (~/.aws/amazonq/prompts/*.md). AC does
    // not render either yet, so the supports* flags stay UNSET (base skip-warns) —
    // a deferred wiring opportunity, NOT an absent surface.
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".aws", "amazonq");
    const userMcp = join(userDir, "mcp.json");
    const projDir = join(projectDir, ".amazonq");
    const projMcp = join(projDir, "mcp.json");

    const userInstalled = existsSync(userDir) || existsSync(userMcp);
    const projInstalled = existsSync(projDir) || existsSync(projMcp);
    const installed = userInstalled || projInstalled;
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projMcp : userMcp;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? `found Amazon Q config (${scope}) at ${configPath}`
        : `no Amazon Q mcp.json at ${userDir} or ${projDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  /**
   * Config directory per scope. Amazon Q uses DIFFERENT basenames:
   *   user:    ~/.aws/amazonq   (two segments — NOT a single dotDir)
   *   project: <projectDir>/.amazonq
   * This is the ONE deviation from droid/cursor's single-basename getConfigDir.
   */
  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".amazonq")
      : join(homedir(), ".aws", "amazonq");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "mcp.json");
  }

  /**
   * Hooks live in a per-agent file, NOT the mcp.json. Amazon Q hooks have no
   * global file, so AC targets the built-in `q_cli_default` agent file at the
   * install scope (mirroring kiro's default-agent selection):
   *   user    → ~/.aws/amazonq/cli-agents/q_cli_default.json
   *   project → <projectDir>/.amazonq/cli-agents/q_cli_default.json
   * A project install writes a project-scoped `q_cli_default` that SHADOWS the
   * user-global one (a local `q_cli_default` takes precedence and auto-loads).
   */
  getHookConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "cli-agents", DEFAULT_AGENT_FILE);
  }

  // ── Memory surface: the `.amazonq/rules` content tree ─────────────────────
  // Amazon Q uses `.amazonq/rules` (NOT AGENTS.md) for its OWN project rules, so
  // this override replaces the AGENTS.md base default entirely:
  //   project → <projectDir>/.amazonq/rules/agent-connector.md  (DEDICATED file
  //             AC owns; plain Markdown, auto-applied — no frontmatter needed)
  //   user    → [] (no verified user/global rules dir → base installMemory
  //             skip-warns rather than guessing a path the CLI may not read)
  // When `.amazonq/rules` exists as a single FILE (not a directory) we must NOT
  // create `.amazonq/rules/agent-connector.md` underneath it (that would throw
  // ENOTDIR), so memoryTargets() returns [] and installMemory() emits a precise
  // skip-warn rather than crashing (the cline `.clinerules`-is-a-file precedent).
  protected override memoryTargets(ctx: InstallContext): MemoryTarget[] {
    // An explicit platforms[amazon-q].memory.path override wins (escape hatch).
    if (this.memoryOverride(ctx)?.path) return super.memoryTargets(ctx);
    if (ctx.scope === "project") {
      if (this.rulesDirIsFile(ctx.projectDir)) return [];
      return [
        {
          path: join(ctx.projectDir, ".amazonq", "rules", "agent-connector.md"),
          reason: "amazon-q project rules dir (.amazonq/rules; agent-connector-owned file)",
        },
      ];
    }
    // user scope: no primary-verified user/global rules dir → [] → skip-warn.
    return [];
  }

  /**
   * Override installMemory ONLY to surface a precise warn when `.amazonq/rules`
   * exists as a single FILE at project scope (so memoryTargets() returned []):
   * we never write under it. All other behavior delegates to the base
   * implementation (the cline `.clinerules`-is-a-file precedent).
   */
  override installMemory(ctx: InstallContext): ChangeRecord[] {
    if (
      ctx.scope === "project" &&
      !this.memoryOverride(ctx)?.path &&
      (ctx.connector.memory ?? []).length > 0 &&
      ctx.connector.platforms[this.id]?.memory !== false &&
      this.rulesDirIsFile(ctx.projectDir)
    ) {
      return [
        {
          platform: this.id,
          action: "warn",
          path: join(ctx.projectDir, ".amazonq", "rules"),
          detail:
            "existing .amazonq/rules is a file, not a directory; left untouched — " +
            "convert it to a .amazonq/rules/ directory to receive agent-connector memory",
        },
      ];
    }
    return super.installMemory(ctx);
  }

  /** True when `<dir>/.amazonq/rules` exists and is a regular FILE (not a dir). */
  private rulesDirIsFile(dir: string): boolean {
    const p = join(dir, ".amazonq", "rules");
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
            ? "server registration disabled for amazon-q"
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

  /** Render a normalized ServerDef into Amazon Q's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): AmazonQStdioServer | AmazonQHttpServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

      // Transparent telemetry wrapping: route the real command through
      // `<homeBin> serve --connector <id> -- <command> <args...>`.
      ({ command, args } = buildWrappedStdio(ctx, server, this.id, command, args));

      // Amazon Q has no documented native interpolation token — resolve every
      // ${env:VAR} to a literal at install time (safe path, matches droid/crush).
      const entry: AmazonQStdioServer = {
        command: resolveEnvRefsDeep(command),
      };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      // timeout: Amazon Q uses MILLISECONDS — pass timeoutMs through unchanged.
      // Only emit when the connector explicitly sets one (do NOT invent a default).
      if (server.timeoutMs !== undefined) entry.timeout = server.timeoutMs;
      return entry;
    }

    // http (and any other remote transport) — Amazon Q registers a remote URL.
    // REMOTE shape: { type: "http", url } — explicit `type` discriminator, NO
    // `headers` (OAuth auth, not static headers), NO `disabled`.
    return {
      type: "http",
      url: resolveEnvRefsDeep(server.url ?? ""),
    };
  }

  /**
   * Render stdio env values. Amazon Q has no documented native interpolation
   * token, so resolve `${env:VAR}` references to literals at install time.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hook install / uninstall (merge into the default agent file) ──────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.hooks === false) {
      return [{ platform: this.id, action: "skip", detail: "hooks disabled for amazon-q" }];
    }
    if (connector.hookEvents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no hooks" }];
    }

    const pending = connector.hookEvents.map((event) => ({
      event,
      matcher: connector.hooks[event]?.matcher ?? "",
    }));
    return this.upsertHookEntries(
      ctx,
      this.getHookConfigPath(ctx),
      pending,
      this.hookDescriptor(),
    );
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    return this.removeHookEntries(ctx, this.getHookConfigPath(ctx), this.hookDescriptor());
  }

  /**
   * Amazon Q's hook-merge descriptor (FLAT object-of-arrays shape — each entry is
   * `{ command, matcher? }`, NO `type` field, unlike kiro's nested
   * `{ matcher, hooks:[...] }`).
   *  - mapEvent = EVENT_MAP (canonical → Amazon Q trigger); unmapped events
   *    (PreCompact / SessionEnd / Notification + the E1 set) warn-skip.
   *  - renderEntry emits `{ command }`, adding `matcher` ONLY for the
   *    matcher-meaningful triggers (preToolUse/postToolUse) when one is declared;
   *    an empty matcher = all tools, so it is OMITTED (no `matcher: ""` noise).
   *  - entryOwnsCommand / ownsEntryForRemove match the home-bin command string
   *    (idempotency on re-install; whole-entry removal on uninstall). FLAT host →
   *    no stripInner; an emptied trigger key is dropped by the engine.
   */
  private hookDescriptor(): HookMergeDescriptor<AmazonQHookEntry> {
    return {
      mapEvent: (e) => EVENT_MAP[e as HookEventName],
      unmappedWarnDetail: (e) => `${e} has no Amazon Q hook equivalent — skipped`,
      renderEntry: (trigger, matcher, command) => {
        const entry: AmazonQHookEntry = { command };
        if (matcher && MATCHER_TRIGGERS.has(trigger)) entry.matcher = matcher;
        return entry;
      },
      entryOwnsCommand: (entry, command) => entry.command === command,
      ownsEntryForRemove: (c) => (entry) => this.isOurCommand(entry.command, c),
      skipDetail: (trigger) => `hooks.${trigger} already registered`,
      removeDetail: (trigger, removed) => `hooks.${trigger} (${removed})`,
      absentDetail: "no hooks section present",
      noMatchDetail: "no matching hook entries",
    };
  }

  /** True when a hook command references our home binary AND this connector id
   *  (anchored so a shared-prefix id can't collide — see isHomeBinHookCommand). */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const mcpPath = this.getServerConfigPath(ctx);
    const agentPath = this.getHookConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const hookEvents = ctx.connector.hookEvents;
    return [
      {
        name: `${this.name}: mcp.json present`,
        check: () =>
          existsSync(mcpPath)
            ? { status: "OK", detail: mcpPath }
            : { status: "FAIL", detail: `not found: ${mcpPath}` },
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
        name: `${this.name}: hook command registered`,
        check: () => {
          if (hookEvents.length === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          const agent = this.readJson<AmazonQAgentFile>(agentPath);
          if (!agent) return { status: "FAIL", detail: `cannot read ${agentPath}` };
          const hooks = agent.hooks ?? {};
          const registered = Object.values(hooks).some((entries) =>
            (entries ?? []).some((e) => isHomeBinHookCommand(e.command, homeBin, connectorId)),
          );
          return registered
            ? { status: "OK", detail: "hook command present" }
            : { status: "FAIL", detail: `no hook for ${connectorId} in ${agentPath}` };
        },
      },
    ];
  }

  // ── Runtime: parse Amazon Q stdin JSON → normalized event ─────────────────
  // Amazon Q's stdin payload shape and exit-code contract are IDENTICAL to kiro's,
  // so this parse + the formatReply below mirror the kiro adapter exactly.

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as AmazonQWireInput;
    const connectorId = typeof input.connector === "string" ? input.connector : "";
    const sessionId = typeof input.session_id === "string" ? input.session_id : "";
    const projectDir = typeof input.cwd === "string" ? input.cwd : undefined;

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
        const ev: PostToolUseEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          ...(toolResponseToString(input.tool_response) !== undefined
            ? { toolOutput: toolResponseToString(input.tool_response) }
            : {}),
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
      default: {
        // Amazon Q never delivers PreCompact / SessionEnd / Notification nor the
        // E1 extension events (no native triggers). If the runtime dispatches one
        // anyway, surface it loudly rather than silently mis-parse.
        throw new Error(`unsupported amazon-q hook event: ${String(event)}`);
      }
    }
  }

  // ── Runtime: normalized response → Amazon Q native (exit-code) hook reply ──

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const decision = response.decision ?? "allow";

    // deny → block the action: exit 2 with the reason on stderr.
    if (decision === "deny") {
      return { exitCode: 2, stderr: response.reason ?? "Blocked by hook" };
    }

    // ask → Amazon Q has no native "ask"; degrade to deny (exit 2) to stay fail-safe.
    if (decision === "ask") {
      return {
        exitCode: 2,
        stderr: response.reason ?? "Action requires user confirmation (security policy)",
      };
    }

    // Stop → exit-code only (deny already handled above). No context channel on a
    // Stop hook, so anything non-deny passes through with exit 0.
    if (event === "Stop") {
      return { exitCode: 0 };
    }

    // context → inject soft guidance. Amazon Q reads agentSpawn additionalContext
    // from stdout JSON (mirrors the kiro/Claude SessionStart shape). exit 0 = allow.
    if (decision === "context" && response.additionalContext) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: Q_TRIGGER.agentSpawn,
            additionalContext: response.additionalContext,
          },
        }),
      };
    }

    // modify is unsupported (exit-code protocol — cannot rewrite args/output);
    // allow / void → pass through with exit 0.
    return { exitCode: 0 };
  }
}

/** Coerce an Amazon Q PostToolUse `tool_response` into a string for the normalized event. */
function toolResponseToString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const adapter = new AmazonQAdapter();
export default adapter;
