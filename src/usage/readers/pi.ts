/**
 * usage/readers/pi — Pi (badlogic/pi-mono) + OMP (oh-my-pi fork) session reader.
 *
 * Faithful port of tokscale sessions/pi.rs. Pi-format JSONL lives under TWO
 * roots that share the identical schema (tokscale scans both under ClientId::Pi):
 *   - ~/.pi/agent/sessions/<encoded-cwd>/*.jsonl   → emitted as platformId "pi"
 *   - ~/.omp/agent/sessions/<encoded-cwd>/*.jsonl  → emitted as platformId "omp"
 *     (Oh My Pi fork, https://github.com/can1357/oh-my-pi — same format, new root)
 * The pi root honors the PI_CODING_AGENT_DIR override (verbatim when non-empty);
 * the omp root is the fixed ~/.omp default.
 *
 * File shape (port of parse_pi_file):
 *   - Line 0 MUST be the session header `{type:"session", id, cwd?, timestamp?}`.
 *     If the first non-empty line is not a parseable `session` header, the WHOLE
 *     file yields nothing (mirrors the Rust early-return on header failure).
 *   - Subsequent lines are entries; only `type:"message"` with
 *     `message.role=="assistant"` AND a present `message.usage`, `message.model`,
 *     and `message.provider` produce a record. Any of those missing → skip line.
 *
 * Tokens (message.usage): input, output, cacheRead→cacheRead, cacheWrite→cacheWrite;
 * reasoning is always 0 (Pi does not report it). Each token clamped ≥ 0.
 * Provider is the explicit `message.provider` field (NOT inferred). Timestamp is
 * the entry's RFC3339 `timestamp` (→ epoch ms), falling back to the file mtime.
 * Session id is the header `id`; workspace is the header `cwd` normalized once.
 *
 * Dedup: pi.rs performs NO dedup (one row per assistant line; file path + line
 * index are implicitly unique within a session). We still emit a stable
 * dedupKey `<platformId>:<sessionId>:<lineIndex>` so the global insertion-order
 * de-dup backstop has a per-record key to key on.
 *
 * Confidence: "host-reported" (Pi logs real token counts).
 *
 * Fail-open: no root → []; unreadable/malformed file or line → skipped; a file
 * whose header is missing/invalid contributes nothing (never throws).
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { PlatformId } from "../../core/types.js";
import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { fileMtimeMs, readJsonlLines } from "../jsonl.js";
import { normalizeWorkspaceKey, workspaceLabelFromKey } from "../normalize.js";
import { isDir, walkFiles } from "../paths.js";

const PI_PLATFORM_ID: PlatformId = "pi";
const OMP_PLATFORM_ID: PlatformId = "omp";

/** The two Pi-format roots, each tagged with the platformId it emits. */
interface PiRoot {
  readonly dir: string;
  readonly platformId: PlatformId;
}

/** Session header (first JSONL line). */
interface PiSessionHeader {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
}

/** Subsequent JSONL entry. */
interface PiSessionEntry {
  type?: unknown;
  timestamp?: unknown;
  message?: {
    role?: unknown;
    model?: unknown;
    provider?: unknown;
    usage?: {
      input?: unknown;
      output?: unknown;
      cacheRead?: unknown;
      cacheWrite?: unknown;
    };
  };
}

/** Coerce an unknown to a non-negative integer (0 on absence/garbage). */
function toNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/** Parse an RFC3339 / numeric timestamp to epoch ms, or null when unusable. */
function parseTs(v: unknown): number | null {
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
    const num = Number(v);
    if (Number.isFinite(num) && num > 0) return num >= 1e12 ? num : num * 1000;
    return null;
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return v >= 1e12 ? v : v * 1000;
  }
  return null;
}

/**
 * Read an env override, treating empty/blank as unset (tokscale's
 * is_config_dir_overridden contract: an empty override must NOT resolve to "").
 * Relative paths resolve against the process CWD; "~" is expanded.
 */
function envOverrideDir(name: string): string | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return undefined;
  let p = raw.trim();
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(p);
}

/**
 * Resolve the two Pi-format roots, most-specific first. The pi root honors the
 * PI_CODING_AGENT_DIR override; the omp root is the fixed ~/.omp default. Roots
 * that are not existing directories are dropped (fail-open).
 */
function piRoots(): PiRoot[] {
  const piDir = envOverrideDir("PI_CODING_AGENT_DIR") ?? join(homedir(), ".pi", "agent", "sessions");
  const ompDir = join(homedir(), ".omp", "agent", "sessions");
  const candidates: PiRoot[] = [
    { dir: piDir, platformId: PI_PLATFORM_ID },
    { dir: ompDir, platformId: OMP_PLATFORM_ID },
  ];
  return candidates.filter((c) => isDir(c.dir));
}

/**
 * Parse one Pi JSONL session file into usage records (port of parse_pi_file).
 * Returns [] when the header is missing/invalid (whole-file early return) or no
 * assistant line qualifies. `platformId` tags which root the file came from.
 */
function parsePiFile(path: string, platformId: PlatformId): UsageRecord[] {
  const lines = readJsonlLines(path);
  if (lines.length === 0) return [];

  const fallbackTs = fileMtimeMs(path);

  // ── Header (first non-empty parseable line) ────────────────────────────
  // readJsonlLines already drops blank/malformed lines; index 0 is the first
  // successfully-parsed line. It MUST be a `session` header or the file is void.
  const headerRaw = lines[0];
  if (typeof headerRaw !== "object" || headerRaw === null) return [];
  const header = headerRaw as PiSessionHeader;
  if (header.type !== "session") return [];
  if (typeof header.id !== "string" || header.id === "") return [];
  const sessionId = header.id;

  let projectKey: string | undefined;
  let projectLabel: string | undefined;
  if (typeof header.cwd === "string" && header.cwd !== "") {
    const key = normalizeWorkspaceKey(header.cwd);
    if (key !== undefined) {
      projectKey = key;
      projectLabel = workspaceLabelFromKey(key);
    }
  }

  const out: UsageRecord[] = [];

  // ── Entries (every line after the header) ──────────────────────────────
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as PiSessionEntry;

    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message === undefined || message === null) continue;
    if (message.role !== "assistant") continue;

    const usage = message.usage;
    if (usage === undefined || usage === null) continue;
    if (typeof message.model !== "string" || message.model === "") continue;
    if (typeof message.provider !== "string" || message.provider === "") continue;

    const modelId = message.model;
    const providerId = message.provider;

    const ts = parseTs(entry.timestamp) ?? fallbackTs;

    const tokens = emptyTokens();
    tokens.input = toNonNegInt(usage.input);
    tokens.output = toNonNegInt(usage.output);
    tokens.cacheRead = toNonNegInt(usage.cacheRead);
    tokens.cacheWrite = toNonNegInt(usage.cacheWrite);
    // reasoning stays 0 (Pi does not report it).

    const record: UsageRecord = {
      platformId,
      modelId,
      providerId,
      sessionId,
      tokens,
      ts,
      messageCount: 1,
      // No host dedup key in Pi; synthesize a per-record key (path-implicit
      // uniqueness within a session, mirrored by session id + line index).
      dedupKey: `${platformId}:${sessionId}:${i}`,
      confidence: "host-reported",
    };
    if (projectKey !== undefined) record.projectKey = projectKey;
    if (projectLabel !== undefined) record.projectLabel = projectLabel;
    out.push(record);
  }

  return out;
}

/** The Pi / OMP usage reader singleton (registry lists it under "pi"). */
const piReader: UsageReader = {
  platformId: PI_PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const roots = piRoots();
    if (roots.length === 0) return []; // no ~/.pi or ~/.omp → fail-open

    const records: UsageRecord[] = [];
    for (const root of roots) {
      // <root>/<encoded-cwd>/*.jsonl
      const files = walkFiles(root.dir, (name) => name.endsWith(".jsonl"));
      for (const file of files) {
        const rows = parsePiFile(file, root.platformId);
        for (const row of rows) {
          if (sinceMs !== undefined && row.ts < sinceMs) continue;
          records.push(row);
        }
      }
    }
    return records;
  },
};

export default piReader;
