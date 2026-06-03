/**
 * tests/usage/u4-readers — fixture-based tests for the 4 SYNCED usage readers
 * (cursor, antigravity, trae, warp).
 *
 * These four platforms are SYNCED: tokscale fills a LOCAL CACHE via an external
 * API sync that this codebase NEVER performs (no auth, no network). So each
 * reader only ever READS a local cache artifact a separate tokscale run may have
 * produced:
 *   - cache ABSENT  → read() returns [] (the common case; the scan layer notes
 *                     "requires sync, skipped"). This is the primary assertion.
 *   - cache PRESENT → parse it and emit records with the spec confidence.
 *
 * Cache roots are resolved by src/usage/paths.ts under the tokscale config dir
 * (~/.config/tokscale by default). paths.ts supports an explicit
 * AGENT_CONNECTOR_TOKSCALE_DIR override which we point at a fresh temp dir each
 * test, so the suite is hermetic and OS-independent (we never touch a real
 * tokscale install). The per-platform cache subdirs are:
 *   <tokscale>/cursor-cache/      (usage*.csv)
 *   <tokscale>/antigravity-cache/ (manifest.json + sessions/*.jsonl)
 *   <tokscale>/trae-cache/        (sessions/usage-*.json)
 *   <tokscale>/warp-cache/        (usage.json)
 *
 * Artifact shapes are grounded in the tokscale Rust parsers
 * (crates/tokscale-core/src/sessions/{cursor,antigravity,trae,warp}.rs) and the
 * design spec (docs/research/usage-readers.json + usage-design.md §3d).
 *
 * Every block asserts FAIL-OPEN: a missing cache → [] (the reader never throws).
 * Env is snapshotted in beforeEach and fully restored in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import cursorReader from "../../src/usage/readers/cursor.js";
import antigravityReader from "../../src/usage/readers/antigravity.js";
import traeReader from "../../src/usage/readers/trae.js";
import warpReader from "../../src/usage/readers/warp.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared harness. We set HOME to a fresh temp dir (so the antigravity reader's
// ~/antigravity-* filesystem scan finds nothing stray) and point the tokscale
// cache dir at a separate fresh temp dir via AGENT_CONNECTOR_TOKSCALE_DIR (the
// override paths.ts honors first). We also neutralize the per-platform
// AGENT_CONNECTOR_<P>_DIR overrides and XDG/APPDATA so resolution is fully
// deterministic. All touched env keys are snapshotted + restored.
// ─────────────────────────────────────────────────────────────────────────

const SAVED_ENV = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "AGENT_CONNECTOR_TOKSCALE_DIR",
  "AGENT_CONNECTOR_CURSOR_DIR",
  "AGENT_CONNECTOR_ANTIGRAVITY_DIR",
  "AGENT_CONNECTOR_TRAE_DIR",
  "AGENT_CONNECTOR_WARP_DIR",
] as const;

let tmpHome: string;
let tokscaleDir: string;
let savedEnv: Record<string, string | undefined>;

/** Absolute path to a platform's cache subdir under the temp tokscale dir. */
function cacheDir(name: string): string {
  return join(tokscaleDir, name);
}

/** Write a file (mkdir -p the parent first). */
function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

beforeEach(() => {
  savedEnv = {};
  for (const key of SAVED_ENV) savedEnv[key] = process.env[key];

  tmpHome = mkdtempSync(join(tmpdir(), "ac-u4-home-"));
  tokscaleDir = mkdtempSync(join(tmpdir(), "ac-u4-tokscale-"));

  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome; // homedir() on Windows
  // Point the tokscale cache dir at our temp dir; the per-platform cache subdirs
  // (cursor-cache, …) live under it. Nothing is created until a test writes one.
  process.env.AGENT_CONNECTOR_TOKSCALE_DIR = tokscaleDir;
  // Neutralize everything else so resolution is deterministic across OSes.
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  delete process.env.APPDATA;
  delete process.env.LOCALAPPDATA;
  for (const key of SAVED_ENV) {
    if (key.startsWith("AGENT_CONNECTOR_") && key !== "AGENT_CONNECTOR_TOKSCALE_DIR") {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  for (const key of SAVED_ENV) {
    const v = savedEnv[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  for (const dir of [tmpHome, tokscaleDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════
// 1. cursor — <tokscale>/cursor-cache/usage*.csv (CSV export the dashboard
//    sync produces). v1/v2/v3 column maps; cacheWrite = in(w/CW) - in(w/oCW).
//    Confidence host-reported; sessionId = dedupKey = cursor-<account>-<date>.
// ═════════════════════════════════════════════════════════════════════════

describe("cursor reader (synced)", () => {
  // v1 header (no "Kind" column): the columns the reader maps for v1.
  const V1_HEADER =
    "Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost,Cost to you";

  it("requires sync: returns [] when NO cursor-cache exists", async () => {
    expect(await cursorReader.read({})).toEqual([]);
  });

  it("parses a v1 CSV export into one record per data row", async () => {
    // input = Input(w/o CW) = 400; cacheWrite = 500 - 400 = 100; cacheRead = 30;
    // output = 250; cost = $1.23; date-only → noon UTC.
    const csv =
      `${V1_HEADER}\n` +
      `2026-02-05,claude-sonnet-4-5,500,400,30,250,1180,$1.23,$0.00\n`;
    writeFile(join(cacheDir("cursor-cache"), "usage.csv"), csv);

    const records = await cursorReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("cursor");
    expect(r.modelId).toBe("claude-sonnet-4-5");
    expect(r.providerId).toBe("anthropic"); // inferred from the model
    expect(r.tokens.input).toBe(400); // Input (w/o Cache Write)
    expect(r.tokens.cacheWrite).toBe(100); // 500 - 400
    expect(r.tokens.cacheRead).toBe(30);
    expect(r.tokens.output).toBe(250);
    expect(r.tokens.reasoning).toBe(0); // Cursor does not report reasoning
    expect(r.cost).toBeCloseTo(1.23);
    expect(r.ts).toBe(Date.UTC(2026, 1, 5, 12, 0, 0, 0)); // date-only → noon UTC
    expect(r.sessionId).toBe("cursor-active-2026-02-05"); // usage.csv → "active"
    expect(r.dedupKey).toBe("cursor-active-2026-02-05"); // composite is the dedup key
    expect(r.confidence).toBe("host-reported");
  });

  it("skips rows with an empty model and defaults the provider to 'cursor'", async () => {
    const csv =
      `${V1_HEADER}\n` +
      `2026-02-05,,500,400,30,250,1180,$1.23,$0.00\n` + // empty model → skipped
      `2026-02-06,auto,10,8,0,2,20,Included,Included\n`; // Cursor-only id → provider "cursor"
    writeFile(join(cacheDir("cursor-cache"), "usage.csv"), csv);

    const records = await cursorReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.modelId).toBe("auto");
    expect(r.providerId).toBe("cursor"); // no family match → platform default
    expect(r.cost).toBe(0); // "Included" → 0
    expect(r.tokens.input).toBe(8);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. antigravity — <tokscale>/antigravity-cache/ ; manifest.json indexing
//    sessions/*.jsonl dumps. JSONL "session_meta" (fallback model) + "usage"
//    rows (input/output/cacheRead/cacheWrite/reasoning, epoch-ms timestamp,
//    responseId dedup). Confidence host-reported.
// ═════════════════════════════════════════════════════════════════════════

describe("antigravity reader (synced)", () => {
  it("requires sync: returns [] when NO antigravity-cache exists", async () => {
    expect(await antigravityReader.read({})).toEqual([]);
  });

  it("parses a manifest.json + sessions/*.jsonl cache into usage records", async () => {
    const root = cacheDir("antigravity-cache");
    // A manifest indexing one session artifact (relative path, inside the cache).
    const manifest = JSON.stringify([
      { artifact_path: "sessions/sess-1-abc.jsonl" },
    ]);
    writeFile(join(root, "manifest.json"), manifest);

    // The session dump: a session_meta line (fallback model) then a usage line.
    const jsonl =
      JSON.stringify({
        type: "session_meta",
        sessionId: "sess-1",
        modelId: "claude-sonnet-4.6",
      }) +
      "\n" +
      JSON.stringify({
        type: "usage",
        sessionId: "sess-1",
        timestamp: 1775000000000, // epoch ms (> 0)
        input: 120,
        output: 45,
        cacheRead: 30,
        cacheWrite: 5,
        reasoning: 8,
        responseId: "resp-1",
      }) +
      "\n";
    writeFile(join(root, "sessions", "sess-1-abc.jsonl"), jsonl);

    const records = await antigravityReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("antigravity");
    expect(r.sessionId).toBe("sess-1");
    expect(r.tokens.input).toBe(120);
    expect(r.tokens.output).toBe(45);
    expect(r.tokens.cacheRead).toBe(30);
    expect(r.tokens.cacheWrite).toBe(5);
    expect(r.tokens.reasoning).toBe(8);
    expect(r.modelId).toBe("claude-sonnet-4-6"); // alias-resolved from "claude-sonnet-4.6"
    expect(r.providerId).toBe("anthropic"); // inferred from the model
    expect(r.ts).toBe(1775000000000);
    expect(r.dedupKey).toBe("resp-1"); // from responseId
    expect(r.confidence).toBe("host-reported");
  });

  it("reads sessions/*.jsonl directly even without a manifest, and drops zero-token rows", async () => {
    const root = cacheDir("antigravity-cache");
    // No manifest.json at all — the reader still walks sessions/*.jsonl.
    const jsonl =
      JSON.stringify({
        type: "usage",
        sessionId: "sess-2",
        timestamp: 1775000111000,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
      }) + // all-zero usage → dropped
      "\n" +
      JSON.stringify({
        type: "usage",
        sessionId: "sess-2",
        timestamp: 1775000222000,
        input: 10,
        output: 3,
        responseId: "resp-2",
      }) +
      "\n";
    writeFile(join(root, "sessions", "sess-2.jsonl"), jsonl);

    const records = await antigravityReader.read({});
    expect(records).toHaveLength(1); // zero-token row dropped, one survivor
    const r = records[0]!;
    expect(r.sessionId).toBe("sess-2");
    expect(r.tokens.input).toBe(10);
    expect(r.tokens.output).toBe(3);
    expect(r.dedupKey).toBe("resp-2");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. trae — <tokscale>/trae-cache/sessions/usage-*.json (JSON array of session
//    objects the API sync caches). usage_time is epoch SECONDS → ×1000;
//    tokens via extra_info.{input,output,cache_read,cache_write}_token; cost
//    from dollar_float. dedupKey = trae:<session_id>:<usage_time>. host-reported.
// ═════════════════════════════════════════════════════════════════════════

describe("trae reader (synced)", () => {
  it("requires sync: returns [] when NO trae-cache exists", async () => {
    expect(await traeReader.read({})).toEqual([]);
  });

  it("parses a sessions/usage-*.json array into one record per session", async () => {
    const usageTimeSec = 1776000000; // epoch SECONDS
    const artifact = JSON.stringify([
      {
        model_name: "Claude Sonnet 4.6",
        mode: "Auto",
        session_id: "trae-sess-1",
        usage_time: usageTimeSec,
        dollar_float: 0.5,
        extra_info: {
          input_token: 200,
          output_token: 60,
          cache_read_token: 15,
          cache_write_token: 4,
        },
      },
    ]);
    writeFile(join(cacheDir("trae-cache"), "sessions", "usage-2026-02.json"), artifact);

    const records = await traeReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("trae");
    expect(r.modelId).toBe("claude-sonnet-4.6"); // normalized display name
    expect(r.providerId).toBe("anthropic"); // provider_for_model on "Claude …"
    expect(r.sessionId).toBe("trae-sess-1");
    expect(r.tokens.input).toBe(200);
    expect(r.tokens.output).toBe(60);
    expect(r.tokens.cacheRead).toBe(15);
    expect(r.tokens.cacheWrite).toBe(4);
    expect(r.tokens.reasoning).toBe(0); // Trae does not report reasoning
    expect(r.cost).toBeCloseTo(0.5);
    expect(r.ts).toBe(usageTimeSec * 1000); // seconds → ms
    expect(r.dedupKey).toBe(`trae:trae-sess-1:${usageTimeSec}`);
    expect(r.confidence).toBe("host-reported");
  });

  it("drops all-zero-token sessions and buckets an auto-mode (empty model) session", async () => {
    const artifact = JSON.stringify([
      {
        model_name: "",
        mode: "Auto",
        session_id: "zero-sess",
        usage_time: 1776000000,
        dollar_float: 0.0,
        extra_info: { input_token: 0, output_token: 0, cache_read_token: 0, cache_write_token: 0 },
      }, // all-zero → dropped
      {
        model_name: "", // auto-mode → bucket under "trae-<mode>"
        mode: "Auto",
        session_id: "auto-sess",
        usage_time: 1776000005,
        dollar_float: 0.27,
        extra_info: { input_token: 10, output_token: 2, cache_read_token: 0, cache_write_token: 0 },
      },
    ]);
    writeFile(join(cacheDir("trae-cache"), "sessions", "usage-auto.json"), artifact);

    const records = await traeReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.sessionId).toBe("auto-sess");
    expect(r.modelId).toBe("trae-auto"); // empty model + mode "Auto" → "trae-auto"
    expect(r.cost).toBeCloseTo(0.27);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. warp — <tokscale>/warp-cache/usage.json (aggregate-only sync artifact).
//    NO token breakdown → tokens stay 0; the spend (cents→USD) goes in `cost`
//    and the request count in `messageCount`. Confidence host-estimated.
//    Per-workspace rows preferred; account aggregate is the fallback.
// ═════════════════════════════════════════════════════════════════════════

describe("warp reader (synced, aggregate-only / host-estimated)", () => {
  it("requires sync: returns [] when NO warp-cache exists", async () => {
    expect(await warpReader.read({})).toEqual([]);
  });

  it("parses usage.json: cost set, tokens 0, host-estimated (per-workspace rows)", async () => {
    const cache = JSON.stringify({
      syncedAt: "2026-02-05T10:00:00.000Z",
      usage: { requestsUsed: 999, spendCents: 5000 }, // account aggregate (fallback only)
      workspaces: [
        { id: "ws-123", name: "My Workspace", requestsUsed: 42, spendCents: 1234 },
      ],
    });
    writeFile(join(cacheDir("warp-cache"), "usage.json"), cache);

    const records = await warpReader.read({});
    expect(records).toHaveLength(1); // workspaces present → per-workspace, not account
    const r = records[0]!;
    expect(r.platformId).toBe("warp");
    expect(r.modelId).toBe("aggregate-requests"); // synthetic — no per-model usage
    expect(r.providerId).toBe("warp");
    // NO token breakdown — every dimension is 0 (host-estimated, aggregate-only).
    expect(r.tokens.input).toBe(0);
    expect(r.tokens.output).toBe(0);
    expect(r.tokens.cacheRead).toBe(0);
    expect(r.tokens.cacheWrite).toBe(0);
    expect(r.tokens.reasoning).toBe(0);
    // Cost IS set: spendCents 1234 → $12.34. Request count in messageCount.
    expect(r.cost).toBeCloseTo(12.34);
    expect(r.messageCount).toBe(42); // requestsUsed
    expect(r.sessionId).toBe("warp-aggregate-ws-123"); // sanitized workspace id
    expect(r.projectKey).toBe("ws-123");
    expect(r.projectLabel).toBe("My Workspace");
    expect(r.ts).toBe(Date.parse("2026-02-05T10:00:00.000Z"));
    expect(r.dedupKey).toBe(`warp:warp-aggregate-ws-123:${Date.parse("2026-02-05T10:00:00.000Z")}`);
    expect(r.confidence).toBe("host-estimated");
  });

  it("falls back to a single account-level row when no workspaces are listed", async () => {
    const cache = JSON.stringify({
      syncedAt: "2026-02-05T10:00:00.000Z",
      usage: { requestsUsed: 7, spendCents: 250 },
      workspaces: [],
    });
    writeFile(join(cacheDir("warp-cache"), "usage.json"), cache);

    const records = await warpReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.sessionId).toBe("warp-aggregate-account");
    expect(r.cost).toBeCloseTo(2.5); // 250 cents
    expect(r.messageCount).toBe(7);
    expect(r.tokens.input).toBe(0);
    expect(r.confidence).toBe("host-estimated");
  });

  it("returns [] when the cache has no parseable synced timestamp", async () => {
    // syncedAt absent/garbage → timestamp <= 0 guard → no rows.
    const cache = JSON.stringify({ usage: { requestsUsed: 5, spendCents: 100 }, workspaces: [] });
    writeFile(join(cacheDir("warp-cache"), "usage.json"), cache);
    expect(await warpReader.read({})).toEqual([]);
  });
});
