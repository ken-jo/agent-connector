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
import { resolve } from "node:path";

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
  | "npm-plugin";

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
};

/** All formats, in a stable, documented order (also the order `--format all` emits). */
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
] as const;

/**
 * The formats `--format all` emits. npm-plugin is included because it emits a
 * CLEAN publishable package (not a half-baked stub), per the build plan.
 */
export const FEASIBLE_FORMATS: readonly PackageFormat[] = ALL_FORMATS;

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
  return emitter(connector, ctx);
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

/** Read + parse a JSON file (used by callers/tests). Returns null on absence/parse error. */
export function readPackagedJson<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
