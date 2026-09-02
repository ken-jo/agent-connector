/**
 * core/package-formats/agent-plugin — the `agent-plugin` emitter: an
 * **Agent Plugins 1.0.0** package (https://agent-plugins.org — the Vercel-led
 * open spec co-maintained with AWS, Cursor, GitHub, Microsoft and OpenAI).
 *
 * This is the SINGLE SOURCE OF TRUTH bundle for every host that speaks the
 * spec. One directory, installed through each client's own plugin flow:
 *   • Codex / ChatGPT      — root plugin.json is Codex's preferred manifest
 *                            (codex-rs/utils/plugins: `find_plugin_manifest_path`
 *                            checks it before `.codex-plugin/`); hooks arrive via
 *                            the `com.openai` extension namespace. The codex
 *                            marketplace driver stages THIS bundle (live-verified
 *                            0.149: `plugin marketplace add` + `plugin add`).
 *   • GitHub Copilot CLI / VS Code / JetBrains Copilot — hooks, agents and
 *                            commands ride in `com.github.copilot/`; the copilot
 *                            driver stages THIS bundle (live-verified CLI 1.0.80),
 *                            and VS Code auto-imports what the CLI installed.
 *   • Kiro, Hermes, Cursor, OpenClaw, … — portable skills + MCP.
 * Hosts that do not speak the spec (Claude Code, Antigravity, Gemini CLI, Qwen
 * Code, Droid, Kimi, OpenCode/Kilo/Pi) keep their native formats.
 *
 * Layout (spec §4–§8):
 *   <outDir>/<id>/
 *   ├── plugin.json                 REQUIRED manifest — closed schema:
 *   │                               $schema (const) + name (slug) + optional
 *   │                               version/description/author/extensions
 *   ├── mcp.json                    portable MCP servers: stdio |
 *   │                               streamable-http | sse (closed variants)
 *   ├── bin/agent-connector.mjs     PORTABLE LAUNCHER (see below)
 *   ├── skills/<n>/SKILL.md (+res)  Agent Skills (agentskills.io) — immediate
 *   │                               children of skills/ only (§6.1)
 *   ├── com.github.copilot/         CLIENT EXTENSION namespaces (§8.2): hooks,
 *   │   ├── hooks/hooks.json        commands and subagents are NOT portable v1
 *   │   ├── commands/<n>.md         components, so each client that documents a
 *   │   └── agents/<n>.agent.md     namespace gets its own copy (CLIENT_NAMESPACES);
 *   ├── com.openai/hooks/hooks.json clients ignore namespaces they do not own
 *   └── README.md                   install notes
 *   <outDir>/.claude-plugin/marketplace.json   local catalogs so the two-step
 *   <outDir>/.agents/plugins/marketplace.json  copilot / codex `marketplace add
 *                                              <outDir>` + install still works
 *
 * THE LAUNCHER — why the bundle never embeds a machine path (§7.2.1):
 *   `command` MUST be ONE executable token — a bare name resolved by the
 *   platform's search rules, or a plugin-relative `./…` path. An absolute path
 *   is NON-conformant, and a fatal schema violation makes the client reject the
 *   WHOLE plugin (§5.2). So instead of baking `~/.agent-connector/bin/...` in,
 *   the bundle ships `bin/agent-connector.mjs`, launched as
 *   `node ${PLUGIN_ROOT}/bin/agent-connector.mjs …` (`${PLUGIN_ROOT}` expansion
 *   in args is spec-mandated, §7.2.3; `node` is the one bare dependency the
 *   framework already has). At run time it resolves the framework runtime in a
 *   fixed order — the stable home binary (present on any machine that ran a
 *   branded `install`), then `agent-connector` on PATH (a global install), then
 *   `npx @ken-jo/agent-connector@^<range>` — so the SAME bundle works for a
 *   local marketplace install AND for shared distribution, and the runtime stays
 *   the one home binary (R1).
 *
 *   Hooks are client-namespace content, outside the spec's path rules, so each
 *   namespace uses the command form its client documents: Copilot / VS Code
 *   expand `${PLUGIN_ROOT}` in hook commands → the launcher; Codex documents no
 *   root token for hook commands → the SAME absolute home-bin command the
 *   native codex-plugin bundle always carried (staged locally by the driver).
 *
 *   Other conformance rules honored: `cwd` MUST be `./…`, `${PLUGIN_ROOT}…` or
 *   `${PLUGIN_DATA}…`; env keys `PLUGIN_ROOT` / `PLUGIN_DATA` are reserved.
 *   Non-conformant values are dropped with a note rather than emitted invalid.
 *
 * Remote servers ARE carried (the only bundle format that does): an `http`
 * transport maps to `streamable-http`, `sse` to the legacy `sse` variant; `ws`
 * has no spec analog and is dropped with a note. The remote URL/headers pass
 * through verbatim (the spec forbids placeholder expansion there).
 */

import { join } from "node:path";

import type { PlatformId, ResolvedConnector, ServerDef } from "../types.js";
import {
  renderCommandMd,
  renderSkillMd,
  renderSubagentMd,
} from "../../adapters/claude-code/render.js";
import { buildHomeBinHookCommand, shouldWrapForTelemetry } from "../spawn.js";
import {
  AGENT_CONNECTOR_PACKAGE_NAME,
  CLAUDE_MAPPED_EVENTS,
  createEmitter,
  json,
  renderEnv,
  resolveFrameworkDependencyRange,
  resolveWithin,
  type EmitContext,
  type FormatEmitter,
  type PackageResult,
  type PluginHookEntry,
} from "./shared.js";

/** Canonical Agent Plugins 1.0.0 manifest schema id (plugin.json `$schema`, const). */
export const AGENT_PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
/** Canonical Agent Plugins 1.0.0 MCP schema id (mcp.json `$schema`, const). */
export const AGENT_PLUGIN_MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
/** Spec version this emitter targets (drives both `$schema` ids). */
export const AGENT_PLUGIN_SPEC_VERSION = "1.0.0";

/** Plugin-relative path of the portable launcher the MCP entry + hooks run. */
export const AGENT_PLUGIN_LAUNCHER = "bin/agent-connector.mjs";

/** The catalog name every emitted marketplace.json carries (`<id>@agent-connector`). */
const CATALOG_NAME = "agent-connector";

/**
 * How a client namespace's hook commands reach the framework runtime.
 *   "plugin-root-launcher" — `node "${PLUGIN_ROOT}/bin/agent-connector.mjs" hook …`
 *                            (clients that expand `${PLUGIN_ROOT}` in hook commands)
 *   "home-bin"             — `"<homeBinPath>" hook …` (the universal home-bin
 *                            command; clients with no documented root token)
 */
export type HookCommandStyle = "plugin-root-launcher" | "home-bin";

/**
 * A client extension namespace (§8.2) this emitter populates. Hooks, commands
 * and subagents are client-specific, so ONE bundle carries a copy per client
 * that documents a namespace; every other client ignores dirs it does not own.
 */
export interface ClientNamespace {
  /** Reverse-domain directory name at the plugin root. */
  readonly namespace: string;
  /** Human-readable client name for notes/README. */
  readonly label: string;
  /** Default `--host` stamp for this namespace's hooks (telemetry attribution). */
  readonly platform: PlatformId;
  /**
   * Every PlatformId that reads this namespace. A staging `hostHint` matching
   * one of these restamps the hooks for that exact host.
   */
  readonly readers: readonly PlatformId[];
  /** Hook command form this client documents. */
  readonly hookStyle: HookCommandStyle;
  /** Subagent file name inside `<ns>/agents/` (null: client reads no agents dir). */
  readonly agentFile: ((name: string) => string) | null;
  /** Command file name inside `<ns>/commands/` (null: client reads no commands dir). */
  readonly commandFile: ((name: string) => string) | null;
  /**
   * Manifest `extensions[<namespace>]` entry the client needs to find the
   * namespace files (Codex resolves hooks from its extension object). Null when
   * the client discovers the directory by convention.
   */
  readonly manifestExtension: ((paths: { hooks?: string }) => Record<string, unknown>) | null;
}

/**
 * Documented client namespaces — the data every namespace-specific behavior is
 * driven from. Extend this table as more clients document theirs.
 *
 *   com.github.copilot — VS Code docs: `com.github.copilot/hooks/hooks.json`
 *     (hooks) and `com.github.copilot/agents/<n>.agent.md` (custom agents), also
 *     read by Copilot CLI and the Copilot app; commands mirror the Copilot-native
 *     plugin layout. `${PLUGIN_ROOT}` is expanded in hook commands.
 *   com.openai — Codex (codex-rs/core-plugins/agent_plugin_manifest.rs): the
 *     `extensions["com.openai"]` object is parsed as a Codex plugin manifest
 *     overlay whose `hooks` path resolves relative to the plugin root; the
 *     namespace directory holds the hooks file. Codex reads no agents/commands.
 */
export const CLIENT_NAMESPACES: readonly ClientNamespace[] = [
  {
    namespace: "com.github.copilot",
    label: "GitHub Copilot (CLI, VS Code, JetBrains)",
    platform: "copilot-cli",
    readers: ["copilot-cli", "vscode-copilot", "jetbrains-copilot"],
    hookStyle: "plugin-root-launcher",
    agentFile: (name) => `${name}.agent.md`,
    commandFile: (name) => `${name}.md`,
    manifestExtension: null,
  },
  {
    namespace: "com.openai",
    label: "Codex / ChatGPT",
    platform: "codex",
    readers: ["codex"],
    hookStyle: "home-bin",
    agentFile: null,
    commandFile: null,
    manifestExtension: ({ hooks }) => (hooks ? { hooks } : {}),
  },
];

/** Reserved runtime variables a plugin cannot set (§9). */
const RESERVED_ENV_KEYS = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);

/**
 * Coerce a connector id into a spec-conformant plugin `name` (§5.5):
 * 1–64 chars, `[a-z0-9]` with `-`/`.` separators, alphanumeric at both ends,
 * never `--` or `..`. Connector ids are already kebab-case, so this is a
 * defensive normalization, not a rename.
 */
export function toAgentPluginName(id: string): string {
  let name = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/(?:-\.|\.-)+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  if (name.length > 64) {
    name = name.slice(0, 64).replace(/[^a-z0-9]+$/g, "");
  }
  return name.length > 0 ? name : "connector";
}

/** True when `cwd` has one of the three forms the spec permits (§7.2.1). */
function isConformantCwd(cwd: string): boolean {
  return (
    cwd.startsWith("./") ||
    cwd === "${PLUGIN_ROOT}" ||
    cwd.startsWith("${PLUGIN_ROOT}/") ||
    cwd === "${PLUGIN_DATA}" ||
    cwd.startsWith("${PLUGIN_DATA}/")
  );
}

/** True when a stdio `command` is a bare name or a plugin-relative `./` path. */
function isConformantCommand(command: string): boolean {
  if (command.startsWith("./")) return true;
  // A bare executable name carries no path separators.
  return !command.includes("/") && !command.includes("\\");
}

/** A stdio server entry (spec `stdioServer` variant). */
interface StdioServerEntry {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** A remote server entry (spec `streamableHttpServer` | `sseServer` variants). */
interface RemoteServerEntry {
  type: "streamable-http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

type ServerEntry = StdioServerEntry | RemoteServerEntry;

/** The launcher path as the spec's root token spells it (expanded in args + hook commands). */
const LAUNCHER_AT_ROOT = `\${PLUGIN_ROOT}/${AGENT_PLUGIN_LAUNCHER}`;

/** The hook command for one namespace, in the style that client documents. */
function hookCommand(
  style: HookCommandStyle,
  homeBin: string,
  platform: PlatformId,
  event: string,
  connectorId: string,
): string {
  if (style === "home-bin") {
    return buildHomeBinHookCommand(homeBin, platform, event, connectorId);
  }
  return `node "${LAUNCHER_AT_ROOT}" hook ${platform} ${event} --connector ${connectorId}`;
}

/**
 * Render the connector's server into a spec-conformant mcp.json entry, or null
 * when nothing portable can be emitted. Drops (with notes) rather than emitting
 * a value a conforming client would reject.
 */
function buildServerEntry(
  connector: ResolvedConnector,
  hostHint: PlatformId | undefined,
  notes: string[],
): { serverName: string; entry: ServerEntry; wrapped: boolean } | null {
  const server: ServerDef | undefined = connector.server;
  if (!server) return null;
  const serverName = connector.id;

  if (server.transport === "stdio") {
    const realCommand = server.command ?? "";
    if (realCommand === "") return null;
    const realArgs = [...(server.args ?? [])];

    let entry: StdioServerEntry;
    let wrapped = false;
    if (shouldWrapForTelemetry(server, connector.telemetry)) {
      const flags = ["serve", "--connector", connector.id];
      if (hostHint !== undefined) flags.push("--host", hostHint);
      entry = {
        type: "stdio",
        command: "node",
        args: [LAUNCHER_AT_ROOT, ...flags, "--", realCommand, ...realArgs],
      };
      wrapped = true;
    } else {
      entry = { type: "stdio", command: realCommand };
      if (realArgs.length > 0) entry.args = realArgs;
      if (!isConformantCommand(realCommand)) {
        notes.push(
          `agent-plugin: server command "${realCommand}" is neither a bare executable name nor a plugin-relative ./ path — conforming clients may reject it (spec §7.2.1)`,
        );
      }
    }

    const env = renderEnv(server.env);
    if (env) {
      const kept: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        if (RESERVED_ENV_KEYS.has(key)) {
          notes.push(
            `agent-plugin: dropped env "${key}" — PLUGIN_ROOT / PLUGIN_DATA are reserved runtime variables a plugin cannot set`,
          );
          continue;
        }
        kept[key] = value;
      }
      if (Object.keys(kept).length > 0) entry.env = kept;
    }

    if (server.cwd) {
      if (isConformantCwd(server.cwd)) {
        entry.cwd = server.cwd;
      } else {
        notes.push(
          `agent-plugin: dropped cwd "${server.cwd}" — must be ./-relative, \${PLUGIN_ROOT}… or \${PLUGIN_DATA}… (the plugin root is used instead)`,
        );
      }
    }
    return { serverName, entry, wrapped };
  }

  const url = server.url ?? "";
  if (url === "") return null;

  if (server.transport === "ws") {
    notes.push(
      `agent-plugin: dropped the "ws" server — Agent Plugins 1.0.0 defines only stdio, streamable-http and (legacy) sse transports`,
    );
    return null;
  }

  const entry: RemoteServerEntry = {
    type: server.transport === "sse" ? "sse" : "streamable-http",
    url,
  };
  const headers = renderEnv(server.headers);
  if (headers) entry.headers = headers;
  if (server.auth) {
    notes.push(
      `agent-plugin: the server's \`auth\` block is not portable — Agent Plugins carries only literal HTTP headers; the client handles authentication`,
    );
  }
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(?:[:/]|$)/i.test(url)) {
    notes.push(
      `agent-plugin: remote url "${url}" is not HTTPS — the spec requires HTTPS for non-loopback endpoints`,
    );
  }
  return { serverName, entry, wrapped: false };
}

/** Build the Claude-shaped hooks.json for one client namespace, stamped for `platform`. */
function buildNamespaceHooks(
  connector: ResolvedConnector,
  ns: ClientNamespace,
  platform: PlatformId,
  homeBin: string,
): { hooks: Record<string, PluginHookEntry[]> } | null {
  const events = connector.hookEvents.filter((e) => CLAUDE_MAPPED_EVENTS.has(e));
  if (events.length === 0) return null;
  const hooks: Record<string, PluginHookEntry[]> = {};
  for (const event of events) {
    const matcher = connector.hooks[event]?.matcher ?? "";
    const command = {
      type: "command" as const,
      command: hookCommand(ns.hookStyle, homeBin, platform, event, connector.id),
    };
    hooks[event] = [matcher ? { matcher, hooks: [command] } : { hooks: [command] }];
  }
  return { hooks };
}

/** Build plugin.json — every field the closed schema permits that we can populate. */
function buildManifest(
  connector: ResolvedConnector,
  extensions: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    $schema: AGENT_PLUGIN_SCHEMA,
    name: toAgentPluginName(connector.id),
  };
  if (connector.version && connector.version !== "0.0.0") {
    manifest.version = connector.version;
  }
  manifest.description = `${connector.displayName} — connector emitted by agent-connector`;
  const author = connector.publish?.author;
  if (author?.name) {
    const a: Record<string, string> = { name: author.name };
    if (author.email) a.email = author.email;
    if (author.url) a.url = author.url;
    manifest.author = a;
  }
  if (Object.keys(extensions).length > 0) manifest.extensions = extensions;
  return manifest;
}

/**
 * Source of `bin/agent-connector.mjs`. Self-contained ESM, no framework
 * imports: it only locates the runtime and re-executes it with inherited stdio
 * (the MCP stdio proxy and hook JSON pass straight through). Resolution order
 * is fixed and documented in the module header.
 */
export function renderLauncher(): string {
  const range = resolveFrameworkDependencyRange();
  const spec = range === "*" ? AGENT_CONNECTOR_PACKAGE_NAME : `${AGENT_CONNECTOR_PACKAGE_NAME}@${range}`;
  return `#!/usr/bin/env node
/**
 * AUTO-GENERATED by agent-connector — DO NOT EDIT.
 *
 * Portable launcher for the agent-connector runtime. Agent Plugins packages
 * must not embed absolute paths, so this file resolves the runtime at run time:
 *   1. $AGENT_CONNECTOR_HOME_BIN                       (explicit override)
 *   2. <$AGENT_CONNECTOR_DATA_DIR | ~/.agent-connector>/bin/agent-connector  (the stable home binary)
 *   3. \`agent-connector\` on PATH                       (a global install)
 *   4. npx -y ${spec}   (network; last resort)
 * stdio is inherited so the MCP stdio proxy and hook JSON pass straight through.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const win = process.platform === "win32";
const argv = process.argv.slice(2);

function onPath(name) {
  const exts = win ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const dataRoot = process.env.AGENT_CONNECTOR_DATA_DIR || join(homedir(), ".agent-connector");
const homeBin = join(dataRoot, "bin", win ? "agent-connector.cmd" : "agent-connector");
const explicit = process.env.AGENT_CONNECTOR_HOME_BIN;

let command;
let args;
const local = [explicit, homeBin].find((p) => p && existsSync(p)) ?? onPath("agent-connector");
if (local) {
  command = local;
  args = argv;
} else {
  command = win ? "npx.cmd" : "npx";
  args = ["-y", ${JSON.stringify(spec)}, ...argv];
}

// .cmd/.bat wrappers need the shell on Windows; everything else spawns directly.
const shell = win && /\\.(cmd|bat)$/i.test(command);
const child = spawn(command, args, { stdio: "inherit", windowsHide: true, shell });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (err) => {
  process.stderr.write(\`agent-connector launcher: cannot start \${command}: \${err.message}\\n\`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
`;
}

/** The minimal object-owner catalog claude/copilot/codex all read. */
function buildCatalog(connector: ResolvedConnector): Record<string, unknown> {
  return {
    name: CATALOG_NAME,
    owner: { name: connector.publish?.author?.name ?? CATALOG_NAME },
    plugins: [
      {
        name: connector.id,
        source: `./${connector.id}`,
        description: `${connector.displayName} — connector emitted by agent-connector`,
      },
    ],
  };
}

/** The bundle README: what is inside + how a consumer installs it. */
function buildReadme(
  connector: ResolvedConnector,
  has: { mcp: boolean; skills: boolean; namespaces: ClientNamespace[]; launcher: boolean },
): string {
  const lines: string[] = [
    `# ${connector.displayName} — Agent Plugin`,
    "",
    `An [Agent Plugins ${AGENT_PLUGIN_SPEC_VERSION}](https://agent-plugins.org) package for the`,
    `\`${connector.id}\` connector, emitted by agent-connector.`,
    "",
    "## Contents",
    "",
    "- `plugin.json` — the plugin manifest",
  ];
  if (has.mcp) lines.push("- `mcp.json` — the MCP server entry");
  if (has.skills) lines.push("- `skills/<name>/SKILL.md` — Agent Skills");
  for (const ns of has.namespaces) {
    lines.push(
      `- \`${ns.namespace}/\` — client extension namespace for ${ns.label} (other clients ignore it)`,
    );
  }
  if (has.launcher) {
    lines.push(
      `- \`${AGENT_PLUGIN_LAUNCHER}\` — portable launcher that locates the agent-connector runtime (home binary → PATH → npx) so per-tool token telemetry carries through without any absolute path in the bundle`,
    );
  }
  lines.push(
    "",
    "## Install",
    "",
    "Locally, the directory ABOVE this one is a marketplace root — register it and",
    `install by name: \`copilot plugin marketplace add <root> && copilot plugin install ${connector.id}@${CATALOG_NAME}\``,
    `or \`codex plugin marketplace add <root> && codex plugin add ${connector.id}@${CATALOG_NAME}\`.`,
    "",
    "To share it, push this directory to a git repository and install it from",
    "source with your client's plugin flow — in VS Code run **Chat: Install Plugin",
    "From Source** from the Command Palette and enter the repository URL. Every",
    "Agent Plugins client has an equivalent: https://agent-plugins.org/compatible-clients",
    "",
  );
  return lines.join("\n");
}

/**
 * Parse an Agent Plugins manifest (a root plugin.json carrying the AP `$schema`).
 * Returns null for anything else, so callers can use it as the format marker.
 */
export function readAgentPluginManifest(
  manifestJson: string,
): { name?: string; version?: string; description?: string } | null {
  try {
    const parsed = JSON.parse(manifestJson) as Record<string, unknown>;
    if (parsed.$schema !== AGENT_PLUGIN_SCHEMA) return null;
    return parsed as { name?: string; version?: string; description?: string };
  } catch {
    return null;
  }
}

export const emitAgentPlugin: FormatEmitter = (
  connector: ResolvedConnector,
  ctx: EmitContext,
): PackageResult => {
  const { emit, files } = createEmitter(ctx.dryRun);
  const pluginDir = join(ctx.outDir, connector.id);
  const notes: string[] = [];
  const hostHint = ctx.hostHint;

  // ── client extension namespaces (non-portable surfaces, one copy each) ────
  // Computed first: Codex needs the hooks path inside the manifest.
  const hasHooks = connector.hookEvents.some((e) => CLAUDE_MAPPED_EVENTS.has(e));
  const populated: ClientNamespace[] = [];
  const extensions: Record<string, Record<string, unknown>> = {};
  const namespaceFiles: Array<{ path: string; contents: string }> = [];
  let launcherHooks = false;
  let homeBinHooks = false;
  for (const ns of CLIENT_NAMESPACES) {
    const extDir = join(pluginDir, ns.namespace);
    const platform =
      hostHint !== undefined && ns.readers.includes(hostHint) ? hostHint : ns.platform;
    const hooksRel = `${ns.namespace}/hooks/hooks.json`;
    let wrote = false;
    const hooksJson = hasHooks ? buildNamespaceHooks(connector, ns, platform, ctx.homeBinPath) : null;
    if (hooksJson) {
      namespaceFiles.push({ path: join(extDir, "hooks", "hooks.json"), contents: json(hooksJson) });
      if (ns.hookStyle === "plugin-root-launcher") launcherHooks = true;
      else homeBinHooks = true;
      wrote = true;
    }
    if (ns.commandFile) {
      for (const cmd of connector.commands) {
        namespaceFiles.push({
          path: join(extDir, "commands", ns.commandFile(cmd.name)),
          contents: renderCommandMd(cmd),
        });
        wrote = true;
      }
    }
    if (ns.agentFile) {
      for (const agent of connector.subagents) {
        namespaceFiles.push({
          path: join(extDir, "agents", ns.agentFile(agent.name)),
          contents: renderSubagentMd(agent),
        });
        wrote = true;
      }
    }
    if (!wrote) continue;
    populated.push(ns);
    if (ns.manifestExtension) {
      const ext = ns.manifestExtension({ hooks: hooksJson ? `./${hooksRel}` : undefined });
      if (Object.keys(ext).length > 0) extensions[ns.namespace] = ext;
    }
  }

  // ── plugin.json (REQUIRED, at the plugin root) ────────────────────────────
  emit(join(pluginDir, "plugin.json"), json(buildManifest(connector, extensions)));

  // ── mcp.json (portable stdio | streamable-http | sse) ─────────────────────
  const mcp = buildServerEntry(connector, hostHint, notes);
  if (mcp) {
    emit(
      join(pluginDir, "mcp.json"),
      json({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { [mcp.serverName]: mcp.entry },
      }),
    );
  }

  // ── skills/<name>/SKILL.md (+ resources) — Agent Skills, immediate children ─
  for (const skill of connector.skills) {
    const skillDir = join(pluginDir, "skills", skill.name);
    emit(join(skillDir, "SKILL.md"), renderSkillMd(skill));
    for (const [rel, contents] of Object.entries(skill.resources ?? {})) {
      const target = resolveWithin(skillDir, rel);
      if (target === null) continue; // never write outside the skill dir
      emit(target, contents);
    }
  }

  // ── <namespace>/… ─────────────────────────────────────────────────────────
  for (const f of namespaceFiles) emit(f.path, f.contents);
  if (populated.length > 0) {
    notes.push(
      `agent-plugin: hooks/commands/subagents are not portable Agent Plugins 1.0 components — emitted under the ${populated
        .map((ns) => `${ns.namespace}/`)
        .join(", ")} client extension namespace(s); clients ignore namespaces they do not own`,
    );
  }

  // ── bin/agent-connector.mjs — the portable launcher ───────────────────────
  const launcher = launcherHooks || (mcp !== null && mcp.wrapped);
  if (launcher) {
    emit(join(pluginDir, AGENT_PLUGIN_LAUNCHER), renderLauncher());
    notes.push(
      `agent-plugin: the MCP entry${launcherHooks ? " and Copilot hooks" : ""} run through the bundled launcher ${AGENT_PLUGIN_LAUNCHER} (no absolute path — resolves the home binary, then PATH, then npx ${AGENT_CONNECTOR_PACKAGE_NAME})`,
    );
  }
  if (homeBinHooks) {
    notes.push(
      `agent-plugin: com.openai/ hooks call this machine's agent-connector launcher (${ctx.homeBinPath}) — Codex documents no plugin-root token for hook commands; valid for a local install, re-run \`package\` per machine to share`,
    );
  }

  // ── README.md ─────────────────────────────────────────────────────────────
  emit(
    join(pluginDir, "README.md"),
    buildReadme(connector, {
      mcp: mcp !== null,
      skills: connector.skills.length > 0,
      namespaces: populated,
      launcher,
    }),
  );

  // ── local marketplace catalogs (outDir level, outside the plugin) ─────────
  // The same object-owner catalog at both documented locations, so
  // `copilot plugin marketplace add <outDir>` and `codex plugin marketplace add
  // <outDir>` (which REJECTS a `.codex-plugin/` catalog) both resolve `./<id>`.
  const catalog = json(buildCatalog(connector));
  const marketplacePath = join(ctx.outDir, ".claude-plugin", "marketplace.json");
  emit(marketplacePath, catalog);
  emit(join(ctx.outDir, ".agents", "plugins", "marketplace.json"), catalog);

  const result: PackageResult = { files, pluginDir, marketplacePath };
  if (notes.length > 0) result.notes = notes;
  return result;
};
