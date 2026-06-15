/**
 * sdk/test-harness — the SHIPPED, OFFLINE behavioral harness.
 *
 * Two read-only tools a connector author runs WITHOUT installing anything or
 * touching the host's filesystem:
 *
 *   • `explain(connector)` — the static per-host × per-DECLARED-surface matrix:
 *     for every registered host and every surface the connector actually ships,
 *     is it `native` (the host can honor it), `disabled` (the connector opted
 *     out for that host via `platforms[host].<surface> === false`), or
 *     `skip-warn` (the host cannot honor it → install would skip-warn)?
 *
 *   • `simulate(connector, opts)` — runs the REAL adapter parse → handler →
 *     format chain INLINE against a host-shaped raw payload and reports whether
 *     the host actually HONORS the connector's response (the trustworthy part:
 *     it surfaces the documented degradations, e.g. Codex silently dropping a
 *     UserPromptSubmit "context" injection that has no stdout path).
 *
 * It deliberately does NOT import the runtime entrypoints (runHook /
 * runStatusline) — those load the REGISTERED connector from disk and record
 * telemetry. The harness instead re-implements the tiny parse→handler→format
 * chain against the in-memory connector + the adapter, mirroring the runtime's
 * input tolerance (empty/malformed payload → `{}`) and its fail-safe envelope.
 */

import type {
  HookEventName,
  HookResponse,
  PlatformId,
  PlatformOverride,
  ResolvedConnector,
} from "../core/types.js";
import { allAdapters, loadAdapter } from "../adapters/registry.js";
import type { NormalizedEvent } from "../adapters/spi.js";
import {
  compileMatcher,
  eventMatcherSubject,
} from "../runtime/hook-entrypoint.js";
import type { SurfaceName } from "./introspect.js";
import { SURFACE_PREDICATES } from "./introspect.js";

// ─────────────────────────────────────────────────────────────────────────
// explain — the static per-host × per-declared-surface matrix
// ─────────────────────────────────────────────────────────────────────────

/** One cell of the {@link explain} matrix: a host × a declared surface. */
export interface ExplainRow {
  host: PlatformId;
  surface: SurfaceName;
  /**
   *  - "native"    — the host's capabilities pass the surface predicate.
   *  - "disabled"  — the connector opted out for this host
   *                  (`platforms[host].<surface> === false`).
   *  - "skip-warn" — the host cannot honor it; install would skip-warn.
   */
  support: "native" | "skip-warn" | "disabled";
  reason: string;
}

/**
 * The GLOBAL surfaces a connector declares (these apply to every host — only
 * declared surfaces get a matrix row). The two platform-scoped surfaces
 * (`configPatch` / `nativeHooks`) are deliberately EXCLUDED here: they are
 * declared under one specific `platforms[host]`, so each is added PER HOST in
 * {@link explain} (see {@link platformScopedSurfacesFor}) — adding them globally
 * would falsely promise a configPatch row on hosts that never declared it.
 */
function declaredGlobalSurfaces(connector: ResolvedConnector): SurfaceName[] {
  const out: SurfaceName[] = [];
  if (connector.server) out.push("server");
  if (Object.keys(connector.hooks).length > 0) out.push("hooks");
  if (connector.commands.length > 0) out.push("commands");
  if (connector.skills.length > 0) out.push("skills");
  if (connector.subagents.length > 0) out.push("subagents");
  if (connector.memory.length > 0) out.push("memory");
  if (connector.statusline) out.push("statusline");
  return out;
}

/**
 * The platform-scoped surfaces (`configPatch` / `nativeHooks`) THIS host
 * actually declares — keyed off the host's own `platforms[host]` override, so a
 * configPatch declared under claude-code never shows up as a row for codex.
 */
function platformScopedSurfacesFor(
  override: PlatformOverride | undefined,
): SurfaceName[] {
  const out: SurfaceName[] = [];
  if (!override) return out;
  if ((override.configPatch?.length ?? 0) > 0) out.push("configPatch");
  if (override.nativeHooks != null && Object.keys(override.nativeHooks).length > 0) {
    out.push("nativeHooks");
  }
  return out;
}

/**
 * Is the surface explicitly DISABLED for this host? Mirrors the per-host opt-out
 * the installer honors: a boolean-or-object surface override is "disabled" only
 * when set to the literal `false` (the object form is a tuning, not an opt-out).
 * `configPatch` / `nativeHooks` have no boolean opt-out form — declaring them is
 * the opt-in, so they are never "disabled".
 */
function isDisabledForHost(
  connector: ResolvedConnector,
  host: PlatformId,
  surface: SurfaceName,
): boolean {
  const override = connector.platforms[host];
  if (!override) return false;
  switch (surface) {
    case "server":
      return override.server === false;
    case "hooks":
      return override.hooks === false;
    case "commands":
      return override.commands === false;
    case "skills":
      return override.skills === false;
    case "subagents":
      return override.subagents === false;
    case "memory":
      return override.memory === false;
    case "statusline":
      return override.statusline === false;
    case "configPatch":
    case "nativeHooks":
      return false;
  }
}

/**
 * The static support matrix: every registered host × every surface the
 * connector declares. Rows are sorted by host then surface for stable output.
 * Pure read of the adapter capabilities — installs nothing, writes nothing.
 */
export async function explain(connector: ResolvedConnector): Promise<ExplainRow[]> {
  const globalSurfaces = declaredGlobalSurfaces(connector);
  const adapters = await allAdapters();
  const rows: ExplainRow[] = [];

  for (const adapter of adapters) {
    // Per-host surface set = the global surfaces every host gets a row for, plus
    // the platform-scoped surfaces THIS host actually declares (configPatch /
    // nativeHooks live under platforms[host], so they are host-local).
    const override = connector.platforms[adapter.id];
    const surfaces = [
      ...globalSurfaces,
      ...platformScopedSurfacesFor(override),
    ];
    for (const surface of surfaces) {
      if (isDisabledForHost(connector, adapter.id, surface)) {
        rows.push({
          host: adapter.id,
          surface,
          support: "disabled",
          reason: `connector opted out for ${adapter.id} (platforms.${adapter.id}.${surface} = false)`,
        });
        continue;
      }
      const native = SURFACE_PREDICATES[surface](adapter.capabilities);
      rows.push({
        host: adapter.id,
        surface,
        support: native ? "native" : "skip-warn",
        reason: explainReason(adapter.id, surface, native),
      });
    }
  }

  rows.sort((a, b) =>
    a.host === b.host ? a.surface.localeCompare(b.surface) : a.host.localeCompare(b.host),
  );
  return rows;
}

/**
 * The human-readable reason for a native/skip-warn cell. `server` is a special
 * case: the predicate is CAPABILITY-based (the host advertises ≥1 MCP
 * transport), but advertising a transport does NOT guarantee a writable
 * registration — e.g. jetbrains-copilot advertises stdio yet its installServer
 * skip-warns because MCP is managed in IDE settings. So the server reason states
 * the verdict is capability-based and registration may be host-managed, rather
 * than promising a write. (A precise per-adapter installServer dry-run is a
 * Phase-2 enhancement — until then this avoids over-promising.)
 */
function explainReason(host: PlatformId, surface: SurfaceName, native: boolean): string {
  if (surface === "server") {
    return native
      ? `${host} advertises an MCP transport (capability-based; registration may be host-managed)`
      : `${host} advertises no MCP transport; install skip-warns`;
  }
  return native
    ? `${host} natively supports ${surface}`
    : `${host} cannot honor ${surface}; install skip-warns`;
}

// ─────────────────────────────────────────────────────────────────────────
// simulate — the real adapter parse → handler → format chain, inline
// ─────────────────────────────────────────────────────────────────────────

/** What to drive through the harness: one host, one surface, one raw payload. */
export interface SimulateOptions {
  surface: "hooks" | "statusline";
  host: PlatformId | string;
  /** REQUIRED when `surface === "hooks"`: which normalized lifecycle event. */
  event?: HookEventName;
  /** The host-shaped RAW payload (what the host would pipe in on stdin). */
  input: unknown;
}

/** The harness verdict: did the host actually honor the connector's response? */
export interface SimulateResult {
  /** True when the host's native reply carries the connector's intent. */
  honored: boolean;
  /** The host-native stdout the adapter would emit (when there is one). */
  hostReply?: string;
  /** Human-readable why — names the documented degradation when honored:false. */
  reason: string;
}

/**
 * Tolerantly coerce the raw payload, mirroring the runtime's parseStdin: a
 * string is JSON-parsed (empty/malformed → `{}`); a nullish value → `{}`; any
 * other value (already-parsed object) is passed through untouched.
 */
function coerceInput(input: unknown): unknown {
  if (input == null) return {};
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      return {};
    }
  }
  return input;
}

/** Normalize a handler's return into a concrete response (void/non-object → `{}`). */
function normalizeResponse(value: HookResponse | void): HookResponse {
  if (value == null || typeof value !== "object") return {};
  return value;
}

/**
 * The decoded shape of a host's native hook reply on stdout. Every json-stdio
 * adapter writes a SUBSET of these fields (claude-code / codex share the
 * `hookSpecificOutput` envelope; Stop-class continuation uses the TOP-LEVEL
 * `decision:"block"`). We read the DECODED fields — never substring-match the
 * serialized JSON, which a path/newline/quote in the payload would break.
 */
interface ParsedReply {
  /** Top-level Stop-class continuation: {"decision":"block","reason"}. */
  decision?: unknown;
  reason?: unknown;
  /** Top-level Claude context channel (no adapter emits it yet; future-proofing). */
  systemMessage?: unknown;
  hookSpecificOutput?: {
    hookEventName?: unknown;
    additionalContext?: unknown;
    permissionDecision?: unknown;
    permissionDecisionReason?: unknown;
    updatedInput?: unknown;
    /** PermissionRequest nested envelope: decision:{behavior:"allow"|"deny", updatedInput?}. */
    decision?: { behavior?: unknown; updatedInput?: unknown };
  };
}

/**
 * Tolerantly decode a reply's stdout into {@link ParsedReply}. Empty / absent /
 * unparseable stdout is a legitimate "no payload" signal (the adapter wrote a
 * bare exit-0) → `undefined`, the honest "this decision had no stdout path"
 * verdict input.
 */
function parseReplyStdout(stdout: string | undefined): ParsedReply | undefined {
  if (stdout == null || stdout.trim() === "") return undefined;
  try {
    const value = JSON.parse(stdout);
    return value != null && typeof value === "object"
      ? (value as ParsedReply)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Structural deep-equal for plain JSON values (objects/arrays/primitives). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a == null || b == null) return false;
  if (typeof a !== "object") return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const x = a as unknown[];
    const y = b as unknown[];
    return x.length === y.length && x.every((v, i) => deepEqual(v, y[i]));
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const xk = Object.keys(x);
  const yk = Object.keys(y);
  return xk.length === yk.length && xk.every((k) => deepEqual(x[k], y[k]));
}

/**
 * Decide whether the host HONORED a decision-bearing response, judging the
 * PARSED reply against each adapter's ACTUAL (event, decision) contract — never
 * by substring-matching the serialized JSON. `allow`/no-decision is always
 * pass-through honored; every other decision is honored only when the decoded
 * reply carries that exact intent, and the verdict names the documented
 * degradation when it does not.
 */
function judgeHookHonor(
  host: string,
  event: HookEventName,
  response: HookResponse,
  stdout: string | undefined,
): { honored: boolean; reason: string } {
  const decision = response.decision;
  if (decision === undefined || decision === "allow") {
    return { honored: true, reason: "pass-through allow" };
  }

  const reply = parseReplyStdout(stdout);
  const hso = reply?.hookSpecificOutput;

  if (decision === "context") {
    // Honored only when the DECODED additionalContext equals what the handler
    // asked to inject (claude-code's hookSpecificOutput.additionalContext, or a
    // future top-level systemMessage). codex only emits this on
    // SessionStart/PostToolUse — every other event silently drops it.
    const want = response.additionalContext;
    const got = hso?.additionalContext ?? reply?.systemMessage;
    if (reply && got === want) {
      return { honored: true, reason: `${host} injects context on ${event}` };
    }
    return {
      honored: false,
      reason: `${host} drops context on ${event} (no stdout path)`,
    };
  }

  if (decision === "deny") {
    if (!reply) {
      return {
        honored: false,
        reason: `${host} drops deny on ${event} (deny not honored; fails open to allow)`,
      };
    }
    // A real block: PreToolUse's permissionDecision:"deny", or the
    // PermissionRequest nested decision.behavior:"deny".
    if (hso?.permissionDecision === "deny" || hso?.decision?.behavior === "deny") {
      return { honored: true, reason: `${host} blocks ${event}` };
    }
    // Stop-class continuation: top-level decision:"block" KEEPS the session /
    // subagent running (persistence) — the SEMANTIC OPPOSITE of a block. Honored
    // (the reply carried the intent), but the reason must not say "blocks".
    if (reply.decision === "block") {
      return {
        honored: true,
        reason: `${host} continues the session/subagent on ${event} (persistence) — NOT a block`,
      };
    }
    // SubagentStart / PostToolUseFailure DEGRADE a deny to a context note — the
    // spawn/failure is not actually blocked.
    if (hso?.additionalContext != null) {
      return {
        honored: false,
        reason: `${host} degrades deny to a context note on ${event}; spawn/failure not blocked`,
      };
    }
    return {
      honored: false,
      reason: `${host} drops deny on ${event} (deny not honored; fails open to allow)`,
    };
  }

  if (decision === "ask") {
    if (hso?.permissionDecision === "ask") {
      return { honored: true, reason: `${host} asks on ${event}` };
    }
    // On PermissionRequest, ask/void falls through to the host's NATIVE dialog
    // (the dialog IS the ask), which the adapter expresses as a bare exit-0.
    if (event === "PermissionRequest" && !reply) {
      return {
        honored: true,
        reason: `${host} shows the native confirmation dialog on ${event} (the ask)`,
      };
    }
    return {
      honored: false,
      reason: `${host} drops ask on ${event} (no ask path)`,
    };
  }

  // decision === "modify": honored only when the decoded updatedInput deep-equals
  // what the handler asked to write (hookSpecificOutput.updatedInput, or the
  // PermissionRequest nested decision.updatedInput).
  const wrote = hso?.updatedInput ?? hso?.decision?.updatedInput;
  if (reply && wrote !== undefined && deepEqual(wrote, response.updatedInput)) {
    return { honored: true, reason: `${host} rewrites tool input on ${event}` };
  }
  return {
    honored: false,
    reason: `${host} drops modify on ${event} (modify not honored)`,
  };
}

/**
 * Run the connector against ONE host-shaped payload through the REAL adapter
 * path and report whether the host honors the response. Self-contained (does not
 * touch the registered-connector loader or telemetry) and fail-safe: any throw
 * in the chain degrades to `honored:false` with the error message, never rejects.
 */
export async function simulate(
  connector: ResolvedConnector,
  opts: SimulateOptions,
): Promise<SimulateResult> {
  try {
    const adapter = await loadAdapter(opts.host);
    if (!adapter) {
      return { honored: false, reason: `unknown host "${opts.host}"` };
    }

    if (opts.surface === "statusline") {
      if (
        !(adapter.capabilities.supportsStatusline ?? false) ||
        !adapter.parseStatusInput ||
        !adapter.formatStatusOutput
      ) {
        return { honored: false, reason: `${opts.host} has no statusline surface` };
      }
      if (!connector.statusline || typeof connector.statusline.render !== "function") {
        return { honored: false, reason: "connector declares no statusline" };
      }
      const ctx = adapter.parseStatusInput(coerceInput(opts.input));
      ctx.connectorId = connector.id;
      const rendered = await connector.statusline.render(ctx);
      const line = rendered == null ? "" : String(rendered);
      const reply = adapter.formatStatusOutput(line);
      return {
        honored: true,
        ...(reply.stdout !== undefined ? { hostReply: reply.stdout } : {}),
        reason: "rendered",
      };
    }

    // surface === "hooks"
    const event = opts.event;
    if (!event) {
      return { honored: false, reason: "event is required when surface === \"hooks\"" };
    }
    if (!adapter.parseEvent || !adapter.formatReply) {
      return { honored: false, reason: `${opts.host} has no hook runtime (mcp-only)` };
    }

    const evt = adapter.parseEvent(event, coerceInput(opts.input));
    evt.connectorId = connector.id;

    const definition = connector.hooks[event];
    if (!definition || typeof definition.handler !== "function") {
      return { honored: false, reason: `connector declares no ${event} handler` };
    }

    // Matcher filtering, in lockstep with runHook: when the connector's matcher
    // is set and the event's subject (tool name, or agent type for Subagent*
    // events) does not match, the host never runs the handler — so the harness
    // must NOT run it either, and reports the (honored) exclusion. Reuses the
    // runtime helpers directly so the two stay byte-for-byte aligned.
    const subject = eventMatcherSubject(evt as NormalizedEvent);
    if (subject !== undefined) {
      const re = compileMatcher(definition.matcher);
      if (re && !re.test(subject)) {
        return {
          honored: true,
          reason: `matcher excludes ${subject} (handler not run)`,
        };
      }
    }

    const response = normalizeResponse(
      await definition.handler(evt as never),
    );
    const reply = adapter.formatReply(event, response);
    const verdict = judgeHookHonor(String(opts.host), event, response, reply.stdout);
    return {
      honored: verdict.honored,
      ...(reply.stdout !== undefined ? { hostReply: reply.stdout } : {}),
      reason: verdict.reason,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const verb = opts.surface === "statusline" ? "render" : "handler";
    return { honored: false, reason: `${verb} threw: ${message}` };
  }
}
