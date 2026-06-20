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

import type {
  HookEventName,
  PlatformCapabilities,
  PlatformId,
} from "../core/types.js";
import { allAdapters, loadAdapter } from "../adapters/registry.js";

/**
 * The single source of truth mapping each normalized {@link HookEventName} onto
 * the {@link PlatformCapabilities} flag that says "this host can natively FIRE
 * this event". The optional flags (the newer E1 events + PostCompact) are read
 * as `?? false`, mirroring the supportsCommands precedent — a host that leaves a
 * flag unset cannot fire that event, so a declared hook for it skip-warns at
 * install and `explain` reports it as not honored.
 *
 * This is the per-event signal {@link explain}'s hooks row evaluates against the
 * connector's DECLARED events (so a Stop-only connector on a PreToolUse-only
 * host no longer falsely shows `native`), and the same signal `simulate`'s real
 * parse→handler→format chain expresses at runtime.
 */
export function hostCanFireEvent(
  c: PlatformCapabilities,
  event: HookEventName,
): boolean {
  switch (event) {
    case "SessionStart":
      return c.sessionStart;
    case "SessionEnd":
      return c.sessionEnd;
    case "UserPromptSubmit":
      return c.userPromptSubmit;
    case "PreToolUse":
      return c.preToolUse;
    case "PostToolUse":
      return c.postToolUse;
    case "PreCompact":
      return c.preCompact;
    case "Stop":
      return c.stop;
    case "Notification":
      return c.notification;
    case "PermissionRequest":
      return c.permissionRequest ?? false;
    case "PostToolUseFailure":
      return c.postToolUseFailure ?? false;
    case "SubagentStart":
      return c.subagentStart ?? false;
    case "SubagentStop":
      return c.subagentStop ?? false;
    case "PostCompact":
      return c.postCompact ?? false;
  }
}

/** The full normalized hook-event union, in canonical order. */
const ALL_HOOK_EVENTS: HookEventName[] = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "Stop",
  "Notification",
  "PermissionRequest",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "PostCompact",
];

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
 * `hooks` here is the COARSE host-capability predicate: `true` when the host can
 * fire AT LEAST ONE normalized event (it derives from {@link hostCanFireEvent},
 * the per-event source of truth, so the two never drift). It is the right answer
 * for the connector-less queries ({@link hostsSupporting} / {@link surfaceSupport}:
 * "which hosts have a hook runtime at all?"). It is deliberately NOT used by
 * {@link explain}, which must judge the hooks surface against the connector's
 * SPECIFIC declared events — a Stop-only connector on a PreToolUse-only host is
 * NOT honored even though the host has a hook runtime (see {@link explain}).
 */
export const SURFACE_PREDICATES: Record<
  SurfaceName,
  (c: PlatformCapabilities) => boolean
> = {
  server: (c) => c.transports.length > 0,
  hooks: (c) => ALL_HOOK_EVENTS.some((e) => hostCanFireEvent(c, e)),
  commands: (c) => c.supportsCommands ?? false,
  skills: (c) => c.supportsSkills ?? false,
  subagents: (c) => c.supportsSubagents ?? false,
  memory: (c) => c.supportsMemory ?? false,
  statusline: (c) => c.supportsStatusline ?? false,
  // Emitters ship on droid + hermes + warp plus the ts-plugin slash-command
  // hosts omp + openclaw (+ the nemoclaw fork) — the hosts with a verifiable
  // target. Every other host leaves supportsActions unset, so explain() marks
  // actions skip-warn there — the honest state for a host with no emission target.
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
