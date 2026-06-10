/**
 * usage/readers/trae — Trae / ByteDance AI IDE usage reader (SYNCED platform).
 *
 * Faithful port of tokscale sessions/trae.rs. Trae's per-session token usage
 * lives behind the Trae usage REST API; tokscale authenticates, paginates, and
 * caches the JSON responses under ~/.config/tokscale/trae-cache/. THIS reader
 * never authenticates and never calls that API — it only parses the cached
 * artifacts when a tokscale run has already produced them. Hence kind:"synced":
 *   - cache present  → parse the JSON array(s) and emit one record per session;
 *   - cache absent   → return [] (the scan layer notes "requires sync, skipped").
 *
 * Cache layout (per docs/research/usage-readers.json + design §3d):
 *   ~/.config/tokscale/trae-cache/sessions/usage-*.json   (cached API artifacts)
 *   ~/.config/tokscale/trae-cache/manifest.json           (sync bookkeeping — ignored here)
 * paths.ts resolves the cache dir (env override AGENTCONNECT_TOKSCALE_DIR
 * first, the tokscale ~/.config/tokscale default second). We walk for the
 * `usage-*.json` artifacts directly rather than reading the manifest: the
 * artifacts are self-describing and a manifest mismatch must never drop real data.
 *
 * Artifact format (mirrors parse_trae_file exactly): each file is a JSON array of
 * session objects. Per-session fields:
 *   model_name  — display name (may be "" for auto-mode);
 *   mode        — interaction mode (e.g. "Auto");
 *   session_id  — required; records without it cannot dedup correctly → dropped;
 *   usage_time  — epoch SECONDS, required & > 0 → ms = usage_time × 1000;
 *   dollar_float — cost in USD;
 *   extra_info  — { input_token, output_token, cache_read_token, cache_write_token }.
 *
 * Token math (port of parse_session): the API returns exact counts, so each
 * dimension maps straight through; reasoning is always 0 (Trae does not report
 * it). A row whose four token dimensions sum to 0 is skipped.
 *
 * Model / provider (port of normalize_trae_model + provider_for_model):
 *   - a known display name maps to a tiktoken-style id (e.g. "GPT-5.4" →
 *     "gpt-5.4", "Claude Sonnet 4.6" → "claude-sonnet-4.6"); an unknown name
 *     passes through verbatim;
 *   - an empty model_name (auto-mode) buckets under "trae-<mode>" (e.g.
 *     "trae-auto"); empty model AND empty mode → "trae-unknown" so the cost is
 *     still attributed instead of vanishing into an empty Model cell;
 *   - provider is inferred by substring on the display name: GPT→openai,
 *     Claude→anthropic, Gemini→google, GLM→zhipu, else "trae".
 *
 * Dedup (design §6 / §220): Trae's API returns cumulative deltas and overlapping
 * syncs can write the same (session_id, usage_time) into multiple artifacts —
 * latest-per-(session_id, usage_time) wins. The dedupKey is
 * `trae:{session_id}:{usage_time}`. Because the global aggregate backstop keeps
 * the FIRST occurrence per key, this reader collapses duplicates itself, keeping
 * the LAST artifact row seen per key (walk order), so the emitted set is already
 * unique and the global filter is a no-op. Confidence is "host-reported" — the
 * cached data carries real, exact host token counts (spec lists it as medium for
 * the source overall; the per-row provenance is host-reported).
 *
 * Overflow guard (port of the checked_mul in Rust): a crafted usage_time near
 * the safe-integer ceiling would overflow when multiplied by 1000 — reject the
 * record rather than emit a garbage timestamp.
 *
 * Fail-open: no cache dir → []; unreadable/malformed file → skipped; a session
 * missing session_id / usage_time, with non-positive or overflowing usage_time,
 * or with all-zero tokens → skipped. No project scope (account-level usage).
 */

import type { TokenBreakdown, UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { readJsonFile } from "../jsonl.js";
import { firstExistingRoot, walkFiles } from "../paths.js";

const PLATFORM_ID = "trae" as const;
const DEFAULT_PROVIDER = "trae";

/** Multiplying usage_time (s) by 1000 must stay a safe integer (port of checked_mul). */
const MAX_SAFE_USAGE_TIME_S = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

/** The fields we read off a cached Trae session object (everything optional / unknown). */
interface TraeSession {
  model_name?: unknown;
  mode?: unknown;
  session_id?: unknown;
  usage_time?: unknown;
  dollar_float?: unknown;
  extra_info?: {
    input_token?: unknown;
    output_token?: unknown;
    cache_read_token?: unknown;
    cache_write_token?: unknown;
  };
}

/**
 * Known mapping from Trae display names to tiktoken-style model ids (port of
 * normalize_trae_model). Unknown names fall through to the raw `model_name`
 * (mixed-case, space-separated) so a future model is still attributed.
 */
function normalizeTraeModel(name: string): string {
  switch (name) {
    case "GPT-5.4":
      return "gpt-5.4";
    case "GPT-5.3-Codex":
    case "GPT-5.3 Codex":
      return "gpt-5.3-codex";
    case "GPT-5.3":
      return "gpt-5.3";
    case "GPT-5.2-Codex":
    case "GPT-5.2 Codex":
      return "gpt-5.2-codex";
    case "GPT-5.2":
      return "gpt-5.2";
    case "GPT-5.1-Codex":
    case "GPT-5.1 Codex":
      return "gpt-5.1-codex";
    case "GPT-5.1":
      return "gpt-5.1";
    case "Gemini 3.1 Pro":
      return "gemini-3.1-pro";
    case "Gemini 3.1":
      return "gemini-3.1";
    case "GLM 5.1":
    case "GLM-5.1":
      return "glm-5.1";
    case "Claude Sonnet 4.6":
    case "Claude-Sonnet-4.6":
      return "claude-sonnet-4.6";
    case "Claude Sonnet 4.5":
    case "Claude-Sonnet-4.5":
      return "claude-sonnet-4.5";
    default:
      return name;
  }
}

/**
 * Infer the provider from the display name (port of provider_for_model).
 * Substring matching, first match wins; falls back to "trae". Trae-specific so it
 * does not route through normalize.ts inferProvider (which knows nothing of GLM).
 */
function providerForModel(name: string): string {
  if (name.includes("GPT") || name.includes("gpt")) return "openai";
  if (name.includes("Claude") || name.includes("claude")) return "anthropic";
  if (name.includes("Gemini") || name.includes("gemini")) return "google";
  if (name.includes("GLM") || name.includes("glm")) return "zhipu";
  return DEFAULT_PROVIDER;
}

/** Coerce an unknown to a non-negative integer (0 on absence/garbage). */
function toNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/** Coerce an unknown to a finite number (0 on absence/garbage) — for the cost field. */
function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Coerce an unknown to a positive integer epoch-seconds value, or null when it is
 * absent / non-positive / not an integer (port of the as_i64()? + ≤0 checks).
 */
function toUsageTimeSeconds(v: unknown): number | null {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") n = Number(v);
  else return null;
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n <= 0) return null;
  return n;
}

/** Parse one cached Trae session object into a usage record (port of parse_session). */
function parseSession(session: TraeSession): UsageRecord | null {
  const modelRaw = typeof session.model_name === "string" ? session.model_name : "";
  const mode = typeof session.mode === "string" ? session.mode : "";

  // Auto-mode sessions return model_name "" (the system picks a model per turn).
  // Bucket them under "trae-<mode>" so the cost is still attributed.
  let modelId: string;
  if (modelRaw !== "") modelId = normalizeTraeModel(modelRaw);
  else if (mode !== "") modelId = `trae-${mode.toLowerCase()}`;
  else modelId = "trae-unknown";

  // Provider is inferred from the raw display name (the model_id may already be a
  // bucket like "trae-auto"); fall back to the model_id when no raw name exists.
  const providerId = providerForModel(modelRaw !== "" ? modelRaw : modelId);

  // Records without a real session_id cannot be deduplicated correctly (every
  // "missing-id" record would collide on the same key); records without a
  // positive usage_time would land at epoch 0. Drop them rather than fabricating.
  const sessionId =
    typeof session.session_id === "string" && session.session_id !== "" ? session.session_id : null;
  if (sessionId === null) return null;

  const usageTime = toUsageTimeSeconds(session.usage_time);
  if (usageTime === null) return null;

  // Overflow guard: a crafted usage_time would overflow × 1000 → reject it.
  if (usageTime > MAX_SAFE_USAGE_TIME_S) return null;
  const ts = usageTime * 1000;

  const cost = toNumber(session.dollar_float);

  const extra = session.extra_info ?? {};
  const input = toNonNegInt(extra.input_token);
  const output = toNonNegInt(extra.output_token);
  const cacheRead = toNonNegInt(extra.cache_read_token);
  const cacheWrite = toNonNegInt(extra.cache_write_token);

  if (input + output + cacheRead + cacheWrite === 0) return null;

  const tokens: TokenBreakdown = emptyTokens();
  tokens.input = input;
  tokens.output = output;
  tokens.cacheRead = cacheRead;
  tokens.cacheWrite = cacheWrite;
  // reasoning stays 0 (Trae does not report it).

  return {
    platformId: PLATFORM_ID,
    modelId,
    providerId,
    sessionId,
    tokens,
    cost,
    ts,
    messageCount: 1,
    dedupKey: `trae:${sessionId}:${usageTime}`,
    confidence: "host-reported",
  };
}

/**
 * Parse one cached artifact file (a JSON array of sessions) into usage records
 * (port of parse_trae_file). A non-array / unreadable / malformed file yields [].
 */
function parseTraeFile(path: string): UsageRecord[] {
  const value = readJsonFile(path);
  if (!Array.isArray(value)) return [];

  const out: UsageRecord[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = parseSession(raw as TraeSession);
    if (record !== null) out.push(record);
  }
  return out;
}

/** The Trae synced usage reader singleton. */
const traeReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "synced",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    // The cache dir is ~/.config/tokscale/trae-cache (env override first).
    // Absent → [] so the scan layer reports "requires sync, skipped".
    const root = firstExistingRoot(PLATFORM_ID);
    if (root === undefined) return [];

    // Enumerate cached artifacts: sessions/usage-*.json (walkFiles recurses, so
    // a flat or nested layout both work). Match the artifact name shape.
    const files = walkFiles(root, (name) => {
      const lower = name.toLowerCase();
      return lower.startsWith("usage-") && lower.endsWith(".json");
    });

    // Trae returns cumulative deltas and overlapping syncs can repeat a
    // (session_id, usage_time) across artifacts — latest wins. Collapse to one
    // record per dedupKey, keeping the LAST seen (walk order), so the emitted set
    // is already unique (the global aggregate backstop keeps FIRST, not last).
    const byKey = new Map<string, UsageRecord>();
    for (const file of files) {
      for (const row of parseTraeFile(file)) {
        const key = row.dedupKey ?? `${row.sessionId}:${row.ts}`;
        byKey.set(key, row); // later artifact overwrites earlier → latest wins
      }
    }

    const records: UsageRecord[] = [];
    for (const row of byKey.values()) {
      if (sinceMs !== undefined && row.ts < sinceMs) continue;
      records.push(row);
    }
    return records;
  },
};

export default traeReader;
