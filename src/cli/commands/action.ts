/**
 * cli/commands/action — the universal user-invokable action entrypoint.
 *
 *   agent-connector action <platform> <actionId> --connector <id>
 *
 * A future host affordance (slash command / keybinding) points at the single
 * stable home binary (via core/spawn.buildHomeBinActionCommand). This command
 * parses the positionals + --connector, dispatches through runAction, writes any
 * stdout/stderr the action produced, and exits with its code. It reads NO stdin
 * (an action takes no host payload, unlike a hook or status line).
 *
 * USER-TRIGGERED is the runtime's contract: unlike the fail-open hook command,
 * an unknown action id or a throwing run surfaces as exit 1 + a stderr message —
 * the user invoked it deliberately, so the failure is shown, never swallowed.
 */

import { parseArgs } from "node:util";

import { runAction } from "../../runtime/index.js";
import { fail } from "../app.js";

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      connector: { type: "string" },
    },
    allowPositionals: true,
  });

  const platformId = positionals[0];
  const actionId = positionals[1];
  if (!platformId || !actionId) {
    return fail("usage: agent-connector action <platform> <actionId> --connector <id>");
  }
  const connectorId = values.connector;
  if (!connectorId || connectorId.trim() === "") {
    return fail("action requires --connector <id>");
  }

  const reply = await runAction({ platformId, actionId, connectorId });
  if (reply.stdout !== undefined && reply.stdout !== "") {
    process.stdout.write(reply.stdout.endsWith("\n") ? reply.stdout : `${reply.stdout}\n`);
  }
  if (reply.stderr !== undefined && reply.stderr !== "") {
    process.stderr.write(reply.stderr.endsWith("\n") ? reply.stderr : `${reply.stderr}\n`);
  }
  process.exit(reply.exitCode);
}
