/**
 * cli/commands/serve — the telemetry-wrapping MCP stdio proxy entrypoint.
 *
 *   agent-connector serve --connector <id> [--scope <user|project>] [--host <platformId>] -- <realCommand> <realArgs...>
 *
 * A stdio MCP server that opts into transparent telemetry has its host config
 * rewritten to launch THIS instead of the server directly. We split argv at the
 * literal `--` separator: flags on the left, the real server command + args on
 * the right (taken verbatim). The optional `--scope` flag records the install
 * dimension (global user vs project-local) onto telemetry; it is absent for
 * configs written before scope plumbing existed → the runtime reads "unknown".
 * The optional `--host` flag carries the install TARGET platform id so the proxy
 * stamps hostPlatform correctly under a headless spawn; absent configs fall back
 * to runtime env detection.
 * The optional `--data-dir` flag pins the framework data-root the child must use
 * to resolve the connector record (and write telemetry). It is written by the
 * wrapper only for a NON-DEFAULT root, because some hosts (codex) strip the MCP
 * child's environment and would otherwise not propagate AGENT_CONNECTOR_DATA_DIR
 * — the child would then resolve the default root and fail "Connector not
 * registered". Absent configs resolve the data-root the usual way.
 * runServe stands up the per-session telemetry context and proxies bytes both
 * ways, resolving with the child's exit code.
 */

import { parseArgs } from "node:util";

import type { PlatformId } from "../../core/types.js";
import type { TelemetryInstallScope } from "../../telemetry/types.js";
import { runServe } from "../../runtime/index.js";
import { fail } from "../app.js";

export async function run(argv: string[]): Promise<number> {
  // Split at the FIRST literal "--": everything after it is the real server
  // invocation and must be passed through verbatim (never re-parsed as flags).
  const sepIndex = argv.indexOf("--");
  if (sepIndex === -1) {
    return fail(
      "usage: agent-connector serve --connector <id> [--scope <user|project>] [--host <platformId>] [--data-dir <path>] -- <command> [args...]",
    );
  }
  const flagArgs = argv.slice(0, sepIndex);
  const serverInvocation = argv.slice(sepIndex + 1);

  // strict:false so an unknown FUTURE flag before `--` (written by a newer host
  // config) is ignored instead of throwing — a parse throw here would prevent the
  // real MCP server from ever spawning and wedge the host's tool call. We only
  // read the flags we understand; everything else is tolerated.
  const { values } = parseArgs({
    args: flagArgs,
    options: {
      connector: { type: "string" },
      scope: { type: "string" },
      // `--host <platformId>` bakes the install TARGET platform into the wrapper
      // so the proxy stamps hostPlatform correctly under a headless spawn (where
      // runtime env markers are absent). Optional + tolerated (strict:false).
      host: { type: "string" },
      // `--data-dir <path>` pins the framework data-root for the child (connector
      // record + telemetry). Written only for a NON-DEFAULT root, so the child
      // never depends on inheriting AGENT_CONNECTOR_DATA_DIR (codex strips it).
      // Optional + tolerated (strict:false).
      "data-dir": { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  // With strict:false, parseArgs types each value as string | boolean; we only
  // accept the string form (a bare `--connector` flag with no value is invalid).
  const connectorId = typeof values.connector === "string" ? values.connector : undefined;
  if (!connectorId || connectorId.trim() === "") {
    return fail("serve requires --connector <id>");
  }

  // `--scope` is optional and only ever "user" | "project" (the wrapper emits
  // exactly those). An unrecognized value is ignored rather than fatal so a
  // future/older wrapper can never break a real tool call over a flag mismatch.
  const rawScope = values.scope;
  const installScope: TelemetryInstallScope | undefined =
    rawScope === "user" || rawScope === "project" ? rawScope : undefined;

  // `--host` carries the install TARGET platform id (string only). runServe
  // validates it against the registry and falls back to runtime detection when
  // it is absent or unrecognized — so a future/older wrapper never breaks here.
  const hostPlatformOverride =
    typeof values.host === "string" ? (values.host as PlatformId) : undefined;

  // `--data-dir` pins the framework data-root (string only). When present and
  // non-empty, runServe makes the WHOLE child resolve this root — connector
  // record lookup AND telemetry store — so the wrap is independent of the child
  // env that codex strips. Absent → resolve the data-root the usual way.
  const dataDir =
    typeof values["data-dir"] === "string" && values["data-dir"].trim() !== ""
      ? values["data-dir"]
      : undefined;

  const serverCommand = serverInvocation[0];
  if (!serverCommand) {
    return fail("serve requires a command after `--`");
  }
  const serverArgs = serverInvocation.slice(1);

  const code = await runServe({
    connectorId,
    serverCommand,
    serverArgs,
    installScope,
    hostPlatformOverride,
    dataDir,
  });
  process.exit(code);
}
