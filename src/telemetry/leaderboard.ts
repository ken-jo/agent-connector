/**
 * telemetry/leaderboard — the PLUGIN / MCP leaderboard, derived from the per-MCP
 * serve-proxy telemetry store (src/telemetry/*).
 *
 * This is the signature MCP-dev metric: of the MCP servers WE wrap, which one
 * costs the most tokens — platform-independent, because it measures the server's
 * OWN bytes (tool args in, tool result out, tool-defs schemas) tokenized locally,
 * the only signal identical across every host. Origin is always `mcp-self`; it is
 * NEVER summed with host-native usage (src/usage/*), which measures a different
 * thing (whole-conversation tokens).
 *
 * Pure aggregation + pure formatting over {@link TelemetryStore.query}. The scope
 * dimension (installScope/launchMethod) is OPTIONAL on each row — rows written
 * before those fields existed are read as "unknown" and are honestly labeled.
 */

import type { ResolvedConnector } from "../core/types.js";
import { openStore } from "./store.js";
import { computeSurfaceFootprints } from "./surface-footprint.js";
import { worstConfidence } from "./types.js";
import type {
  ConfidenceSource,
  LaunchMethod,
  QueryFilter,
  SurfaceKind,
  TelemetryInstallScope,
  TelemetryStore,
  ToolEventRecord,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────
// Options + scope filter
// ─────────────────────────────────────────────────────────────────────────

/**
 * A scope filter value the leaderboards accept. The two install buckets
 * (`user`/`project`) and the launch methods (`npx`/`bunx`/`uvx`/`node`/`binary`/
 * `http`) plus the honest `unknown` fallback. A record matches a `user`/`project`
 * value by its `installScope`, and a launch-method value by its `launchMethod`.
 */
export type ScopeFilter =
  | TelemetryInstallScope
  | LaunchMethod;

/** Every accepted {@link ScopeFilter} string, for CLI validation. */
export const SCOPE_FILTER_VALUES: readonly ScopeFilter[] = [
  "user",
  "project",
  "npx",
  "bunx",
  "uvx",
  "node",
  "binary",
  "http",
  "unknown",
] as const;

/** Options shared by every leaderboard query. */
export interface LeaderboardOptions {
  /** An open store to read from. Defaults to {@link openStore} on the data-root. */
  store?: TelemetryStore;
  /** Lower-bound epoch ms (inclusive) — forwarded as the store's sinceMs filter. */
  sinceMs?: number;
  /** Restrict to one connector. */
  connectorId?: string;
  /** Slice by install scope (user|project) or launch method (npx|binary|http|…). */
  scope?: ScopeFilter;
}

/** Is `value` one of the accepted scope-filter strings? */
export function isScopeFilter(value: string): value is ScopeFilter {
  return (SCOPE_FILTER_VALUES as readonly string[]).includes(value);
}

/** The install/launch values a `user`/`project` scope filter matches against. */
const INSTALL_SCOPES: ReadonlySet<string> = new Set<string>(["user", "project"]);

/**
 * Does a record satisfy the requested scope slice? `user`/`project` match the
 * record's `installScope`; any concrete launch method matches the record's
 * `launchMethod`. The honest `unknown` filter is special: it matches ONLY a
 * record that lacks BOTH dimensions (a truly pre-scope row) — a record carrying
 * a known installScope but no launchMethod (or vice-versa) is NOT "unknown" and
 * must not be swept into that bucket.
 */
function matchesScope(record: ToolEventRecord, scope: ScopeFilter): boolean {
  if (scope === "unknown") {
    return record.installScope === undefined && record.launchMethod === undefined;
  }
  if (INSTALL_SCOPES.has(scope)) {
    return record.installScope === scope;
  }
  return record.launchMethod === scope;
}

/** Build the store {@link QueryFilter} from the shared options. */
function toFilter(opts: LeaderboardOptions): QueryFilter {
  const filter: QueryFilter = {};
  if (opts.sinceMs !== undefined) filter.sinceMs = opts.sinceMs;
  if (opts.connectorId !== undefined && opts.connectorId !== "") {
    filter.connectorId = opts.connectorId;
  }
  return filter;
}

/**
 * Query the store and apply the (in-memory) scope slice the store cannot. By
 * default EXCLUDES the host-native `model_turn` rows: this selector feeds the
 * per-MCP/plugin views (mcp/tool/scope), which measure per-MCP `call` + the
 * `tool_defs` overhead and must NEVER sum the whole-conversation host-native
 * turns. Pass `includeModelTurn: true` to read those rows instead (used by
 * {@link hostNativeTurns}).
 */
function selectRecords(
  opts: LeaderboardOptions,
  includeModelTurn = false,
): ToolEventRecord[] {
  const store = opts.store ?? openStore({});
  const owned = opts.store === undefined;
  try {
    let rows = store.query(toFilter(opts));
    rows = includeModelTurn
      ? rows.filter((r) => r.scope === "model_turn")
      : rows.filter((r) => r.scope !== "model_turn");
    if (opts.scope === undefined) return rows;
    const scope = opts.scope;
    return rows.filter((r) => matchesScope(r, scope));
  } finally {
    if (owned) store.close();
  }
}

// Confidence ranking + worst-of comparison live in ./types (the single source
// of truth, imported as worstConfidence above) so a new ConfidenceSource value
// orders correctly here as well.

// ─────────────────────────────────────────────────────────────────────────
// Leaderboard rows
// ─────────────────────────────────────────────────────────────────────────

/**
 * One row of the MCP/plugin leaderboard — a connector ranked by total measured
 * tokens. `tools` is the count of distinct tool names seen (excluding the
 * tool-defs `*` pseudo-tool); `hostPlatforms` is the distinct set of hosts that
 * ran this server, evidence that the count aggregates across machines.
 */
export interface McpLeaderboardRow {
  connectorId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Count of distinct real tool names (the tool-defs `*` row is excluded). */
  tools: number;
  /** Distinct host platforms that produced records, sorted for stable output. */
  hostPlatforms: string[];
  /** Worst (least-confident) source in the group, for honest labeling. */
  confidence: ConfidenceSource;
  lastTs: number;
}

/**
 * One row of the per-tool leaderboard — a (connector, tool) pair ranked by total
 * measured tokens. The tool-defs pseudo-tool (`*`, scope `tool_defs`) is kept as
 * its own row so the fixed schema overhead is visible rather than hidden.
 */
export interface ToolLeaderboardRow {
  connectorId: string;
  toolName: string;
  /** "call" round-trips vs the one-time "tool_defs" overhead measurement. */
  scope: ToolEventRecord["scope"];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  confidence: ConfidenceSource;
  lastTs: number;
}

/**
 * One row of the scope breakdown — usage grouped by (installScope, launchMethod),
 * both honestly reported as "unknown" when the underlying record lacks the field.
 */
export interface ScopeBreakdownRow {
  installScope: TelemetryInstallScope | "unknown";
  launchMethod: LaunchMethod;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  confidence: ConfidenceSource;
  lastTs: number;
}

/**
 * One row of the host-native turns aggregation — a (host, session) pair ranked by
 * total host-reported tokens for that whole-conversation turn stream. This is the
 * THIRD origin (`host-native-live`): it comes from the opt-in AfterModel /
 * PostInvocation usage hook (scope `model_turn`, confidence `host-native`) and is
 * NEVER summed with the per-MCP `call` rows or the usage-reader host-scan numbers.
 */
export interface HostNativeTurnsRow {
  hostPlatform: string;
  sessionId: string;
  /** Number of recorded model turns (scope `model_turn` rows) in this group. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Distinct connector ids that produced turns under this host/session. */
  connectors: string[];
  confidence: ConfidenceSource;
  lastTs: number;
}

/** Mutable accumulator for the host-native turns fold (set finalized to count). */
interface HostNativeAcc {
  hostPlatform: string;
  sessionId: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  connectors: Set<string>;
  confidence: ConfidenceSource;
  lastTs: number;
}

/** Mutable accumulator for the MCP leaderboard fold (sets finalized to counts). */
interface McpAcc {
  connectorId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tools: Set<string>;
  hostPlatforms: Set<string>;
  confidence: ConfidenceSource;
  lastTs: number;
}

/**
 * The PLUGIN / MCP leaderboard: rank connectors by total measured tokens desc
 * (ties broken by recency). This is the headline "which MCP server costs the
 * most" metric, platform-independent by construction.
 */
export function mcpLeaderboard(opts: LeaderboardOptions = {}): McpLeaderboardRow[] {
  const groups = new Map<string, McpAcc>();

  for (const r of selectRecords(opts)) {
    let g = groups.get(r.connectorId);
    if (g === undefined) {
      g = {
        connectorId: r.connectorId,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        tools: new Set<string>(),
        hostPlatforms: new Set<string>(),
        confidence: r.confidenceSource,
        lastTs: r.ts,
      };
      groups.set(r.connectorId, g);
    }
    // A tool_defs row is a one-time schema overhead, not a call: count its
    // tokens but do not inflate the call count or the distinct-tool count.
    if (r.scope === "call") {
      g.calls += 1;
      g.tools.add(r.toolName);
    }
    g.inputTokens += r.inputTokens;
    g.outputTokens += r.outputTokens;
    g.totalTokens += r.inputTokens + r.outputTokens;
    g.hostPlatforms.add(r.hostPlatform);
    g.confidence = worstConfidence(g.confidence, r.confidenceSource);
    if (r.ts > g.lastTs) g.lastTs = r.ts;
  }

  const rows: McpLeaderboardRow[] = [];
  for (const g of groups.values()) {
    rows.push({
      connectorId: g.connectorId,
      calls: g.calls,
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      totalTokens: g.totalTokens,
      tools: g.tools.size,
      hostPlatforms: [...g.hostPlatforms].sort(),
      confidence: g.confidence,
      lastTs: g.lastTs,
    });
  }
  rows.sort((a, b) => b.totalTokens - a.totalTokens || b.lastTs - a.lastTs);
  return rows;
}

/**
 * The per-tool leaderboard: rank (connector, tool) pairs by total tokens desc
 * (ties broken by recency). Drills the MCP leaderboard down to which individual
 * tool is the expensive one.
 */
export function toolLeaderboard(opts: LeaderboardOptions = {}): ToolLeaderboardRow[] {
  const groups = new Map<string, ToolLeaderboardRow>();

  for (const r of selectRecords(opts)) {
    const key = `${r.connectorId} ${r.toolName} ${r.scope}`;
    const g = groups.get(key);
    if (g === undefined) {
      groups.set(key, {
        connectorId: r.connectorId,
        toolName: r.toolName,
        scope: r.scope,
        calls: r.scope === "call" ? 1 : 0,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        totalTokens: r.inputTokens + r.outputTokens,
        confidence: r.confidenceSource,
        lastTs: r.ts,
      });
    } else {
      if (r.scope === "call") g.calls += 1;
      g.inputTokens += r.inputTokens;
      g.outputTokens += r.outputTokens;
      g.totalTokens += r.inputTokens + r.outputTokens;
      g.confidence = worstConfidence(g.confidence, r.confidenceSource);
      if (r.ts > g.lastTs) g.lastTs = r.ts;
    }
  }

  const rows = [...groups.values()];
  rows.sort((a, b) => b.totalTokens - a.totalTokens || b.lastTs - a.lastTs);
  return rows;
}

/**
 * The scope breakdown: group usage by (installScope, launchMethod). Both
 * dimensions read "unknown" when the source row lacks the field, so a pre-scope
 * row is honestly bucketed rather than dropped or mis-attributed.
 */
export function scopeBreakdown(opts: LeaderboardOptions = {}): ScopeBreakdownRow[] {
  const groups = new Map<string, ScopeBreakdownRow>();

  for (const r of selectRecords(opts)) {
    const installScope: TelemetryInstallScope | "unknown" = r.installScope ?? "unknown";
    const launchMethod: LaunchMethod = r.launchMethod ?? "unknown";
    const key = `${installScope} ${launchMethod}`;
    const g = groups.get(key);
    if (g === undefined) {
      groups.set(key, {
        installScope,
        launchMethod,
        calls: r.scope === "call" ? 1 : 0,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        totalTokens: r.inputTokens + r.outputTokens,
        confidence: r.confidenceSource,
        lastTs: r.ts,
      });
    } else {
      if (r.scope === "call") g.calls += 1;
      g.inputTokens += r.inputTokens;
      g.outputTokens += r.outputTokens;
      g.totalTokens += r.inputTokens + r.outputTokens;
      g.confidence = worstConfidence(g.confidence, r.confidenceSource);
      if (r.ts > g.lastTs) g.lastTs = r.ts;
    }
  }

  const rows = [...groups.values()];
  rows.sort((a, b) => b.totalTokens - a.totalTokens || b.lastTs - a.lastTs);
  return rows;
}

/**
 * The THIRD origin: host-native turns. Aggregates ONLY the `model_turn` rows (the
 * opt-in AfterModel / PostInvocation host-native usage hook) by (host, session),
 * ranked by total host-reported tokens desc. This is whole-conversation usage the
 * host itself reported — exact, but a DIFFERENT thing than the per-MCP `call`
 * rows; it is surfaced separately and NEVER summed with the other two origins.
 */
export function hostNativeTurns(opts: LeaderboardOptions = {}): HostNativeTurnsRow[] {
  const groups = new Map<string, HostNativeAcc>();

  for (const r of selectRecords(opts, /* includeModelTurn */ true)) {
    const key = `${r.hostPlatform} ${r.sessionId}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = {
        hostPlatform: r.hostPlatform,
        sessionId: r.sessionId,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        connectors: new Set<string>(),
        confidence: r.confidenceSource,
        lastTs: r.ts,
      };
      groups.set(key, g);
    }
    g.turns += 1;
    g.inputTokens += r.inputTokens;
    g.outputTokens += r.outputTokens;
    g.totalTokens += r.inputTokens + r.outputTokens;
    g.connectors.add(r.connectorId);
    g.confidence = worstConfidence(g.confidence, r.confidenceSource);
    if (r.ts > g.lastTs) g.lastTs = r.ts;
  }

  const rows: HostNativeTurnsRow[] = [];
  for (const g of groups.values()) {
    rows.push({
      hostPlatform: g.hostPlatform,
      sessionId: g.sessionId,
      turns: g.turns,
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      totalTokens: g.totalTokens,
      connectors: [...g.connectors].sort(),
      confidence: g.confidence,
      lastTs: g.lastTs,
    });
  }
  rows.sort((a, b) => b.totalTokens - a.totalTokens || b.lastTs - a.lastTs);
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-surface leaderboard (the FIVE developer-axis surfaces)
// ─────────────────────────────────────────────────────────────────────────

/**
 * One row of the per-surface developer breakdown — a (surfaceKind, name) pair.
 * Combines the RUNTIME-measured surfaces (server `call`+`tool_defs` rows and the
 * new `hook` rows from the telemetry store) with the STATIC content footprints
 * (command/skill/subagent) from {@link computeSurfaceFootprints}.
 *
 *   • `kind` distinguishes RUNTIME (measured live) from STATIC (footprint of
 *     context the host loads — never an intercepted usage row).
 *   • For static rows `calls` is 0, `outputTokens` is 0, the cost sits in
 *     `inputTokens`/`totalTokens`, and `confidence` is the tokenizer source for
 *     the connector's family. For runtime rows everything aggregates the store.
 */
export interface SurfaceLeaderboardRow {
  surfaceKind: SurfaceKind;
  /** Per-item name: the tool name (server), the event name (hook), or the
   *  command/skill/subagent name (static surfaces). */
  name: string;
  /** RUNTIME (server/hook store rows) vs STATIC (command/skill/subagent footprint). */
  kind: "runtime" | "static";
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  confidence: ConfidenceSource;
  lastTs: number;
}

/** Mutable accumulator for the runtime side of the per-surface fold. */
interface SurfaceAcc {
  surfaceKind: SurfaceKind;
  name: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  confidence: ConfidenceSource;
  lastTs: number;
}

/**
 * A record's developer-axis surface kind, backward-compatibly. Rows written
 * before `surfaceKind` existed (every legacy serve-proxy `call`/`tool_defs` row)
 * lack it and are read as `server`; the `hook` runtime stamps it explicitly.
 */
function recordSurfaceKind(r: ToolEventRecord): SurfaceKind {
  if (r.surfaceKind !== undefined) return r.surfaceKind;
  // No explicit kind → it predates this field → it is a serve-proxy server row.
  return "server";
}

/** Options for {@link surfaceLeaderboard}: the shared query opts + the connectors
 *  whose STATIC footprints are folded in. */
export interface SurfaceLeaderboardOptions extends LeaderboardOptions {
  /** Registered connectors to compute static command/skill/subagent footprints
   *  over. Omit/empty → only the runtime (server/hook) rows are reported. */
  connectors?: readonly ResolvedConnector[];
}

/**
 * The PER-SURFACE developer leaderboard across all FIVE surfaces.
 *
 * RUNTIME side: the store's `call`/`tool_defs` rows (surface `server`) and the
 * `hook` rows (surface `hook`), grouped by (surfaceKind, name) with IN/OUT/TOTAL
 * and a call count. (`model_turn` rows are excluded by `selectRecords`, exactly
 * as the per-MCP views exclude them.)
 *
 * STATIC side: one row per command/skill/subagent from
 * {@link computeSurfaceFootprints} over each passed connector, deduped by
 * (surfaceKind, name) and summed when the same surface is declared by more than
 * one connector. Static rows carry the footprint in `inputTokens` (the cost the
 * host pays to load that context); `outputTokens`/`calls` are 0.
 *
 * Sorted by total tokens desc, ties broken by recency (static rows have lastTs 0
 * so they sort after equal-token runtime rows).
 */
export function surfaceLeaderboard(
  opts: SurfaceLeaderboardOptions = {},
): SurfaceLeaderboardRow[] {
  // ── RUNTIME: aggregate server + hook store rows by (surfaceKind, name) ──
  const runtime = new Map<string, SurfaceAcc>();
  for (const r of selectRecords(opts)) {
    const surfaceKind = recordSurfaceKind(r);
    const key = `${surfaceKind} ${r.toolName}`;
    let g = runtime.get(key);
    if (g === undefined) {
      g = {
        surfaceKind,
        name: r.toolName,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        confidence: r.confidenceSource,
        lastTs: r.ts,
      };
      runtime.set(key, g);
    }
    // tool_defs is a one-time schema overhead, not a call — count tokens only.
    if (r.scope === "call" || r.scope === "hook") g.calls += 1;
    g.inputTokens += r.inputTokens;
    g.outputTokens += r.outputTokens;
    g.totalTokens += r.inputTokens + r.outputTokens;
    g.confidence = worstConfidence(g.confidence, r.confidenceSource);
    if (r.ts > g.lastTs) g.lastTs = r.ts;
  }

  const rows: SurfaceLeaderboardRow[] = [];
  for (const g of runtime.values()) {
    rows.push({
      surfaceKind: g.surfaceKind,
      name: g.name,
      kind: "runtime",
      calls: g.calls,
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      totalTokens: g.totalTokens,
      confidence: g.confidence,
      lastTs: g.lastTs,
    });
  }

  // ── STATIC: fold in command/skill/subagent footprints per connector ──────
  const staticRows = new Map<
    string,
    { surfaceKind: SurfaceKind; name: string; tokens: number }
  >();
  for (const connector of opts.connectors ?? []) {
    for (const fp of computeSurfaceFootprints(connector)) {
      const key = `${fp.surfaceKind} ${fp.name}`;
      const existing = staticRows.get(key);
      if (existing === undefined) {
        staticRows.set(key, { surfaceKind: fp.surfaceKind, name: fp.name, tokens: fp.tokens });
      } else {
        existing.tokens += fp.tokens;
      }
    }
  }
  // A pure tokenizer footprint carries no host-reported truth — label it with the
  // tokenizer source the connector's family would yield. We derive that once via
  // a throwaway count so the static confidence is honest (approx vs exact).
  const staticConfidence: ConfidenceSource = staticFootprintConfidence(opts.connectors ?? []);
  for (const s of staticRows.values()) {
    rows.push({
      surfaceKind: s.surfaceKind,
      name: s.name,
      kind: "static",
      calls: 0,
      inputTokens: s.tokens,
      outputTokens: 0,
      totalTokens: s.tokens,
      confidence: staticConfidence,
      lastTs: 0,
    });
  }

  rows.sort((a, b) => b.totalTokens - a.totalTokens || b.lastTs - a.lastTs);
  return rows;
}

/**
 * The confidence label for the static footprints: the tokenizer source for the
 * first connector's family (exact for openai, approx otherwise). Defaults to
 * `tokenizer-approx` when no connector is supplied — an honest estimate label.
 */
function staticFootprintConfidence(
  connectors: readonly ResolvedConnector[],
): ConfidenceSource {
  const first = connectors[0];
  if (first === undefined) return "tokenizer-approx";
  // openai family → exact BPE; everything else → approx. Mirrors tokenizer.bpeSource.
  return first.telemetry.modelFamilyHint === "openai"
    ? "tokenizer-exact"
    : "tokenizer-approx";
}

// ─────────────────────────────────────────────────────────────────────────
// Formatting (mirrors telemetry/report.ts: aligned table + honesty legend)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Sources whose counts are estimates (vs real / host-reported numbers).
 * `tokenizer-calibrated` is still an estimate — an approximation nudged toward
 * truth by a sampled Anthropic count_tokens factor — so it belongs here too.
 */
const ESTIMATE_SOURCES: ReadonlySet<ConfidenceSource> = new Set<ConfidenceSource>([
  "heuristic",
  "tokenizer-approx",
  "tokenizer-calibrated",
]);

/** Compact integer formatting with thousands separators. */
function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Right-pad (left-aligned columns). */
function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Left-pad (right-aligned numeric columns). */
function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/**
 * Render an aligned table given headers, the data cells, and which columns are
 * left-aligned (text) vs right-aligned (numbers). Adds rule lines and a TOTAL
 * footer. Shared by every leaderboard formatter for one consistent style.
 */
function renderTable(
  headers: string[],
  dataRows: string[][],
  leftAlignedCols: ReadonlySet<number>,
  totalRow: string[],
  emptyMessage: string,
): string[] {
  const widths = headers.map((h, col) => {
    let w = h.length;
    for (const row of dataRows) w = Math.max(w, (row[col] ?? "").length);
    w = Math.max(w, (totalRow[col] ?? "").length);
    return w;
  });

  const renderRow = (cells: string[]): string =>
    cells
      .map((c, col) =>
        leftAlignedCols.has(col)
          ? padRight(c, widths[col] ?? 0)
          : padLeft(c, widths[col] ?? 0),
      )
      .join("  ")
      .trimEnd();

  const ruleWidth = widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1);
  const rule = "-".repeat(ruleWidth);

  const lines: string[] = [];
  lines.push(renderRow(headers));
  lines.push(rule);
  if (dataRows.length === 0) {
    lines.push(emptyMessage);
  } else {
    for (const row of dataRows) lines.push(renderRow(row));
  }
  lines.push(rule);
  lines.push(renderRow(totalRow));
  return lines;
}

/** Append the estimate legend when any row carries an estimate confidence. */
function appendEstimateLegend(
  lines: string[],
  confidences: ConfidenceSource[],
): void {
  if (confidences.some((c) => ESTIMATE_SOURCES.has(c))) {
    lines.push("");
    lines.push(
      "note: heuristic and tokenizer-approx token counts are estimates, " +
        "not exact host-reported usage.",
    );
    if (confidences.some((c) => c === "tokenizer-calibrated")) {
      lines.push(
        "note: tokenizer-calibrated = local approx adjusted by a sampled " +
          "Anthropic count_tokens factor (opt-in; content sampled off-box only " +
          "when AGENT_CONNECTOR_CALIBRATE=anthropic).",
      );
    }
  }
}

/**
 * Format the MCP/plugin leaderboard as an aligned table:
 *   RANK | CONNECTOR | CALLS | TOOLS | IN | OUT | TOTAL | HOSTS | CONFIDENCE
 * sorted by total tokens desc, with a TOTAL footer and the honesty legend.
 */
export function formatMcpLeaderboard(rows: McpLeaderboardRow[]): string {
  const sorted = [...rows].sort(
    (a, b) => b.totalTokens - a.totalTokens || b.lastTs - a.lastTs,
  );
  const headers = [
    "RANK",
    "CONNECTOR",
    "CALLS",
    "TOOLS",
    "IN",
    "OUT",
    "TOTAL",
    "HOSTS",
    "CONFIDENCE",
  ];
  const dataRows = sorted.map((r, i) => [
    `${i + 1}`,
    r.connectorId,
    fmtInt(r.calls),
    fmtInt(r.tools),
    fmtInt(r.inputTokens),
    fmtInt(r.outputTokens),
    fmtInt(r.totalTokens),
    r.hostPlatforms.length === 0 ? "-" : r.hostPlatforms.join(","),
    r.confidence,
  ]);

  const totals = sorted.reduce(
    (acc, r) => {
      acc.calls += r.calls;
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.totalTokens += r.totalTokens;
      return acc;
    },
    { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  const totalRow = [
    "",
    "TOTAL",
    fmtInt(totals.calls),
    "",
    fmtInt(totals.inputTokens),
    fmtInt(totals.outputTokens),
    fmtInt(totals.totalTokens),
    "",
    "",
  ];

  // Left-align RANK (0), CONNECTOR (1), HOSTS (7), CONFIDENCE (8); numbers right.
  const leftCols = new Set<number>([0, 1, 7, 8]);
  const lines = renderTable(
    headers,
    dataRows,
    leftCols,
    totalRow,
    "(no MCP telemetry recorded)",
  );
  appendEstimateLegend(
    lines,
    sorted.map((r) => r.confidence),
  );
  return lines.join("\n");
}

/**
 * Format the per-tool leaderboard:
 *   RANK | CONNECTOR | TOOL | SCOPE | CALLS | IN | OUT | TOTAL | CONFIDENCE
 * sorted by total tokens desc, with a TOTAL footer and the honesty legend.
 */
export function formatToolLeaderboard(rows: ToolLeaderboardRow[]): string {
  const sorted = [...rows].sort(
    (a, b) => b.totalTokens - a.totalTokens || b.lastTs - a.lastTs,
  );
  const headers = [
    "RANK",
    "CONNECTOR",
    "TOOL",
    "SCOPE",
    "CALLS",
    "IN",
    "OUT",
    "TOTAL",
    "CONFIDENCE",
  ];
  const dataRows = sorted.map((r, i) => [
    `${i + 1}`,
    r.connectorId,
    r.toolName,
    r.scope,
    fmtInt(r.calls),
    fmtInt(r.inputTokens),
    fmtInt(r.outputTokens),
    fmtInt(r.totalTokens),
    r.confidence,
  ]);

  const totals = sorted.reduce(
    (acc, r) => {
      acc.calls += r.calls;
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.totalTokens += r.totalTokens;
      return acc;
    },
    { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  const totalRow = [
    "",
    "TOTAL",
    "",
    "",
    fmtInt(totals.calls),
    fmtInt(totals.inputTokens),
    fmtInt(totals.outputTokens),
    fmtInt(totals.totalTokens),
    "",
  ];

  // Left-align RANK (0), CONNECTOR (1), TOOL (2), SCOPE (3), CONFIDENCE (8).
  const leftCols = new Set<number>([0, 1, 2, 3, 8]);
  const lines = renderTable(
    headers,
    dataRows,
    leftCols,
    totalRow,
    "(no MCP telemetry recorded)",
  );
  appendEstimateLegend(
    lines,
    sorted.map((r) => r.confidence),
  );
  return lines.join("\n");
}

/**
 * Format the scope breakdown:
 *   INSTALL | LAUNCH | CALLS | IN | OUT | TOTAL | CONFIDENCE
 * with a TOTAL footer and the honesty legend.
 */
export function formatScopeBreakdown(rows: ScopeBreakdownRow[]): string {
  const sorted = [...rows].sort(
    (a, b) => b.totalTokens - a.totalTokens || b.lastTs - a.lastTs,
  );
  const headers = ["INSTALL", "LAUNCH", "CALLS", "IN", "OUT", "TOTAL", "CONFIDENCE"];
  const dataRows = sorted.map((r) => [
    r.installScope,
    r.launchMethod,
    fmtInt(r.calls),
    fmtInt(r.inputTokens),
    fmtInt(r.outputTokens),
    fmtInt(r.totalTokens),
    r.confidence,
  ]);

  const totals = sorted.reduce(
    (acc, r) => {
      acc.calls += r.calls;
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.totalTokens += r.totalTokens;
      return acc;
    },
    { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  const totalRow = [
    "TOTAL",
    "",
    fmtInt(totals.calls),
    fmtInt(totals.inputTokens),
    fmtInt(totals.outputTokens),
    fmtInt(totals.totalTokens),
    "",
  ];

  // Left-align INSTALL (0), LAUNCH (1), CONFIDENCE (6); numbers right-aligned.
  const leftCols = new Set<number>([0, 1, 6]);
  const lines = renderTable(
    headers,
    dataRows,
    leftCols,
    totalRow,
    "(no MCP telemetry recorded)",
  );
  appendEstimateLegend(
    lines,
    sorted.map((r) => r.confidence),
  );
  return lines.join("\n");
}

/**
 * Format the host-native turns aggregation (the THIRD origin):
 *   RANK | HOST | SESSION | TURNS | IN | OUT | TOTAL | CONNECTORS | CONFIDENCE
 * sorted by total tokens desc, with a TOTAL footer. These are whole-conversation,
 * host-reported (exact) counts — a DIFFERENT thing than the per-MCP rows, so the
 * footer total is for THIS section alone and is never added to the others.
 */
export function formatHostNativeTurns(rows: HostNativeTurnsRow[]): string {
  const sorted = [...rows].sort(
    (a, b) => b.totalTokens - a.totalTokens || b.lastTs - a.lastTs,
  );
  const headers = [
    "RANK",
    "HOST",
    "SESSION",
    "TURNS",
    "IN",
    "OUT",
    "TOTAL",
    "CONNECTORS",
    "CONFIDENCE",
  ];
  const dataRows = sorted.map((r, i) => [
    `${i + 1}`,
    r.hostPlatform,
    r.sessionId === "" ? "-" : r.sessionId,
    fmtInt(r.turns),
    fmtInt(r.inputTokens),
    fmtInt(r.outputTokens),
    fmtInt(r.totalTokens),
    r.connectors.length === 0 ? "-" : r.connectors.join(","),
    r.confidence,
  ]);

  const totals = sorted.reduce(
    (acc, r) => {
      acc.turns += r.turns;
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.totalTokens += r.totalTokens;
      return acc;
    },
    { turns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  const totalRow = [
    "",
    "TOTAL",
    "",
    fmtInt(totals.turns),
    fmtInt(totals.inputTokens),
    fmtInt(totals.outputTokens),
    fmtInt(totals.totalTokens),
    "",
    "",
  ];

  // Left-align RANK (0), HOST (1), SESSION (2), CONNECTORS (7), CONFIDENCE (8).
  const leftCols = new Set<number>([0, 1, 2, 7, 8]);
  const lines = renderTable(
    headers,
    dataRows,
    leftCols,
    totalRow,
    "(no host-native turns recorded — enable opt-in host-native usage)",
  );
  return lines.join("\n");
}

/**
 * Format the per-surface developer breakdown:
 *   SURFACE | NAME | IN | OUT | TOTAL | KIND
 * one row per (surfaceKind, name) across all FIVE surfaces — server + hook
 * (runtime, measured from the store) and command/skill/subagent (static
 * footprints). Sorted by total tokens desc, with a TOTAL footer and the honesty
 * legend (static footprints + any estimate-confidence runtime rows).
 *
 * NOTE: the TOTAL footer sums BOTH runtime and static tokens for at-a-glance
 * scale; the KIND column keeps the distinction explicit so the two are never
 * silently conflated (runtime = live usage; static = context-load footprint).
 */
export function formatSurfaceLeaderboard(rows: SurfaceLeaderboardRow[]): string {
  const sorted = [...rows].sort(
    (a, b) => b.totalTokens - a.totalTokens || b.lastTs - a.lastTs,
  );
  const headers = ["SURFACE", "NAME", "IN", "OUT", "TOTAL", "KIND"];
  const dataRows = sorted.map((r) => [
    r.surfaceKind,
    r.name,
    fmtInt(r.inputTokens),
    fmtInt(r.outputTokens),
    fmtInt(r.totalTokens),
    r.kind,
  ]);

  const totals = sorted.reduce(
    (acc, r) => {
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.totalTokens += r.totalTokens;
      return acc;
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  const totalRow = [
    "TOTAL",
    "",
    fmtInt(totals.inputTokens),
    fmtInt(totals.outputTokens),
    fmtInt(totals.totalTokens),
    "",
  ];

  // Left-align SURFACE (0), NAME (1), KIND (5); numbers right-aligned.
  const leftCols = new Set<number>([0, 1, 5]);
  const lines = renderTable(
    headers,
    dataRows,
    leftCols,
    totalRow,
    "(no developer surfaces recorded)",
  );
  if (sorted.some((r) => r.kind === "static")) {
    lines.push("");
    lines.push(
      "note: KIND=static rows are the tokenized FOOTPRINT a command/skill/subagent " +
        "imposes on a host that loads it as context — not intercepted usage rows.",
    );
  }
  appendEstimateLegend(
    lines,
    sorted.map((r) => r.confidence),
  );
  return lines.join("\n");
}
