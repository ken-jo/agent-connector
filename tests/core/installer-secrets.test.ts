/**
 * core/installer — the install-time `${secret:NAME}` warning.
 *
 * The serve wrapper injects a connector's referenced secrets at launch and
 * refuses to start the server while any is unset, so the installer warns at
 * the moment the host entry is written:
 *   • one warn per unset name:
 *       secret "<name>" is not set — run `secrets set <name>` before the host launches the server
 *   • ONE warn when the keystore itself is unavailable (reason + hint)
 *   • no warn once the secret is set, and none for a server without secretEnv
 *   • the warn is per host entry written (each target repeats it) and lands in
 *     both `changes` (inline) and `warnings` (summary block)
 * Drives the real {@link installConnector} (dry-run) into a throwaway HOME with
 * the `file` backend in a throwaway data root — no OS keystore is touched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { installConnector } from "../../src/core/installer.js";
import { registerConnector } from "../../src/core/load-connector.js";
import { openSecretStore } from "../../src/core/secrets.js";
import type { PlatformId, ResolvedConnector, ServerDef } from "../../src/core/types.js";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  AGENT_CONNECTOR_DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  AGENT_CONNECTOR_SECRETS_BACKEND: process.env.AGENT_CONNECTOR_SECRETS_BACKEND,
  AGENT_CONNECTOR_TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
};

let tmpHome: string;
let tmpData: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-secrets-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-secrets-data-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  process.env.AGENT_CONNECTOR_SECRETS_BACKEND = "file";
  delete process.env.AGENT_CONNECTOR_TELEMETRY;
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of [tmpHome, tmpData]) rmSync(d, { recursive: true, force: true });
});

const STDIO: ServerDef = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@acme/db-mcp"],
  env: { PLAIN: "x" },
};

/** A resolved connector whose server carries `secretEnv` (built explicitly, as defineConnector would). */
function connector(secretEnv?: Record<string, string>): ResolvedConnector {
  const base = defineConnector({
    id: "acme-db",
    displayName: "Acme DB Tools",
    version: "1.0.0",
    server: STDIO,
    telemetry: { enabled: false },
  });
  const server = base.server as ServerDef;
  return { ...base, server: secretEnv ? { ...server, secretEnv } : server };
}

async function install(c: ResolvedConnector, targets: PlatformId[]) {
  return installConnector({
    connector: c,
    modulePath: join(tmpData, "fake.mjs"),
    scope: "user",
    projectDir: tmpHome,
    targets,
    dryRun: true,
  });
}

const NOT_SET = (name: string): string =>
  `secret "${name}" is not set — run \`secrets set ${name}\` before the host launches the server`;

function secretWarns(result: { changes: { action: string; platform: string; detail: string }[] }) {
  return result.changes.filter((c) => c.action === "warn" && /^secret(s backend)? /.test(c.detail));
}

describe("installer — ${secret:NAME} install-time warning", () => {
  it("warns once per unset name, on the host entry it wrote, and in the summary warnings", async () => {
    const result = await install(
      connector({ API_KEY: "${secret:api-key}", DB_PASS: "${secret:db-pass}" }),
      ["claude-code"],
    );
    const warns = secretWarns(result);
    expect(warns.map((w) => [w.platform, w.detail])).toEqual([
      ["claude-code", NOT_SET("api-key")],
      ["claude-code", NOT_SET("db-pass")],
    ]);
    expect(result.warnings).toEqual(expect.arrayContaining([NOT_SET("api-key"), NOT_SET("db-pass")]));
  });

  it("repeats the warn for every target that wrote an entry", async () => {
    const result = await install(connector({ API_KEY: "${secret:api-key}" }), ["claude-code", "codex"]);
    const warns = secretWarns(result);
    expect(warns.map((w) => w.platform).sort()).toEqual(["claude-code", "codex"]);
    expect(new Set(warns.map((w) => w.detail))).toEqual(new Set([NOT_SET("api-key")]));
  });

  it("no warn once the secret is set", async () => {
    openSecretStore({ connectorId: "acme-db", backend: "file", dataRoot: tmpData }).set(
      "api-key",
      "value",
    );
    const result = await install(connector({ API_KEY: "${secret:api-key}" }), ["claude-code"]);
    expect(secretWarns(result)).toEqual([]);
  });

  it("warns when the id is re-registered from another module while secrets are stored under it", async () => {
    const c = connector({ API_KEY: "${secret:api-key}" });
    openSecretStore({ connectorId: "acme-db" }).set("api-key", "K");
    registerConnector(c, join(tmpData, "prior.mjs"), "user");
    const result = await install(c, ["claude-code"]);
    const handover = result.warnings.filter((w) => /was registered from/.test(w));
    expect(handover).toHaveLength(1);
    expect(handover[0]).toContain(join(tmpData, "prior.mjs"));
    expect(handover[0]).toContain(join(tmpData, "fake.mjs"));
    expect(handover[0]).toContain("(api-key)");
    expect(handover[0]).not.toContain("K\"");
    expect(result.changes.filter((ch) => /was registered from/.test(ch.detail ?? ""))).toHaveLength(1);
    // Same module, or nothing stored, or no secrets referenced: silent.
    registerConnector(c, join(tmpData, "fake.mjs"), "user");
    expect((await install(c, ["claude-code"])).warnings.some((w) => /was registered from/.test(w))).toBe(false);
    registerConnector(c, join(tmpData, "prior.mjs"), "user");
    expect((await install(connector(), ["claude-code"])).warnings.some((w) => /was registered from/.test(w))).toBe(false);
    openSecretStore({ connectorId: "acme-db" }).delete("api-key");
    expect((await install(c, ["claude-code"])).warnings.some((w) => /was registered from/.test(w))).toBe(false);
  });

  it("no warn for a host whose override disables the server (nothing is written there)", async () => {
    const c = connector({ API_KEY: "${secret:api-key}" });
    const result = await install(
      { ...c, platforms: { "claude-code": { server: false } } },
      ["claude-code"],
    );
    expect(secretWarns(result)).toEqual([]);
  });

  it("no warn for a server without secretEnv", async () => {
    const result = await install(connector(), ["claude-code"]);
    expect(secretWarns(result)).toEqual([]);
  });

  it("ONE warn (never a failure) when the keystore backend is unavailable on this OS", async () => {
    const foreign = process.platform === "win32" ? "keychain" : "credential-manager";
    process.env.AGENT_CONNECTOR_SECRETS_BACKEND = foreign;
    const result = await install(
      connector({ API_KEY: "${secret:api-key}", DB_PASS: "${secret:db-pass}" }),
      ["claude-code"],
    );
    const warns = secretWarns(result);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.detail).toMatch(new RegExp(`^secrets backend ${foreign} unavailable: .+ only; cannot verify api-key, db-pass$`));
    // the install itself still completed (no installServer step failure)
    expect(result.changes.some((c) => c.detail?.includes("installServer failed"))).toBe(false);
  });
});
