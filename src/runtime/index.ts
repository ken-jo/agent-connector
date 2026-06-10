/**
 * runtime — the two universal runtime entrypoints, re-exported for the CLI.
 *
 *   • runHook  — the json-stdio hook dispatcher every host's hook config points
 *     at (via the single stable home binary). Takes the parsed hook flags + the
 *     raw stdin string; the CLI is responsible for reading stdin (these
 *     entrypoints accept it as a parameter and do no IO of their own here).
 *   • runServe — the telemetry-wrapping MCP stdio proxy launcher used when a
 *     stdio server opts into transparent per-tool token telemetry.
 *
 * Keeping both behind this barrel lets the CLI import from one place and lets
 * the package expose a stable `agentconnect/runtime` subpath.
 */

export { runHook } from "./hook-entrypoint.js";
export type { RunHookOptions, RunHookResult } from "./hook-entrypoint.js";

export { runServe } from "./serve.js";
export type { RunServeOptions } from "./serve.js";

export { runUsageEvent } from "./usage-event.js";
export type { RunUsageEventOptions, RunUsageEventResult } from "./usage-event.js";
