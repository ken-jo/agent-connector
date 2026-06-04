/**
 * core/package-formats/gemini — the `gemini-extension` emitter + its `qwen-extension`
 * variant.
 *
 * A Gemini CLI extension is a directory with `gemini-extension.json` at its root
 * carrying `{ name, version, description, mcpServers, contextFileName }` plus the
 * component dirs: commands/<n>.toml (slash commands), skills/<n>/SKILL.md,
 * agents/<n>.md, hooks/hooks.json, and a GEMINI.md context file. UNLIKE the
 * Claude family, MCP is declared INLINE in the manifest's `mcpServers` map (not a
 * separate .mcp.json) — we still serve-wrap it so telemetry carries through.
 *
 * Qwen Code is a Gemini-CLI fork with its own `qwen-extension.json` (same shape)
 * but two differences captured here: commands are MARKDOWN (commands/<n>.md) not
 * TOML, and the context file is QWEN.md.
 *
 * Commands render to Gemini's native TOML `{ description, prompt }` (the same
 * shape the live gemini-cli adapter writes); skills/subagents reuse the shared
 * claude-code renderers (Gemini/Qwen read the same SKILL.md + md+frontmatter).
 * Hooks use the universal home-bin command; the MCP entry is serve-wrapped with
 * --host gemini-cli | qwen-code.
 */

import { join } from "node:path";

import type { CommandDef, PlatformId, ResolvedConnector } from "../types.js";
import { writeTomlString } from "../toml.js";
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

/** Per-variant knobs for a Gemini-family extension. */
interface GeminiFamilySpec {
  platformId: PlatformId;
  /** Manifest filename at the extension root. */
  manifestFile: string;
  /** Context file name (GEMINI.md | QWEN.md). */
  contextFile: string;
  /** Command file format: TOML (gemini) or Markdown (qwen). */
  commandFormat: "toml" | "md";
}

const SPECS: Record<string, GeminiFamilySpec> = {
  "gemini-extension": {
    platformId: "gemini-cli",
    manifestFile: "gemini-extension.json",
    contextFile: "GEMINI.md",
    commandFormat: "toml",
  },
  "qwen-extension": {
    platformId: "qwen-code",
    manifestFile: "qwen-extension.json",
    contextFile: "QWEN.md",
    commandFormat: "md",
  },
};

/** Render a command to Gemini's native TOML `{ description, prompt }`. */
function renderCommandToml(cmd: CommandDef): string {
  const obj: Record<string, unknown> = {};
  if (cmd.description !== undefined) obj.description = cmd.description;
  obj.prompt = cmd.prompt;
  return writeTomlString(obj);
}

/** Build gemini-extension.json | qwen-extension.json (with optional inline mcpServers). */
function buildManifest(
  connector: ResolvedConnector,
  spec: GeminiFamilySpec,
  homeBin: string,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: connector.id,
    // gemini requires a version; default a placeholder to a real semver.
    version:
      connector.version && connector.version !== "0.0.0"
        ? connector.version
        : "0.0.1",
    description: `${connector.displayName} — connector emitted by agent-connector`,
  };

  const mcp = buildMcpEntry(connector, homeBin, spec.platformId);
  if (mcp) {
    manifest.mcpServers = { [mcp.serverName]: mcp.entry };
  }
  manifest.contextFileName = spec.contextFile;
  return manifest;
}

function emitGeminiFamily(
  connector: ResolvedConnector,
  ctx: EmitContext,
  format: keyof typeof SPECS,
): PackageResult {
  const spec = SPECS[format];
  if (!spec) throw new Error(`unknown gemini-family format: ${format}`);

  const { emit, files } = createEmitter(ctx.dryRun);
  const pluginDir = join(ctx.outDir, connector.id);

  // ── gemini-extension.json | qwen-extension.json (MCP is inline here) ──────
  emit(
    join(pluginDir, spec.manifestFile),
    json(buildManifest(connector, spec, ctx.homeBinPath)),
  );

  // ── context file (GEMINI.md | QWEN.md) ────────────────────────────────────
  emit(
    join(pluginDir, spec.contextFile),
    `# ${connector.displayName}\n\nConnector context emitted by agent-connector.\n`,
  );

  // ── commands/<name>.{toml|md} ─────────────────────────────────────────────
  for (const cmd of connector.commands) {
    if (spec.commandFormat === "toml") {
      emit(join(pluginDir, "commands", `${cmd.name}.toml`), renderCommandToml(cmd));
    } else {
      emit(join(pluginDir, "commands", `${cmd.name}.md`), renderCommandMd(cmd));
    }
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
  const hooksJson = buildClaudeHooksJson(connector, ctx.homeBinPath, spec.platformId);
  if (hooksJson) emit(join(pluginDir, "hooks", "hooks.json"), json(hooksJson));

  // A Gemini/Qwen extension has no separate marketplace catalog (it installs by
  // URL/path); marketplacePath is left undefined.
  return { files, pluginDir };
}

export const emitGeminiExtension: FormatEmitter = (connector, ctx) =>
  emitGeminiFamily(connector, ctx, "gemini-extension");

export const emitQwenExtension: FormatEmitter = (connector, ctx) =>
  emitGeminiFamily(connector, ctx, "qwen-extension");
