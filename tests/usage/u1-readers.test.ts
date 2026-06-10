/**
 * tests/usage/u1-readers — fixture-based tests for the 7 U1 JSONL usage readers
 * (claude-code, codex, gemini-cli, copilot-cli, pi, kimi, openclaw).
 *
 * Each block writes a tiny synthetic session log in the platform's NATIVE on-disk
 * shape under a fresh fake HOME (and any platform-specific env override), calls the
 * reader, and asserts the extracted TokenBreakdown. The CRITICAL cases exercise the
 * per-platform DEDUP that prevents double-counting (grounded in the tokscale Rust
 * parser tests):
 *   - claude-code : two streamed lines with the SAME message.id + requestId carrying
 *                   cumulative counts → per-field MAX (not sum).
 *   - codex       : two token_count turns with cumulative total_token_usage →
 *                   per-turn DELTA from last_token_usage (not double count).
 *   - kimi        : two progressive StatusUpdates with the same message_id → MAX.
 *   - copilot-cli : a chat span + an inference log sharing one trace_id → the
 *                   inference lane is suppressed (counted once); the surviving
 *                   record carries the stable "trace_id:span_id" dedupKey.
 *
 * Every block also asserts FAIL-OPEN: a missing root yields [], and a malformed
 * JSONL line is skipped (the reader never throws).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import claudeCodeReader from "../../src/usage/readers/claude-code.js";
import codexReader from "../../src/usage/readers/codex.js";
import geminiReader from "../../src/usage/readers/gemini-cli.js";
import copilotReader from "../../src/usage/readers/copilot-cli.js";
import piReader from "../../src/usage/readers/pi.js";
import kimiReader from "../../src/usage/readers/kimi.js";
import openclawReader from "../../src/usage/readers/openclaw.js";
import type { UsageRecord } from "../../src/usage/types.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fake-HOME harness. Every reader resolves its root via os.homedir(),
// which honors process.env.HOME on POSIX. We also snapshot + restore the
// platform-specific env overrides the readers read (KIMI_CODE_HOME,
// PI_CODING_AGENT_DIR, XDG_*), so no test leaks state into another.
// ─────────────────────────────────────────────────────────────────────────

const SAVED_ENV = [
  "HOME",
  "KIMI_CODE_HOME",
  "PI_CODING_AGENT_DIR",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "AGENTCONNECT_OPENCLAW_DIR",
] as const;

let tmpHome: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of SAVED_ENV) savedEnv[key] = process.env[key];
  tmpHome = mkdtempSync(join(tmpdir(), "ac-u1-home-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // Neutralize overrides so each reader resolves under the fake HOME by default.
  delete process.env.KIMI_CODE_HOME;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.AGENTCONNECT_OPENCLAW_DIR;
  // Pin XDG so copilot-cli resolves under the fake HOME deterministically.
  process.env.XDG_DATA_HOME = join(tmpHome, ".local", "share");
  process.env.XDG_CONFIG_HOME = join(tmpHome, ".config");
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

/** Write a JSONL file (one JSON value per line) at an absolute path, mkdir -p first. */
function writeJsonl(dir: string, name: string, lines: unknown[]): void {
  mkdirSync(dir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(dir, name), body, "utf8");
}

/** Write a raw text JSONL file (for malformed-line cases). */
function writeRaw(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, "utf8");
}

const byInput = (a: UsageRecord, b: UsageRecord): number => a.tokens.input - b.tokens.input;

// ═════════════════════════════════════════════════════════════════════════
// 1. claude-code  — ~/.claude/projects/<key>/*.jsonl ; message.usage.*
//    DEDUP: messageId:requestId streaming duplicates → per-field MAX.
// ═════════════════════════════════════════════════════════════════════════

describe("claude-code reader", () => {
  const projectsDir = (): string => join(tmpHome, ".claude", "projects", "-Users-me-proj");

  it("extracts the TokenBreakdown from a representative assistant record", async () => {
    writeJsonl(projectsDir(), "session-1.jsonl", [
      {
        type: "assistant",
        timestamp: "2026-01-15T10:00:00.000Z",
        requestId: "req_001",
        message: {
          id: "msg_001",
          model: "claude-sonnet-4-5",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
          },
        },
      },
    ]);

    const records = await claudeCodeReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("claude-code");
    expect(r.tokens.input).toBe(100);
    expect(r.tokens.output).toBe(50);
    expect(r.tokens.cacheRead).toBe(10);
    expect(r.tokens.cacheWrite).toBe(5);
    expect(r.tokens.reasoning).toBe(0); // CC never reports reasoning
    expect(r.providerId).toBe("anthropic");
    expect(r.confidence).toBe("host-reported");
    expect(r.dedupKey).toBe("msg_001:req_001");
    // The project key is the dir-name-encoded cwd kept verbatim (the Rust
    // normalize_workspace_key/workspace_label_from_key keep it as-is); since the
    // encoded key has no `/`, its last-segment label equals the key itself.
    expect(r.projectKey).toBe("-Users-me-proj");
    expect(r.projectLabel).toBe("-Users-me-proj");
  });

  it("DEDUP: merges streaming duplicates (same message.id+requestId) via PER-FIELD MAX, not sum", async () => {
    // Two writes of the SAME logical message; CC's streaming API rewrites it with
    // cumulative counts. Summing would give input 60 / output 200 / cacheRead 25.
    // Per-field max must give input 50 / output 100 / cacheRead 20.
    writeJsonl(projectsDir(), "session-2.jsonl", [
      {
        type: "assistant",
        timestamp: "2026-01-15T10:00:00.000Z",
        requestId: "req_001",
        message: {
          id: "msg_001",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 5 },
        },
      },
      {
        type: "assistant",
        timestamp: "2026-01-15T10:00:00.100Z",
        requestId: "req_001",
        message: {
          id: "msg_001",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 50, output_tokens: 100, cache_read_input_tokens: 20 },
        },
      },
    ]);

    const records = await claudeCodeReader.read({});
    expect(records).toHaveLength(1); // one logical message
    const r = records[0]!;
    expect(r.tokens.input).toBe(50); // max(10, 50)
    expect(r.tokens.output).toBe(100); // max(100, 100)
    expect(r.tokens.cacheRead).toBe(20); // max(5, 20)
  });

  it("DEDUP: a higher first chunk then a lower late chunk still keeps the MAX", async () => {
    writeJsonl(projectsDir(), "session-3.jsonl", [
      {
        type: "assistant",
        timestamp: "2026-01-15T10:00:00.000Z",
        requestId: "req_001",
        message: { id: "msg_001", model: "claude-sonnet-4-5", usage: { input_tokens: 100, output_tokens: 500 } },
      },
      {
        type: "assistant",
        timestamp: "2026-01-15T10:00:00.100Z",
        requestId: "req_001",
        message: { id: "msg_001", model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 100 } },
      },
    ]);

    const records = await claudeCodeReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(100);
    expect(records[0]!.tokens.output).toBe(500);
  });

  it("keeps DISTINCT requestIds as separate records (no over-merge)", async () => {
    writeJsonl(projectsDir(), "session-4.jsonl", [
      {
        type: "assistant",
        requestId: "req_001",
        message: { id: "msg_001", model: "claude-sonnet-4-5", usage: { input_tokens: 100, output_tokens: 50 } },
      },
      {
        type: "assistant",
        requestId: "req_002",
        message: { id: "msg_002", model: "claude-sonnet-4-5", usage: { input_tokens: 200, output_tokens: 100 } },
      },
    ]);

    const records = await claudeCodeReader.read({});
    expect(records).toHaveLength(2);
    const inputs = records.map((r) => r.tokens.input).sort((a, b) => a - b);
    expect(inputs).toEqual([100, 200]);
  });

  it("FAIL-OPEN: returns [] when ~/.claude/projects is absent", async () => {
    expect(await claudeCodeReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: skips a malformed JSONL line without throwing", async () => {
    const good = JSON.stringify({
      type: "assistant",
      requestId: "req_001",
      message: { id: "msg_001", model: "claude-sonnet-4-5", usage: { input_tokens: 12, output_tokens: 3 } },
    });
    writeRaw(projectsDir(), "session-bad.jsonl", `{ not valid json\n${good}\n`);

    const records = await claudeCodeReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(12);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. codex — ~/.codex/sessions/**/*.jsonl ; payload.info.{last,total}_token_usage
//    DEDUP: cumulative total_token_usage → per-turn DELTA from last_token_usage.
// ═════════════════════════════════════════════════════════════════════════

describe("codex reader", () => {
  const sessDir = (): string => join(tmpHome, ".codex", "sessions", "2026", "01", "15");

  /** A token_count event with a cumulative total and a per-turn last delta. */
  const tokenCount = (
    ts: string,
    total: Record<string, number>,
    last: Record<string, number>,
  ): unknown => ({
    timestamp: ts,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
  });

  it("extracts the TokenBreakdown from the first token_count (cached netted out of input)", async () => {
    // input 100 includes 20 cached → net input 80, cacheRead 20, output 30, reasoning 5.
    writeJsonl(sessDir(), "rollout-a.jsonl", [
      { type: "session_meta", payload: { type: "session_meta", model_provider: "openai", cwd: "/Users/me/proj" } },
      { type: "turn_context", payload: { type: "turn_context", model: "gpt-5-codex" } },
      tokenCount(
        "2026-01-15T10:00:00Z",
        { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5 },
        { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5 },
      ),
    ]);

    const records = await codexReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("codex");
    expect(r.tokens.input).toBe(80); // 100 - 20 cached
    expect(r.tokens.cacheRead).toBe(20);
    expect(r.tokens.output).toBe(30);
    expect(r.tokens.reasoning).toBe(5);
    expect(r.tokens.cacheWrite).toBe(0);
    expect(r.modelId).toBe("gpt-5-codex");
    expect(r.providerId).toBe("openai");
    expect(r.projectLabel).toBe("proj");
    expect(r.confidence).toBe("host-reported");
    expect(r.dedupKey).toBeDefined(); // real timestamp present
  });

  it("DEDUP: two cumulative turns yield the per-turn DELTA, not a double count", async () => {
    // total goes 100→110 cumulatively; the SECOND turn's increment is last_token_usage
    // (input 10, output 3, etc.), NOT the full cumulative 110.
    writeJsonl(sessDir(), "rollout-b.jsonl", [
      { type: "session_meta", payload: { type: "session_meta", model_provider: "openai" } },
      { type: "turn_context", payload: { type: "turn_context", model: "gpt-5-codex" } },
      tokenCount(
        "2026-01-15T10:00:00Z",
        { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5 },
        { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5 },
      ),
      tokenCount(
        "2026-01-15T10:00:01Z",
        { input_tokens: 110, cached_input_tokens: 22, output_tokens: 33, reasoning_output_tokens: 6 },
        { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 },
      ),
    ]);

    const records = await codexReader.read({}).then((rs) => rs.slice().sort(byInput));
    expect(records).toHaveLength(2);

    // Turn 1: net input 80, cacheRead 20, output 30, reasoning 5.
    // Turn 2 uses last_token_usage {10,2,3,1}: net input 8, cacheRead 2, output 3, reasoning 1.
    const t2 = records[0]!; // smaller input
    const t1 = records[1]!;
    expect(t1.tokens.input).toBe(80);
    expect(t1.tokens.output).toBe(30);
    expect(t2.tokens.input).toBe(8); // 10 - 2 cached  (NOT 110-22)
    expect(t2.tokens.cacheRead).toBe(2);
    expect(t2.tokens.output).toBe(3);
    expect(t2.tokens.reasoning).toBe(1);

    // The grand total of OUTPUT across both rows is 33 (30 + 3), i.e. the final
    // cumulative — proving no double count.
    const totalOutput = records.reduce((s, r) => s + r.tokens.output, 0);
    expect(totalOutput).toBe(33);
  });

  it("DEDUP: an identical repeated cumulative snapshot is skipped (no duplicate row)", async () => {
    writeJsonl(sessDir(), "rollout-c.jsonl", [
      { type: "session_meta", payload: { type: "session_meta", model_provider: "openai" } },
      { type: "turn_context", payload: { type: "turn_context", model: "gpt-5-codex" } },
      tokenCount(
        "2026-01-15T10:00:00Z",
        { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5 },
        { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5 },
      ),
      // Identical cumulative total as the previous baseline → duplicate snapshot.
      tokenCount(
        "2026-01-15T10:00:01Z",
        { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5 },
        { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5 },
      ),
    ]);

    const records = await codexReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.output).toBe(30);
  });

  it("FAIL-OPEN: returns [] when ~/.codex/sessions is absent", async () => {
    expect(await codexReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: skips a malformed JSONL line without throwing", async () => {
    const good = JSON.stringify(
      tokenCount(
        "2026-01-15T10:00:00Z",
        { input_tokens: 50, cached_input_tokens: 0, output_tokens: 12 },
        { input_tokens: 50, cached_input_tokens: 0, output_tokens: 12 },
      ),
    );
    const ctx = JSON.stringify({ type: "turn_context", payload: { type: "turn_context", model: "gpt-5-codex" } });
    writeRaw(sessDir(), "rollout-bad.jsonl", `${ctx}\n{ bad json here\n${good}\n`);

    const records = await codexReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(50);
    expect(records[0]!.tokens.output).toBe(12);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. gemini-cli — ~/.gemini/tmp/<id>/chats/<file> ; message.tokens.* (+ session-*)
//    DEDUP: direct-token events with the same `id` → last-wins replacement.
// ═════════════════════════════════════════════════════════════════════════

describe("gemini-cli reader", () => {
  const chatsDir = (id = "sess-1"): string => join(tmpHome, ".gemini", "tmp", id, "chats");

  it("extracts the TokenBreakdown from a structured session-*.json record (tool folded into input)", async () => {
    // Canonical structured-message shape (tokscale gemini.rs alias list):
    // input/output/cached/thoughts/tool/total. `tool` is folded into input after
    // normalization. total(15848) == input(14918)+output(60)+reasoning(863)+tool(7),
    // so the cached overlap (0 here) is a no-op and input = 14918 + 7 = 14925.
    writeRaw(
      join(tmpHome, ".gemini", "tmp", "sess-1", "chats"),
      "session-x.json",
      JSON.stringify({
        sessionId: "gemini-session-1",
        projectHash: "h",
        startTime: "2026-01-15T10:00:00.000Z",
        lastUpdated: "2026-01-15T10:00:00.000Z",
        messages: [
          {
            type: "gemini",
            model: "gemini-3.1-pro-preview",
            timestamp: "2026-01-15T10:00:00.000Z",
            tokens: { input: 14918, output: 60, cached: 0, thoughts: 863, tool: 7, total: 15848 },
          },
        ],
      }),
    );

    const records = await geminiReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("gemini-cli");
    expect(r.providerId).toBe("google");
    expect(r.modelId).toBe("gemini-3.1-pro-preview");
    expect(r.sessionId).toBe("gemini-session-1");
    expect(r.tokens.input).toBe(14925); // 14918 + tool 7
    expect(r.tokens.output).toBe(60);
    expect(r.tokens.cacheRead).toBe(0);
    expect(r.tokens.reasoning).toBe(863); // from `thoughts`
    expect(r.tokens.cacheWrite).toBe(0);
    expect(r.confidence).toBe("host-reported");
  });

  it("nets cached out of input when total equals the cache-EXCLUSIVE sum", async () => {
    // total(140) == input(100)+output(40)+reasoning(0)+tool(0), i.e. cached(30) is
    // NOT inside input, so it is subtracted: net input 100-30 = 70 (cached intact).
    writeRaw(
      join(tmpHome, ".gemini", "tmp", "sess-2", "chats"),
      "session-y.json",
      JSON.stringify({
        sessionId: "sess-2",
        projectHash: "h",
        startTime: "2026-01-15T10:00:00.000Z",
        lastUpdated: "2026-01-15T10:00:00.000Z",
        messages: [
          {
            type: "gemini",
            model: "gemini-2.5-pro",
            timestamp: "2026-01-15T10:00:00.000Z",
            tokens: { input: 100, output: 40, cached: 30, total: 140 },
          },
        ],
      }),
    );

    const records = await geminiReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(70);
    expect(records[0]!.tokens.cacheRead).toBe(30);
  });

  it("DEDUP: headless JSONL direct-token events with the same id are last-wins", async () => {
    writeJsonl(chatsDir("sess-3"), "stream.jsonl", [
      { type: "init", model: "gemini-2.5-flash", session_id: "sess-3" },
      { type: "gemini", id: "evt-1", tokens: { input: 100, output: 10 } }, // superseded
      { type: "gemini", id: "evt-1", tokens: { input: 100, output: 55 } }, // wins (same id)
      { type: "gemini", id: "evt-2", tokens: { input: 200, output: 20 } }, // distinct id
    ]);

    const records = await geminiReader.read({}).then((rs) => rs.slice().sort(byInput));
    expect(records).toHaveLength(2); // evt-1 (deduped) + evt-2
    const evt1 = records[0]!;
    const evt2 = records[1]!;
    expect(evt1.tokens.input).toBe(100);
    expect(evt1.tokens.output).toBe(55); // last-wins value, not 10 and not 65
    expect(evt1.dedupKey).toBe("sess-3:evt-1");
    expect(evt2.tokens.input).toBe(200);
  });

  it("rejects a non-session file outside the .../tmp/<id>/chats/ layout", async () => {
    // A stray .json directly under tmp/<id> (not in chats/) and not named session-*
    // must be ignored by the path filter.
    writeRaw(
      join(tmpHome, ".gemini", "tmp", "sess-4"),
      "stray.json",
      JSON.stringify({ type: "gemini", model: "gemini-2.5-pro", tokens: { input: 999, output: 999 } }),
    );
    expect(await geminiReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: returns [] when ~/.gemini/tmp is absent", async () => {
    expect(await geminiReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: skips a malformed JSONL line without throwing", async () => {
    const good = JSON.stringify({ type: "gemini", id: "g1", model: "gemini-2.5-pro", tokens: { input: 12, output: 3 } });
    writeRaw(chatsDir("sess-5"), "stream-bad.jsonl", `{ broken\n${good}\n`);

    const records = await geminiReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(12);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. copilot-cli — <XDG_DATA_HOME>/Copilot/telemetry/*.jsonl ; OTEL records
//    DEDUP: chat span + inference log sharing one trace_id → inference suppressed.
// ═════════════════════════════════════════════════════════════════════════

describe("copilot-cli reader", () => {
  const telemetryDir = (): string => join(tmpHome, ".local", "share", "Copilot", "telemetry");

  it("extracts the TokenBreakdown from a chat span (net input = input - cacheRead)", async () => {
    writeJsonl(telemetryDir(), "otel-1.jsonl", [
      {
        type: "span",
        traceId: "trace-cache",
        spanId: "span-cache",
        name: "chat gpt-5.4",
        endTime: [1775934264, 967317833],
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.response.model": "gpt-5.4",
          "gen_ai.usage.input_tokens": 1000, // inclusive of cache reads
          "gen_ai.usage.output_tokens": 20,
          "gen_ai.usage.cache_read.input_tokens": 200,
          "gen_ai.usage.cache_write.input_tokens": 50,
        },
      },
    ]);

    const records = await copilotReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("copilot-cli");
    expect(r.tokens.input).toBe(800); // 1000 - 200 cacheRead
    expect(r.tokens.output).toBe(20);
    expect(r.tokens.cacheRead).toBe(200);
    expect(r.tokens.cacheWrite).toBe(50);
    expect(r.providerId).toBe("openai"); // gpt-5.4 → openai
    expect(r.confidence).toBe("host-reported");
    expect(r.dedupKey).toBe("trace-cache:span-cache");
  });

  it("DEDUP: a chat span + an inference log sharing one trace_id is counted ONCE (inference suppressed)", async () => {
    writeJsonl(telemetryDir(), "otel-dupe.jsonl", [
      {
        type: "span",
        traceId: "trace-dupe",
        spanId: "span-chat",
        name: "chat gpt-5.4-mini",
        endTime: [1775934264, 0],
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.response.model": "gpt-5.4-mini",
          "gen_ai.response.id": "resp-dupe",
          "gen_ai.usage.input_tokens": 100,
          "gen_ai.usage.output_tokens": 30,
        },
      },
      {
        // Same response, lower-priority lane → suppressed by trace_id match.
        hrTime: [1775934264, 0],
        spanContext: { traceId: "trace-dupe", spanId: "span-log", traceFlags: 1 },
        attributes: {
          "event.name": "gen_ai.client.inference.operation.details",
          "gen_ai.response.model": "gpt-5.4-mini",
          "gen_ai.response.id": "resp-dupe",
          "gen_ai.usage.input_tokens": 100,
          "gen_ai.usage.output_tokens": 30,
        },
        _body: "GenAI inference: gpt-5.4-mini",
      },
    ]);

    const records = await copilotReader.read({});
    expect(records).toHaveLength(1); // inference log dropped
    const r = records[0]!;
    expect(r.tokens.input).toBe(100); // counted once, not 200
    expect(r.tokens.output).toBe(30);
    expect(r.dedupKey).toBe("trace-dupe:span-chat"); // the surviving chat-span key
  });

  it("clamps cacheRead used for input to <= input, keeping the reported bucket intact", async () => {
    writeJsonl(telemetryDir(), "otel-clamp.jsonl", [
      {
        type: "span",
        traceId: "trace-clamp",
        spanId: "span-clamp",
        name: "chat gpt-5.4-mini",
        endTime: [1775934264, 0],
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.response.model": "gpt-5.4-mini",
          "gen_ai.usage.input_tokens": 100,
          "gen_ai.usage.output_tokens": 5,
          "gen_ai.usage.cache_read.input_tokens": 90,
          "gen_ai.usage.cache_write.input_tokens": 20,
        },
      },
    ]);

    const records = await copilotReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(10); // 100 - 90
    expect(records[0]!.tokens.cacheRead).toBe(90); // bucket kept intact
    expect(records[0]!.tokens.cacheWrite).toBe(20);
  });

  it("FAIL-OPEN: returns [] when the telemetry root is absent", async () => {
    expect(await copilotReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: skips a malformed JSONL line without throwing", async () => {
    const good = JSON.stringify({
      type: "span",
      traceId: "trace-ok",
      spanId: "span-ok",
      name: "chat gpt-5.4-mini",
      endTime: [1775934264, 0],
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.response.model": "gpt-5.4-mini",
        "gen_ai.usage.input_tokens": 12,
        "gen_ai.usage.output_tokens": 3,
      },
    });
    writeRaw(telemetryDir(), "otel-bad.jsonl", `not json at all\n${good}\n`);

    const records = await copilotReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(12);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5. pi — ~/.pi/agent/sessions/<encoded-cwd>/*.jsonl ; message.usage.* (+ env override)
//    No host dedup; synthesizes <platformId>:<sessionId>:<lineIndex> dedupKey.
// ═════════════════════════════════════════════════════════════════════════

describe("pi reader", () => {
  /** A Pi session file: header line + assistant message line(s). */
  function writePiSession(dir: string, name: string, sessionId: string, cwd: string, entries: unknown[]): void {
    writeJsonl(dir, name, [{ type: "session", id: sessionId, cwd, timestamp: "2026-01-15T10:00:00.000Z" }, ...entries]);
  }

  it("extracts the TokenBreakdown from an assistant message line", async () => {
    const dir = join(tmpHome, ".pi", "agent", "sessions", "-Users-me-proj");
    writePiSession(dir, "s1.jsonl", "pi-sess-1", "/Users/me/proj", [
      {
        type: "message",
        timestamp: "2026-01-15T10:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-5",
          provider: "anthropic",
          usage: { input: 120, output: 45, cacheRead: 30, cacheWrite: 12 },
        },
      },
    ]);

    const records = await piReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("pi");
    expect(r.tokens.input).toBe(120);
    expect(r.tokens.output).toBe(45);
    expect(r.tokens.cacheRead).toBe(30);
    expect(r.tokens.cacheWrite).toBe(12);
    expect(r.tokens.reasoning).toBe(0); // Pi does not report reasoning
    expect(r.modelId).toBe("claude-sonnet-4-5");
    expect(r.providerId).toBe("anthropic"); // explicit field, not inferred
    expect(r.sessionId).toBe("pi-sess-1");
    expect(r.projectLabel).toBe("proj");
    expect(r.confidence).toBe("host-reported");
    expect(r.dedupKey).toBe("pi:pi-sess-1:1"); // header is line 0, message is line 1
  });

  it("honors PI_CODING_AGENT_DIR and skips non-assistant / model-less lines", async () => {
    const override = join(tmpHome, "custom-pi");
    process.env.PI_CODING_AGENT_DIR = override;
    writePiSession(override, "s2.jsonl", "pi-sess-2", "/work/repo", [
      { type: "message", message: { role: "user", model: "x", provider: "y", usage: { input: 1 } } }, // not assistant
      { type: "message", message: { role: "assistant", provider: "anthropic", usage: { input: 5 } } }, // no model → skip
      {
        type: "message",
        message: { role: "assistant", model: "claude-opus-4-5", provider: "anthropic", usage: { input: 77, output: 11 } },
      },
    ]);

    const records = await piReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(77);
    expect(records[0]!.tokens.output).toBe(11);
    expect(records[0]!.modelId).toBe("claude-opus-4-5");
  });

  it("yields nothing when the first line is not a session header (whole-file void)", async () => {
    const dir = join(tmpHome, ".pi", "agent", "sessions", "-no-header");
    writeJsonl(dir, "s3.jsonl", [
      { type: "message", message: { role: "assistant", model: "m", provider: "p", usage: { input: 9 } } },
    ]);
    expect(await piReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: returns [] when neither ~/.pi nor ~/.omp exists", async () => {
    expect(await piReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: skips a malformed JSONL line without throwing", async () => {
    const dir = join(tmpHome, ".pi", "agent", "sessions", "-Users-me-proj");
    const header = JSON.stringify({ type: "session", id: "pi-sess-bad", cwd: "/Users/me/proj" });
    const good = JSON.stringify({
      type: "message",
      message: { role: "assistant", model: "claude-sonnet-4-5", provider: "anthropic", usage: { input: 22, output: 4 } },
    });
    writeRaw(dir, "s-bad.jsonl", `${header}\n{ broken json\n${good}\n`);

    const records = await piReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(22);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 6. kimi — ~/.kimi/sessions/<GROUP>/<UUID>/wire.jsonl ; StatusUpdate token_usage
//    DEDUP: two progressive StatusUpdates with the same message_id → MAX total.
// ═════════════════════════════════════════════════════════════════════════

describe("kimi reader", () => {
  /** Write a wire.jsonl plus the sibling config.json carrying the model name. */
  function writeKimiSession(home: string, group: string, uuid: string, wireLines: unknown[], model = "kimi-k2"): void {
    const sessionDir = join(home, "sessions", group, uuid);
    writeJsonl(sessionDir, "wire.jsonl", wireLines);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ model }), "utf8");
  }

  /** A StatusUpdate wire frame (timestamp is Unix SECONDS, often fractional). */
  const statusUpdate = (ts: number, usage: Record<string, number>, messageId?: string): unknown => ({
    timestamp: ts,
    message: {
      type: "StatusUpdate",
      payload: { token_usage: usage, ...(messageId !== undefined ? { message_id: messageId } : {}) },
    },
  });

  it("extracts the TokenBreakdown from a StatusUpdate (model from config.json)", async () => {
    const home = join(tmpHome, ".kimi");
    writeKimiSession(home, "grp-1", "uuid-aaa", [
      { type: "metadata", protocol_version: "1.3" },
      statusUpdate(
        1770983426.420942,
        { input_other: 1562, output: 2463, input_cache_read: 40, input_cache_creation: 5 },
        "chatcmpl-xxx",
      ),
    ]);

    const records = await kimiReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("kimi");
    expect(r.tokens.input).toBe(1562); // input_other
    expect(r.tokens.output).toBe(2463);
    expect(r.tokens.cacheRead).toBe(40); // input_cache_read
    expect(r.tokens.cacheWrite).toBe(5); // input_cache_creation
    expect(r.tokens.reasoning).toBe(0);
    expect(r.modelId).toBe("kimi-k2"); // from config.json
    expect(r.providerId).toBe("moonshot");
    expect(r.sessionId).toBe("uuid-aaa");
    expect(r.ts).toBe(1770983426420); // seconds * 1000, truncated
    expect(r.dedupKey).toBe("chatcmpl-xxx");
    expect(r.confidence).toBe("host-reported");
  });

  it("DEDUP: progressive StatusUpdates with the SAME message_id keep the MAX total (not sum)", async () => {
    const home = join(tmpHome, ".kimi");
    // Same message_id: 100→10 then 120→30. Sum would be 250; max keeps the larger
    // total snapshot (120 input / 30 output / 5 cacheRead).
    writeKimiSession(home, "grp-2", "uuid-bbb", [
      { type: "metadata", protocol_version: "1.3" },
      statusUpdate(1770983410.0, { input_other: 100, output: 10, input_cache_read: 0, input_cache_creation: 0 }, "msg-prog"),
      statusUpdate(1770983420.0, { input_other: 120, output: 30, input_cache_read: 5, input_cache_creation: 0 }, "msg-prog"),
    ]);

    const records = await kimiReader.read({});
    expect(records).toHaveLength(1); // one logical message
    const r = records[0]!;
    expect(r.tokens.input).toBe(120);
    expect(r.tokens.output).toBe(30);
    expect(r.tokens.cacheRead).toBe(5);
  });

  it("keeps DISTINCT and missing message_ids as separate rows", async () => {
    const home = join(tmpHome, ".kimi");
    writeKimiSession(home, "grp-3", "uuid-ccc", [
      { type: "metadata", protocol_version: "1.3" },
      statusUpdate(1770983410.0, { input_other: 10, output: 1 }, "msg-1"),
      statusUpdate(1770983420.0, { input_other: 20, output: 2 }, "msg-2"),
      statusUpdate(1770983430.0, { input_other: 30, output: 3 }), // no message_id
      statusUpdate(1770983440.0, { input_other: 40, output: 4 }), // no message_id
    ]);

    const records = await kimiReader.read({});
    expect(records).toHaveLength(4);
    const inputs = records.map((r) => r.tokens.input).sort((a, b) => a - b);
    expect(inputs).toEqual([10, 20, 30, 40]);
  });

  it("honors KIMI_CODE_HOME for a relocated Kimi home", async () => {
    const codeHome = join(tmpHome, ".kimi-code");
    process.env.KIMI_CODE_HOME = codeHome;
    writeKimiSession(
      codeHome,
      "grp-k",
      "uuid-kkk",
      [
        { type: "metadata", protocol_version: "1.3" },
        statusUpdate(1770983426.0, { input_other: 88, output: 9 }, "msg-k"),
      ],
      "kimi-for-coding",
    );

    const records = await kimiReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(88);
    expect(records[0]!.sessionId).toBe("uuid-kkk");
    expect(records[0]!.modelId).toBe("kimi-for-coding");
  });

  it("FAIL-OPEN: returns [] when ~/.kimi/sessions is absent", async () => {
    expect(await kimiReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: skips a malformed wire line without throwing", async () => {
    const home = join(tmpHome, ".kimi");
    const sessionDir = join(home, "sessions", "grp-bad", "uuid-bad");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ model: "kimi-k2" }), "utf8");
    const meta = JSON.stringify({ type: "metadata", protocol_version: "1.3" });
    const good = JSON.stringify(statusUpdate(1770983426.0, { input_other: 14, output: 2 }, "msg-ok"));
    writeRaw(sessionDir, "wire.jsonl", `${meta}\n{ not json\n${good}\n`);

    const records = await kimiReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(14);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 7. openclaw — ~/.openclaw/agents/**/*.jsonl* ; message.usage.* (stateful model)
//    Per-record dedupKey openclaw:<sessionId>:<entry.id|#ordinal>.
// ═════════════════════════════════════════════════════════════════════════

describe("openclaw reader", () => {
  const agentsDir = (): string => join(tmpHome, ".openclaw", "agents", "default");

  it("extracts the TokenBreakdown from an assistant message (model from inline + state)", async () => {
    writeJsonl(agentsDir(), "sess-a.jsonl", [
      { type: "model_change", modelId: "claude-sonnet-4-5", provider: "anthropic" },
      {
        type: "message",
        id: "msg1",
        message: {
          role: "assistant",
          timestamp: 1775000000000,
          usage: { input: 200, output: 60, cacheRead: 25, cacheWrite: 8, cost: { total: 0.0123 } },
        },
      },
    ]);

    const records = await openclawReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("openclaw");
    expect(r.tokens.input).toBe(200);
    expect(r.tokens.output).toBe(60);
    expect(r.tokens.cacheRead).toBe(25);
    expect(r.tokens.cacheWrite).toBe(8);
    expect(r.tokens.reasoning).toBe(0); // OpenClaw does not report reasoning
    expect(r.modelId).toBe("claude-sonnet-4-5"); // tracked from model_change
    expect(r.providerId).toBe("anthropic");
    expect(r.sessionId).toBe("sess-a");
    expect(r.ts).toBe(1775000000000); // i64 millis
    expect(r.cost).toBeCloseTo(0.0123);
    expect(r.dedupKey).toBe("openclaw:sess-a:msg1");
    expect(r.confidence).toBe("host-reported");
  });

  it("uses an ordinal in the dedupKey when entry.id is absent, and tracks model across lines", async () => {
    writeJsonl(agentsDir(), "sess-b.jsonl", [
      {
        type: "custom",
        customType: "model-snapshot",
        data: { modelId: "claude-opus-4-5", provider: "anthropic" },
      },
      { type: "message", message: { role: "user", usage: { input: 1 } } }, // skipped (not assistant)
      { type: "message", message: { role: "assistant", usage: { input: 10, output: 2 } } }, // model from state
      { type: "message", message: { role: "assistant", usage: { input: 20, output: 4 } } },
    ]);

    const records = await openclawReader.read({}).then((rs) => rs.slice().sort(byInput));
    expect(records).toHaveLength(2);
    expect(records[0]!.modelId).toBe("claude-opus-4-5");
    expect(records[0]!.dedupKey).toBe("openclaw:sess-b:#1");
    expect(records[1]!.dedupKey).toBe("openclaw:sess-b:#2");
  });

  it("derives the session id from an archived .jsonl.reset filename", async () => {
    writeJsonl(agentsDir(), "sess-c.jsonl.reset.2026-03-20T06-34-44.520Z", [
      { type: "model_change", modelId: "claude-sonnet-4-5", provider: "anthropic" },
      { type: "message", id: "m1", message: { role: "assistant", usage: { input: 33, output: 5 } } },
    ]);

    const records = await openclawReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.sessionId).toBe("sess-c"); // stem before the first .jsonl
    expect(records[0]!.dedupKey).toBe("openclaw:sess-c:m1");
  });

  it("FAIL-OPEN: returns [] when no openclaw agent root exists", async () => {
    expect(await openclawReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: skips a malformed JSONL line without throwing", async () => {
    const mc = JSON.stringify({ type: "model_change", modelId: "claude-sonnet-4-5", provider: "anthropic" });
    const good = JSON.stringify({
      type: "message",
      id: "m1",
      message: { role: "assistant", usage: { input: 18, output: 3 } },
    });
    writeRaw(agentsDir(), "sess-bad.jsonl", `${mc}\n{ broken\n${good}\n`);

    const records = await openclawReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(18);
  });
});
