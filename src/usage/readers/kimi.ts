/**
 * usage/readers/kimi — Moonshot native session-log reader (TWO products).
 *
 * Originally a faithful port of tokscale sessions/kimi.rs (origin of the wire
 * protocol parse), this reader now covers BOTH Moonshot products that share the
 * "kimi" platform id but lay out their session logs DIFFERENTLY:
 *
 *   - Kimi CLI  (older, ~/.kimi):
 *       ~/.kimi/sessions/<GROUP_ID>/<SESSION_UUID>/wire.jsonl
 *       config.json sits at ~/.kimi/config.json. This is the tree tokscale's
 *       sessions/kimi.rs reads and the one this port was first written against.
 *
 *   - Kimi Code (newer, @moonshot-ai/kimi-code, ~/.kimi-code):
 *       ~/.kimi-code/sessions/<SESSION>/agents/<AGENT>/wire.jsonl
 *       config.json sits at ~/.kimi-code/config.json. This is a DEEPER tree (an
 *       extra `agents/<AGENT>/` level) — the product our connector adapter
 *       targets. The `~/.kimi-code` base + `$KIMI_CODE_HOME` override are
 *       primary-doc-confirmed (moonshotai.github.io/kimi-code/en/configuration/
 *       config-files.html), as is the `wire.jsonl` filename ("the agent event
 *       stream", moonshotai.github.io/kimi-code docs).
 *
 * Both default trees are scanned (Kimi Code preferred first); $KIMI_CODE_HOME
 * relocates the Kimi Code home and is honored ahead of the defaults; the
 * AGENT_CONNECTOR_KIMI_DIR override (via paths.ts hostRoots) is honored first.
 *
 * HONEST VERIFICATION LIMIT: Kimi Code's wire.jsonl FRAME schema is NOT
 * live-verified — generating a Kimi Code session is auth-gated (Moonshot login,
 * unavailable in this environment). Web docs confirm only the FILENAME/concept
 * (`wire.jsonl` = "the agent event stream"), so we ASSUME it is the same
 * Moonshot wire protocol the Kimi CLI port already parses. THE SAFETY NET: the
 * parser below counts ONLY frames with `message.type === "StatusUpdate"`
 * carrying `payload.token_usage`. If Kimi Code's frames diverge, those files
 * yield ZERO records (fail-open) — NEVER wrong token counts. The frame filter
 * is deliberately NOT loosened for this reason.
 *
 * --- wire frame parse (unchanged from the Kimi CLI port) ---
 * Each line is a timestamped wire frame; only frames whose
 * `message.type === "StatusUpdate"` carry a `payload.token_usage` block:
 *   input_other          → input
 *   output               → output
 *   input_cache_read     → cacheRead
 *   input_cache_creation → cacheWrite  (cache CREATION cost, not a read)
 *   reasoning is always 0 (the wire protocol folds reasoning into output).
 *
 * The first line (`{"type":"metadata", …}`) and every non-StatusUpdate frame
 * (TurnBegin / ContentPart / ToolCall / StepBegin …) are skipped. Zero-token
 * StatusUpdates are dropped.
 *
 * DEDUP (the double-counting hazard): Kimi emits PROGRESSIVE StatusUpdates for a
 * single assistant message as generation streams (e.g. message_id "msg-x" at
 * 100→10 tokens, then 120→30). We dedup by `payload.message_id`, keeping the row
 * with the MAX total tokens (tie-break: the later timestamp). Records WITHOUT a
 * (non-empty) message_id are never merged — each passes through as its own row,
 * exactly as the Rust push_or_replace_status_update does. The kept row's
 * `dedupKey` is its message_id (absent for un-keyed rows).
 *
 * Model: `.model` from <home>/config.json (fallback "kimi-for-coding"), where
 * <home> is found by walking UP from wire.jsonl to the nearest dir containing
 * config.json — depth-robust, so it lands on ~/.kimi for the CLI tree and
 * ~/.kimi-code for the deeper Kimi Code tree (a fixed dirname-hop count would
 * mis-resolve the deeper tree). Provider is hard-coded "moonshot". Session id is
 * the immediate parent dir of wire.jsonl: the SESSION_UUID for Kimi CLI; for the
 * deeper Kimi Code tree that is the <AGENT> dir (the best available id at that
 * depth — documented, acceptable). Kimi's wire log carries no cwd, so there is
 * no project attribution. Confidence is "host-reported" (real host token counts).
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

/** A wire.jsonl line: metadata header OR a timestamped message frame. */
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

/** Coerce an unknown to a non-negative integer (0 on absence/garbage). */
function toNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/**
 * Convert the wire `timestamp` (Unix seconds, often fractional like
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
    const seen = new Set<string>();
    const records: UsageRecord[] = [];
    for (const root of roots) {
      const files = walkFiles(root, (name) => name === "wire.jsonl");
      for (const file of files) {
        if (seen.has(file)) continue; // de-overlap across overlapping roots
        seen.add(file);
        const rows = parseKimiFile(file);
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
