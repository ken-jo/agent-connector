/**
 * core/native-hooks — the platform-scoped NATIVE HOOKS PASSTHROUGH.
 *
 * Covers the whole feature spine:
 *   • defineConnector validation — collision with the 12 normalized events is a
 *     ConnectorConfigError, handlers must be functions, matcher must be a
 *     string, and a nativeHooks-only connector is a legal sole payload.
 *   • Registration — the persisted connector.json keeps nativeHooks event-name
 *     keys (+matcher) but strips the non-serializable handler.
 *   • claude-code adapter — installHooks writes settings.json entries with the
 *     native event name VERBATIM + the home-bin command shape; idempotent;
 *     uninstallHooks strips them.
 *   • Runtime — runNativeHook passes the RAW stdin payload to the handler and
 *     serializes its return VERBATIM to stdout (exit 0); void → silent allow;
 *     a throw fails OPEN (exit 0, no output); telemetry records the native
 *     event name on the same scope:"hook" store path.
 *   • Hook CLI — a non-union event name is accepted only when declared; the
 *     strict unknown-event error is kept otherwise.
 *   • Installer — a nativeHooks declaration for a host whose adapter lacks
 *     supportsNativeHooks yields the standard skip-warn ChangeRecord.
 *
 * Isolation: HOME + AGENT_CONNECTOR_DATA_DIR point at fresh temp dirs and are
 * restored in afterEach (the fixture module pattern mirrors
 * tests/integration/hook.test.ts — runNativeHook re-imports the module to
 * recover live handlers, since functions cannot survive the JSON registry).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConnectorConfigError,
  defineConnector,
} from "../../src/core/define-connector.js";
import {
  loadConnectorFromPath,
  readRegisteredMeta,
  registerConnector,
} from "../../src/core/load-connector.js";
import { installConnector } from "../../src/core/installer.js";
import {
  isNativeHookDeclared,
  runNativeHook,
} from "../../src/runtime/hook-entrypoint.js";
import { run as runHookCli } from "../../src/cli/commands/hook.js";
import { openStore } from "../../src/telemetry/store.js";
import claudeAdapter from "../../src/adapters/claude-code/index.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

const CONNECTOR_ID = "native-fx";
const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
  HOST: process.env.AGENT_CONNECTOR_HOST,
};

let tmpHome: string;
let tmpData: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-native-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-native-data-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  delete process.env.AGENT_CONNECTOR_TELEMETRY;
  delete process.env.AGENT_CONNECTOR_HOST;
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of [tmpHome, tmpData]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/**
 * Fixture connector module: nativeHooks-only, exported as a PLAIN config so
 * loadConnectorFromPath runs it through THIS repo's defineConnector on every
 * (re-)import. TaskCreated echoes what the handler received (verbatim-output
 * proof), TeammateIdle returns void, StopFailure throws (fail-open proof).
 */
function writeFixtureModule(dir: string): string {
  const modPath = join(dir, "native.config.mjs");
  const source = `
export default {
  id: ${JSON.stringify(CONNECTOR_ID)},
  platforms: {
    "claude-code": {
      nativeHooks: {
        TaskCreated: {
          handler(evt) {
            return {
              continue: false,
              stopReason: "task vetoed by native hook",
              event: evt.event,
              sessionId: evt.sessionId,
              projectDir: evt.projectDir,
              echo: evt.raw,
            };
          },
        },
        TeammateIdle: {
          handler() {},
        },
        StopFailure: {
          matcher: "rate_limit|overloaded",
          handler() {
            throw new Error("boom");
          },
        },
      },
    },
  },
};
`;
  writeFileSync(modPath, source, "utf8");
  return modPath;
}

async function registerFixture(): Promise<ResolvedConnector> {
  const modPath = writeFixtureModule(tmpData);
  const { connector } = await loadConnectorFromPath(modPath);
  registerConnector(connector, modPath);
  return connector;
}

function buildCtx(connector: ResolvedConnector, projectDir: string): InstallContext {
  return {
    connector,
    scope: "project",
    projectDir,
    homeBinPath: HOME_BIN,
    dataRoot: projectDir,
    dryRun: false,
  };
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ─────────────────────────────────────────────────────────────────────────
// defineConnector validation
// ─────────────────────────────────────────────────────────────────────────

describe("defineConnector — nativeHooks validation", () => {
  it("rejects a native event name that collides with the normalized union", () => {
    expect(() =>
      defineConnector({
        id: "collide",
        platforms: {
          "claude-code": {
            nativeHooks: { PreToolUse: { handler: () => {} } },
          },
        },
      }),
    ).toThrow(ConnectorConfigError);
    try {
      defineConnector({
        id: "collide",
        platforms: {
          "claude-code": { nativeHooks: { Stop: { handler: () => {} } } },
        },
      });
      throw new Error("expected to throw");
    } catch (e) {
      // The error directs to the normalized hooks API.
      expect((e as Error).message).toContain("normalized");
      expect((e as Error).message).toContain("hooks.Stop");
    }
  });

  it("rejects a non-function handler", () => {
    expect(() =>
      defineConnector({
        id: "bad-native",
        platforms: {
          "claude-code": {
            nativeHooks: { TaskCreated: { handler: "nope" } as unknown as never },
          },
        },
      }),
    ).toThrow(ConnectorConfigError);
    expect(() =>
      defineConnector({
        id: "bad-native-2",
        platforms: {
          "claude-code": {
            nativeHooks: { TaskCreated: {} as unknown as never },
          },
        },
      }),
    ).toThrow(ConnectorConfigError);
  });

  it("rejects a non-string matcher", () => {
    expect(() =>
      defineConnector({
        id: "bad-matcher",
        platforms: {
          "claude-code": {
            nativeHooks: {
              TaskCreated: { matcher: 42, handler: () => {} } as unknown as never,
            },
          },
        },
      }),
    ).toThrow(ConnectorConfigError);
  });

  it("rejects a nativeHooks value that is not an object map", () => {
    expect(() =>
      defineConnector({
        id: "bad-shape",
        platforms: {
          "claude-code": { nativeHooks: [] as unknown as never },
        },
      }),
    ).toThrow(ConnectorConfigError);
  });

  it("accepts a nativeHooks-only connector and keeps live handlers in platforms (never in hookEvents)", () => {
    const handler = () => ({ continue: false });
    const resolved = defineConnector({
      id: "native-only",
      platforms: {
        "claude-code": {
          nativeHooks: { TaskCreated: { matcher: "", handler } },
        },
      },
    });
    // Native events never enter the normalized hookEvents list.
    expect(resolved.hookEvents).toEqual([]);
    // platforms survive resolution VERBATIM — the live handler is preserved.
    expect(
      resolved.platforms["claude-code"]?.nativeHooks?.TaskCreated?.handler,
    ).toBe(handler);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Registration record (connector.json)
// ─────────────────────────────────────────────────────────────────────────

describe("registerConnector — nativeHooks persistence", () => {
  it("persists native event-name keys (+matcher) but strips the handler", async () => {
    await registerFixture();
    const meta = readRegisteredMeta(CONNECTOR_ID);
    expect(meta).not.toBeNull();
    const native = meta!.platforms["claude-code"]?.nativeHooks as
      | Record<string, { matcher?: string; handler?: unknown }>
      | undefined;
    expect(native).toBeDefined();
    expect(Object.keys(native!).sort()).toEqual(
      ["StopFailure", "TaskCreated", "TeammateIdle"].sort(),
    );
    expect(native!.StopFailure!.matcher).toBe("rate_limit|overloaded");
    expect(native!.TaskCreated!.handler).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// claude-code adapter install / uninstall
// ─────────────────────────────────────────────────────────────────────────

describe("claude-code adapter — nativeHooks install/uninstall", () => {
  it("installHooks writes native entries with VERBATIM event-name keys + home-bin command, and uninstallHooks removes them", async () => {
    const connector = await registerFixture();
    const projectDir = mkdtempSync(join(tmpdir(), "ac-native-proj-"));
    try {
      const ctx = buildCtx(connector, projectDir);

      const changes = claudeAdapter.installHooks(ctx);
      // A nativeHooks-only connector is NOT "declares no hooks".
      expect(changes.some((c) => c.detail === "connector declares no hooks")).toBe(false);
      expect(changes.filter((c) => c.action === "create")).toHaveLength(3);

      const settingsPath = join(projectDir, ".claude", "settings.json");
      const cfg = readJson(settingsPath);
      // Event-name keys verbatim; matcher from the def; same command shape.
      expect(cfg.hooks.TaskCreated[0].matcher).toBe("");
      expect(cfg.hooks.TaskCreated[0].hooks[0].command).toContain(
        "hook claude-code TaskCreated",
      );
      expect(cfg.hooks.TaskCreated[0].hooks[0].command).toContain(
        `--connector ${CONNECTOR_ID}`,
      );
      expect(cfg.hooks.StopFailure[0].matcher).toBe("rate_limit|overloaded");
      expect(cfg.hooks.TeammateIdle[0].hooks[0].command).toContain(
        "hook claude-code TeammateIdle",
      );

      // Idempotent: a second install only skips.
      const second = claudeAdapter.installHooks(ctx);
      expect(second.every((c) => c.action === "skip")).toBe(true);
      expect(cfg.hooks.TaskCreated).toHaveLength(1);

      // Uninstall strips every native entry (generic command-ownership match).
      claudeAdapter.uninstallHooks(ctx);
      const after = readJson(settingsPath);
      expect(JSON.stringify(after.hooks ?? {})).not.toContain(HOME_BIN);
      expect(after.hooks?.TaskCreated).toBeUndefined();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("health checks count native hooks as declared hooks", async () => {
    const connector = await registerFixture();
    const projectDir = mkdtempSync(join(tmpdir(), "ac-native-proj-"));
    try {
      const ctx = buildCtx(connector, projectDir);
      const before = claudeAdapter.getHealthChecks(ctx);
      // Without an install, the settings.json check must FAIL (hooks ARE declared).
      const settingsCheck = before.find((c) => c.name.includes("settings.json"));
      expect(settingsCheck!.check().status).toBe("FAIL");

      claudeAdapter.installHooks(ctx);
      const after = claudeAdapter.getHealthChecks(ctx);
      for (const hc of after) {
        expect(hc.check().status).toBe("OK");
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Runtime passthrough (runNativeHook)
// ─────────────────────────────────────────────────────────────────────────

describe("runNativeHook — verbatim passthrough dispatch", () => {
  it("hands the handler the RAW payload and serializes its return VERBATIM to stdout (exit 0)", async () => {
    await registerFixture();
    const payload = {
      hook_event_name: "TaskCreated",
      session_id: "sess-native-1",
      cwd: "/home/dev/acme",
      task_id: "T-42",
      task_subject: "ship the passthrough",
      teammate_name: "rivka",
    };

    const res = await runNativeHook({
      platformId: "claude-code",
      event: "TaskCreated",
      connectorId: CONNECTOR_ID,
      stdin: JSON.stringify(payload),
    });

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBeUndefined();
    const out = JSON.parse(res.stdout!);
    // The handler's return IS the reply — no HookResponse mapping in between.
    expect(out.continue).toBe(false);
    expect(out.stopReason).toBe("task vetoed by native hook");
    // NativeHookEvent envelope: event name, session, projectDir, raw untouched.
    expect(out.event).toBe("TaskCreated");
    expect(out.sessionId).toBe("sess-native-1");
    expect(out.projectDir).toBe("/home/dev/acme");
    expect(out.echo).toEqual(payload);
  });

  it("void return → exit 0 with NO output", async () => {
    await registerFixture();
    const res = await runNativeHook({
      platformId: "claude-code",
      event: "TeammateIdle",
      connectorId: CONNECTOR_ID,
      stdin: JSON.stringify({ teammate_name: "rivka", team_name: "core" }),
    });
    expect(res).toEqual({ exitCode: 0 });
  });

  it("a throwing handler fails OPEN (exit 0, no output)", async () => {
    await registerFixture();
    const res = await runNativeHook({
      platformId: "claude-code",
      event: "StopFailure",
      connectorId: CONNECTOR_ID,
      stdin: JSON.stringify({ error: "rate_limit" }),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBeUndefined();
  });

  it("an event the connector does not declare for the platform allows silently", async () => {
    await registerFixture();
    const res = await runNativeHook({
      platformId: "claude-code",
      event: "WorktreeCreate",
      connectorId: CONNECTOR_ID,
      stdin: "{}",
    });
    expect(res).toEqual({ exitCode: 0 });
    // And the declaration is platform-scoped: same event on another platform
    // reads as undeclared.
    expect(await isNativeHookDeclared("claude-code", "TaskCreated", CONNECTOR_ID)).toBe(true);
    expect(await isNativeHookDeclared("codex", "TaskCreated", CONNECTOR_ID)).toBe(false);
    expect(await isNativeHookDeclared("claude-code", "WorktreeCreate", CONNECTOR_ID)).toBe(false);
  });

  it("records a scope:hook telemetry row named by the NATIVE event", async () => {
    await registerFixture();
    await runNativeHook({
      platformId: "claude-code",
      event: "TaskCreated",
      connectorId: CONNECTOR_ID,
      stdin: JSON.stringify({ session_id: "sess-t", task_id: "T-1" }),
    });
    const store = openStore({});
    try {
      const rows = store.query({}).filter((r) => r.scope === "hook");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.toolName).toBe("TaskCreated");
      expect(rows[0]!.surfaceKind).toBe("hook");
      expect(rows[0]!.hostPlatform).toBe("claude-code");
      expect(rows[0]!.connectorId).toBe(CONNECTOR_ID);
    } finally {
      store.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Hook CLI gate
// ─────────────────────────────────────────────────────────────────────────

describe("hook CLI — non-union event names", () => {
  it("keeps the strict unknown-event error for an UNDECLARED native event", async () => {
    await registerFixture();
    // Declared events would proceed to read stdin (and exit the process), so we
    // assert only the rejection paths here: undeclared event on a registered
    // connector, and any event on an unregistered connector.
    const code = await runHookCli([
      "claude-code",
      "BogusEvent",
      "--connector",
      CONNECTOR_ID,
    ]);
    expect(code).toBe(2);

    const codeUnregistered = await runHookCli([
      "claude-code",
      "TaskCreated",
      "--connector",
      "not-registered",
    ]);
    expect(codeUnregistered).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Installer skip-warn for unsupported hosts
// ─────────────────────────────────────────────────────────────────────────

describe("installer — nativeHooks on a host without supportsNativeHooks", () => {
  it("reports the standard skip-warn ChangeRecord (never silent)", async () => {
    const connector = defineConnector({
      id: "warp-native",
      platforms: {
        warp: {
          nativeHooks: { SomethingNative: { handler: () => {} } },
        },
      },
    });
    const result = await installConnector({
      connector,
      modulePath: join(tmpData, "fake.mjs"),
      scope: "user",
      projectDir: tmpHome,
      targets: ["warp"],
      dryRun: true,
    });
    const warn = result.changes.find(
      (c) => c.action === "warn" && c.detail.includes("nativeHooks not supported on warp"),
    );
    expect(warn).toBeDefined();
    expect(warn!.detail).toContain("1 skipped");
  });

  it("does NOT warn on claude-code (supportsNativeHooks: true)", async () => {
    const connector = defineConnector({
      id: "claude-native",
      platforms: {
        "claude-code": {
          nativeHooks: { TaskCreated: { handler: () => {} } },
        },
      },
    });
    const result = await installConnector({
      connector,
      modulePath: join(tmpData, "fake.mjs"),
      scope: "user",
      projectDir: tmpHome,
      targets: ["claude-code"],
      dryRun: true,
    });
    expect(
      result.changes.some((c) => c.detail.includes("nativeHooks not supported")),
    ).toBe(false);
    // The dry-run still RENDERS the native hook entries it would create.
    expect(
      result.changes.some(
        (c) => c.action === "create" && c.detail === "hooks.TaskCreated",
      ),
    ).toBe(true);
  });
});
