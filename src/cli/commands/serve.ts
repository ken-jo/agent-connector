/**
 * cli/commands/serve — the telemetry-wrapping MCP stdio proxy entrypoint.
 *
 *   agent-connector serve --connector <id> -- <realCommand> <realArgs...>
 *
 * A stdio MCP server that opts into transparent telemetry has its host config
 * rewritten to launch THIS instead of the server directly. We split argv at the
 * literal `--` separator: flags on the left, the real server command + args on
 * the right (taken verbatim). runServe stands up the per-session telemetry
 * context and proxies bytes both ways, resolving with the child's exit code.
 */

import { parseArgs } from "node:util";

import { runServe } from "../../runtime/index.js";
import { fail } from "../app.js";

export async function run(argv: string[]): Promise<number> {
  // Split at the FIRST literal "--": everything after it is the real server
  // invocation and must be passed through verbatim (never re-parsed as flags).
  const sepIndex = argv.indexOf("--");
  if (sepIndex === -1) {
    return fail(
      "usage: agent-connector serve --connector <id> -- <command> [args...]",
    );
  }
  const flagArgs = argv.slice(0, sepIndex);
  const serverInvocation = argv.slice(sepIndex + 1);

  const { values } = parseArgs({
    args: flagArgs,
    options: {
      connector: { type: "string" },
    },
    allowPositionals: false,
  });

  const connectorId = values.connector;
  if (!connectorId || connectorId.trim() === "") {
    return fail("serve requires --connector <id>");
  }

  const serverCommand = serverInvocation[0];
  if (!serverCommand) {
    return fail("serve requires a command after `--`");
  }
  const serverArgs = serverInvocation.slice(1);

  const code = await runServe({ connectorId, serverCommand, serverArgs });
  process.exit(code);
}
