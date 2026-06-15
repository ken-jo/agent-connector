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
 * event is PreToolUse or PermissionRequest and the handler explicitly denied,
 * in which case the deny (a deliberate security decision) is preserved rather
 * than swallowed.
 */

import type {
  HookEventName,
  HookResponse,
  NativeHookDef,
  NativeHookEvent,
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

/**
 * The string a connector matcher filters on, when the event carries one:
 * tool events (PreToolUse / PostToolUse / PermissionRequest /
 * PostToolUseFailure) expose `toolName`; subagent events expose `agentType`.
 * Returns undefined when the event has neither (no filtering) — including a
 * SubagentStop arriving WITHOUT agent_type, which some hosts fail to populate;
 * filtering out such an event would silently drop a real stop, so we run the
 * handler instead (fail-open).
 */
export function eventMatcherSubject(evt: NormalizedEvent): string | undefined {
  const name = (evt as { toolName?: unknown }).toolName;
  if (typeof name === "string") return name;
  const agentType = (evt as { agentType?: unknown }).agentType;
  if (typeof agentType === "string") return agentType;
  return undefined;
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
export function compileMatcher(matcher: string | undefined): RegExp | null {
  if (!matcher || matcher === "") return null;
  try {
    return new RegExp(matcher);
  } catch {
    return null;
  }
}

/**
 * Normalize a handler return into a concrete HookResponse. A void/non-object
 * return becomes `{}` — NO decision — which every adapter formats as
 * pass-through allow (`response.decision ?? "allow"`). Deliberately NOT
 * `{decision:"allow"}`: on PermissionRequest an explicit "allow" is an ACTIVE
 * grant that suppresses the host's permission dialog, and a handler that
 * returns nothing must fall through to the dialog, never silently grant.
 */
function normalizeResponse(value: HookResponse | void): HookResponse {
  if (value == null || typeof value !== "object") return {};
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
  evt: NormalizedEvent | NativeHookEvent,
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
 * input  = the inbound event payload the handler reads (normalized event, or
 *          the {@link NativeHookEvent} envelope for native passthrough hooks);
 * output = what the handler returned (a normalized {@link HookResponse}, or the
 *          verbatim native reply object). Tokenized with the SAME tokenizer the
 *          proxy uses. For a native hook `opts.event` is the host-native name.
 *
 * MUST be fail-open (the hook runtime is fail-open by contract): any error here
 * is swallowed so a measurement bug can NEVER break a host's hook. Honors the
 * AGENT_CONNECTOR_TELEMETRY=0 kill switch (skips entirely; the store's append is
 * already a no-op under it, but we also skip the tokenize work).
 */
function recordHookTelemetry(
  opts: { platformId: string; event: string; connectorId: string },
  connector: ResolvedConnector,
  evt: NormalizedEvent | NativeHookEvent,
  response: unknown,
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

    // Matcher: if set and the event's subject (tool name, or agent type for
    // Subagent* events) does not match, allow (the hook is simply not
    // interested in this tool/agent).
    const subject = eventMatcherSubject(evt);
    if (subject !== undefined) {
      const re = compileMatcher(definition.matcher);
      if (re && !re.test(subject)) return ALLOW;
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
    // The ONE exception is a PreToolUse / PermissionRequest deny — a deliberate
    // block we honor even if a later step threw. We re-derive that decision
    // defensively from the adapter so a throw AFTER the deny still surfaces it.
    const message = err instanceof Error ? err.message : String(err);
    log.error(`hook ${platformId}/${event} (${connectorId}) failed:`, message);
    return failOpenOrPreserveDeny(opts, message);
  }
}

/**
 * Events whose explicit deny survives the fail-open error path. Both are
 * permission gates — a deny there is a deliberate security decision that must
 * never be silently downgraded to allow. (Stop-class denies are persistence
 * conveniences, not security boundaries, so they stay fail-open.)
 */
const DENY_PRESERVE_EVENTS: ReadonlySet<HookEventName> = new Set([
  "PreToolUse",
  "PermissionRequest",
]);

/**
 * Error path. Returns fail-open allow, UNLESS this is a deny-preserving event
 * (PreToolUse / PermissionRequest) whose handler explicitly denied — in which
 * case the deny is reconstructed and preserved (a security decision is never
 * silently downgraded to allow).
 *
 * Best-effort: if anything in the deny reconstruction itself throws, we fall
 * back to allow (we never escalate an error into a spurious block).
 */
async function failOpenOrPreserveDeny(
  opts: RunHookOptions,
  errorMessage: string,
): Promise<RunHookResult> {
  if (!DENY_PRESERVE_EVENTS.has(opts.event)) return ALLOW;
  try {
    const connector = await loadRegisteredConnector(opts.connectorId);
    const adapter = await loadAdapter(opts.platformId);
    if (!adapter?.parseEvent || !adapter.formatReply) return ALLOW;

    const definition = connector.hooks[opts.event];
    if (!definition || typeof definition.handler !== "function") return ALLOW;

    const raw = parseStdin(opts.stdin);
    const evt = adapter.parseEvent(opts.event, raw);
    evt.connectorId = opts.connectorId;

    const subject = eventMatcherSubject(evt);
    if (subject !== undefined) {
      const re = compileMatcher(definition.matcher);
      if (re && !re.test(subject)) return ALLOW;
    }

    const response = normalizeResponse(await definition.handler(evt as never));
    if (response.decision !== "deny") return ALLOW;

    const reply = adapter.formatReply(opts.event, response);
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

// ─────────────────────────────────────────────────────────────────────────
// Native (passthrough) hooks — host events OUTSIDE the normalized union
// ─────────────────────────────────────────────────────────────────────────

/** Flags + stdin for {@link runNativeHook}. `event` is HOST-NATIVE (non-union). */
export interface RunNativeHookOptions {
  /** Host platform id from the hook command (`hook <platformId> ...`). */
  platformId: string;
  /** Host-native event name, verbatim (e.g. "TaskCreated"). */
  event: string;
  /** Connector id from `--connector <id>`. */
  connectorId: string;
  /** Raw stdin payload (host-native JSON). Empty string is tolerated → `{}`. */
  stdin: string;
}

/** The connector's native hook definition for `platformId`/`event`, if any. */
function nativeHookDef(
  connector: ResolvedConnector,
  platformId: string,
  event: string,
): NativeHookDef | undefined {
  return connector.platforms[platformId as PlatformId]?.nativeHooks?.[event];
}

/**
 * True when the registered connector declares `event` under
 * `platforms[platformId].nativeHooks` with a live handler. Used by the hook CLI
 * to decide whether a non-union event name is accepted (declared → dispatch via
 * {@link runNativeHook}) or rejected with the strict unknown-event error.
 * Fail-safe: any load error reads as "not declared".
 */
export async function isNativeHookDeclared(
  platformId: string,
  event: string,
  connectorId: string,
): Promise<boolean> {
  try {
    const connector = await loadRegisteredConnector(connectorId);
    return typeof nativeHookDef(connector, platformId, event)?.handler === "function";
  } catch {
    return false;
  }
}

/**
 * Dispatch one NATIVE (passthrough) hook invocation. No normalized parse, no
 * HookResponse mapping, no runtime matcher evaluation (the host's own matcher
 * already filtered — the def's matcher string was written verbatim into the
 * host config at install):
 *
 *   stdin JSON → NativeHookEvent{raw} → handler → VERBATIM JSON stdout (exit 0).
 *
 * void/undefined return → exit 0 with no output. Fail-open: ANY throw degrades
 * to exit 0 with no output — exit-2 blocking semantics are not modeled in v1.
 * Telemetry: records the same scope:"hook" developer-axis row as normalized
 * hooks, with the NATIVE event name as the per-item name.
 */
export async function runNativeHook(
  opts: RunNativeHookOptions,
): Promise<RunHookResult> {
  const { platformId, event, connectorId, stdin } = opts;
  try {
    const connector = await loadRegisteredConnector(connectorId);
    const def = nativeHookDef(connector, platformId, event);
    if (!def || typeof def.handler !== "function") {
      // Not declared for this platform — nothing to do, allow.
      return ALLOW;
    }

    const raw = parseStdin(stdin);
    // Best-effort session/project extraction from the json-stdio common shape
    // (Claude Code: session_id / cwd). Everything else stays in `raw` untouched.
    const sessionId =
      typeof (raw as { session_id?: unknown })?.session_id === "string"
        ? (raw as { session_id: string }).session_id
        : "";
    const cwd = (raw as { cwd?: unknown })?.cwd;
    const evt: NativeHookEvent = {
      event,
      hostPlatform: REGISTERED_PLATFORM_IDS.has(platformId as PlatformId)
        ? (platformId as PlatformId)
        : "unknown",
      sessionId,
      ...(typeof cwd === "string" && cwd !== "" ? { projectDir: cwd } : {}),
      raw,
    };

    const result = await def.handler(evt);

    // Same scope:"hook" telemetry row as normalized hooks (fail-open inside).
    recordHookTelemetry(opts, connector, evt, result === undefined ? {} : result);

    if (result === undefined) return ALLOW; // void → exit 0, no output
    const json = JSON.stringify(result);
    // Non-JSON-serializable returns (functions/symbols) degrade to silence.
    if (json === undefined) return ALLOW;
    return { exitCode: 0, stdout: json };
  } catch (err) {
    // Fail-open, unconditionally: native hooks have no deny-preserve carve-out
    // (there is no normalized decision to reconstruct).
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      `native hook ${platformId}/${event} (${connectorId}) failed:`,
      message,
    );
    return ALLOW;
  }
}
