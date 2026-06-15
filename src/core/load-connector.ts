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

import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  CommandDef,
  HookEventName,
  InstallScope,
  MemoryDef,
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
  /**
   * Memory entries (managed-block content surface). Plain content, persisted
   * whole so uninstall normally has the full entry list even when the source
   * module is gone (the marker prefix-scan is the fallback beyond that).
   */
  memory: MemoryDef[];
  targets: ResolvedConnector["targets"];
  /** Per-platform overrides with any hook handler functions stripped. */
  platforms: Partial<Record<PlatformId, PlatformOverride>>;
  /**
   * The install scope this connector was registered under, persisted so the
   * runtime entrypoints (hook/statusline/action) can recover it cheaply (sync)
   * and stamp it onto the HostCtx/event — scope is an install-time property the
   * runtime otherwise has no access to. OPTIONAL: absent for an ad-hoc register
   * that passed no scope, or a record written before this field existed.
   * This is the install's RUN-WIDE DEFAULT scope; it can differ from the
   * effective per-host scope when a `platforms[host].scope` override is set (the
   * record is keyed by connector id only and holds no per-host scope map).
   */
  scope?: InstallScope;
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
  let modulePath = isAbsolute(path) ? path : resolve(path);
  // Canonicalize before building the file:// URL for dynamic import. On Windows a
  // short (8.3) temp path like C:\Users\RUNNER~1\...\x.mjs round-trips the "~" as
  // %7E and fails to load; realpathSync.native expands it to the real long path.
  // It also resolves symlinked temp roots (e.g. macOS /var -> /private/var).
  // If the file does not exist yet, fall through with the resolve()'d path so the
  // subsequent read/import throws the real not-found error.
  try {
    modulePath = realpathSync.native(modulePath);
  } catch {
    /* keep the resolve()'d path */
  }

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
 * serializable). `nativeHooks` declarations are persisted HANDLER-LESS (event
 * name + matcher only) so meta-based inspection (doctor / health checks / the
 * hook CLI) can still see WHICH native events were declared — the live handlers
 * are re-imported from `modulePath` at runtime, exactly like normalized hooks.
 * Everything else on the override is kept verbatim — notably `configPatch`
 * declarations, which are pure JSON (key/value/reason/docsUrl, no functions)
 * and persist WHOLE so uninstall/doctor can reason about them even when the
 * source module is gone.
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
    const { hooks, nativeHooks, ...rest } = override;
    const clean: PlatformOverride = { ...rest };
    // Keep only a boolean hooks flag; object hooks carry handler functions.
    if (typeof hooks === "boolean") clean.hooks = hooks;
    if (nativeHooks && typeof nativeHooks === "object") {
      const stripped: Record<string, { matcher?: string }> = {};
      for (const [event, def] of Object.entries(nativeHooks)) {
        stripped[event] =
          typeof def?.matcher === "string" ? { matcher: def.matcher } : {};
      }
      // Cast: the persisted record deliberately omits the (non-serializable)
      // handler; consumers of meta-derived connectors never dispatch handlers.
      clean.nativeHooks = stripped as PlatformOverride["nativeHooks"];
    }
    out[id] = clean;
  }
  return out;
}

/**
 * Persist a connector's serializable metadata to `connectorDir(id)/connector.json`.
 * Handlers are NOT serialized — they are re-imported from `modulePath` at runtime.
 * The optional `scope` (the install scope the caller deployed under) is persisted
 * so the runtime entrypoints can recover it and stamp it onto the HostCtx/event.
 * Returns the absolute path of the written record.
 */
export function registerConnector(
  connector: ResolvedConnector,
  modulePath: string,
  scope?: InstallScope,
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
    memory: connector.memory,
    targets: connector.targets,
    platforms: serializablePlatforms(connector.platforms),
    // Persist the install scope when the caller supplied one (the installer
    // passes its install scope). Omitted from the record when undefined so an
    // ad-hoc register stays minimal and round-trips as "no scope known".
    ...(scope !== undefined ? { scope } : {}),
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
    memory: meta.memory ?? [],
    // Actions carry live `run` handlers, so they are NOT serialized into the
    // record (like the statusline render). A handler-less meta-derived connector
    // gets [] — inspection/uninstall never dispatch action handlers, and the
    // BaseAdapter action default already tolerates an empty list.
    actions: [],
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
