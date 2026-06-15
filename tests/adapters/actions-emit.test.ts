/**
 * tests/adapters/actions-emit — the action-surface EMITTERS (droid/hermes/warp).
 *
 * Each emitter installs a user-invokable host trigger that runs the home-bin
 * action verb (`<homeBin> action <host> <id> --connector <id>`):
 *   • hermes → quick_commands.<id>: { type: "exec", command } in ~/.hermes/
 *     config.yaml (MERGE-preserve other quick_commands + user keys).
 *   • warp   → one OWNED YAML workflow per action at <cfg>/workflows/<id>.yaml
 *     ({ name, command, description }; palette pastes the command — not exec).
 *   • droid  → an OWNED executable file at <cfg>/commands/<id> (no .md ext):
 *     shebang + `exec <verb> "$@"`, mode 0o755. win32 → skip-warn (unverified).
 *
 * Asserts: exact trigger bytes, idempotency, reversible uninstall (hermes leaves
 * foreign quick_commands; warp/droid remove the owned file), per-platform
 * actions===false opt-out, empty-actions skip, and the stamped ChangeRecord
 * platform. HOME-isolated (mkdtemp) + deterministic.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { buildHomeBinActionCommand } from "../../src/core/spawn.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ActionDef, ResolvedConnector } from "../../src/core/types.js";

import droidAdapter from "../../src/adapters/droid/index.js";
import hermesAdapter from "../../src/adapters/hermes/index.js";
import warpAdapter from "../../src/adapters/warp/index.js";

const HOME_BIN = "/fake/home/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
};

let tmpHome: string;
let tmpProject: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-actemit-home-"));
  tmpProject = mkdtempSync(join(tmpdir(), "ac-actemit-proj-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(tmpHome, ".agent-connector");
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of [tmpHome, tmpProject]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function actionsConnector(
  actions: ActionDef[],
  platforms: ResolvedConnector["platforms"] = {},
): ResolvedConnector {
  return defineConnector({ id: CONNECTOR_ID, actions, platforms });
}

function buildCtx(
  connector: ResolvedConnector,
  scope: "project" | "user",
): InstallContext {
  return {
    connector,
    scope,
    projectDir: tmpProject,
    homeBinPath: HOME_BIN,
    dataRoot: join(tmpHome, ".agent-connector"),
    dryRun: false,
  };
}

const DEPLOY: ActionDef = {
  id: "deploy",
  description: "Deploy the app.",
  run: () => ({ message: "deployed" }),
};
const ROLLBACK: ActionDef = { id: "rollback", run: () => undefined };

function verb(host: string, id: string): string {
  return buildHomeBinActionCommand(HOME_BIN, host, id, CONNECTOR_ID);
}

// ─────────────────────────────────────────────────────────────────────────
// hermes — quick_commands.<id>: { type: "exec", command }, MERGE-preserve
// ─────────────────────────────────────────────────────────────────────────

describe("hermes — actions emitter", () => {
  const cfgPath = () => join(tmpHome, ".hermes", "config.yaml");

  function readCfg(): Record<string, unknown> {
    return parseYaml(readFileSync(cfgPath(), "utf8")) as Record<string, unknown>;
  }

  it("advertises supportsActions", () => {
    expect(hermesAdapter.capabilities.supportsActions).toBe(true);
  });

  it("installActions writes quick_commands.<id> exec entries with the action verb", () => {
    const ctx = buildCtx(actionsConnector([DEPLOY, ROLLBACK]), "user");
    const changes = hermesAdapter.installActions!(ctx);
    expect(changes.every((c) => c.platform === "hermes")).toBe(true);
    expect(changes.map((c) => c.action)).toEqual(["create", "create"]);

    const qc = readCfg().quick_commands as Record<string, unknown>;
    expect(qc.deploy).toEqual({ type: "exec", command: verb("hermes", "deploy") });
    expect(qc.rollback).toEqual({ type: "exec", command: verb("hermes", "rollback") });
  });

  it("is idempotent (a second install reports skip, bytes unchanged)", () => {
    const ctx = buildCtx(actionsConnector([DEPLOY]), "user");
    hermesAdapter.installActions!(ctx);
    const before = readFileSync(cfgPath(), "utf8");
    const changes = hermesAdapter.installActions!(ctx);
    expect(changes.every((c) => c.action === "skip")).toBe(true);
    expect(readFileSync(cfgPath(), "utf8")).toBe(before);
  });

  it("MERGE-preserves a foreign quick_commands entry and unrelated user keys", () => {
    // Seed a config with a foreign quick_command + an unrelated top-level key.
    mkdirSync(dirname(cfgPath()), { recursive: true });
    writeFileSync(
      cfgPath(),
      "model: nous-hermes\nquick_commands:\n  mine:\n    type: exec\n    command: echo hi\n",
      "utf8",
    );
    const ctx = buildCtx(actionsConnector([DEPLOY]), "user");
    hermesAdapter.installActions!(ctx);

    const cfg = readCfg();
    expect(cfg.model).toBe("nous-hermes");
    const qc = cfg.quick_commands as Record<string, unknown>;
    expect(qc.mine).toEqual({ type: "exec", command: "echo hi" });
    expect(qc.deploy).toEqual({ type: "exec", command: verb("hermes", "deploy") });
  });

  it("skip-warns when quick_commands.<id> exists and is NOT ours", () => {
    mkdirSync(dirname(cfgPath()), { recursive: true });
    writeFileSync(
      cfgPath(),
      "quick_commands:\n  deploy:\n    type: exec\n    command: my-own-deploy.sh\n",
      "utf8",
    );
    const ctx = buildCtx(actionsConnector([DEPLOY]), "user");
    const changes = hermesAdapter.installActions!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("warn");
    expect(changes[0]!.detail).toContain("not ours");
    // The user's entry is untouched.
    const qc = readCfg().quick_commands as Record<string, unknown>;
    expect(qc.deploy).toEqual({ type: "exec", command: "my-own-deploy.sh" });
  });

  it("uninstallActions removes ONLY our entries, leaving foreign ones + the map", () => {
    mkdirSync(dirname(cfgPath()), { recursive: true });
    writeFileSync(
      cfgPath(),
      "quick_commands:\n  mine:\n    type: exec\n    command: echo hi\n",
      "utf8",
    );
    const ctx = buildCtx(actionsConnector([DEPLOY]), "user");
    hermesAdapter.installActions!(ctx);
    const changes = hermesAdapter.uninstallActions!(ctx);
    expect(changes.some((c) => c.action === "remove")).toBe(true);

    const qc = readCfg().quick_commands as Record<string, unknown>;
    expect(qc.mine).toEqual({ type: "exec", command: "echo hi" });
    expect(qc.deploy).toBeUndefined();
  });

  it("uninstallActions drops the map when no entries remain", () => {
    const ctx = buildCtx(actionsConnector([DEPLOY]), "user");
    hermesAdapter.installActions!(ctx);
    hermesAdapter.uninstallActions!(ctx);
    expect(readCfg().quick_commands).toBeUndefined();
  });

  it("honors platforms.hermes.actions === false (opt-out, never writes)", () => {
    const ctx = buildCtx(actionsConnector([DEPLOY], { hermes: { actions: false } }), "user");
    const changes = hermesAdapter.installActions!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("disabled for hermes");
    expect(existsSync(cfgPath())).toBe(false);
  });

  it("skips silently when no actions are declared", () => {
    const ctx = buildCtx(defineConnector({ id: CONNECTOR_ID, commands: [{ name: "n", prompt: "p" }] }), "user");
    const changes = hermesAdapter.installActions!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("declares no actions");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// warp — one OWNED YAML workflow per action; palette PASTES (not exec)
// ─────────────────────────────────────────────────────────────────────────

describe("warp — actions emitter", () => {
  const wfPath = (id: string) => join(tmpProject, ".warp", "workflows", `${id}.yaml`);

  it("advertises supportsActions", () => {
    expect(warpAdapter.capabilities.supportsActions).toBe(true);
  });

  it("installActions writes one workflow YAML per action (name/command/description)", () => {
    const ctx = buildCtx(actionsConnector([DEPLOY, ROLLBACK]), "project");
    const changes = warpAdapter.installActions!(ctx);
    expect(changes.every((c) => c.platform === "warp")).toBe(true);
    expect(changes.map((c) => c.action)).toEqual(["create", "create"]);
    // HONESTY: the detail spells out the paste-not-exec semantics.
    expect(changes[0]!.detail).toContain("pastes the action command for the user to run");

    const deploy = parseYaml(readFileSync(wfPath("deploy"), "utf8"));
    expect(deploy).toEqual({
      name: "Deploy the app.",
      command: verb("warp", "deploy"),
      description: "Deploy the app.",
    });
    // rollback has no description → label/description fall back to the id.
    const rollback = parseYaml(readFileSync(wfPath("rollback"), "utf8"));
    expect(rollback).toEqual({
      name: "rollback",
      command: verb("warp", "rollback"),
      description: "rollback",
    });
  });

  it("user scope writes under ~/.warp/workflows/<id>.yaml", () => {
    const ctx = buildCtx(actionsConnector([DEPLOY]), "user");
    warpAdapter.installActions!(ctx);
    expect(existsSync(join(tmpHome, ".warp", "workflows", "deploy.yaml"))).toBe(true);
  });

  it("is idempotent (second install → skip, bytes unchanged)", () => {
    const ctx = buildCtx(actionsConnector([DEPLOY]), "project");
    warpAdapter.installActions!(ctx);
    const before = readFileSync(wfPath("deploy"), "utf8");
    const changes = warpAdapter.installActions!(ctx);
    expect(changes[0]!.action).toBe("skip");
    expect(readFileSync(wfPath("deploy"), "utf8")).toBe(before);
  });

  it("uninstallActions removes the owned file", () => {
    const ctx = buildCtx(actionsConnector([DEPLOY]), "project");
    warpAdapter.installActions!(ctx);
    expect(existsSync(wfPath("deploy"))).toBe(true);
    const changes = warpAdapter.uninstallActions!(ctx);
    expect(changes[0]!.action).toBe("remove");
    expect(existsSync(wfPath("deploy"))).toBe(false);
  });

  it("honors platforms.warp.actions === false (opt-out)", () => {
    const ctx = buildCtx(actionsConnector([DEPLOY], { warp: { actions: false } }), "project");
    const changes = warpAdapter.installActions!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("disabled for warp");
    expect(existsSync(wfPath("deploy"))).toBe(false);
  });

  it("skips silently when no actions are declared", () => {
    const ctx = buildCtx(defineConnector({ id: CONNECTOR_ID, skills: [{ name: "s", description: "d", body: "b" }] }), "project");
    const changes = warpAdapter.installActions!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("declares no actions");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// droid — OWNED executable command file (no .md ext), shebang + exec, 0o755
// ─────────────────────────────────────────────────────────────────────────

describe("droid — actions emitter", () => {
  const filePath = (id: string) => join(tmpProject, ".factory", "commands", id);

  it("advertises supportsActions", () => {
    expect(droidAdapter.capabilities.supportsActions).toBe(true);
  });

  it("installActions writes an executable shebang exec-file with the verb (mode 0o755)", () => {
    const ctx = buildCtx(actionsConnector([DEPLOY]), "project");
    const changes = droidAdapter.installActions!(ctx);
    expect(changes.every((c) => c.platform === "droid")).toBe(true);
    expect(changes[0]!.action).toBe("create");

    const body = readFileSync(filePath("deploy"), "utf8");
    expect(body).toBe(`#!/usr/bin/env sh\nexec ${verb("droid", "deploy")} "$@"\n`);
    // Executable bit set (compare the low 9 perm bits).
    expect(statSync(filePath("deploy")).mode & 0o777).toBe(0o755);
    // NO .md extension is written (it would collide with the command surface).
    expect(existsSync(`${filePath("deploy")}.md`)).toBe(false);
  });

  it("is idempotent (second install → skip, bytes unchanged)", () => {
    const ctx = buildCtx(actionsConnector([DEPLOY]), "project");
    droidAdapter.installActions!(ctx);
    const before = readFileSync(filePath("deploy"), "utf8");
    const changes = droidAdapter.installActions!(ctx);
    expect(changes[0]!.action).toBe("skip");
    expect(readFileSync(filePath("deploy"), "utf8")).toBe(before);
  });

  it("uninstallActions removes the owned file", () => {
    const ctx = buildCtx(actionsConnector([DEPLOY]), "project");
    droidAdapter.installActions!(ctx);
    expect(existsSync(filePath("deploy"))).toBe(true);
    const changes = droidAdapter.uninstallActions!(ctx);
    expect(changes[0]!.action).toBe("remove");
    expect(existsSync(filePath("deploy"))).toBe(false);
  });

  it("skip-warns and writes NOTHING on win32 (exec-file interp unverified)", () => {
    const spy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const ctx = buildCtx(actionsConnector([DEPLOY, ROLLBACK]), "project");
      const changes = droidAdapter.installActions!(ctx);
      expect(changes).toHaveLength(1);
      expect(changes[0]!.action).toBe("warn");
      expect(changes[0]!.detail).toContain("unverified on Windows");
      expect(changes[0]!.detail).toContain("2 skipped");
      expect(existsSync(filePath("deploy"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("honors platforms.droid.actions === false (opt-out)", () => {
    const ctx = buildCtx(actionsConnector([DEPLOY], { droid: { actions: false } }), "project");
    const changes = droidAdapter.installActions!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("disabled for droid");
    expect(existsSync(filePath("deploy"))).toBe(false);
  });

  it("skips silently when no actions are declared", () => {
    const ctx = buildCtx(defineConnector({ id: CONNECTOR_ID, commands: [{ name: "n", prompt: "p" }] }), "project");
    const changes = droidAdapter.installActions!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("declares no actions");
  });
});
