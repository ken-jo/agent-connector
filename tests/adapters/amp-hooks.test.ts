/**
 * adapters/amp-hooks — ts-plugin hook surface for the Amp (AmpCode) adapter.
 *
 * Amp loads TypeScript plugin modules from `.amp/plugins/<name>.ts`, each
 * default-exporting `(amp) => void` that registers `amp.on("<event>", …)`
 * handlers (ampcode.com/manual → Plugins). This adapter wires the five amp.on
 * events with a canonical analog and bridges them to the universal home-bin
 * entrypoint, exactly like the OMP / OpenCode ts-plugin adapters:
 *   SessionStart->session.start, UserPromptSubmit->agent.start,
 *   PreToolUse->tool.call, PostToolUse->tool.result, Stop->agent.end.
 * Amp documents NO session.end, so SessionEnd is an honest gap (warn-skip).
 *
 * These tests lock:
 *   - paradigm + capability flags (ts-plugin; canModifyArgs / canModifyOutput /
 *     canInjectSessionContext all false — tool.call uses the { action } decision
 *     union and tool.result's replacement shape is undocumented → observe-only)
 *   - installHooks writes .amp/plugins/<id>.ts at PROJECT scope
 *   - the generated module registers amp.on(session.start|agent.start|tool.call|
 *     tool.result|agent.end) + the canonical bridge(...) for each
 *   - SessionEnd warn-skips (reported "unsupported here", never a handler)
 *   - hooks:false suppresses the CANONICAL handlers (native still installs)
 *   - nativeHooks passthrough registers + bridges the native event verbatim
 *   - user scope warn-skips (no documented user-scope plugins dir)
 *   - idempotent second install → skip; uninstall removes the module
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import ampAdapter from "../../src/adapters/amp/index.js";

const CONNECTOR_ID = "acme-amp-hooks";
const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";

function buildCtx(
  projectDir: string,
  connector: ResolvedConnector,
  scope: "project" | "user" = "project",
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

/** Path of the generated ts-plugin module (project scope). */
function entryPath(projectDir: string): string {
  return join(projectDir, ".amp", "plugins", `${CONNECTOR_ID}.ts`);
}

let saved: Record<string, string | undefined> = {};
const KEYS = ["HOME", "USERPROFILE"];
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function freshHome(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ac-amp-hooks-")));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return dir;
}

/** A connector declaring all five mapped events + the unsupported SessionEnd. */
function allEventsConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Amp",
    version: "1.0.0",
    hooks: {
      SessionStart: { handler: () => ({ decision: "allow" }) },
      UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
      PreToolUse: { handler: () => ({ decision: "allow" }) },
      PostToolUse: { handler: () => ({ decision: "allow" }) },
      Stop: { handler: () => ({ decision: "allow" }) },
      // No Amp analog → reported "unsupported here", never wired.
      SessionEnd: { handler: () => ({ decision: "allow" }) },
    },
  });
}

describe("amp adapter — ts-plugin hooks", () => {
  it("declares the ts-plugin paradigm and the verified capability flags", () => {
    expect(ampAdapter.paradigm).toBe("ts-plugin");
    const c = ampAdapter.capabilities;
    expect(c.sessionStart).toBe(true);
    expect(c.userPromptSubmit).toBe(true);
    expect(c.preToolUse).toBe(true);
    expect(c.postToolUse).toBe(true);
    expect(c.stop).toBe(true);
    // Amp documents no session.end.
    expect(c.sessionEnd).toBe(false);
    expect(c.preCompact).toBe(false);
    expect(c.notification).toBe(false);
    // tool.call decision surface is the { action } union (no documented arg
    // rewrite); tool.result's replacement object shape is undocumented, so
    // PostToolUse is observe-only (canModifyOutput:false); no session.start
    // context-injection surface.
    expect(c.canModifyArgs).toBe(false);
    expect(c.canModifyOutput).toBe(false);
    expect(c.canInjectSessionContext).toBe(false);
    expect(c.supportsNativeHooks).toBe(true);
  });

  it("installHooks (project) writes .amp/plugins/<id>.ts with each amp.on + bridge", () => {
    const projectDir = freshHome();
    const changes = ampAdapter.installHooks(buildCtx(projectDir, allEventsConnector()));
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("amp");
    expect(changes[0]?.path).toBe(entryPath(projectDir));
    expect(existsSync(entryPath(projectDir))).toBe(true);

    const src = readFileSync(entryPath(projectDir), "utf8");
    // verified amp.on event names, each wired to its canonical bridge call.
    expect(src).toContain('amp.on("session.start"');
    expect(src).toContain('bridge("SessionStart"');
    expect(src).toContain('amp.on("agent.start"');
    expect(src).toContain('bridge("UserPromptSubmit"');
    expect(src).toContain('amp.on("tool.call"');
    expect(src).toContain('bridge("PreToolUse"');
    expect(src).toContain('amp.on("tool.result"');
    expect(src).toContain('bridge("PostToolUse"');
    expect(src).toContain('amp.on("agent.end"');
    expect(src).toContain('bridge("Stop"');
    // function-export plugin shape + the home-bin host token.
    expect(src).toContain("export default function plugin(amp: PluginAPI)");
    expect(src).toContain('"hook", "amp", event, "--connector"');
    // SessionEnd has no Amp analog → no session.end handler is emitted.
    expect(src).not.toContain("session.end");
  });

  it("PreToolUse blocks via the { action: 'reject-and-continue' } union; PostToolUse is observe-only", () => {
    const projectDir = freshHome();
    ampAdapter.installHooks(buildCtx(projectDir, allEventsConnector()));
    const src = readFileSync(entryPath(projectDir), "utf8");
    // tool.call: deny/ask → return amp's documented decision union (NOT a throw).
    expect(src).toContain('res.decision === "deny" || res.decision === "ask"');
    expect(src).toContain('action: "reject-and-continue"');
    expect(src).toContain('return { action: "allow" }');
    expect(src).not.toContain("throw new Error(");
    // tool.call tool name comes from the verified event.tool field.
    expect(src).toContain("event.tool");
    // tool.result: observe-only — the replacement object shape is undocumented,
    // so the handler returns nothing (no guessed { output } mutation).
    expect(src).not.toContain("res.updatedOutput");
    expect(src).not.toContain("return { output:");
    // session.start id from the verified event.thread.id field.
    expect(src).toContain("event.thread && event.thread.id");
  });

  it("reports SessionEnd as 'unsupported here' in the change detail", () => {
    const projectDir = freshHome();
    const changes = ampAdapter.installHooks(buildCtx(projectDir, allEventsConnector()));
    expect(changes[0]?.detail).toContain("unsupported here: SessionEnd");
    // The five mapped events ARE claimed.
    expect(changes[0]?.detail).toContain("SessionStart");
    expect(changes[0]?.detail).toContain("PreToolUse");
  });

  it("nativeHooks passthrough registers + bridges the native event verbatim", () => {
    const projectDir = freshHome();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme Amp Native",
      version: "1.0.0",
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        amp: { nativeHooks: { "thread.update": { handler: () => ({}) } } },
      },
    });
    const changes = ampAdapter.installHooks(buildCtx(projectDir, connector));
    expect(changes.some((c) => c.action === "skip")).toBe(false);

    const src = readFileSync(entryPath(projectDir), "utf8");
    expect(src).toContain('amp.on("thread.update"');
    expect(src).toContain('bridge("thread.update"');
    // the canonical handler is still wired alongside (no regression).
    expect(src).toContain('amp.on("tool.call"');
    expect(changes[0]?.detail).toContain("native: thread.update");
  });

  it("native-only connector (no canonical hooks) STILL synthesizes the plugin", () => {
    const projectDir = freshHome();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme Amp Native Only",
      version: "1.0.0",
      platforms: { amp: { nativeHooks: { "thread.update": { handler: () => ({}) } } } },
    });
    const changes = ampAdapter.installHooks(buildCtx(projectDir, connector));
    expect(changes.some((c) => c.action === "skip")).toBe(false);

    const src = readFileSync(entryPath(projectDir), "utf8");
    expect(src).toContain('amp.on("thread.update"');
    expect(src).not.toContain('amp.on("tool.call"');
    expect(src).toContain("export default function plugin(amp: PluginAPI)");
  });

  it("hooks:false disables canonical handlers but a nativeHook STILL registers", () => {
    const projectDir = freshHome();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme Amp Hooks Off",
      version: "1.0.0",
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        amp: { hooks: false, nativeHooks: { "thread.update": { handler: () => ({}) } } },
      },
    });
    const changes = ampAdapter.installHooks(buildCtx(projectDir, connector));
    expect(changes.some((c) => c.action === "skip")).toBe(false);

    const src = readFileSync(entryPath(projectDir), "utf8");
    expect(src).toContain('amp.on("thread.update"'); // native installed (sibling)
    expect(src).not.toContain('amp.on("tool.call"'); // canonical disabled by hooks:false
  });

  it("hooks:false with NO native events → skip 'hooks disabled for amp'", () => {
    const projectDir = freshHome();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme Amp Off",
      version: "1.0.0",
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: { amp: { hooks: false } },
    });
    const changes = ampAdapter.installHooks(buildCtx(projectDir, connector));
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("hooks disabled for amp");
    expect(existsSync(entryPath(projectDir))).toBe(false);
  });

  it("no hooks declared → skip 'connector declares no hooks'", () => {
    const projectDir = freshHome();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme Amp Bare",
      version: "1.0.0",
      memory: [{ content: "placeholder" }],
    });
    const changes = ampAdapter.installHooks(buildCtx(projectDir, connector));
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("connector declares no hooks");
  });

  it("user scope warn-skips (no documented user-scope plugins dir)", () => {
    const projectDir = freshHome();
    const changes = ampAdapter.installHooks(
      buildCtx(projectDir, allEventsConnector(), "user"),
    );
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("project-scoped");
    // Nothing is written under the project .amp/plugins tree either.
    expect(existsSync(entryPath(projectDir))).toBe(false);
  });

  it("idempotent second install → skip; uninstall removes the module", () => {
    const projectDir = freshHome();
    const ctx = buildCtx(projectDir, allEventsConnector());
    ampAdapter.installHooks(ctx);
    const second = ampAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const removed = ampAdapter.uninstallHooks(ctx);
    expect(removed[0]?.action).toBe("remove");
    expect(existsSync(entryPath(projectDir))).toBe(false);

    const again = ampAdapter.uninstallHooks(ctx);
    expect(again[0]?.action).toBe("skip");
  });

  it("formatReply emits the normalized HookResponse on stdout (exit 0)", () => {
    const reply = ampAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "nope",
    });
    expect(reply.exitCode).toBe(0);
    expect(JSON.parse(reply.stdout!)).toEqual({ decision: "deny", reason: "nope" });
  });

  it("parseEvent maps the bridge payload for each wired event", () => {
    const pre = ampAdapter.parseEvent!("PreToolUse", {
      toolName: "Bash",
      toolInput: { cmd: "ls" },
      sessionId: "s1",
      projectDir: "/p",
    });
    expect(pre).toMatchObject({
      hostPlatform: "amp",
      toolName: "Bash",
      toolInput: { cmd: "ls" },
      sessionId: "s1",
      projectDir: "/p",
    });

    const ups = ampAdapter.parseEvent!("UserPromptSubmit", { prompt: "hi" });
    expect(ups).toMatchObject({ hostPlatform: "amp", prompt: "hi" });

    const post = ampAdapter.parseEvent!("PostToolUse", {
      toolName: "Bash",
      toolOutput: "done",
      isError: false,
    });
    expect(post).toMatchObject({ toolName: "Bash", toolOutput: "done", isError: false });

    const stop = ampAdapter.parseEvent!("Stop", { sessionId: "s2" });
    expect(stop).toMatchObject({ hostPlatform: "amp", sessionId: "s2" });
  });
});
