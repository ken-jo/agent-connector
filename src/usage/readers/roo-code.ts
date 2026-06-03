/**
 * usage/readers/roo-code — Roo Code (VS Code extension) task-log reader.
 *
 * Faithful port of tokscale sessions/roocode.rs (parse_roo_kilo_file, source
 * "roocode"). Roo Code (rooveterinaryinc.roo-cline) is a Cline-fork VS Code
 * extension that persists per-task logs under its VS Code globalStorage:
 *   <vscodeUserDir>/globalStorage/rooveterinaryinc.roo-cline/tasks/<taskId>/
 *     ui_messages.json               (the UI message stream — token source)
 *     api_conversation_history.json  (sibling — model/agent source)
 *
 * roo-code is NOT in paths.ts hostRoots (the framework's per-platform table
 * targets CLIs with ~/.<tool> roots, not VS Code extension globalStorage), so
 * this reader resolves the cross-OS VS Code "User" dir itself, mirroring the
 * roo-code platform adapter (adapters/roo-code/index.ts vscodeUserDir):
 *   - macOS   → ~/Library/Application Support/Code/User
 *   - Windows → %APPDATA%/Code/User  (else ~/AppData/Roaming/Code/User)
 *   - Linux   → ~/.config/Code/User
 * An AGENT_CONNECTOR_ROO_CODE_DIR override (verbatim, non-empty, ~-expanded)
 * points directly at a `tasks` parent when set, matching the env convention in
 * paths.ts hostRoots.
 *
 * Tokens (ui_messages.json): the file is a JSON ARRAY of entries; only entries
 * with type=="say" AND say=="api_req_started" carry usage. Each such entry's
 * `text` field is a JSON-in-string payload:
 *   tokensIn     → input
 *   tokensOut    → output
 *   cacheReads   → cacheRead
 *   cacheWrites  → cacheWrite
 *   cost (f64)   → cost
 *   apiProtocol  → providerId (preserved verbatim, e.g. "bedrock/anthropic")
 * reasoning is ALWAYS 0 (Roo Code does not report it). A malformed text payload,
 * a missing text, or an unparseable `ts` skips just that entry.
 *
 * model / agent (api_conversation_history.json): scan every
 * <environment_details>…</environment_details> block for <model>, <slug>, <name>
 * tags; the LAST <model> wins (default "unknown"); agent prefers <slug> then
 * <name> (optional). When the sibling file is absent/unreadable: model "unknown",
 * no agent — exactly the Rust read_task_metadata fallback.
 *
 * session id is the taskId — the parent directory name of ui_messages.json
 * (port of extract_session_id), defaulting to "unknown". provider from
 * apiProtocol (trimmed, default "unknown"). No project attribution (Roo Code's
 * logs carry no cwd). No dedup — one row per api_req_started event. Confidence is
 * "host-reported".
 *
 * Fail-open: no root → []; unreadable/malformed file, entry, or payload → skipped
 * (never throws). Read-only.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { readJsonFile } from "../jsonl.js";
import { expandHome, walkFiles } from "../paths.js";

const PLATFORM_ID = "roo-code" as const;
const DEFAULT_MODEL = "unknown";
const DEFAULT_PROVIDER = "unknown";
const DEFAULT_SESSION = "unknown";

/** Roo Code extension id → its VS Code globalStorage folder. */
const ROO_EXTENSION_ID = "rooveterinaryinc.roo-cline";

// ─────────────────────────────────────────────────────────────────────────
// Storage-root resolution (mirrors adapters/roo-code vscodeUserDir + the
// AGENT_CONNECTOR_<PLATFORM>_DIR env convention in paths.ts hostRoots)
// ─────────────────────────────────────────────────────────────────────────

/** Resolve the cross-OS VS Code per-user "User" dir (the globalStorage parent). */
function vscodeUserDir(): string {
  const home = homedir();
  switch (osPlatform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Code", "User");
    case "win32": {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(appData, "Code", "User");
    }
    default:
      return join(home, ".config", "Code", "User");
  }
}

/**
 * The `tasks` root holding per-task subdirectories. Honors an
 * AGENT_CONNECTOR_ROO_CODE_DIR override (verbatim, non-empty, ~-expanded,
 * resolved against CWD when relative), else the extension's globalStorage tasks
 * dir under the resolved VS Code user dir.
 */
function tasksRoot(): string {
  const raw = process.env.AGENT_CONNECTOR_ROO_CODE_DIR;
  if (raw != null && raw.trim() !== "") {
    const expanded = expandHome(raw.trim());
    return isAbsolute(expanded) ? expanded : resolve(expanded);
  }
  return join(vscodeUserDir(), "globalStorage", ROO_EXTENSION_ID, "tasks");
}

// ─────────────────────────────────────────────────────────────────────────
// Value coercion (ports of utils.rs extract_i64 / extract_f64 / parse_timestamp_str)
// ─────────────────────────────────────────────────────────────────────────

/** Port of extract_i64: number / numeric-string → integer, else undefined. */
function extractI64(v: unknown): number | undefined {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return undefined;
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) return undefined; // Rust parses as i64 (integer-only)
    const n = Number(trimmed);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  return undefined;
}

/** A non-negative integer from a payload field (0 on absence/garbage, clamped ≥ 0). */
function tokenField(v: unknown): number {
  const n = extractI64(v);
  return n === undefined ? 0 : Math.max(0, n);
}

/** Port of extract_f64: number / numeric-string → f64, else undefined. */
function extractF64(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Port of utils.rs parse_timestamp_str / parse_entry_timestamp: an RFC3339 string
 * → epoch ms; an integer (string or number) → ms (×1000 when below the 1e12 ms
 * threshold); rejects ≤ 0. Returns null when unusable so the entry is skipped.
 */
function parseEntryTimestamp(v: unknown): number | null {
  let s: string;
  if (typeof v === "string") s = v;
  else if (typeof v === "number" && Number.isFinite(v)) s = String(Math.trunc(v));
  else return null;

  return parseTimestampStr(s);
}

function parseTimestampStr(value: string): number | null {
  const ms = Date.parse(value);
  if (!Number.isNaN(ms)) return ms; // RFC3339 / any Date-parseable form

  if (/^[+-]?\d+$/.test(value.trim())) {
    const numeric = Number(value.trim());
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// session id (port of extract_session_id)
// ─────────────────────────────────────────────────────────────────────────

/** Session id = the parent directory (taskId) of ui_messages.json, else "unknown". */
function extractSessionId(path: string): string {
  const parent = basename(dirname(path));
  return parent !== "" ? parent : DEFAULT_SESSION;
}

// ─────────────────────────────────────────────────────────────────────────
// model / agent (ports of read_task_metadata / extract_model_and_agent / extract_tag_value)
// ─────────────────────────────────────────────────────────────────────────

interface TaskMetadata {
  model: string;
  agent?: string;
}

/** Read the sibling api_conversation_history.json for model/agent (fail-open). */
function readTaskMetadata(uiMessagesPath: string): TaskMetadata {
  const historyPath = join(dirname(uiMessagesPath), "api_conversation_history.json");
  let content: string;
  try {
    content = readFileSync(historyPath, "utf8");
  } catch {
    return { model: DEFAULT_MODEL }; // missing/unreadable → ("unknown", None)
  }
  return extractModelAndAgent(content);
}

/**
 * Scan every <environment_details>…</environment_details> block, extracting
 * <model>, <slug>, <name>. The LAST non-empty value of each tag wins (port of the
 * Rust last_* accumulation). model defaults to "unknown"; agent prefers slug then
 * name (and is omitted when neither is present).
 */
function extractModelAndAgent(content: string): TaskMetadata {
  const ENV_START = "<environment_details>";
  const ENV_END = "</environment_details>";

  let offset = 0;
  let lastModel: string | undefined;
  let lastSlug: string | undefined;
  let lastName: string | undefined;

  for (;;) {
    const startRel = content.indexOf(ENV_START, offset);
    if (startRel < 0) break;
    const startIdx = startRel + ENV_START.length;

    const endRel = content.indexOf(ENV_END, startIdx);
    if (endRel < 0) break;

    const block = content.slice(startIdx, endRel);

    const model = extractTagValue(block, "model");
    if (model !== undefined) lastModel = model;
    const slug = extractTagValue(block, "slug");
    if (slug !== undefined) lastSlug = slug;
    const name = extractTagValue(block, "name");
    if (name !== undefined) lastName = name;

    offset = endRel + ENV_END.length;
  }

  const agent = lastSlug ?? lastName;
  const result: TaskMetadata = { model: lastModel ?? DEFAULT_MODEL };
  if (agent !== undefined) result.agent = agent;
  return result;
}

/** First <tag>…</tag> value in `block`, trimmed; undefined when absent or empty. */
function extractTagValue(block: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const close = `</${tag}>`;

  const openIdx = block.indexOf(open);
  if (openIdx < 0) return undefined;
  const start = openIdx + open.length;
  const endRel = block.indexOf(close, start);
  if (endRel < 0) return undefined;

  const value = block.slice(start, endRel).trim();
  return value === "" ? undefined : value;
}

// ─────────────────────────────────────────────────────────────────────────
// api_req_started payload (port of parse_api_req_started_payload + provider_from_api_protocol)
// ─────────────────────────────────────────────────────────────────────────

interface ApiReqStartedPayload {
  cost: number;
  tokensIn: number;
  tokensOut: number;
  cacheReads: number;
  cacheWrites: number;
  apiProtocol?: string;
}

/** Parse the JSON-in-string `text` payload of an api_req_started entry. */
function parseApiReqStartedPayload(text: string): ApiReqStartedPayload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;

  // cost: extract_f64(.cost).unwrap_or(0.0).max(0.0)
  const cost = Math.max(0, extractF64(obj["cost"]) ?? 0);
  const apiProtocolRaw = typeof obj["apiProtocol"] === "string" ? (obj["apiProtocol"] as string) : undefined;

  const payload: ApiReqStartedPayload = {
    cost,
    tokensIn: tokenField(obj["tokensIn"]),
    tokensOut: tokenField(obj["tokensOut"]),
    cacheReads: tokenField(obj["cacheReads"]),
    cacheWrites: tokenField(obj["cacheWrites"]),
  };
  if (apiProtocolRaw !== undefined) payload.apiProtocol = apiProtocolRaw;
  return payload;
}

/** Provider from apiProtocol: trimmed, non-empty, else "unknown" (verbatim — no inference). */
function providerFromApiProtocol(apiProtocol: string | undefined): string {
  if (apiProtocol === undefined) return DEFAULT_PROVIDER;
  const trimmed = apiProtocol.trim();
  return trimmed === "" ? DEFAULT_PROVIDER : trimmed;
}

// ─────────────────────────────────────────────────────────────────────────
// File parse (port of parse_roo_kilo_file with source "roocode")
// ─────────────────────────────────────────────────────────────────────────

/** The fields we read off a ui_messages.json entry (all optional / unknown). */
interface UiMessageEntry {
  type?: unknown;
  say?: unknown;
  text?: unknown;
  ts?: unknown;
}

/** Parse one task's ui_messages.json into usage records. */
function parseRooCodeFile(path: string): UsageRecord[] {
  const data = readJsonFile(path);
  if (!Array.isArray(data)) return []; // malformed / non-array → no rows

  const sessionId = extractSessionId(path);
  const { model, agent } = readTaskMetadata(path);

  const out: UsageRecord[] = [];
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as UiMessageEntry;

    if (entry.type !== "say" || entry.say !== "api_req_started") continue;

    if (typeof entry.text !== "string") continue; // None => skip
    const ts = parseEntryTimestamp(entry.ts);
    if (ts === null) continue; // unparseable ts => skip

    const payload = parseApiReqStartedPayload(entry.text);
    if (payload === undefined) continue; // malformed payload => skip

    const providerId = providerFromApiProtocol(payload.apiProtocol);

    const tokens = emptyTokens();
    tokens.input = payload.tokensIn;
    tokens.output = payload.tokensOut;
    tokens.cacheRead = payload.cacheReads;
    tokens.cacheWrite = payload.cacheWrites;
    // reasoning stays 0 (Roo Code does not report it).

    const record: UsageRecord = {
      platformId: PLATFORM_ID,
      modelId: model,
      providerId,
      sessionId,
      tokens,
      ts,
      messageCount: 1,
      confidence: "host-reported",
    };
    if (payload.cost > 0) record.cost = payload.cost;
    if (agent !== undefined) record.agent = agent;
    out.push(record);
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Reader singleton
// ─────────────────────────────────────────────────────────────────────────

/** The Roo Code (VS Code extension) usage reader singleton. */
const rooCodeReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const root = tasksRoot();
    if (!existsSync(root)) return []; // no tasks dir → fail-open

    // <root>/<taskId>/ui_messages.json
    const files = walkFiles(root, (name, abs) => {
      return name === "ui_messages.json" && /[\\/]ui_messages\.json$/.test(abs);
    });

    const records: UsageRecord[] = [];
    for (const file of files) {
      let rows: UsageRecord[];
      try {
        rows = parseRooCodeFile(file);
      } catch {
        continue; // fail-open per file
      }
      for (const row of rows) {
        if (sinceMs !== undefined && row.ts < sinceMs) continue;
        records.push(row);
      }
    }
    return records;
  },
};

export default rooCodeReader;
