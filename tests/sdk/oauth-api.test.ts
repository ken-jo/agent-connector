/**
 * sdk — the OAuth surface re-exported from `@ken-jo/agent-connector/sdk`.
 *
 * A connector author (or their MCP server) reaches the login engine through
 * the SDK import alone: `getAccessToken`, `login`, `logout`, `loginStatus`,
 * `canOpenBrowser`, `OAUTH_PRESET_IDS`, `getOAuthPreset`, `discoverEndpoints`,
 * the two error classes and the documented types. Exercised against the
 * `file` backend in a throwaway data root; no browser opens and no live
 * provider is contacted.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as sdk from "../../src/sdk/index.js";
import type {
  AccessTokenOptions,
  LoginResult,
  LoginStatus,
  OAuthLoginDef,
  OAuthPreset,
  OAuthPresetId,
  ResolvedOAuthLoginDef,
  TokenSet,
} from "../../src/sdk/index.js";

const SAVED = {
  AGENT_CONNECTOR_DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  AGENT_CONNECTOR_SECRETS_BACKEND: process.env.AGENT_CONNECTOR_SECRETS_BACKEND,
  AGENT_CONNECTOR_BROWSER: process.env.AGENT_CONNECTOR_BROWSER,
};

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "ac-sdk-oauth-"));
  process.env.AGENT_CONNECTOR_DATA_DIR = dataRoot;
  process.env.AGENT_CONNECTOR_SECRETS_BACKEND = "file";
  delete process.env.AGENT_CONNECTOR_BROWSER;
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dataRoot, { recursive: true, force: true });
});

/** A generic login whose endpoints are loopback addresses nothing listens on — never contacted here. */
const DEF: ResolvedOAuthLoginDef = {
  key: "acme",
  provider: "generic",
  clientId: "cid",
  scopes: ["read"],
  authorizationEndpoint: "http://127.0.0.1:9/authorize",
  tokenEndpoint: "http://127.0.0.1:9/token",
  flow: "auto",
  redirectPath: "/callback",
  storeAs: "oauth.acme.refresh-token",
};

describe("sdk oauth exports", () => {
  it("exposes the documented functions, constants and error classes", () => {
    expect(typeof sdk.getAccessToken).toBe("function");
    expect(typeof sdk.login).toBe("function");
    expect(typeof sdk.logout).toBe("function");
    expect(typeof sdk.loginStatus).toBe("function");
    expect(typeof sdk.canOpenBrowser).toBe("function");
    expect(typeof sdk.getOAuthPreset).toBe("function");
    expect(typeof sdk.discoverEndpoints).toBe("function");
    expect(sdk.OAUTH_PRESET_IDS).toEqual(["google", "microsoft", "github", "bing-webmaster", "posthog", "generic"]);

    const err = new sdk.OAuthError("config", "x", "h");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("config");
    expect(err.hint).toBe("h");
    const required = new sdk.OAuthLoginRequiredError("acme-db", "google");
    expect(required).toBeInstanceOf(sdk.OAuthError);
    expect(required.code).toBe("login-required");
    expect(required.command).toBe("auth login google --connector-id acme-db");
    expect(required.message).toBe(
      'login "google" is not present for connector acme-db — run `auth login google --connector-id acme-db`',
    );
  });

  it("presets: every id resolves through getOAuthPreset with the exported types", () => {
    for (const id of sdk.OAUTH_PRESET_IDS) {
      const presetId: OAuthPresetId = id;
      const preset: OAuthPreset = sdk.getOAuthPreset(presetId);
      expect(preset.id).toBe(id);
      expect(preset.label.length).toBeGreaterThan(0);
      expect(typeof preset.pkce).toBe("boolean");
      expect(typeof preset.deviceFlow).toBe("boolean");
    }
    // README "By the numbers": presets minus generic.
    expect(sdk.OAUTH_PRESET_IDS.filter((id) => id !== "generic")).toHaveLength(5);
    expect(() => sdk.getOAuthPreset("nope" as OAuthPresetId)).toThrow();
  });

  it("canOpenBrowser honors the AGENT_CONNECTOR_BROWSER override", () => {
    expect(sdk.canOpenBrowser({ AGENT_CONNECTOR_BROWSER: "never" }, "darwin")).toBe(false);
    expect(sdk.canOpenBrowser({ AGENT_CONNECTOR_BROWSER: "always" }, "linux")).toBe(true);
    expect(sdk.canOpenBrowser({}, "linux")).toBe(false);
  });

  it("loginStatus reads presence from the secret store, never the network", () => {
    const opts = { connectorId: "acme-db", logins: { acme: DEF } };
    const absent: LoginStatus[] = sdk.loginStatus(opts);
    expect(absent.map((s) => [s.key, s.provider, s.present])).toEqual([["acme", "generic", false]]);

    sdk.openSecretStore({ connectorId: "acme-db", backend: "file", dataRoot }).set("oauth.acme.refresh-token", "rt");
    const present: LoginStatus[] = sdk.loginStatus(opts);
    expect(present.map((s) => [s.key, s.present])).toEqual([["acme", true]]);
    expect(JSON.stringify(present)).not.toContain("rt");
  });

  it("getAccessToken with interactive: never and no stored login rejects with OAuthLoginRequiredError", async () => {
    const opts: AccessTokenOptions = { connectorId: "acme-db", key: "acme", def: DEF, interactive: "never" };
    const failure = await sdk.getAccessToken(opts).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(sdk.OAuthLoginRequiredError);
    expect((failure as sdk.OAuthLoginRequiredError).message).toBe(
      'login "acme" is not present for connector acme-db — run `auth login acme --connector-id acme-db`',
    );
  });

  it("getAccessToken without a registry record and without def is a config error", async () => {
    const failure = await sdk
      .getAccessToken({ connectorId: "never-registered", key: "acme", interactive: "never" })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(failure).toBeInstanceOf(sdk.OAuthError);
    expect((failure as sdk.OAuthError).code).toBe("config");
  });

  it("logout of a login that was never run reports nothing removed", async () => {
    const outcome = await sdk.logout({ connectorId: "acme-db", key: "acme", def: DEF });
    expect(outcome).toEqual({ removed: false, revoked: false });
  });

  it("the documented types are exported", () => {
    const def: OAuthLoginDef = { provider: "google", clientId: "cid", scopes: ["openid"] };
    const token: TokenSet = { accessToken: "at", tokenType: "Bearer" };
    const result: LoginResult = { key: "google", provider: "google", obtainedVia: "loopback", backend: "file" };
    expect([def.provider, token.tokenType, result.obtainedVia]).toEqual(["google", "Bearer", "loopback"]);
  });
});
