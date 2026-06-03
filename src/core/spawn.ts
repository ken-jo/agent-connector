/**
 * core/spawn — cross-platform command construction.
 *
 * Borrowed from context-mode (issues #369/#372/#548/#738): bare `node` is
 * unreliable on Windows Git Bash (MSYS) and MSYS rewrites absolute paths on
 * non-C: drives. Always use the resolved runtime path, forward slashes, and
 * double-quoting. No-ops on macOS/Linux.
 */

import type { ServerDef } from "./types.js";

/** Build `"<nodePath>" "<scriptPath>"`. */
export function buildNodeCommand(
  scriptPath: string,
  opts?: { nodePath?: string },
): string {
  const nodePath = (opts?.nodePath ?? process.execPath).replace(/\\/g, "/");
  const safe = scriptPath.replace(/\\/g, "/");
  return `"${nodePath}" "${safe}"`;
}

/**
 * Strict inverse of buildNodeCommand. Returns the two quoted tokens, or null if
 * `cmd` was not produced by buildNodeCommand (no fragile last-whitespace tail
 * grabbing — that was the #548 doubled-path bug when paths contained spaces).
 */
export function parseNodeCommand(
  cmd: string,
): { nodePath: string; scriptPath: string } | null {
  if (typeof cmd !== "string" || cmd.length === 0) return null;
  const m = cmd.match(/^"([^"]+)"\s+"([^"]+)"\s*$/);
  if (!m || !m[1] || !m[2]) return null;
  return { nodePath: m[1], scriptPath: m[2] };
}

/** Quote a single argument for inclusion in a host hook command string. */
export function quoteArg(arg: string): string {
  return `"${arg.replace(/\\/g, "/")}"`;
}

/**
 * Build the universal hook command a host config points at:
 *   "<homeBin>" hook <platformId> <event> --connector <id>
 * Pointing every host at the one stable home binary is how a single update
 * propagates everywhere (docs/ARCHITECTURE.md §3 R1).
 */
export function buildHomeBinHookCommand(
  homeBinPath: string,
  platformId: string,
  event: string,
  connectorId: string,
): string {
  return `${quoteArg(homeBinPath)} hook ${platformId} ${event} --connector ${connectorId}`;
}

/**
 * True when `command` is a home-bin hook command for exactly `connectorId`.
 *
 * Critical: the connector id is the LAST token of the hook command
 * (`... --connector <id>`), so a naive `command.includes("--connector " + id)`
 * collides on shared-prefix ids — `--connector acme-db` contains
 * `--connector acme`, which would let uninstalling `acme` strip `acme-db`'s
 * hooks. We anchor the id token: the character after it must be end-of-string,
 * whitespace, or a closing double-quote (the JSON-embedded case). Connector ids
 * are kebab-case (ID_RE) so they never contain whitespace or quotes themselves.
 */
export function isHomeBinHookCommand(
  command: string | undefined,
  homeBinPath: string,
  connectorId: string,
): boolean {
  if (!command) return false;
  if (!command.includes(homeBinPath)) return false;
  const token = `--connector ${connectorId}`;
  let from = 0;
  for (;;) {
    const idx = command.indexOf(token, from);
    if (idx < 0) return false;
    const after = command.charAt(idx + token.length);
    if (after === "" || after === '"' || /\s/.test(after)) return true;
    from = idx + token.length;
  }
}

/**
 * Single source of truth for "should this server be wrapped by `serve` for
 * telemetry?" — so every adapter behaves identically even for a server that
 * skipped normalizeServer (e.g. a per-platform override). On by default for an
 * stdio server with a command, unless explicitly disabled or telemetry is off.
 */
export function shouldWrapForTelemetry(
  server: ServerDef,
  telemetry: { enabled: boolean },
): boolean {
  return (
    server.wrapForTelemetry !== false &&
    telemetry.enabled === true &&
    server.transport === "stdio" &&
    typeof server.command === "string" &&
    server.command !== ""
  );
}

/**
 * Build the telemetry-wrapping server command:
 *   "<homeBin>" serve --connector <id> -- <realCommand> <realArgs...>
 * Used when a stdio server opts into transparent telemetry capture.
 */
export function buildServeWrapperCommand(
  homeBinPath: string,
  connectorId: string,
  realCommand: string,
  realArgs: string[],
): { command: string; args: string[] } {
  return {
    command: homeBinPath,
    args: ["serve", "--connector", connectorId, "--", realCommand, ...realArgs],
  };
}
