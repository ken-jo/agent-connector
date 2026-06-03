/**
 * cli/commands/usage-event — the HIDDEN host-native turn-usage entrypoint (4a).
 *
 *   agent-connector usage-event <platform> --connector <id>
 *
 * An OPT-IN AfterModel / PostInvocation hook (installed by the Gemini / Antigravity
 * adapters only when host-native usage is enabled) points here. It reads the ENTIRE
 * host payload from stdin, hands it to {@link runUsageEvent}, and ALWAYS exits 0 —
 * a host-native usage hook must never block a model turn. Hidden (not in the help
 * text) and intentionally a peer of `hook` so it mirrors the same plumbing.
 *
 * Fail-open is the contract: runUsageEvent never throws; on any parse/store error
 * it records nothing and we still exit 0.
 */

import { parseArgs } from "node:util";

import { runUsageEvent } from "../../runtime/index.js";

/** Read all of a readable stream to a UTF-8 string. */
async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function run(argv: string[]): Promise<number> {
  // strict:false so a future flag from a newer install can never make this throw
  // and surface a non-zero exit into the host's model turn.
  let platformId = "";
  let connectorId = "";
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { connector: { type: "string" } },
      allowPositionals: true,
      strict: false,
    });
    platformId = positionals[0] ?? "";
    connectorId = typeof values.connector === "string" ? values.connector : "";
  } catch {
    // A malformed invocation must still fail-open (record nothing, exit 0).
    return 0;
  }

  // Drain stdin regardless — a host expects the hook command to consume its
  // payload. A missing platform/connector simply records nothing.
  const stdin = await readAll(process.stdin).catch(() => "");

  if (platformId === "" || connectorId === "") {
    return 0;
  }

  const result = await runUsageEvent({ platformId, connectorId, stdin });
  return result.exitCode;
}
