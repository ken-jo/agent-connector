/**
 * sdk/introspect — host-capability introspection over the adapter registry.
 *
 * A thin, READ-ONLY query layer above {@link loadAdapter} / {@link allAdapters}:
 * "which hosts can honor surface X?" and "what can host Y do?". It exists so a
 * connector author (or a docs/CLI surface) can answer those questions WITHOUT
 * reaching into adapter internals or re-deriving the per-surface capability
 * rules — the predicates below are the single source of truth for mapping the
 * raw {@link PlatformCapabilities} flags onto the developer-facing surface names.
 *
 * Everything is async because adapters load lazily (one entry per platform in
 * the registry, imported only when queried).
 */

import type { PlatformCapabilities, PlatformId } from "../core/types.js";
import { allAdapters, loadAdapter } from "../adapters/registry.js";

/**
 * The developer-facing surface names a connector can declare. These mirror the
 * top-level {@link import("../core/types.js").ConnectorConfig} keys (server,
 * hooks, commands, …) plus the platform-scoped `configPatch` / `nativeHooks`
 * escape hatches — the same vocabulary the install diff and `explain` use.
 */
export type SurfaceName =
  | "server"
  | "hooks"
  | "commands"
  | "skills"
  | "subagents"
  | "memory"
  | "statusline"
  | "actions"
  | "configPatch"
  | "nativeHooks";

/**
 * Pure capability predicate per surface — `true` when the host can NATIVELY
 * honor that surface. The optional capability flags are read as `?? false`
 * (the supportsCommands precedent in core/types), so a host that simply leaves
 * a flag unset reports the surface as unsupported (the installer skip-warns it).
 *
 * `hooks` is satisfied by ANY normalized hook event (i.e. the host has at least
 * one event it can dispatch); the per-event flags map 1:1 onto the
 * {@link import("../core/types.js").HookEventName} union.
 */
export const SURFACE_PREDICATES: Record<
  SurfaceName,
  (c: PlatformCapabilities) => boolean
> = {
  server: (c) => c.transports.length > 0,
  hooks: (c) =>
    c.sessionStart ||
    c.preToolUse ||
    c.postToolUse ||
    c.userPromptSubmit ||
    c.stop ||
    c.sessionEnd ||
    c.preCompact ||
    c.notification ||
    (c.permissionRequest ?? false) ||
    (c.postToolUseFailure ?? false) ||
    (c.subagentStart ?? false) ||
    (c.subagentStop ?? false),
  commands: (c) => c.supportsCommands ?? false,
  skills: (c) => c.supportsSkills ?? false,
  subagents: (c) => c.supportsSubagents ?? false,
  memory: (c) => c.supportsMemory ?? false,
  statusline: (c) => c.supportsStatusline ?? false,
  // v1: no adapter sets supportsActions (no affordance emitter yet), so this is
  // false everywhere and explain() marks actions skip-warn on every host — the
  // honest state until the affordance emitter ships.
  actions: (c) => c.supportsActions ?? false,
  configPatch: (c) => c.supportsConfigPatch ?? false,
  nativeHooks: (c) => c.supportsNativeHooks ?? false,
};

/**
 * The {@link PlatformCapabilities} a host advertises, or `undefined` for an id
 * that is not in the registry (`"unknown"`, a usage-only id like `"synthetic"`,
 * or a typo) — callers branch on undefined rather than crash.
 */
export async function capabilitiesOf(
  host: PlatformId | string,
): Promise<PlatformCapabilities | undefined> {
  const adapter = await loadAdapter(host);
  return adapter?.capabilities;
}

/**
 * Every registered host that can NATIVELY honor `surface`, as a sorted id list
 * (stable output for snapshots/docs). Loads all adapters in parallel and keeps
 * only those whose capabilities pass {@link SURFACE_PREDICATES}.
 */
export async function hostsSupporting(surface: SurfaceName): Promise<PlatformId[]> {
  const predicate = SURFACE_PREDICATES[surface];
  const adapters = await allAdapters();
  return adapters
    .filter((adapter) => predicate(adapter.capabilities))
    .map((adapter) => adapter.id)
    .sort();
}

/**
 * Convenience: does `host` natively support `surface`? `false` for an unknown
 * id (no capabilities → cannot support anything).
 */
export async function surfaceSupport(
  host: PlatformId | string,
  surface: SurfaceName,
): Promise<boolean> {
  const capabilities = await capabilitiesOf(host);
  return capabilities ? SURFACE_PREDICATES[surface](capabilities) : false;
}
