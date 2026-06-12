/**
 * core/package — emit a marketplace/extension-installable connector bundle.
 *
 * Turns a {@link ResolvedConnector} into a self-contained plugin/extension bundle
 * for ANY of the emit-feasible plugin/marketplace formats the agent ecosystem
 * supports. The format-specific emitters live under `package-formats/<family>.ts`,
 * each conforming to the shared {@link FormatEmitter} signature; this module is
 * the single, consistent dispatch over them.
 *
 * Supported formats (PackageFormat):
 *   • claude-plugin    — Claude Code / codex / vscode-copilot / openclaw / omp
 *   • codex-plugin     — Codex `.codex-plugin/` manifest variant of claude-plugin
 *   • factory-plugin   — droid `.factory-plugin/` (droids/, mcp.json) variant
 *   • gemini-extension — Gemini CLI extension (gemini-extension.json + TOML commands)
 *   • qwen-extension   — Qwen Code extension (qwen-extension.json + Markdown commands)
 *   • agy-plugin       — Antigravity CLI/IDE (root plugin.json + mcp_config.json)
 *   • cursor-plugin    — Cursor (.cursor-plugin/ + pointer fields + marketplace.json)
 *   • kimi-plugin      — Kimi (skills + MCP only; hooks/commands/subagents dropped)
 *   • npm-plugin       — opencode / kilo-cli / pi (publishable npm package + bridge)
 *
 * The command / skill / subagent markdown is rendered through the SAME shared
 * claude-code renderers the live adapters write with (where the target uses
 * markdown), hooks via buildHomeBinHookCommand, and MCP via buildServeWrapperCommand
 * with `--host <platform>` — so telemetry-wrap + the universal home-bin pointer
 * carry through every bundle exactly as an `agent-connector install` would.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ResolvedConnector } from "./types.js";
import { homeBinPath as defaultHomeBinPath } from "./paths.js";
import type { EmitContext, FormatEmitter, PackageResult } from "./package-formats/shared.js";
import {
  emitClaudePlugin,
  emitCodexPlugin,
  emitFactoryPlugin,
} from "./package-formats/claude-family.js";
import { emitCursorPlugin } from "./package-formats/cursor.js";
import {
  emitGeminiExtension,
  emitQwenExtension,
} from "./package-formats/gemini.js";
import { emitAgyPlugin } from "./package-formats/agy.js";
import { emitKimiPlugin } from "./package-formats/kimi.js";
import { emitNpmPlugin } from "./package-formats/npm.js";
import { emitMcpServerJson } from "./package-formats/mcp-server.js";
import { emitMcpbBundle } from "./package-formats/mcpb.js";

export type { PackageResult } from "./package-formats/shared.js";

/** Every packaging format `package` can emit. */
export type PackageFormat =
  | "claude-plugin"
  | "codex-plugin"
  | "factory-plugin"
  | "gemini-extension"
  | "qwen-extension"
  | "agy-plugin"
  | "cursor-plugin"
  | "kimi-plugin"
  | "npm-plugin"
  // Official MCP standard artifacts (describe the dev's REAL upstream server,
  // not our serve wrapper; require `publish` metadata, so they are opt-in and
  // excluded from `--format all`).
  | "mcp-server-json"
  | "mcpb";

/** The single consistent dispatch map: format → emitter. */
const EMITTERS: Record<PackageFormat, FormatEmitter> = {
  "claude-plugin": emitClaudePlugin,
  "codex-plugin": emitCodexPlugin,
  "factory-plugin": emitFactoryPlugin,
  "gemini-extension": emitGeminiExtension,
  "qwen-extension": emitQwenExtension,
  "agy-plugin": emitAgyPlugin,
  "cursor-plugin": emitCursorPlugin,
  "kimi-plugin": emitKimiPlugin,
  "npm-plugin": emitNpmPlugin,
  "mcp-server-json": emitMcpServerJson,
  mcpb: emitMcpbBundle,
};

/** All formats, in a stable, documented order. */
export const ALL_FORMATS: readonly PackageFormat[] = [
  "claude-plugin",
  "codex-plugin",
  "factory-plugin",
  "gemini-extension",
  "qwen-extension",
  "agy-plugin",
  "cursor-plugin",
  "kimi-plugin",
  "npm-plugin",
  "mcp-server-json",
  "mcpb",
] as const;

/**
 * The formats `--format all` emits — the host plugin/marketplace bundles that
 * work for ANY connector. The official MCP standard artifacts (mcp-server-json,
 * and the MCPB bundle) are deliberately EXCLUDED: they require `publish`
 * metadata (a namespace the dev owns, their published package) and would error
 * for a connector that has not opted into publishing, so they are emitted only
 * when requested explicitly by name.
 */
export const FEASIBLE_FORMATS: readonly PackageFormat[] = [
  "claude-plugin",
  "codex-plugin",
  "factory-plugin",
  "gemini-extension",
  "qwen-extension",
  "agy-plugin",
  "cursor-plugin",
  "kimi-plugin",
  "npm-plugin",
] as const;

/** Type guard: is `s` a supported {@link PackageFormat}? */
export function isPackageFormat(s: string): s is PackageFormat {
  return Object.prototype.hasOwnProperty.call(EMITTERS, s);
}

export interface PackageOptions {
  /** Directory the bundle is written under (the format root). */
  outDir: string;
  /** Output format. Defaults to "claude-plugin". */
  format?: PackageFormat;
  /**
   * Absolute path to agent-connector's stable home-bin that hooks + the MCP
   * serve-wrapper point at. Defaults to {@link defaultHomeBinPath}.
   */
  homeBinPath?: string;
  /** Compute the file list without writing anything. */
  dryRun?: boolean;
}

/**
 * Emit a bundle for `connector` in a single `format` (default claude-plugin).
 *
 * Writes (or, for dryRun, only enumerates) the bundle under `opts.outDir`.
 * Returns the absolute file list, the plugin root dir, an optional marketplace
 * path, and optional drop notes (for lossy formats like kimi-plugin).
 */
/**
 * Host-bundle formats whose hooks/MCP entries embed the ABSOLUTE home-bin path
 * of the machine that ran `package`. They install fine locally, but on another
 * machine/user the baked path points at nothing — so every emit carries a note.
 * (npm-plugin resolves the CLI by name on PATH; mcp-server-json/mcpb describe
 * the dev's real upstream server — none of those embed a local path.)
 */
const HOME_BIN_EMBED_FORMATS: ReadonlySet<PackageFormat> = new Set([
  "claude-plugin",
  "codex-plugin",
  "factory-plugin",
  "gemini-extension",
  "qwen-extension",
  "agy-plugin",
  "cursor-plugin",
  "kimi-plugin",
]);

export function packageConnector(
  connector: ResolvedConnector,
  opts: PackageOptions,
): PackageResult {
  const format = opts.format ?? "claude-plugin";
  const emitter = EMITTERS[format];
  if (!emitter) {
    throw new Error(`unsupported package format: ${format}`);
  }

  const ctx: EmitContext = {
    outDir: resolve(opts.outDir),
    homeBinPath: opts.homeBinPath ?? defaultHomeBinPath(),
    dryRun: opts.dryRun ?? false,
  };
  const result = emitter(connector, ctx);
  if (HOME_BIN_EMBED_FORMATS.has(format)) {
    const note =
      `bundle embeds this machine's agent-connector launcher path (${ctx.homeBinPath}) — ` +
      "valid for LOCAL install; for a shared marketplace, consumers need agent-connector " +
      "at the same home path (run `agent-connector upgrade` there) or re-run `package` per machine";
    result.notes = [...(result.notes ?? []), note];
  }
  return result;
}

/** One entry in a multi-format ({@link packageConnectorAll}) emit. */
export interface MultiPackageResult {
  format: PackageFormat;
  result: PackageResult;
}

/**
 * Emit EVERY feasible format, each into its own `<outDir>/<format>/` subdir, so a
 * single `package --format all` produces the whole matrix without collisions.
 */
export function packageConnectorAll(
  connector: ResolvedConnector,
  opts: { outDir: string; homeBinPath?: string; dryRun?: boolean },
): MultiPackageResult[] {
  const base = resolve(opts.outDir);
  const homeBin = opts.homeBinPath ?? defaultHomeBinPath();
  const dryRun = opts.dryRun ?? false;
  return FEASIBLE_FORMATS.map((format) => ({
    format,
    result: packageConnector(connector, {
      outDir: resolve(base, format),
      format,
      homeBinPath: homeBin,
      dryRun,
    }),
  }));
}

/**
 * Per-format MANUAL install commands (the accurate two-step add+install where
 * applicable). Lives in core (not the CLI) so both `package`'s printed
 * instructions and the marketplace method's skip-warn records for non-drivable
 * hosts quote the SAME commands — one copy, no drift.
 */
export function installInstructions(
  format: PackageFormat,
  id: string,
  outDir: string,
): string[] {
  switch (format) {
    case "claude-plugin":
      return [
        `/plugin marketplace add ${outDir}`,
        `/plugin install ${id}@agent-connector`,
        `(CLI: claude plugin marketplace add ${outDir} && claude plugin install ${id}@agent-connector)`,
      ];
    case "codex-plugin":
      return [
        `codex plugin marketplace add ${outDir}`,
        `codex plugin add ${id}@agent-connector`,
      ];
    case "factory-plugin":
      return [
        `droid plugin marketplace add ${outDir}`,
        `droid plugin install ${id}@agent-connector`,
      ];
    case "gemini-extension":
      return [`gemini extensions install ${join(outDir, id)}`];
    case "qwen-extension":
      return [`qwen extensions install ${join(outDir, id)}`];
    case "agy-plugin":
      return [
        `agy plugin install ${join(outDir, id)}`,
        `(validate: agy plugin validate ${join(outDir, id)})`,
      ];
    case "cursor-plugin":
      return [
        `link ${join(outDir, id)} into ~/.cursor/plugins/local/${id}/ then Developer: Reload Window`,
        `(or publish ${outDir} as a Cursor marketplace repo)`,
      ];
    case "kimi-plugin":
      return [`kimi plugin install ${join(outDir, id)}`];
    case "npm-plugin":
      return [
        `npm publish ${join(outDir, id)}  (then: opencode plugin install <pkg> | kilo plugin <pkg> | pi install npm:<pkg>)`,
      ];
    case "mcp-server-json":
      return [
        `mcp-publisher login <github|dns|http>   (prove ownership of your namespace once)`,
        `cd ${outDir} && mcp-publisher publish   (uploads server.json to the official MCP Registry)`,
      ];
    case "mcpb":
      return [
        `vendor your built server under ${join(outDir, "server")}/ (see the emitted README)`,
        `npx @anthropic-ai/mcpb pack ${outDir}   (then optionally: mcpb sign)`,
      ];
    default:
      return [];
  }
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
