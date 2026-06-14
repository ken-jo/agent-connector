/**
 * runtime/statusline-entrypoint — the universal statusline (HUD) renderer.
 *
 * A statusline-supporting host points its status line config at the single stable
 * home binary (`<homeBin> statusline <platformId> --connector <id>`, built by
 * core/spawn.buildHomeBinStatuslineCommand). The CLI reads stdin and calls
 * {@link runStatusline} with the parsed flags + the raw stdin string. This module:
 *
 *   1. Loads the registered connector (live render handler) and the host adapter.
 *   2. Parses the host's raw status payload into a normalized StatuslineContext.
 *   3. Calls the connector's render(ctx) and coerces the result to a string.
 *   4. Formats the line into the host's native status reply (exit code + stdout).
 *
 * FAIL-SAFE is the contract (NOT fail-open with carve-outs like hooks): a status
 * line is decorative — it must NEVER wedge the host or spew an error/stack trace
 * into the status bar. So ANY error path — bad payload, missing connector,
 * throwing render, adapter without statusline support — returns exit 0 with NO
 * stdout (an empty status line), never a non-zero exit and never partial output.
 *
 * NOTE (follow-up): no telemetry is recorded for statusline renders in v1 (out of
 * scope). When added, it MUST stay inside the same fail-safe envelope.
 */

import { log } from "../core/logger.js";
import { loadRegisteredConnector } from "../core/load-connector.js";
import { loadAdapter } from "../adapters/registry.js";

/** Flags + stdin the CLI hands to {@link runStatusline}. */
export interface RunStatuslineOptions {
  /** Host platform id from the command (`statusline <platformId> …`). */
  platformId: string;
  /** Connector id from `--connector <id>`. */
  connectorId: string;
  /** Raw stdin payload (host-native status JSON). Empty string is tolerated → `{}`. */
  stdin: string;
}

/** Process-level result the CLI translates into exit code + stdout/stderr. */
export interface RunStatuslineResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

/** The fail-safe result: exit 0, no output (an empty status line). */
const EMPTY: RunStatuslineResult = { exitCode: 0 };

/**
 * Tolerantly parse the host's stdin payload. Empty / whitespace-only input is a
 * legitimate "no payload" signal and resolves to `{}`. Malformed JSON also
 * degrades to `{}` rather than throwing — fail-safe is the contract.
 */
function parseStdin(stdin: string): unknown {
  const trimmed = stdin.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

/**
 * Render one host status-line invocation. Always resolves (never rejects): every
 * failure path returns the empty {@link EMPTY} result so the CLI exits cleanly
 * with an empty status line. See the module header for the fail-safe contract.
 */
export async function runStatusline(
  opts: RunStatuslineOptions,
): Promise<RunStatuslineResult> {
  const { platformId, connectorId, stdin } = opts;

  try {
    const connector = await loadRegisteredConnector(connectorId);
    const adapter = await loadAdapter(platformId);

    // Nothing to render: no statusline declared, or the host adapter has no
    // statusline runtime support (parse/format pair). Empty line, exit 0.
    if (
      !connector.statusline ||
      typeof connector.statusline.render !== "function" ||
      !adapter ||
      !adapter.parseStatusInput ||
      !adapter.formatStatusOutput
    ) {
      return EMPTY;
    }

    const raw = parseStdin(stdin);
    const ctx = adapter.parseStatusInput(raw);
    // The command carries the authoritative connector id; stamp it so render()
    // sees the connector it was dispatched for.
    ctx.connectorId = connectorId;

    const rendered = await connector.statusline.render(ctx);
    // Coerce: a non-string return (number, accidental object) is stringified so
    // a misbehaving render never crashes the format step. null/undefined → "".
    const line = rendered == null ? "" : String(rendered);

    const reply = adapter.formatStatusOutput(line);
    return {
      exitCode: reply.exitCode,
      ...(reply.stdout !== undefined ? { stdout: reply.stdout } : {}),
      ...(reply.stderr !== undefined ? { stderr: reply.stderr } : {}),
    };
  } catch (err) {
    // FAIL-SAFE: a status line must never wedge the host or surface an error.
    // Log for diagnostics (stderr of the home binary — not the status bar) and
    // return the empty line.
    const message = err instanceof Error ? err.message : String(err);
    log.error(`statusline ${platformId} (${connectorId}) failed:`, message);
    return EMPTY;
  }
}

export default runStatusline;
