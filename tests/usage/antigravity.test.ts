/**
 * usage/antigravity — dedicated suite for the Antigravity usage readers.
 *
 * Two distinct native stores, both fail-open and MEDIUM-confidence (Antigravity
 * is fast-moving; docs are JS-rendered → the native JSONL `usage_metadata` shape
 * is observed, not byte-verified):
 *
 *   • antigravity (IDE)     — ~/.gemini/antigravity-ide/brain/<conv>/transcript*.jsonl
 *                             (launch-era ~/.gemini/antigravity/ probed as fallback),
 *                             plus a best-effort tokscale-cache mirror.
 *   • antigravity-cli (agy) — ~/.gemini/antigravity-cli/brain/<conv>/transcript*.jsonl
 *                             + history.jsonl per-conversation model index.
 *
 * Both embed a Gemini-style usage_metadata block per assistant turn; promptTokenCount
 * is cache-inclusive → net input = prompt − cached (≥ 0). `.pb` protobuf dumps have
 * no public schema → SKIPPED. This file is self-contained (its own temp-HOME harness)
 * and does NOT collide with tests/usage/u4-readers.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import antigravityReader from "../../src/usage/readers/antigravity.js";
import antigravityCliReader from "../../src/usage/readers/antigravity-cli.js";

// ─────────────────────────────────────────────────────────────────────────
// Self-contained harness: redirect HOME to a fresh temp dir, neutralize the
// XDG/APPDATA + per-platform overrides + the tokscale dir so resolution is
// deterministic and nothing escapes the sandbox. All touched env restored.
// ─────────────────────────────────────────────────────────────────────────

const SAVED_ENV = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "AGENT_CONNECTOR_TOKSCALE_DIR",
  "AGENT_CONNECTOR_ANTIGRAVITY_DIR",
  "AGENT_CONNECTOR_ANTIGRAVITY_CLI_DIR",
] as const;

let tmpHome: string;
let tokscaleDir: string;
let savedEnv: Record<string, string | undefined>;

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

beforeEach(() => {
  savedEnv = {};
  for (const key of SAVED_ENV) savedEnv[key] = process.env[key];

  tmpHome = mkdtempSync(join(tmpdir(), "ac-antig-usage-home-"));
  tokscaleDir = mkdtempSync(join(tmpdir(), "ac-antig-usage-toks-"));

  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome; // homedir() on Windows
  // Point the tokscale cache dir at an EMPTY temp dir so the IDE reader's cache
  // fallback contributes nothing unless a test writes into it.
  process.env.AGENT_CONNECTOR_TOKSCALE_DIR = tokscaleDir;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  delete process.env.APPDATA;
  delete process.env.LOCALAPPDATA;
  delete process.env.AGENT_CONNECTOR_ANTIGRAVITY_DIR;
  delete process.env.AGENT_CONNECTOR_ANTIGRAVITY_CLI_DIR;
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
// antigravity (IDE) native-brain reader
// ═════════════════════════════════════════════════════════════════════════

describe("antigravity IDE reader (native brain transcript fixture)", () => {
  /** Canonical native-IDE brain transcript path under the temp HOME. */
  function ideTranscript(conv: string, file: string): string {
    return join(tmpHome, ".gemini", "antigravity-ide", "brain", conv, file);
  }

  it("fails open to [] when neither native brain nor tokscale cache exists", async () => {
    expect(await antigravityReader.read({})).toEqual([]);
  });

  it("extracts usage_metadata, alias-resolves the model, skips .pb and zero-token rows", async () => {
    const conv = "ide-conv-1";
    // .pb sibling MUST be skipped (no public schema).
    writeFile(ideTranscript(conv, `${conv}.pb`), "\x00binary-proto");
    const jsonl =
      JSON.stringify({ type: "session_meta", modelId: "MODEL_PLACEHOLDER_M36" }) +
      "\n" +
      JSON.stringify({
        type: "turn",
        timestamp: 1775200000000,
        usage_metadata: {
          promptTokenCount: 120, // cache-inclusive
          candidatesTokenCount: 33,
          cachedContentTokenCount: 20,
          thoughtsTokenCount: 7,
        },
        responseId: "ide-r1",
      }) +
      "\n" +
      JSON.stringify({ type: "turn", usage_metadata: { promptTokenCount: 0 } }) + // zero → dropped
      "\n{ broken json\n"; // malformed → skipped
    writeFile(ideTranscript(conv, "transcript.jsonl"), jsonl);

    const records = await antigravityReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("antigravity");
    expect(r.sessionId).toBe(conv); // from brain/<conv>/
    expect(r.modelId).toBe("gemini-3.1-pro"); // MODEL_PLACEHOLDER_M36 alias
    expect(r.providerId).toBe("google");
    expect(r.tokens.input).toBe(100); // 120 prompt − 20 cached
    expect(r.tokens.output).toBe(33);
    expect(r.tokens.cacheRead).toBe(20);
    expect(r.tokens.cacheWrite).toBe(0); // Gemini never reports cache write
    expect(r.tokens.reasoning).toBe(7);
    expect(r.ts).toBe(1775200000000);
    expect(r.dedupKey).toBe(`${conv}:ide-r1`);
    expect(r.confidence).toBe("host-reported");
  });

  it("probes the launch-era ~/.gemini/antigravity/ root as a fallback", async () => {
    const conv = "legacy-conv";
    writeFile(
      join(tmpHome, ".gemini", "antigravity", "brain", conv, "transcript.jsonl"),
      JSON.stringify({
        model: "gemini-3-flash",
        timestamp: 1775200500000,
        usage_metadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
      }) + "\n",
    );
    const records = await antigravityReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.modelId).toBe("gemini-3-flash-preview"); // alias-resolved
    expect(records[0]!.tokens.input).toBe(9);
    expect(records[0]!.tokens.output).toBe(4);
  });

  it("snake_case usage_metadata spelling is tolerated", async () => {
    writeFile(
      ideTranscript("snake-conv", "transcript-0.jsonl"),
      JSON.stringify({
        model: "claude-opus-4-6",
        timestamp: 1775201000000,
        usage_metadata: {
          prompt_token_count: 50,
          candidates_token_count: 10,
          cached_content_token_count: 5,
        },
      }) + "\n",
    );
    const records = await antigravityReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.tokens.input).toBe(45); // 50 − 5
    expect(records[0]!.tokens.output).toBe(10);
    expect(records[0]!.tokens.cacheRead).toBe(5);
  });

  it("respects sinceMs (drops rows older than the cutoff)", async () => {
    writeFile(
      ideTranscript("old-conv", "transcript.jsonl"),
      JSON.stringify({
        timestamp: 1000,
        usage_metadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
      }) + "\n",
    );
    expect(await antigravityReader.read({ sinceMs: 1_700_000_000_000 })).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// antigravity-cli (`agy`) native-brain reader
// ═════════════════════════════════════════════════════════════════════════

describe("antigravity-cli reader (synthetic transcript.jsonl fixture)", () => {
  function cliRoot(): string {
    return join(tmpHome, ".gemini", "antigravity-cli");
  }

  it("fails open to [] when ~/.gemini/antigravity-cli is absent", async () => {
    expect(await antigravityCliReader.read({})).toEqual([]);
  });

  it("parses a synthetic transcript.jsonl with usage_metadata and history.jsonl model fallback", async () => {
    const conv = "agy-conv-1";
    // history.jsonl supplies the model when the transcript row carries none.
    writeFile(
      join(cliRoot(), "history.jsonl"),
      JSON.stringify({ id: conv, model: "kimi-k2.5-thinking" }) + "\n",
    );
    // .pb sibling MUST be skipped.
    writeFile(join(cliRoot(), "brain", conv, `${conv}.pb`), "\x00binary");
    writeFile(
      join(cliRoot(), "brain", conv, "transcript.jsonl"),
      JSON.stringify({
        type: "turn",
        timestamp: 1775300000000,
        usage_metadata: {
          promptTokenCount: 300,
          candidatesTokenCount: 60,
          cachedContentTokenCount: 100,
          thoughtsTokenCount: 15,
        },
        responseId: "agy-r1",
      }) + "\n",
    );

    const records = await antigravityCliReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("antigravity-cli");
    expect(r.sessionId).toBe(conv);
    expect(r.modelId).toBe("kimi-k2-thinking"); // history fallback, alias-resolved
    expect(r.tokens.input).toBe(200); // 300 − 100 cached
    expect(r.tokens.output).toBe(60);
    expect(r.tokens.cacheRead).toBe(100);
    expect(r.tokens.cacheWrite).toBe(0);
    expect(r.tokens.reasoning).toBe(15);
    expect(r.ts).toBe(1775300000000);
    expect(r.dedupKey).toBe(`${conv}:agy-r1`);
    expect(r.confidence).toBe("host-reported");
  });

  it("a session_meta row's model overrides the history fallback", async () => {
    const conv = "agy-conv-2";
    writeFile(
      join(cliRoot(), "history.jsonl"),
      JSON.stringify({ conversationId: conv, model: "gemini-3-pro" }) + "\n",
    );
    writeFile(
      join(cliRoot(), "brain", conv, "transcript.jsonl"),
      JSON.stringify({ type: "session_meta", modelId: "claude-sonnet-4.6" }) +
        "\n" +
        JSON.stringify({
          type: "turn",
          timestamp: 1775300500000,
          usage_metadata: { promptTokenCount: 20, candidatesTokenCount: 5 },
        }) +
        "\n",
    );
    const records = await antigravityCliReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.modelId).toBe("claude-sonnet-4-6"); // session_meta wins, alias-resolved
  });

  it("honors AGENT_CONNECTOR_ANTIGRAVITY_CLI_DIR and falls open on a .pb-only conversation", async () => {
    const overrideRoot = mkdtempSync(join(tmpdir(), "ac-antig-cli-override-"));
    process.env.AGENT_CONNECTOR_ANTIGRAVITY_CLI_DIR = overrideRoot;
    writeFile(join(overrideRoot, "brain", "c", "c.pb"), "\x00binary");

    expect(await antigravityCliReader.read({})).toEqual([]); // no transcript jsonl → []

    rmSync(overrideRoot, { recursive: true, force: true });
  });

  it("collects rows across multiple conversations and multiple transcript files", async () => {
    writeFile(
      join(cliRoot(), "brain", "c-a", "transcript.jsonl"),
      JSON.stringify({
        model: "gemini-3-pro",
        timestamp: 1775301000000,
        usage_metadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      }) + "\n",
    );
    writeFile(
      join(cliRoot(), "brain", "c-b", "transcript-1.jsonl"),
      JSON.stringify({
        model: "gemini-3-pro",
        timestamp: 1775301100000,
        usage_metadata: { promptTokenCount: 30, candidatesTokenCount: 6 },
      }) + "\n",
    );
    const records = await antigravityCliReader.read({});
    expect(records).toHaveLength(2);
    expect(records.reduce((s, r) => s + r.tokens.input, 0)).toBe(40);
  });
});
