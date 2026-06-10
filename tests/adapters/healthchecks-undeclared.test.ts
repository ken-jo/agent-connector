/**
 * tests/adapters/healthchecks-undeclared — REGISTRY-WIDE regression for the
 * "only assert what the connector declares" doctor rule.
 *
 * Found dogfooding omg (a catalog-only connector with NO MCP server and NO
 * hooks): adapter getHealthChecks() asserted host-config entries for surfaces
 * the connector never declared — e.g. codex FAILed "mcp_servers.omg registered"
 * even though a server-less connector never writes an [mcp_servers.<id>] table.
 * The rule (reference idiom: codex's mcp_servers check + cursor's hooks.json
 * check):
 *   - server-entry/registration checks return OK ("no MCP server declared")
 *     when `ctx.connector.server` is absent;
 *   - hooks-file/hook-registration checks return OK ("no hooks declared")
 *     when `ctx.connector.hookEvents` is empty.
 *
 * This test sweeps EVERY adapter in ADAPTER_REGISTRY with a connector that
 * declares NOTHING (no server, hooks: {}, hookEvents: [], no commands/skills/
 * subagents) inside a sandboxed HOME. Mirroring the doctor-targets fixture, the
 * host's primary config file is created minimally ("{}" — the host IS
 * installed; the connector just never wrote anything into it), then every
 * health check runs and NO FAIL may complain about a server entry or hooks
 * file (name+detail must not match /mcp|server|hook/i).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";
import type { Adapter, InstallContext } from "../../src/adapters/spi.js";
import { defineConnector } from "../../src/core/define-connector.js";
import type { ResolvedConnector } from "../../src/core/types.js";

/**
 * Env vars that can redirect an adapter's user-scope config resolution outside
 * the sandboxed HOME (CODEX_HOME for codex, KIMI_HOME/KIMI_CODE_HOME for kimi,
 * XDG_CONFIG_HOME for kilo, PI_CODING_AGENT_DIR for omp; APPDATA/LOCALAPPDATA
 * on Windows). All are saved + sandboxed/cleared per test so nothing reads or
 * pollutes the real user config.
 */
const SANDBOXED_ENV = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "AGENT_CONNECTOR_DATA_DIR",
  "XDG_CONFIG_HOME",
  "CODEX_HOME",
  "KIMI_HOME",
  "KIMI_CODE_HOME",
  "PI_CODING_AGENT_DIR",
] as const;

let tmp: string;
let saved: Partial<Record<(typeof SANDBOXED_ENV)[number], string | undefined>>;

beforeEach(() => {
  saved = {};
  for (const key of SANDBOXED_ENV) saved[key] = process.env[key];
  tmp = mkdtempSync(join(tmpdir(), "ac-hc-undeclared-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.APPDATA = join(tmp, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(tmp, "AppData", "Local");
  process.env.AGENT_CONNECTOR_DATA_DIR = join(tmp, ".agent-connector");
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CODEX_HOME;
  delete process.env.KIMI_HOME;
  delete process.env.KIMI_CODE_HOME;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  for (const key of SANDBOXED_ENV) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A connector that declares NOTHING installable: no server, `hooks: {}` (so
 * hookEvents resolves to []), and no commands/skills/subagents. This is the
 * omg shape minus even its catalog content — the worst case for any health
 * check that asserts an undeclared surface.
 */
function declaresNothing(): ResolvedConnector {
  return defineConnector({ id: "omg-min", hooks: {} });
}

function buildCtx(connector: ResolvedConnector): InstallContext {
  const projectDir = join(tmp, "project");
  mkdirSync(projectDir, { recursive: true });
  return {
    connector,
    scope: "user",
    projectDir,
    homeBinPath: join(tmp, ".agent-connector", "bin", "agent-connector"),
    dataRoot: join(tmp, ".agent-connector"),
    dryRun: false,
  };
}

/**
 * Mirror the doctor-targets fixture: the host is "installed" — its primary
 * config file exists but contains nothing of ours (the connector never wrote
 * an entry). Safety: only write inside the sandbox; an adapter with no
 * writable server config (e.g. pi) may resolve something unusual or throw —
 * in that case there is simply no fixture to create.
 */
function createHostConfigFixture(adapter: Adapter, ctx: InstallContext): void {
  let path: string;
  try {
    path = adapter.getServerConfigPath(ctx);
  } catch {
    return;
  }
  if (!path.startsWith(tmp + sep)) {
    throw new Error(
      `${adapter.id}: getServerConfigPath escaped the sandbox: ${path}`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}", "utf8");
}

/** A health-check outcome flattened for the regex screen below. */
interface RanCheck {
  adapter: string;
  name: string;
  status: "OK" | "FAIL";
  detail: string;
}

function runHealthChecks(adapter: Adapter, ctx: InstallContext): RanCheck[] {
  const results: RanCheck[] = [];
  for (const hc of adapter.getHealthChecks?.(ctx) ?? []) {
    try {
      const r = hc.check();
      results.push({
        adapter: adapter.id,
        name: hc.name,
        status: r.status,
        detail: r.detail ?? "",
      });
    } catch (err) {
      // A throwing check is a hard failure; screen its message like a detail.
      results.push({
        adapter: adapter.id,
        name: hc.name,
        status: "FAIL",
        detail: `threw: ${String(err)}`,
      });
    }
  }
  return results;
}

/** The complaint signature of the bug class: an undeclared server/hooks assert. */
const UNDECLARED_SURFACE_COMPLAINT = /mcp|server|hook/i;

describe("the declares-nothing connector really declares nothing", () => {
  it("resolves with no server, no hookEvents, and empty content surfaces", () => {
    const connector = declaresNothing();
    expect(connector.server).toBeUndefined();
    expect(connector.hooks).toEqual({});
    expect(connector.hookEvents).toEqual([]);
    expect(connector.commands).toEqual([]);
    expect(connector.skills).toEqual([]);
    expect(connector.subagents).toEqual([]);
  });
});

describe("getHealthChecks — registry-wide, connector that declares NOTHING", () => {
  it.each(ADAPTER_REGISTRY.map((factory) => [factory.id, factory] as const))(
    "%s: no health check FAILs with a server-entry or hooks-file complaint",
    async (_id, factory) => {
      const adapter = await factory.load();
      const ctx = buildCtx(declaresNothing());
      createHostConfigFixture(adapter, ctx);

      const results = runHealthChecks(adapter, ctx);

      // The bug class: a FAIL whose name or detail complains about an MCP
      // server entry / hooks file the connector never declared. Other FAILs
      // (none expected with the fixture in place) are outside this regression's
      // scope and are not screened here.
      const offenders = results.filter(
        (r) =>
          r.status === "FAIL" &&
          UNDECLARED_SURFACE_COMPLAINT.test(`${r.name} ${r.detail}`),
      );
      expect(offenders).toEqual([]);
    },
  );
});
