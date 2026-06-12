/**
 * core/package-formats/claude-family — the claude-plugin emitter + its two
 * manifest-rename siblings (codex-plugin, factory-plugin).
 *
 * All three share ONE component tree (commands/ agents-or-droids/ skills/<n>/
 * SKILL.md + hooks/hooks.json + an MCP json) and differ only in:
 *   • the manifest DIR + filename            (.claude-plugin/ | .codex-plugin/ | .factory-plugin/)
 *   • the subagent dir name                  (agents/ vs droids/ for factory)
 *   • the MCP filename                       (.mcp.json vs mcp.json for factory)
 *   • the manifest extra fields              (claude adds $schema; factory pins version+author)
 *   • the marketplace catalog shape          (claude/codex object-owner; factory git-repo catalog)
 *
 * The command / skill / subagent markdown is rendered through the SAME shared
 * claude-code renderers the live adapter writes with, so an installed plugin and
 * an `agent-connector install` produce byte-identical content files. Hooks use
 * the universal home-bin command (telemetry-routed) and the MCP entry is
 * serve-wrapped with `--host <platform>` so telemetry carries through.
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

/** Per-variant layout + manifest knobs for a Claude-family bundle. */
interface ClaudeFamilySpec {
  /** Host platform stamped into the serve-wrapper + hook command (--host). */
  platformId: PlatformId;
  /** Manifest directory under the plugin root (e.g. ".claude-plugin"). */
  manifestDir: string;
  /** Subagent directory name (claude/codex: "agents"; factory: "droids"). */
  subagentDir: string;
  /** MCP filename at the plugin root (claude/codex: ".mcp.json"; factory: "mcp.json"). */
  mcpFile: string;
  /** Add `$schema` to plugin.json (claude only). */
  schemaUrl?: string;
  /** Always carry a version in plugin.json, defaulting placeholder to "0.0.1" (factory requires it). */
  requireVersion?: boolean;
  /** Always carry an `author` object in plugin.json (factory pins it). */
  alwaysAuthor?: boolean;
  /**
   * Where to write the marketplace catalog, relative to outDir, and which shape.
   * "claude": <outDir>/.claude-plugin/marketplace.json    (object owner).
   * "codex":  <outDir>/.agents/plugins/marketplace.json   (same object-owner
   *           catalog; codex's documented location — `codex plugin marketplace
   *           add` REJECTS a `.codex-plugin/` catalog with "marketplace root
   *           does not contain a supported manifest"; live-verified 0.139.0).
   * "factory":<outDir>/marketplace.json                   (git-repo catalog at the repo root).
   */
  marketplace: { dir: string | null; file: string; shape: "claude" | "factory" };
}

const SPECS: Record<string, ClaudeFamilySpec> = {
  "claude-plugin": {
    platformId: "claude-code",
    manifestDir: ".claude-plugin",
    subagentDir: "agents",
    mcpFile: ".mcp.json",
    schemaUrl: "https://json.schemastore.org/claude-code-plugin-manifest.json",
    marketplace: { dir: ".claude-plugin", file: "marketplace.json", shape: "claude" },
  },
  "codex-plugin": {
    platformId: "codex",
    manifestDir: ".codex-plugin",
    subagentDir: "agents",
    mcpFile: ".mcp.json",
    marketplace: {
      dir: join(".agents", "plugins"),
      file: "marketplace.json",
      shape: "claude",
    },
  },
  "factory-plugin": {
    platformId: "droid",
    manifestDir: ".factory-plugin",
    subagentDir: "droids",
    mcpFile: "mcp.json",
    requireVersion: true,
    alwaysAuthor: true,
    // droid marketplaces are Git-repo catalogs; the catalog sits at the repo root.
    marketplace: { dir: null, file: "marketplace.json", shape: "factory" },
  },
};

/** Build the plugin manifest for a Claude-family variant. */
function buildManifest(
  connector: ResolvedConnector,
  spec: ClaudeFamilySpec,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {};
  if (spec.schemaUrl) manifest.$schema = spec.schemaUrl;
  manifest.name = connector.id;
  manifest.description = `${connector.displayName} — connector emitted by agent-connector`;

  const hasRealVersion = connector.version && connector.version !== "0.0.0";
  if (hasRealVersion) {
    manifest.version = connector.version;
  } else if (spec.requireVersion) {
    // factory requires a semver version; supply a sane default when unpinned.
    manifest.version = "0.0.1";
  }
  // Attribute the bundle to the connector developer when they declared an
  // author (publish.author); the framework name is only the fallback.
  if (spec.alwaysAuthor) {
    manifest.author = { name: connector.publish?.author?.name ?? "agent-connector" };
  }
  return manifest;
}

/** Build the marketplace catalog for a Claude-family variant. */
function buildMarketplace(connector: ResolvedConnector): Record<string, unknown> {
  // Both the claude/codex object-owner catalog and the droid git-repo catalog
  // use the same minimal { name, owner, plugins:[{name,source,description}] }
  // shape — droid reads source as a path relative to the marketplace repo root.
  // The catalog NAME stays "agent-connector" (the printed install instructions
  // `<id>@agent-connector` key on it); the OWNER is the developer when known.
  return {
    name: "agent-connector",
    owner: { name: connector.publish?.author?.name ?? "agent-connector" },
    plugins: [
      {
        name: connector.id,
        source: `./${connector.id}`,
        description: `${connector.displayName} — connector emitted by agent-connector`,
      },
    ],
  };
}

/** Emit a Claude-family bundle (claude-plugin | codex-plugin | factory-plugin). */
function emitClaudeFamily(
  connector: ResolvedConnector,
  ctx: EmitContext,
  format: keyof typeof SPECS,
): PackageResult {
  const spec = SPECS[format];
  if (!spec) throw new Error(`unknown claude-family format: ${format}`);

  const { emit, files } = createEmitter(ctx.dryRun);
  const pluginDir = join(ctx.outDir, connector.id);

  // ── plugin.json (the ONLY file inside the manifest dir) ───────────────────
  emit(
    join(pluginDir, spec.manifestDir, "plugin.json"),
    json(buildManifest(connector, spec)),
  );

  // ── commands/<name>.md ────────────────────────────────────────────────────
  for (const cmd of connector.commands) {
    emit(join(pluginDir, "commands", `${cmd.name}.md`), renderCommandMd(cmd));
  }

  // ── agents|droids/<name>.md ───────────────────────────────────────────────
  for (const agent of connector.subagents) {
    emit(
      join(pluginDir, spec.subagentDir, `${agent.name}.md`),
      renderSubagentMd(agent),
    );
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

  // ── hooks/hooks.json (mapped events only) ─────────────────────────────────
  const hooksJson = buildClaudeHooksJson(connector, ctx.homeBinPath, spec.platformId);
  if (hooksJson) emit(join(pluginDir, "hooks", "hooks.json"), json(hooksJson));

  // ── MCP json (serve-wrapped stdio server) ─────────────────────────────────
  const mcp = buildMcpEntry(connector, ctx.homeBinPath, spec.platformId);
  if (mcp) {
    emit(
      join(pluginDir, spec.mcpFile),
      json({ mcpServers: { [mcp.serverName]: mcp.entry } }),
    );
  }

  // ── marketplace catalog ───────────────────────────────────────────────────
  const marketplacePath = spec.marketplace.dir
    ? join(ctx.outDir, spec.marketplace.dir, spec.marketplace.file)
    : join(ctx.outDir, spec.marketplace.file);
  emit(marketplacePath, json(buildMarketplace(connector)));

  return { files, pluginDir, marketplacePath };
}

export const emitClaudePlugin: FormatEmitter = (connector, ctx) =>
  emitClaudeFamily(connector, ctx, "claude-plugin");

export const emitCodexPlugin: FormatEmitter = (connector, ctx) =>
  emitClaudeFamily(connector, ctx, "codex-plugin");

export const emitFactoryPlugin: FormatEmitter = (connector, ctx) =>
  emitClaudeFamily(connector, ctx, "factory-plugin");
