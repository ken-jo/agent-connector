/**
 * core/installer — the install-time `oauth.<key>` login warning.
 *
 * A server whose connector declares logins the user never ran opens a browser
 * (or fails closed) on its first `getAccessToken`, so the installer warns at
 * the moment the host entry is written:
 *   • one warn per `${secret:NAME}` a login's clientId / clientSecret references
 *     that the keystore does not hold (a user-registered app), before that
 *     login's absence line:
 *       login "<key>" (<provider>) references secret "<NAME>" which is not set — run `secrets set <NAME>` before `auth login <key>`
 *   • one warn per absent login:
 *       login "<key>" (<provider>) is not present — run `auth login <key>` before the server needs it
 *   • ONE warn when the keystore itself cannot be read
 *   • no warn once the refresh token is stored, and none for a connector without `oauth`
 *   • the warn is per host entry written (each target repeats it) and lands in
 *     both `changes` (inline) and `warnings` (summary block)
 * Drives the real {@link installConnector} (dry-run) into a throwaway HOME with
 * the `file` backend in a throwaway data root — no OS keystore, no network.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { installConnector } from "../../src/core/installer.js";
import { openSecretStore } from "../../src/core/secrets.js";
import { userRegisteredBing } from "../support/oauth-fixtures.js";
import type {
  PlatformId,
  ResolvedConnector,
  ResolvedOAuthLoginDef,
  ServerDef,
} from "../../src/core/types.js";

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
  tmpHome = mkdtempSync(join(tmpdir(), "ac-oauth-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-oauth-data-"));
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

/** A resolved login definition with the defaults applied, as defineConnector produces it. */
function loginDef(key: string, provider: ResolvedOAuthLoginDef["provider"]): ResolvedOAuthLoginDef {
  return {
    key,
    provider,
    clientId: `${key}-client-id`,
    scopes: ["read"],
    flow: "auto",
    redirectPath: "/callback",
    storeAs: `oauth.${key}.refresh-token`,
  };
}

/** A resolved connector carrying the given logins (built explicitly, as defineConnector would). */
function connector(logins: ResolvedOAuthLoginDef[] = []): ResolvedConnector {
  const base = defineConnector({
    id: "acme-db",
    displayName: "Acme DB Tools",
    version: "1.0.0",
    server: STDIO,
    telemetry: { enabled: false },
  });
  return { ...base, oauth: Object.fromEntries(logins.map((l) => [l.key, l])) };
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

const NOT_PRESENT = (key: string, provider: string): string =>
  `login "${key}" (${provider}) is not present — run \`auth login ${key}\` before the server needs it`;
const SECRET_NOT_SET = (key: string, provider: string, name: string): string =>
  `login "${key}" (${provider}) references secret "${name}" which is not set — run \`secrets set ${name}\` before \`auth login ${key}\``;

/** A user-registered Bing login: the id and the secret are both `${secret:NAME}` references. */
function secrets() {
  return openSecretStore({ connectorId: "acme-db", backend: "file", dataRoot: tmpData });
}

function loginWarns(result: { changes: { action: string; platform: string; detail: string }[] }) {
  return result.changes.filter((c) => c.action === "warn" && /login\(s\)|^login "/.test(c.detail));
}

describe("installer — oauth.<key> install-time warning", () => {
  it("warns once per absent login, on the host entry it wrote, and in the summary warnings", async () => {
    const result = await install(
      connector([loginDef("google", "google"), loginDef("ms", "microsoft")]),
      ["claude-code"],
    );
    const warns = loginWarns(result);
    expect(warns.map((w) => [w.platform, w.detail])).toEqual([
      ["claude-code", NOT_PRESENT("google", "google")],
      ["claude-code", NOT_PRESENT("ms", "microsoft")],
    ]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([NOT_PRESENT("google", "google"), NOT_PRESENT("ms", "microsoft")]),
    );
  });

  it("repeats the warn for every target that wrote an entry", async () => {
    const result = await install(connector([loginDef("google", "google")]), ["claude-code", "codex"]);
    const warns = loginWarns(result);
    expect(warns.map((w) => w.platform).sort()).toEqual(["claude-code", "codex"]);
    expect(new Set(warns.map((w) => w.detail))).toEqual(new Set([NOT_PRESENT("google", "google")]));
  });

  it("no warn once the refresh token is stored under storeAs", async () => {
    openSecretStore({ connectorId: "acme-db", backend: "file", dataRoot: tmpData }).set(
      "oauth.google.refresh-token",
      "rt",
    );
    const result = await install(connector([loginDef("google", "google")]), ["claude-code"]);
    expect(loginWarns(result)).toEqual([]);

    // a custom storeAs is what counts, not the default name
    const custom = { ...loginDef("ms", "microsoft"), storeAs: "ms-refresh" };
    expect(loginWarns(await install(connector([custom]), ["claude-code"]))).toHaveLength(1);
    openSecretStore({ connectorId: "acme-db", backend: "file", dataRoot: tmpData }).set("ms-refresh", "rt");
    expect(loginWarns(await install(connector([custom]), ["claude-code"]))).toEqual([]);
  });

  it("no warn for a host whose override disables the server (nothing is written there)", async () => {
    const c = connector([loginDef("google", "google")]);
    const result = await install(
      { ...c, platforms: { "claude-code": { server: false } } },
      ["claude-code"],
    );
    expect(loginWarns(result)).toEqual([]);
  });

  it("no warn for a connector without oauth", async () => {
    const result = await install(connector(), ["claude-code"]);
    expect(loginWarns(result)).toEqual([]);
  });

  it("the login warning never carries a token", async () => {
    openSecretStore({ connectorId: "acme-db", backend: "file", dataRoot: tmpData }).set(
      "oauth.google.refresh-token",
      "rt-secret-value",
    );
    const result = await install(
      connector([loginDef("google", "google"), loginDef("ms", "microsoft")]),
      ["claude-code"],
    );
    expect(JSON.stringify(result)).not.toContain("rt-secret-value");
  });

  it("names each unset ${secret:NAME} a login references, clientId first, before that login's absence line", async () => {
    const result = await install(connector([userRegisteredBing(loginDef("bing", "bing-webmaster")), loginDef("google", "google")]), ["claude-code"]);
    expect(loginWarns(result).map((w) => w.detail)).toEqual([
      SECRET_NOT_SET("bing", "bing-webmaster", "bing-client-id"),
      SECRET_NOT_SET("bing", "bing-webmaster", "bing-client-secret"),
      NOT_PRESENT("bing", "bing-webmaster"),
      NOT_PRESENT("google", "google"),
    ]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        SECRET_NOT_SET("bing", "bing-webmaster", "bing-client-id"),
        SECRET_NOT_SET("bing", "bing-webmaster", "bing-client-secret"),
      ]),
    );
    // `install` keeps its exit-1-on-warn convention: the lines are warnings, not failures.
    expect(result.changes.some((c) => c.detail?.includes("installServer failed"))).toBe(false);
  });

  it("reports a name referenced by both clientId and clientSecret once", async () => {
    const result = await install(connector([userRegisteredBing(loginDef("bing", "bing-webmaster"), "bing-app", "bing-app")]), ["claude-code"]);
    expect(loginWarns(result).map((w) => w.detail)).toEqual([
      SECRET_NOT_SET("bing", "bing-webmaster", "bing-app"),
      NOT_PRESENT("bing", "bing-webmaster"),
    ]);
  });

  it("drops each secret line once `secrets set` stored the value, and the absence line once the login ran", async () => {
    const c = connector([userRegisteredBing(loginDef("bing", "bing-webmaster"))]);
    secrets().set("bing-client-id", "bing-app-id");
    expect(loginWarns(await install(c, ["claude-code"])).map((w) => w.detail)).toEqual([
      SECRET_NOT_SET("bing", "bing-webmaster", "bing-client-secret"),
      NOT_PRESENT("bing", "bing-webmaster"),
    ]);
    secrets().set("bing-client-secret", "bing-app-secret");
    expect(loginWarns(await install(c, ["claude-code"])).map((w) => w.detail)).toEqual([NOT_PRESENT("bing", "bing-webmaster")]);
    secrets().set("oauth.bing.refresh-token", "rt");
    const done = await install(c, ["claude-code"]);
    expect(loginWarns(done)).toEqual([]);
    expect(JSON.stringify(done)).not.toContain("bing-app-secret");
  });

  it("no secret line for a literal clientId, ${env:VAR} clientId or literal clientSecret", async () => {
    const google: ResolvedOAuthLoginDef = { ...loginDef("google", "google"), clientSecret: "GOCSPX-replace-me" };
    const ms: ResolvedOAuthLoginDef = { ...loginDef("ms", "microsoft"), clientId: "${env:MS_CLIENT_ID}" };
    const result = await install(connector([google, ms]), ["claude-code"]);
    expect(loginWarns(result).map((w) => w.detail)).toEqual([NOT_PRESENT("google", "google"), NOT_PRESENT("ms", "microsoft")]);
  });

  it("repeats the same secret and absence lines, in order, for every host that wrote an entry (probed once per connector)", async () => {
    const result = await install(connector([userRegisteredBing(loginDef("bing", "bing-webmaster")), loginDef("google", "google")]), ["claude-code", "codex"]);
    const expected = [
      SECRET_NOT_SET("bing", "bing-webmaster", "bing-client-id"),
      SECRET_NOT_SET("bing", "bing-webmaster", "bing-client-secret"),
      NOT_PRESENT("bing", "bing-webmaster"),
      NOT_PRESENT("google", "google"),
    ];
    for (const platform of ["claude-code", "codex"]) {
      expect(loginWarns(result).filter((w) => w.platform === platform).map((w) => w.detail)).toEqual(expected);
    }
    expect(result.warnings.filter((w) => expected.includes(w))).toHaveLength(expected.length * 2);
  });

  it("ONE warn (never a failure) when the keystore backend is unavailable, with no secret line", async () => {
    const foreign = process.platform === "win32" ? "keychain" : "credential-manager";
    process.env.AGENT_CONNECTOR_SECRETS_BACKEND = foreign;
    const result = await install(connector([userRegisteredBing(loginDef("bing", "bing-webmaster")), loginDef("google", "google")]), ["claude-code"]);
    const warns = loginWarns(result);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.detail).toMatch(/cannot verify login\(s\) bing, google/);
    expect(JSON.stringify(result)).not.toContain("references secret");
  });

  it("ONE warn (never a failure) when the keystore backend is unavailable on this OS", async () => {
    const foreign = process.platform === "win32" ? "keychain" : "credential-manager";
    process.env.AGENT_CONNECTOR_SECRETS_BACKEND = foreign;
    const result = await install(
      connector([loginDef("google", "google"), loginDef("ms", "microsoft")]),
      ["claude-code"],
    );
    const warns = loginWarns(result);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.detail).toMatch(/cannot verify login\(s\) google, ms/);
    // the install itself still completed (no installServer step failure)
    expect(result.changes.some((c) => c.detail?.includes("installServer failed"))).toBe(false);
  });
});
