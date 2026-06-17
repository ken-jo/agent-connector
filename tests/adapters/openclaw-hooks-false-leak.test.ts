/**
 * adapters/nemoclaw — hooks:false must NOT leak canonical handlers via installActions.
 *
 * Regression for a release-review blocker: the generated OpenClaw/NemoClaw plugin
 * module is synthesized by BOTH installHooks AND installActions (a connector with
 * actions but hooks:false still writes the module — for the actions).
 * buildPluginSource must therefore honor `platforms[host].hooks === false` and emit
 * NO canonical api.on("before_tool_call"/"after_tool_call") handler, or hooks:false
 * (an advertised opt-out) would silently re-enable tool gating. Mirrors omp/opencode's
 * canonicalOff guard. NemoClaw inherits buildPluginSource from OpenClaw. (The
 * openclaw row of this suite has moved to adapters/openclaw.test.ts; this file
 * finishes the nemoclaw migration in a later PR.)
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import nemoclawAdapter from "../../src/adapters/nemoclaw/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-leak";

function buildCtx(projectDir: string, connector: ResolvedConnector): InstallContext {
  return { connector, scope: "project", projectDir, homeBinPath: HOME_BIN, dataRoot: projectDir, dryRun: false };
}

/** A connector with a canonical PreToolUse hook + an action, hooks toggled per arg. */
function connector(hooksDisabled: boolean): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    actions: [{ id: "reindex", description: "Rebuild the search index.", run: () => undefined }],
    platforms: hooksDisabled ? { nemoclaw: { hooks: false } } : {},
  });
}

let savedHome: string | undefined;
let savedUP: string | undefined;
beforeEach(() => { savedHome = process.env.HOME; savedUP = process.env.USERPROFILE; });
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedUP === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUP;
});
function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-openclaw-leak-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return dir;
}

describe.each([
  ["nemoclaw", nemoclawAdapter],
])("%s adapter — hooks:false does not leak canonical handlers via installActions", (_name, adapter) => {
  it("installActions writes the plugin for the action but OMITS the canonical before_tool_call handler under hooks:false", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, connector(true));
    adapter.installActions!(ctx);
    const src = readFileSync(adapter.getHookConfigPath!(ctx), "utf8");
    // Canonical handlers register via on("<native_event>", …) — MUST be
    // suppressed by hooks:false (omitted from the generated source entirely).
    expect(src).not.toContain('on("before_tool_call"');
    expect(src).not.toContain('on("after_tool_call"');
    // The plugin WAS written (for the action) — registerCommand present.
    expect(src).toContain("reindex");
  });

  it("CONTROL: with hooks enabled, the same connector DOES emit the canonical before_tool_call handler", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, connector(false));
    adapter.installActions!(ctx);
    const src = readFileSync(adapter.getHookConfigPath!(ctx), "utf8");
    expect(src).toContain('on("before_tool_call"');
  });
});
