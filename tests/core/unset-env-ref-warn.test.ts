/**
 * core/unset-env-ref-warn — the silent-empty-secret install guard.
 *
 * On hosts WITHOUT native ${env:VAR} interpolation (Codex TOML and ~25 others)
 * the installer resolves env-refs to LITERALS at install time. A ref whose var
 * is unset AND that carries no `:-default` therefore bakes "" into the server's
 * secret-bearing fields — a broken install that previously exited 0 with no
 * signal and only surfaced as a runtime auth failure inside the MCP server.
 * The installer now emits a `warn` ChangeRecord at the moment the entry is
 * written. This suite is the byte-oracle for that warn:
 *   • codex (literal host) + an unset, defaultless ref → one warn naming the var
 *   • codex + the SAME ref with a value exported → NO warn
 *   • codex + a ref WITH a `:-default` → NO warn (intentional)
 *   • claude-code (native ${env:VAR} interpolation) → NO warn (token passes
 *     through to the host config; no literal is baked)
 *
 * Drives the real {@link installConnector} (dry-run) into a throwaway HOME so the
 * real user home and repo tree are never touched (mirrors native-hooks.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConnector } from "../../src/core/define-connector.js";
import { installConnector } from "../../src/core/installer.js";
import type { PlatformId, ResolvedConnector } from "../../src/core/types.js";

const ENV_VAR = "ACME_DB_URL";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
  ENV_VAR: process.env[ENV_VAR],
};

let tmpHome: string;
let tmpData: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-unsetref-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-unsetref-data-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  delete process.env.AGENT_CONNECTOR_TELEMETRY;
  delete process.env[ENV_VAR];
});

afterEach(() => {
  for (const [key, envKey] of [
    ["HOME", "HOME"],
    ["USERPROFILE", "USERPROFILE"],
    ["DATA_DIR", "AGENT_CONNECTOR_DATA_DIR"],
    ["TELEMETRY", "AGENT_CONNECTOR_TELEMETRY"],
    ["ENV_VAR", ENV_VAR],
  ] as const) {
    const value = SAVED[key];
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
  for (const d of [tmpHome, tmpData]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function connectorWithEnv(ref: string): ResolvedConnector {
  return defineConnector({
    id: "acme-db",
    displayName: "Acme DB Tools",
    version: "1.0.0",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/db-mcp"],
      env: { [ENV_VAR]: ref },
    },
    telemetry: { enabled: false },
  });
}

async function install(connector: ResolvedConnector, target: PlatformId) {
  return installConnector({
    connector,
    modulePath: join(tmpData, "fake.mjs"),
    scope: "user",
    projectDir: tmpHome,
    targets: [target],
    dryRun: true,
  });
}

const BAKE_WARN_RE = new RegExp(`${ENV_VAR} is unset — baking an empty value`);

describe("installer — unset env-ref bake warning (literal-resolving host)", () => {
  it("codex: an unset, defaultless ref → one warn naming the var", async () => {
    const result = await install(connectorWithEnv(`\${env:${ENV_VAR}}`), "codex");
    const warns = result.changes.filter(
      (c) => c.action === "warn" && BAKE_WARN_RE.test(c.detail),
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]!.platform).toBe("codex");
    expect(warns[0]!.detail).toContain(`baking an empty value into codex config`);
    expect(warns[0]!.detail).toContain("export it before install");
  });

  it("codex: the SAME ref with the var EXPORTED → NO warn", async () => {
    process.env[ENV_VAR] = "postgres://real";
    const result = await install(connectorWithEnv(`\${env:${ENV_VAR}}`), "codex");
    expect(
      result.changes.some((c) => c.action === "warn" && BAKE_WARN_RE.test(c.detail)),
    ).toBe(false);
  });

  it("codex: a ref WITH a :-default → NO warn (intentional)", async () => {
    const result = await install(
      connectorWithEnv(`\${env:${ENV_VAR}:-postgres://fallback}`),
      "codex",
    );
    expect(
      result.changes.some((c) => c.action === "warn" && BAKE_WARN_RE.test(c.detail)),
    ).toBe(false);
  });
});

describe("installer — unset env-ref on a native-interpolation host", () => {
  it("claude-code: the ${env:VAR} token passes through → NO bake warn", async () => {
    const result = await install(connectorWithEnv(`\${env:${ENV_VAR}}`), "claude-code");
    expect(
      result.changes.some((c) => c.action === "warn" && BAKE_WARN_RE.test(c.detail)),
    ).toBe(false);
    // The server entry IS still written (the token is rendered natively).
    expect(
      result.changes.some(
        (c) => c.platform === "claude-code" && (c.action === "create" || c.action === "update"),
      ),
    ).toBe(true);
  });
});
