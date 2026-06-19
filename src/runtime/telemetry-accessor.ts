/**
 * runtime/telemetry-accessor — build the handler-facing {@link TelemetryAccessor}.
 *
 * Every runtime entrypoint (hook / statusline / action) stamps `ctx.telemetry`
 * (or `evt.telemetry`) with the accessor built here so a connector handler can
 * read ITS OWN recorded usage on demand (`await ctx.telemetry?.()`), without the
 * handler reaching into the telemetry store directly.
 *
 * The accessor is LAZY (it opens the store only when called) and DEFENSIVE:
 *   - AGENT_CONNECTOR_TELEMETRY=0 → resolves zeros without touching disk;
 *   - any read error → resolves zeros (NEVER throws into a handler — the hook
 *     runtime is fail-open, the statusline fail-safe, and even the action
 *     surface must not have a usage read crash an otherwise-fine run).
 *
 * COST: each accessor call, or the first read of a lazy `ctx.usage`, reads the
 * connector's telemetry file in full (the NDJSON store has no since/limit bound)
 * and linear-scans it. Cheap for normal stores, but a handler on a HOT path
 * should call it only when it needs usage.
 */

import type { TelemetryAccessor, TelemetryUsageSummary } from "../core/types.js";
import { openStore } from "../telemetry/store.js";

/** The empty summary returned when telemetry is off or a read fails. */
const ZERO: TelemetryUsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  calls: 0,
};

/**
 * Synchronously sum every stored row's inputTokens/outputTokens for the
 * connector and count rows (`calls`). Honors the AGENT_CONNECTOR_TELEMETRY=0
 * kill switch (zeros, no disk touch) and swallows any error (zeros).
 */
export function readTelemetryUsageSummary(connectorId: string): TelemetryUsageSummary {
  if (process.env.AGENT_CONNECTOR_TELEMETRY === "0") return { ...ZERO };
  try {
    const store = openStore({});
    try {
      let inputTokens = 0;
      let outputTokens = 0;
      let calls = 0;
      // COERCE each addend to a finite number: query() tolerates malformed
      // LINES but does not validate field shapes, so a legacy/hand-edited row
      // with a missing (→ NaN) or string (→ concat) token field must not
      // poison the summary's numeric contract. A non-finite token reads as 0.
      for (const row of store.query({ connectorId })) {
        inputTokens += Number.isFinite(row.inputTokens) ? row.inputTokens : 0;
        outputTokens += Number.isFinite(row.outputTokens) ? row.outputTokens : 0;
        calls += 1;
      }
      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        calls,
      };
    } finally {
      store.close();
    }
  } catch {
    // Never throw into a handler — a usage read failure resolves to zeros.
    return { ...ZERO };
  }
}

/**
 * Build a {@link TelemetryAccessor} bound to `connectorId`. The returned async
 * function uses {@link readTelemetryUsageSummary}; it never throws.
 */
export function buildTelemetryAccessor(connectorId: string): TelemetryAccessor {
  return async (): Promise<TelemetryUsageSummary> => {
    return readTelemetryUsageSummary(connectorId);
  };
}

/**
 * Install a cached lazy `usage` property on a statusline context. This preserves
 * synchronous `ctx.usage` reads for render functions without forcing every
 * status refresh to scan the telemetry store when the render never uses usage.
 */
export function attachLazyTelemetryUsage(
  ctx: { usage?: TelemetryUsageSummary },
  connectorId: string,
  read: (connectorId: string) => TelemetryUsageSummary = readTelemetryUsageSummary,
): void {
  let cached: TelemetryUsageSummary | undefined;
  let hasCached = false;

  Object.defineProperty(ctx, "usage", {
    configurable: true,
    enumerable: true,
    get() {
      if (!hasCached) {
        cached = read(connectorId);
        hasCached = true;
      }
      return cached;
    },
    set(value: TelemetryUsageSummary | undefined) {
      cached = value;
      hasCached = true;
    },
  });
}
