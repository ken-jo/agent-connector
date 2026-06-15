/**
 * tests/core/statusline — the statusline (HUD) surface.
 *
 * Covers the whole feature spine (issue #2):
 *   • defineConnector validation — render MUST be a function; name (when present)
 *     kebab-case; description (when present) a string; a statusline-only connector
 *     is a legal sole payload; statusline survives resolution as a live handler.
 *   • spawn helpers — buildHomeBinStatuslineCommand / isHomeBinStatuslineCommand
 *     (the ` statusline ` verb + shared-prefix-id anchoring).
 *   • claude-code adapter — capabilities.supportsStatusline === true;
 *     installStatusline writes the ownership-tracked settings.json.statusLine
 *     (ledger row, prior absent) via the SAME ledger as configPatch; idempotent
 *     re-install; uninstall reverses (last-owner-verified); a pre-existing non-AC
 *     statusLine is NEVER clobbered (skip-warn); per-platform false skips;
 *     parseStatusInput maps Claude's stdin JSON; formatStatusOutput → exit 0.
 *   • a non-supporting adapter (codex) → installStatusline skip-warns (never silent).
 *   • CLI — the `statusline` command is registered (and its --help never crashes).
 *
 * Isolation: HOME + AGENT_CONNECTOR_DATA_DIR point at fresh temp dirs and are
 * restored in afterEach (the config-patch test pattern).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConnectorConfigError,
  defineConnector,
  defineStatusline,
} from "../../src/core/define-connector.js";
import {
  buildHomeBinStatuslineCommand,
  isHomeBinStatuslineCommand,
} from "../../src/core/spawn.js";
import { loadConfigPatchLedger } from "../../src/core/config-patch-ledger.js";
import claudeAdapter from "../../src/adapters/claude-code/index.js";
import codexAdapter from "../../src/adapters/codex/index.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector, StatuslineDef } from "../../src/core/types.js";
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
  tmpHome = mkdtempSync(join(tmpdir(), "ac-sl-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-sl-data-"));
  tmpProject = mkdtempSync(join(tmpdir(), "ac-sl-proj-"));
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

/** A connector whose only payload is a status line. */
function statuslineConnector(id: string, def: StatuslineDef): ResolvedConnector {
  return defineConnector({ id, statusline: def });
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

function settingsPath(): string {
  return join(tmpProject, ".claude", "settings.json");
}

function readSettings(): Record<string, any> {
  return JSON.parse(readFileSync(settingsPath(), "utf8"));
}

function writeSettings(data: unknown): void {
  mkdirSync(join(tmpProject, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

// ─────────────────────────────────────────────────────────────────────────
// defineConnector validation
// ─────────────────────────────────────────────────────────────────────────

describe("defineConnector — statusline validation", () => {
  it("resolves a connector with a valid statusline.render (survives as a live handler)", () => {
    const render = (ctx: { cwd?: string }) => `cwd=${ctx.cwd}`;
    const resolved = statuslineConnector("sl-ok", { render });
    expect(typeof resolved.statusline?.render).toBe("function");
    // name defaults to "statusline".
    expect(resolved.statusline?.name).toBe("statusline");
    // The live handler is callable and returns the rendered string.
    expect(
      resolved.statusline?.render({
        host: "claude-code",
        capabilities: claudeAdapter.capabilities,
        cwd: "/x",
        raw: {},
      }),
    ).toBe("cwd=/x");
  });

  it("is SINGULAR (one statusline object, not an array)", () => {
    const resolved = statuslineConnector("sl-singular", { render: () => "x" });
    expect(Array.isArray(resolved.statusline)).toBe(false);
    expect(resolved.statusline).not.toBeUndefined();
  });

  it("a statusline-only connector is a legal sole payload", () => {
    expect(() => statuslineConnector("sl-sole", { render: () => "hud" })).not.toThrow();
  });

  it("throws when render is not a function", () => {
    expect(() =>
      defineConnector({ id: "sl-no-render", statusline: { render: "nope" as never } }),
    ).toThrow(ConnectorConfigError);
    expect(() =>
      defineConnector({ id: "sl-no-render2", statusline: {} as never }),
    ).toThrow(/render must be a function/);
  });

  it("throws on a non-kebab-case name", () => {
    expect(() =>
      defineConnector({
        id: "sl-bad-name",
        statusline: { name: "Bad Name", render: () => "x" },
      }),
    ).toThrow(ConnectorConfigError);
  });

  it("throws on a non-string description", () => {
    expect(() =>
      defineConnector({
        id: "sl-bad-desc",
        statusline: { description: 42 as never, render: () => "x" },
      }),
    ).toThrow(/description must be a string/);
  });

  it("throws when statusline is not an object", () => {
    expect(() =>
      defineConnector({ id: "sl-not-obj", statusline: [] as never }),
    ).toThrow(/must be an object/);
  });

  it("defineStatusline is a typed identity helper", () => {
    const def = defineStatusline({ render: (ctx) => `${ctx.host}` });
    expect(typeof def.render).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Per-host `hosts:` override map — author-time validation (BOTH surfaces)
// ─────────────────────────────────────────────────────────────────────────

describe("defineConnector — per-host hosts: map validation", () => {
  it("resolves a statusline with a valid hosts: map (registered ids, function renders)", () => {
    const resolved = defineConnector({
      id: "sl-hosts-ok",
      statusline: {
        render: () => "top",
        hosts: {
          codex: { render: () => "codex-line" },
          "claude-code": { render: () => "cc-line" },
        },
      },
    });
    expect(typeof resolved.statusline?.hosts?.["codex"]?.render).toBe("function");
    expect(typeof resolved.statusline?.hosts?.["claude-code"]?.render).toBe("function");
  });

  it("rejects an UNKNOWN host id in a statusline hosts: map (message names the bad id)", () => {
    let thrown: unknown;
    try {
      defineConnector({
        id: "sl-hosts-bad-id",
        statusline: {
          render: () => "top",
          hosts: { "not-a-host": { render: () => "x" } } as never,
        },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConnectorConfigError);
    expect((thrown as Error).message).toContain("not-a-host");
    expect((thrown as Error).message).toContain("statusline.hosts");
  });

  it("rejects a non-function per-host render in a statusline hosts: map", () => {
    expect(() =>
      defineConnector({
        id: "sl-hosts-bad-render",
        statusline: {
          render: () => "top",
          hosts: { codex: { render: "nope" as never } },
        },
      }),
    ).toThrow(/statusline\.hosts\.codex\.render must be a function/);
  });

  it("resolves a hook with a valid hosts: map (registered ids, function handlers)", () => {
    const resolved = defineConnector({
      id: "hk-hosts-ok",
      hooks: {
        PreToolUse: {
          handler: () => ({ decision: "allow" }),
          hosts: {
            codex: { handler: () => ({ decision: "deny", reason: "no" }) },
            "claude-code": { handler: () => ({ decision: "deny", reason: "no" }) },
          },
        },
      },
    });
    expect(typeof resolved.hooks.PreToolUse?.hosts?.["codex"]?.handler).toBe("function");
  });

  it("rejects an UNKNOWN host id in a hook hosts: map (message names the bad id + surface)", () => {
    let thrown: unknown;
    try {
      defineConnector({
        id: "hk-hosts-bad-id",
        hooks: {
          PreToolUse: {
            handler: () => undefined,
            hosts: { "not-a-host": { handler: () => undefined } } as never,
          },
        },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConnectorConfigError);
    expect((thrown as Error).message).toContain("not-a-host");
    expect((thrown as Error).message).toContain("hooks.PreToolUse.hosts");
  });

  it("rejects a non-function per-host handler in a hook hosts: map", () => {
    expect(() =>
      defineConnector({
        id: "hk-hosts-bad-handler",
        hooks: {
          PreToolUse: {
            handler: () => undefined,
            hosts: { codex: { handler: "nope" as never } },
          },
        },
      }),
    ).toThrow(/hooks\.PreToolUse\.hosts\.codex\.handler must be a function/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// spawn helpers
// ─────────────────────────────────────────────────────────────────────────

describe("spawn — statusline command helpers", () => {
  it("builds the home-bin statusline command", () => {
    const cmd = buildHomeBinStatuslineCommand(HOME_BIN, "claude-code", "acme");
    expect(cmd).toBe(`"${HOME_BIN}" statusline claude-code --connector acme`);
  });

  it("matches our statusline command and anchors against shared-prefix ids", () => {
    const cmd = buildHomeBinStatuslineCommand(HOME_BIN, "claude-code", "acme");
    expect(isHomeBinStatuslineCommand(cmd, HOME_BIN, "acme")).toBe(true);
    // shared-prefix id "acme" must NOT match a command for "acme-db".
    const dbCmd = buildHomeBinStatuslineCommand(HOME_BIN, "claude-code", "acme-db");
    expect(isHomeBinStatuslineCommand(dbCmd, HOME_BIN, "acme")).toBe(false);
    expect(isHomeBinStatuslineCommand(dbCmd, HOME_BIN, "acme-db")).toBe(true);
  });

  it("does not match a plain hook / usage-event command (requires the statusline verb)", () => {
    const hookCmd = `"${HOME_BIN}" hook claude-code SessionStart --connector acme`;
    const usageCmd = `"${HOME_BIN}" usage-event claude-code --connector acme`;
    expect(isHomeBinStatuslineCommand(hookCmd, HOME_BIN, "acme")).toBe(false);
    expect(isHomeBinStatuslineCommand(usageCmd, HOME_BIN, "acme")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// claude-code adapter
// ─────────────────────────────────────────────────────────────────────────

describe("claude-code adapter — statusline", () => {
  it("advertises supportsStatusline === true", () => {
    expect(claudeAdapter.capabilities.supportsStatusline).toBe(true);
  });

  it("installs the ownership-tracked statusLine (ledger row, prior absent)", () => {
    const connector = statuslineConnector("sl-install", { render: () => "x" });
    const changes = claudeAdapter.installStatusline!(buildCtx(connector));
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const settings = readSettings();
    expect(settings.statusLine).toEqual({
      type: "command",
      command: buildHomeBinStatuslineCommand(HOME_BIN, "claude-code", "sl-install"),
    });

    // The ledger has a refcounted ownership row for the statusLine key.
    const ledger = loadConfigPatchLedger(tmpData);
    const entry = ledger.entries.find(
      (e) => e.platform === "claude-code" && e.key === "statusLine",
    );
    expect(entry).toBeTruthy();
    expect(entry!.prior).toEqual({ present: false });
    expect(entry!.owners.map((o) => o.connectorId)).toContain("sl-install");
  });

  it("is idempotent on re-install (skip, no duplicate)", () => {
    const connector = statuslineConnector("sl-idem", { render: () => "x" });
    claudeAdapter.installStatusline!(buildCtx(connector));
    const second = claudeAdapter.installStatusline!(buildCtx(connector));
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall reverses (removes the key + drops the ledger row)", () => {
    const connector = statuslineConnector("sl-uninstall", { render: () => "x" });
    claudeAdapter.installStatusline!(buildCtx(connector));
    expect(readSettings().statusLine).toBeTruthy();

    const changes = claudeAdapter.uninstallStatusline!(buildCtx(connector));
    expect(changes.some((c) => c.action === "remove")).toBe(true);
    expect(readSettings().statusLine).toBeUndefined();

    const ledger = loadConfigPatchLedger(tmpData);
    expect(
      ledger.entries.find((e) => e.key === "statusLine"),
    ).toBeUndefined();
  });

  it("NEVER clobbers a pre-existing non-AC statusLine (skip-warn)", () => {
    writeSettings({ statusLine: { type: "command", command: "my-own-statusline.sh" } });
    const connector = statuslineConnector("sl-conflict", { render: () => "x" });
    const changes = claudeAdapter.installStatusline!(buildCtx(connector));

    expect(changes.some((c) => c.action === "warn")).toBe(true);
    // The user's statusLine is untouched.
    expect(readSettings().statusLine).toEqual({
      type: "command",
      command: "my-own-statusline.sh",
    });
    // No ownership was taken on a key we did not create.
    const ledger = loadConfigPatchLedger(tmpData);
    expect(ledger.entries.find((e) => e.key === "statusLine")).toBeUndefined();
  });

  it("uninstall never deletes a non-AC statusLine (no ownership recorded → skip)", () => {
    writeSettings({ statusLine: { type: "command", command: "my-own-statusline.sh" } });
    const connector = statuslineConnector("sl-conflict2", { render: () => "x" });
    claudeAdapter.installStatusline!(buildCtx(connector)); // skip-warn (not ours)
    const changes = claudeAdapter.uninstallStatusline!(buildCtx(connector));
    expect(changes.every((c) => c.action === "skip")).toBe(true);
    expect(readSettings().statusLine).toEqual({
      type: "command",
      command: "my-own-statusline.sh",
    });
  });

  it("per-platform statusline:false skips the install entirely", () => {
    const connector = defineConnector({
      id: "sl-disabled",
      statusline: { render: () => "x" },
      platforms: { "claude-code": { statusline: false } },
    });
    const changes = claudeAdapter.installStatusline!(buildCtx(connector));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("parseStatusInput maps Claude's statusLine stdin JSON", () => {
    const raw = {
      session_id: "sess-1",
      transcript_path: "/t/x.jsonl",
      cwd: "/home/dev/acme",
      version: "2.1.0",
      model: { id: "claude-opus", display_name: "Opus" },
      cost: { total_cost_usd: 0.42 },
    };
    const ctx = claudeAdapter.parseStatusInput!(raw);
    expect(ctx.host).toBe("claude-code");
    expect(ctx.sessionId).toBe("sess-1");
    expect(ctx.cwd).toBe("/home/dev/acme");
    expect(ctx.model).toEqual({ id: "claude-opus", displayName: "Opus" });
    expect(ctx.cost).toEqual({ totalUsd: 0.42 });
    expect(ctx.transcriptPath).toBe("/t/x.jsonl");
    expect(ctx.raw).toBe(raw); // verbatim escape hatch (version etc.)
  });

  it("parseStatusInput falls back to workspace.current_dir for cwd", () => {
    const ctx = claudeAdapter.parseStatusInput!({
      workspace: { current_dir: "/ws/dir" },
    });
    expect(ctx.cwd).toBe("/ws/dir");
  });

  it("formatStatusOutput returns exit 0 + the rendered line on stdout", () => {
    expect(claudeAdapter.formatStatusOutput!("Opus /home/dev")).toEqual({
      exitCode: 0,
      stdout: "Opus /home/dev",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// non-supporting adapter (codex)
// ─────────────────────────────────────────────────────────────────────────

describe("non-supporting adapter (codex) — statusline", () => {
  it("does not advertise supportsStatusline", () => {
    expect(codexAdapter.capabilities.supportsStatusline ?? false).toBe(false);
  });

  it("installStatusline skip-warns (never silent) when a statusline is declared", () => {
    const connector = statuslineConnector("sl-codex", { render: () => "x" });
    const changes = codexAdapter.installStatusline!(buildCtx(connector));
    expect(changes.some((c) => c.action === "warn")).toBe(true);
    expect(changes.some((c) => c.detail.includes("statusline"))).toBe(true);
  });

  it("installStatusline skips silently when no statusline is declared", () => {
    const connector = defineConnector({
      id: "sl-codex-none",
      commands: [{ name: "noop", prompt: "p" }],
    });
    const changes = codexAdapter.installStatusline!(buildCtx(connector));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CLI registration
// ─────────────────────────────────────────────────────────────────────────

describe("CLI — statusline command is registered", () => {
  it("`statusline --help` prints a usage line and exits 0", async () => {
    let out = "";
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      });
    const code = await main(["statusline", "--help"]);
    spy.mockRestore();
    expect(code).toBe(0);
    expect(out).toContain("usage: agent-connector statusline");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// statusLine is a RESERVED configPatch key (the statusline surface models it)
// ─────────────────────────────────────────────────────────────────────────

describe("statusLine reserved against raw configPatch", () => {
  it("rejects a configPatch keyed statusLine and points at the statusline surface", () => {
    let thrown: unknown;
    try {
      defineConnector({
        id: "sl-reserved",
        platforms: {
          "claude-code": {
            configPatch: [
              { key: "statusLine", value: { type: "command", command: "x" }, reason: "r" },
            ],
          },
        },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConnectorConfigError);
    expect((thrown as Error).message).toContain("statusline");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Coexistence: a connector with BOTH a real configPatch AND a statusline.
// They share settings.json but DISTINCT ledger keys, so install/uninstall in
// installer order (configPatch then statusline; reverse on uninstall) never
// double-processes a row and ends clean. (Adversarial review finding #1/#2.)
// ─────────────────────────────────────────────────────────────────────────

describe("claude-code — configPatch + statusline coexistence", () => {
  function bothConnector(id: string): ResolvedConnector {
    return defineConnector({
      id,
      statusline: { render: () => "x" },
      platforms: {
        "claude-code": {
          configPatch: [{ key: "cleanupPeriodDays", value: 30, reason: "keep N days" }],
        },
      },
    });
  }

  it("installs both keys with two distinct ledger rows", () => {
    const connector = bothConnector("sl-both-install");
    // installer order: configPatch first, statusline last.
    claudeAdapter.installConfigPatches(buildCtx(connector));
    claudeAdapter.installStatusline!(buildCtx(connector));

    const cfg = readSettings();
    expect(cfg.cleanupPeriodDays).toBe(30);
    expect(typeof cfg.statusLine.command).toBe("string");
    expect(isHomeBinStatuslineCommand(cfg.statusLine.command, HOME_BIN, "sl-both-install")).toBe(
      true,
    );

    const ledger = loadConfigPatchLedger(tmpData);
    const keys = ledger.entries.map((e) => e.key).sort();
    expect(keys).toEqual(["cleanupPeriodDays", "statusLine"]);
  });

  it("uninstall (statusline first, configPatch second) removes both and ends clean", () => {
    const connector = bothConnector("sl-both-uninstall");
    claudeAdapter.installConfigPatches(buildCtx(connector));
    claudeAdapter.installStatusline!(buildCtx(connector));

    // inverse order on uninstall.
    const slChanges = claudeAdapter.uninstallStatusline!(buildCtx(connector));
    const cpChanges = claudeAdapter.uninstallConfigPatches!(buildCtx(connector));

    // statusline uninstall removed the statusLine row; configPatch uninstall the
    // other — neither path touched the other's key (no double-processing).
    expect(slChanges.some((c) => c.action === "remove" && /statusLine/.test(c.detail!))).toBe(
      true,
    );
    expect(slChanges.some((c) => /cleanupPeriodDays/.test(c.detail ?? ""))).toBe(false);
    expect(cpChanges.some((c) => c.action === "remove" && /cleanupPeriodDays/.test(c.detail!))).toBe(
      true,
    );
    // The configPatch uninstall must NOT emit a bogus statusLine diagnostic.
    expect(cpChanges.some((c) => /statusLine/.test(c.detail ?? ""))).toBe(false);

    const cfg = readSettings();
    expect(cfg.statusLine).toBeUndefined();
    expect(cfg.cleanupPeriodDays).toBeUndefined();
    expect(loadConfigPatchLedger(tmpData).entries).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// doctor reports the statusLine row EXACTLY once (review finding #4): the
// dedicated "statusline wired" health check, NOT also as a configPatch.
// ─────────────────────────────────────────────────────────────────────────

describe("claude-code — doctor reports statusLine once", () => {
  it("statusLine is reported once — the dedicated check, never as a configPatch", () => {
    const connector = statuslineConnector("sl-doctor", { render: () => "x" });
    claudeAdapter.installStatusline!(buildCtx(connector));

    // doctor() folds in getHealthChecks AND configPatchDiagnostics. The
    // statusLine must surface EXACTLY ONCE — via the dedicated "statusline
    // wired" check — and NEVER as a "configPatch statusLine" diagnostic.
    const diag = claudeAdapter.doctor(buildCtx(connector));
    const mentions = diag.filter((d) => /statusLine/i.test(d.check));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.check).toContain("statusline wired");
    expect(diag.some((d) => /configPatch statusLine/i.test(d.check))).toBe(false);

    // The dedicated health check passes (statusLine command is ours).
    const checks = claudeAdapter.getHealthChecks!(buildCtx(connector));
    const sl = checks.filter((c) => /statusline/i.test(c.name));
    expect(sl).toHaveLength(1);
    expect(sl[0]!.check().status).toBe("OK");
  });

  it("fires for a REGISTERED connector (ledger row present, statusline not declared)", () => {
    // Install with a statusline connector → seeds the ownership ledger.
    claudeAdapter.installStatusline!(
      buildCtx(statuslineConnector("sl-reg", { render: () => "x" })),
    );
    // The REGISTERED-connector doctor path (connectorFromMeta) can't re-expose
    // the render fn, so statusline comes back undefined — but the ledger row
    // proves the surface was wired, so the check must still fire (and pass).
    const regConnector = defineConnector({
      id: "sl-reg",
      memory: [{ name: "m", content: "x" }],
    }); // SAME id, NO statusline
    const checks = claudeAdapter.getHealthChecks!(buildCtx(regConnector));
    const sl = checks.filter((c) => /statusline/i.test(c.name));
    expect(sl).toHaveLength(1);
    expect(sl[0]!.check().status).toBe("OK");
  });
});
