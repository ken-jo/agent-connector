/**
 * tests/usage/u2-readers — fixture-based tests for the 7 U2 JSON usage readers
 * (amp, droid, codebuff, mux, roo-code, kilo, kiro).
 *
 * Each block writes a tiny synthetic session file in the platform's NATIVE on-disk
 * shape under a fresh fake HOME (and any platform-specific env override), calls the
 * reader, and asserts the extracted TokenBreakdown. Grounded in the tokscale Rust
 * parsers (crates/tokscale-core/src/sessions/{amp,droid,codebuff,mux,roocode,
 * kilocode,kiro}.rs). The CRITICAL cases exercise the per-platform behavior the
 * design calls out:
 *   - amp  : a usageLedger event + the assistant message describing the SAME call
 *            MERGE into ONE row (not double-counted) — ports
 *            test_parse_amp_does_not_double_count_full_ledger.
 *   - kiro : a turn lacking explicit token counts is ESTIMATED (context% × window,
 *            else chars/4) and labeled confidence "host-estimated" with a non-zero
 *            input — ports the kiro.rs context-percentage estimation path.
 *
 * Every block also asserts FAIL-OPEN: a missing root yields [] (the reader never
 * throws), and a malformed file is skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ampReader from "../../src/usage/readers/amp.js";
import droidReader from "../../src/usage/readers/droid.js";
import codebuffReader from "../../src/usage/readers/codebuff.js";
import muxReader from "../../src/usage/readers/mux.js";
import rooCodeReader from "../../src/usage/readers/roo-code.js";
import kiloReader from "../../src/usage/readers/kilo.js";
import kiroReader from "../../src/usage/readers/kiro.js";
import type { UsageRecord } from "../../src/usage/types.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fake-HOME harness. Every reader resolves its root via os.homedir(),
// which honors process.env.HOME on POSIX. We also snapshot + restore the
// env overrides these readers read (XDG_*, AGENT_CONNECTOR_*_DIR), so no test
// leaks state into another.
//
//   amp        → $XDG_DATA_HOME/amp/threads               (XDG_DATA_HOME pinned)
//   droid      → ~/.factory/sessions
//   codebuff   → $XDG_CONFIG_HOME/manicode/projects        (XDG_CONFIG_HOME pinned)
//   mux        → ~/.mux/sessions
//   roo-code   → AGENT_CONNECTOR_ROO_CODE_DIR (a fake tasks dir)
//   kilo       → AGENT_CONNECTOR_KILO_DIR     (a fake tasks dir)
//   kiro       → ~/.kiro/sessions/cli
// ─────────────────────────────────────────────────────────────────────────

const SAVED_ENV = [
  "HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "AGENT_CONNECTOR_CODEBUFF_DIR",
  "AGENT_CONNECTOR_ROO_CODE_DIR",
  "AGENT_CONNECTOR_KILO_DIR",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

let tmpHome: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of SAVED_ENV) savedEnv[key] = process.env[key];
  tmpHome = mkdtempSync(join(tmpdir(), "ac-u2-home-"));
  process.env.HOME = tmpHome;
  // Pin XDG so amp / codebuff resolve under the fake HOME deterministically.
  process.env.XDG_DATA_HOME = join(tmpHome, ".local", "share");
  process.env.XDG_CONFIG_HOME = join(tmpHome, ".config");
  // Neutralize the VS-Code-extension overrides; each test that needs them sets
  // its own value, every other test must see them unset (→ [] fail-open).
  delete process.env.AGENT_CONNECTOR_CODEBUFF_DIR;
  delete process.env.AGENT_CONNECTOR_ROO_CODE_DIR;
  delete process.env.AGENT_CONNECTOR_KILO_DIR;
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

/** Write a single JSON value at an absolute path, mkdir -p first. */
function writeJson(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value), "utf8");
}

/** Write a JSONL file (one JSON value per line) at an absolute path, mkdir -p first. */
function writeJsonl(dir: string, name: string, lines: unknown[]): void {
  mkdirSync(dir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(dir, name), body, "utf8");
}

/** Write raw text at an absolute path (for malformed cases), mkdir -p first. */
function writeRaw(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, "utf8");
}

const byInput = (a: UsageRecord, b: UsageRecord): number => a.tokens.input - b.tokens.input;

// ═════════════════════════════════════════════════════════════════════════
// 1. amp — $XDG_DATA_HOME/amp/threads/*.json ; usageLedger.events + messages[].usage
//    MERGE: a ledger event + the assistant message describing the same call →
//    ONE row (not double-counted).
// ═════════════════════════════════════════════════════════════════════════

describe("amp reader", () => {
  const threadsDir = (): string => join(tmpHome, ".local", "share", "amp", "threads");

  it("extracts the TokenBreakdown from a ledger event (cost from credits)", async () => {
    writeJson(threadsDir(), "thread-a.json", {
      id: "thread-a",
      created: 1775000000000,
      usageLedger: {
        events: [
          {
            timestamp: "2026-04-04T12:00:00Z",
            model: "claude-sonnet-4-5",
            credits: 0.75,
            tokens: {
              input: 100,
              output: 20,
              cacheReadInputTokens: 30,
              cacheCreationInputTokens: 8,
            },
          },
        ],
      },
      messages: [],
    });

    const records = await ampReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("amp");
    expect(r.tokens.input).toBe(100);
    expect(r.tokens.output).toBe(20);
    expect(r.tokens.cacheRead).toBe(30);
    expect(r.tokens.cacheWrite).toBe(8);
    expect(r.tokens.reasoning).toBe(0); // Amp never reports reasoning
    expect(r.providerId).toBe("anthropic");
    expect(r.sessionId).toBe("thread-a");
    expect(r.ts).toBe(Date.parse("2026-04-04T12:00:00Z"));
    expect(r.cost).toBeCloseTo(0.75);
    expect(r.confidence).toBe("host-reported");
    expect(r.dedupKey).toBeDefined();
  });

  it("MERGE/DEDUP: a ledger event + the message describing the SAME call is NOT doubled", async () => {
    // Two ledger events AND two assistant messages describing the SAME two calls
    // (matched by identical model + tokens). Summing both lanes would give
    // output 20 (5+5 ledger + 5+5 message) and input 90 (45 ledger + 45 message).
    // The in-file merge must keep ONE row per call: 2 rows, total output 10,
    // total input 45. Ports test_parse_amp_does_not_double_count_full_ledger.
    writeJson(threadsDir(), "thread-full.json", {
      id: "thread-full",
      created: 1775000000000,
      usageLedger: {
        events: [
          {
            timestamp: "2026-04-04T12:00:00Z",
            model: "claude-sonnet-4-5",
            credits: 0.2,
            tokens: { input: 20, output: 5 },
          },
          {
            timestamp: "2026-04-05T12:00:00Z",
            model: "claude-sonnet-4-5",
            credits: 0.25,
            tokens: { input: 25, output: 5 },
          },
        ],
      },
      messages: [
        {
          role: "assistant",
          messageId: 1,
          usage: { model: "claude-sonnet-4-5", inputTokens: 20, outputTokens: 5, credits: 0.2 },
        },
        {
          role: "assistant",
          messageId: 2,
          usage: { model: "claude-sonnet-4-5", inputTokens: 25, outputTokens: 5, credits: 0.25 },
        },
      ],
    });

    const records = await ampReader.read({}).then((rs) => rs.slice().sort(byInput));
    expect(records).toHaveLength(2); // merged, NOT 4

    const totalInput = records.reduce((s, r) => s + r.tokens.input, 0);
    const totalOutput = records.reduce((s, r) => s + r.tokens.output, 0);
    expect(totalInput).toBe(45); // 20 + 25, counted ONCE (not 90)
    expect(totalOutput).toBe(10); // 5 + 5, counted ONCE (not 20)
    expect(records[0]!.tokens.input).toBe(20);
    expect(records[1]!.tokens.input).toBe(25);
  });

  it("appends an unmatched assistant message as its own row alongside the ledger", async () => {
    // One ledger event (input 100) + two messages: one matches it (input 100),
    // one does NOT (input 50). Result: 2 rows — the merged ledger row + the
    // unmatched message row. Ports test_parse_amp_reconciles_partial_ledger.
    writeJson(threadsDir(), "thread-partial.json", {
      id: "thread-partial",
      created: 1775000000000,
      usageLedger: {
        events: [
          {
            timestamp: "2026-04-08T12:00:00Z",
            model: "claude-sonnet-4-5",
            credits: 0.75,
            tokens: { input: 100, output: 20 },
          },
        ],
      },
      messages: [
        {
          role: "assistant",
          messageId: 1,
          usage: { model: "claude-sonnet-4-5", inputTokens: 100, outputTokens: 20, credits: 0.75 },
        },
        {
          role: "assistant",
          messageId: 2,
          usage: { model: "claude-sonnet-4-5", inputTokens: 50, outputTokens: 10, credits: 0.4 },
        },
      ],
    });

    const records = await ampReader.read({}).then((rs) => rs.slice().sort(byInput));
    expect(records).toHaveLength(2);
    expect(records[0]!.tokens.input).toBe(50); // unmatched message
    expect(records[1]!.tokens.input).toBe(100); // merged ledger row
  });

  it("FAIL-OPEN: returns [] when the amp/threads root is absent", async () => {
    expect(await ampReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: skips a malformed JSON thread file without throwing", async () => {
    writeRaw(threadsDir(), "thread-bad.json", "{ not valid json");
    // A second, valid thread proves the reader keeps going past the bad file.
    writeJson(threadsDir(), "thread-ok.json", {
      id: "thread-ok",
      created: 1775000000000,
      usageLedger: {
        events: [{ timestamp: "2026-04-04T12:00:00Z", model: "claude-sonnet-4-5", tokens: { input: 12, output: 3 } }],
      },
    });

    const records = await ampReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(12);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. droid — ~/.factory/sessions/*.settings.json ; tokenUsage.*
//    No dedup (session id is the primary key). Custom model normalization.
// ═════════════════════════════════════════════════════════════════════════

describe("droid reader", () => {
  const sessionsDir = (): string => join(tmpHome, ".factory", "sessions");

  it("extracts the TokenBreakdown and normalizes the custom model name", async () => {
    writeJson(sessionsDir(), "uuid-1.settings.json", {
      model: "custom:Claude-Opus-4.5-Thinking-[Anthropic]-0",
      providerLock: "anthropic",
      providerLockTimestamp: "2026-01-15T10:00:00.000Z",
      tokenUsage: {
        inputTokens: 300,
        outputTokens: 90,
        cacheReadTokens: 40,
        cacheCreationTokens: 15,
        thinkingTokens: 12,
      },
    });

    const records = await droidReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("droid");
    expect(r.tokens.input).toBe(300);
    expect(r.tokens.output).toBe(90);
    expect(r.tokens.cacheRead).toBe(40);
    expect(r.tokens.cacheWrite).toBe(15);
    expect(r.tokens.reasoning).toBe(12); // from thinkingTokens
    // custom: stripped, [Anthropic] removed, trailing-hyphen trimmed is NOT
    // applied (the "-0" keeps its digit), dots→hyphens, lowercased.
    expect(r.modelId).toBe("claude-opus-4-5-thinking-0");
    expect(r.providerId).toBe("anthropic"); // providerLock
    expect(r.sessionId).toBe("uuid-1"); // .settings stripped
    expect(r.ts).toBe(Date.parse("2026-01-15T10:00:00.000Z"));
    expect(r.confidence).toBe("host-reported");
  });

  it("drops a settings file whose tokenUsage sums to zero", async () => {
    writeJson(sessionsDir(), "empty.settings.json", {
      model: "gpt-5",
      providerLockTimestamp: "2026-01-15T10:00:00.000Z",
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(await droidReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: returns [] when ~/.factory/sessions is absent", async () => {
    expect(await droidReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: skips a malformed settings file without throwing", async () => {
    writeRaw(sessionsDir(), "bad.settings.json", "{ broken");
    writeJson(sessionsDir(), "ok.settings.json", {
      model: "claude-sonnet-4-5",
      providerLock: "anthropic",
      providerLockTimestamp: "2026-01-15T10:00:00.000Z",
      tokenUsage: { inputTokens: 22, outputTokens: 4 },
    });

    const records = await droidReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(22);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. codebuff — $XDG_CONFIG_HOME/manicode/projects/<project>/chats/<chatId>/
//    chat-messages.json ; assistant metadata.usage. Dedup: ChatMessage.id.
// ═════════════════════════════════════════════════════════════════════════

describe("codebuff reader", () => {
  const chatDir = (project = "sandbox", chatId = "2025-12-14T10-00-00.000Z"): string =>
    join(tmpHome, ".config", "manicode", "projects", project, "chats", chatId);

  it("extracts the TokenBreakdown from an assistant message (model + dedup from id)", async () => {
    writeJson(chatDir(), "chat-messages.json", [
      { role: "user", metadata: { usage: { inputTokens: 1 } } }, // skipped (not assistant)
      {
        role: "assistant",
        id: "cm-001",
        timestamp: "2025-12-14T10:00:05.000Z",
        metadata: {
          model: "claude-sonnet-4-5",
          usage: {
            inputTokens: 250,
            outputTokens: 70,
            cacheReadInputTokens: 35,
            cacheCreationInputTokens: 9,
            credits: 0.05,
          },
        },
      },
    ]);

    const records = await codebuffReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("codebuff");
    expect(r.tokens.input).toBe(250);
    expect(r.tokens.output).toBe(70);
    expect(r.tokens.cacheRead).toBe(35);
    expect(r.tokens.cacheWrite).toBe(9);
    expect(r.tokens.reasoning).toBe(0); // Codebuff does not report reasoning
    expect(r.modelId).toBe("claude-sonnet-4-5");
    expect(r.providerId).toBe("anthropic");
    expect(r.sessionId).toBe("manicode/sandbox/2025-12-14T10-00-00.000Z");
    expect(r.projectLabel).toBe("sandbox");
    expect(r.cost).toBeCloseTo(0.05);
    expect(r.dedupKey).toBe("cm-001"); // upstream ChatMessage.id
    expect(r.confidence).toBe("host-reported");
  });

  it("accepts snake_case usage fields and synthesizes a dedupKey when id is absent", async () => {
    writeJson(chatDir("repo", "2025-12-14T11-00-00.000Z"), "chat-messages.json", [
      {
        variant: "ai", // assistant variant
        metadata: {
          model: "gpt-5",
          usage: { input_tokens: 80, output_tokens: 12 },
        },
      },
    ]);

    const records = await codebuffReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.tokens.input).toBe(80);
    expect(r.tokens.output).toBe(12);
    expect(r.providerId).toBe("openai");
    // No upstream id → deterministic composite key (begins with the platform).
    expect(r.dedupKey).toMatch(/^codebuff:manicode\/repo\/2025-12-14T11-00-00\.000Z:/);
  });

  it("FAIL-OPEN: returns [] when no codebuff projects root exists", async () => {
    expect(await codebuffReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: skips a malformed chat-messages.json without throwing", async () => {
    writeRaw(chatDir("p1", "2025-12-14T12-00-00.000Z"), "chat-messages.json", "{ not an array");
    writeJson(chatDir("p2", "2025-12-14T13-00-00.000Z"), "chat-messages.json", [
      { role: "assistant", id: "cm-x", metadata: { model: "claude-sonnet-4-5", usage: { inputTokens: 18, outputTokens: 3 } } },
    ]);

    const records = await codebuffReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(18);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. mux — ~/.mux/sessions/<workspaceId>/session-usage.json ; byModel.<key>.*
//    No dedup (aggregate file). Model key split on the FIRST ':' → provider+model.
// ═════════════════════════════════════════════════════════════════════════

describe("mux reader", () => {
  const wsDir = (id = "ws-abc"): string => join(tmpHome, ".mux", "sessions", id);

  it("produces one row per byModel entry with provider split from the key", async () => {
    writeJson(wsDir(), "session-usage.json", {
      lastRequest: { timestamp: 1775000000000 },
      byModel: {
        "anthropic:claude-opus-4-6": {
          input: { tokens: 500 },
          cached: { tokens: 60 },
          cacheCreate: { tokens: 20 },
          output: { tokens: 120 },
          reasoning: { tokens: 35 },
        },
        "openai:gpt-5": {
          input: { tokens: 200 },
          output: { tokens: 40 },
        },
      },
    });

    const records = await muxReader.read({}).then((rs) => rs.slice().sort(byInput));
    expect(records).toHaveLength(2);

    const gpt = records[0]!; // smaller input
    const claude = records[1]!;
    expect(claude.platformId).toBe("mux");
    expect(claude.providerId).toBe("anthropic");
    expect(claude.modelId).toBe("claude-opus-4-6"); // remainder after first ':'
    expect(claude.tokens.input).toBe(500);
    expect(claude.tokens.cacheRead).toBe(60); // cached
    expect(claude.tokens.cacheWrite).toBe(20); // cacheCreate
    expect(claude.tokens.output).toBe(120);
    expect(claude.tokens.reasoning).toBe(35);
    expect(claude.sessionId).toBe("ws-abc"); // parent dir = workspaceId
    expect(claude.ts).toBe(1775000000000); // lastRequest.timestamp (raw ms)
    expect(claude.confidence).toBe("host-reported");

    expect(gpt.providerId).toBe("openai");
    expect(gpt.modelId).toBe("gpt-5");
    expect(gpt.tokens.input).toBe(200);
  });

  it("drops a byModel entry whose five dimensions sum to zero", async () => {
    writeJson(wsDir("ws-empty"), "session-usage.json", {
      byModel: { "anthropic:claude-opus-4-6": { input: { tokens: 0 }, output: { tokens: 0 } } },
    });
    expect(await muxReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: returns [] when ~/.mux/sessions is absent", async () => {
    expect(await muxReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: skips a malformed session-usage.json without throwing", async () => {
    writeRaw(wsDir("ws-bad"), "session-usage.json", "{ broken");
    writeJson(wsDir("ws-good"), "session-usage.json", {
      byModel: { "openai:gpt-5": { input: { tokens: 14 }, output: { tokens: 2 } } },
    });

    const records = await muxReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(14);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5. roo-code — <tasks>/<taskId>/ui_messages.json ; api_req_started JSON-in-string
//    No dedup. model/agent from sibling api_conversation_history.json.
// ═════════════════════════════════════════════════════════════════════════

describe("roo-code reader", () => {
  let tasksRoot: string;
  beforeEach(() => {
    tasksRoot = join(tmpHome, "roo-tasks");
    process.env.AGENT_CONNECTOR_ROO_CODE_DIR = tasksRoot;
  });

  /** Write a task's ui_messages.json + optional api_conversation_history.json. */
  function writeTask(taskId: string, uiEntries: unknown[], history?: string): void {
    const dir = join(tasksRoot, taskId);
    writeJson(dir, "ui_messages.json", uiEntries);
    if (history !== undefined) writeRaw(dir, "api_conversation_history.json", history);
  }

  const apiReqStarted = (ts: number, payload: Record<string, unknown>): unknown => ({
    type: "say",
    say: "api_req_started",
    ts,
    text: JSON.stringify(payload),
  });

  it("extracts the TokenBreakdown from an api_req_started entry (model/agent from sibling)", async () => {
    writeTask(
      "task-1",
      [
        { type: "say", say: "text", ts: 1775000000000, text: "hello" }, // ignored
        apiReqStarted(1775000001000, {
          tokensIn: 400,
          tokensOut: 110,
          cacheReads: 50,
          cacheWrites: 12,
          cost: 0.034,
          apiProtocol: "bedrock/anthropic",
        }),
      ],
      "<environment_details><model>claude-sonnet-4-5</model><slug>code</slug></environment_details>",
    );

    const records = await rooCodeReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("roo-code");
    expect(r.tokens.input).toBe(400);
    expect(r.tokens.output).toBe(110);
    expect(r.tokens.cacheRead).toBe(50);
    expect(r.tokens.cacheWrite).toBe(12);
    expect(r.tokens.reasoning).toBe(0); // Roo Code does not report reasoning
    expect(r.modelId).toBe("claude-sonnet-4-5"); // from <model>
    expect(r.providerId).toBe("bedrock/anthropic"); // apiProtocol verbatim
    expect(r.sessionId).toBe("task-1"); // taskId = parent dir
    expect(r.agent).toBe("code"); // <slug>
    expect(r.cost).toBeCloseTo(0.034);
    expect(r.ts).toBe(1775000001000);
    expect(r.confidence).toBe("host-reported");
  });

  it("defaults model to unknown when the sibling history is absent and skips non-api entries", async () => {
    writeTask("task-2", [
      { type: "ask", ask: "tool", ts: 1775000000000, text: "x" }, // ignored
      apiReqStarted(1775000002000, { tokensIn: 77, tokensOut: 11 }),
    ]);

    const records = await rooCodeReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.modelId).toBe("unknown");
    expect(r.providerId).toBe("unknown"); // no apiProtocol
    expect(r.tokens.input).toBe(77);
    expect(r.agent).toBeUndefined();
  });

  it("FAIL-OPEN: returns [] when the tasks root is absent", async () => {
    process.env.AGENT_CONNECTOR_ROO_CODE_DIR = join(tmpHome, "nonexistent-roo");
    expect(await rooCodeReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: skips an entry with a malformed JSON-in-string text payload", async () => {
    writeTask("task-bad", [
      { type: "say", say: "api_req_started", ts: 1775000003000, text: "{ not json" }, // skipped
      apiReqStarted(1775000004000, { tokensIn: 18, tokensOut: 3 }),
    ]);

    const records = await rooCodeReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(18);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 6. kilo — <tasks>/<taskId>/ui_messages.json ; SAME format as roo-code.
//    No dedup (per-file isolation). AGENT_CONNECTOR_KILO_DIR override.
// ═════════════════════════════════════════════════════════════════════════

describe("kilo reader", () => {
  let tasksRoot: string;
  beforeEach(() => {
    tasksRoot = join(tmpHome, "kilo-tasks");
    process.env.AGENT_CONNECTOR_KILO_DIR = tasksRoot;
  });

  function writeTask(taskId: string, uiEntries: unknown[], history?: string): void {
    const dir = join(tasksRoot, taskId);
    writeJson(dir, "ui_messages.json", uiEntries);
    if (history !== undefined) writeRaw(dir, "api_conversation_history.json", history);
  }

  const apiReqStarted = (ts: number, payload: Record<string, unknown>): unknown => ({
    type: "say",
    say: "api_req_started",
    ts,
    text: JSON.stringify(payload),
  });

  it("extracts the TokenBreakdown from an api_req_started entry (platformId kilo)", async () => {
    writeTask(
      "ktask-1",
      [
        apiReqStarted(1775000005000, {
          tokensIn: 220,
          tokensOut: 60,
          cacheReads: 18,
          cacheWrites: 4,
          cost: 0.011,
          apiProtocol: "azure/openai",
        }),
      ],
      "<environment_details><model>gpt-5</model><name>orchestrator</name></environment_details>",
    );

    const records = await kiloReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("kilo");
    expect(r.tokens.input).toBe(220);
    expect(r.tokens.output).toBe(60);
    expect(r.tokens.cacheRead).toBe(18);
    expect(r.tokens.cacheWrite).toBe(4);
    expect(r.tokens.reasoning).toBe(0);
    expect(r.modelId).toBe("gpt-5");
    expect(r.providerId).toBe("azure/openai");
    expect(r.sessionId).toBe("ktask-1");
    expect(r.agent).toBe("orchestrator"); // <name> (no <slug>)
    expect(r.cost).toBeCloseTo(0.011);
    expect(r.confidence).toBe("host-reported");
  });

  it("FAIL-OPEN: returns [] when the kilo tasks root is absent", async () => {
    process.env.AGENT_CONNECTOR_KILO_DIR = join(tmpHome, "nonexistent-kilo");
    expect(await kiloReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: skips a malformed ui_messages.json without throwing", async () => {
    const dir = join(tasksRoot, "ktask-bad");
    writeRaw(dir, "ui_messages.json", "{ not an array");
    writeTask("ktask-ok", [apiReqStarted(1775000006000, { tokensIn: 21, tokensOut: 5 })]);

    const records = await kiloReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(21);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 7. kiro — ~/.kiro/sessions/cli/<stem>.json (+ adjacent .jsonl)
//    HOST-ESTIMATED path: a turn lacking explicit token counts → input estimated
//    from context% × window (or chars/4), confidence "host-estimated".
// ═════════════════════════════════════════════════════════════════════════

describe("kiro reader", () => {
  const cliDir = (): string => join(tmpHome, ".kiro", "sessions", "cli");

  it("extracts host-REPORTED tokens when the turn carries explicit counts", async () => {
    writeJson(cliDir(), "sess-rep.json", {
      session_id: "kiro-rep",
      cwd: "/Users/me/proj",
      session_state: {
        rts_model_state: { model_info: { model_id: "claude-sonnet-4-5", context_window_tokens: 200000 } },
        conversation_metadata: {
          user_turn_metadatas: [
            {
              input_token_count: 1200,
              output_token_count: 340,
              end_timestamp: "2026-01-15T10:00:00.000Z",
              total_request_count: 2,
            },
          ],
        },
      },
    });

    const records = await kiroReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("kiro");
    expect(r.tokens.input).toBe(1200);
    expect(r.tokens.output).toBe(340);
    expect(r.tokens.cacheRead).toBe(0);
    expect(r.tokens.cacheWrite).toBe(0);
    expect(r.tokens.reasoning).toBe(0);
    expect(r.modelId).toBe("claude-sonnet-4-5");
    expect(r.providerId).toBe("amazon-bedrock"); // hardcoded
    expect(r.sessionId).toBe("kiro-rep");
    expect(r.projectLabel).toBe("proj");
    expect(r.messageCount).toBe(2); // total_request_count
    expect(r.dedupKey).toBe("kiro-rep:0"); // <sessionId>:<turnIndex>
    expect(r.confidence).toBe("host-reported"); // both dimensions explicit
  });

  it("HOST-ESTIMATED: a turn without explicit counts estimates input from context% × window", async () => {
    // No input_token_count/output_token_count. context_window 200000 × 25% = 50000
    // (non-zero estimate); output has no explicit count and no assistant chars → 0.
    // input + output > 0, so the row survives and is labeled host-estimated.
    writeJson(cliDir(), "sess-est.json", {
      session_id: "kiro-est",
      session_state: {
        rts_model_state: { model_info: { model_id: "claude-sonnet-4-5", context_window_tokens: 200000 } },
        conversation_metadata: {
          user_turn_metadatas: [
            {
              context_usage_percentage: 25,
              end_timestamp: "2026-01-15T11:00:00.000Z",
            },
          ],
        },
      },
    });

    const records = await kiroReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.confidence).toBe("host-estimated"); // estimation makes it estimated
    expect(r.tokens.input).toBe(50000); // 200000 * 25 / 100, non-zero estimate
    expect(r.tokens.input).toBeGreaterThan(0);
    expect(r.dedupKey).toBe("kiro-est:0");
  });

  it("HOST-ESTIMATED: falls back to chars/4 from the adjacent .jsonl transcript", async () => {
    // No explicit counts, no context%. The estimate comes from the matched
    // Prompt/AssistantMessage char counts in the sibling .jsonl: a 12-char prompt
    // → ceil(12/4)=3 input; an 8-char assistant reply → ceil(8/4)=2 output.
    writeJson(cliDir(), "sess-chars.json", {
      session_id: "kiro-chars",
      session_state: {
        rts_model_state: { model_info: { model_id: "claude-sonnet-4-5" } },
        conversation_metadata: {
          user_turn_metadatas: [{ message_ids: ["m-1"], end_timestamp: "2026-01-15T12:00:00.000Z" }],
        },
      },
    });
    writeJsonl(cliDir(), "sess-chars.jsonl", [
      { kind: "Prompt", data: { message_id: "m-1", content: [{ kind: "text", data: "123456789012" }] } }, // 12 chars
      { kind: "AssistantMessage", data: { message_id: "m-1", content: [{ kind: "text", data: "12345678" }] } }, // 8 chars
    ]);

    const records = await kiroReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.confidence).toBe("host-estimated");
    expect(r.tokens.input).toBe(3); // ceil(12/4)
    expect(r.tokens.output).toBe(2); // ceil(8/4)
  });

  it("FAIL-OPEN: returns [] when ~/.kiro/sessions/cli is absent", async () => {
    expect(await kiroReader.read({})).toEqual([]);
  });

  it("FAIL-OPEN: skips a malformed header .json without throwing", async () => {
    writeRaw(cliDir(), "sess-bad.json", "{ not valid");
    writeJson(cliDir(), "sess-ok.json", {
      session_id: "kiro-ok",
      session_state: {
        rts_model_state: { model_info: { model_id: "claude-sonnet-4-5" } },
        conversation_metadata: {
          user_turn_metadatas: [{ input_token_count: 9, output_token_count: 2, end_timestamp: 1775000000 }],
        },
      },
    });

    const records = await kiroReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(9);
  });
});
