/**
 * core/load-connector — discover, load, and register connector definitions.
 *
 * Responsibilities:
 *   1. Locate the developer's `agent-connector.config.{mjs,js,json}` by walking
 *      upward from a start directory (the project root convention).
 *   2. Load a config from a path into a LIVE ResolvedConnector (with handlers).
 *   3. Register a connector by persisting SERIALIZABLE metadata (no functions)
 *      to `connectorDir(id)/connector.json`, pointing at the source module so
 *      live handlers can be re-imported at runtime from a stable record.
 *
 * Why split live vs. serialized? Hook handlers are functions and cannot survive
 * JSON. The registry stores only what JSON can hold plus an absolute
 * `modulePath`; the runtime re-imports that module to recover the live handlers.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  CommandDef,
  HookEventName,
  PlatformId,
  PlatformOverride,
  ResolvedConnector,
  ServerDef,
  SkillDef,
  SubagentDef,
} from "./types.js";
import { defineConnector } from "./define-connector.js";
import { connectorDir, connectorsDir, ensureDir } from "./paths.js";

/** Candidate config filenames, in resolution-precedence order. */
const CONFIG_FILENAMES = [
  "agent-connector.config.mjs",
  "agent-connector.config.js",
  "agent-connector.config.json",
] as const;

/**
 * The serializable subset of a connector persisted to `connector.json`.
 * Hook handler functions are intentionally absent — only the absolute
 * `modulePath` is stored so the live ResolvedConnector can be re-imported.
 */
export interface RegisteredMeta {
  id: string;
  displayName: string;
  version: string;
  /** Absolute path to the source module that produced this connector. */
  modulePath: string;
  telemetry: ResolvedConnector["telemetry"];
  /** Canonical event names the connector handles (handlers themselves stripped). */
  hookEvents: HookEventName[];
  hasServer: boolean;
  server: ServerDef | null;
  /**
   * Content surfaces (commands/skills/subagents). These are JSON-serializable
   * (no functions) so they persist cleanly and let uninstall locate the files
   * to remove even when the source module is gone.
   */
  commands: CommandDef[];
  skills: SkillDef[];
  subagents: SubagentDef[];
  targets: ResolvedConnector["targets"];
  /** Per-platform overrides with any hook handler functions stripped. */
  platforms: Partial<Record<PlatformId, PlatformOverride>>;
}

/**
 * Search `startDir` and each ancestor for a connector config file. Returns the
 * absolute path to the first match (filesystem-root-stopping), or null.
 */
export function findConnectorConfig(startDir: string): string | null {
  let dir = resolve(startDir);
  // Walk upward until `dirname(dir) === dir` (filesystem root).
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** True if a value already looks like a ResolvedConnector (vs. a raw config). */
function isResolvedConnector(value: unknown): value is ResolvedConnector {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { hookEvents?: unknown }).hookEvents)
  );
}

/**
 * Load a connector from an absolute or relative path.
 *   - `.json`           → JSON.parse, then defineConnector().
 *   - `.mjs` / `.js`    → dynamic import (via pathToFileURL, Windows-safe),
 *                         take the default export. If it already looks like a
 *                         ResolvedConnector use it as-is; otherwise treat it as
 *                         a ConnectorConfig and run it through defineConnector().
 * Returns the live connector plus the absolute module path it came from.
 */
export async function loadConnectorFromPath(
  path: string,
): Promise<{ connector: ResolvedConnector; modulePath: string }> {
  const modulePath = isAbsolute(path) ? path : resolve(path);

  if (modulePath.endsWith(".json")) {
    const text = readFileSync(modulePath, "utf8");
    const config = JSON.parse(text) as unknown;
    const connector = defineConnector(config as Parameters<typeof defineConnector>[0]);
    return { connector, modulePath };
  }

  // .mjs / .js — dynamic ESM import. pathToFileURL keeps Windows paths valid.
  const mod = (await import(pathToFileURL(modulePath).href)) as {
    default?: unknown;
  };
  const exported = mod.default;
  if (exported == null) {
    throw new Error(
      `Connector module has no default export: ${modulePath}`,
    );
  }
  const connector = isResolvedConnector(exported)
    ? exported
    : defineConnector(exported as Parameters<typeof defineConnector>[0]);
  return { connector, modulePath };
}

/**
 * Strip any function-valued `hooks` from per-platform overrides so the result
 * is JSON-serializable. A boolean `hooks` override is preserved; an object
 * override is dropped (it can only carry handler functions, which are not
 * serializable). Everything else on the override is kept verbatim.
 */
function serializablePlatforms(
  platforms: Partial<Record<PlatformId, PlatformOverride>>,
): Partial<Record<PlatformId, PlatformOverride>> {
  const out: Partial<Record<PlatformId, PlatformOverride>> = {};
  for (const [id, override] of Object.entries(platforms) as [
    PlatformId,
    PlatformOverride | undefined,
  ][]) {
    if (!override) continue;
    const { hooks, ...rest } = override;
    const clean: PlatformOverride = { ...rest };
    // Keep only a boolean hooks flag; object hooks carry handler functions.
    if (typeof hooks === "boolean") clean.hooks = hooks;
    out[id] = clean;
  }
  return out;
}

/**
 * Persist a connector's serializable metadata to `connectorDir(id)/connector.json`.
 * Handlers are NOT serialized — they are re-imported from `modulePath` at runtime.
 * Returns the absolute path of the written record.
 */
export function registerConnector(
  connector: ResolvedConnector,
  modulePath: string,
): string {
  const meta: RegisteredMeta = {
    id: connector.id,
    displayName: connector.displayName,
    version: connector.version,
    modulePath: resolve(modulePath),
    telemetry: connector.telemetry,
    hookEvents: connector.hookEvents,
    hasServer: !!connector.server,
    server: connector.server ?? null,
    commands: connector.commands,
    skills: connector.skills,
    subagents: connector.subagents,
    targets: connector.targets,
    platforms: serializablePlatforms(connector.platforms),
  };

  const dir = connectorDir(connector.id);
  ensureDir(dir);
  const outPath = join(dir, "connector.json");
  writeFileSync(outPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return outPath;
}

/**
 * Deregister a connector by removing its DATA-dir record directory
 * (`connectorDir(id)`) recursively. This is the inverse of {@link registerConnector}:
 * registerConnector writes `connectorDir(id)/connector.json`, but per-target
 * uninstall only strips host-native registrations — it never removes this record,
 * leaving an orphan behind. Best-effort + guarded: returns the directory path and
 * whether it existed before removal.
 */
export function deregisterConnector(id: string): {
  removed: boolean;
  path: string;
} {
  const dir = connectorDir(id);
  const existed = existsSync(dir);
  if (existed) rmSync(dir, { recursive: true, force: true });
  return { removed: existed, path: dir };
}

/**
 * Read the registered metadata record for `id`, or null if not registered or
 * the record is unreadable/corrupt.
 */
export function readRegisteredMeta(id: string): RegisteredMeta | null {
  const recordPath = join(connectorDir(id), "connector.json");
  if (!existsSync(recordPath)) return null;
  try {
    return JSON.parse(readFileSync(recordPath, "utf8")) as RegisteredMeta;
  } catch {
    return null;
  }
}

/**
 * Load the LIVE ResolvedConnector (with hook handlers) for a registered id by
 * re-importing its source module. Throws a clear error when the connector is
 * not registered or its source module no longer resolves to it.
 */
export async function loadRegisteredConnector(
  id: string,
): Promise<ResolvedConnector> {
  const meta = readRegisteredMeta(id);
  if (!meta) {
    throw new Error(
      `Connector "${id}" is not registered (no record at ${join(connectorDir(id), "connector.json")}). ` +
        `Run an install/register step first.`,
    );
  }
  if (!meta.modulePath || !existsSync(meta.modulePath)) {
    throw new Error(
      `Connector "${id}" record points at a missing module: ${meta.modulePath}`,
    );
  }
  const { connector } = await loadConnectorFromPath(meta.modulePath);
  return connector;
}

/**
 * Build a handler-less ResolvedConnector from stored metadata. Suitable for
 * inspection/doctor where live hook handlers are not needed (and where the
 * source module may even be gone). `hooks` is empty; `hookEvents` is preserved.
 */
export function connectorFromMeta(meta: RegisteredMeta): ResolvedConnector {
  return {
    id: meta.id,
    displayName: meta.displayName,
    version: meta.version,
    ...(meta.server ? { server: meta.server } : {}),
    hooks: {},
    hookEvents: meta.hookEvents ?? [],
    telemetry: meta.telemetry,
    commands: meta.commands ?? [],
    skills: meta.skills ?? [],
    subagents: meta.subagents ?? [],
    platforms: meta.platforms ?? {},
    targets: meta.targets,
  };
}

/**
 * List every registered connector as a handler-less ResolvedConnector (read
 * from `connectorsDir()`). Used by doctor to health-check what is actually
 * installed, rather than guessing from the local working directory.
 */
export function listRegisteredConnectors(): ResolvedConnector[] {
  const dir = connectorsDir();
  if (!existsSync(dir)) return [];
  const out: ResolvedConnector[] = [];
  for (const entry of readdirSync(dir)) {
    const meta = readRegisteredMeta(entry);
    if (meta) out.push(connectorFromMeta(meta));
  }
  return out;
}
