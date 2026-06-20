/**
 * adapters/amp — Amp (Sourcegraph / AmpCode) platform adapter for agent-connector.
 *
 * Amp is a **ts-plugin** host: alongside MCP it loads TypeScript plugin modules
 * from `.amp/plugins/<name>.ts`, each default-exporting a function `(amp) => void`
 * that registers lifecycle handlers via `amp.on("<event>", async (event, ctx) =>
 * …)` (ampcode.com/manual → Plugins). This adapter wires the five amp.on events
 * that have a canonical analog and bridges them to the universal home-bin
 * entrypoint, exactly like the OMP / OpenCode ts-plugin adapters.
 *
 * Event mapping (only events the connector declares are subscribed):
 *   SessionStart     → amp.on("session.start", …)  (thread begins; id = event.thread.id)
 *   UserPromptSubmit → amp.on("agent.start",  …)   (user submits a prompt; observe-only)
 *   PreToolUse       → amp.on("tool.call",     …)   (before a tool runs; deny → return
 *                       { action: "reject-and-continue" }, else { action: "allow" })
 *   PostToolUse      → amp.on("tool.result",   …)   (after a tool finishes; observe-only)
 *   Stop             → amp.on("agent.end",     …)   (turn ends; observe-only)
 * Amp documents NO session.end event, so SessionEnd is an honest gap (warn-skip
 * via the unsupported-here detail). tool.call's decision surface is the
 * { action } union (canModifyArgs:false — the "modify" input shape is not
 * documented); tool.result CAN return a replacement but the manual never
 * documents its object shape, so PostToolUse is observe-only (canModifyOutput:
 * false) rather than ship a guessed mutation; session.start has no documented
 * context-injection surface (canInjectSessionContext:false).
 *
 * Why we SYNTHESIZE a self-contained module instead of importing handlers:
 *   the connector's hook handlers are arbitrary developer code we must not import
 *   into Amp's (Bun) runtime — wrong cwd, wrong deps, version skew. So, like the
 *   OMP / OpenCode adapters, we generate a tiny ESM/TS plugin that imports NOTHING
 *   from agent-connector: each `amp.on(...)` handler shells out to the ONE stable
 *   home binary's universal entrypoint (`<homeBin> hook amp <event> --connector
 *   <id>`) over child_process, feeds it the amp-shaped payload as JSON on stdin,
 *   and JSON.parses the normalized HookResponse back from stdout. Fail-open: any
 *   bridge error → no-op. One entrypoint, every paradigm.
 *
 * Plugin scope: the `.amp/plugins/` dir is documented at PROJECT scope only; Amp
 * documents no user-scope plugins dir, so installHooks writes the plugin for
 * project scope and warn-skips user scope (the MCP + skills surfaces keep their
 * own user-scope paths). MCP config (report §2 / §5.3):
 *   - user scope    → ~/.config/amp/settings.json
 *   - project scope → <projectDir>/.amp/settings.json
 *   Both are JSONC (we write plain JSON, which is valid JSONC). The settings file
 *   is SHARED with the rest of Amp's configuration, so we MERGE our entry into
 *   the existing object and never clobber unrelated keys.
 *
 * QUIRK 1 — dotted top-level key: Amp does NOT use a nested `mcpServers` object.
 * The MCP registry is a single FLAT settings key literally named
 * `"amp.mcpServers"`, whose value is an object of `{ id: { command, args, env } }`.
 * We therefore set `settings["amp.mcpServers"][connectorId] = entry`. Because the
 * base JSON helpers index `config[rootKey][serverId]`, passing the dotted string
 * as the root key writes exactly that flat key while preserving every sibling
 * setting (true merge).
 *
 * QUIRK 2 — native interpolation: Amp expands `${VAR_NAME}` in stdio entries at
 * runtime, so we KEEP env/header/url refs native by rewriting the portable
 * `${env:VAR}` syntax to Amp's `${VAR}` token rather than resolving to literals
 * (secrets stay out of the settings file).
 *
 * Skills surface: Amp reads SKILL.md files (dir-per-skill, same shape as
 * claude-code) from a skill root that is NOT under the config dir
 * (`~/.config/amp`):
 *   - user scope    → ~/.config/agents/skills/<name>/SKILL.md  (the sibling
 *     cross-agent `agents` dir — `~/.config/amp/skills/` is also documented-native,
 *     but the `agents` root is the cross-agent standard we standardize on)
 *   - project scope → <projectDir>/.agents/skills/<name>/SKILL.md
 * Because that root differs from getConfigDir, skills use a dedicated skillDir()
 * helper rather than reusing getConfigDir.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BaseAdapter } from "../base.js";
import type {
  Adapter,
  GeneratedPluginFile,
  HookReply,
  InstallContext,
  NormalizedEvent,
} from "../spi.js";
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
  SkillDef,
  StopEvent,
  Transport,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { rewriteEnvRefs } from "../../core/interpolate.js";
import { renderBridgePrelude } from "../../core/ts-plugin-bridge.js";
import {
  buildWrappedStdio,
} from "../../core/spawn.js";
import { renderSkillMd } from "../claude-code/render.js";

const HOST: PlatformId = "amp";
/**
 * QUIRK: a single FLAT, dotted settings key — NOT a nested object. The base
 * JSON helpers treat this as `config["amp.mcpServers"][serverId]`.
 */
const MCP_ROOT_KEY = "amp.mcpServers";

/**
 * Canonical → Amp plugin event name map. A connector hook event is only
 * subscribed by the generated plugin when it appears here AND is declared by the
 * connector. Names verified against ampcode.com/manual (Plugins → amp.on events).
 * Amp documents NO `session.end`, so SessionEnd has no entry (honest gap).
 */
const EVENT_TO_AMP: Partial<Record<HookEventName, string>> = {
  SessionStart: "session.start",
  UserPromptSubmit: "agent.start",
  PreToolUse: "tool.call",
  PostToolUse: "tool.result",
  Stop: "agent.end",
};

/** Raw payload the generated plugin posts to the universal hook entrypoint. */
interface AmpBridgePayload {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  // ToolResultEvent.output is typed `unknown` by the host (@ampcode/plugin
  // index.d.ts:947 — "Tool output/result if available"), so the bridge may
  // forward a string OR a structured value; parseEvent stringifies non-strings.
  toolOutput?: unknown;
  isError?: boolean;
  prompt?: string;
  sessionId?: string;
  projectDir?: string;
}

/** Native MCP server entry shapes Amp accepts under `amp.mcpServers`. */
interface AmpStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
interface AmpHttpServer {
  url: string;
  headers?: Record<string, string>;
}

export class AmpAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Amp";
  readonly paradigm: HookParadigm = "ts-plugin";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block via the BaseAdapter default
    // (memoryTargets: project <projectDir>/AGENTS.md; user scope where documented).
    supportsMemory: true,
    // amp.on lifecycle events with a canonical analog (EVENT_TO_AMP):
    // tool.call / tool.result / session.start / agent.start / agent.end.
    preToolUse: true,
    postToolUse: true,
    // Amp has no documented compaction hook.
    preCompact: false,
    sessionStart: true,
    // Amp documents NO session.end event — SessionEnd is an honest gap.
    sessionEnd: false,
    userPromptSubmit: true,
    stop: true,
    notification: false,
    // Newer events: Amp documents no permission/approval, post-tool-failure, or
    // subagent lifecycle hook with a canonical analog, so permissionRequest /
    // postToolUseFailure / subagentStart / subagentStop stay unset — the
    // generated bridge never references them and install reports them as
    // "unsupported here".
    // tool.call's documented decision surface is { action: "allow" |
    // "reject-and-continue" | "modify" | "synthesize" } (ampcode.com/manual →
    // Plugins → tool.call). We wire allow + reject-and-continue (block); the
    // "modify" input-rewrite shape is not byte-documented, so canModifyArgs:false.
    canModifyArgs: false,
    // tool.result says "return a replacement status/output" but the manual never
    // documents the replacement OBJECT SHAPE (which keys). Rather than guess it,
    // PostToolUse is observe-only and canModifyOutput stays false until the shape
    // is primary-source-verified (honesty bar: under-claim, never emit a guessed
    // mutation contract).
    canModifyOutput: false,
    // session.start has no documented context-injection surface.
    canInjectSessionContext: false,
    // Amp registers stdio and Streamable HTTP MCP servers.
    transports: ["stdio", "http"],
    // Skills: Amp reads SKILL.md from ~/.config/agents/skills/<name>/SKILL.md
    // (user) and <projectDir>/.agents/skills/<name>/SKILL.md (project) — a root
    // OUTSIDE the config dir, so the skillDir() helper resolves it explicitly.
    supportsSkills: true,
    // Native passthrough hooks: amp.on events with no canonical HookEventName
    // analog are reachable via platforms["amp"].nativeHooks; the generated plugin
    // registers + bridges each declared native event verbatim and the home-bin
    // runtime dispatches it host-generically via runNativeHook.
    supportsNativeHooks: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".config", "amp");
    const userSettings = join(userDir, "settings.json");
    const projectDirAmp = join(projectDir, ".amp");
    const projectSettings = join(projectDirAmp, "settings.json");

    const userInstalled = existsSync(userDir) || existsSync(userSettings);
    const projectInstalled = existsSync(projectDirAmp) || existsSync(projectSettings);
    const installed = userInstalled || projectInstalled;
    const scope = projectInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projectSettings : userSettings;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? `found Amp config (${scope}) at ${configPath}`
        : `no Amp config at ${userSettings} or ${projectSettings}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".amp")
      : join(homedir(), ".config", "amp");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "settings.json");
  }

  /**
   * For this ts-plugin host the "hook config path" is the generated plugin
   * MODULE. Amp loads every `.ts` file in `.amp/plugins/`, so writing this file
   * IS the registration. The `.amp/plugins/` dir is documented at PROJECT scope
   * (Amp documents no user-scope plugins dir — see pluginsDir); the user-scope
   * path is returned for doctor/uninstall symmetry but installHooks warn-skips it.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return join(this.pluginsDir(ctx), `${ctx.connector.id}.ts`);
  }

  /**
   * Plugin directory Amp auto-loads `.ts` modules from. PROJECT scope is the
   * documented `<projectDir>/.amp/plugins`; user scope mirrors the MCP config dir
   * (`~/.config/amp/plugins`) for path symmetry only — installHooks never writes
   * there because Amp documents no user-scope plugins dir.
   */
  private pluginsDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".amp", "plugins")
      : join(this.getConfigDir(ctx), "plugins");
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
            ? "server registration disabled for amp"
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

    // Upsert into the flat "amp.mcpServers" key, merging into existing settings.
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

  /** Render a normalized ServerDef into Amp's native `amp.mcpServers` entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): AmpStdioServer | AmpHttpServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

      // Transparent telemetry wrapping: route the real command through
      // `<homeBin> serve --connector <id> -- <command> <args...>`.
      ({ command, args } = buildWrappedStdio(ctx, server, this.id, command, args));

      // Amp expands ${VAR_NAME} natively, so keep refs native (no literals).
      const entry: AmpStdioServer = { command: this.rewrite(command) };
      if (args.length > 0) entry.args = args.map((a) => this.rewrite(a));
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // http (and any other remote transport we surface) — Amp registers a URL.
    const entry: AmpHttpServer = { url: this.rewrite(server.url ?? "") };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Amp supports native `${VAR_NAME}` interpolation,
   * so translate `${env:VAR}` refs to that native token rather than baking
   * secrets into the file. Literals pass through unchanged.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) out[k] = this.rewrite(v);
    return out;
  }

  /** Translate `${env:VAR(:-default)}` to Amp's native `${VAR}` token. */
  private rewrite(value: string): string {
    return rewriteEnvRefs(value, ampEnvToken);
  }

  // ── Skills surface ───────────────────────────────────────────────────────
  // CONTENT-ONLY: pure native-file writers under the skill root. No runtime
  // dispatch, no home-bin pointer, no telemetry wrap. Idempotent (byte-identical
  // → skip) via writeContentFile and reversible via removeContentFile. Honors
  // platforms["amp"].skills === false to skip.
  //
  // QUIRK: the skill root is NOT under getConfigDir (~/.config/amp). Amp reads
  // SKILL.md from the sibling cross-agent `agents` tree:
  //   user scope    → ~/.config/agents/skills/<name>/SKILL.md
  //   project scope → <projectDir>/.agents/skills/<name>/SKILL.md
  // so skillDir() resolves it explicitly rather than reusing getConfigDir.

  /** Skill root: user `~/.config/agents/skills`, project `<projectDir>/.agents/skills`. */
  private skillsDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".agents", "skills")
      : join(homedir(), ".config", "agents", "skills");
  }

  /** Native skill dir: <skillRoot>/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for amp" }];
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

  /** Render a skill's SKILL.md (delegates to the shared renderer). */
  private renderSkill(skill: SkillDef): string {
    return renderSkillMd(skill);
  }

  // ── Hook install / uninstall (ts-plugin module) ──────────────────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const pluginPath = this.getHookConfigPath(ctx);

    // Amp documents no user-scope plugins dir — only `.amp/plugins/` at project
    // scope. Degradation is never silent: warn-skip rather than write to an
    // unverified user path.
    if (ctx.scope !== "project") {
      return [
        {
          platform: this.id,
          action: "warn",
          path: pluginPath,
          detail:
            "amp plugins are project-scoped (.amp/plugins/) — no user-scope plugins dir is documented; skipped",
        },
      ];
    }

    // Native passthrough events are a sibling, amp-scoped declaration: `hooks:
    // false` disables only the CANONICAL events, and the generated native loop
    // reads platforms.amp.nativeHooks directly (independent of hookEvents). So
    // whenever native events exist the plugin must still be synthesized.
    const canonicalDisabled = ctx.connector.platforms[HOST]?.hooks === false;
    const hasCanonical = !canonicalDisabled && ctx.connector.hookEvents.length > 0;
    const hasNative = this.nativeHookEvents(ctx).length > 0;

    if (!hasCanonical && !hasNative) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: pluginPath,
          detail: canonicalDisabled
            ? "hooks disabled for amp"
            : "connector declares no hooks",
        },
      ];
    }

    const files = this.synthesizePlugin(ctx);
    const changes: ChangeRecord[] = [];

    for (const file of files) {
      changes.push(
        this.writeManagedFile(
          file.path,
          file.contents,
          ctx.dryRun,
          `amp plugin module (${this.hookDetail(ctx)})`,
          file.executable,
        ),
      );
    }

    return changes;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const pluginPath = this.getHookConfigPath(ctx);
    return [
      this.removeManagedFile(pluginPath, ctx.dryRun, "amp plugin module", "no amp plugin module present"),
    ];
  }

  /**
   * Human-facing summary of which declared events the synthesized module ACTUALLY
   * wires. Only events present in EVENT_TO_AMP are mapped/wired; any declared
   * event with no Amp mapping (e.g. SessionEnd) is reported separately as
   * "unsupported here" so the detail never overstates coverage.
   */
  private hookDetail(ctx: InstallContext): string {
    // `hooks: false` suppresses the canonical handlers, so the detail must not
    // claim them; native events are still reported below.
    const canonicalOff = ctx.connector.platforms[HOST]?.hooks === false;
    const declared = canonicalOff ? [] : ctx.connector.hookEvents;
    const mapped = declared.filter((e) => EVENT_TO_AMP[e] !== undefined);
    const unsupported = declared.filter((e) => EVENT_TO_AMP[e] === undefined);
    const native = this.nativeHookEvents(ctx);
    const parts: string[] = [];
    if (mapped.length > 0) parts.push(mapped.join(","));
    if (native.length > 0) parts.push(`native: ${native.join(",")}`);
    const base = parts.join("; ") || "no canonical hooks";
    return unsupported.length > 0
      ? `${base}; unsupported here: ${unsupported.join(",")}`
      : base;
  }

  /**
   * Amp-native passthrough events declared on platforms["amp"].nativeHooks
   * (amp.on event names with no canonical HookEventName analog). Emitted as
   * generic bridge registrations and dispatched host-generically by the home-bin's
   * runNativeHook.
   */
  private nativeHookEvents(ctx: InstallContext): string[] {
    return Object.keys(ctx.connector.platforms[HOST]?.nativeHooks ?? {});
  }

  // ── ts-plugin synthesis ──────────────────────────────────────────────────

  /**
   * Build ONE self-contained Amp plugin module (`.amp/plugins/<id>.ts`). It
   * imports nothing from agent-connector; each `amp.on(...)` handler shells out to
   * the universal hook entrypoint via child_process and applies the normalized
   * HookResponse. Its default export is the Amp plugin function `(amp) => void`.
   */
  synthesizePlugin(ctx: InstallContext): GeneratedPluginFile[] {
    const path = this.getHookConfigPath(ctx);
    const contents = this.buildPluginSource(ctx);
    return [{ path, contents, executable: false }];
  }

  /** Compose the generated plugin source with plain string concatenation. */
  private buildPluginSource(ctx: InstallContext): string {
    // `platforms.amp.hooks === false` disables only the CANONICAL events (the
    // native loop below reads platforms.amp.nativeHooks directly and is a sibling,
    // unaffected). When canonical hooks are off the module may still be
    // synthesized for native events, so the canonical handler set collapses to
    // empty here rather than short-circuiting the whole plugin.
    const canonicalOff = ctx.connector.platforms[HOST]?.hooks === false;
    const events = canonicalOff
      ? []
      : ctx.connector.hookEvents.filter(
          (e): e is HookEventName => EVENT_TO_AMP[e] !== undefined,
        );
    const has = (e: HookEventName) => events.includes(e);

    const header = `/**
 * AUTO-GENERATED by agent-connector — DO NOT EDIT.
 *
 * Self-contained Amp plugin for connector ${ctx.connector.id}.
 * It imports nothing from agent-connector: every hook invocation shells out to
 * the stable home binary's universal entrypoint and JSON-parses the normalized
 * response. Fail-open: any bridge error degrades to a no-op (never wedges Amp).
 *
 * Amp loads this module from .amp/plugins/${ctx.connector.id}.ts; the default
 * export is the plugin function (amp) => void called once with the PluginAPI.
 */
import type { PluginAPI } from "@ampcode/plugin";
import { execFileSync, execSync } from "node:child_process";

${renderBridgePrelude({
  homeBin: ctx.homeBinPath,
  connectorId: ctx.connector.id,
  hookSlug: "amp",
  payloadNoun: "amp",
  failOpenComment: "Fail-open — never wedge an Amp tool call / lifecycle event.",
})}

// Amp documents no project-dir env var; the plugin process runs in the workspace
// root, so resolve once at load. Session id is rebound on each session.start.
const PROJECT_DIR = process.cwd();
let SESSION_ID = "";
`;

    const handlers: string[] = [];

    if (has("SessionStart")) {
      handlers.push(`  // SessionStart → rebind the session id and notify the connector.
  // Amp's session.start event carries event.thread.id (ampcode.com/manual →
  // Plugins → session.start: "Example session.start for \${event.thread.id}").
  amp.on("session.start", async (event) => {
    SESSION_ID =
      (event && event.thread && event.thread.id) || "amp-session";
    bridge("SessionStart", { sessionId: SESSION_ID, projectDir: PROJECT_DIR });
  });`);
    }

    if (has("UserPromptSubmit")) {
      handlers.push(`  // UserPromptSubmit → agent.start "fires when the user submits a prompt"
  // (ampcode.com/manual). The host DOES carry the prompt: AgentStartEvent.message
  // is "The user's prompt message" (@ampcode/plugin index.d.ts:1011-1012), so we
  // PROJECT event.message into the bridge payload's prompt key (the prior version
  // dropped it). Observe-only return surface — any deny/context decision is a no-op.
  amp.on("agent.start", async (event) => {
    bridge("UserPromptSubmit", {
      prompt: (event && typeof event.message === "string" && event.message) || "",
      sessionId: SESSION_ID,
      projectDir: PROJECT_DIR,
      raw: event,
    });
  });`);
    }

    if (has("PreToolUse")) {
      handlers.push(`  // PreToolUse → Amp's tool.call returns a decision union (ampcode.com/manual →
  // Plugins → tool.call): { action: "allow" } to run, or { action:
  // "reject-and-continue", message } to block and let the agent continue. The
  // tool name is event.tool (verified); the input field is not byte-documented,
  // so event.input is a best-effort hint for the connector's matcher (the matcher
  // keys on the verified tool name). A deny/ask decision maps to reject-and-
  // continue; everything else allows.
  amp.on("tool.call", async (event) => {
    const payload = {
      toolName: (event && event.tool) || "",
      toolInput: (event && event.input) || {},
      sessionId: SESSION_ID,
      projectDir: PROJECT_DIR,
    };
    const res = bridge("PreToolUse", payload);
    if (res && (res.decision === "deny" || res.decision === "ask")) {
      return {
        action: "reject-and-continue",
        message: res.reason || "Blocked by ${ctx.connector.id}",
      };
    }
    return { action: "allow" };
  });`);
    }

    if (has("PostToolUse")) {
      handlers.push(`  // PostToolUse → tool.result "fires after a tool finishes and before the result
  // is sent back to the model" (ampcode.com/manual). The tool name is event.tool
  // and the error signal is event.status === "error" (both verified). The host DOES
  // carry the output: ToolResultEvent extends ToolResult.output (typed unknown —
  // "Tool output/result if available", @ampcode/plugin index.d.ts:946-947,976), so
  // we PROJECT event.output into the bridge payload's toolOutput (prior version
  // dropped it). Replacement still observe-only (canModifyOutput:false) — the
  // replacement OBJECT shape is undocumented, so we never return a guessed mutation.
  amp.on("tool.result", async (event) => {
    bridge("PostToolUse", {
      toolName: (event && event.tool) || "",
      toolOutput: event && event.output,
      isError: !!(event && event.status === "error"),
      sessionId: SESSION_ID,
      projectDir: PROJECT_DIR,
      raw: event,
    });
  });`);
    }

    if (has("Stop")) {
      handlers.push(`  // Stop → observe turn end. Amp's agent.end exposes no decision surface, so
  // this is observe-only (a deny decision degrades to a no-op).
  amp.on("agent.end", async (event) => {
    bridge("Stop", { sessionId: SESSION_ID, projectDir: PROJECT_DIR, raw: event });
  });`);
    }

    // NATIVE passthrough events: amp.on event names with no canonical analog,
    // declared on platforms.amp.nativeHooks (independent of hookEvents, so they
    // install even with hooks:false). Each bridges the NATIVE event name verbatim
    // to the home-bin → runNativeHook dispatches it host-generically.
    for (const ev of this.nativeHookEvents(ctx)) {
      const key = JSON.stringify(ev);
      handlers.push(`  // nativeHooks passthrough → ${ev}
  amp.on(${key}, async (event) => {
    bridge(${key}, { sessionId: SESSION_ID, projectDir: PROJECT_DIR, raw: event });
  });`);
    }

    const factory = `
export default function plugin(amp: PluginAPI) {
${handlers.join("\n\n")}
}
`;

    return header + factory;
  }

  // ── Runtime: parse OUR bridge payload → normalized event ─────────────────

  /**
   * `raw` is the payload OUR generated plugin posts (NOT a host-native shape):
   *   { toolName?, toolInput?, toolOutput?, isError?, prompt?, sessionId?, projectDir? }
   * so this maps straight through.
   */
  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as AmpBridgePayload;
    const base = {
      hostPlatform: HOST,
      connectorId: "",
      sessionId: typeof input.sessionId === "string" ? input.sessionId : "",
      raw,
      ...(typeof input.projectDir === "string"
        ? { projectDir: input.projectDir }
        : {}),
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
        // ToolResultEvent.output is typed `unknown` by the host (@ampcode/plugin
        // index.d.ts:947), so the bridge can forward a string OR a structured value.
        // Accept both: pass strings through, JSON-stringify other non-nullish
        // values (the old `typeof === "string"` guard silently dropped the latter).
        const out = coerceToolOutput(input.toolOutput);
        const ev: PostToolUseEvent = {
          ...base,
          toolName: input.toolName ?? "",
          toolInput: input.toolInput ?? {},
          ...(out !== undefined ? { toolOutput: out } : {}),
          ...(typeof input.isError === "boolean"
            ? { isError: input.isError }
            : {}),
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
        const ev: StopEvent = { ...base };
        return ev;
      }
      case "SessionStart": {
        const ev: SessionStartEvent = { ...base, source: "startup" };
        return ev;
      }
      default:
        // Other canonical events are not surfaced by Amp; treat as a
        // session-start-shaped no-op so the dispatcher fails open gracefully.
        return { ...base, source: "startup" } satisfies SessionStartEvent;
    }
  }

  // ── Runtime: normalized response → reply the generated bridge parses ─────

  /**
   * Unlike json-stdio hosts (whose reply is the host's NATIVE control payload),
   * OUR generated bridge consumes this stdout directly. So the reply body is the
   * NORMALIZED HookResponse itself — the bridge JSON.parses it and, for tool.call,
   * maps a deny/ask decision → { action: "reject-and-continue" } (else allow).
   * Other events are observe-only, so their reply is ignored by the handler.
   */
  formatReply(_event: HookEventName, response: HookResponse): HookReply {
    return {
      exitCode: 0,
      stdout: JSON.stringify(response ?? { decision: "allow" }),
    };
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
        name: `${this.name}: server entry registered`,
        check: () => {
          // Only assert what the connector declares: a server-less connector
          // never writes a server entry, so its absence is healthy.
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const cfg = this.readJson<{ [k: string]: Record<string, unknown> }>(settingsPath);
          const bucket = cfg?.[MCP_ROOT_KEY];
          if (!cfg || !bucket) {
            return { status: "FAIL", detail: `no "${MCP_ROOT_KEY}" in ${settingsPath}` };
          }
          return connectorId in bucket
            ? { status: "OK", detail: `"${MCP_ROOT_KEY}".${connectorId} present` }
            : {
                status: "FAIL",
                detail: `no "${MCP_ROOT_KEY}".${connectorId} in ${settingsPath}`,
              };
        },
      },
      {
        name: `${this.name}: plugin module present`,
        check: () => {
          const hasHooks =
            ctx.connector.hookEvents.length > 0 ||
            this.nativeHookEvents(ctx).length > 0;
          if (!hasHooks) return { status: "OK", detail: "no hooks declared" };
          // Amp plugins are project-scoped; a user-scope install warn-skips the
          // plugin, so its absence there is healthy.
          if (ctx.scope !== "project") {
            return {
              status: "OK",
              detail: "amp plugins are project-scoped (user scope skipped)",
            };
          }
          const pluginPath = this.getHookConfigPath(ctx);
          return existsSync(pluginPath)
            ? { status: "OK", detail: pluginPath }
            : { status: "FAIL", detail: `not found: ${pluginPath}` };
        },
      },
    ];
  }

  /** Read a file, returning undefined on any error (idempotency compare). */
}

/**
 * Coerce Amp's `ToolResultEvent.output` (typed `unknown` upstream) into the
 * normalized event's `toolOutput: string`. Strings pass through; other
 * non-nullish values (objects / arrays / numbers) are JSON-stringified so a
 * structured tool result is no longer silently dropped. `undefined`/`null`
 * yields `undefined` (the key is omitted by the caller).
 */
function coerceToolOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Amp native interpolation token: `${env:VAR}` → `${VAR}`.
 *
 * When the portable ref carried a default (`${env:VAR:-fallback}`), Amp's native
 * `${VAR}` token has no way to express it — so a bare native token would silently
 * DROP the default. Instead, resolve the default at install time: emit the live
 * value when VAR is set and non-empty, else the literal fallback. The native
 * token is only emitted when there is no default to preserve.
 */
function ampEnvToken(name: string, def?: string): string {
  if (def !== undefined) {
    const v = process.env[name];
    return v != null && v !== "" ? v : def;
  }
  return `\${${name}}`;
}

export const adapter = new AmpAdapter();
export default adapter;
