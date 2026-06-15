/**
 * tests/core/actions — the action (user-invokable) surface, config + install side.
 *
 * Covers the dispatch-backbone surface (issue #3 v1):
 *   • defineConnector validation — valid actions resolve as live handlers; the id
 *     is kebab-case + unique (dup → ConnectorConfigError); run MUST be a function;
 *     description (when present) a string; an actions-only connector is legal; the
 *     per-host hosts: map validates registered ids + function runs; defineAction
 *     is an identity helper.
 *   • spawn helpers — buildHomeBinActionCommand / isHomeBinActionCommand (the
 *     ` action ` verb + shared-prefix-id anchoring).
 *   • install — EVERY adapter honestly skip-warns when actions are declared
 *     (v1 ships no affordance emitter), and skips silently when none are declared.
 *   • CLI — the `action` command is registered (and its --help never crashes).
 *
 * Isolation: HOME + AGENT_CONNECTOR_DATA_DIR point at fresh temp dirs and are
 * restored in afterEach (the statusline test pattern).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConnectorConfigError,
  defineAction,
  defineConnector,
} from "../../src/core/define-connector.js";
import {
  buildHomeBinActionCommand,
  isHomeBinActionCommand,
  isHomeBinStatuslineCommand,
  isUsageEventCommand,
} from "../../src/core/spawn.js";
import claudeAdapter from "../../src/adapters/claude-code/index.js";
import codexAdapter from "../../src/adapters/codex/index.js";
import warpAdapter from "../../src/adapters/warp/index.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ActionDef, ResolvedConnector } from "../../src/core/types.js";
import { main } from "../../src/cli/app.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
};

let tmpHome: string;
let tmpData: string;
let tmpProject: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-act-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-act-data-"));
  tmpProject = mkdtempSync(join(tmpdir(), "ac-act-proj-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of [tmpHome, tmpData, tmpProject]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** A connector whose only payload is one or more actions. */
function actionsConnector(id: string, actions: ActionDef[]): ResolvedConnector {
  return defineConnector({ id, actions });
}

function buildCtx(
  connector: ResolvedConnector,
  overrides: Partial<InstallContext> = {},
): InstallContext {
  return {
    connector,
    scope: "project",
    projectDir: tmpProject,
    homeBinPath: HOME_BIN,
    dataRoot: tmpData,
    dryRun: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// defineConnector validation
// ─────────────────────────────────────────────────────────────────────────

describe("defineConnector — action validation", () => {
  it("resolves a connector with valid actions (survive as live handlers)", () => {
    const resolved = actionsConnector("act-ok", [
      { id: "do-thing", run: () => ({ message: "did the thing" }) },
      { id: "other-thing", description: "d", run: () => undefined },
    ]);
    expect(resolved.actions).toHaveLength(2);
    expect(resolved.actions[0]!.id).toBe("do-thing");
    expect(typeof resolved.actions[0]!.run).toBe("function");
    // The live handler is callable and returns its result.
    expect(
      resolved.actions[0]!.run({
        host: "claude-code",
        capabilities: claudeAdapter.capabilities,
      }),
    ).toEqual({ message: "did the thing" });
  });

  it("is an ARRAY surface ([] when none, like commands/skills)", () => {
    const resolved = defineConnector({
      id: "act-none",
      server: { transport: "stdio", command: "node" },
    });
    expect(Array.isArray(resolved.actions)).toBe(true);
    expect(resolved.actions).toHaveLength(0);
  });

  it("an actions-only connector is a legal sole payload", () => {
    expect(() =>
      actionsConnector("act-sole", [{ id: "go", run: () => undefined }]),
    ).not.toThrow();
  });

  it("throws on a duplicate action id", () => {
    expect(() =>
      defineConnector({
        id: "act-dup",
        actions: [
          { id: "go", run: () => undefined },
          { id: "go", run: () => undefined },
        ],
      }),
    ).toThrow(ConnectorConfigError);
    expect(() =>
      defineConnector({
        id: "act-dup2",
        actions: [
          { id: "go", run: () => undefined },
          { id: "go", run: () => undefined },
        ],
      }),
    ).toThrow(/duplicate id "go"/);
  });

  it("throws when run is not a function", () => {
    expect(() =>
      defineConnector({
        id: "act-no-run",
        actions: [{ id: "go", run: "nope" as never }],
      }),
    ).toThrow(/actions\[0\]\.run must be a function/);
  });

  it("throws on a non-kebab-case id (message names the `id` field, not `name`)", () => {
    expect(() =>
      defineConnector({
        id: "act-bad-id",
        actions: [{ id: "Bad Id", run: () => undefined }],
      }),
    ).toThrow(/actions\[0\]\.id must be kebab-case/);
  });

  it("throws on a non-string description", () => {
    expect(() =>
      defineConnector({
        id: "act-bad-desc",
        actions: [{ id: "go", description: 42 as never, run: () => undefined }],
      }),
    ).toThrow(/description must be a string/);
  });

  it("throws when actions is not an array", () => {
    // A second payload (server) lets the empty-connector guard pass so the
    // normalizeActions array-shape check is the branch that fires.
    expect(() =>
      defineConnector({
        id: "act-not-arr",
        server: { transport: "stdio", command: "node" },
        actions: {} as never,
      }),
    ).toThrow(/actions must be an array/);
  });

  it("defineAction is a typed identity helper", () => {
    const def = defineAction({ id: "go", run: (ctx) => ({ message: `${ctx.host}` }) });
    expect(typeof def.run).toBe("function");
    expect(def.id).toBe("go");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Per-host `hosts:` override map — author-time validation
// ─────────────────────────────────────────────────────────────────────────

describe("defineConnector — action hosts: map validation", () => {
  it("resolves an action with a valid hosts: map (registered ids, function runs)", () => {
    const resolved = defineConnector({
      id: "act-hosts-ok",
      actions: [
        {
          id: "go",
          run: () => ({ message: "top" }),
          hosts: {
            codex: { run: () => ({ message: "codex" }) },
            "claude-code": { run: () => ({ message: "cc" }) },
          },
        },
      ],
    });
    expect(typeof resolved.actions[0]!.hosts?.["codex"]?.run).toBe("function");
    expect(typeof resolved.actions[0]!.hosts?.["claude-code"]?.run).toBe("function");
  });

  it("rejects an UNKNOWN host id in an action hosts: map (message names the bad id + surface)", () => {
    let thrown: unknown;
    try {
      defineConnector({
        id: "act-hosts-bad-id",
        actions: [
          {
            id: "go",
            run: () => undefined,
            hosts: { "not-a-host": { run: () => undefined } } as never,
          },
        ],
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConnectorConfigError);
    expect((thrown as Error).message).toContain("not-a-host");
    expect((thrown as Error).message).toContain("actions.go.hosts");
  });

  it("rejects a non-function per-host run in an action hosts: map", () => {
    expect(() =>
      defineConnector({
        id: "act-hosts-bad-run",
        actions: [
          {
            id: "go",
            run: () => undefined,
            hosts: { codex: { run: "nope" as never } },
          },
        ],
      }),
    ).toThrow(/actions\.go\.hosts\.codex\.run must be a function/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// spawn helpers
// ─────────────────────────────────────────────────────────────────────────

describe("spawn — action command helpers", () => {
  it("builds the home-bin action command", () => {
    const cmd = buildHomeBinActionCommand(HOME_BIN, "claude-code", "do-thing", "acme");
    expect(cmd).toBe(`"${HOME_BIN}" action claude-code do-thing --connector acme`);
  });

  it("matches our action command and anchors against shared-prefix ids", () => {
    const cmd = buildHomeBinActionCommand(HOME_BIN, "claude-code", "go", "acme");
    expect(isHomeBinActionCommand(cmd, HOME_BIN, "acme")).toBe(true);
    // shared-prefix id "acme" must NOT match a command for "acme-db".
    const dbCmd = buildHomeBinActionCommand(HOME_BIN, "claude-code", "go", "acme-db");
    expect(isHomeBinActionCommand(dbCmd, HOME_BIN, "acme")).toBe(false);
    expect(isHomeBinActionCommand(dbCmd, HOME_BIN, "acme-db")).toBe(true);
  });

  it("does not match a hook / usage-event / statusline command (requires the action verb)", () => {
    const hookCmd = `"${HOME_BIN}" hook claude-code SessionStart --connector acme`;
    const usageCmd = `"${HOME_BIN}" usage-event claude-code --connector acme`;
    const slCmd = `"${HOME_BIN}" statusline claude-code --connector acme`;
    expect(isHomeBinActionCommand(hookCmd, HOME_BIN, "acme")).toBe(false);
    expect(isHomeBinActionCommand(usageCmd, HOME_BIN, "acme")).toBe(false);
    expect(isHomeBinActionCommand(slCmd, HOME_BIN, "acme")).toBe(false);
  });

  it("a free-form actionId equal to another verb name does NOT collide (verb-SLOT anchoring)", () => {
    // actionId "statusline" / "usage-event" are legal kebab tokens. The verb
    // detectors must anchor on the SLOT (right after the home bin), not match the
    // verb name anywhere in the args — else uninstall scans misattribute ownership.
    const slId = buildHomeBinActionCommand(HOME_BIN, "claude-code", "statusline", "acme");
    expect(isHomeBinActionCommand(slId, HOME_BIN, "acme")).toBe(true);
    expect(isHomeBinStatuslineCommand(slId, HOME_BIN, "acme")).toBe(false); // NOT a statusline cmd
    const ueId = buildHomeBinActionCommand(HOME_BIN, "claude-code", "usage-event", "acme");
    expect(isHomeBinActionCommand(ueId, HOME_BIN, "acme")).toBe(true);
    expect(isUsageEventCommand(ueId, HOME_BIN, "acme")).toBe(false); // NOT a usage-event cmd
    // and the reverse: a real statusline command is never seen as an action.
    const realSl = `"${HOME_BIN}" statusline claude-code --connector acme`;
    expect(isHomeBinStatuslineCommand(realSl, HOME_BIN, "acme")).toBe(true);
    expect(isHomeBinActionCommand(realSl, HOME_BIN, "acme")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// install = honest skip-warn on EVERY host (no affordance emitter in v1)
// ─────────────────────────────────────────────────────────────────────────

describe("install — actions skip-warn on every host (v1)", () => {
  it("NO adapter advertises supportsActions in v1", () => {
    expect(claudeAdapter.capabilities.supportsActions ?? false).toBe(false);
    expect(codexAdapter.capabilities.supportsActions ?? false).toBe(false);
    expect(warpAdapter.capabilities.supportsActions ?? false).toBe(false);
  });

  it("installActions skip-warns (never silent) when actions are declared — every adapter", () => {
    const connector = actionsConnector("act-warn", [
      { id: "a", run: () => undefined },
      { id: "b", run: () => undefined },
    ]);
    for (const adapter of [claudeAdapter, codexAdapter, warpAdapter]) {
      const changes = adapter.installActions!(buildCtx(connector));
      expect(changes.some((c) => c.action === "warn")).toBe(true);
      expect(changes.some((c) => c.detail.includes("actions not supported"))).toBe(true);
      expect(changes.some((c) => c.detail.includes("2 skipped"))).toBe(true);
    }
  });

  it("installActions skips silently when no actions are declared", () => {
    const connector = defineConnector({
      id: "act-none-decl",
      commands: [{ name: "noop", prompt: "p" }],
    });
    for (const adapter of [claudeAdapter, codexAdapter, warpAdapter]) {
      const changes = adapter.installActions!(buildCtx(connector));
      expect(changes).toHaveLength(1);
      expect(changes[0]!.action).toBe("skip");
      expect(changes[0]!.detail).toContain("declares no actions");
    }
  });

  it("uninstallActions mirrors install (skip-warn / skip), never silent on a declared surface", () => {
    const connector = actionsConnector("act-uninstall", [{ id: "a", run: () => undefined }]);
    const changes = claudeAdapter.uninstallActions!(buildCtx(connector));
    expect(changes.some((c) => c.action === "warn")).toBe(true);
    expect(changes.some((c) => c.detail.includes("1 skipped"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CLI registration
// ─────────────────────────────────────────────────────────────────────────

describe("CLI — action command is registered", () => {
  it("`action --help` prints a usage line and exits 0", async () => {
    let out = "";
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      });
    const code = await main(["action", "--help"]);
    spy.mockRestore();
    expect(code).toBe(0);
    expect(out).toContain("usage: agent-connector action");
  });
});
