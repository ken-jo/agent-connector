/**
 * runtime/serve — the `agent-connector serve` telemetry-wrapping entrypoint.
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
import { loadRegisteredConnector } from "../core/load-connector.js";
import { projectIdentity } from "../core/paths.js";
import { runServeProxy } from "../telemetry/proxy.js";
import { openStore } from "../telemetry/store.js";
import { getTokenizer } from "../telemetry/tokenizer.js";

/** Flags the CLI hands to {@link runServe}. */
export interface RunServeOptions {
  /** Connector id from `--connector <id>`; selects telemetry config + stamps records. */
  connectorId: string;
  /** The real MCP server executable to spawn (everything after `--`). */
  serverCommand: string;
  /** Arguments passed to that executable. */
  serverArgs: string[];
}

/**
 * Launch the developer's real MCP server under the telemetry-wrapping proxy.
 *
 * Resolves with the child server's exit code (propagated as this process's exit
 * code by the CLI). The session id comes from AGENT_CONNECTOR_SESSION when the
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
    env.AGENT_CONNECTOR_SESSION ||
    env.CLAUDE_SESSION_ID ||
    env.CODEX_THREAD_ID ||
    env.CURSOR_TRACE_ID ||
    env.MCP_SESSION_ID ||
    `proc-${randomUUID()}`
  );
}

export async function runServe(opts: RunServeOptions): Promise<number> {
  const { connectorId, serverCommand, serverArgs } = opts;

  const connector = await loadRegisteredConnector(connectorId);

  const id = projectIdentity(process.cwd());
  const host = detectRuntimeHost();
  const sessionId = resolveSessionId();

  const store = openStore({});
  const tok = getTokenizer();

  return runServeProxy({
    connectorId,
    command: serverCommand,
    args: serverArgs,
    store,
    tokenizer: tok,
    modelFamilyHint: connector.telemetry.modelFamilyHint,
    hostPlatform: host.platform,
    sessionId,
    projectKey: id.key,
    projectDir: id.dir,
    measureToolDefs: connector.telemetry.measureToolDefs,
  });
}
