import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import qwenReader from "../../src/usage/readers/qwen-code.js";
import type { UsageRecord } from "../../src/usage/types.js";

// ─────────────────────────────────────────────────────────────────────────
// Temp HOME harness: the reader resolves ~/.qwen/projects via os.homedir(),
// which honors process.env.HOME on POSIX. Each test gets a fresh fake HOME.
// ─────────────────────────────────────────────────────────────────────────

const ORIG_HOME = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-qwen-home-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Write a chats JSONL file under ~/.qwen/projects/<project>/chats/<session>.jsonl. */
function writeChat(project: string, session: string, lines: unknown[]): void {
  const dir = join(tmpHome, ".qwen", "projects", project, "chats");
  mkdirSync(dir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(dir, `${session}.jsonl`), body, "utf8");
}

function read(): Promise<UsageRecord[]> {
  return qwenReader.read({});
}

// ─────────────────────────────────────────────────────────────────────────
// Token extraction
// ─────────────────────────────────────────────────────────────────────────

describe("qwen-code reader — token extraction", () => {
  it("extracts input/output/cacheRead/reasoning with input = prompt - cached", async () => {
    writeChat("proj1", "sessA", [
      {
        type: "assistant",
        model: "qwen-max",
        sessionId: "sessA",
        timestamp: "2026-01-15T10:00:00.000Z",
        usageMetadata: {
          promptTokenCount: 1000, // cumulative prompt incl. cached context
          candidatesTokenCount: 250, // → output
          thoughtsTokenCount: 40, // → reasoning
          cachedContentTokenCount: 600, // → cacheRead
        },
      },
    ]);

    const records = await read();
    expect(records).toHaveLength(1);
    const r = records[0]!;
    // input is the NET fresh prompt: 1000 - 600 = 400
    expect(r.tokens.input).toBe(400);
    expect(r.tokens.output).toBe(250);
    expect(r.tokens.cacheRead).toBe(600);
    expect(r.tokens.reasoning).toBe(40);
    // Qwen never reports cacheWrite.
    expect(r.tokens.cacheWrite).toBe(0);
  });

  it("clamps net input to >= 0 when cached exceeds the prompt count", async () => {
    writeChat("proj1", "sessClamp", [
      {
        type: "assistant",
        model: "qwen-max",
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 10,
          cachedContentTokenCount: 500, // > prompt → input clamps to 0
        },
      },
    ]);

    const records = await read();
    expect(records).toHaveLength(1);
    expect(records[0]?.tokens.input).toBe(0);
    expect(records[0]?.tokens.cacheRead).toBe(500);
    expect(records[0]?.tokens.output).toBe(10);
  });

  it("treats missing token fields as zero", async () => {
    writeChat("proj1", "sessPartial", [
      {
        type: "assistant",
        model: "qwen-plus",
        usageMetadata: {
          promptTokenCount: 80,
          candidatesTokenCount: 20,
          // no thoughts, no cached
        },
      },
    ]);

    const records = await read();
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.tokens.input).toBe(80); // 80 - 0
    expect(r.tokens.output).toBe(20);
    expect(r.tokens.cacheRead).toBe(0);
    expect(r.tokens.reasoning).toBe(0);
    expect(r.tokens.cacheWrite).toBe(0);
  });

  it("keeps a fully-cached prompt (prompt>0, fresh input 0) as a non-zero record", async () => {
    writeChat("proj1", "sessCached", [
      {
        type: "assistant",
        model: "qwen-max",
        usageMetadata: {
          promptTokenCount: 500,
          candidatesTokenCount: 0,
          cachedContentTokenCount: 500, // entire prompt cached
        },
      },
    ]);

    const records = await read();
    expect(records).toHaveLength(1);
    expect(records[0]?.tokens.input).toBe(0);
    expect(records[0]?.tokens.cacheRead).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Line filtering
// ─────────────────────────────────────────────────────────────────────────

describe("qwen-code reader — line filtering", () => {
  it("ignores non-assistant lines and lines without usageMetadata", async () => {
    writeChat("proj1", "sessMixed", [
      { type: "user", text: "hello" },
      { type: "system", text: "boot" },
      { type: "assistant", model: "qwen-max" }, // no usageMetadata
      {
        type: "assistant",
        model: "qwen-max",
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5 },
      },
    ]);

    const records = await read();
    expect(records).toHaveLength(1);
    expect(records[0]?.tokens.input).toBe(30);
    expect(records[0]?.tokens.output).toBe(5);
  });

  it("drops all-zero-token assistant entries", async () => {
    writeChat("proj1", "sessZero", [
      {
        type: "assistant",
        model: "qwen-max",
        usageMetadata: {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 0,
          cachedContentTokenCount: 0,
        },
      },
    ]);

    const records = await read();
    expect(records).toHaveLength(0);
  });

  it("skips malformed JSONL lines without throwing", async () => {
    const dir = join(tmpHome, ".qwen", "projects", "proj1", "chats");
    mkdirSync(dir, { recursive: true });
    const good = JSON.stringify({
      type: "assistant",
      model: "qwen-max",
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
    });
    writeFileSync(join(dir, "sessBad.jsonl"), `{ not valid json\n${good}\n`, "utf8");

    const records = await read();
    expect(records).toHaveLength(1);
    expect(records[0]?.tokens.input).toBe(12);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Metadata: session id, model/provider, project, confidence
// ─────────────────────────────────────────────────────────────────────────

describe("qwen-code reader — metadata", () => {
  it("prefers the line's sessionId when present", async () => {
    writeChat("proj1", "fileName", [
      {
        type: "assistant",
        model: "qwen-max",
        sessionId: "explicit-session-id",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
      },
    ]);

    const records = await read();
    expect(records[0]?.sessionId).toBe("explicit-session-id");
  });

  it("falls back to <project>-<filename> when no sessionId on the line", async () => {
    writeChat("my-project", "chat-42", [
      {
        type: "assistant",
        model: "qwen-max",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
      },
    ]);

    const records = await read();
    expect(records[0]?.sessionId).toBe("my-project-chat-42");
  });

  it("infers provider qwen from a qwen model id and sets platformId", async () => {
    writeChat("proj1", "sessProv", [
      {
        type: "assistant",
        model: "qwen-max",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
      },
    ]);

    const records = await read();
    expect(records[0]?.platformId).toBe("qwen-code");
    expect(records[0]?.providerId).toBe("qwen");
    expect(records[0]?.modelId).toBe("qwen-max");
    expect(records[0]?.confidence).toBe("host-reported");
    expect(records[0]?.messageCount).toBe(1);
  });

  it("defaults the model to 'unknown' and provider to 'qwen' when model is absent", async () => {
    writeChat("proj1", "sessNoModel", [
      {
        type: "assistant",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
      },
    ]);

    const records = await read();
    expect(records[0]?.modelId).toBe("unknown");
    expect(records[0]?.providerId).toBe("qwen");
  });

  it("derives projectKey/projectLabel from the path window", async () => {
    writeChat("acme-repo", "sessProj", [
      {
        type: "assistant",
        model: "qwen-max",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
      },
    ]);

    const records = await read();
    expect(records[0]?.projectKey).toContain("acme-repo");
    expect(records[0]?.projectLabel).toBe("acme-repo");
  });

  it("parses the RFC3339 timestamp into epoch ms", async () => {
    writeChat("proj1", "sessTs", [
      {
        type: "assistant",
        model: "qwen-max",
        timestamp: "2026-01-15T10:00:00.000Z",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
      },
    ]);

    const records = await read();
    expect(records[0]?.ts).toBe(Date.parse("2026-01-15T10:00:00.000Z"));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// sinceMs filtering + fail-open
// ─────────────────────────────────────────────────────────────────────────

describe("qwen-code reader — sinceMs + fail-open", () => {
  it("drops records older than sinceMs", async () => {
    writeChat("proj1", "sessSince", [
      {
        type: "assistant",
        model: "qwen-max",
        timestamp: "2020-01-01T00:00:00.000Z", // old
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
      },
      {
        type: "assistant",
        model: "qwen-max",
        timestamp: "2026-01-01T00:00:00.000Z", // new
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 2 },
      },
    ]);

    const cutoff = Date.parse("2025-01-01T00:00:00.000Z");
    const records = await qwenReader.read({ sinceMs: cutoff });
    expect(records).toHaveLength(1);
    expect(records[0]?.tokens.input).toBe(20);
  });

  it("returns [] (fail-open) when ~/.qwen/projects does not exist", async () => {
    // fresh tmpHome with nothing written
    const records = await read();
    expect(records).toEqual([]);
  });

  it("aggregates assistant lines from multiple files/projects", async () => {
    writeChat("projA", "s1", [
      { type: "assistant", model: "qwen-max", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 } },
    ]);
    writeChat("projB", "s2", [
      { type: "assistant", model: "qwen-plus", usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 2 } },
    ]);

    const records = await read();
    expect(records).toHaveLength(2);
    const inputs = records.map((r) => r.tokens.input).sort((a, b) => a - b);
    expect(inputs).toEqual([10, 20]);
  });
});
