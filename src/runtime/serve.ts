/**
 * runtime/serve — the `agentconnect serve` telemetry-wrapping entrypoint.
 *
 * When a stdio MCP server opts into transparent telemetry, its host config is
 * rewritten (by the adapter, via core/spawn.buildServeWrapperCommand) to launch
 *   <homeBin> serve --connector <id> -- <realCommand> <realArgs...>
 * instead of the server directly. The CLI parses those flags and calls
 * {@link runServe}, which stands up the per-session telemetry context (store,
 * tokenizer, project identity, host detection) and hands off to the proxy.
 *
 * The proxy (telemetry/proxy.runServeProxy) forwards bytes VERBATIM in both
 * directions and measures aggregate per-tool token counts out of band, so this
 * wrapper is transparent to both the host and the real server. It resolves with
 * the child server's exit code, which the CLI uses as its own.
 */

import { randomUUID } from "node:crypto";

import { detectRuntimeHost } from "../adapters/detect.js";
import { REGISTERED_PLATFORM_IDS } from "../adapters/registry.js";
import { loadRegisteredConnector } from "../core/load-connector.js";
import { projectIdentity } from "../core/paths.js";
import { detectLaunchMethod } from "../core/spawn.js";
import type { PlatformId } from "../core/types.js";
import { runServeProxy } from "../telemetry/proxy.js";
import { openStore } from "../telemetry/store.js";
import { getTokenizer } from "../telemetry/tokenizer.js";
import type { TelemetryInstallScope } from "../telemetry/types.js";

/** Flags the CLI hands to {@link runServe}. */
export interface RunServeOptions {
  /** Connector id from `--connector <id>`; selects telemetry config + stamps records. */
  connectorId: string;
  /** The real MCP server executable to spawn (everything after `--`). */
  serverCommand: string;
  /** Arguments passed to that executable. */
  serverArgs: string[];
  /**
   * Install scope from `--scope <user|project>`. OPTIONAL: absent for configs
   * written before scope plumbing existed — left unstamped so older rows read
   * as "unknown". Stamped verbatim onto every telemetry record when present.
   */
  installScope?: TelemetryInstallScope;
  /**
   * Install TARGET platform id from `--host <platformId>` (baked into the
   * wrapper at install time). OPTIONAL: when a recognized platform id, it
   * OVERRIDES runtime env detection so headless spawns stamp hostPlatform
   * correctly (detectRuntimeHost only knows env markers for a few hosts and
   * otherwise mis-attributes). Absent/unrecognized → fall back to detection.
   */
  hostPlatformOverride?: PlatformId;
}

/**
 * Launch the developer's real MCP server under the telemetry-wrapping proxy.
 *
 * Resolves with the child server's exit code (propagated as this process's exit
 * code by the CLI). The session id comes from AGENTCONNECT_SESSION when the
 * host sets it (empty otherwise); the host platform is detected from runtime env
 * markers; the project identity partitions telemetry by the stable project key.
 */
/**
 * Resolve a session id for telemetry attribution. Prefers a host-provided
 * session/thread marker (so records from the same host session group together);
 * falls back to a per-process UUID — each `serve` invocation is one server
 * session, a sensible default granularity — so `--by session` rollups are never
 * collapsed into a single empty-keyed group.
 */
function resolveSessionId(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.AGENTCONNECT_SESSION ||
    env.CLAUDE_SESSION_ID ||
    env.CODEX_THREAD_ID ||
    env.CURSOR_TRACE_ID ||
    env.MCP_SESSION_ID ||
    `proc-${randomUUID()}`
  );
}

export async function runServe(opts: RunServeOptions): Promise<number> {
  const { connectorId, serverCommand, serverArgs, installScope, hostPlatformOverride } =
    opts;

  const connector = await loadRegisteredConnector(connectorId);

  const id = projectIdentity(process.cwd());
  // Prefer the install TARGET platform baked into the wrapper (--host), but only
  // when it is a KNOWN registered platform id — a bad/unknown value falls back to
  // runtime env detection so a config typo can never poison hostPlatform.
  const hostPlatform: PlatformId =
    hostPlatformOverride !== undefined &&
    REGISTERED_PLATFORM_IDS.has(hostPlatformOverride)
      ? hostPlatformOverride
      : detectRuntimeHost().platform;
  const sessionId = resolveSessionId();

  // `serve` only ever wraps a locally-spawned stdio server (a remote/http server
  // is never launched through the proxy), so isRemote is always false here.
  const launchMethod = detectLaunchMethod(serverCommand, serverArgs);

  const store = openStore({});
  const tok = getTokenizer();

  return runServeProxy({
    connectorId,
    command: serverCommand,
    args: serverArgs,
    store,
    tokenizer: tok,
    modelFamilyHint: connector.telemetry.modelFamilyHint,
    hostPlatform,
    sessionId,
    projectKey: id.key,
    projectDir: id.dir,
    measureToolDefs: connector.telemetry.measureToolDefs,
    installScope,
    launchMethod,
  });
}
