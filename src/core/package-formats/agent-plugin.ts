/**
 * core/package-formats/agent-plugin — the `agent-plugin` emitter: an
 * **Agent Plugins 1.0.0** package (https://agent-plugins.org — the Vercel-led
 * open spec co-maintained with AWS, Cursor, GitHub, Microsoft and OpenAI).
 *
 * Unlike every host-specific bundle, this format is PORTABLE: one directory
 * that any conforming client (VS Code, Cursor, GitHub Copilot, ChatGPT/Codex,
 * Kiro, Hermes, OpenClaw, …) installs through its own plugin flow, with no
 * per-host restamp and NO absolute path baked in.
 *
 * Layout (spec §4–§8):
 *   <outDir>/<id>/
 *   ├── plugin.json                 REQUIRED manifest — closed schema:
 *   │                               $schema (const) + name (slug) + optional
 *   │                               version/description/author/…
 *   ├── mcp.json                    portable MCP servers: stdio |
 *   │                               streamable-http | sse (closed variants)
 *   ├── skills/<n>/SKILL.md (+res)  Agent Skills (agentskills.io) — immediate
 *   │                               children of skills/ only (§6.1)
 *   ├── com.github.copilot/         CLIENT EXTENSION namespace (§8.2): hooks,
 *   │   ├── hooks/hooks.json        commands and subagents are NOT portable
 *   │   ├── commands/<n>.md         v1 components, so they ride in the
 *   │   └── agents/<n>.md           namespace VS Code / Copilot documents
 *   └── README.md                   install + PATH prerequisite
 *
 * Two spec rules shape the MCP entry (§7.2.1):
 *   • `command` MUST be ONE executable token — a bare name resolved by the
 *     platform's search rules, or a plugin-relative `./…` path. An absolute
 *     path is NON-conformant. So this emitter never embeds the machine's
 *     home-bin path: the telemetry serve-wrapper + hooks invoke the bare
 *     `agent-connector` bin (the framework CLI on PATH), exactly like the
 *     npm-plugin bridge's PATH fallback. A note records the prerequisite.
 *   • `cwd` MUST be `./…`, `${PLUGIN_ROOT}…` or `${PLUGIN_DATA}…`; env keys
 *     `PLUGIN_ROOT` / `PLUGIN_DATA` are reserved. Non-conformant values are
 *     dropped with a note rather than emitted invalid (a fatal schema violation
 *     makes the client reject the WHOLE plugin — §5.2).
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
import { buildServeWrapperCommand, shouldWrapForTelemetry } from "../spawn.js";
import {
  buildClaudeHooksJson,
  createEmitter,
  json,
  renderEnv,
  resolveWithin,
  type EmitContext,
  type FormatEmitter,
  type PackageResult,
} from "./shared.js";

/** Canonical Agent Plugins 1.0.0 manifest schema id (plugin.json `$schema`, const). */
export const AGENT_PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
/** Canonical Agent Plugins 1.0.0 MCP schema id (mcp.json `$schema`, const). */
export const AGENT_PLUGIN_MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
/** Spec version this emitter targets (drives both `$schema` ids). */
export const AGENT_PLUGIN_SPEC_VERSION = "1.0.0";

/**
 * The bare framework bin the MCP serve-wrapper + hooks invoke. The spec
 * forbids absolute `command` paths, so the portable bundle resolves the CLI by
 * name on PATH instead of the machine-local home-bin.
 */
export const AGENT_PLUGIN_BIN = "agent-connector";

/**
 * Reverse-domain client extension namespace for GitHub Copilot / VS Code — the
 * one launch client that documents hooks, commands and agents inside an Agent
 * Plugins package (`com.github.copilot/hooks/hooks.json` per VS Code docs;
 * commands/ and agents/ follow the Copilot-native plugin layout relocated
 * under the namespace).
 */
export const COPILOT_EXTENSION_NAMESPACE = "com.github.copilot";

/** Host stamped into the namespaced hooks (telemetry routes to the Copilot host). */
const EXTENSION_PLATFORM: PlatformId = "copilot-cli";

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

/**
 * Render the connector's server into a spec-conformant mcp.json entry, or null
 * when nothing portable can be emitted. Drops (with notes) rather than emitting
 * a value a conforming client would reject.
 */
function buildServerEntry(
  connector: ResolvedConnector,
  notes: string[],
): { serverName: string; entry: ServerEntry } | null {
  const server: ServerDef | undefined = connector.server;
  if (!server) return null;
  const serverName = connector.id;

  if (server.transport === "stdio") {
    const realCommand = server.command ?? "";
    if (realCommand === "") return null;
    const realArgs = [...(server.args ?? [])];

    let entry: StdioServerEntry;
    if (shouldWrapForTelemetry(server, connector.telemetry)) {
      // Bare bin (PATH-resolved) — never the absolute home-bin path. No --host:
      // the portable bundle does not know which client will launch it, so the
      // serve proxy falls back to runtime host detection.
      const wrapped = buildServeWrapperCommand(
        AGENT_PLUGIN_BIN,
        connector.id,
        realCommand,
        realArgs,
      );
      entry = { type: "stdio", command: wrapped.command, args: wrapped.args };
      notes.push(
        `agent-plugin: the MCP entry is serve-wrapped through the bare \`${AGENT_PLUGIN_BIN}\` command (the Agent Plugins spec forbids absolute command paths) — consumers need the framework CLI on PATH (npm i -g @ken-jo/agent-connector), or disable telemetry wrapping to launch the server directly`,
      );
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
    return { serverName, entry };
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
  return { serverName, entry };
}

/** Build plugin.json — every field the closed schema permits that we can populate. */
function buildManifest(connector: ResolvedConnector): Record<string, unknown> {
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
  return manifest;
}

/** The bundle README: what is inside + how a consumer installs it. */
function buildReadme(
  connector: ResolvedConnector,
  has: { mcp: boolean; skills: boolean; extension: boolean; wrapped: boolean },
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
  if (has.extension) {
    lines.push(
      `- \`${COPILOT_EXTENSION_NAMESPACE}/\` — hooks, slash commands and subagents for GitHub Copilot / VS Code (client extension namespace; other clients ignore it)`,
    );
  }
  lines.push(
    "",
    "## Install",
    "",
    "Push this directory to a git repository, then install it from source with",
    "your client's plugin flow — for example in VS Code run",
    "**Chat: Install Plugin From Source** from the Command Palette and enter the",
    "repository URL. Every Agent Plugins client (Cursor, GitHub Copilot, Codex,",
    "Kiro, …) has an equivalent: https://agent-plugins.org/compatible-clients",
    "",
  );
  if (has.wrapped) {
    lines.push(
      "## Prerequisite",
      "",
      "The MCP entry and hooks invoke the framework CLI by name (`agent-connector`)",
      "so per-tool token telemetry carries through. Install it once:",
      "",
      "```bash",
      "npm install -g @ken-jo/agent-connector",
      "```",
      "",
    );
  }
  return lines.join("\n");
}

export const emitAgentPlugin: FormatEmitter = (
  connector: ResolvedConnector,
  ctx: EmitContext,
): PackageResult => {
  const { emit, files } = createEmitter(ctx.dryRun);
  const pluginDir = join(ctx.outDir, connector.id);
  const notes: string[] = [];

  // ── plugin.json (REQUIRED, at the plugin root) ────────────────────────────
  emit(join(pluginDir, "plugin.json"), json(buildManifest(connector)));

  // ── mcp.json (portable stdio | streamable-http | sse) ─────────────────────
  const mcp = buildServerEntry(connector, notes);
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

  // ── com.github.copilot/ — client extension namespace (non-portable surfaces) ─
  const extDir = join(pluginDir, COPILOT_EXTENSION_NAMESPACE);
  const hooksJson = buildClaudeHooksJson(connector, AGENT_PLUGIN_BIN, EXTENSION_PLATFORM);
  if (hooksJson) emit(join(extDir, "hooks", "hooks.json"), json(hooksJson));
  for (const cmd of connector.commands) {
    emit(join(extDir, "commands", `${cmd.name}.md`), renderCommandMd(cmd));
  }
  for (const agent of connector.subagents) {
    emit(join(extDir, "agents", `${agent.name}.md`), renderSubagentMd(agent));
  }
  const hasExtension =
    hooksJson !== null || connector.commands.length > 0 || connector.subagents.length > 0;
  if (hasExtension) {
    notes.push(
      `agent-plugin: hooks/commands/subagents are not portable Agent Plugins 1.0 components — emitted under the ${COPILOT_EXTENSION_NAMESPACE}/ client extension namespace (GitHub Copilot + VS Code read it; other clients ignore it)`,
    );
  }
  if (hooksJson) {
    notes.push(
      `agent-plugin: hooks invoke the bare \`${AGENT_PLUGIN_BIN}\` command — consumers need the framework CLI on PATH`,
    );
  }

  // ── README.md ─────────────────────────────────────────────────────────────
  const wrapped =
    hooksJson !== null || (mcp !== null && mcp.entry.type === "stdio" && mcp.entry.command === AGENT_PLUGIN_BIN);
  emit(
    join(pluginDir, "README.md"),
    buildReadme(connector, {
      mcp: mcp !== null,
      skills: connector.skills.length > 0,
      extension: hasExtension,
      wrapped,
    }),
  );

  const result: PackageResult = { files, pluginDir };
  if (notes.length > 0) result.notes = notes;
  return result;
};
