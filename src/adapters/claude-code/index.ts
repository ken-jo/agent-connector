/**
 * adapters/claude-code — Claude Code platform adapter for agent-connector.
 *
 * Generalized from context-mode's proven 15-platform Claude adapter: the served
 * identity is now `ctx.connector` (not a hardcoded "context-mode"), and every
 * hook command points at the single stable home binary
 * (`buildHomeBinHookCommand`) so one framework update propagates everywhere.
 *
 * Claude Code is a json-stdio host:
 *   - MCP servers: user scope → ~/.claude.json ("mcpServers"); project scope →
 *     <projectDir>/.mcp.json ("mcpServers").
 *   - Hooks: <configDir>/settings.json under "hooks", keyed by event name, each
 *     value an array of { matcher, hooks:[{ type:"command", command }] }.
 *   - Reply: a `hookSpecificOutput` object (allow|deny|ask + reason,
 *     additionalContext, updatedInput) on stdout with exit 0.
 */

import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { BaseAdapter } from "../base.js";
import type { Adapter, HookReply, InstallContext, MemoryTarget, NormalizedEvent } from "../spi.js";
import type {
  ChangeRecord,
  CommandDef,
  ConfigPatchDef,
  DetectedPlatform,
  DiagnosticResult,
  HealthCheck,
  HookEventName,
  HookParadigm,
  HookResponse,
  JsonValue,
  NotificationEvent,
  PermissionRequestEvent,
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
  StatuslineContext,
  StopEvent,
  SubagentDef,
  SubagentStartEvent,
  SubagentStopEvent,
  Transport,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { resolveEnvRefsDeep, rewriteEnvRefs } from "../../core/interpolate.js";
import {
  buildHomeBinHookCommand,
  buildHomeBinStatuslineCommand,
  buildServeWrapperCommand,
  isHomeBinHookCommand,
  isHomeBinStatuslineCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";
import {
  type ConfigPatchLedgerEntry,
  addLedgerOwner,
  configPatchManualEdit,
  configPatchNamespaceViolation,
  createLedgerEntry,
  describeJsonValue,
  dropLedgerEntry,
  findLedgerEntry,
  hashJsonValue,
  isValidConfigPatchKey,
  jsonDeepEquals,
  ledgerEntriesOwnedBy,
  loadConfigPatchLedger,
  removeLedgerOwner,
  saveConfigPatchLedger,
} from "../../core/config-patch-ledger.js";
import { readRegisteredMeta } from "../../core/load-connector.js";
import {
  linesOutsideFences,
  listManagedBlocks,
  loadMemoryLedger,
  recordMemoryTarget,
  removeBlocksFromText,
  removeManagedBlocksFile,
  saveMemoryLedger,
  upsertManagedBlockFile,
} from "../../core/managed-block.js";
import { backupsDir, ensureDir } from "../../core/paths.js";
import {
  type ClaudeHookEvent,
  type ClaudeWireInput,
  extractSessionId,
  toolResponseToString,
} from "./wire.js";
import { renderCommandMd, renderSkillMd, renderSubagentMd } from "./render.js";

const HOST: PlatformId = "claude-code";
const MCP_ROOT_KEY = "mcpServers";

/**
 * settings.json leaf key the statusline surface owns. Wired through the SAME
 * set-if-absent ownership ledger as configPatch (it is NOT on the configPatch
 * sensitive-key denylist — verified — and is a single top-level leaf), so a
 * non-AC statusLine is never clobbered.
 */
const STATUSLINE_KEY = "statusLine";

/**
 * Reserved blockId of the SHARED `@AGENTS.md` import bridge in CLAUDE.md
 * (agents-import mode). The `_shared/` prefix cannot collide with a connector
 * blockId (connector ids match ^[a-z0-9][a-z0-9-]*$), and the bridge is
 * refcounted namespace-wide: it is removed only when the LAST agent-connector
 * block leaves the sibling AGENTS.md.
 */
const CLAUDE_AGENTS_IMPORT_BLOCK_ID = "_shared/claude-agents-import";

/** A single hook registration entry as Claude Code stores it in settings.json. */
interface ClaudeHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** Native MCP server entry shapes Claude Code accepts under `mcpServers`. */
interface ClaudeStdioServer {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}
interface ClaudeHttpServer {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/**
 * Claude Code statusLine command stdin payload (the documented status-line hook
 * input). Every field optional — a refresh only carries what the host knows.
 * `version` and any unmodeled fields stay in StatuslineContext.raw.
 */
interface ClaudeStatuslineInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  version?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  cost?: { total_cost_usd?: number };
}

export class ClaudeCodeAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Claude Code";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    sessionEnd: true,
    userPromptSubmit: true,
    stop: true,
    notification: true,
    // Newer events — Claude Code is the reference host for all four.
    permissionRequest: true,
    postToolUseFailure: true,
    subagentStart: true,
    subagentStop: true,
    // Claude Code can rewrite PreToolUse input (updatedInput) but does NOT let a
    // PostToolUse hook rewrite already-emitted tool output.
    canModifyArgs: true,
    canModifyOutput: false,
    canInjectSessionContext: true,
    // Native passthrough hooks: settings.json hook keys are free-form event
    // names, so any host event (TaskCreated, TeammateIdle, WorktreeCreate, …)
    // declared under platforms["claude-code"].nativeHooks installs verbatim.
    supportsNativeHooks: true,
    // Declarative host-config key patches: claude-code is the ONLY v1 host
    // (set-if-absent leaf keys in settings.json, refcounted ownership ledger,
    // sensitive-key denylist — see SENSITIVE_KEY_RULES below).
    supportsConfigPatch: true,
    // Statusline surface: claude-code is the ONLY v1 host. installStatusline
    // wires settings.json.statusLine = {type:"command", command:<home-bin
    // statusline cmd>} through the SAME set-if-absent ownership ledger as
    // configPatch (never clobbers a statusLine agent-connector does not own).
    supportsStatusline: true,
    transports: ["stdio", "http"],
    // Content surfaces: Claude Code is the reference implementation for all three.
    supportsCommands: true,
    supportsSkills: true,
    supportsSubagents: true,
    // Memory surface — EXCEPTION host: Claude Code reads CLAUDE.md, NOT
    // AGENTS.md (docs are explicit; no AGENTS.md support through v2.1.172), so
    // memoryTargets/installMemory below override the base AGENTS.md default.
    supportsMemory: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".claude");
    const userSettings = join(userDir, "settings.json");
    const userServers = join(homedir(), ".claude.json");
    const projectServers = join(projectDir, ".mcp.json");
    const userInstalled =
      existsSync(userDir) || existsSync(userSettings) || existsSync(userServers);
    const projInstalled = existsSync(projectServers);
    const installed = userInstalled || projInstalled;
    // Report the scope/path/reason for the marker that actually matched, so a
    // project-only install isn't misreported as a (non-existent) user install.
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projectServers : userSettings;
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
          ? `found project Claude Code config at ${projectServers}`
          : `found Claude Code config under ${userDir}`
        : `no Claude Code config at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".claude")
      : join(homedir(), ".claude");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".mcp.json")
      : join(homedir(), ".claude.json");
  }

  getHookConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "settings.json");
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
            ? "server registration disabled for claude-code"
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

  /** Render a normalized ServerDef into Claude Code's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): ClaudeStdioServer | ClaudeHttpServer {
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

      const entry: ClaudeStdioServer = { type: "stdio", command, args };
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      if (server.cwd) entry.cwd = resolveEnvRefsDeep(server.cwd);
      return entry;
    }

    // http (and any other remote transport we surface) — Claude registers a URL.
    const entry: ClaudeHttpServer = {
      type: "http",
      url: rewriteEnvRefs(server.url ?? "", claudeEnvToken),
    };
    if (server.headers) {
      entry.headers = this.renderEnv(server.headers) ?? {};
    }
    return entry;
  }

  /**
   * Render env/header values. Claude Code supports its own `${VAR}` native
   * interpolation, so translate `${env:VAR}` refs to that native token rather
   * than baking secrets into the file. Literals pass through unchanged.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      out[k] = rewriteEnvRefs(v, claudeEnvToken);
    }
    return out;
  }

  // ── Hook install / uninstall ─────────────────────────────────────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    const override = connector.platforms[HOST];

    // `hooks: false` disables only the NORMALIZED hooks. nativeHooks is a
    // sibling, explicitly claude-code-scoped declaration on the same override —
    // it installs regardless (the dev wrote both keys on the same object).
    const normalizedEvents = override?.hooks === false ? [] : connector.hookEvents;
    const nativeHooks = override?.nativeHooks ?? {};
    const nativeEvents = Object.keys(nativeHooks);

    if (normalizedEvents.length === 0 && nativeEvents.length === 0) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail:
            override?.hooks === false
              ? "hooks disabled for claude-code"
              : "connector declares no hooks",
        },
      ];
    }

    const settingsPath = this.getHookConfigPath(ctx);
    const settings = this.readJson<Record<string, unknown>>(settingsPath) ?? {};
    const hooks = (settings.hooks ??= {}) as Record<string, ClaudeHookEntry[]>;

    const changes: ChangeRecord[] = [];
    let mutated = false;

    // One pass over normalized + NATIVE events: native event-name keys are
    // written VERBATIM (e.g. "TaskCreated"), matcher from the def, and the
    // exact same home-bin command shape — so uninstall/doctor/telemetry treat
    // both identically.
    const pending: Array<{ event: string; matcher: string }> = [
      ...normalizedEvents.map((event) => ({
        event: event as string,
        matcher: connector.hooks[event]?.matcher ?? "",
      })),
      ...nativeEvents.map((event) => ({
        event,
        matcher: nativeHooks[event]?.matcher ?? "",
      })),
    ];

    for (const { event, matcher } of pending) {
      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, event, connector.id);
      const entry: ClaudeHookEntry = {
        matcher,
        hooks: [{ type: "command", command }],
      };

      const bucket = (hooks[event] ??= []);
      const existingIdx = bucket.findIndex((e) => this.entryHasCommand(e, command));

      if (existingIdx >= 0) {
        if (JSON.stringify(bucket[existingIdx]) === JSON.stringify(entry)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: settingsPath,
            detail: `hooks.${event} already registered`,
          });
          continue;
        }
        bucket[existingIdx] = entry;
        changes.push({
          platform: this.id,
          action: "update",
          path: settingsPath,
          detail: `hooks.${event}`,
        });
      } else {
        bucket.push(entry);
        changes.push({
          platform: this.id,
          action: "create",
          path: settingsPath,
          detail: `hooks.${event}`,
        });
      }
      mutated = true;
    }

    if (mutated) this.writeJson(settingsPath, settings, ctx.dryRun);
    return changes;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const settingsPath = this.getHookConfigPath(ctx);
    const settings = this.readJson<Record<string, unknown>>(settingsPath);
    const hooks = settings?.hooks as Record<string, ClaudeHookEntry[]> | undefined;
    if (!settings || !hooks) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: settingsPath,
          detail: "no hooks section present",
        },
      ];
    }

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of Object.keys(hooks)) {
      const bucket = hooks[event];
      if (!Array.isArray(bucket)) continue;

      // Strip our hook command from each entry; drop entries left empty.
      const next: ClaudeHookEntry[] = [];
      let removed = 0;
      for (const e of bucket) {
        const innerBefore = e.hooks?.length ?? 0;
        const inner = (e.hooks ?? []).filter(
          (h) => !this.isOurCommand(h.command, ctx),
        );
        removed += innerBefore - inner.length;
        if (inner.length > 0) next.push({ matcher: e.matcher ?? "", hooks: inner });
      }

      if (removed > 0) {
        if (next.length > 0) hooks[event] = next;
        else delete hooks[event];
        changes.push({
          platform: this.id,
          action: "remove",
          path: settingsPath,
          detail: `hooks.${event} (${removed})`,
        });
        mutated = true;
      }
    }

    if (mutated) this.writeJson(settingsPath, settings, ctx.dryRun);
    if (changes.length === 0) {
      changes.push({
        platform: this.id,
        action: "skip",
        path: settingsPath,
        detail: "no matching hook entries",
      });
    }
    return changes;
  }

  private entryHasCommand(entry: ClaudeHookEntry, command: string): boolean {
    return (entry.hooks ?? []).some((h) => h.command === command);
  }

  // ── Declarative host-config key patches (configPatch) ────────────────────
  // FIXED semantics (docs/ARCHITECTURE.md §4): set-if-absent on a single
  // dotted LEAF key of settings.json, skip-warn on ANY conflict (present key,
  // non-object intermediate, drift), refcounted ownership in the persisted
  // ledger at <dataRoot>/state/config-patches.json. Reuses the adapter's
  // existing whole-file settings.json JSON IO (the same handling the hook
  // install performs on this exact file) — Claude Code itself rewrites this
  // file, so format preservation is a non-issue here. NOTE for future hosts:
  // VS Code JSONC needs jsonc-parser modify/applyEdits and Codex TOML needs an
  // anchored edit — core/toml.ts's round-trip is BANNED for configPatch.

  /** The ONLY file configPatch may touch on claude-code: settings.json at scope. */
  getPatchableConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "settings.json");
  }

  override installConfigPatches(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    const patches = connector.platforms[HOST]?.configPatch ?? [];
    if (patches.length === 0) {
      return [
        { platform: this.id, action: "skip", detail: "connector declares no configPatch entries" },
      ];
    }
    return this.applyConfigPatches(ctx, patches);
  }

  /**
   * The shared set-if-absent / ownership-ledger apply loop behind BOTH
   * {@link installConfigPatches} and {@link installStatusline}. Routing the
   * statusline through the EXACT same path is how a connector's statusLine
   * inherits the configPatch contract verbatim: never clobber a statusLine
   * agent-connector does not own (skip-warn), record prior state + owner,
   * refcounted across connectors, reversible by uninstallConfigPatches.
   */
  private applyConfigPatches(
    ctx: InstallContext,
    patches: ConfigPatchDef[],
    opts: { surfaceLabel?: "configPatch" | "statusline" } = {},
  ): ChangeRecord[] {
    // The user-facing surface name in every ChangeRecord.detail. "statusline"
    // routes the AC-modeled statusLine key through this loop INTERNALLY — that
    // key is namespace-reserved against raw configPatch, so the internal path
    // bypasses the namespace guard (the surface, not a smuggled patch, owns it).
    const surfaceLabel = opts.surfaceLabel ?? "configPatch";
    const internal = surfaceLabel !== "configPatch";
    const { connector } = ctx;
    const filePath = this.getPatchableConfigPath(ctx);
    // OVERWRITE GUARD (upsertServerInJson precedent): never round-trip a
    // present-but-unparseable settings file into `{}`.
    if (this.isPresentButUnparseable(filePath)) {
      return [
        {
          platform: this.id,
          action: "warn",
          path: filePath,
          detail: `existing ${filePath} is not parseable; configPatch left unapplied (back it up / fix it, then re-run)`,
        },
      ];
    }
    const settings = this.readJson<Record<string, unknown>>(filePath) ?? {};
    if (typeof settings !== "object" || Array.isArray(settings)) {
      return [
        {
          platform: this.id,
          action: "warn",
          path: filePath,
          detail: `existing ${filePath} is not a JSON object; configPatch left unapplied`,
        },
      ];
    }

    const ledger = loadConfigPatchLedger(ctx.dataRoot);
    const changes: ChangeRecord[] = [];
    let fileMutated = false;
    let ledgerMutated = false;

    for (const patch of patches) {
      // Defense in depth: re-validate grammar + AC-namespace here (a connector
      // loaded from raw meta/JSON must not bypass defineConnector's checks).
      if (!isValidConfigPatchKey(patch.key)) {
        changes.push({
          platform: this.id,
          action: "warn",
          detail:
            `configPatch ${JSON.stringify(patch.key)} refused: not a dotted leaf path ` +
            `(segments must match [A-Za-z0-9_-]+; no array indices)`,
        });
        continue;
      }
      // The statusline surface intentionally models the (now namespace-reserved)
      // statusLine key, so its internal patches skip this guard.
      if (!internal) {
        const namespace = configPatchNamespaceViolation(patch.key);
        if (namespace) {
          changes.push({
            platform: this.id,
            action: "warn",
            detail: `configPatch refused: ${namespace}`,
          });
          continue;
        }
      }
      // SENSITIVE-KEY DENYLIST — hard refuse, no override flag in v1.
      const sensitive = claudeSensitiveKeyViolation(patch.key);
      if (sensitive) {
        changes.push({
          platform: this.id,
          action: "warn",
          detail:
            `configPatch ${patch.key} refused: matches the claude-code sensitive-key ` +
            `denylist (${sensitive}); security-relevant keys are never patched`,
        });
        continue;
      }

      // `${env:VAR}` refs resolve at install time, matching server-entry behavior.
      const desired = resolveEnvRefsDeep(patch.value) as JsonValue;
      const segments = patch.key.split(".");
      const leaf = readJsonLeaf(settings, segments);
      const entry = findLedgerEntry(ledger, HOST, filePath, patch.key);

      if (leaf.kind === "blocked") {
        changes.push({
          platform: this.id,
          action: "warn",
          path: filePath,
          detail:
            `${surfaceLabel} ${patch.key} skipped: "${leaf.atPath}" exists but is not an ` +
            `object — ${configPatchManualEdit(patch)}`,
        });
        continue;
      }

      if (leaf.kind === "absent") {
        // SET-IF-ABSENT: the one write path. Intermediates created only as needed.
        writeJsonLeaf(settings, segments, desired);
        fileMutated = true;
        if (entry) {
          // Stale ledger row (key was deleted out from under us): re-assert the
          // value, keep existing owners (they still rely on the key existing),
          // and record what was actually (re)written.
          entry.writtenValue = desired;
          entry.writtenValueHash = hashJsonValue(desired);
          addLedgerOwner(entry, connector.id, connector.version);
        } else {
          createLedgerEntry(ledger, {
            platform: HOST,
            file: filePath,
            key: patch.key,
            value: desired,
            connectorId: connector.id,
            connectorVersion: connector.version,
          });
        }
        ledgerMutated = true;
        changes.push({
          platform: this.id,
          action: "create",
          path: filePath,
          detail: `${surfaceLabel} ${patch.key}: <absent> → ${describeJsonValue(desired)} (${patch.reason})`,
        });
        continue;
      }

      // Key PRESENT — never overwrite; the only question is ownership/refcount.
      if (!entry) {
        // User- (or other-tool-) owned. No ownership is taken even when values
        // happen to match — uninstall must never delete a key we did not create.
        changes.push({
          platform: this.id,
          action: "warn",
          path: filePath,
          detail:
            `${surfaceLabel} ${patch.key} skipped: already set to ${describeJsonValue(leaf.value)} ` +
            `(not created by agent-connector; desired ${describeJsonValue(desired)}) — ` +
            configPatchManualEdit(patch),
        });
        continue;
      }

      if (!jsonDeepEquals(leaf.value, entry.writtenValue)) {
        // DRIFT: the user edited the value after we wrote it. Never revert —
        // sync re-asserts only ABSENT keys.
        changes.push({
          platform: this.id,
          action: "warn",
          path: filePath,
          detail:
            `${surfaceLabel} ${patch.key}: value changed since install ` +
            `(current ${describeJsonValue(leaf.value)}, wrote ${describeJsonValue(entry.writtenValue)}); ` +
            `leaving in place — ${configPatchManualEdit(patch)}`,
        });
        continue;
      }

      if (jsonDeepEquals(desired, leaf.value)) {
        // Same value we own: register as co-owner (refcount++) or plain
        // idempotent skip when this connector is already an owner.
        const owners = entry.owners.map((o) => o.connectorId);
        if (addLedgerOwner(entry, connector.id, connector.version)) {
          ledgerMutated = true;
          changes.push({
            platform: this.id,
            action: "skip",
            path: filePath,
            detail: `${surfaceLabel} ${patch.key} already installed; registered as co-owner (co-owned with ${owners.join(", ")})`,
          });
        } else {
          changes.push({
            platform: this.id,
            action: "skip",
            path: filePath,
            detail: `${surfaceLabel} ${patch.key} already installed`,
          });
        }
        continue;
      }

      // FIRST-WRITER-WINS: another connector owns this key with a different value.
      changes.push({
        platform: this.id,
        action: "warn",
        path: filePath,
        detail:
          `${surfaceLabel} ${patch.key} skipped: already owned by ${entry.owners
            .map((o) => o.connectorId)
            .join(", ")} with a different value ` +
          `(current ${describeJsonValue(leaf.value)}, desired ${describeJsonValue(desired)}) — ` +
          configPatchManualEdit(patch),
      });
    }

    if (fileMutated) this.writeJson(filePath, settings, ctx.dryRun);
    if (ledgerMutated && !ctx.dryRun) saveConfigPatchLedger(ctx.dataRoot, ledger);
    return changes;
  }

  override uninstallConfigPatches(ctx: InstallContext): ChangeRecord[] {
    const connectorId = ctx.connector.id;
    const ledger = loadConfigPatchLedger(ctx.dataRoot);
    // Keyed off the LEDGER (not the declaration): releases ownership for every
    // file/scope this connector ever patched, even when the uninstall context
    // is a minimal synthetic connector or the scope flag differs from install.
    // EXCLUDE the statusLine key — that surface releases via uninstallStatusline
    // (the installer runs both), so this never double-processes the same row.
    const owned = ledgerEntriesOwnedBy(ledger, HOST, connectorId).filter(
      (e) => e.key !== STATUSLINE_KEY,
    );
    const declared = ctx.connector.platforms[HOST]?.configPatch ?? [];
    const changes: ChangeRecord[] = [];

    // Declared patches with NO ownership record anywhere: never delete a key
    // we did not create (rule 1) — explicit skip so the outcome is never silent.
    const ownedKeys = new Set(owned.map((e) => e.key));
    for (const patch of declared) {
      if (!ownedKeys.has(patch.key)) {
        changes.push({
          platform: this.id,
          action: "skip",
          detail: `configPatch ${patch.key}: no ownership recorded; left untouched`,
        });
      }
    }
    if (owned.length === 0) return changes;
    changes.push(...this.releaseOwnedConfigPatches(ctx, ledger, owned));
    return changes;
  }

  /**
   * The shared last-owner-verified release loop behind BOTH
   * {@link uninstallConfigPatches} and {@link uninstallStatusline}: for each
   * already-selected owned ledger entry, drop this connector's ownership and
   * remove the key ONLY when last-owner ∧ value-unchanged ∧ prior-absent (else
   * skip-warn + leave the key). Saves the ledger when it mutated.
   */
  private releaseOwnedConfigPatches(
    ctx: InstallContext,
    ledger: ReturnType<typeof loadConfigPatchLedger>,
    owned: ConfigPatchLedgerEntry[],
    opts: { surfaceLabel?: "configPatch" | "statusline" } = {},
  ): ChangeRecord[] {
    const surfaceLabel = opts.surfaceLabel ?? "configPatch";
    const connectorId = ctx.connector.id;
    const changes: ChangeRecord[] = [];
    let ledgerMutated = false;
    const backedUp = new Set<string>();

    // Group by file (entries may span scopes/files).
    const byFile = new Map<string, ConfigPatchLedgerEntry[]>();
    for (const entry of owned) {
      const bucket = byFile.get(entry.file) ?? [];
      bucket.push(entry);
      byFile.set(entry.file, bucket);
    }

    for (const [filePath, entries] of byFile) {
      const unparseable = this.isPresentButUnparseable(filePath);
      const settings = unparseable
        ? null
        : this.readJson<Record<string, unknown>>(filePath);
      let fileMutated = false;

      for (const entry of entries) {
        const { lastOwner } = removeLedgerOwner(entry, connectorId);
        ledgerMutated = true;

        if (!lastOwner) {
          // The shared-flag case: A uninstalls, B still relies on the key.
          changes.push({
            platform: this.id,
            action: "skip",
            path: filePath,
            detail: `${surfaceLabel} ${entry.key} retained: still owned by ${entry.owners
              .map((o) => o.connectorId)
              .join(", ")}`,
          });
          continue;
        }

        // Last owner out → the ledger row is dropped on every branch below;
        // the KEY is removed only on the fully-verified branch.
        dropLedgerEntry(ledger, entry);

        if (unparseable) {
          changes.push({
            platform: this.id,
            action: "warn",
            path: filePath,
            detail: `${surfaceLabel} ${entry.key}: ${filePath} is not parseable; key left in place (ownership released)`,
          });
          continue;
        }
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: filePath,
            detail: `${surfaceLabel} ${entry.key} already absent (no settings file); ownership record dropped`,
          });
          continue;
        }
        const leaf = readJsonLeaf(settings, entry.key.split("."));
        if (leaf.kind !== "present") {
          changes.push({
            platform: this.id,
            action: "skip",
            path: filePath,
            detail: `${surfaceLabel} ${entry.key} already absent; ownership record dropped`,
          });
          continue;
        }
        if (entry.prior?.present !== false || !jsonDeepEquals(leaf.value, entry.writtenValue)) {
          // User edited the value after install (or the row predates the
          // set-if-absent guarantee): deleting would clobber them. Leave it.
          changes.push({
            platform: this.id,
            action: "warn",
            path: filePath,
            detail:
              `${surfaceLabel} ${entry.key}: value changed since install ` +
              `(current ${describeJsonValue(leaf.value)}, wrote ${describeJsonValue(entry.writtenValue)}); ` +
              `left in place`,
          });
          continue;
        }

        // VERIFIED: last owner + current === writtenValue + prior was absent.
        // Back up the exact file before its first mutation, then delete the
        // leaf key (intermediate objects we created are left in place).
        if (!ctx.dryRun && !backedUp.has(filePath) && existsSync(filePath)) {
          const backup = this.backupFileForConfigPatch(filePath);
          backedUp.add(filePath);
          if (backup) {
            changes.push({
              platform: this.id,
              action: "create",
              path: backup,
              detail: "backed up settings before configPatch removal",
            });
          }
        }
        deleteJsonLeaf(settings, entry.key.split("."));
        fileMutated = true;
        changes.push({
          platform: this.id,
          action: "remove",
          path: filePath,
          detail: `${surfaceLabel} ${entry.key} removed (was ${describeJsonValue(entry.writtenValue)})`,
        });
      }

      if (fileMutated && settings) this.writeJson(filePath, settings, ctx.dryRun);
    }

    if (ledgerMutated && !ctx.dryRun) saveConfigPatchLedger(ctx.dataRoot, ledger);
    return changes;
  }

  // ── Statusline surface (a HUD/status line) ────────────────────────────────
  // Wires settings.json.statusLine = { type:"command", command:<home-bin
  // statusline cmd> } through the SAME ownership ledger as configPatch: a
  // synthetic ConfigPatchDef routed through applyConfigPatches, so the statusLine
  // inherits the full set-if-absent contract verbatim — never clobbers a
  // statusLine agent-connector does not own (skip-warn), records prior state +
  // owner, reversible. The home-bin command makes the host exec
  // `<homeBin> statusline claude-code --connector <id>` for every status refresh,
  // which re-imports the connector module and renders the line (runtime/
  // statusline-entrypoint). No telemetry in v1.

  /** The synthetic statusLine configPatch this connector would write. */
  private statuslineConfigPatch(ctx: InstallContext): ConfigPatchDef {
    const command = buildHomeBinStatuslineCommand(ctx.homeBinPath, HOST, ctx.connector.id);
    return {
      key: STATUSLINE_KEY,
      value: { type: "command", command },
      reason: "agent-connector statusline surface",
    };
  }

  override installStatusline(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.statusline == null) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no statusline" }];
    }
    if (connector.platforms[HOST]?.statusline === false) {
      return [{ platform: this.id, action: "skip", detail: "statusline disabled for claude-code" }];
    }
    // Reuse the configPatch apply path (set-if-absent, ownership ledger, skip-warn
    // on any non-AC statusLine). This is the SAME machinery installConfigPatches
    // uses on this exact file, so the ownership semantics are identical — only the
    // surface LABEL differs (statusLine is namespace-reserved against raw
    // configPatch; this internal path bypasses that guard and owns the key).
    return this.applyConfigPatches(ctx, [this.statuslineConfigPatch(ctx)], {
      surfaceLabel: "statusline",
    });
  }

  override uninstallStatusline(ctx: InstallContext): ChangeRecord[] {
    const ledger = loadConfigPatchLedger(ctx.dataRoot);
    // Release ONLY the statusLine ledger row this connector owns (keyed off the
    // ledger, not the declaration, so an id-only synthetic uninstall still
    // reclaims it). Same last-owner-verified delete as uninstallConfigPatches.
    const owned = ledgerEntriesOwnedBy(ledger, HOST, ctx.connector.id).filter(
      (e) => e.key === STATUSLINE_KEY,
    );
    if (owned.length === 0) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail: "statusline: no ownership recorded; left untouched",
        },
      ];
    }
    return this.releaseOwnedConfigPatches(ctx, ledger, owned, {
      surfaceLabel: "statusline",
    });
  }

  /**
   * Parse Claude Code's statusLine stdin JSON into the normalized
   * {@link StatuslineContext}. Claude pipes a JSON object to the statusLine
   * command on stdin (model, workspace, cost, etc.); fields the payload omits
   * stay undefined. `raw` keeps the verbatim payload (incl. `version`).
   */
  parseStatusInput(raw: unknown): StatuslineContext {
    const input = (raw ?? {}) as ClaudeStatuslineInput;
    const model: { id?: string; displayName?: string } = {};
    if (typeof input.model?.id === "string") model.id = input.model.id;
    if (typeof input.model?.display_name === "string") {
      model.displayName = input.model.display_name;
    }
    const cwd =
      typeof input.cwd === "string"
        ? input.cwd
        : typeof input.workspace?.current_dir === "string"
          ? input.workspace.current_dir
          : undefined;

    const ctx: StatuslineContext = { host: HOST, raw };
    if (typeof input.session_id === "string" && input.session_id !== "") {
      ctx.sessionId = input.session_id;
    }
    if (cwd !== undefined) ctx.cwd = cwd;
    if (model.id !== undefined || model.displayName !== undefined) ctx.model = model;
    if (typeof input.cost?.total_cost_usd === "number") {
      ctx.cost = { totalUsd: input.cost.total_cost_usd };
    }
    if (typeof input.transcript_path === "string") {
      ctx.transcriptPath = input.transcript_path;
    }
    return ctx;
  }

  /** Format the rendered status line into Claude's native reply: stdout = line, exit 0. */
  formatStatusOutput(rendered: string): HookReply {
    return { exitCode: 0, stdout: rendered };
  }

  /**
   * Back up ONE exact file (the ledger-recorded patch target, which may belong
   * to a different scope than the current ctx) into the standard backups dir.
   * Best-effort: a failed copy returns null and the caller proceeds — the
   * removal is already value-verified.
   */
  private backupFileForConfigPatch(filePath: string): string | null {
    try {
      ensureDir(backupsDir());
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = join(backupsDir(), `${this.id}-${stamp}-${basename(filePath)}`);
      copyFileSync(filePath, dest);
      return dest;
    } catch {
      return null;
    }
  }

  /**
   * Doctor: per-ledger-entry configPatch state for this connector —
   *   ok       → key present and still exactly what we wrote;
   *   drifted  → user changed the value (we print the manual edit, NEVER
   *              auto-fix — sync re-asserts only absent keys);
   *   missing  → key deleted by the user; sync will re-assert it;
   *   orphaned → ledger row whose owners' connector records are all gone.
   * Plus a re-print of the manual edit for declared patches that hold no
   * ownership (skipped at install).
   */
  private configPatchDiagnostics(ctx: InstallContext): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const ledger = loadConfigPatchLedger(ctx.dataRoot);
    const connectorId = ctx.connector.id;
    // EXCLUDE the statusLine row: it is owned by the statusline surface and gets
    // its own dedicated health check in getHealthChecks. Reporting it here too
    // would double-report the key and (on a user edit) print a bogus configPatch
    // "drifted" hint to restore a configPatch the connector never declared.
    const platformEntries = ledger.entries.filter(
      (e) => e.platform === this.id && e.key !== STATUSLINE_KEY,
    );

    for (const entry of platformEntries) {
      const ownedByThis = entry.owners.some((o) => o.connectorId === connectorId);
      if (!ownedByThis) {
        // ORPHAN check (global hygiene): every owner's connector record is gone.
        const orphaned =
          entry.owners.length === 0 ||
          entry.owners.every((o) => readRegisteredMeta(o.connectorId) === null);
        if (orphaned) {
          results.push({
            check: `${this.name}: configPatch ${entry.key}`,
            status: "warn",
            message:
              `orphaned ledger entry in ${entry.file}: owning connector record(s) ` +
              `gone (${entry.owners.map((o) => o.connectorId).join(", ") || "none"})`,
            fix:
              `re-run \`agent-connector uninstall <owner-id>\` to release it, or remove ` +
              `${entry.key} from ${entry.file} manually`,
          });
        }
        continue;
      }

      const state = this.configPatchState(entry);
      if (state.kind === "ok") {
        results.push({
          check: `${this.name}: configPatch ${entry.key}`,
          status: "pass",
          message: `ok — ${entry.key} = ${describeJsonValue(entry.writtenValue)} (${entry.file})`,
        });
      } else if (state.kind === "missing") {
        results.push({
          check: `${this.name}: configPatch ${entry.key}`,
          status: "warn",
          message: `missing — key deleted from ${entry.file} since install`,
          fix: `agent-connector install (sync) will re-assert it`,
        });
      } else {
        results.push({
          check: `${this.name}: configPatch ${entry.key}`,
          status: "warn",
          message:
            `drifted — value changed since install (current ${describeJsonValue(state.current)}, ` +
            `wrote ${describeJsonValue(entry.writtenValue)}); never auto-fixed`,
          fix: `manual edit if wanted: set ${entry.key} = ${describeJsonValue(entry.writtenValue)} in ${entry.file}`,
        });
      }
    }

    // Declared-but-unowned patches: re-print the manual edit (the patch was
    // skipped at install — conflict, denylist, or simply not installed yet).
    const declared = ctx.connector.platforms[HOST]?.configPatch ?? [];
    const ownedKeys = new Set(
      ledgerEntriesOwnedBy(ledger, HOST, connectorId).map((e) => e.key),
    );
    for (const patch of declared) {
      if (ownedKeys.has(patch.key)) continue;
      results.push({
        check: `${this.name}: configPatch ${patch.key}`,
        status: "warn",
        message: `declared but not owned (skipped at install or not yet installed)`,
        fix: configPatchManualEdit(patch),
      });
    }
    return results;
  }

  /** Current on-disk state of one owned ledger entry. */
  private configPatchState(
    entry: ConfigPatchLedgerEntry,
  ): { kind: "ok" } | { kind: "missing" } | { kind: "drifted"; current: JsonValue } {
    const settings = this.readJson<Record<string, unknown>>(entry.file);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return { kind: "missing" };
    }
    const leaf = readJsonLeaf(settings, entry.key.split("."));
    if (leaf.kind !== "present") return { kind: "missing" };
    if (jsonDeepEquals(leaf.value, entry.writtenValue)) return { kind: "ok" };
    return { kind: "drifted", current: leaf.value };
  }

  override doctor(ctx: InstallContext): DiagnosticResult[] {
    const results = super.doctor(ctx);
    results.push(...this.configPatchDiagnostics(ctx));
    return results;
  }

  // ── Content surfaces: commands / skills / subagents ──────────────────────
  // CONTENT-ONLY: pure native-file writers under <configDir>/{commands,skills,
  // agents}. No runtime dispatch, no home-bin pointer, no telemetry wrap. Each
  // method is idempotent (byte-identical → skip) via BaseAdapter.writeContentFile
  // and reversible via removeContentFile. Honors platforms["claude-code"]
  // per-surface false to skip.

  private commandsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "commands");
  }
  private skillsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "skills");
  }
  private agentsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "agents");
  }

  /** Native command file path: <configDir>/commands/<name>.md. */
  private commandPath(ctx: InstallContext, name: string): string {
    return join(this.commandsDir(ctx), `${name}.md`);
  }
  /** Native skill dir: <configDir>/skills/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }
  /** Native subagent file path: <configDir>/agents/<name>.md. */
  private subagentPath(ctx: InstallContext, name: string): string {
    return join(this.agentsDir(ctx), `${name}.md`);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  override installCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.commands === false) {
      return [{ platform: this.id, action: "skip", detail: "commands disabled for claude-code" }];
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

  /** Render a command to md+frontmatter (delegates to the shared renderer). */
  private renderCommand(cmd: CommandDef): string {
    return renderCommandMd(cmd);
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for claude-code" }];
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

  // ── Subagents ───────────────────────────────────────────────────────────────

  override installSubagents(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.subagents === false) {
      return [{ platform: this.id, action: "skip", detail: "subagents disabled for claude-code" }];
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

  /** Render a subagent to md+frontmatter (delegates to the shared renderer). */
  private renderSubagent(agent: SubagentDef): string {
    return renderSubagentMd(agent);
  }

  // ── Memory surface: CLAUDE.md managed block + AGENTS.md interop ────────────
  // EXCEPTION host. Claude Code reads CLAUDE.md, NOT AGENTS.md (docs verbatim:
  // "Claude Code reads CLAUDE.md, not AGENTS.md"; no AGENTS.md support through
  // v2.1.172), so the base AGENTS.md-first default is overridden:
  //   - mode "block" (default): the managed block goes straight into CLAUDE.md.
  //     HTML-comment markers are CORRECT here — Claude strips HTML comments
  //     from CLAUDE.md before context injection, so the markers and the
  //     do-not-edit notice are INVISIBLE to the model while remaining fully
  //     parseable by us for sync/doctor/uninstall.
  //   - mode "agents-import" (opt-in via platforms["claude-code"].memory.mode):
  //     canonical block goes into AGENTS.md, plus a SHARED `@AGENTS.md` import
  //     bridge block in CLAUDE.md (Anthropic's documented interop). Opt-in
  //     because the import makes Claude read the ENTIRE AGENTS.md — a behavior
  //     change agent-connector must not make silently.
  //   - AUTO interop: when CLAUDE.md ALREADY imports `@AGENTS.md` (a line
  //     outside code fences and outside our own blocks) or IS a symlink
  //     resolving to AGENTS.md, the canonical block goes to AGENTS.md and
  //     CLAUDE.md is NOT touched — the pre-existing user wiring is never
  //     claimed as agent-connector-managed (prevents double-reads and writes
  //     "through" a symlink). Order-independent: keyed off the import/symlink
  //     existing, never off whether the AGENTS.md block was written yet.

  /** CLAUDE.md path: project `<projectDir>/CLAUDE.md`, user `~/.claude/CLAUDE.md`. */
  private claudeMdPath(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, "CLAUDE.md")
      : join(homedir(), ".claude", "CLAUDE.md");
  }

  /** Sibling AGENTS.md at the same scope (agents-import / auto-interop target). */
  private agentsMdPath(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, "AGENTS.md")
      : join(homedir(), ".claude", "AGENTS.md");
  }

  /**
   * True when the user ALREADY wired CLAUDE.md to AGENTS.md themselves:
   * an `@AGENTS.md` import line outside code fences and outside agent-connector
   * managed blocks (our own bridge must not count), or CLAUDE.md being a
   * symlink that resolves to the sibling AGENTS.md.
   */
  private claudeMdWiredToAgentsMd(ctx: InstallContext): boolean {
    const claudeMd = this.claudeMdPath(ctx);
    if (!existsSync(claudeMd)) return false;
    try {
      if (lstatSync(claudeMd).isSymbolicLink()) {
        const agentsMd = this.agentsMdPath(ctx);
        const resolved = realpathSync(claudeMd);
        const agentsResolved = existsSync(agentsMd) ? realpathSync(agentsMd) : agentsMd;
        if (resolved === agentsResolved) return true;
      }
    } catch {
      /* unreadable link — fall through to the content probe */
    }
    let raw: string;
    try {
      raw = readFileSync(claudeMd, "utf8");
    } catch {
      return false;
    }
    // Strip every agent-connector managed block first so OUR bridge import is
    // never mistaken for user wiring (idempotence across modes).
    const withoutBlocks = removeBlocksFromText(raw, { blockIdPrefix: "" }).text;
    const importRe = /(^|\s)@(?:AGENTS\.md|~\/\.claude\/AGENTS\.md)(\s|$)/;
    return linesOutsideFences(withoutBlocks).some((line) => importRe.test(line));
  }

  /**
   * Effective memory mode for this install:
   *   "user-import"   — the user already wired CLAUDE.md→AGENTS.md (wins over
   *                     everything; we never write a duplicate or a second import);
   *   "agents-import" — explicit opt-in via platforms["claude-code"].memory.mode;
   *   "block"         — the default (managed block directly in CLAUDE.md).
   */
  private effectiveMemoryMode(ctx: InstallContext): "block" | "agents-import" | "user-import" {
    if (this.claudeMdWiredToAgentsMd(ctx)) return "user-import";
    return this.memoryOverride(ctx)?.mode === "agents-import" ? "agents-import" : "block";
  }

  protected override memoryTargets(ctx: InstallContext): MemoryTarget[] {
    // An explicit path override keeps the base resolution (escape hatch wins).
    if (this.memoryOverride(ctx)?.path) return super.memoryTargets(ctx);
    if (ctx.scope !== "project" && ctx.scope !== "user") return [];
    const mode = this.effectiveMemoryMode(ctx);
    if (mode === "block") {
      return [
        {
          path: this.claudeMdPath(ctx),
          reason:
            "CLAUDE.md (Claude Code reads CLAUDE.md, not AGENTS.md; " +
            "HTML-comment markers are stripped from the model's context)",
        },
      ];
    }
    return [
      {
        path: this.agentsMdPath(ctx),
        reason:
          mode === "user-import"
            ? "AGENTS.md (CLAUDE.md already imports/symlinks it — user wiring respected)"
            : "AGENTS.md (agents-import mode; @AGENTS.md bridge managed in CLAUDE.md)",
      },
    ];
  }

  override installMemory(ctx: InstallContext): ChangeRecord[] {
    const changes = super.installMemory(ctx);
    const { connector } = ctx;
    // Bridge management applies only when the generic path actually installed.
    if (connector.platforms[HOST]?.memory === false || (connector.memory ?? []).length === 0) {
      return changes;
    }
    if (ctx.scope !== "project" && ctx.scope !== "user") return changes;
    if (this.memoryOverride(ctx)?.path) return changes;

    const mode = this.effectiveMemoryMode(ctx);
    if (mode === "user-import") {
      changes.push({
        platform: this.id,
        action: "skip",
        path: this.claudeMdPath(ctx),
        detail:
          "memory: CLAUDE.md already imports AGENTS.md; canonical block in AGENTS.md " +
          "suffices (pre-existing user import never claimed as managed)",
      });
      return changes;
    }
    if (mode !== "agents-import") return changes;

    // agents-import: ensure the SHARED `@AGENTS.md` bridge block in CLAUDE.md.
    const claudeMd = this.claudeMdPath(ctx);
    const importLine = ctx.scope === "project" ? "@AGENTS.md" : "@~/.claude/AGENTS.md";
    const res = upsertManagedBlockFile(claudeMd, {
      blockId: CLAUDE_AGENTS_IMPORT_BLOCK_ID,
      connectorId: "_shared",
      content: importLine,
      notice:
        "Managed by agent-connector (shared bridge). This import makes Claude Code read " +
        "AGENTS.md; it is removed automatically when the last agent-connector block " +
        "leaves AGENTS.md.",
      force: ctx.force ?? false,
      dryRun: ctx.dryRun,
    });
    changes.push({
      platform: this.id,
      action: res.action,
      path: claudeMd,
      detail: `memory: ${res.detail} — @AGENTS.md import bridge (agents-import mode)`,
    });
    if (res.backupPath) {
      changes.push({
        platform: this.id,
        action: "create",
        path: res.backupPath,
        detail: "backed up CLAUDE.md before destructive change",
      });
    }
    if (res.action !== "warn" && !ctx.dryRun) {
      const ledger = loadMemoryLedger(connector.id);
      recordMemoryTarget(ledger, {
        platform: this.id,
        scope: ctx.scope,
        path: claudeMd,
        blockId: CLAUDE_AGENTS_IMPORT_BLOCK_ID,
        createdFile: res.createdFile,
        hash: res.hash,
      });
      saveMemoryLedger(connector.id, ledger);
    }
    return changes;
  }

  override uninstallMemory(ctx: InstallContext): ChangeRecord[] {
    // Capture bridge facts BEFORE super prunes this platform's ledger rows.
    const priorRows = loadMemoryLedger(ctx.connector.id).targets.filter(
      (t) => t.platform === this.id && t.blockId === CLAUDE_AGENTS_IMPORT_BLOCK_ID,
    );
    const changes = super.uninstallMemory(ctx);

    // Bridge candidates: the current-scope CLAUDE.md plus any CLAUDE.md the
    // ledger recorded a bridge in (scope drift between install and uninstall).
    const pairs = new Map<string, { agentsMd: string; createdFile: boolean }>();
    if (ctx.scope === "project" || ctx.scope === "user") {
      pairs.set(this.claudeMdPath(ctx), {
        agentsMd: this.agentsMdPath(ctx),
        createdFile: false,
      });
    }
    for (const row of priorRows) {
      const existing = pairs.get(row.path);
      pairs.set(row.path, {
        agentsMd: existing?.agentsMd ?? join(dirname(row.path), "AGENTS.md"),
        createdFile: (existing?.createdFile ?? false) || row.createdFile,
      });
    }
    for (const [claudeMd, { agentsMd, createdFile }] of pairs) {
      changes.push(...this.releaseAgentsImportBridge(ctx, claudeMd, agentsMd, createdFile));
    }
    return changes;
  }

  /**
   * Refcounted bridge release: remove the `_shared/claude-agents-import` block
   * from CLAUDE.md ONLY when the sibling AGENTS.md holds zero agent-connector
   * blocks from OTHER connectors (namespace-wide count, excluding this
   * connector's own blocks so the answer is identical on dry-run and real run).
   * A user-authored `@AGENTS.md` import (no markers) is NEVER touched.
   */
  private releaseAgentsImportBridge(
    ctx: InstallContext,
    claudeMd: string,
    agentsMd: string,
    createdFile: boolean,
  ): ChangeRecord[] {
    if (!existsSync(claudeMd)) return [];
    let raw: string;
    try {
      raw = readFileSync(claudeMd, "utf8");
    } catch {
      return [];
    }
    if (!listManagedBlocks(raw).some((b) => b.blockId === CLAUDE_AGENTS_IMPORT_BLOCK_ID)) {
      return []; // no managed bridge here (user wiring or block mode) — nothing to release
    }
    let remaining = 0;
    if (existsSync(agentsMd)) {
      try {
        remaining = listManagedBlocks(readFileSync(agentsMd, "utf8")).filter(
          (b) => !b.blockId.startsWith(`${ctx.connector.id}/`),
        ).length;
      } catch {
        remaining = 1; // unreadable → conservative: keep the bridge
      }
    }
    if (remaining > 0) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: claudeMd,
          detail:
            `memory: @AGENTS.md import bridge retained — ${remaining} agent-connector ` +
            `block(s) from other connectors remain in ${agentsMd}`,
        },
      ];
    }
    return removeManagedBlocksFile(
      claudeMd,
      { blockId: CLAUDE_AGENTS_IMPORT_BLOCK_ID },
      { dryRun: ctx.dryRun, deleteFileIfCreated: createdFile },
    ).map((r) => ({
      platform: this.id,
      action: r.action,
      path: r.path,
      detail: `memory: ${r.detail}`,
    }));
  }

  /** True when a hook command references our home binary AND this connector id
   *  (anchored so a shared-prefix id can't collide — see isHomeBinHookCommand). */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const settingsPath = this.getHookConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const hookEvents = ctx.connector.hookEvents;
    // Native passthrough hooks count toward "declares hooks" ONLY when declared
    // for this platform (the serialized meta keeps the event-name keys, so this
    // works for doctor's handler-less meta-derived connectors too).
    const declaredHookCount =
      hookEvents.length +
      Object.keys(ctx.connector.platforms[HOST]?.nativeHooks ?? {}).length;
    const checks: HealthCheck[] = [
      {
        name: `${this.name}: settings.json present`,
        check: () => {
          // Same "only assert what the connector declares" rule as the
          // content-surface checks below: a hookless connector never writes
          // hooks into settings.json, so its absence is healthy, not a failure.
          if (declaredHookCount === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          return existsSync(settingsPath)
            ? { status: "OK", detail: settingsPath }
            : { status: "FAIL", detail: `not found: ${settingsPath}` };
        },
      },
      {
        name: `${this.name}: hook command registered`,
        check: () => {
          if (declaredHookCount === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          const settings = this.readJson<{ hooks?: Record<string, ClaudeHookEntry[]> }>(
            settingsPath,
          );
          if (!settings) return { status: "FAIL", detail: `cannot read ${settingsPath}` };
          const hooks = settings.hooks ?? {};
          const registered = Object.values(hooks).some((entries) =>
            (entries ?? []).some((e) =>
              (e.hooks ?? []).some((h) =>
                isHomeBinHookCommand(h.command, homeBin, connectorId),
              ),
            ),
          );
          return registered
            ? { status: "OK", detail: "hook command present" }
            : {
                status: "FAIL",
                detail: `no hook for ${connectorId} in ${settingsPath}`,
              };
        },
      },
    ];

    // Content-surface checks: only assert presence of the files this connector
    // declares (skip silently for surfaces it never asked for).
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

    // Statusline check: only assert it when the connector declares one AND it
    // is not disabled for this host. settings.json.statusLine.command must be OUR
    // home-bin statusline command (ok); present but not ours → drifted/skip-warn
    // (never our concern to fix); absent → missing.
    if (
      ctx.connector.statusline != null &&
      ctx.connector.platforms[HOST]?.statusline !== false
    ) {
      checks.push({
        name: `${this.name}: statusline wired`,
        check: () => {
          const settings = this.readJson<{ statusLine?: { command?: unknown } }>(settingsPath);
          const command = settings?.statusLine?.command;
          if (command === undefined) {
            return { status: "FAIL", detail: `statusLine not set in ${settingsPath}` };
          }
          if (
            typeof command === "string" &&
            isHomeBinStatuslineCommand(command, homeBin, connectorId)
          ) {
            return { status: "OK", detail: "statusLine command present" };
          }
          // Present but not ours — a non-AC statusLine we must never clobber.
          return {
            status: "FAIL",
            detail: `statusLine in ${settingsPath} is not agent-connector's (left untouched)`,
          };
        },
      });
    }
    return checks;
  }

  // ── Runtime: parse Claude stdin JSON → normalized event ──────────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as ClaudeWireInput;
    const connectorId = typeof input.connector === "string" ? input.connector : "";
    const sessionId = extractSessionId(input);
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
      case "PermissionRequest": {
        const ev: PermissionRequestEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          ...(Array.isArray(input.permission_suggestions)
            ? { permissionSuggestions: input.permission_suggestions }
            : {}),
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
      case "SubagentStart": {
        const ev: SubagentStartEvent = {
          ...base,
          ...(typeof input.agent_id === "string" ? { agentId: input.agent_id } : {}),
          ...(typeof input.agent_type === "string"
            ? { agentType: input.agent_type }
            : {}),
        };
        return ev;
      }
      case "SubagentStop": {
        // agent_id/agent_type stay optional — the SDK does not reliably
        // populate agent_type on SubagentStop (real-world quirk).
        const ev: SubagentStopEvent = {
          ...base,
          ...(typeof input.agent_id === "string" ? { agentId: input.agent_id } : {}),
          ...(typeof input.agent_type === "string"
            ? { agentType: input.agent_type }
            : {}),
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
        return ev;
      }
      default: {
        // Exhaustive guard — every HookEventName is handled above.
        const _never: never = event;
        throw new Error(`unsupported claude-code hook event: ${String(_never)}`);
      }
    }
  }

  // ── Runtime: normalized response → Claude native hook reply ──────────────

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const hookEventName = event as ClaudeHookEvent;
    const decision = response.decision ?? "allow";

    // PermissionRequest replies use Claude's nested decision{behavior} envelope
    // and are the ONE event where an EXPLICIT "allow" is an ACTIVE grant (it
    // suppresses the permission dialog) rather than passthrough:
    //   allow            → decision{behavior:"allow"} (+updatedInput when set);
    //                      Claude still enforces its own deny rules — an allow
    //                      never overrides a matching deny rule (host-enforced).
    //   modify           → an allow grant carrying updatedInput.
    //   deny             → decision{behavior:"deny", message} (shown to Claude).
    //   ask/context/void → NO decision output: fall through to the native
    //                      dialog (the dialog IS the ask).
    if (event === "PermissionRequest") {
      if (response.decision === "deny") {
        return this.stdout({
          hookSpecificOutput: {
            hookEventName,
            decision: {
              behavior: "deny",
              message: response.reason ?? "Blocked by hook",
            },
          },
        });
      }
      if (
        response.decision === "allow" ||
        (response.decision === "modify" && response.updatedInput)
      ) {
        return this.stdout({
          hookSpecificOutput: {
            hookEventName,
            decision: {
              behavior: "allow",
              ...(response.updatedInput
                ? { updatedInput: response.updatedInput }
                : {}),
            },
          },
        });
      }
      return { exitCode: 0 };
    }

    // PostToolUseFailure (feedback beside the error) and SubagentStart (context
    // injected at the start of the SUBAGENT's conversation) are observe/context-
    // only on Claude: "context" emits additionalContext, and a "deny" DEGRADES
    // to the same shape carrying the reason (the tool already failed / the
    // spawn is not blockable). Everything else passes through.
    if (event === "PostToolUseFailure" || event === "SubagentStart") {
      const context =
        decision === "context"
          ? response.additionalContext
          : decision === "deny"
            ? response.reason ?? response.additionalContext
            : undefined;
      if (context) {
        return this.stdout({
          hookSpecificOutput: { hookEventName, additionalContext: context },
        });
      }
      return { exitCode: 0 };
    }

    // deny → block the action with a reason (exit 0; JSON carries the decision).
    // Claude's deny shape is EVENT-SPECIFIC: PreToolUse uses
    // hookSpecificOutput.permissionDecision, but Stop / SubagentStop /
    // UserPromptSubmit / PostToolUse honor only the TOP-LEVEL
    // {"decision":"block","reason"} — rendering those as permissionDecision is
    // silently ignored by Claude (found porting oh-my-claudecode: its ralph
    // persistence loop denies the Stop event, which never blocked through the
    // old shape). A SubagentStop block keeps the subagent running with `reason`
    // as its next instruction (Stop semantics).
    if (decision === "deny") {
      if (
        event === "Stop" ||
        event === "SubagentStop" ||
        event === "UserPromptSubmit" ||
        event === "PostToolUse"
      ) {
        return this.stdout({
          decision: "block",
          reason: response.reason ?? "Blocked by hook",
        });
      }
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

    // modify → rewrite PreToolUse input (only where Claude supports it).
    if (decision === "modify") {
      if (event === "PreToolUse" && response.updatedInput) {
        return this.stdout({
          hookSpecificOutput: { hookEventName, updatedInput: response.updatedInput },
        });
      }
      // Output rewrite is unsupported on Claude; fall through to allow.
    }

    // context → inject soft guidance (also the SessionStart context path).
    if (decision === "context" && response.additionalContext) {
      return this.stdout({
        hookSpecificOutput: { hookEventName, additionalContext: response.additionalContext },
      });
    }

    // allow / void / unsupported-degradation → pass through with exit 0.
    return { exitCode: 0 };
  }

  private stdout(payload: unknown): HookReply {
    return { exitCode: 0, stdout: JSON.stringify(payload) };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// configPatch: sensitive-key denylist + JSON leaf-path helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * SENSITIVE-KEY DENYLIST (claude-code, v1) — THE documented list. configPatch
 * targeting any key below is HARD-REFUSED (warn ChangeRecord, never applied;
 * no override flag in v1). Rationale: configPatch writes bare host keys with
 * no inherent attribution, and these keys are security-relevant — permission
 * grants, tool allowlists, credential/auth helpers, login pinning, and any
 * env var that can reroute credentials or traffic. The OMC case
 * `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` passes; credential rerouting and
 * self-granted permissions do not. Reviewed whenever the host matrix updates.
 *
 *   permissions, permissions.*            — self-granted permission rules
 *   allowedTools / disallowedTools (.*)   — tool allowlist tampering
 *   apiKey* (e.g. apiKeyHelper)           — credential helpers
 *   awsAuthRefresh / awsCredentialExport  — AWS credential plumbing
 *   forceLoginMethod / forceLoginOrgUUID  — login/org pinning
 *   otelHeadersHelper                     — telemetry-header (token) helper
 *   hooks*, mcpServers* (+ enable/enabled/disabledMcpjsonServers)
 *                                         — refused upstream by the
 *                                           agent-connector NAMESPACE guard
 *   env.ANTHROPIC_*                       — API key / base-URL rerouting
 *   env.AWS_*                             — AWS credentials
 *   env.*_PROXY                           — traffic interception
 *   env.*TOKEN* / env.*KEY* / env.*SECRET* — generic credential patterns
 */
const SENSITIVE_KEY_RULES: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /^permissions(\.|$)/, label: "permissions" },
  { re: /^allowedTools(\.|$)/, label: "allowedTools" },
  { re: /^disallowedTools(\.|$)/, label: "disallowedTools" },
  { re: /^apiKey/i, label: "apiKey*" },
  { re: /^awsAuthRefresh$/, label: "awsAuthRefresh" },
  { re: /^awsCredentialExport$/, label: "awsCredentialExport" },
  { re: /^forceLoginMethod$/, label: "forceLoginMethod" },
  { re: /^forceLoginOrgUUID$/, label: "forceLoginOrgUUID" },
  { re: /^otelHeadersHelper$/, label: "otelHeadersHelper" },
  { re: /^env\.ANTHROPIC_/, label: "env.ANTHROPIC_*" },
  { re: /^env\.AWS_/, label: "env.AWS_*" },
  { re: /^env\.[^.]*_PROXY(\.|$)/i, label: "env.*_PROXY" },
  { re: /^env\.[^.]*TOKEN/i, label: "env.*TOKEN*" },
  { re: /^env\.[^.]*KEY/i, label: "env.*KEY*" },
  { re: /^env\.[^.]*SECRET/i, label: "env.*SECRET*" },
];

/**
 * The matched denylist pattern label when `key` is sensitive on claude-code,
 * else null. Exported so tests and docs stay pinned to the real list.
 */
export function claudeSensitiveKeyViolation(key: string): string | null {
  for (const rule of SENSITIVE_KEY_RULES) {
    if (rule.re.test(key)) return rule.label;
  }
  return null;
}

/** Result of looking up a dotted leaf path in a parsed JSON object. */
type JsonLeafLookup =
  | { kind: "absent" }
  | { kind: "present"; value: JsonValue }
  | { kind: "blocked"; atPath: string };

/**
 * Walk `segments` (a validated dotted leaf path) through `root`. "blocked"
 * reports the first intermediate that exists but is not a plain object —
 * the skip-warn case (we never replace a non-object intermediate).
 */
function readJsonLeaf(root: Record<string, unknown>, segments: string[]): JsonLeafLookup {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = node[segments[i]!];
    if (next === undefined) return { kind: "absent" };
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      return { kind: "blocked", atPath: segments.slice(0, i + 1).join(".") };
    }
    node = next as Record<string, unknown>;
  }
  const leaf = node[segments[segments.length - 1]!];
  if (leaf === undefined) return { kind: "absent" };
  return { kind: "present", value: leaf as JsonValue };
}

/**
 * Write `value` at the leaf, creating ONLY absent intermediate objects along
 * the way (callers must have verified the path is not blocked).
 */
function writeJsonLeaf(
  root: Record<string, unknown>,
  segments: string[],
  value: JsonValue,
): void {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = node[seg];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      node[seg] = created;
      node = created;
    } else {
      node = next as Record<string, unknown>;
    }
  }
  node[segments[segments.length - 1]!] = value;
}

/**
 * Delete the leaf key only. Intermediate objects — even ones we created — are
 * deliberately left in place (harmless; pruning risks collateral).
 */
function deleteJsonLeaf(root: Record<string, unknown>, segments: string[]): void {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = node[segments[i]!];
    if (next === null || typeof next !== "object" || Array.isArray(next)) return;
    node = next as Record<string, unknown>;
  }
  delete node[segments[segments.length - 1]!];
}

/** Claude Code native interpolation token: `${env:VAR}` → `${VAR}`. */
function claudeEnvToken(name: string): string {
  return `\${${name}}`;
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

export const adapter = new ClaudeCodeAdapter();
export default adapter;
