/**
 * core/package-formats/agy — the `agy plugin` bundle emitter (Antigravity CLI +
 * Antigravity IDE, which share the bundle).
 *
 * Live-confirmed layout (`agy plugin validate`):
 *   • REQUIRED root `plugin.json` marker { name, version, description } — its
 *     absence is the one hard error the validator reports.
 *   • MCP MUST be a SEPARATE `mcp_config.json` { mcpServers:{...} } — an inline
 *     `mcpServers` in plugin.json is NOT picked up. (This is the one structural
 *     difference from the Claude family.)
 *   • hooks/hooks.json keyed { hooks:{ <Event>:[{matcher,hooks:[{type,command}]}] } }.
 *   • skills/<n>/SKILL.md, agents/<n>.md, commands/<n>.md (commands are converted
 *     to skills on validate — still emitted as Markdown command files).
 *
 * Markdown reuses the shared claude-code renderers; hooks use the universal
 * home-bin command; the MCP entry is serve-wrapped with --host antigravity-cli so
 * telemetry carries through. No marketplace catalog ships in the bundle (agy
 * installs by target / plugin@marketplace).
 */

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

const PLATFORM: PlatformId = "antigravity-cli";

/** Build the required root plugin.json marker. */
function buildManifest(connector: ResolvedConnector): Record<string, unknown> {
  return {
    name: connector.id,
    // agy expects a version on the marker; default a placeholder to a real semver.
    version:
      connector.version && connector.version !== "0.0.0"
        ? connector.version
        : "0.0.1",
    description: `${connector.displayName} — connector emitted by agent-connector`,
  };
}

export const emitAgyPlugin: FormatEmitter = (
  connector: ResolvedConnector,
  ctx: EmitContext,
): PackageResult => {
  const { emit, files } = createEmitter(ctx.dryRun);
  const pluginDir = join(ctx.outDir, connector.id);

  // ── plugin.json (REQUIRED root marker) ────────────────────────────────────
  emit(join(pluginDir, "plugin.json"), json(buildManifest(connector)));

  // ── commands/<name>.md (validator converts these to skills) ───────────────
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
  const hooksJson = buildClaudeHooksJson(connector, ctx.homeBinPath, PLATFORM);
  if (hooksJson) emit(join(pluginDir, "hooks", "hooks.json"), json(hooksJson));

  // ── mcp_config.json (SEPARATE file — inline mcpServers is NOT read by agy) ─
  const mcp = buildMcpEntry(connector, ctx.homeBinPath, PLATFORM);
  if (mcp) {
    emit(
      join(pluginDir, "mcp_config.json"),
      json({ mcpServers: { [mcp.serverName]: mcp.entry } }),
    );
  }

  return { files, pluginDir };
};
