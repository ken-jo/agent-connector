/**
 * adapters/opencode — focused tests for the two hooks fixes:
 *
 *   A. PermissionRequest → "permission.ask" (hooks-canonical). The generated
 *      plugin emits a "permission.ask" handler that MUTATES output.status
 *      ("ask"|"deny"|"allow") rather than returning a value — verified against
 *      anomalyco/opencode packages/plugin/src/index.ts. capabilities
 *      .permissionRequest is true and the docs hooks-matrix cell is non-null.
 *   B. nativeHooks opt-in (hooks-native). capabilities.supportsNativeHooks is
 *      true; OpenCode-native passthrough events declared on
 *      platforms["opencode"].nativeHooks are emitted as fire-and-forget bridge
 *      registrations and the install gate synthesizes the plugin for them even
 *      with no canonical hookEvents.
 *
 * Filesystem isolation: every test gets a fresh mkdtemp project dir with HOME +
 * AGENT_CONNECTOR_DATA_DIR redirected there, restored in afterEach. Project scope
 * throughout for deterministic paths. The generated bridge is exercised LIVE with
 * node:child_process mocked so a "deny" round-trips through output.status.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";
import { platforms as matrixPlatforms } from "../../site/src/components/docs/hooks-matrix.js";

import ocAdapter from "../../src/adapters/opencode/index.js";

// ── node:child_process mock (hoisted above imports) ───────────────────────
let execFileSyncImpl: (...args: any[]) => string = () => "";
const execFileSyncMock = vi.fn((...args: any[]) => execFileSyncImpl(...args));
vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: execFileSyncMock,
}));

// Pin POSIX so the generated bridge takes its execFileSync(HOME_BIN, [argv]) path.
const REAL_PLATFORM = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

const CONNECTOR_ID = "acme-db";
const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";

/** Connector declaring PermissionRequest + an OpenCode-native passthrough event. */
function buildConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    hooks: {
      PreToolUse: {
        matcher: "acme_write",
        handler: () => ({ decision: "allow" }),
      },
      PermissionRequest: {
        matcher: "acme_write",
        handler: () => ({ decision: "deny", reason: "blocked" }),
      },
    },
    platforms: {
      opencode: {
        nativeHooks: { "session.idle": { handler: () => undefined } },
      },
    },
  });
}

/** Connector with NO canonical hooks — only an OpenCode-native passthrough. */
function buildNativeOnlyConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    platforms: {
      opencode: {
        nativeHooks: { "session.idle": { handler: () => undefined } },
      },
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
    dryRun: false,
  };
}

let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedDataDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  execFileSyncMock.mockClear();
  execFileSyncImpl = () => "";
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedUserProfile);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshProject(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  return dir;
}

// ── Fix A: PermissionRequest → permission.ask ──────────────────────────────

describe("opencode — capabilities + docs-matrix wiring", () => {
  it("declares permissionRequest === true", () => {
    expect(ocAdapter.capabilities.permissionRequest).toBe(true);
  });

  it("declares supportsNativeHooks === true", () => {
    expect(ocAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("the docs hooks-matrix opencode PermissionRequest cell is permission.ask", () => {
    const entry = matrixPlatforms.find((p) => p.platform === "opencode")!;
    expect(entry.events.PermissionRequest).toBe("permission.ask");
  });
});

describe("opencode — generated plugin: permission.ask handler", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let pluginPath: string;

  beforeEach(() => {
    projectDir = freshProject("ac-oc-perm-");
    ctx = buildCtx(projectDir, buildConnector());
    pluginPath = ocAdapter.getHookConfigPath(ctx);
  });

  it("source contains a permission.ask handler that mutates output.status to 'deny'", () => {
    ocAdapter.installHooks(ctx);
    const src = readFileSync(pluginPath, "utf8");
    expect(src).toContain('"permission.ask": async (input, output) =>');
    expect(src).toContain('bridge("PermissionRequest"');
    // MUTATES output.status — never returns a value.
    expect(src).toContain('if (res.decision === "deny") output.status = "deny";');
    expect(src).toContain('else if (res.decision === "ask") output.status = "ask";');
  });

  it("LIVE: a 'deny' mutates output.status to 'deny' (no return value)", async () => {
    ocAdapter.installHooks(ctx);
    execFileSyncImpl = () => JSON.stringify({ decision: "deny", reason: "blocked" });

    const url = `${pathToFileURL(pluginPath).href}?t=${Date.now()}-${Math.random()}`;
    const mod = await import(/* @vite-ignore */ url);
    const hooks = await mod.default({ directory: projectDir });
    const permissionAsk = hooks["permission.ask"];
    expect(typeof permissionAsk).toBe("function");

    const output = { status: "ask" as "ask" | "deny" | "allow" };
    const ret = await permissionAsk({ type: "acme_write", sessionID: "s1" }, output);

    expect(ret).toBeUndefined(); // mutates, does NOT return
    expect(output.status).toBe("deny");

    const [bin, argv] = execFileSyncMock.mock.calls[0]!;
    expect(bin).toBe(HOME_BIN);
    expect(argv).toEqual(["hook", "opencode", "PermissionRequest", "--connector", CONNECTOR_ID]);
  });

  it("LIVE: an 'allow' decision leaves output.status untouched", async () => {
    ocAdapter.installHooks(ctx);
    execFileSyncImpl = () => JSON.stringify({ decision: "allow" });

    const url = `${pathToFileURL(pluginPath).href}?t=${Date.now()}-${Math.random()}`;
    const mod = await import(/* @vite-ignore */ url);
    const hooks = await mod.default({ directory: projectDir });

    const output = { status: "ask" as "ask" | "deny" | "allow" };
    await hooks["permission.ask"]({ type: "acme_write", sessionID: "s1" }, output);
    expect(output.status).toBe("ask"); // default/allow left alone
  });

  it("parseEvent normalizes PermissionRequest from the bridge payload", () => {
    const evt = ocAdapter.parseEvent!("PermissionRequest", {
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "oc-1",
      projectDir: "/some/proj",
    });
    expect(evt).toMatchObject({
      hostPlatform: "opencode",
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "oc-1",
      projectDir: "/some/proj",
    });
  });
});

// ── Fix B: nativeHooks opt-in ──────────────────────────────────────────────

describe("opencode — generated plugin: native passthrough events", () => {
  it("a nativeHooks event appears as a bridge registration in the generated plugin", () => {
    const projectDir = freshProject("ac-oc-native-");
    const ctx = buildCtx(projectDir, buildConnector());
    ocAdapter.installHooks(ctx);
    const src = readFileSync(ocAdapter.getHookConfigPath(ctx), "utf8");
    // Computed (quoted) key + a bridge() call with the verbatim native name.
    expect(src).toContain('["session.idle"]: async (input, output) =>');
    expect(src).toContain('bridge("session.idle"');
    expect(src).toContain("raw: input,");
  });

  it("install synthesizes the plugin for a native-only connector (no canonical hooks)", () => {
    const projectDir = freshProject("ac-oc-native-only-");
    const ctx = buildCtx(projectDir, buildNativeOnlyConnector());
    const changes = ocAdapter.installHooks(ctx);
    const pluginPath = ocAdapter.getHookConfigPath(ctx);

    expect(changes.some((c) => c.action === "create")).toBe(true);
    expect(existsSync(pluginPath)).toBe(true);

    const src = readFileSync(pluginPath, "utf8");
    expect(src).toContain('bridge("session.idle"');
    // No canonical handlers were emitted.
    expect(src).not.toContain("tool.execute.before");
    expect(src).not.toContain('"permission.ask"');
  });

  it("LIVE: a native event fires the bridge with `hook opencode session.idle`", async () => {
    const projectDir = freshProject("ac-oc-native-live-");
    const ctx = buildCtx(projectDir, buildConnector());
    ocAdapter.installHooks(ctx);

    const pluginPath = ocAdapter.getHookConfigPath(ctx);
    const url = `${pathToFileURL(pluginPath).href}?t=${Date.now()}-${Math.random()}`;
    const mod = await import(/* @vite-ignore */ url);
    const hooks = await mod.default({ directory: projectDir });

    const idle = hooks["session.idle"];
    expect(typeof idle).toBe("function");
    await idle({ sessionID: "s1", foo: "bar" }, {});

    const [bin, argv] = execFileSyncMock.mock.calls[0]!;
    expect(bin).toBe(HOME_BIN);
    expect(argv).toEqual(["hook", "opencode", "session.idle", "--connector", CONNECTOR_ID]);
  });

  it("`hooks: false` disables canonical handlers but keeps native passthrough", () => {
    const projectDir = freshProject("ac-oc-hooks-false-");
    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        opencode: {
          hooks: false,
          nativeHooks: { "session.idle": { handler: () => undefined } },
        },
      },
    });
    const ctx = buildCtx(projectDir, connector);
    ocAdapter.installHooks(ctx);
    const src = readFileSync(ocAdapter.getHookConfigPath(ctx), "utf8");
    expect(src).not.toContain("tool.execute.before");
    expect(src).toContain('bridge("session.idle"');
  });
});
