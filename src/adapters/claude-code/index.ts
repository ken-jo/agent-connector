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

import { copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { BaseAdapter } from "../base.js";
import type { Adapter, HookReply, InstallContext, NormalizedEvent } from "../spi.js";
import type {
  ChangeRecord,
  CommandDef,
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
  buildServeWrapperCommand,
  isHomeBinHookCommand,
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
    transports: ["stdio", "http"],
    // Content surfaces: Claude Code is the reference implementation for all three.
    supportsCommands: true,
    supportsSkills: true,
    supportsSubagents: true,
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
      const namespace = configPatchNamespaceViolation(patch.key);
      if (namespace) {
        changes.push({
          platform: this.id,
          action: "warn",
          detail: `configPatch refused: ${namespace}`,
        });
        continue;
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
            `configPatch ${patch.key} skipped: "${leaf.atPath}" exists but is not an ` +
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
          detail: `configPatch ${patch.key}: <absent> → ${describeJsonValue(desired)} (${patch.reason})`,
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
            `configPatch ${patch.key} skipped: already set to ${describeJsonValue(leaf.value)} ` +
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
            `configPatch ${patch.key}: value changed since install ` +
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
            detail: `configPatch ${patch.key} already installed; registered as co-owner (co-owned with ${owners.join(", ")})`,
          });
        } else {
          changes.push({
            platform: this.id,
            action: "skip",
            path: filePath,
            detail: `configPatch ${patch.key} already installed`,
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
          `configPatch ${patch.key} skipped: already owned by ${entry.owners
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
    const owned = ledgerEntriesOwnedBy(ledger, HOST, connectorId);
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
            detail: `configPatch ${entry.key} retained: still owned by ${entry.owners
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
            detail: `configPatch ${entry.key}: ${filePath} is not parseable; key left in place (ownership released)`,
          });
          continue;
        }
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: filePath,
            detail: `configPatch ${entry.key} already absent (no settings file); ownership record dropped`,
          });
          continue;
        }
        const leaf = readJsonLeaf(settings, entry.key.split("."));
        if (leaf.kind !== "present") {
          changes.push({
            platform: this.id,
            action: "skip",
            path: filePath,
            detail: `configPatch ${entry.key} already absent; ownership record dropped`,
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
              `configPatch ${entry.key}: value changed since install ` +
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
          detail: `configPatch ${entry.key} removed (was ${describeJsonValue(entry.writtenValue)})`,
        });
      }

      if (fileMutated && settings) this.writeJson(filePath, settings, ctx.dryRun);
    }

    if (ledgerMutated && !ctx.dryRun) saveConfigPatchLedger(ctx.dataRoot, ledger);
    return changes;
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
    const platformEntries = ledger.entries.filter((e) => e.platform === this.id);

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
