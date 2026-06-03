/**
 * tests/usage/leaderboard — the USER / HOST leaderboard, derived from the host
 * usage readers (src/usage/*).
 *
 * Two complementary layers:
 *   1. INTEGRATION: seed real native session logs for two LOCAL platforms
 *      (claude-code + qwen-code) under a fresh fake HOME, then call the real
 *      {@link hostLeaderboard} (which scans → aggregates) and assert the ranking
 *      ("which CLI/host spent the most"). This exercises the whole scan→rank path.
 *   2. UNIT: drive {@link hostLeaderboard}'s ranking contract through the same
 *      aggregateBy it uses, and assert the formatter renders a ranked table with
 *      the honesty legend + skip notes.
 *
 * Filesystem is isolated to an os.tmpdir mkdtemp HOME, restored in afterEach so
 * the real user home is never touched. The scan is restricted to the two seeded
 * local platforms so the synced cloud readers never add nondeterministic skips.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { aggregateBy, emptyTokens } from "../../src/usage/aggregate.js";
import {
  formatHostLeaderboard,
  hostLeaderboard,
  type HostLeaderboardResult,
} from "../../src/usage/leaderboard.js";
import type { TokenBreakdown, UsageRecord } from "../../src/usage/types.js";

const SAVED_ENV: Record<string, string | undefined> = {};
const SAVED_KEYS = ["HOME", "USERPROFILE", "XDG_DATA_HOME", "XDG_CONFIG_HOME"] as const;

let tmpHome: string;

beforeEach(() => {
  for (const k of SAVED_KEYS) SAVED_ENV[k] = process.env[k];
  tmpHome = mkdtempSync(join(tmpdir(), "ac-usage-lb-home-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.XDG_DATA_HOME = join(tmpHome, ".local", "share");
  process.env.XDG_CONFIG_HOME = join(tmpHome, ".config");
});

afterEach(() => {
  for (const k of SAVED_KEYS) {
    const v = SAVED_ENV[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ── On-disk seeders for the two LOCAL readers ─────────────────────────────

/** Write a Claude Code assistant line under ~/.claude/projects/<key>/<sess>.jsonl. */
function seedClaude(
  key: string,
  session: string,
  lines: Array<Record<string, unknown>>,
): void {
  const dir = join(tmpHome, ".claude", "projects", key);
  mkdirSync(dir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(dir, `${session}.jsonl`), body, "utf8");
}

/** Write a Qwen chats file under ~/.qwen/projects/<project>/chats/<sess>.jsonl. */
function seedQwen(
  project: string,
  session: string,
  lines: Array<Record<string, unknown>>,
): void {
  const dir = join(tmpHome, ".qwen", "projects", project, "chats");
  mkdirSync(dir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(dir, `${session}.jsonl`), body, "utf8");
}

// ─────────────────────────────────────────────────────────────────────────
// INTEGRATION — hostLeaderboard over real seeded readers
// ─────────────────────────────────────────────────────────────────────────

describe("hostLeaderboard (integration over seeded native logs)", () => {
  it("ranks the host that spent the most tokens first (claude-code > qwen-code)", async () => {
    // claude-code: one big assistant message (input 1000 + output 2000 = 3000).
    seedClaude("-home-dev-acme", "sessC", [
      {
        type: "assistant",
        requestId: "req-1",
        timestamp: "2026-01-15T10:00:00.000Z",
        message: {
          id: "msg-1",
          model: "claude-sonnet-4",
          usage: {
            input_tokens: 1000,
            output_tokens: 2000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);

    // qwen-code: a smaller turn (net input 400 + output 250 + reasoning 40).
    seedQwen("proj1", "sessQ", [
      {
        type: "assistant",
        model: "qwen-max",
        sessionId: "sessQ",
        timestamp: "2026-01-15T11:00:00.000Z",
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 250,
          thoughtsTokenCount: 40,
          cachedContentTokenCount: 600,
        },
      },
    ]);

    const result = await hostLeaderboard({ platforms: ["claude-code", "qwen-code"] });

    expect(result.by).toBe("platform");
    expect(result.rows.map((r) => r.key)).toEqual(["claude-code", "qwen-code"]);

    const claude = result.rows[0]!;
    expect(claude.total).toBe(3000);
    expect(claude.tokens.input).toBe(1000);
    expect(claude.tokens.output).toBe(2000);
    expect(claude.confidence).toBe("host-reported");

    const qwen = result.rows[1]!;
    // sumTokens spans all five dimensions: input(1000-600 cached=400) +
    // output(250) + cacheRead(600) + reasoning(40) = 1290 — still < claude's 3000.
    expect(qwen.total).toBe(1290);
    expect(qwen.tokens.input).toBe(400);
    expect(qwen.tokens.output).toBe(250);
    expect(qwen.tokens.cacheRead).toBe(600);
    expect(qwen.tokens.reasoning).toBe(40);

    // Two distinct LOCAL platforms → no synced-skip notes for this slice.
    expect(result.skipped).toEqual([]);
  });

  it("scanning a single platform restricts the leaderboard to it", async () => {
    seedQwen("p", "s", [
      {
        type: "assistant",
        model: "qwen-max",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    ]);
    const result = await hostLeaderboard({ platforms: ["qwen-code"] });
    expect(result.rows.map((r) => r.key)).toEqual(["qwen-code"]);
    expect(result.rows[0]!.total).toBe(15);
  });

  it("by:model ranks the models instead of the platforms", async () => {
    seedClaude("-x", "s1", [
      {
        type: "assistant",
        requestId: "r",
        message: {
          id: "m",
          model: "claude-sonnet-4",
          usage: { input_tokens: 500, output_tokens: 500 },
        },
      },
    ]);
    seedQwen("p", "s2", [
      {
        type: "assistant",
        model: "qwen-max",
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
      },
    ]);
    const result = await hostLeaderboard({
      platforms: ["claude-code", "qwen-code"],
      by: "model",
    });
    expect(result.by).toBe("model");
    // The richer model (claude, 1000) outranks qwen (150).
    expect(result.rows[0]!.total).toBe(1000);
    expect(result.rows[1]!.total).toBe(150);
  });

  it("an empty HOME yields no rows (fail-open, never throws)", async () => {
    const result = await hostLeaderboard({ platforms: ["claude-code", "qwen-code"] });
    expect(result.rows).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// UNIT — the ranking contract hostLeaderboard delegates to aggregateBy
// ─────────────────────────────────────────────────────────────────────────

function tokens(partial: Partial<TokenBreakdown>): TokenBreakdown {
  return { ...emptyTokens(), ...partial };
}

function rec(over: Partial<UsageRecord>): UsageRecord {
  return {
    platformId: "claude-code",
    modelId: "claude-sonnet-4",
    providerId: "anthropic",
    sessionId: "s1",
    tokens: emptyTokens(),
    ts: 1_000,
    messageCount: 1,
    confidence: "host-reported",
    ...over,
  };
}

describe("host ranking (aggregateBy by platform)", () => {
  it("ranks platforms by total tokens desc and counts distinct sessions", () => {
    const rows = aggregateBy(
      [
        rec({ platformId: "claude-code", sessionId: "a", tokens: tokens({ input: 100, output: 100 }) }),
        rec({ platformId: "claude-code", sessionId: "b", tokens: tokens({ input: 100, output: 100 }) }),
        rec({ platformId: "codex", sessionId: "c", tokens: tokens({ input: 50, output: 50 }) }),
      ],
      "platform",
    );
    expect(rows.map((r) => r.key)).toEqual(["claude-code", "codex"]);
    expect(rows[0]!.total).toBe(400);
    expect(rows[0]!.sessions).toBe(2);
    expect(rows[1]!.total).toBe(100);
  });

  it("carries the worst confidence into the group (estimate downgrades reported)", () => {
    const rows = aggregateBy(
      [
        rec({ platformId: "kiro", confidence: "host-reported", tokens: tokens({ input: 10 }) }),
        rec({ platformId: "kiro", confidence: "host-estimated", tokens: tokens({ input: 10 }) }),
      ],
      "platform",
    );
    expect(rows[0]!.confidence).toBe("host-estimated");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Formatter
// ─────────────────────────────────────────────────────────────────────────

describe("formatHostLeaderboard", () => {
  it("renders an empty-state table", () => {
    const result: HostLeaderboardResult = { by: "platform", rows: [], skipped: [] };
    const out = formatHostLeaderboard(result);
    expect(out).toContain("PLATFORM");
    expect(out).toContain("(no host usage found)");
    expect(out).toContain("TOTAL");
  });

  it("renders a ranked table with a RANK column and the right KEY header per dimension", () => {
    const rows = aggregateBy(
      [
        rec({ platformId: "claude-code", tokens: tokens({ input: 300 }) }),
        rec({ platformId: "codex", tokens: tokens({ input: 100 }) }),
      ],
      "platform",
    );
    const out = formatHostLeaderboard({ by: "platform", rows, skipped: [] });
    const lines = out.split("\n");
    expect(lines[0]).toContain("RANK");
    expect(lines[0]).toContain("PLATFORM");
    const claudeIdx = lines.findIndex((l) => l.includes("claude-code"));
    const codexIdx = lines.findIndex((l) => l.includes("codex"));
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(codexIdx).toBeGreaterThan(claudeIdx); // claude ranked first
  });

  it("appends an estimate legend and skip notes when present", () => {
    const rows = aggregateBy(
      [rec({ platformId: "crush", confidence: "host-estimated", tokens: tokens({ input: 5 }) })],
      "platform",
    );
    const out = formatHostLeaderboard({
      by: "platform",
      rows,
      skipped: [{ platformId: "cursor", reason: "requires sync (no local cache found)" }],
    });
    expect(out).toContain("host-estimated rows are derived");
    expect(out).toContain("skipped");
    expect(out).toContain("cursor");
  });
});
