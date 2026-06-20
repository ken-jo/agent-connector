/**
 * adapters/goose — Block's Goose platform adapter for agent-connector.
 *
 * Goose is a json-stdio host, but its two config surfaces use DIFFERENT formats:
 *
 *   - MCP servers (Goose calls them "extensions") live in a YAML config under the
 *     root key `extensions`. Goose's `ExtensionConfig` is a `#[serde(tag="type")]`
 *     enum (crates/goose/src/agents/extension.rs); we render two of its variants:
 *       stdio → { type: "stdio", cmd: <exe>, args: [...], envs: {...}, timeout, enabled }
 *         NOTE the field is `cmd` (NOT `command`) and the env map is `envs` (NOT
 *         `env`).
 *       http  → { type: "streamable_http", uri, headers?, envs?, timeout, enabled }
 *         Goose's CURRENT remote transport is Streamable HTTP — the field is `uri`
 *         (NOT `url`). The legacy `type: "sse"` variant still deserializes for old
 *         config-file compatibility but Goose REJECTS it at connect time
 *         ("SSE is unsupported, migrate to streamable_http" —
 *         crates/goose/src/agents/extension_manager.rs), so we do NOT emit it and
 *         do NOT advertise `sse` in capabilities; an `sse`/`ws` server warn-skips.
 *     Because the file is YAML, the BaseAdapter JSON helpers do not apply — we
 *     merge via core/yaml's readYaml/writeYaml, preserving any other config.
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

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { BaseAdapter, type HookMergeDescriptor } from "../base.js";
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
  StopEvent,
  Transport,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { removeFromObjectMap, upsertInObjectMap } from "../../core/object-map.js";
import { roamingAppData } from "../../core/host-paths.js";
import { readYaml, yamlObjectMapCodec } from "../../core/yaml.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import { buildWrappedStdio, isHomeBinHookCommand } from "../../core/spawn.js";
import { renderSkillMd } from "../claude-code/render.js";
import { normalizeSessionSource } from "../claude-code/wire.js";

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
  // Goose has no post-compaction hook either — postCompact stays unset on
  // `capabilities`, so a declared PostCompact warn-skips at install.
  PostCompact: "postCompact",
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

/**
 * Goose remote extension (MCP Streamable HTTP server) — Goose's CURRENT remote
 * transport. Note the Goose-specific field name `uri` (NOT `url`); `headers` and
 * `envs` are the StreamableHttp variant's optional maps (see the `ExtensionConfig`
 * enum in crates/goose/src/agents/extension.rs).
 */
interface GooseStreamableHttpExtension {
  type: "streamable_http";
  uri: string;
  headers?: Record<string, string>;
  envs?: Record<string, string>;
  timeout: number;
  enabled: boolean;
}

type GooseExtension = GooseStdioExtension | GooseStreamableHttpExtension;

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

/**
 * Raw Goose hook stdin payload — the serialized `HookContext` struct
 * (crates/goose/src/hooks/mod.rs:162-176). Goose's HookContext carries ONLY:
 *   event, session_id, matcher_context, tool_name?, tool_input?, tool_output?,
 *   message?, working_dir?
 * It is NOT Claude-compatible: there is no `prompt`, `tool_response`, `error`,
 * `is_error`, `source`, `reason`, `stop_hook_active`, `tool_use_id`,
 * `is_interrupt`, or `duration_ms` field on the wire — reading any of those
 * (kimi #189 false-friend class) yields undefined for every event. The prompt
 * rides on `message` (`.with_message`, agent.rs:1505-1509); the tool result
 * rides on `tool_output` (NOT `tool_response`).
 */
interface GooseWireInput {
  session_id?: string;
  /** Goose names the working directory `working_dir`; `cwd` is a fallback. */
  working_dir?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** PostToolUse result field is `tool_output` (NOT Claude's `tool_response`);
   * goose's PostToolUse ctx never calls with_tool_output, so it is absent on the
   * wire — kept for forward-compat (agent.rs:534-536, hooks/mod.rs:171,200-203). */
  tool_output?: unknown;
  /** UserPromptSubmit prompt text lives here via `.with_message`
   * (agent.rs:1505-1509); goose has NO `prompt` field. */
  message?: string;
  trigger?: string;
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
    // Goose's Open Plugins runtime fires SessionEnd / UserPromptSubmit / Stop
    // (goose-docs.ai/blog/2026/05/14/goose-hooks/); parseEvent + the wire types
    // already handle all three, so they are wired (were incorrectly gated false).
    sessionEnd: true,
    userPromptSubmit: true,
    stop: true,
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
    // Goose registers two MCP extension transports: local `stdio` and remote
    // `http` (rendered as Goose's `type: "streamable_http"`). The legacy
    // `type: "sse"` variant still parses for old-config compatibility but Goose
    // refuses to connect over it ("SSE is unsupported, migrate to
    // streamable_http" — crates/goose/src/agents/extension_manager.rs), so it is
    // NOT advertised — an `sse`/`ws` server warn-skips at install.
    transports: ["stdio", "http"],
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
      return join(roamingAppData(), "Block", "goose", "config", "config.yaml");
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

    // Goose registers stdio extensions ({ type:"stdio", cmd, args }) AND remote
    // Streamable-HTTP extensions ({ type:"streamable_http", uri }). It has no
    // live SSE transport (the `sse` variant parses but Goose refuses to connect —
    // crates/goose/src/agents/extension_manager.rs), so anything else is
    // reported, never silently written as a broken empty-cmd stdio entry.
    const transport: Transport = server.transport;
    const isStdio = transport === "stdio" && !!server.command;
    const isHttp = transport === "http" && !!server.url;
    if (!isStdio && !isHttp) {
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: `transport "${transport}" not registrable in ${MCP_ROOT_KEY} (stdio + http/streamable_http only)`,
        },
      ];
    }

    const symlink = this.symlinkPathWarning(path);
    if (symlink) return [symlink];

    const entry = this.renderExtension(ctx, server);

    // Merge into existing YAML, preserving every other config key + extension.
    return [
      upsertInObjectMap({
        codec: yamlObjectMapCodec(),
        rootKey: MCP_ROOT_KEY,
        policy: "coerce",
        platform: this.id,
        configPath: path,
        entryId: connector.id,
        entry,
        dryRun,
      }),
    ];
  }

  override uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getServerConfigPath(ctx);
    const symlink = this.symlinkPathWarning(path);
    if (symlink) return [symlink];

    return [
      removeFromObjectMap({
        codec: yamlObjectMapCodec(),
        rootKey: MCP_ROOT_KEY,
        policy: "coerce",
        platform: this.id,
        configPath: path,
        entryId: connector.id,
        dryRun,
      }),
    ];
  }

  /**
   * Render a normalized ServerDef into Goose's native extension entry. Goose has
   * no native env interpolation, so `${env:VAR}` refs are resolved to literals at
   * install time.
   *
   *   stdio → { type:"stdio", cmd, args, envs?, timeout, enabled } — honors the
   *           telemetry serve-wrapper (cmd=homeBin, args=[serve…]).
   *   http  → { type:"streamable_http", uri, headers?, envs?, timeout, enabled } —
   *           a remote URL has no local command to route through the serve proxy,
   *           so it is never telemetry-wrapped; env-refs in uri/headers/env resolve
   *           to literals. The Goose field is `uri` (NOT `url`).
   */
  private renderExtension(ctx: InstallContext, server: ServerDef): GooseExtension {
    const timeoutMs = server.timeoutMs;
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0 ? Math.round(timeoutMs / 1000) : 300;

    // Remote (Streamable HTTP) — never serve-wrapped; `uri` is the Goose field.
    if (server.transport === "http") {
      const entry: GooseStreamableHttpExtension = {
        type: "streamable_http",
        uri: resolveEnvRefsDeep(server.url ?? ""),
        timeout,
        enabled: server.enabled !== false,
      };
      if (server.headers && Object.keys(server.headers).length > 0) {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(resolveEnvRefsDeep(server.headers))) {
          headers[k] = String(v);
        }
        entry.headers = headers;
      }
      if (server.env && Object.keys(server.env).length > 0) {
        const envs: Record<string, string> = {};
        for (const [k, v] of Object.entries(resolveEnvRefsDeep(server.env))) {
          envs[k] = String(v);
        }
        entry.envs = envs;
      }
      return entry;
    }

    let cmd = server.command ?? "";
    let args = [...(server.args ?? [])];

    ({ command: cmd, args } = buildWrappedStdio(ctx, server, this.id, cmd, args));

    cmd = resolveEnvRefsDeep(cmd);
    args = resolveEnvRefsDeep(args);

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
    const { connector } = ctx;
    const path = this.getHookConfigPath(ctx);

    if (connector.platforms[HOST]?.hooks === false) {
      return [{ platform: this.id, action: "skip", path, detail: "hooks disabled for goose" }];
    }
    if (connector.hookEvents.length === 0) {
      return [{ platform: this.id, action: "skip", path, detail: "connector declares no hooks" }];
    }

    const pending = connector.hookEvents.map((event) => ({
      event,
      matcher: connector.hooks[event]?.matcher ?? "",
    }));
    return this.upsertHookEntries(ctx, path, pending, this.hookDescriptor(ctx));
  }

  override uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    return this.removeHookEntries(ctx, this.getHookConfigPath(ctx), this.hookDescriptor(ctx));
  }

  /**
   * Goose's hook-merge descriptor for the shared object-map engine. Goose's hook
   * file is the DEDICATED per-connector `.agents/plugins/<id>/hooks/hooks.json`
   * (NESTED rule shape `{ matcher?, hooks:[{type,command}] }`), so every
   * observable string + ownership predicate is carried here to reproduce the
   * prior in-adapter loop byte-for-byte:
   *  - malformedPolicy "coerce" — a present-but-malformed `hooks` root (array /
   *    primitive, hand-edited) and a non-array event bucket are coerced to fresh
   *    containers, matching the old readHooksFile coerce + the `??=` bucket fill.
   *  - mapEvent = the CAPABILITY FILTER: an event Goose's Open-Plugins runtime
   *    does not deliver (e.g. UserPromptSubmit, PreCompact) maps to undefined →
   *    the engine emits the `<event> unsupported on goose — skipped` warn and
   *    never writes it; supported events map to themselves (identity).
   *  - entryOwnsCommand is connector-GENERIC (ANY of our commands in the nested
   *    inner `hooks`) — the old ruleHasOurCommand.
   *  - uninstall is NESTED: ownsEntryForRemove is never-true so the engine only
   *    runs stripInner — strip our owned inner commands, keep foreign ones, drop
   *    emptied rules. The rebuilt rule OMITS `matcher` when it was undefined
   *    (distinct from claude/droid/qwen, which always emit a matcher); `removed`
   *    is the inner-command count, surfaced in the `(<n>)` remove detail.
   */
  private hookDescriptor(ctx: InstallContext): HookMergeDescriptor<GooseHookRule> {
    return {
      malformedPolicy: "coerce",
      // CAPABILITY FILTER → identity-or-undefined: supported events map to
      // themselves; an unsupported one (capability !== true) maps to undefined,
      // routing it to the warn-skip path.
      mapEvent: (e) =>
        this.capabilities[EVENT_CAPABILITY[e as HookEventName]] === true ? e : undefined,
      unmappedWarnDetail: (e) => `${e} unsupported on goose — skipped`,
      // NESTED rule, matcher-FIRST key order (matches the old `desired`).
      renderEntry: (_event, matcher, command) => ({
        matcher,
        hooks: [{ type: "command", command }],
      }),
      // Connector-generic find (= the old ruleHasOurCommand): ANY inner command ours.
      entryOwnsCommand: (rule, _command) =>
        (rule.hooks ?? []).some((h) => this.isOurCommand(h.command, ctx)),
      // NESTED: never drop a whole rule; inner-strip only.
      ownsEntryForRemove: () => () => false,
      stripInner: (c) => (rule) => {
        const innerBefore = rule.hooks?.length ?? 0;
        const inner = (rule.hooks ?? []).filter((h) => !this.isOurCommand(h.command, c));
        return {
          // MATCHER-OMITTED-WHEN-UNDEFINED: reproduce the old rebuild exactly —
          // key order is `matcher` (only when present) then `hooks`.
          next:
            inner.length > 0
              ? { ...(rule.matcher !== undefined ? { matcher: rule.matcher } : {}), hooks: inner }
              : null,
          removed: innerBefore - inner.length,
        };
      },
      skipDetail: (e) => `hooks.${e}`,
      removeDetail: (e, n) => `hooks.${e} (${n})`,
      absentDetail: "no hooks.json",
      noMatchDetail: "no matching hook entries",
    };
  }

  /** True when a hook command is ours (anchored home-bin + connector id). */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
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
        this.writeContentFile(join(dir, "SKILL.md"), renderSkillMd(skill), ctx.dryRun),
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
        // SOURCE (hooks/mod.rs:171, agent.rs:534-536): the result field is
        // `tool_output` (NOT `tool_response`), AND goose's PostToolUse ctx is
        // built with only with_tool + with_working_dir — it never calls
        // with_tool_output — so no output is on the wire today. The read is kept
        // for forward-compat (if goose later populates tool_output it maps here).
        // There is NO `is_error` field on HookContext: goose signals failure by
        // emitting PostToolUseFailure as a DISTINCT event (agent.rs:526-531),
        // not via a boolean — so isError is never set here.
        const ev: PostToolUseEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          ...(toolOutputToString(input.tool_output) !== undefined
            ? { toolOutput: toolOutputToString(input.tool_output) }
            : {}),
        };
        return ev;
      }
      case "SessionStart": {
        // SOURCE (agent.rs:409-416 emit_hook + hooks/mod.rs:736-737 test): goose
        // emits SessionStart as a BARE HookContext::new with no builders — its
        // struct has no `source` discriminator, so there is no field to read.
        // normalizeSessionSource(undefined) → 'startup'; that is the only honest
        // value goose can supply. If goose later adds a start-reason field, map
        // it here.
        const ev: SessionStartEvent = { ...base, source: normalizeSessionSource(undefined) };
        return ev;
      }
      case "SessionEnd": {
        // SOURCE (agent.rs:409-416 emit_hook): SessionEnd is also a bare
        // HookContext with no `reason` field on the struct — goose provides no
        // end-reason on stdin (the hooks/mod.rs `reason` is the hook→host deny
        // REPLY direction, not input). The optional normalized reason is omitted.
        const ev: SessionEndEvent = { ...base };
        return ev;
      }
      case "UserPromptSubmit": {
        // SOURCE (agent.rs:1505-1509 .with_message + hooks/mod.rs:173): goose has
        // NO `prompt` field; the prompt text is carried on `message`. Reading
        // input.prompt always dropped the whole prompt — read input.message.
        const ev: UserPromptSubmitEvent = {
          ...base,
          prompt: typeof input.message === "string" ? input.message : "",
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
        // SOURCE (agent.rs:1851-1854, 2536-2539, 2575 emit_hook + hooks/mod.rs
        // :162-176): every Stop emit site constructs a bare HookContext::new
        // (Stop); the struct has no `stop_hook_active` field, so the optional
        // stopHookActive is omitted (goose emits no such boolean).
        const ev: StopEvent = { ...base };
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
        // SOURCE (agent.rs:526-537 + hooks/mod.rs:162-176): goose builds the
        // failure HookContext with ONLY with_tool + with_working_dir. The struct
        // carries no `error` text on the wire — HOST GAP: the failure message is
        // genuinely never serialized on stdin (the hooks/mod.rs `reason` is the
        // hook→host deny REPLY, not input), so the REQUIRED normalized `error`
        // stays "". There is also no `tool_use_id`, `is_interrupt`, or
        // `duration_ms` field on HookContext — those optional fields are omitted
        // (no correlation id / interrupt flag / duration is delivered).
        const ev: PostToolUseFailureEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          error: "",
        };
        return ev;
      }
      case "PermissionRequest":
      case "SubagentStart":
      case "SubagentStop":
      case "PostCompact": {
        // No Goose analog (no permission-dialog event, no subagent lifecycle
        // hooks, no post-compaction hook). Install already skip-warns these via
        // EVENT_CAPABILITY; a runtime dispatch is a mis-route — fail loudly.
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

/** Coerce a Goose PostToolUse `tool_output` (hooks/mod.rs:171) into a string. */
function toolOutputToString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const adapter = new GooseAdapter();
export default adapter;
