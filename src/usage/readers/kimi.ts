/**
 * usage/readers/kimi — Moonshot native session-log reader (TWO products).
 *
 * Originally a faithful port of tokscale sessions/kimi.rs (origin of the Kimi
 * CLI wire parse), this reader now PARSES BOTH Moonshot products that share the
 * "kimi" platform id. They lay out their logs DIFFERENTLY *and* write a
 * different wire.jsonl record shape, so the parser auto-routes per line (a given
 * wire.jsonl is one product's format; no root-based branching is needed):
 *
 *   - Kimi CLI  (older, ~/.kimi):
 *       ~/.kimi/sessions/<GROUP_ID>/<SESSION_UUID>/wire.jsonl
 *       config.json sits at ~/.kimi/config.json. This is the tree tokscale's
 *       sessions/kimi.rs reads and the one this port was first written against.
 *       PARSE MODEL: progressive `message.type==="StatusUpdate"` snapshots,
 *       deduped by `payload.message_id` keeping the MAX total (see parseKimiFile).
 *
 *   - Kimi Code (newer, @moonshot-ai/kimi-code, ~/.kimi-code):
 *       ~/.kimi-code/sessions/<SESSION>/agents/<AGENT>/wire.jsonl
 *       config.json sits at ~/.kimi-code/config.json. This is a DEEPER tree (an
 *       extra `agents/<AGENT>/` level) — the product our connector adapter
 *       targets. The `~/.kimi-code` base + `$KIMI_CODE_HOME` override are
 *       primary-doc-confirmed (moonshotai.github.io/kimi-code/en/configuration/
 *       config-files.html), as is the `wire.jsonl` filename ("the agent event
 *       stream", moonshotai.github.io/kimi-code docs).
 *       PARSE MODEL: per-LLM-call usage DELTAS, SUMMED (see parseKimiCodeFile).
 *
 * Both default trees are scanned (Kimi Code preferred first); $KIMI_CODE_HOME
 * relocates the Kimi Code home and is honored ahead of the defaults; the
 * AGENT_CONNECTOR_KIMI_DIR override (via paths.ts hostRoots) is honored first.
 *
 * ─── Kimi CLI wire frame parse (port of tokscale sessions/kimi.rs) ───
 * Each line is a timestamped wire frame; only frames whose
 * `message.type === "StatusUpdate"` carry a `payload.token_usage` block:
 *   input_other          → input
 *   output               → output
 *   input_cache_read     → cacheRead
 *   input_cache_creation → cacheWrite  (cache CREATION cost, not a read)
 *   reasoning is always 0 (the wire protocol folds reasoning into output).
 * The first line (`{"type":"metadata", …}`) and every non-StatusUpdate frame
 * (TurnBegin / ContentPart / ToolCall / StepBegin …) are skipped. Zero-token
 * StatusUpdates are dropped.
 * DEDUP (the double-counting hazard): Kimi CLI emits PROGRESSIVE StatusUpdates
 * for a single assistant message as generation streams (e.g. message_id "msg-x"
 * at 100→10 tokens, then 120→30). We dedup by `payload.message_id`, keeping the
 * row with the MAX total tokens (tie-break: the later timestamp). Records
 * WITHOUT a (non-empty) message_id are never merged — each passes through as its
 * own row, exactly as the Rust push_or_replace_status_update does. The kept
 * row's `dedupKey` is its message_id (absent for un-keyed rows).
 *
 * ─── Kimi Code wire record parse (SOURCE-VERIFIED from MoonshotAI/kimi-code) ───
 * The on-disk usage record is `{ type:"usage.record", time?, model, usage,
 * usageScope? }` — verified against the readable (non-minified) TypeScript
 * source:
 *   - packages/agent-core/src/agent/records/types.ts → the wire.jsonl usage
 *     record shape `{ type:"usage.record", time?:number, model:string,
 *     usage:TokenUsage, usageScope?:"session"|"turn" }`.
 *   - packages/kosong/src/usage.ts → `TokenUsage = { inputOther, output,
 *     inputCacheRead, inputCacheCreation }` (camelCase; NO reasoning field).
 *   - packages/agent-core/src/agent/usage/index.ts `record(model, usage, scope)`
 *     logs exactly ONE `usage.record` per LLM call carrying that call's per-call
 *     DELTA usage; the canonical session total is the SUM of all deltas
 *     (`addUsage`), confirmed by packages/agent-core/test/agent/usage.test.ts
 *     (record(inputOther:1)+record(inputOther:10) ⇒ total inputOther:11).
 *   - `usageScope` ('session'|'turn') only drives an IN-MEMORY currentTurn
 *     rollup; exactly one `usage.record` is written per record() call, so SUMMING
 *     ALL usage.record deltas of ANY scope = the correct session total with NO
 *     double-count. We deliberately do NOT filter or dedup by scope.
 * Field map (TokenUsage → TokenBreakdown):
 *   inputOther          → input
 *   output              → output
 *   inputCacheRead      → cacheRead
 *   inputCacheCreation  → cacheWrite
 *   reasoning is always 0 (TokenUsage has no reasoning field).
 * Each usage.record is a DELTA, so each becomes its OWN row (no message_id
 * dedup; dedupKey is absent so aggregation never merges them) and the rows SUM
 * downstream. Zero-token records are dropped (consistent with the CLI path).
 * Per-record `model` is taken from the record itself (DEFAULT_MODEL fallback),
 * so the config.json walk is NOT consulted for the Kimi Code model. Timestamp is
 * `record.time` normalized via normalizeTimestampMs (>1e12 ⇒ ms, else
 * seconds×1000), falling back to the file mtime like the CLI path.
 *
 * Model (Kimi CLI only): `.model` from <home>/config.json (fallback
 * "kimi-for-coding"), where <home> is found by walking UP from wire.jsonl to the
 * nearest dir containing config.json — depth-robust, so it lands on ~/.kimi for
 * the CLI tree (and would land on ~/.kimi-code for the deeper tree, though Kimi
 * Code records carry their own model). Provider is hard-coded "moonshot".
 * Session id is the immediate parent dir of wire.jsonl: the SESSION_UUID for
 * Kimi CLI; for the deeper Kimi Code tree that is the <AGENT> dir (the best
 * available id at that depth — documented, acceptable). Kimi's wire log carries
 * no cwd, so there is no project attribution. Confidence is "host-reported"
 * (real host token counts).
 *
 * Fail-open: no root → []; an unreadable/malformed file or line → skipped.
 */

import { basename, dirname, join } from "node:path";

import type { TokenBreakdown, UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { fileMtimeMs, readJsonFile, readJsonlLines } from "../jsonl.js";
import { expandHome, hostRoots, isDir, isFile, walkFiles } from "../paths.js";

const PLATFORM_ID = "kimi" as const;
const DEFAULT_MODEL = "kimi-for-coding";
const DEFAULT_PROVIDER = "moonshot";

/**
 * Bound on the upward config.json walk. Kimi CLI needs 4 hops (wire.jsonl →
 * UUID → GROUP → sessions → home); Kimi Code's deeper tree needs 5 (wire.jsonl →
 * AGENT → agents → SESSION → sessions → home). 6 leaves headroom without letting
 * a stray config.json far up the filesystem masquerade as the Kimi home.
 */
const MAX_HOME_WALK_LEVELS = 6;

/** A Kimi CLI wire.jsonl line: metadata header OR a timestamped message frame. */
interface WireLine {
  type?: unknown;
  timestamp?: unknown;
  message?: {
    type?: unknown;
    payload?: {
      token_usage?: {
        input_other?: unknown;
        output?: unknown;
        input_cache_read?: unknown;
        input_cache_creation?: unknown;
      };
      message_id?: unknown;
    };
  };
}

/**
 * A Kimi Code wire.jsonl `usage.record` line (SOURCE-VERIFIED, see header). The
 * `usage` block is TokenUsage (camelCase, no reasoning); `time` is the record
 * timestamp; `model` is the per-call model; `usageScope` is informational only
 * and intentionally not read (every record is summed regardless of scope).
 */
interface KimiCodeUsageRecord {
  type?: unknown;
  time?: unknown;
  model?: unknown;
  usage?: {
    inputOther?: unknown;
    output?: unknown;
    inputCacheRead?: unknown;
    inputCacheCreation?: unknown;
  };
}

/** Coerce an unknown to a non-negative integer (0 on absence/garbage). */
function toNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/**
 * Convert the Kimi CLI wire `timestamp` (Unix seconds, often fractional like
 * 1770983426.420942) to epoch ms. Returns null when unusable so the caller can
 * fall back to the file mtime (port of `timestamp * 1000.0 as i64`).
 */
function parseWireTs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return Math.trunc(v * 1000);
  }
  return null;
}

/**
 * Normalize a Kimi Code `usage.record.time` to epoch ms, disambiguating
 * seconds-vs-ms by magnitude (the repo-wide convention): a value already in ms
 * (> 1e12) passes through truncated; a smaller value is treated as Unix seconds
 * (× 1000). Returns null when unusable so the caller falls back to the file mtime.
 */
function normalizeTimestampMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return v > 1e12 ? Math.trunc(v) : Math.trunc(v * 1000);
  }
  return null;
}

/**
 * Find the Kimi home for a wire.jsonl and read its `.model` (depth-robust
 * evolution of the Rust read_model_from_config). The two product trees differ in
 * DEPTH:
 *   Kimi CLI : <home>/sessions/<GROUP_ID>/<SESSION_UUID>/wire.jsonl   (4 hops)
 *   Kimi Code: <home>/sessions/<SESSION>/agents/<AGENT>/wire.jsonl    (5 hops)
 * A fixed dirname-hop count would land on `sessions/` for the deeper tree, so we
 * walk UP the ancestor chain (bounded by MAX_HOME_WALK_LEVELS) reading the first
 * `config.json` found — but the home is DEFINITIONALLY the parent of the
 * `sessions/` segment, so the moment we reach the `sessions` dir we read its
 * parent's config.json and STOP. That hard ceiling keeps the search inside the
 * Kimi home: it can never escape into an ancestor (e.g. a repo's or $HOME's stray
 * config.json) when the real home lacks one. For the Kimi CLI tree this resolves
 * the SAME <home> as the old 4-hop logic, so CLI behavior is byte-identical.
 * Fail-open to DEFAULT_MODEL on no config.json or any missing/garbage value.
 */
function modelFromConfigAt(dir: string): string {
  const parsed = readJsonFile(join(dir, "config.json"));
  if (typeof parsed === "object" && parsed !== null) {
    const model = (parsed as { model?: unknown }).model;
    if (typeof model === "string" && model !== "") return model;
  }
  return DEFAULT_MODEL; // config.json absent/unreadable or no usable .model
}

function readModelFromConfig(wirePath: string): string {
  let dir = dirname(wirePath);
  for (let level = 0; level <= MAX_HOME_WALK_LEVELS; level += 1) {
    if (isFile(join(dir, "config.json"))) return modelFromConfigAt(dir);
    // The home is the parent of the `sessions/` segment — read it and STOP so the
    // walk never climbs above the Kimi home into a stray ancestor config.json.
    if (basename(dir) === "sessions") return modelFromConfigAt(dirname(dir));
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return DEFAULT_MODEL;
}

/**
 * Session id from the wire path: the immediate parent directory of wire.jsonl
 * (port of extract_session_id, UNCHANGED). For Kimi CLI that is the SESSION_UUID;
 * for the deeper Kimi Code tree (.../sessions/<SESSION>/agents/<AGENT>/wire.jsonl)
 * that is the <AGENT> dir — the best available id at that depth (documented,
 * acceptable). Keeping the immediate-parent rule keeps Kimi CLI byte-identical.
 */
function extractSessionId(wirePath: string): string {
  const dir = basename(dirname(wirePath));
  return dir === "" ? "unknown" : dir;
}

/** Sum of the five token dimensions (port of TokenBreakdown::total). */
function tokenTotal(t: TokenBreakdown): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite + t.reasoning;
}

/**
 * Whether `candidate` should replace `existing` for the same message_id. Port of
 * should_replace_status_update: a strictly larger total wins; on an equal total
 * the later-or-equal timestamp wins (so the freshest progressive update is kept).
 */
function shouldReplace(existing: UsageRecord, candidate: UsageRecord): boolean {
  const existingTotal = tokenTotal(existing.tokens);
  const candidateTotal = tokenTotal(candidate.tokens);
  return (
    candidateTotal > existingTotal ||
    (candidateTotal === existingTotal && candidate.ts >= existing.ts)
  );
}

/** Parse one Kimi wire.jsonl file into usage records (port of parse_kimi_file). */
function parseKimiFile(path: string): UsageRecord[] {
  const lines = readJsonlLines(path);
  if (lines.length === 0) return [];

  const model = readModelFromConfig(path);
  const sessionId = extractSessionId(path);
  const mtime = fileMtimeMs(path);

  const out: UsageRecord[] = [];
  // message_id → index into `out`, for progressive-StatusUpdate dedup.
  const keyedIndices = new Map<string, number>();

  for (const raw of lines) {
    if (typeof raw !== "object" || raw === null) continue;
    const wire = raw as WireLine;

    // Skip the metadata header line.
    if (wire.type === "metadata") continue;

    const message = wire.message;
    if (typeof message !== "object" || message === null) continue;

    // Only StatusUpdate frames carry token usage.
    if (message.type !== "StatusUpdate") continue;

    const payload = message.payload;
    if (typeof payload !== "object" || payload === null) continue;

    const usage = payload.token_usage;
    if (typeof usage !== "object" || usage === null) continue;

    const input = toNonNegInt(usage.input_other);
    const output = toNonNegInt(usage.output);
    const cacheRead = toNonNegInt(usage.input_cache_read);
    const cacheWrite = toNonNegInt(usage.input_cache_creation);

    // Skip zero-token entries.
    if (input + output + cacheRead + cacheWrite === 0) continue;

    const ts = parseWireTs(wire.timestamp) ?? mtime;

    const tokens = emptyTokens();
    tokens.input = input;
    tokens.output = output;
    tokens.cacheRead = cacheRead;
    tokens.cacheWrite = cacheWrite;
    // reasoning stays 0 — the Kimi wire protocol folds reasoning into output.

    const messageId = payload.message_id;
    const dedupKey =
      typeof messageId === "string" && messageId !== "" ? messageId : undefined;

    const record: UsageRecord = {
      platformId: PLATFORM_ID,
      modelId: model,
      providerId: DEFAULT_PROVIDER,
      sessionId,
      tokens,
      ts,
      messageCount: 1,
      confidence: "host-reported",
    };
    if (dedupKey !== undefined) record.dedupKey = dedupKey;

    if (dedupKey === undefined) {
      // Un-keyed StatusUpdates are never merged — each is its own row.
      out.push(record);
      continue;
    }

    const existingIndex = keyedIndices.get(dedupKey);
    if (existingIndex !== undefined) {
      const existing = out[existingIndex];
      if (existing !== undefined && shouldReplace(existing, record)) {
        out[existingIndex] = record;
      }
      continue;
    }

    keyedIndices.set(dedupKey, out.length);
    out.push(record);
  }

  return out;
}

/**
 * Parse one Kimi Code wire.jsonl file into usage records (SOURCE-VERIFIED, see
 * header). Each `type === "usage.record"` line is a per-LLM-call usage DELTA;
 * we emit each as its OWN row (NO message_id dedup — dedupKey is absent so
 * aggregation never merges them) and the rows SUM to the canonical session
 * total. usageScope is ignored on purpose: exactly one usage.record is written
 * per record() call, so summing all deltas of any scope never double-counts.
 * Non-usage.record lines (metadata, turn_begin, …) are skipped; zero-token
 * records are dropped, matching the CLI path.
 */
function parseKimiCodeFile(path: string): UsageRecord[] {
  const lines = readJsonlLines(path);
  if (lines.length === 0) return [];

  const sessionId = extractSessionId(path);
  const mtime = fileMtimeMs(path);

  const out: UsageRecord[] = [];

  for (const raw of lines) {
    if (typeof raw !== "object" || raw === null) continue;
    const rec = raw as KimiCodeUsageRecord;

    // Only usage.record lines carry token usage in the Kimi Code format.
    if (rec.type !== "usage.record") continue;

    const usage = rec.usage;
    if (typeof usage !== "object" || usage === null) continue;

    // TokenUsage → TokenBreakdown (camelCase source fields; no reasoning field).
    const input = toNonNegInt(usage.inputOther);
    const output = toNonNegInt(usage.output);
    const cacheRead = toNonNegInt(usage.inputCacheRead);
    const cacheWrite = toNonNegInt(usage.inputCacheCreation);

    // Skip zero-token deltas (consistent with the CLI path).
    if (input + output + cacheRead + cacheWrite === 0) continue;

    const ts = normalizeTimestampMs(rec.time) ?? mtime;

    const tokens = emptyTokens();
    tokens.input = input;
    tokens.output = output;
    tokens.cacheRead = cacheRead;
    tokens.cacheWrite = cacheWrite;
    // reasoning stays 0 — Kimi Code's TokenUsage has no reasoning field.

    const model =
      typeof rec.model === "string" && rec.model !== "" ? rec.model : DEFAULT_MODEL;

    // Each delta is its own row (no dedupKey ⇒ never merged at aggregation).
    out.push({
      platformId: PLATFORM_ID,
      modelId: model,
      providerId: DEFAULT_PROVIDER,
      sessionId,
      tokens,
      ts,
      messageCount: 1,
      confidence: "host-reported",
    });
  }

  return out;
}

/**
 * Detect which product wrote a wire.jsonl by its record shape (a given file is
 * ONE product's format). A file is Kimi Code iff it carries any
 * `type === "usage.record"` line; otherwise it is parsed as Kimi CLI. This keeps
 * the Kimi CLI path (parseKimiFile) provably untouched — a CLI StatusUpdate file
 * has no usage.record line and routes to parseKimiFile byte-identically.
 */
function parseWireFile(path: string): UsageRecord[] {
  const lines = readJsonlLines(path);
  for (const raw of lines) {
    if (typeof raw === "object" && raw !== null && (raw as KimiCodeUsageRecord).type === "usage.record") {
      return parseKimiCodeFile(path);
    }
  }
  return parseKimiFile(path);
}

/**
 * Candidate Kimi session roots, most-preferred first. Covers BOTH Moonshot
 * products under the "kimi" id:
 *   1. $KIMI_CODE_HOME/sessions — Kimi Code's relocated home, when set (the env
 *      var our adapter and the official kimi-code docs honor).
 *   2. paths.ts hostRoots("kimi"), in order:
 *        - AGENT_CONNECTOR_KIMI_DIR/sessions  (explicit framework override)
 *        - ~/.kimi-code/sessions              (Kimi Code default — preferred)
 *        - ~/.kimi/sessions                   (Kimi CLI default)
 * All existing roots are scanned (not just the first) so a box running BOTH
 * products is fully covered; the reader's `seen` set de-overlaps any duplicate
 * wire.jsonl reached via two roots (e.g. KIMI_CODE_HOME == ~/.kimi-code).
 */
function kimiSessionRoots(): string[] {
  const roots: string[] = [];

  const codeHome = process.env.KIMI_CODE_HOME;
  if (codeHome != null && codeHome.trim() !== "") {
    roots.push(join(expandHome(codeHome.trim()), "sessions"));
  }

  // hostRoots already prepends the AGENT_CONNECTOR_KIMI_DIR override and lists
  // ~/.kimi-code/sessions then ~/.kimi/sessions as the two product defaults.
  for (const root of hostRoots(PLATFORM_ID)) roots.push(root);

  return roots;
}

/** The Kimi CLI usage reader singleton. */
const kimiReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const roots = kimiSessionRoots().filter((r) => isDir(r));
    if (roots.length === 0) return []; // no session root present → fail-open

    // Kimi CLI : <root>/<GROUP_ID>/<SESSION_UUID>/wire.jsonl
    // Kimi Code: <root>/<SESSION>/agents/<AGENT>/wire.jsonl (deeper — walkFiles
    //            recurses, so the extra `agents/` level is found transparently).
    // parseWireFile routes each file to its product parser by record shape.
    const seen = new Set<string>();
    const records: UsageRecord[] = [];
    for (const root of roots) {
      const files = walkFiles(root, (name) => name === "wire.jsonl");
      for (const file of files) {
        if (seen.has(file)) continue; // de-overlap across overlapping roots
        seen.add(file);
        const rows = parseWireFile(file);
        for (const row of rows) {
          if (sinceMs !== undefined && row.ts < sinceMs) continue;
          records.push(row);
        }
      }
    }
    return records;
  },
};

export default kimiReader;
