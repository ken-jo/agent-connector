/**
 * runtime — the universal runtime entrypoints, re-exported for the CLI.
 *
 *   • runHook  — the json-stdio hook dispatcher every host's hook config points
 *     at (via the single stable home binary). Takes the parsed hook flags + the
 *     raw stdin string; the CLI is responsible for reading stdin (these
 *     entrypoints accept it as a parameter and do no IO of their own here).
 *     runNativeHook is its passthrough sibling for host-native (non-union)
 *     events declared under platforms[<id>].nativeHooks — raw stdin → handler →
 *     verbatim JSON stdout, no normalization.
 *   • runServe — the telemetry-wrapping MCP stdio proxy launcher used when a
 *     stdio server opts into transparent per-tool token telemetry.
 *
 * Keeping both behind this barrel lets the CLI import from one place and lets
 * the package expose a stable `agent-connector/runtime` subpath.
 */

export { runHook, runNativeHook, isNativeHookDeclared } from "./hook-entrypoint.js";
export type {
  RunHookOptions,
  RunHookResult,
  RunNativeHookOptions,
} from "./hook-entrypoint.js";

export { runServe } from "./serve.js";
export type { RunServeOptions } from "./serve.js";

export { runUsageEvent } from "./usage-event.js";
export type { RunUsageEventOptions, RunUsageEventResult } from "./usage-event.js";

export { runStatusline } from "./statusline-entrypoint.js";
export type {
  RunStatuslineOptions,
  RunStatuslineResult,
} from "./statusline-entrypoint.js";

export { runAction } from "./action-entrypoint.js";
export type {
  RunActionOptions,
  RunActionResult,
} from "./action-entrypoint.js";
