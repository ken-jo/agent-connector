/**
 * core/package-formats/kimi — the `kimi-plugin` emitter (skills + MCP ONLY).
 *
 * A Kimi plugin is a directory whose manifest is `kimi.plugin.json` at the root
 * carrying { name, version, description, skills, mcpServers }. Kimi plugins carry
 * exactly TWO functional surfaces:
 *   • skills/<n>/SKILL.md   (declared via the `skills` pointer)
 *   • mcpServers            (a standard MCP map, stdio + http)
 *
 * Kimi EXPLICITLY ignores `tools`, `commands`, `hooks`, `apps`, `inject`,
 * `configFile` (they surface as diagnostics). So when the connector declares
 * commands, subagents, or hooks, those surfaces are DROPPED — and a note is
 * returned so the lossy bundle is never silent. The MCP entry is still
 * serve-wrapped with --host kimi so telemetry carries through; hooks are NOT
 * emitted because Kimi has no hooks surface.
 */

import { join } from "node:path";

import type { PlatformId, ResolvedConnector } from "../types.js";
import { renderSkillMd } from "../../adapters/claude-code/render.js";
import {
  buildMcpEntry,
  createEmitter,
  json,
  resolveWithin,
  type EmitContext,
  type FormatEmitter,
  type PackageResult,
} from "./shared.js";

const PLATFORM: PlatformId = "kimi";

/** Build kimi.plugin.json (skills pointer + inline mcpServers when present). */
function buildManifest(
  connector: ResolvedConnector,
  hasSkills: boolean,
  homeBin: string,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: connector.id,
    version:
      connector.version && connector.version !== "0.0.0"
        ? connector.version
        : "0.0.1",
    description: `${connector.displayName} — connector emitted by agent-connector`,
  };
  if (hasSkills) manifest.skills = "./skills/";
  const mcp = buildMcpEntry(connector, homeBin, PLATFORM);
  if (mcp) manifest.mcpServers = { [mcp.serverName]: mcp.entry };
  return manifest;
}

export const emitKimiPlugin: FormatEmitter = (
  connector: ResolvedConnector,
  ctx: EmitContext,
): PackageResult => {
  const { emit, files } = createEmitter(ctx.dryRun);
  const pluginDir = join(ctx.outDir, connector.id);
  const notes: string[] = [];

  const hasSkills = connector.skills.length > 0;

  // ── kimi.plugin.json (root manifest; MCP inline; hooks/commands ignored) ──
  emit(join(pluginDir, "kimi.plugin.json"), json(buildManifest(connector, hasSkills, ctx.homeBinPath)));

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

  // ── Surfaces Kimi cannot carry → DROPPED, with an explicit note ───────────
  if (connector.commands.length > 0) {
    notes.push(
      `kimi-plugin: dropped ${connector.commands.length} command(s) — Kimi plugins ignore commands`,
    );
  }
  if (connector.subagents.length > 0) {
    notes.push(
      `kimi-plugin: dropped ${connector.subagents.length} subagent(s) — Kimi plugins ignore subagents`,
    );
  }
  if (connector.hookEvents.length > 0) {
    notes.push(
      `kimi-plugin: dropped ${connector.hookEvents.length} hook event(s) — Kimi plugins ignore hooks`,
    );
  }

  return { files, pluginDir, ...(notes.length > 0 ? { notes } : {}) };
};
