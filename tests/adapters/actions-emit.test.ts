/**
 * tests/adapters/actions-emit — the action-surface EMITTER for warp.
 * (droid now lives in adapters/droid.test.ts; hermes now lives in
 * adapters/hermes.test.ts.)
 *
 * Each emitter installs a user-invokable host trigger that runs the home-bin
 * action verb (`<homeBin> action <host> <id> --connector <id>`):
 *   • warp   → one OWNED YAML workflow per action at <cfg>/workflows/<id>.yaml
 *     ({ name, command, description }; palette pastes the command — not exec).
 *
 * Asserts: exact trigger bytes, idempotency, reversible uninstall (warp removes
 * the owned file), per-platform actions===false opt-out, empty-actions skip, and
 * the stamped ChangeRecord platform. HOME-isolated (mkdtemp) + deterministic.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { buildHomeBinActionCommand } from "../../src/core/spawn.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ActionDef, ResolvedConnector } from "../../src/core/types.js";

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
