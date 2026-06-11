/**
 * cli/commands/hook — the universal json-stdio hook entrypoint.
 *
 *   agent-connector hook <platform> <event> --connector <id>
 *
 * This is the single command every host's hook config points at (via the stable
 * home binary). It reads the ENTIRE host payload from stdin, dispatches through
 * runHook, writes any stdout/stderr the adapter produced, and exits with the
 * adapter's exit code (the host interprets it as allow/deny/etc.).
 *
 * Fail-open is the runtime's contract: runHook never rejects, so a framework or
 * handler bug can't wedge a host's tool call.
 */

import { parseArgs } from "node:util";

import type { HookEventName } from "../../core/types.js";
import { isNativeHookDeclared, runHook, runNativeHook } from "../../runtime/index.js";
import type { RunHookResult } from "../../runtime/index.js";
import { fail } from "../app.js";

const HOOK_EVENTS: ReadonlySet<string> = new Set<HookEventName>([
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
]);

/** Read all of a readable stream to a UTF-8 string. */
async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      connector: { type: "string" },
    },
    allowPositionals: true,
  });

  const platformId = positionals[0];
  const event = positionals[1];
  if (!platformId || !event) {
    return fail("usage: agent-connector hook <platform> <event> --connector <id>");
  }
  const connectorId = values.connector;
  if (!connectorId || connectorId.trim() === "") {
    return fail("hook requires --connector <id>");
  }

  // NATIVE PASSTHROUGH: a non-union event name is accepted ONLY when the
  // resolved connector declares it under platforms[<platform>].nativeHooks —
  // dispatch then bypasses the normalized parse/format entirely (raw stdin →
  // handler → verbatim JSON stdout). Undeclared names keep the strict error.
  if (!HOOK_EVENTS.has(event)) {
    if (!(await isNativeHookDeclared(platformId, event, connectorId))) {
      return fail(`unknown hook event "${event}"`);
    }
    const stdin = await readAll(process.stdin);
    const reply = await runNativeHook({ platformId, event, connectorId, stdin });
    return exitWithReply(reply);
  }

  // Read the entire host payload before dispatching.
  const stdin = await readAll(process.stdin);

  const reply = await runHook({
    platformId,
    event: event as HookEventName,
    connectorId,
    stdin,
  });

  return exitWithReply(reply);
}

/** Write a hook reply's stdout/stderr and exit with its code. */
function exitWithReply(reply: RunHookResult): never {
  if (reply.stdout !== undefined && reply.stdout !== "") {
    process.stdout.write(reply.stdout);
  }
  if (reply.stderr !== undefined && reply.stderr !== "") {
    process.stderr.write(reply.stderr.endsWith("\n") ? reply.stderr : `${reply.stderr}\n`);
  }
  process.exit(reply.exitCode);
}
