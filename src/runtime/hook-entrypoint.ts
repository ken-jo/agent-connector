/**
 * runtime/hook-entrypoint — the universal json-stdio hook dispatcher.
 *
 * Every json-stdio host points its hook config at the single stable home binary
 * (`<homeBin> hook <platformId> <event> --connector <id>`, built by
 * core/spawn.buildHomeBinHookCommand). The CLI reads stdin and calls
 * {@link runHook} with the parsed flags + the raw stdin string. This module:
 *
 *   1. Loads the registered connector (live handlers) and the host adapter.
 *   2. Parses the host's stdin payload into a normalized event via the adapter.
 *   3. Finds the connector's handler for the event, honoring the tool matcher.
 *   4. Runs the handler, normalizes its return, and formats the adapter's native
 *      reply.
 *
 * Fail-open is the safety contract: ANY error degrades to exit 0 ("allow") so a
 * framework or handler bug can never wedge a host's tool call — EXCEPT when the
 * event is PreToolUse and the handler explicitly denied, in which case the deny
 * (a deliberate security decision) is preserved rather than swallowed.
 */

import type {
  HookEventName,
  HookResponse,
  PlatformId,
  ResolvedConnector,
} from "../core/types.js";
import { log } from "../core/logger.js";
import { loadRegisteredConnector } from "../core/load-connector.js";
import { loadAdapter, REGISTERED_PLATFORM_IDS } from "../adapters/registry.js";
import type { NormalizedEvent } from "../adapters/spi.js";
import { projectIdentity } from "../core/paths.js";
import { measureHook } from "../telemetry/measure.js";
import { openStore, newRecordId } from "../telemetry/store.js";
import { getTokenizer, inferModelFamily } from "../telemetry/tokenizer.js";

/** Flags + stdin the CLI hands to {@link runHook}. */
export interface RunHookOptions {
  /** Host platform id from the hook command (`hook <platformId> ...`). */
  platformId: string;
  /** Canonical lifecycle event name from the hook command. */
  event: HookEventName;
  /** Connector id from `--connector <id>`. */
  connectorId: string;
  /** Raw stdin payload (host-native JSON). Empty string is tolerated → `{}`. */
  stdin: string;
}

/** Process-level result the CLI translates into exit code + stdout/stderr. */
export interface RunHookResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

/** A pass-through "allow" reply with exit 0 and no payload. */
const ALLOW: RunHookResult = { exitCode: 0 };

/** Does a normalized event carry a tool name (only tool events do)? */
function eventToolName(evt: NormalizedEvent): string | undefined {
  const name = (evt as { toolName?: unknown }).toolName;
  return typeof name === "string" ? name : undefined;
}

/**
 * Tolerantly parse the host's stdin payload. Empty / whitespace-only input is a
 * legitimate "no payload" signal from some hosts and resolves to `{}`. Malformed
 * JSON also degrades to `{}` rather than throwing — fail-open is the contract.
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
 * Compile the connector's matcher (a regex string) for a tool event. A missing
 * or empty matcher matches everything (returns null → no filtering). An invalid
 * regex degrades to "match everything" so a typo never blocks tool calls.
 */
function compileMatcher(matcher: string | undefined): RegExp | null {
  if (!matcher || matcher === "") return null;
  try {
    return new RegExp(matcher);
  } catch {
    return null;
  }
}

/** Normalize a handler return (void → allow) into a concrete HookResponse. */
function normalizeResponse(value: HookResponse | void): HookResponse {
  if (value == null || typeof value !== "object") return { decision: "allow" };
  return value;
}

/**
 * Resolve the host platform to stamp on a hook telemetry row. Mirrors the serve
 * `--host` plumbing: the install-target platform id is baked into the hook
 * command (`hook <platformId> <event> …`) so `opts.platformId` is authoritative,
 * but an explicit env override (AGENT_CONNECTOR_HOST) wins when it names a known
 * platform. Falls back to the event's adapter-stamped hostPlatform, then
 * "unknown" — never throws.
 */
function resolveHookHostPlatform(
  platformId: string,
  evt: NormalizedEvent,
): PlatformId {
  const override = process.env.AGENT_CONNECTOR_HOST;
  if (
    override !== undefined &&
    REGISTERED_PLATFORM_IDS.has(override as PlatformId)
  ) {
    return override as PlatformId;
  }
  if (REGISTERED_PLATFORM_IDS.has(platformId as PlatformId)) {
    return platformId as PlatformId;
  }
  const fromEvent = (evt as { hostPlatform?: unknown }).hostPlatform;
  if (
    typeof fromEvent === "string" &&
    REGISTERED_PLATFORM_IDS.has(fromEvent as PlatformId)
  ) {
    return fromEvent as PlatformId;
  }
  return "unknown";
}

/**
 * Record one RUNTIME hook dispatch as a `hook` developer-axis telemetry row.
 *
 * input  = the inbound normalized event payload the handler reads;
 * output = the normalized {@link HookResponse} the handler returned (the part
 *          that becomes host context/decision: additionalContext/updatedInput/
 *          reason/…). Tokenized with the SAME tokenizer the proxy uses.
 *
 * MUST be fail-open (the hook runtime is fail-open by contract): any error here
 * is swallowed so a measurement bug can NEVER break a host's hook. Honors the
 * AGENT_CONNECTOR_TELEMETRY=0 kill switch (skips entirely; the store's append is
 * already a no-op under it, but we also skip the tokenize work).
 */
function recordHookTelemetry(
  opts: RunHookOptions,
  connector: ResolvedConnector,
  evt: NormalizedEvent,
  response: HookResponse,
): void {
  if (process.env.AGENT_CONNECTOR_TELEMETRY === "0") return;
  try {
    const family = inferModelFamily("", connector.telemetry.modelFamilyHint);
    const measurement = measureHook(evt, response, family, getTokenizer());

    const sessionId =
      typeof (evt as { sessionId?: unknown }).sessionId === "string"
        ? ((evt as { sessionId: string }).sessionId)
        : "";
    const evtProjectDir = (evt as { projectDir?: unknown }).projectDir;
    const projectDir =
      typeof evtProjectDir === "string" && evtProjectDir !== ""
        ? evtProjectDir
        : process.cwd();
    const id = projectIdentity(projectDir);

    const store = openStore({});
    try {
      store.append({
        id: newRecordId(0),
        ts: Date.now(),
        connectorId: opts.connectorId,
        toolName: opts.event, // for a hook row the per-item name IS the event
        scope: "hook",
        surfaceKind: "hook",
        hostPlatform: resolveHookHostPlatform(opts.platformId, evt),
        sessionId,
        projectKey: id.key,
        projectDir: id.dir,
        inputTokens: measurement.inputTokens,
        outputTokens: measurement.outputTokens,
        confidenceSource: measurement.source,
        isError: false,
      });
    } finally {
      store.close();
    }
  } catch {
    // Fail-open: a telemetry error must NEVER break the hook runtime.
  }
}

/**
 * Dispatch one host hook invocation. Always resolves (never rejects): every
 * failure path returns a concrete {@link RunHookResult} so the CLI can exit
 * cleanly. See the module header for the fail-open contract.
 */
export async function runHook(opts: RunHookOptions): Promise<RunHookResult> {
  const { platformId, event, connectorId, stdin } = opts;

  try {
    const connector = await loadRegisteredConnector(connectorId);
    const adapter = await loadAdapter(platformId);

    // mcp-only hosts (and any adapter without runtime dispatch) cannot parse a
    // hook payload — nothing to do, allow.
    if (!adapter || !adapter.parseEvent || !adapter.formatReply) {
      return ALLOW;
    }

    const raw = parseStdin(stdin);
    const evt = adapter.parseEvent(event, raw);
    // The hook command carries the authoritative connector id; stamp it on the
    // event so handlers see the connector they were dispatched for.
    evt.connectorId = connectorId;

    const definition = connector.hooks[event];
    if (!definition || typeof definition.handler !== "function") {
      // The connector declares no handler for this event — allow.
      return ALLOW;
    }

    // Tool-event matcher: if set and the event's tool name does not match, allow
    // (the hook is simply not interested in this tool).
    const toolName = eventToolName(evt);
    if (toolName !== undefined) {
      const re = compileMatcher(definition.matcher);
      if (re && !re.test(toolName)) return ALLOW;
    }

    // Run the handler. Its return is normalized (void → allow) and handed to the
    // adapter to render the host-native reply.
    const handlerResult = await definition.handler(
      // The adapter parsed `evt` as exactly this event's payload type; the
      // HooksConfig handler for the same event expects that payload.
      evt as never,
    );
    const response = normalizeResponse(handlerResult);

    // Developer-axis telemetry for the RUNTIME `hook` surface. Fail-open: never
    // lets a measurement error break the hook (handled inside the helper).
    recordHookTelemetry(opts, connector, evt, response);

    const reply = adapter.formatReply(event, response);
    return {
      exitCode: reply.exitCode,
      ...(reply.stdout !== undefined ? { stdout: reply.stdout } : {}),
      ...(reply.stderr !== undefined ? { stderr: reply.stderr } : {}),
    };
  } catch (err) {
    // Fail-open: a framework/handler error must not wedge the host's tool call.
    // The ONE exception is a PreToolUse deny — a deliberate block we honor even
    // if a later step threw. We re-derive that decision defensively from the
    // adapter so a throw AFTER the deny still surfaces it.
    const message = err instanceof Error ? err.message : String(err);
    log.error(`hook ${platformId}/${event} (${connectorId}) failed:`, message);
    return failOpenOrPreserveDeny(opts, message);
  }
}

/**
 * Error path. Returns fail-open allow, UNLESS this is a PreToolUse event whose
 * handler explicitly denied — in which case the deny is reconstructed and
 * preserved (a security decision is never silently downgraded to allow).
 *
 * Best-effort: if anything in the deny reconstruction itself throws, we fall
 * back to allow (we never escalate an error into a spurious block).
 */
async function failOpenOrPreserveDeny(
  opts: RunHookOptions,
  errorMessage: string,
): Promise<RunHookResult> {
  if (opts.event !== "PreToolUse") return ALLOW;
  try {
    const connector = await loadRegisteredConnector(opts.connectorId);
    const adapter = await loadAdapter(opts.platformId);
    if (!adapter?.parseEvent || !adapter.formatReply) return ALLOW;

    const definition = connector.hooks.PreToolUse;
    if (!definition || typeof definition.handler !== "function") return ALLOW;

    const raw = parseStdin(opts.stdin);
    const evt = adapter.parseEvent("PreToolUse", raw);
    evt.connectorId = opts.connectorId;

    const toolName = eventToolName(evt);
    if (toolName !== undefined) {
      const re = compileMatcher(definition.matcher);
      if (re && !re.test(toolName)) return ALLOW;
    }

    const response = normalizeResponse(await definition.handler(evt as never));
    if (response.decision !== "deny") return ALLOW;

    const reply = adapter.formatReply("PreToolUse", response);
    return {
      exitCode: reply.exitCode,
      ...(reply.stdout !== undefined ? { stdout: reply.stdout } : {}),
      ...(reply.stderr !== undefined
        ? { stderr: reply.stderr }
        : { stderr: errorMessage }),
    };
  } catch {
    // Reconstruction failed — never escalate an internal error into a block.
    return ALLOW;
  }
}
