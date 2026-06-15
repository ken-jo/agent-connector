/**
 * adapters/qwen-code-statusline.test.ts — the statusline (HUD) surface on the
 * qwen-code adapter (the 2nd v1 statusline host after claude-code).
 *
 * Mirrors the claude-code statusline block in tests/core/statusline.test.ts,
 * adapted to qwen's NESTED config key (`ui.statusLine` in ~/.qwen/settings.json,
 * project scope → <projectDir>/.qwen/settings.json) and its stdin payload shape.
 *
 *   • capabilities.supportsStatusline === true;
 *   • installStatusline writes the ownership-tracked ui.statusLine (ledger row,
 *     prior absent) via the SAME refcounted ledger as configPatch;
 *   • idempotent re-install (skip, no duplicate);
 *   • a pre-existing non-AC ui.statusLine is NEVER clobbered (skip-warn, no
 *     ownership taken);
 *   • uninstall reverses (last-owner-verified delete + drops the ledger row);
 *   • per-platform statusline:false skips the install entirely;
 *   • parseStatusInput maps Qwen's documented stdin JSON (display_name,
 *     context_window.*, session_id, workspace.current_dir; cost undefined);
 *   • formatStatusOutput → exit 0 + stdout.
 *
 * Isolation: HOME + AGENT_CONNECTOR_DATA_DIR point at fresh temp dirs and are
 * restored in afterEach (the config-patch / claude-code statusline test pattern).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

import { defineConnector } from "../../src/core/define-connector.js";
import { buildHomeBinStatuslineCommand } from "../../src/core/spawn.js";
import { loadConfigPatchLedger } from "../../src/core/config-patch-ledger.js";
import qwenAdapter from "../../src/adapters/qwen-code/index.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector, StatuslineDef } from "../../src/core/types.js";

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
  tmpHome = mkdtempSync(join(tmpdir(), "ac-qsl-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-qsl-data-"));
  tmpProject = mkdtempSync(join(tmpdir(), "ac-qsl-proj-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
});

afterEach(() => {
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

/** Project-scope Qwen settings.json: <projectDir>/.qwen/settings.json. */
function settingsPath(): string {
  return join(tmpProject, ".qwen", "settings.json");
}

function readSettings(): Record<string, any> {
  return JSON.parse(readFileSync(settingsPath(), "utf8"));
}

function writeSettings(data: unknown): void {
  mkdirSync(join(tmpProject, ".qwen"), { recursive: true });
  writeFileSync(settingsPath(), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

// ─────────────────────────────────────────────────────────────────────────
// capabilities + install / uninstall (ownership ledger, nested ui.statusLine)
// ─────────────────────────────────────────────────────────────────────────

describe("qwen-code adapter — statusline", () => {
  it("advertises supportsStatusline === true", () => {
    expect(qwenAdapter.capabilities.supportsStatusline).toBe(true);
  });

  it("installs the ownership-tracked ui.statusLine.command (ledger row, prior absent)", () => {
    const connector = statuslineConnector("sl-install", { render: () => "x" });
    const changes = qwenAdapter.installStatusline!(buildCtx(connector));
    expect(changes.some((c) => c.action === "create")).toBe(true);

    // Nested under `ui` with type:"command" and OUR home-bin command.
    const settings = readSettings();
    expect(settings.ui.statusLine).toEqual({
      type: "command",
      command: buildHomeBinStatuslineCommand(HOME_BIN, "qwen-code", "sl-install"),
    });

    // The ledger has a refcounted ownership row keyed on the NESTED leaf path.
    const ledger = loadConfigPatchLedger(tmpData);
    const entry = ledger.entries.find(
      (e) => e.platform === "qwen-code" && e.key === "ui.statusLine",
    );
    expect(entry).toBeTruthy();
    expect(entry!.prior).toEqual({ present: false });
    expect(entry!.owners.map((o) => o.connectorId)).toContain("sl-install");
  });

  it("creates the `ui` intermediate when absent (set-if-absent on the leaf)", () => {
    // No settings file at all — install must create ui + the statusLine leaf.
    const connector = statuslineConnector("sl-mkdir", { render: () => "x" });
    qwenAdapter.installStatusline!(buildCtx(connector));
    const settings = readSettings();
    expect(typeof settings.ui).toBe("object");
    expect(settings.ui.statusLine.type).toBe("command");
  });

  it("preserves sibling user keys under `ui` and at top level", () => {
    writeSettings({ theme: "dark", ui: { hideTips: true } });
    const connector = statuslineConnector("sl-merge", { render: () => "x" });
    qwenAdapter.installStatusline!(buildCtx(connector));
    const settings = readSettings();
    expect(settings.theme).toBe("dark");
    expect(settings.ui.hideTips).toBe(true);
    expect(settings.ui.statusLine.type).toBe("command");
  });

  it("is idempotent on re-install (skip, no duplicate)", () => {
    const connector = statuslineConnector("sl-idem", { render: () => "x" });
    qwenAdapter.installStatusline!(buildCtx(connector));
    const second = qwenAdapter.installStatusline!(buildCtx(connector));
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall reverses (removes the key + drops the ledger row)", () => {
    const connector = statuslineConnector("sl-uninstall", { render: () => "x" });
    qwenAdapter.installStatusline!(buildCtx(connector));
    expect(readSettings().ui.statusLine).toBeTruthy();

    const changes = qwenAdapter.uninstallStatusline!(buildCtx(connector));
    expect(changes.some((c) => c.action === "remove")).toBe(true);
    expect(readSettings().ui.statusLine).toBeUndefined();

    const ledger = loadConfigPatchLedger(tmpData);
    expect(ledger.entries.find((e) => e.key === "ui.statusLine")).toBeUndefined();
  });

  it("NEVER clobbers a pre-existing non-AC ui.statusLine (skip-warn)", () => {
    writeSettings({ ui: { statusLine: { type: "command", command: "my-own.sh" } } });
    const connector = statuslineConnector("sl-conflict", { render: () => "x" });
    const changes = qwenAdapter.installStatusline!(buildCtx(connector));

    expect(changes.some((c) => c.action === "warn")).toBe(true);
    // The user's ui.statusLine is untouched.
    expect(readSettings().ui.statusLine).toEqual({
      type: "command",
      command: "my-own.sh",
    });
    // No ownership was taken on a key we did not create.
    const ledger = loadConfigPatchLedger(tmpData);
    expect(ledger.entries.find((e) => e.key === "ui.statusLine")).toBeUndefined();
  });

  it("uninstall never deletes a non-AC ui.statusLine (no ownership recorded → skip)", () => {
    writeSettings({ ui: { statusLine: { type: "command", command: "my-own.sh" } } });
    const connector = statuslineConnector("sl-conflict2", { render: () => "x" });
    qwenAdapter.installStatusline!(buildCtx(connector)); // skip-warn (not ours)
    const changes = qwenAdapter.uninstallStatusline!(buildCtx(connector));
    expect(changes.every((c) => c.action === "skip")).toBe(true);
    expect(readSettings().ui.statusLine).toEqual({
      type: "command",
      command: "my-own.sh",
    });
  });

  it("skip-warns when `ui` exists but is not an object (never replace it)", () => {
    writeSettings({ ui: "dark" });
    const connector = statuslineConnector("sl-blocked", { render: () => "x" });
    const changes = qwenAdapter.installStatusline!(buildCtx(connector));
    expect(changes.some((c) => c.action === "warn")).toBe(true);
    expect(readSettings().ui).toBe("dark");
  });

  it("per-platform statusline:false skips the install entirely", () => {
    const connector = defineConnector({
      id: "sl-disabled",
      statusline: { render: () => "x" },
      platforms: { "qwen-code": { statusline: false } },
    });
    const changes = qwenAdapter.installStatusline!(buildCtx(connector));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("skips silently when no statusline is declared", () => {
    const connector = defineConnector({
      id: "sl-none",
      commands: [{ name: "noop", prompt: "p" }],
    });
    const changes = qwenAdapter.installStatusline!(buildCtx(connector));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("no statusline");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// parse / format runtime pair
// ─────────────────────────────────────────────────────────────────────────

describe("qwen-code adapter — statusline parse/format", () => {
  it("parseStatusInput maps Qwen's documented statusLine stdin JSON", () => {
    const raw = {
      session_id: "sess-q",
      version: "0.14.3",
      model: { display_name: "Qwen3-Coder" },
      context_window: {
        context_window_size: 262144,
        used_percentage: 12.5,
        remaining_percentage: 87.5,
        current_usage: 32768,
        total_input_tokens: 30000,
        total_output_tokens: 2768,
      },
      workspace: { current_dir: "/home/dev/acme" },
      git: { branch: "main" },
    };
    const ctx = qwenAdapter.parseStatusInput!(raw);
    expect(ctx.host).toBe("qwen-code");
    expect(ctx.sessionId).toBe("sess-q");
    expect(ctx.cwd).toBe("/home/dev/acme");
    expect(ctx.model).toEqual({ displayName: "Qwen3-Coder" });
    expect(ctx.context).toEqual({
      maxTokens: 262144,
      usedTokens: 32768,
      percent: 12.5,
    });
    // Qwen has NO cost analog — cost must be undefined.
    expect(ctx.cost).toBeUndefined();
    // raw is the verbatim escape hatch (version/git/total_* etc.).
    expect(ctx.raw).toBe(raw);
  });

  it("parseStatusInput omits every field the payload does not carry (tolerant parser)", () => {
    const ctx = qwenAdapter.parseStatusInput!({});
    expect(ctx.host).toBe("qwen-code");
    expect(ctx.sessionId).toBeUndefined();
    expect(ctx.cwd).toBeUndefined();
    expect(ctx.model).toBeUndefined();
    expect(ctx.context).toBeUndefined();
    expect(ctx.cost).toBeUndefined();
  });

  it("parseStatusInput tolerates a partial context_window (only present fields mapped)", () => {
    const ctx = qwenAdapter.parseStatusInput!({
      context_window: { used_percentage: 40 },
    });
    expect(ctx.context).toEqual({ percent: 40 });
  });

  it("formatStatusOutput returns exit 0 + the rendered line on stdout", () => {
    expect(qwenAdapter.formatStatusOutput!("Qwen3-Coder /home/dev")).toEqual({
      exitCode: 0,
      stdout: "Qwen3-Coder /home/dev",
    });
  });
});
