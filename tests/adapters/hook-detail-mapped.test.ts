/**
 * adapters/hook-detail-mapped — the synthesized-plugin (ts-plugin) hosts must
 * report only the events they ACTUALLY wire in their installHooks change detail.
 *
 * A connector may declare more canonical hook events than a given ts-plugin host
 * can map. OpenCode / Kilo CLI / OpenClaw have NO mapping for UserPromptSubmit;
 * OMP additionally maps PreCompact but not UserPromptSubmit. The change detail
 * must therefore list ONLY the mapped/wired events and call out any declared-but-
 * unsupported event separately, e.g.:
 *   "opencode plugin module (SessionStart,PreToolUse,PostToolUse; unsupported here: UserPromptSubmit)"
 * — it must NOT list UserPromptSubmit as if it were wired.
 *
 * The synthesized module already wires only mapped events (asserted elsewhere);
 * here we lock the human-facing detail to match that reality.
 *
 * Filesystem isolation: each test runs against a fresh os.tmpdir project dir with
 * HOME + AGENT_CONNECTOR_DATA_DIR redirected there, restored in afterEach.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import opencodeAdapter from "../../src/adapters/opencode/index.js";
import kiloCliAdapter from "../../src/adapters/kilo-cli/index.js";
import ompAdapter from "../../src/adapters/omp/index.js";
import openclawAdapter from "../../src/adapters/openclaw/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-db";

/**
 * A connector that declares MORE events than any ts-plugin host can map:
 * SessionStart + UserPromptSubmit + PreToolUse + PostToolUse + PreCompact.
 * (declared order follows the canonical ALL_EVENTS order.)
 */
function buildConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    hooks: {
      SessionStart: { handler: () => ({ decision: "allow" }) },
      UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
      PreToolUse: { handler: () => ({ decision: "allow" }) },
      PostToolUse: { handler: () => ({ decision: "allow" }) },
      PreCompact: { handler: () => ({ decision: "allow" }) },
    },
  });
}

function buildCtx(projectDir: string, connector: ResolvedConnector): InstallContext {
  return {
    connector,
    scope: "project",
    projectDir,
    homeBinPath: HOME_BIN,
    dataRoot: projectDir,
    dryRun: true, // detail strings are computed without touching disk
  };
}

let savedHome: string | undefined;
let savedDataDir: string | undefined;
let projectDir: string;
let ctx: InstallContext;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  projectDir = mkdtempSync(join(tmpdir(), "ac-hookdetail-"));
  process.env.HOME = projectDir;
  process.env.USERPROFILE = projectDir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(projectDir, ".agent-connector");
  ctx = buildCtx(projectDir, buildConnector());
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedDataDir === undefined) delete process.env.AGENT_CONNECTOR_DATA_DIR;
  else process.env.AGENT_CONNECTOR_DATA_DIR = savedDataDir;
});

/** The change whose detail names the plugin module (skip the manifest record). */
function moduleDetail(changes: { detail: string; path?: string }[]): string {
  const mod = changes.find(
    (c) => c.detail.includes("plugin module") && !c.path?.endsWith("package.json"),
  );
  expect(mod, "expected a plugin-module change record").toBeTruthy();
  return mod!.detail;
}

describe("ts-plugin installHooks change detail reports MAPPED events only", () => {
  it("opencode lists SessionStart,PreToolUse,PostToolUse and flags UserPromptSubmit + PreCompact unsupported", () => {
    const detail = moduleDetail(opencodeAdapter.installHooks(ctx));
    // mapped (declared order, intersected with EVENT_TO_OPENCODE)
    expect(detail).toContain("SessionStart,PreToolUse,PostToolUse");
    // declared-but-unmapped called out separately, never as wired
    expect(detail).toContain("unsupported here:");
    expect(detail).toContain("UserPromptSubmit");
    expect(detail).toContain("PreCompact");
    // the wired list must NOT contain the unsupported events before the marker
    const wired = detail.split("; unsupported here:")[0]!;
    expect(wired).not.toContain("UserPromptSubmit");
    expect(wired).not.toContain("PreCompact");
  });

  it("kilo-cli lists SessionStart,PreToolUse,PostToolUse and flags the unsupported events", () => {
    const detail = moduleDetail(kiloCliAdapter.installHooks(ctx));
    expect(detail).toContain("SessionStart,PreToolUse,PostToolUse");
    expect(detail).toContain("unsupported here:");
    expect(detail).toContain("UserPromptSubmit");
    const wired = detail.split("; unsupported here:")[0]!;
    expect(wired).not.toContain("UserPromptSubmit");
  });

  it("omp maps PreCompact too, so only UserPromptSubmit is unsupported", () => {
    const detail = moduleDetail(ompAdapter.installHooks(ctx));
    // OMP maps SessionStart, PreToolUse, PostToolUse AND PreCompact.
    expect(detail).toContain("SessionStart,PreToolUse,PostToolUse,PreCompact");
    expect(detail).toContain("unsupported here: UserPromptSubmit");
    const wired = detail.split("; unsupported here:")[0]!;
    expect(wired).not.toContain("UserPromptSubmit");
    // PreCompact IS wired by OMP, so it must appear in the wired list.
    expect(wired).toContain("PreCompact");
  });

  it("openclaw lists SessionStart,PreToolUse,PostToolUse and flags the unsupported events", () => {
    const detail = moduleDetail(openclawAdapter.installHooks(ctx));
    expect(detail).toContain("SessionStart,PreToolUse,PostToolUse");
    expect(detail).toContain("unsupported here:");
    expect(detail).toContain("UserPromptSubmit");
    const wired = detail.split("; unsupported here:")[0]!;
    expect(wired).not.toContain("UserPromptSubmit");
  });

  it("a fully-mapped connector emits no 'unsupported here' suffix", () => {
    const mappedOnly = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme",
      version: "1.0.0",
      hooks: {
        SessionStart: { handler: () => ({ decision: "allow" }) },
        PreToolUse: { handler: () => ({ decision: "allow" }) },
        PostToolUse: { handler: () => ({ decision: "allow" }) },
      },
    });
    const c = buildCtx(projectDir, mappedOnly);
    const detail = moduleDetail(opencodeAdapter.installHooks(c));
    expect(detail).toBe(
      "opencode plugin module (SessionStart,PreToolUse,PostToolUse)",
    );
    expect(detail).not.toContain("unsupported here");
  });
});
