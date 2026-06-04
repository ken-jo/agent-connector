/**
 * usage/antigravity — dedicated suite for the Antigravity usage readers.
 *
 * CONFIRMED-BY-INSTALL (2026-06-03, docs/research/antigravity-paths-confirmed.md):
 * the native Antigravity store is `~/.gemini/antigravity/conversations/<uuid>.pb`
 * — PROTOBUF with NO public schema — and `brain/<uuid>/` holds only media +
 * `*.metadata.json`. There are NO `transcript*.jsonl` files. The `agy` CLI SHARES
 * this same `~/.gemini/antigravity/` tree (no separate dir).
 *
 * So BOTH readers are SYNCED (kind:"synced", format:"synced-cache"): they NEVER
 * parse the `.pb` native store; they read only the tokscale synced-cache if a
 * separate tokscale run produced one, else return [] ("requires sync"). This file
 * asserts that fail-open contract + the synced-cache read path. It is
 * self-contained (its own temp-HOME harness) and does NOT collide with
 * tests/usage/u4-readers.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import antigravityReader from "../../src/usage/readers/antigravity.js";
import antigravityCliReader from "../../src/usage/readers/antigravity-cli.js";

// ─────────────────────────────────────────────────────────────────────────
// Self-contained harness: redirect HOME to a fresh temp dir, neutralize the
// XDG/APPDATA + per-platform overrides, and point the tokscale dir at an EMPTY
// temp dir so resolution is deterministic and nothing escapes the sandbox.
// All touched env restored.
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

/** Absolute path to a platform's cache subdir under the temp tokscale dir. */
function cacheDir(name: string): string {
  return join(tokscaleDir, name);
}

beforeEach(() => {
  savedEnv = {};
  for (const key of SAVED_ENV) savedEnv[key] = process.env[key];

  tmpHome = mkdtempSync(join(tmpdir(), "ac-antig-usage-home-"));
  tokscaleDir = mkdtempSync(join(tmpdir(), "ac-antig-usage-toks-"));

  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome; // homedir() on Windows
  // Point the tokscale cache dir at an EMPTY temp dir so the synced cache
  // contributes nothing unless a test writes into it.
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
// antigravity (IDE) reader — SYNCED, protobuf native store is never parsed
// ═════════════════════════════════════════════════════════════════════════

describe("antigravity IDE reader (synced; .pb native store is unreadable)", () => {
  it("fails open to [] when neither the synced cache nor a native store exists", async () => {
    expect(await antigravityReader.read({})).toEqual([]);
  });

  it("never parses the native .pb store — a conversations/*.pb dir yields []", async () => {
    // CONFIRMED native layout under ~/.gemini/antigravity/.
    writeFile(
      join(tmpHome, ".gemini", "antigravity", "conversations", "uuid-1.pb"),
      "\x00binary-proto",
    );
    writeFile(
      join(tmpHome, ".gemini", "antigravity", "brain", "uuid-1", "a.metadata.json"),
      JSON.stringify({ kind: "image" }),
    );
    expect(await antigravityReader.read({})).toEqual([]);
  });

  it("reads the tokscale synced cache (manifest + sessions/*.jsonl) when present", async () => {
    const root = cacheDir("antigravity-cache");
    writeFile(
      join(root, "manifest.json"),
      JSON.stringify([{ artifact_path: "sessions/s.jsonl" }]),
    );
    const jsonl =
      JSON.stringify({ type: "session_meta", sessionId: "s", modelId: "claude-sonnet-4.6" }) +
      "\n" +
      JSON.stringify({
        type: "usage",
        sessionId: "s",
        timestamp: 1775200000000,
        input: 100,
        output: 33,
        cacheRead: 20,
        cacheWrite: 0,
        reasoning: 7,
        responseId: "r1",
      }) +
      "\n";
    writeFile(join(root, "sessions", "s.jsonl"), jsonl);

    const records = await antigravityReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("antigravity");
    expect(r.sessionId).toBe("s");
    expect(r.modelId).toBe("claude-sonnet-4-6"); // alias-resolved
    expect(r.providerId).toBe("anthropic");
    expect(r.tokens.input).toBe(100);
    expect(r.tokens.output).toBe(33);
    expect(r.tokens.cacheRead).toBe(20);
    expect(r.tokens.reasoning).toBe(7);
    expect(r.ts).toBe(1775200000000);
    expect(r.dedupKey).toBe("r1");
    expect(r.confidence).toBe("host-reported");
  });

  it("respects sinceMs (drops cache rows older than the cutoff)", async () => {
    const root = cacheDir("antigravity-cache");
    writeFile(
      join(root, "sessions", "old.jsonl"),
      JSON.stringify({ type: "usage", sessionId: "old", timestamp: 1000, input: 5, output: 1 }) +
        "\n",
    );
    expect(await antigravityReader.read({ sinceMs: 1_700_000_000_000 })).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// antigravity-cli (`agy`) reader — SYNCED, shares the IDE .pb store
// ═════════════════════════════════════════════════════════════════════════

describe("antigravity-cli reader (synced; shares the IDE .pb store)", () => {
  it("fails open to [] when no synced cache exists", async () => {
    expect(await antigravityCliReader.read({})).toEqual([]);
  });

  it("never parses the shared native .pb store — a conversations/*.pb dir yields []", async () => {
    writeFile(
      join(tmpHome, ".gemini", "antigravity", "conversations", "c.pb"),
      "\x00binary",
    );
    expect(await antigravityCliReader.read({})).toEqual([]);
  });

  it("reads the shared antigravity-cache sessions/*.jsonl when present", async () => {
    const root = cacheDir("antigravity-cache");
    const jsonl =
      JSON.stringify({
        type: "usage",
        sessionId: "cli-s",
        timestamp: 1775300000000,
        input: 200,
        output: 60,
        cacheRead: 100,
        reasoning: 15,
        modelId: "kimi-k2.5-thinking",
        responseId: "cli-r1",
      }) + "\n";
    writeFile(join(root, "sessions", "cli-s.jsonl"), jsonl);

    const records = await antigravityCliReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.platformId).toBe("antigravity-cli");
    expect(r.sessionId).toBe("cli-s");
    expect(r.modelId).toBe("kimi-k2-thinking"); // alias-resolved
    expect(r.tokens.input).toBe(200);
    expect(r.tokens.output).toBe(60);
    expect(r.tokens.cacheRead).toBe(100);
    expect(r.tokens.reasoning).toBe(15);
    expect(r.ts).toBe(1775300000000);
    expect(r.dedupKey).toBe("cli-r1");
    expect(r.confidence).toBe("host-reported");
  });
});
