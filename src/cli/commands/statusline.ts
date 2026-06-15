/**
 * cli/commands/statusline — the universal statusline (HUD) entrypoint.
 *
 *   agent-connector statusline <platform> --connector <id>
 *
 * A statusline-supporting host points its status line config at the single stable
 * home binary (via core/spawn.buildHomeBinStatuslineCommand). This command reads
 * the ENTIRE host payload from stdin, dispatches through runStatusline, writes the
 * rendered line to stdout, and exits with the adapter's exit code.
 *
 * FAIL-SAFE is the runtime's contract: a status line must NEVER wedge the host or
 * spew an error into the status bar. runStatusline never rejects (always exits 0
 * with at most a rendered line), and even a malformed invocation here degrades to
 * exit 0 with no output — never the strict `fail()` non-zero used by other
 * commands.
 */

import { parseArgs } from "node:util";

import { runStatusline } from "../../runtime/index.js";

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
  // and surface a non-zero exit into the host's status bar.
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
    // A malformed invocation must still fail-safe (render nothing, exit 0).
    return 0;
  }

  // Drain stdin regardless — a host expects the command to consume its payload.
  const stdin = await readAll(process.stdin).catch(() => "");

  // Missing platform/connector → render nothing, exit 0 (never a non-zero exit).
  if (platformId === "" || connectorId === "") {
    return 0;
  }

  const reply = await runStatusline({ platformId, connectorId, stdin });
  if (reply.stdout !== undefined && reply.stdout !== "") {
    process.stdout.write(reply.stdout);
  }
  if (reply.stderr !== undefined && reply.stderr !== "") {
    process.stderr.write(reply.stderr.endsWith("\n") ? reply.stderr : `${reply.stderr}\n`);
  }
  return reply.exitCode;
}
