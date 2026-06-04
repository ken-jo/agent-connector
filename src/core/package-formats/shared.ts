/**
 * core/package-formats/shared — the common emitter contract + helpers every
 * format family is built on.
 *
 * A format emitter is a pure function conforming to {@link FormatEmitter}: it
 * takes a {@link ResolvedConnector} plus an {@link EmitContext} ({outDir,
 * homeBinPath, dryRun}) and either writes the bundle (dryRun=false) or only
 * enumerates the files it WOULD write (dryRun=true), returning a
 * {@link PackageResult} ({pluginDir, files[], marketplacePath?, notes?}).
 *
 * Everything below is shared across families so each emitter file is just the
 * format-specific manifest + layout, never a re-implementation of file writing,
 * JSON serialization, traversal-safe resource placement, the home-bin hooks
 * block, or the serve-wrapper MCP entry. Reusing these keeps telemetry-wrap +
 * the universal home-bin hook command byte-identical to the live adapters.
 */

import { dirname, relative, resolve, sep } from "node:path";
import { writeFileSync } from "node:fs";

import type {
  HookEventName,
  PlatformId,
  ResolvedConnector,
} from "../types.js";
import { ensureDir } from "../paths.js";
import {
  buildHomeBinHookCommand,
  buildServeWrapperCommand,
  shouldWrapForTelemetry,
} from "../spawn.js";

/** Inputs every format emitter receives. */
export interface EmitContext {
  /** Directory the bundle is written under (the format root). */
  outDir: string;
  /** Absolute path to agent-connector's stable home-bin (hooks + serve wrapper point here). */
  homeBinPath: string;
  /** Enumerate the file list without writing anything. */
  dryRun: boolean;
}

/** What every format emitter returns. */
export interface PackageResult {
  /** Absolute paths of every file the bundle comprises (written, or planned for dryRun). */
  files: string[];
  /** Absolute path to the plugin/extension root directory. */
  pluginDir: string;
  /** Absolute path to the emitted marketplace catalog, when the format has one. */
  marketplacePath?: string;
  /**
   * Human-readable notes about surfaces the format intentionally DROPS (e.g.
   * Kimi ignores hooks/commands/subagents). The CLI surfaces these so a lossy
   * bundle is never silent. Empty when nothing was dropped.
   */
  notes?: string[];
}

/** The shared signature every `package-formats/<family>.ts` exports. */
export type FormatEmitter = (
  connector: ResolvedConnector,
  ctx: EmitContext,
) => PackageResult;

/** A small file-collecting writer bound to one emit run (honors dryRun). */
export interface Emitter {
  /** Write `contents` to `path` (skipped under dryRun) and record it. */
  emit(path: string, contents: string): void;
  /** The accumulated absolute file list (in emit order). */
  readonly files: string[];
}

/** Build a dryRun-aware {@link Emitter} that records every (would-be) write. */
export function createEmitter(dryRun: boolean): Emitter {
  const files: string[] = [];
  return {
    files,
    emit(path: string, contents: string): void {
      if (!dryRun) {
        ensureDir(dirname(path));
        writeFileSync(path, contents, "utf8");
      }
      files.push(path);
    },
  };
}

/** Pretty-print a value as 2-space JSON with a trailing newline. */
export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Resolve a skill-resource relative key against `baseDir`, returning the
 * absolute target ONLY when it stays inside the dir (defense-in-depth — config
 * validation already rejects traversal, but never trust input). Null otherwise.
 */
export function resolveWithin(baseDir: string, rel: string): string | null {
  const base = resolve(baseDir);
  const target = resolve(base, rel);
  if (target === base) return null;
  const rind = relative(base, target);
  if (rind === "" || rind.startsWith("..") || resolve(base, rind) !== target) {
    return null;
  }
  if (rind === ".." || rind.startsWith(`..${sep}`)) return null;
  return target;
}

/** Pass env through unchanged when present, else undefined (drops empty objects). */
export function renderEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!env || Object.keys(env).length === 0) return undefined;
  return { ...env };
}

// ─────────────────────────────────────────────────────────────────────────
// Hooks — the Claude-shaped hooks.json block, shared by every format whose
// hooks file mirrors Claude Code's `{ type:"command", command:"<string>" }`.
// ─────────────────────────────────────────────────────────────────────────

/** Claude event names a Claude-style plugin's hooks.json may key on. */
export const CLAUDE_MAPPED_EVENTS: ReadonlySet<HookEventName> =
  new Set<HookEventName>([
    "PreToolUse",
    "PostToolUse",
    "PreCompact",
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "Stop",
    "Notification",
  ]);

/** A single hooks.json entry (identical in shape to a settings.json hooks block). */
export interface PluginHookEntry {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/**
 * Build the Claude-shaped hooks.json body for the MAPPED events the connector
 * declares. Each command is the SAME single-string home-bin form the live
 * adapters write (via buildHomeBinHookCommand). `platformId` lets a format point
 * the hook at the right host (e.g. "cursor", "claude-code"). Returns null when
 * the connector declares no mapped events.
 */
export function buildClaudeHooksJson(
  connector: ResolvedConnector,
  homeBin: string,
  platformId: PlatformId,
): { hooks: Record<string, PluginHookEntry[]> } | null {
  const events = connector.hookEvents.filter((e) => CLAUDE_MAPPED_EVENTS.has(e));
  if (events.length === 0) return null;

  const hooks: Record<string, PluginHookEntry[]> = {};
  for (const event of events) {
    const matcher = connector.hooks[event]?.matcher ?? "";
    const command = {
      type: "command" as const,
      command: buildHomeBinHookCommand(homeBin, platformId, event, connector.id),
    };
    hooks[event] = [matcher ? { matcher, hooks: [command] } : { hooks: [command] }];
  }
  return { hooks };
}

// ─────────────────────────────────────────────────────────────────────────
// MCP — the serve-wrapped stdio server entry, shared by every format whose MCP
// file carries a launchable { command, args, env?, cwd? } (the Claude .mcp.json
// dialect). Remote/non-stdio servers are out of scope for a launchable bundle.
// ─────────────────────────────────────────────────────────────────────────

/** Native MCP server entry shape a Claude-dialect mcpServers map accepts. */
export interface PluginMcpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Render the connector's ServerDef into a serve-wrapped MCP entry for
 * `platformId`, so per-tool telemetry carries through the bundle exactly as the
 * live adapter's install does. Returns null when there is no stdio command to
 * launch (remote / server-less connectors). The returned `serverName` is the
 * connector id (the conventional single-server key).
 */
export function buildMcpEntry(
  connector: ResolvedConnector,
  homeBin: string,
  platformId: PlatformId,
): { serverName: string; entry: PluginMcpEntry } | null {
  const server = connector.server;
  if (!server) return null;
  // A launchable bundle entry can only carry stdio servers; remote (http/sse/ws)
  // servers register a URL elsewhere, out of scope for the bundled plugin.
  if (server.transport !== "stdio") return null;

  const realCommand = server.command ?? "";
  if (realCommand === "") return null;
  const realArgs = [...(server.args ?? [])];

  let entry: PluginMcpEntry;
  if (shouldWrapForTelemetry(server, connector.telemetry)) {
    const wrapped = buildServeWrapperCommand(
      homeBin,
      connector.id,
      realCommand,
      realArgs,
      undefined,
      platformId,
    );
    entry = { command: wrapped.command, args: wrapped.args };
  } else {
    entry = { command: realCommand, args: realArgs };
  }

  const env = renderEnv(server.env);
  if (env) entry.env = env;
  if (server.cwd) entry.cwd = server.cwd;

  return { serverName: connector.id, entry };
}
