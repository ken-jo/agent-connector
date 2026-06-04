/**
 * core/package — emit a marketplace-installable Claude Code plugin bundle.
 *
 * Turns a ResolvedConnector into a self-contained plugin directory plus a
 * sibling marketplace.json, laid out exactly as the Claude Code plugin +
 * marketplace spec requires:
 *
 *   <outDir>/
 *   ├── .claude-plugin/marketplace.json          (lists the one plugin; source ./<id>)
 *   └── <id>/                                     (the plugin root)
 *       ├── .claude-plugin/plugin.json            (ONLY file inside .claude-plugin/)
 *       ├── commands/<name>.md                    (one per connector.command)
 *       ├── agents/<name>.md                      (one per connector.subagent)
 *       ├── skills/<name>/SKILL.md (+ resources)  (one dir per connector.skill)
 *       ├── hooks/hooks.json                      (mapped claude-code events only)
 *       └── .mcp.json                             (connector.server, serve-wrapped)
 *
 * STRICT layout rule honored: only plugin.json lives under `.claude-plugin/`;
 * every component dir (commands/agents/skills/hooks) sits at the plugin ROOT.
 *
 * The command / skill / subagent markdown is rendered through the SAME shared
 * helpers (adapters/claude-code/render) the live claude-code adapter writes
 * with, so an installed plugin and a `agent-connector install` produce
 * byte-identical content files.
 *
 * Hooks point at agent-connector's external home-bin via an ABSOLUTE path in
 * EXEC form (`args: ["hook", "claude-code", "<event>", "--connector", "<id>"]`),
 * which means the plugin hard-depends on agent-connector being installed at that
 * path — the same coupling the install path has. The MCP server is wrapped with
 * `serve` for transparent telemetry, also via the home-bin.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import type {
  HookEventName,
  ResolvedConnector,
  ServerDef,
} from "./types.js";
import { ensureDir, homeBinPath as defaultHomeBinPath } from "./paths.js";
import {
  buildHomeBinHookCommand,
  buildServeWrapperCommand,
  shouldWrapForTelemetry,
} from "./spawn.js";
import {
  renderCommandMd,
  renderSkillMd,
  renderSubagentMd,
} from "../adapters/claude-code/render.js";

/** The one packaging format supported today. */
export type PackageFormat = "claude-plugin";

export interface PackageOptions {
  /** Directory the bundle is written under (the marketplace root). */
  outDir: string;
  /** Output format. Only "claude-plugin" today (also the default). */
  format?: PackageFormat;
  /**
   * Absolute path to agent-connector's stable home-bin that hooks + the MCP
   * serve-wrapper point at. Defaults to {@link defaultHomeBinPath}.
   */
  homeBinPath?: string;
  /** Compute the file list without writing anything. */
  dryRun?: boolean;
}

export interface PackageResult {
  /** Absolute paths of every file the bundle comprises (written, or planned for dryRun). */
  files: string[];
  /** Absolute path to the emitted marketplace.json. */
  marketplacePath: string;
  /** Absolute path to the plugin root directory (<outDir>/<id>). */
  pluginDir: string;
}

/** Claude event names a claude-code plugin's hooks.json may key on. */
const CLAUDE_MAPPED_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "Notification",
]);

/** A single hooks.json entry, identical in shape to a settings.json hooks block. */
interface PluginHookEntry {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/**
 * Build the plugin manifest emitted at <plugin-root>/.claude-plugin/plugin.json.
 * Only `name` is strictly required; we additionally emit `description` (always)
 * and a `version` ONLY when the connector declares a meaningful one (omitting it
 * lets the git commit SHA drive updates for actively-developed connectors — and
 * never sets version in BOTH places).
 */
function buildPluginManifest(connector: ResolvedConnector): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    $schema: "https://json.schemastore.org/claude-code-plugin-manifest.json",
    name: connector.id,
    description: `${connector.displayName} — connector emitted by agent-connector`,
  };
  // Only carry a version when the connector pins a real (non-placeholder) one;
  // defineConnector defaults version to "0.0.0", which we treat as "unset" so
  // the git commit SHA drives plugin updates.
  if (connector.version && connector.version !== "0.0.0") {
    manifest.version = connector.version;
  }
  return manifest;
}

/**
 * Build the marketplace manifest emitted at
 * <marketplace-root>/.claude-plugin/marketplace.json. Lists the single plugin
 * with a relative `source` of `./<id>` (resolved against the marketplace ROOT).
 * `owner` is an OBJECT (a frequent emitter bug to get wrong).
 */
function buildMarketplaceManifest(
  connector: ResolvedConnector,
): Record<string, unknown> {
  return {
    name: "agent-connector",
    owner: { name: "agent-connector" },
    plugins: [
      {
        name: connector.id,
        source: `./${connector.id}`,
        description: `${connector.displayName} — connector emitted by agent-connector`,
      },
    ],
  };
}

/**
 * Build the hooks.json body for the MAPPED claude-code events the connector
 * declares. Each hook command is the SAME single-string form the claude-code
 * adapter writes (via buildHomeBinHookCommand) — Claude Code's hooks schema is
 * `{ type:"command", command:"<shell string>" }` with NO separate args array, so
 * the home-bin path + its args are joined into one quoted command string.
 * Returns null when there is nothing to write.
 */
function buildHooksJson(
  connector: ResolvedConnector,
  homeBin: string,
): { hooks: Record<string, PluginHookEntry[]> } | null {
  const events = connector.hookEvents.filter((e) => CLAUDE_MAPPED_EVENTS.has(e));
  if (events.length === 0) return null;

  const hooks: Record<string, PluginHookEntry[]> = {};
  for (const event of events) {
    const matcher = connector.hooks[event]?.matcher ?? "";
    const command = {
      type: "command" as const,
      command: buildHomeBinHookCommand(homeBin, "claude-code", event, connector.id),
    };
    const entry: PluginHookEntry = matcher
      ? { matcher, hooks: [command] }
      : { hooks: [command] };
    hooks[event] = [entry];
  }
  return { hooks };
}

/** Native MCP server entry shape a claude-code plugin's .mcp.json accepts. */
interface PluginMcpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Render the connector's ServerDef into the plugin .mcp.json entry, wrapping the
 * real stdio command with `serve` for transparent telemetry where applicable.
 * Returns null when there is no stdio server to register (remote/no server).
 */
function buildMcpJson(
  connector: ResolvedConnector,
  homeBin: string,
): { mcpServers: Record<string, PluginMcpEntry> } | null {
  const server = connector.server;
  if (!server) return null;
  // The plugin .mcp.json carries a launchable command, so only stdio servers
  // are emitted here (remote/http servers register a URL elsewhere, out of scope
  // for the bundled plugin).
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
      "claude-code",
    );
    entry = { command: wrapped.command, args: wrapped.args };
  } else {
    entry = { command: realCommand, args: realArgs };
  }

  const env = renderEnv(server.env);
  if (env) entry.env = env;
  if (server.cwd) entry.cwd = server.cwd;

  return { mcpServers: { [connector.id]: entry } };
}

/** Pass env through unchanged when present, else undefined (drops empty objects). */
function renderEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!env || Object.keys(env).length === 0) return undefined;
  return { ...env };
}

/**
 * Resolve a skill-resource relative key against the skill dir, returning the
 * absolute target ONLY when it stays inside the dir (defense-in-depth — the
 * config-time validation already rejects traversal, but never trust input).
 */
function resolveWithin(baseDir: string, rel: string): string | null {
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

/**
 * Emit a marketplace-installable Claude Code plugin bundle for `connector`.
 *
 * Writes (or, for dryRun, only enumerates) the plugin tree + a sibling
 * marketplace.json under `opts.outDir`. Returns the absolute file list, the
 * marketplace.json path, and the plugin root dir.
 */
export function packageConnector(
  connector: ResolvedConnector,
  opts: {
    outDir: string;
    format?: PackageFormat;
    homeBinPath?: string;
    dryRun?: boolean;
  },
): PackageResult {
  const format = opts.format ?? "claude-plugin";
  if (format !== "claude-plugin") {
    throw new Error(`unsupported package format: ${format}`);
  }

  const dryRun = opts.dryRun ?? false;
  const homeBin = opts.homeBinPath ?? defaultHomeBinPath();

  const outDir = resolve(opts.outDir);
  const pluginDir = join(outDir, connector.id);
  const marketplacePath = join(outDir, ".claude-plugin", "marketplace.json");

  const files: string[] = [];

  /** Write `contents` to `path` (skipping the write under dryRun) and record it. */
  const emit = (path: string, contents: string): void => {
    if (!dryRun) {
      ensureDir(dirname(path));
      writeFileSync(path, contents, "utf8");
    }
    files.push(path);
  };

  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

  // ── plugin.json (the ONLY file inside .claude-plugin/) ───────────────────
  const pluginManifestPath = join(pluginDir, ".claude-plugin", "plugin.json");
  emit(pluginManifestPath, json(buildPluginManifest(connector)));

  // ── commands/<name>.md ───────────────────────────────────────────────────
  for (const cmd of connector.commands) {
    emit(join(pluginDir, "commands", `${cmd.name}.md`), renderCommandMd(cmd));
  }

  // ── agents/<name>.md ──────────────────────────────────────────────────────
  for (const agent of connector.subagents) {
    emit(join(pluginDir, "agents", `${agent.name}.md`), renderSubagentMd(agent));
  }

  // ── skills/<name>/SKILL.md (+ resources) ──────────────────────────────────
  for (const skill of connector.skills) {
    const skillDir = join(pluginDir, "skills", skill.name);
    emit(join(skillDir, "SKILL.md"), renderSkillMd(skill));
    for (const [rel, contents] of Object.entries(skill.resources ?? {})) {
      const target = resolveWithin(skillDir, rel);
      if (target === null) continue; // never write outside the skill dir
      emit(target, contents);
    }
  }

  // ── hooks/hooks.json (mapped claude-code events only) ─────────────────────
  const hooksJson = buildHooksJson(connector, homeBin);
  if (hooksJson) emit(join(pluginDir, "hooks", "hooks.json"), json(hooksJson));

  // ── .mcp.json (serve-wrapped stdio server) ────────────────────────────────
  const mcpJson = buildMcpJson(connector, homeBin);
  if (mcpJson) emit(join(pluginDir, ".mcp.json"), json(mcpJson));

  // ── marketplace.json (lists this plugin; source ./<id>) ───────────────────
  emit(marketplacePath, json(buildMarketplaceManifest(connector)));

  return { files, marketplacePath, pluginDir };
}

/** Read + parse a JSON file (used by callers/tests). Returns null on absence/parse error. */
export function readPackagedJson<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
