/**
 * tests/usage/u3-readers — fixture-based tests for the 7 U3 SQLite usage readers
 * (opencode, goose, hermes, kilo-cli, synthetic, crush, zed).
 *
 * Each block CREATEs a tiny fixture SQLite database with sql.js (the same WASM
 * engine the production openSqlite() loader uses), exports its bytes to the exact
 * on-disk path the reader resolves under a fresh fake HOME (+ XDG_DATA_HOME /
 * HERMES_HOME / AGENT_CONNECTOR_*_DIR as each reader needs), calls the reader, and
 * asserts the extracted TokenBreakdown + confidence + dedup. Grounded in the
 * tokscale Rust parsers (crates/tokscale-core/src/sessions/{opencode,goose,hermes,
 * kilo,synthetic,crush,zed}.rs) and the design spec (docs/research/usage-readers.json).
 *
 * Platform-specific cases the design calls out:
 *   - opencode / kilo-cli : token data lives in a JSON blob in `m.data`
 *     ($.tokens.input/output/cache.read/cache.write/reasoning); dedupKey prefers
 *     the embedded $.id, else the row id.
 *   - zed : the thread payload is a ZSTD-compressed JSON BLOB; the reader
 *     decompresses it via fzstd. We compress the fixture with Node's
 *     zlib.zstdCompressSync (round-trip-compatible with fzstd.decompress).
 *   - crush : NO per-message tokens — tokens stay 0, confidence "host-estimated",
 *     and the session cost is allocated across local-day buckets.
 *
 * Every block also asserts FAIL-OPEN: a missing db → [] (the reader never throws).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import initSqlJs from "sql.js";

import opencodeReader from "../../src/usage/readers/opencode.js";
import gooseReader from "../../src/usage/readers/goose.js";
import hermesReader from "../../src/usage/readers/hermes.js";
import kiloCliReader from "../../src/usage/readers/kilo-cli.js";
import syntheticReader from "../../src/usage/readers/synthetic.js";
import crushReader from "../../src/usage/readers/crush.js";
import zedReader from "../../src/usage/readers/zed.js";
import type { UsageRecord } from "../../src/usage/types.js";

// ─────────────────────────────────────────────────────────────────────────
// sql.js fixture builder. We run a list of SQL statements against a fresh
// in-memory database and write the exported bytes to `dbPath` (mkdir -p the
// parent). The exported file carries the real "SQLite format 3\0" header, so
// the production openSqlite() magic check accepts it.
// ─────────────────────────────────────────────────────────────────────────

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>;
let SQL: SqlJsStatic;

/** Build a fixture SQLite db at `dbPath` by running `statements` in order. */
function writeSqliteDb(dbPath: string, statements: string[]): void {
  const db = new SQL.Database();
  try {
    for (const sql of statements) db.run(sql);
    const bytes = db.export();
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, Buffer.from(bytes));
  } finally {
    db.close();
  }
}

/** SQL string literal with single-quotes doubled (for embedding JSON blobs). */
function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// ─────────────────────────────────────────────────────────────────────────
// Shared fake-HOME harness. Every SQLite reader resolves its db path via
// homedir() / XDG_DATA_HOME (paths.ts), except hermes (HERMES_HOME) and
// synthetic (AGENT_CONNECTOR_SYNTHETIC_DIR or XDG_DATA_HOME/octofriend). We
// snapshot + restore every env key these readers read so no test leaks state.
// ─────────────────────────────────────────────────────────────────────────

const SAVED_ENV = [
  "HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "HERMES_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "AGENT_CONNECTOR_OPENCODE_DIR",
  "AGENT_CONNECTOR_GOOSE_DIR",
  "AGENT_CONNECTOR_HERMES_DIR",
  "AGENT_CONNECTOR_KILO_CLI_DIR",
  "AGENT_CONNECTOR_SYNTHETIC_DIR",
  "AGENT_CONNECTOR_CRUSH_DIR",
  "AGENT_CONNECTOR_ZED_DIR",
] as const;

let tmpHome: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  if (SQL === undefined) SQL = await initSqlJs();
  savedEnv = {};
  for (const key of SAVED_ENV) savedEnv[key] = process.env[key];
  tmpHome = mkdtempSync(join(tmpdir(), "ac-u3-home-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.XDG_DATA_HOME = join(tmpHome, ".local", "share");
  process.env.XDG_CONFIG_HOME = join(tmpHome, ".config");
  // Point hermes at the fake home; neutralize every other override so each test
  // starts from "db absent" unless it writes one.
  process.env.HERMES_HOME = join(tmpHome, ".hermes");
  for (const key of SAVED_ENV) {
    if (key.startsWith("AGENT_CONNECTOR_")) delete process.env[key];
  }
});

afterEach(() => {
  for (const key of SAVED_ENV) {
    const v = savedEnv[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const byInput = (a: UsageRecord, b: UsageRecord): number => a.tokens.input - b.tokens.input;

// ═════════════════════════════════════════════════════════════════════════
// 1. opencode — $XDG_DATA_HOME/opencode/opencode.db ; message.data JSON blob.
//    Tokens via $.tokens.input/output/cache.read/cache.write/reasoning.
//    dedupKey prefers embedded $.id; workspace from session.directory.
// ═════════════════════════════════════════════════════════════════════════

describe("opencode reader", () => {
  const dbPath = (): string => join(tmpHome, ".local", "share", "opencode", "opencode.db");

  /** A message-row data JSON blob (assistant, with a tokens block). */
  function msgData(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      id: "msg-1",
      role: "assistant",
      modelID: "claude-sonnet-4-5",
      providerID: "anthropic",
      time: { created: 1775000000000 },
      cost: 0.0123,
      tokens: { input: 500, output: 120, reasoning: 30, cache: { read: 40, write: 8 } },
      ...over,
    });
  }

  it("extracts the TokenBreakdown from an assistant message row", async () => {
    writeSqliteDb(dbPath(), [
      "CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT);",
      "CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);",
      `INSERT INTO session VALUES ('sess-1', '/Users/alice/opencode-json-repo');`,
      `INSERT INTO message VALUES ('row-1', 'sess-1', ${lit(msgData())});`,
    ]);

    const records = await opencodeReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("opencode");
    expect(r.tokens.input).toBe(500);
    expect(r.tokens.output).toBe(120);
    expect(r.tokens.cacheRead).toBe(40); // $.tokens.cache.read
    expect(r.tokens.cacheWrite).toBe(8); // $.tokens.cache.write
    expect(r.tokens.reasoning).toBe(30);
    expect(r.modelId).toBe("claude-sonnet-4-5");
    expect(r.providerId).toBe("anthropic");
    expect(r.sessionId).toBe("sess-1"); // m.session_id column
    expect(r.projectKey).toBe("/Users/alice/opencode-json-repo");
    expect(r.projectLabel).toBe("opencode-json-repo"); // repo-name label
    expect(r.ts).toBe(1775000000000); // $.time.created (ms)
    expect(r.cost).toBeCloseTo(0.0123);
    expect(r.dedupKey).toBe("msg-1"); // embedded $.id preferred over row id
    expect(r.confidence).toBe("host-reported");
  });

  it("DEDUP: byte-identical fork copies collapse to one row (embedded id promoted)", async () => {
    // Same fingerprint (created/model/provider/tokens/cost/agent) across two rows
    // in different sessions → one survivor. The survivor's dedupKey is promoted to
    // the embedded $.id; the conflicting workspace collapses to none.
    const data = msgData({ id: "dup-id" });
    writeSqliteDb(dbPath(), [
      "CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT);",
      "CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);",
      `INSERT INTO session VALUES ('s-a', '/repo/aaa');`,
      `INSERT INTO session VALUES ('s-b', '/repo/bbb');`,
      `INSERT INTO message VALUES ('row-a', 's-a', ${lit(data)});`,
      `INSERT INTO message VALUES ('row-b', 's-b', ${lit(data)});`,
    ]);

    const records = await opencodeReader.read({});
    expect(records).toHaveLength(1); // fork copy collapsed
    expect(records[0]!.dedupKey).toBe("dup-id");
    expect(records[0]!.projectKey).toBeUndefined(); // conflicting workspaces → none
  });

  it("falls back to the legacy schema (no session table) using data.$.path.root", async () => {
    const data = msgData({ id: "leg-1", path: { root: "/home/bob/legacy-repo" } });
    writeSqliteDb(dbPath(), [
      "CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);",
      `INSERT INTO message VALUES ('row-1', 'sess-leg', ${lit(data)});`,
    ]);

    const records = await opencodeReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.projectKey).toBe("/home/bob/legacy-repo");
    expect(records[0]!.projectLabel).toBe("legacy-repo");
  });

  it("FAIL-OPEN: returns [] when opencode.db is absent", async () => {
    expect(await opencodeReader.read({})).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. goose — $XDG_DATA_HOME/goose/sessions/sessions.db ; sessions table.
//    Flat columns; reasoning INFERRED (total - input - output). dedup = id.
// ═════════════════════════════════════════════════════════════════════════

describe("goose reader", () => {
  const dbPath = (): string =>
    join(tmpHome, ".local", "share", "goose", "sessions", "sessions.db");

  const CREATE = `CREATE TABLE sessions(
    id TEXT PRIMARY KEY, model_config_json TEXT, provider_name TEXT, created_at TEXT,
    total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
    accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER,
    accumulated_output_tokens INTEGER);`;

  it("extracts tokens, prefers accumulated_*, and INFERS reasoning", async () => {
    // accumulated_* preferred over plain *_tokens. total(700) > input(400)+output(250)
    // → reasoning inferred = 50.
    const modelCfg = JSON.stringify({ model_name: "claude-sonnet-4-5" });
    writeSqliteDb(dbPath(), [
      CREATE,
      `INSERT INTO sessions VALUES ('sess-g1', ${lit(modelCfg)}, 'anthropic',
        '2026-04-14T16:18:53Z', 999, 1, 2, 700, 400, 250);`,
    ]);

    const records = await gooseReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("goose");
    expect(r.tokens.input).toBe(400); // accumulated_input_tokens
    expect(r.tokens.output).toBe(250); // accumulated_output_tokens
    expect(r.tokens.reasoning).toBe(50); // 700 - 400 - 250 (INFERRED)
    expect(r.tokens.cacheRead).toBe(0); // Goose has no cache columns
    expect(r.tokens.cacheWrite).toBe(0);
    expect(r.modelId).toBe("claude-sonnet-4-5"); // from model_config_json.model_name
    expect(r.providerId).toBe("anthropic"); // canonical_provider(provider_name)
    expect(r.sessionId).toBe("sess-g1");
    expect(r.dedupKey).toBe("sess-g1"); // one row per session
    expect(r.ts).toBe(Date.parse("2026-04-14T16:18:53Z"));
    expect(r.confidence).toBe("host-reported");
  });

  it("skips all-zero sessions and rows without a model_config_json model_name", async () => {
    writeSqliteDb(dbPath(), [
      CREATE,
      // all-zero → skipped
      `INSERT INTO sessions VALUES ('z', ${lit(JSON.stringify({ model_name: "gpt-5" }))},
        NULL, '2026-04-14', 0, 0, 0, 0, 0, 0);`,
      // model_config_json present but no model_name → skipped (WHERE passes, parse drops)
      `INSERT INTO sessions VALUES ('nomodel', ${lit(JSON.stringify({ foo: 1 }))},
        NULL, '2026-04-14', 10, 5, 5, NULL, NULL, NULL);`,
    ]);
    expect(await gooseReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: returns [] when sessions.db is absent", async () => {
    expect(await gooseReader.read({})).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. hermes — $HERMES_HOME/state.db ; sessions table. Flat columns; cost
//    prefers actual over estimated; agent fixed "Hermes Agent". dedup = id.
// ═════════════════════════════════════════════════════════════════════════

describe("hermes reader", () => {
  const dbPath = (): string => join(tmpHome, ".hermes", "state.db");

  const CREATE = `CREATE TABLE sessions(
    id TEXT PRIMARY KEY, model TEXT, billing_provider TEXT, started_at REAL,
    message_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
    estimated_cost_usd REAL, actual_cost_usd REAL);`;

  it("extracts flat token columns, prefers actual cost, fixes agent name", async () => {
    // started_at in SECONDS (< 1e12) → ×1000. actual cost preferred over estimated.
    writeSqliteDb(dbPath(), [
      CREATE,
      `INSERT INTO sessions VALUES ('h-1', 'claude-opus-4-6', 'anthropic',
        1775000000, 7, 600, 150, 80, 12, 25, 9.99, 1.23);`,
    ]);

    const records = await hermesReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("hermes");
    expect(r.tokens.input).toBe(600);
    expect(r.tokens.output).toBe(150);
    expect(r.tokens.cacheRead).toBe(80);
    expect(r.tokens.cacheWrite).toBe(12);
    expect(r.tokens.reasoning).toBe(25);
    expect(r.modelId).toBe("claude-opus-4-6");
    expect(r.providerId).toBe("anthropic"); // canonical_provider(billing_provider)
    expect(r.sessionId).toBe("h-1");
    expect(r.dedupKey).toBe("h-1");
    expect(r.messageCount).toBe(7); // message_count column
    expect(r.cost).toBeCloseTo(1.23); // actual preferred over estimated 9.99
    expect(r.agent).toBe("Hermes Agent");
    expect(r.ts).toBe(1775000000 * 1000); // seconds → ms
    expect(r.confidence).toBe("host-reported");
  });

  it("emits a cost-only session (all tokens 0 but actual_cost > 0)", async () => {
    writeSqliteDb(dbPath(), [
      CREATE,
      `INSERT INTO sessions VALUES ('h-cost', 'gpt-5', NULL,
        1775000000000, 1, 0, 0, 0, 0, 0, NULL, 0.5);`,
    ]);

    const records = await hermesReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.cost).toBeCloseTo(0.5);
    expect(r.providerId).toBe("openai"); // inferred from gpt-5 (no billing_provider)
    expect(r.ts).toBe(1775000000000); // already ms (> 1e12)
  });

  it("skips sessions with no model and no token/cost signal", async () => {
    writeSqliteDb(dbPath(), [
      CREATE,
      // no token/cost signal → WHERE excludes it
      `INSERT INTO sessions VALUES ('h-zero', 'gpt-5', NULL, 1775000000000, 0,
        0, 0, 0, 0, 0, 0, 0);`,
      // blank model → WHERE excludes it
      `INSERT INTO sessions VALUES ('h-nomodel', '', NULL, 1775000000000, 1,
        10, 5, 0, 0, 0, 0, 0);`,
    ]);
    expect(await hermesReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: returns [] when state.db is absent", async () => {
    expect(await hermesReader.read({})).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. kilo-cli — $XDG_DATA_HOME/kilo/kilo.db ; message.data JSON blob (like
//    opencode). Tokens via $.tokens.*; session prefers $.session_id; dedup
//    prefers embedded $.id else row id. No project attribution.
// ═════════════════════════════════════════════════════════════════════════

describe("kilo-cli reader", () => {
  const dbPath = (): string => join(tmpHome, ".local", "share", "kilo", "kilo.db");

  function msgData(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      id: "kmsg-1",
      session_id: "ksess-embedded",
      role: "assistant",
      modelID: "gpt-5",
      providerID: "openai",
      time: { created: 1775000111000 },
      cost: 0.05,
      agent: "builder",
      tokens: { input: 220, output: 60, reasoning: 9, cache: { read: 18, write: 4 } },
      ...over,
    });
  }

  it("extracts the TokenBreakdown from a message.data JSON blob", async () => {
    writeSqliteDb(dbPath(), [
      "CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);",
      `INSERT INTO message VALUES ('row-1', 'ksess-col', ${lit(msgData())});`,
    ]);

    const records = await kiloCliReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("kilo-cli");
    expect(r.tokens.input).toBe(220);
    expect(r.tokens.output).toBe(60);
    expect(r.tokens.cacheRead).toBe(18); // $.tokens.cache.read
    expect(r.tokens.cacheWrite).toBe(4); // $.tokens.cache.write
    expect(r.tokens.reasoning).toBe(9);
    expect(r.modelId).toBe("gpt-5");
    expect(r.providerId).toBe("openai");
    expect(r.sessionId).toBe("ksess-embedded"); // $.session_id preferred over column
    expect(r.agent).toBe("builder"); // $.agent
    expect(r.cost).toBeCloseTo(0.05);
    expect(r.ts).toBe(1775000111000); // $.time.created (ms)
    expect(r.dedupKey).toBe("kmsg-1"); // embedded $.id preferred over row id
    expect(r.projectKey).toBeUndefined(); // no workspace in Kilo CLI schema
    expect(r.confidence).toBe("host-reported");
  });

  it("falls back to the row id for dedup and the column for session when JSON omits them", async () => {
    // No $.id, no $.session_id, no time block → dedup=row id, session=column,
    // ts=db file mtime (a positive number).
    const data = JSON.stringify({
      role: "assistant",
      modelID: "gpt-5",
      tokens: { input: 10, output: 2, cache: { read: 0, write: 0 } },
    });
    writeSqliteDb(dbPath(), [
      "CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);",
      `INSERT INTO message VALUES ('row-xyz', 'ksess-col', ${lit(data)});`,
    ]);

    const records = await kiloCliReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.dedupKey).toBe("row-xyz"); // fallback to m.id
    expect(r.sessionId).toBe("ksess-col"); // fallback to m.session_id column
    expect(r.providerId).toBe("openai"); // inferred from gpt-5 (no providerID)
    expect(r.ts).toBeGreaterThan(0); // db file mtime fallback
  });

  it("FAIL-OPEN: returns [] when kilo.db is absent", async () => {
    expect(await kiloCliReader.read({})).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5. synthetic — $XDG_DATA_HOME/octofriend/sqlite.db ; messages table (full)
//    with token_usage fallback. Model normalization strips hf: / accounts/…
//    prefixes. dedup = id. Confidence "host-estimated" (spec rates medium).
// ═════════════════════════════════════════════════════════════════════════

describe("synthetic reader", () => {
  const dbPath = (): string => join(tmpHome, ".local", "share", "octofriend", "sqlite.db");

  it("parses the messages table and normalizes the hf: gateway model prefix", async () => {
    writeSqliteDb(dbPath(), [
      `CREATE TABLE messages(id TEXT PRIMARY KEY, model TEXT, input_tokens INTEGER,
        output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        reasoning_tokens INTEGER, cost REAL, timestamp REAL, session_id TEXT, provider TEXT);`,
      `INSERT INTO messages VALUES ('m-1', 'hf:deepseek-ai/DeepSeek-V3-0324',
        300, 80, 20, 5, 7, 0.02, 1775000000, 'syn-sess', 'synthetic');`,
    ]);

    const records = await syntheticReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("synthetic");
    expect(r.tokens.input).toBe(300);
    expect(r.tokens.output).toBe(80);
    expect(r.tokens.cacheRead).toBe(20);
    expect(r.tokens.cacheWrite).toBe(5);
    expect(r.tokens.reasoning).toBe(7);
    expect(r.modelId).toBe("deepseek-v3-0324"); // hf: + org prefix stripped, lowercased
    expect(r.providerId).toBe("deepseek"); // inferred from cleaned model
    expect(r.sessionId).toBe("syn-sess");
    expect(r.cost).toBeCloseTo(0.02);
    expect(r.ts).toBe(1775000000 * 1000); // seconds → ms
    expect(r.dedupKey).toBe("m-1");
    expect(r.confidence).toBe("host-estimated"); // spec rates this source medium
  });

  it("falls back to the token_usage table when messages yields no rows", async () => {
    writeSqliteDb(dbPath(), [
      // messages table exists but is empty → fallback to token_usage
      `CREATE TABLE messages(id TEXT PRIMARY KEY, model TEXT, input_tokens INTEGER,
        output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        reasoning_tokens INTEGER, cost REAL, timestamp REAL, session_id TEXT, provider TEXT);`,
      `CREATE TABLE token_usage(id TEXT PRIMARY KEY, model TEXT, input_tokens INTEGER,
        output_tokens INTEGER, timestamp REAL, session_id TEXT);`,
      `INSERT INTO token_usage VALUES ('tu-1', 'accounts/fireworks/models/deepseek-v3-0324',
        50, 10, 1775000005000, 'tu-sess');`,
    ]);

    const records = await syntheticReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.tokens.input).toBe(50);
    expect(r.tokens.output).toBe(10);
    expect(r.tokens.cacheRead).toBe(0); // token_usage has no cache columns
    expect(r.modelId).toBe("deepseek-v3-0324"); // accounts/…/models/ prefix stripped
    expect(r.sessionId).toBe("tu-sess");
    expect(r.ts).toBe(1775000005000); // already ms
    expect(r.confidence).toBe("host-estimated");
  });

  it("returns [] when no token-tracking table exists (future-proofing guard)", async () => {
    writeSqliteDb(dbPath(), [
      "CREATE TABLE input_history(id TEXT PRIMARY KEY, text TEXT);",
      `INSERT INTO input_history VALUES ('i-1', 'hi');`,
    ]);
    expect(await syntheticReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: returns [] when the octofriend sqlite.db is absent", async () => {
    expect(await syntheticReader.read({})).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 6. crush — ~/.cache/crush/crush.db ; sessions + messages.
//    NO per-message tokens (all 0). confidence "host-estimated", cost set,
//    allocated across local-day buckets of assistant messages.
// ═════════════════════════════════════════════════════════════════════════

describe("crush reader", () => {
  const dbPath = (): string => join(tmpHome, ".cache", "crush", "crush.db");

  const CREATE = [
    `CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT,
      message_count INTEGER, cost REAL, created_at INTEGER, updated_at INTEGER);`,
    `CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, role TEXT, created_at INTEGER);`,
  ];

  it("CRUSH: tokens are 0, confidence host-estimated, cost allocated to a day bucket", async () => {
    // One root session with 2 assistant messages on the same local day. Tokens are
    // 0 (Crush exposes no reliable per-message breakdown); the whole cost lands in
    // the single day bucket. Use ms-precision timestamps to avoid ×1000 ambiguity.
    const tsMs = 1775000000000;
    writeSqliteDb(dbPath(), [
      ...CREATE,
      `INSERT INTO sessions VALUES ('root-1', NULL, 2, 4.5, ${tsMs}, ${tsMs + 5000});`,
      `INSERT INTO messages VALUES ('a1', 'root-1', 'assistant', ${tsMs});`,
      `INSERT INTO messages VALUES ('a2', 'root-1', 'assistant', ${tsMs + 1000});`,
      `INSERT INTO messages VALUES ('u1', 'root-1', 'user', ${tsMs + 500});`,
    ]);

    const records = await crushReader.read({});
    expect(records).toHaveLength(1); // both assistant msgs fall in one local-day bucket
    const r = records[0]!;
    expect(r.platformId).toBe("crush");
    // ALL token dimensions are 0 — Crush does not report per-message tokens.
    expect(r.tokens.input).toBe(0);
    expect(r.tokens.output).toBe(0);
    expect(r.tokens.cacheRead).toBe(0);
    expect(r.tokens.cacheWrite).toBe(0);
    expect(r.tokens.reasoning).toBe(0);
    expect(r.modelId).toBe("session-total");
    expect(r.providerId).toBe("crush");
    expect(r.sessionId).toBe(`${dbPath()}:root-1`); // <db_path>:<root_session_id>
    expect(r.cost).toBeCloseTo(4.5); // full session cost in the one bucket
    expect(r.messageCount).toBe(2); // assistant message count
    expect(r.confidence).toBe("host-estimated"); // cost real, tokens not reported
  });

  it("CRUSH: a costed root session with no assistant messages emits one cost-only row", async () => {
    const tsMs = 1775000000000;
    writeSqliteDb(dbPath(), [
      ...CREATE,
      `INSERT INTO sessions VALUES ('root-empty', NULL, 0, 2.0, ${tsMs}, ${tsMs + 1000});`,
    ]);

    const records = await crushReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.cost).toBeCloseTo(2.0);
    expect(r.messageCount).toBe(0); // no assistant messages
    expect(r.ts).toBe(tsMs + 1000); // fallback updated_at
    expect(r.tokens.input).toBe(0);
    expect(r.confidence).toBe("host-estimated");
  });

  it("FAIL-OPEN: returns [] when crush.db is absent", async () => {
    expect(await crushReader.read({})).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 7. zed — $XDG_DATA_HOME/zed/threads/threads.db ; threads table with a
//    ZSTD-compressed JSON BLOB in `data`. Only provider == "zed.dev" rows.
//    Tokens summed from request_token_usage. dedup = "zed:"+id.
// ═════════════════════════════════════════════════════════════════════════

describe("zed reader", () => {
  const dbPath = (): string => join(tmpHome, ".local", "share", "zed", "threads", "threads.db");

  /** Build a threads fixture; `payload` is the JSON object, compressed per dataType. */
  function writeThreadsDb(
    rows: Array<{
      id: string;
      updatedAt: string;
      createdAt?: string;
      folderPaths?: string;
      folderPathsOrder?: string;
      dataType: "json" | "zstd";
      payload: unknown;
    }>,
  ): void {
    const stmts = [
      `CREATE TABLE threads(id TEXT PRIMARY KEY, updated_at TEXT, created_at TEXT,
        folder_paths TEXT, folder_paths_order TEXT, data_type TEXT, data BLOB);`,
    ];
    for (const row of rows) {
      const json = Buffer.from(JSON.stringify(row.payload), "utf8");
      const bytes = row.dataType === "zstd" ? Buffer.from(zstdCompressSync(json)) : json;
      // Embed the BLOB via a hex literal so sql.js stores raw bytes.
      const hex = bytes.toString("hex");
      const createdAt = row.createdAt === undefined ? "NULL" : lit(row.createdAt);
      const folderPaths = row.folderPaths === undefined ? "NULL" : lit(row.folderPaths);
      const folderOrder = row.folderPathsOrder === undefined ? "NULL" : lit(row.folderPathsOrder);
      stmts.push(
        `INSERT INTO threads VALUES (${lit(row.id)}, ${lit(row.updatedAt)}, ${createdAt}, ` +
          `${folderPaths}, ${folderOrder}, ${lit(row.dataType)}, x'${hex}');`,
      );
    }
    writeSqliteDb(dbPath(), stmts);
  }

  it("decompresses a ZSTD JSON blob and sums request_token_usage", async () => {
    writeThreadsDb([
      {
        id: "thread-z1",
        updatedAt: "2026-04-14T16:18:53Z",
        createdAt: "2026-04-14T16:00:00Z",
        folderPaths: "/home/me/proj-a\n/home/me/proj-b",
        folderPathsOrder: "1,0", // index 1 has order 0 → proj-b wins
        dataType: "zstd",
        payload: {
          model: { provider: "zed.dev", model: "claude-sonnet-4-5" },
          request_token_usage: {
            "req-1": {
              input_tokens: 100,
              output_tokens: 20,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 4,
            },
            "req-2": {
              input_tokens: 50,
              output_tokens: 8,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
      },
    ]);

    const records = await zedReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("zed");
    expect(r.tokens.input).toBe(150); // 100 + 50
    expect(r.tokens.output).toBe(28); // 20 + 8
    expect(r.tokens.cacheRead).toBe(10);
    expect(r.tokens.cacheWrite).toBe(4); // cache_creation_input_tokens
    expect(r.tokens.reasoning).toBe(0); // Zed has no reasoning field
    expect(r.modelId).toBe("claude-sonnet-4-5");
    expect(r.providerId).toBe("zed.dev"); // hard-coded hosted provider
    expect(r.sessionId).toBe("thread-z1");
    expect(r.messageCount).toBe(2); // two positive request_token_usage entries
    expect(r.dedupKey).toBe("zed:thread-z1");
    expect(r.ts).toBe(Date.parse("2026-04-14T16:00:00Z")); // created_at preferred
    expect(r.projectKey).toBe("/home/me/proj-b"); // folder_paths_order index 1 wins
    expect(r.projectLabel).toBe("proj-b");
    expect(r.confidence).toBe("host-reported");
  });

  it("handles a plain (data_type=json) blob and the cumulative_token_usage fallback", async () => {
    writeThreadsDb([
      {
        id: "thread-z2",
        updatedAt: "2026-04-14T16:18:53Z",
        dataType: "json",
        payload: {
          model: { provider: "zed.dev", model: "claude-opus-4-6" },
          request_token_usage: {}, // empty → fall back to cumulative
          cumulative_token_usage: {
            input_tokens: 999,
            output_tokens: 111,
            cache_read_input_tokens: 22,
            cache_creation_input_tokens: 3,
          },
        },
      },
    ]);

    const records = await zedReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.tokens.input).toBe(999);
    expect(r.tokens.output).toBe(111);
    expect(r.tokens.cacheRead).toBe(22);
    expect(r.tokens.cacheWrite).toBe(3);
    expect(r.messageCount).toBe(1); // cumulative → single message
    expect(r.ts).toBe(Date.parse("2026-04-14T16:18:53Z")); // updated_at (no created_at)
  });

  it("skips non-hosted (external provider) and imported threads", async () => {
    writeThreadsDb([
      {
        id: "external",
        updatedAt: "2026-04-14T16:18:53Z",
        dataType: "json",
        payload: {
          model: { provider: "anthropic", model: "claude-sonnet-4-5" }, // not zed.dev
          cumulative_token_usage: { input_tokens: 100, output_tokens: 20 },
        },
      },
      {
        id: "imported",
        updatedAt: "2026-04-14T16:18:53Z",
        dataType: "json",
        payload: {
          imported: true,
          model: { provider: "zed.dev", model: "claude-sonnet-4-5" },
          cumulative_token_usage: { input_tokens: 100, output_tokens: 20 },
        },
      },
    ]);
    expect(await zedReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: returns [] when threads.db is absent", async () => {
    expect(await zedReader.read({})).toEqual([]);
  });
});
