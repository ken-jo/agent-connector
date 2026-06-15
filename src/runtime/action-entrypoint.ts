/**
 * runtime/action-entrypoint — the universal user-invokable action dispatcher.
 *
 * A future host affordance (slash command / keybinding) points at the single
 * stable home binary (`<homeBin> action <platformId> <actionId> --connector
 * <id>`, built by core/spawn.buildHomeBinActionCommand). The CLI parses the
 * flags and calls {@link runAction}. This module:
 *
 *   1. Loads the registered connector (live run handler) and the host adapter.
 *   2. Builds the shared {@link HostCtx} (host + the adapter's capabilities; NO
 *      stdin — an action takes no host payload, unlike a hook or status line).
 *   3. Finds the action by id, resolves the per-host run override, runs it, and
 *      prints the optional result.message.
 *
 * USER-TRIGGERED ERROR SEMANTICS (the key difference from hooks/statusline):
 * actions are invoked DELIBERATELY by a user, so errors are SURFACED, never
 * failed silently. An unknown action id or a throwing run → exit 1 + a stderr
 * message. (Hooks fail-open to exit 0; the statusline fail-safes to an empty
 * line — both are passive surfaces a host fires automatically. An action is not:
 * swallowing its failure would leave the user staring at nothing, unable to
 * tell the action ran.)
 *
 * NOTE (follow-up): no telemetry is recorded for action runs in v1 (out of
 * scope), and no adapter EMITS the affordance yet — v1 ships the dispatch
 * backbone only.
 */

import type {
  HostCtx,
  PlatformCapabilities,
  PlatformId,
} from "../core/types.js";
import { loadRegisteredConnector } from "../core/load-connector.js";
import { loadAdapter, REGISTERED_PLATFORM_IDS } from "../adapters/registry.js";

/** Flags the CLI hands to {@link runAction} (no stdin — actions take no payload). */
export interface RunActionOptions {
  /** Host platform id from the command (`action <platformId> <actionId> …`). */
  platformId: string;
  /** Connector id from `--connector <id>`. */
  connectorId: string;
  /** The action id positional (`action <platformId> <actionId> …`). */
  actionId: string;
}

/** Process-level result the CLI translates into exit code + stdout/stderr. */
export interface RunActionResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Minimal all-false capabilities for the fallback ctx when the host adapter is
 * unknown/unregistered. The action still runs (it takes no host payload), but
 * branching on `ctx.capabilities` reads every flag as off — no affordance is
 * advertised for a host we cannot describe.
 */
const EMPTY_CAPABILITIES: PlatformCapabilities = {
  preToolUse: false,
  postToolUse: false,
  preCompact: false,
  sessionStart: false,
  sessionEnd: false,
  userPromptSubmit: false,
  stop: false,
  notification: false,
  canModifyArgs: false,
  canModifyOutput: false,
  canInjectSessionContext: false,
  transports: [],
};

/**
 * Dispatch one user-invokable action. Always resolves (never rejects): every
 * path returns a concrete {@link RunActionResult} so the CLI can exit cleanly,
 * but UNLIKE the hook/statusline runtimes an error resolves to exit 1 + a stderr
 * message (actions are user-triggered — surface the failure). See the module
 * header for the user-triggered error contract.
 */
export async function runAction(
  opts: RunActionOptions,
): Promise<RunActionResult> {
  const { platformId, connectorId, actionId } = opts;

  let connector;
  try {
    connector = await loadRegisteredConnector(connectorId);
  } catch (err) {
    // A user asked to run an action on a connector we cannot load — surface it
    // (do NOT fail-open: the user would otherwise see nothing and assume it ran).
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stderr: message };
  }

  const action = connector.actions.find((a) => a.id === actionId);
  if (!action) {
    return {
      exitCode: 1,
      stderr: `no action "${actionId}" on connector ${connectorId}`,
    };
  }

  // Build the shared HostCtx. capabilities come from the adapter; an unknown
  // adapter still runs with the minimal ctx (an action takes no host payload).
  const adapter = await loadAdapter(platformId).catch(() => undefined);
  const host: PlatformId = REGISTERED_PLATFORM_IDS.has(platformId as PlatformId)
    ? (platformId as PlatformId)
    : "unknown";
  const ctx: HostCtx = {
    host,
    capabilities: adapter?.capabilities ?? EMPTY_CAPABILITIES,
  };

  // Per-host run override: when running for host X, `hosts[X].run` wins over the
  // top-level run; a host not listed (or a per-host entry that is somehow not a
  // function) falls back to the top-level run.
  const perHost = action.hosts?.[platformId as PlatformId]?.run;
  const run = typeof perHost === "function" ? perHost : action.run;

  try {
    const result = await run(ctx);
    const message = result?.message;
    if (typeof message === "string" && message !== "") {
      return { exitCode: 0, stdout: message };
    }
    // void / no message → success with no output.
    return { exitCode: 0 };
  } catch (err) {
    // USER-TRIGGERED: a throwing action surfaces its failure (exit 1 + stderr),
    // never a silent fail-open. This is the documented difference from
    // hooks/statusline.
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      stderr: `action "${actionId}" failed: ${message}`,
    };
  }
}

export default runAction;
