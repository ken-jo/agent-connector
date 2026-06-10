/**
 * core/package-formats/cursor — the `cursor-plugin` emitter.
 *
 * Cursor's bundle is near-isomorphic to claude-plugin: manifest at
 * `.cursor-plugin/plugin.json` (only `name` required) with the surface fields
 * declared as POINTERS ("skills":"./skills/", "hooks":"./hooks/hooks.json",
 * "mcpServers":"./mcp.json") so a validator/IDE finds each dir; components live
 * at the plugin root: commands/<n>.md, agents/<n>.md, skills/<n>/SKILL.md,
 * mcp.json, hooks/hooks.json. A multi-plugin repo adds .cursor-plugin/
 * marketplace.json { name, owner:{name,email?}, plugins:[{name,source,description}] }.
 *
 * Markdown reuses the shared claude-code renderers (Cursor reads the same md +
 * frontmatter command/agent/skill documents). Hooks + MCP use the shared
 * builders with --host cursor so the home-bin hook + serve-wrapper telemetry
 * carry through.
 *
 * (Cursor also supports `rules/*.mdc`, but a connector declares no rules surface,
 * so no rules/ dir is emitted and the manifest omits the `rules` pointer.)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { PlatformId, ResolvedConnector } from "../types.js";
import {
  renderCommandMd,
  renderSkillMd,
  renderSubagentMd,
} from "../../adapters/claude-code/render.js";
import {
  buildClaudeHooksJson,
  buildMcpEntry,
  createEmitter,
  json,
  resolveWithin,
  type EmitContext,
  type FormatEmitter,
  type PackageResult,
} from "./shared.js";

const PLATFORM: PlatformId = "cursor";

/** Build .cursor-plugin/plugin.json with pointer surface fields for what exists. */
function buildManifest(
  connector: ResolvedConnector,
  has: { commands: boolean; agents: boolean; skills: boolean; hooks: boolean; mcp: boolean },
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: connector.id,
    description: `${connector.displayName} — connector emitted by agentconnect`,
  };
  if (connector.version && connector.version !== "0.0.0") {
    manifest.version = connector.version;
  }
  // Pointer fields: only declare a surface that actually ships in the bundle.
  if (has.commands) manifest.commands = "./commands/";
  if (has.agents) manifest.agents = "./agents/";
  if (has.skills) manifest.skills = "./skills/";
  if (has.hooks) manifest.hooks = "./hooks/hooks.json";
  if (has.mcp) manifest.mcpServers = "./mcp.json";
  return manifest;
}

/** Build .cursor-plugin/marketplace.json (owner object carries name; email optional). */
function buildMarketplace(connector: ResolvedConnector): Record<string, unknown> {
  return {
    name: "agentconnect",
    owner: { name: "agentconnect" },
    plugins: [
      {
        name: connector.id,
        source: `./${connector.id}`,
        description: `${connector.displayName} — connector emitted by agentconnect`,
      },
    ],
  };
}

export const emitCursorPlugin: FormatEmitter = (
  connector: ResolvedConnector,
  ctx: EmitContext,
): PackageResult => {
  const { emit, files } = createEmitter(ctx.dryRun);
  const pluginDir = join(ctx.outDir, connector.id);

  const hooksJson = buildClaudeHooksJson(connector, ctx.homeBinPath, PLATFORM);
  const mcp = buildMcpEntry(connector, ctx.homeBinPath, PLATFORM);

  const has = {
    commands: connector.commands.length > 0,
    agents: connector.subagents.length > 0,
    skills: connector.skills.length > 0,
    hooks: hooksJson !== null,
    mcp: mcp !== null,
  };

  // ── .cursor-plugin/plugin.json (ONLY file under .cursor-plugin/) ───────────
  emit(
    join(pluginDir, ".cursor-plugin", "plugin.json"),
    json(buildManifest(connector, has)),
  );

  // ── commands/<name>.md ────────────────────────────────────────────────────
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
      if (target === null) continue;
      emit(target, contents);
    }
  }

  // ── hooks/hooks.json ──────────────────────────────────────────────────────
  if (hooksJson) emit(join(pluginDir, "hooks", "hooks.json"), json(hooksJson));

  // ── mcp.json (Cursor's MCP filename, no leading dot) ──────────────────────
  if (mcp) {
    emit(
      join(pluginDir, "mcp.json"),
      json({ mcpServers: { [mcp.serverName]: mcp.entry } }),
    );
  }

  // ── .cursor-plugin/marketplace.json ───────────────────────────────────────
  const marketplacePath = join(ctx.outDir, ".cursor-plugin", "marketplace.json");
  emit(marketplacePath, json(buildMarketplace(connector)));

  return { files, pluginDir, marketplacePath };
};

/** True when a local install of this plugin already exists (used by the CLI hint). */
export function cursorLocalInstallExists(name: string, home: string): boolean {
  return existsSync(join(home, ".cursor", "plugins", "local", name));
}
