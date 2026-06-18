/**
 * adapters/review-fixes — regression tests for the independent-review defect fixes.
 *
 * Each describe block pins one ROOT-CAUSE fix so a regression re-breaks loudly:
 *   • JSONC clobber — zed preserves sibling keys when the settings file
 *     carries a // comment (the data-loss bug before the parseJsonc fix).
 *   • overwrite guard — a present, non-empty, TRULY-malformed settings file is
 *     left untouched (a "warn"), never blanked to {}.
 *
 * (The openclaw parseJsonc-tolerance + dual-registration block has moved to the
 * per-host file adapters/openclaw.test.ts, the omp modify-degrades-to-allow block
 * to adapters/omp.test.ts, the qwen-code remote-transport-key block to
 * adapters/qwen-code.test.ts, the kimi deny-protocol/base-dir/parseEvent blocks
 * to adapters/kimi.test.ts, the roo-code disabled-reflects-server.enabled block
 * to adapters/roo-code.test.ts, and the codebuff env-ref-default block to
 * adapters/codebuff.test.ts, per tests/README.md.)
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDir } from "../../src/core/paths.js";
import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import zedAdapter from "../../src/adapters/zed/index.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-db";

function buildConnector(
  overrides: Partial<Parameters<typeof defineConnector>[0]> = {},
): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
    },
    hooks: {
      PreToolUse: { handler: () => ({ decision: "allow" }) },
      SessionStart: { handler: () => ({ decision: "allow" }) },
    },
    ...overrides,
  });
}

function buildCtx(
  projectDir: string,
  connector: ResolvedConnector,
  scope: InstallContext["scope"] = "project",
): InstallContext {
  return {
    connector,
    scope,
    projectDir,
    homeBinPath: HOME_BIN,
    dataRoot: projectDir,
    dryRun: false,
  };
}

let savedHome: string | undefined;
let savedDataDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  return dir;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ─────────────────────────────────────────────────────────────────────────
// JSONC clobber — sibling keys must SURVIVE when the file has comments
// ─────────────────────────────────────────────────────────────────────────

describe("JSONC clobber: zed settings.json with a // comment + sibling key", () => {
  it("preserves the sibling key and adds our entry (no data loss)", () => {
    const projectDir = freshProject("ac-rf-zed-");
    const ctx = buildCtx(projectDir, buildConnector());
    const settingsPath = zedAdapter.getServerConfigPath(ctx);

    // Pre-write a JSONC file: a // comment + an UNRELATED sibling key.
    ensureDir(join(projectDir, ".zed"));
    writeFileSync(
      settingsPath,
      `{
        // user's editor theme — must survive our merge
        "theme": "Ayu Dark",
        "context_servers": {
          "user-owned": { "command": "/bin/echo" }
        },
      }`,
      "utf8",
    );

    const changes = zedAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const cfg = readJson(settingsPath);
    // The unrelated sibling key SURVIVES (before the fix it was clobbered to {}).
    expect(cfg.theme).toBe("Ayu Dark");
    // The user's own context server SURVIVES.
    expect(cfg.context_servers["user-owned"]).toBeTruthy();
    // Our entry was added.
    expect(cfg.context_servers[CONNECTOR_ID]).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Overwrite guard — a TRULY-malformed file is NOT blanked
// ─────────────────────────────────────────────────────────────────────────

describe("overwrite guard: present, non-empty, TRULY-malformed settings file", () => {
  it("installServer returns a 'warn' and does NOT blank the file", () => {
    const projectDir = freshProject("ac-rf-guard-");
    const ctx = buildCtx(projectDir, buildConnector());
    const settingsPath = zedAdapter.getServerConfigPath(ctx);

    // Not just JSONC — genuinely broken JSON that even stripping cannot rescue.
    const malformed = `{ "theme": "dark", this is broken <<<< not json`;
    ensureDir(join(projectDir, ".zed"));
    writeFileSync(settingsPath, malformed, "utf8");

    const changes = zedAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("not parseable");

    // The original bytes are UNTOUCHED — never replaced with {}-based output.
    expect(readFileSync(settingsPath, "utf8")).toBe(malformed);
  });
});
