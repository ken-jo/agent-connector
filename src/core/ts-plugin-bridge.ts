/**
 * Pure string-builder for the byte-identical HEAD of every ts-plugin host's
 * generated plugin module: the `HOME_BIN`/`CONNECTOR_ID` consts plus the
 * cross-OS `bridge(event, payload)` entrypoint (win32 `execSync`-quoted vs
 * POSIX `execFileSync`, fail-open `JSON.parse`).
 *
 * This module emits SOURCE TEXT only — it imports nothing at runtime and is
 * never loaded by a generated plugin. The 6 adopting hosts (amp, kilo,
 * kilo-cli, mimo-code, omp, opencode) differ in this region by exactly four
 * host-specific tokens, captured below. Changing the emitted bytes here changes
 * every host's generated plugin in lockstep; each host's adapter suite runs the
 * generated plugin live and asserts source substrings, so it is the byte oracle.
 */

export interface BridgePreludeOptions {
  /** Absolute home-bin path (raw — JSON.stringified inside). */
  homeBin: string;
  /** Connector id (raw — JSON.stringified inside). */
  connectorId: string;
  /** Host hook subcommand slug used in the `hook <slug>` argv (e.g. "opencode", "amp"). */
  hookSlug: string;
  /** Host noun for the jsdoc `@param payload <noun>-shaped …` line (e.g. "OpenCode", "amp", "OMP"). */
  payloadNoun: string;
  /** Optional suffix on the jsdoc `@param event canonical event name<eventDoc>` line (e.g. " (PreToolUse|PostToolUse|SessionStart)"). Default "". */
  eventDoc?: string;
  /** The exact fail-open catch-comment line (host wording differs). */
  failOpenComment: string;
}

/**
 * Render the HOME_BIN/CONNECTOR_ID consts + the universal-entrypoint bridge() —
 * the byte-identical head of every ts-plugin host's generated plugin module.
 */
export function renderBridgePrelude(opts: BridgePreludeOptions): string {
  return `const HOME_BIN = ${JSON.stringify(opts.homeBin)};
const CONNECTOR_ID = ${JSON.stringify(opts.connectorId)};

/**
 * Invoke the universal hook entrypoint for one event.
 * @param {string} event canonical event name${opts.eventDoc ?? ""}
 * @param {object} payload ${opts.payloadNoun}-shaped payload posted on stdin
 * @returns {object|null} normalized HookResponse, or null on any failure
 */
function bridge(event, payload) {
  try {
    // On Windows HOME_BIN is the agent-connector.cmd launcher: Node cannot
    // execFile a batch file, and shell+args is deprecated (DEP0190), so run one
    // quoted command line via a shell. POSIX keeps the direct execFile (no shell).
    const args = ["hook", ${JSON.stringify(opts.hookSlug)}, event, "--connector", CONNECTOR_ID];
    const opts = { input: JSON.stringify(payload), encoding: "utf8" };
    const stdout =
      process.platform === "win32"
        ? execSync([HOME_BIN, ...args].map((a) => '"' + a + '"').join(" "), opts)
        : execFileSync(HOME_BIN, args, opts);
    const text = (stdout || "").trim();
    if (text === "") return { decision: "allow" };
    return JSON.parse(text);
  } catch {
    // ${opts.failOpenComment}
    return null;
  }
}`;
}
