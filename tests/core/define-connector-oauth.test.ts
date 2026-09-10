/**
 * core/define-connector — `oauth.<key>` logins.
 *
 * defineConnector validates every login (key, preset, client id, the
 * `${secret:NAME}`-only client secret, scopes, flow, port, path, https
 * endpoints, secret names), applies the three defaults (flow "auto",
 * redirectPath "/callback", storeAs `oauth.<key>.refresh-token`), and leaves a
 * config without `oauth` untouched apart from the trailing `oauth: {}` key.
 * The registry record persists the normalized logins and reads back `{}` for
 * a record written before the field existed.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConnectorConfigError, defineConnector } from "../../src/core/define-connector.js";
import { connectorFromMeta, readRegisteredMeta, registerConnector } from "../../src/core/load-connector.js";
import type { ConnectorConfig, OAuthLoginDef } from "../../src/core/types.js";

const STDIO = { transport: "stdio" as const, command: "npx", args: ["-y", "@acme/seo-mcp"] };

const GOOGLE: OAuthLoginDef = {
  provider: "google",
  clientId: "1234567890-abc.apps.googleusercontent.com",
  clientSecret: "${secret:google-client-secret}",
  scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
};

/** A config with one login under `key`; `login` overrides the google baseline (loosely typed to reach invalid shapes). */
function withLogin(key: string, login: Record<string, unknown> = {}): ConnectorConfig {
  return {
    id: "seo-mcp",
    server: STDIO,
    oauth: { [key]: { ...GOOGLE, ...login } as unknown as OAuthLoginDef },
  };
}

function messageOf(config: ConnectorConfig): string {
  try {
    defineConnector(config);
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorConfigError);
    return (err as Error).message;
  }
  throw new Error("defineConnector accepted the config");
}

function expectRejected(config: ConnectorConfig, message: string): void {
  expect(messageOf(config)).toBe(`Invalid connector config: ${message}`);
}

describe("defineConnector — oauth defaults and pass-through", () => {
  it("stamps the key and applies flow / redirectPath / storeAs defaults, keeping the rest verbatim", () => {
    const resolved = defineConnector(withLogin("google"));
    expect(resolved.oauth).toEqual({
      google: {
        ...GOOGLE,
        key: "google",
        flow: "auto",
        redirectPath: "/callback",
        storeAs: "oauth.google.refresh-token",
      },
    });
    expect(resolved.oauth.google!.scopes).toEqual(GOOGLE.scopes);
  });

  it("keeps explicit values", () => {
    const login: OAuthLoginDef = {
      ...GOOGLE,
      flow: "device",
      redirectPort: 8765,
      redirectPath: "/oauth/return",
      storeAs: "google-refresh",
      pkce: false,
      tokenEndpointAuth: "client_secret_basic",
      extraAuthorizationParams: { login_hint: "ops@example.com" },
      options: { tenant: "common" },
      issuer: "https://accounts.google.com",
      revocationEndpoint: "https://oauth2.googleapis.com/revoke",
    };
    const resolved = defineConnector({ id: "seo-mcp", server: STDIO, oauth: { google: login } });
    expect(resolved.oauth.google).toEqual({ ...login, key: "google" });
  });

  it("normalizes every login and keeps declaration order", () => {
    const resolved = defineConnector({
      id: "seo-mcp",
      server: STDIO,
      oauth: {
        google: GOOGLE,
        bing: { provider: "bing-webmaster", clientId: "${env:BING_CLIENT_ID}", clientSecret: "${secret:bing-secret}", scopes: ["webmaster.manage"], redirectPort: 51000 },
        posthog: { provider: "posthog", clientId: "https://seo-mcp.example.com/oauth-client", scopes: ["query:read"], options: { region: "eu" } },
      },
    });
    expect(Object.keys(resolved.oauth)).toEqual(["google", "bing", "posthog"]);
    expect(resolved.oauth.bing!.storeAs).toBe("oauth.bing.refresh-token");
    expect(resolved.oauth.bing!.redirectPort).toBe(51000);
    expect(resolved.oauth.posthog!.options).toEqual({ region: "eu" });
  });

  it("resolves a config without oauth to oauth: {} as the last key and leaves everything else alone", () => {
    const config: ConnectorConfig = { id: "seo-mcp", server: STDIO };
    const resolved = defineConnector(config);
    expect(resolved.oauth).toEqual({});
    expect(Object.keys(resolved).at(-1)).toBe("oauth");
    // Absent and explicitly empty produce the same connector, key for key.
    const explicit = defineConnector({ ...config, oauth: {} });
    expect(Object.keys(explicit)).toEqual(Object.keys(resolved));
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(resolved));
    const { oauth: _oauth, ...rest } = resolved;
    expect(Object.keys(rest)).not.toContain("oauth");
    expect(rest.server).toMatchObject(STDIO);
    expect(rest.commands).toEqual([]);
    expect(defineConnector({ id: "seo-mcp", server: STDIO, oauth: undefined }).oauth).toEqual({});
    expect(defineConnector({ id: "seo-mcp", server: STDIO, oauth: {} }).oauth).toEqual({});
  });
});

describe("defineConnector — oauth validation messages", () => {
  it("rejects a login key outside ^[a-z0-9][a-z0-9-]{0,31}$", () => {
    for (const key of ["Google", "-google", "google_search", "a".repeat(33), "", "goo gle"]) {
      expectRejected(withLogin(key), `oauth: "${key}" is not a valid login key (expected ^[a-z0-9][a-z0-9-]{0,31}$)`);
    }
    expect(Object.keys(defineConnector(withLogin("a".repeat(32))).oauth)).toEqual(["a".repeat(32)]);
  });

  it("rejects oauth that is not an object, and a login that is not an object", () => {
    expectRejected({ id: "seo-mcp", server: STDIO, oauth: [] as unknown as ConnectorConfig["oauth"] }, "oauth must be an object keyed by login key");
    expectRejected({ id: "seo-mcp", server: STDIO, oauth: "google" as unknown as ConnectorConfig["oauth"] }, "oauth must be an object keyed by login key");
    expectRejected({ id: "seo-mcp", server: STDIO, oauth: { google: null as unknown as OAuthLoginDef } }, "oauth.google must be an object");
  });

  it("rejects an unknown provider", () => {
    expectRejected(
      withLogin("sso", { provider: "okta" }),
      'oauth.sso.provider: "okta" is not a known OAuth preset (google, microsoft, github, bing-webmaster, posthog, generic)',
    );
    expectRejected(
      withLogin("sso", { provider: undefined }),
      'oauth.sso.provider: "undefined" is not a known OAuth preset (google, microsoft, github, bing-webmaster, posthog, generic)',
    );
  });

  it("rejects an empty or secret-bearing clientId, and accepts ${env:VAR}", () => {
    const message = "oauth.google.clientId: must be a non-empty string; a client id is not a secret (use ${env:VAR} for a per-machine value)";
    for (const clientId of ["", "   ", 42, undefined, "${secret:google-client-id}", "id-${secret:x}"]) {
      expectRejected(withLogin("google", { clientId }), message);
    }
    expect(defineConnector(withLogin("google", { clientId: "${env:GOOGLE_CLIENT_ID}" })).oauth.google!.clientId).toBe(
      "${env:GOOGLE_CLIENT_ID}",
    );
  });

  it("accepts a clientSecret only as exactly one ${secret:NAME} reference", () => {
    const message =
      "oauth.google.clientSecret: must be a ${secret:NAME} reference (a literal secret is never written into a connector config)";
    for (const clientSecret of [
      "GOCSPX-literal-value",
      "",
      42,
      "${secret:a} ${secret:b}",
      "prefix-${secret:google-client-secret}",
      "${secret:google-client-secret}-suffix",
      "${secret:-bad}",
      "${secret:has space}",
      `\${secret:${"a".repeat(65)}}`,
      "${env:GOOGLE_CLIENT_SECRET}",
    ]) {
      expectRejected(withLogin("google", { clientSecret }), message);
    }
    expect(defineConnector(withLogin("google", { clientSecret: undefined })).oauth.google!.clientSecret).toBeUndefined();
    expect(defineConnector(withLogin("google", { clientSecret: "${secret:g.secret_1}" })).oauth.google!.clientSecret).toBe(
      "${secret:g.secret_1}",
    );
  });

  it("requires at least one non-empty scope string", () => {
    const message = "oauth.google.scopes: at least one scope string is required";
    for (const scopes of [undefined, [], ["openid", ""], ["openid", "  "], "openid", [1], [null]]) {
      expectRejected(withLogin("google", { scopes }), message);
    }
  });

  it("rejects a flow or tokenEndpointAuth outside its union", () => {
    expectRejected(withLogin("google", { flow: "browser" }), "oauth.google.flow: expected auto | loopback | device");
    expectRejected(withLogin("google", { flow: 1 }), "oauth.google.flow: expected auto | loopback | device");
    expectRejected(
      withLogin("google", { tokenEndpointAuth: "basic" }),
      "oauth.google.tokenEndpointAuth: expected client_secret_post | client_secret_basic | none",
    );
    for (const flow of ["auto", "loopback", "device"]) {
      expect(defineConnector(withLogin("google", { flow })).oauth.google!.flow).toBe(flow);
    }
  });

  it("requires redirectPort to be an integer in 1024..65535", () => {
    const message = "oauth.google.redirectPort: expected an integer in 1024..65535";
    for (const redirectPort of [80, 1023, 65536, 70000, 1024.5, "8080", -1, Number.NaN]) {
      expectRejected(withLogin("google", { redirectPort }), message);
    }
    expect(defineConnector(withLogin("google", { redirectPort: 1024 })).oauth.google!.redirectPort).toBe(1024);
    expect(defineConnector(withLogin("google", { redirectPort: 65535 })).oauth.google!.redirectPort).toBe(65535);
  });

  it('requires redirectPath to start with "/"', () => {
    const message = 'oauth.google.redirectPath: must start with "/"';
    for (const redirectPath of ["callback", "", 7]) {
      expectRejected(withLogin("google", { redirectPath }), message);
    }
    expect(defineConnector(withLogin("google", { redirectPath: "/oauth/cb" })).oauth.google!.redirectPath).toBe("/oauth/cb");
  });

  it("requires a generic login to name an issuer or both endpoints", () => {
    const message = 'oauth.idp: provider "generic" needs issuer, or authorizationEndpoint and tokenEndpoint';
    const generic = { provider: "generic", clientId: "cli", clientSecret: undefined, scopes: ["read"] };
    expectRejected(withLogin("idp", generic), message);
    expectRejected(withLogin("idp", { ...generic, authorizationEndpoint: "https://idp.example.com/authorize" }), message);
    expectRejected(withLogin("idp", { ...generic, tokenEndpoint: "https://idp.example.com/token" }), message);
    expect(defineConnector(withLogin("idp", { ...generic, issuer: "https://idp.example.com" })).oauth.idp!.issuer).toBe(
      "https://idp.example.com",
    );
    const explicit = defineConnector(
      withLogin("idp", {
        ...generic,
        authorizationEndpoint: "https://idp.example.com/authorize",
        tokenEndpoint: "https://idp.example.com/token",
      }),
    );
    expect(explicit.oauth.idp!.tokenEndpoint).toBe("https://idp.example.com/token");
  });

  it("requires https on every endpoint and the issuer, allowing http only on 127.0.0.1 / localhost", () => {
    const fields = ["issuer", "authorizationEndpoint", "tokenEndpoint", "deviceAuthorizationEndpoint", "revocationEndpoint"] as const;
    for (const field of fields) {
      for (const value of ["http://idp.example.com/x", "http://10.0.0.1/x", "ftp://idp.example.com/x", "idp.example.com", "", 5]) {
        expectRejected(withLogin("google", { [field]: value }), `oauth.google.${field}: must be an https URL`);
      }
      const ok = defineConnector(
        withLogin("google", { [field]: field === "issuer" ? "http://127.0.0.1:8080" : "http://localhost:8080/oauth" }),
      );
      expect(ok.oauth.google![field]).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):8080/);
    }
  });

  it("requires storeAs to be a valid secret name", () => {
    for (const storeAs of ["has space", "-leading", "a".repeat(65), ""]) {
      expectRejected(withLogin("google", { storeAs }), `oauth.google.storeAs: "${storeAs}" is not a valid secret name`);
    }
    expectRejected(withLogin("google", { storeAs: 3 }), 'oauth.google.storeAs: "3" is not a valid secret name');
    expect(defineConnector(withLogin("google", { storeAs: "google.rt_1" })).oauth.google!.storeAs).toBe("google.rt_1");
  });

  it("checks the shape of pkce, extraAuthorizationParams, options and the preset-specific options", () => {
    expectRejected(withLogin("google", { pkce: "yes" }), "oauth.google.pkce: must be a boolean");
    expectRejected(
      withLogin("google", { extraAuthorizationParams: { access_type: 1 } }),
      "oauth.google.extraAuthorizationParams: must be an object of string values",
    );
    expectRejected(withLogin("google", { extraAuthorizationParams: ["x"] }), "oauth.google.extraAuthorizationParams: must be an object of string values");
    expectRejected(withLogin("google", { options: "eu" }), "oauth.google.options: must be an object of string values");
    const posthog = { provider: "posthog", clientId: "https://seo-mcp.example.com/oauth-client", clientSecret: undefined, scopes: ["query:read"] };
    expectRejected(withLogin("ph", { ...posthog, options: { region: "asia" } }), "oauth.ph.options.region: expected us | eu");
    expect(defineConnector(withLogin("ph", { ...posthog, options: { region: "us" } })).oauth.ph!.options).toEqual({ region: "us" });
    const microsoft = { provider: "microsoft", clientId: "app-id", clientSecret: undefined, scopes: ["offline_access", "User.Read"] };
    expectRejected(withLogin("ms", { ...microsoft, options: { tenant: " " } }), "oauth.ms.options.tenant: must be a non-empty string");
    expect(defineConnector(withLogin("ms", { ...microsoft, options: { tenant: "organizations" } })).oauth.ms!.options).toEqual({
      tenant: "organizations",
    });
  });
});

describe("registry round trip", () => {
  const SAVED = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  };
  let tmp: string;
  let modulePath: string;

  beforeEach(() => {
    tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "ac-oauth-reg-")));
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.AGENT_CONNECTOR_DATA_DIR = join(tmp, "data");
    modulePath = join(tmp, "agent-connector.config.mjs");
    writeFileSync(modulePath, "export default {};\n", "utf8");
  });

  afterEach(() => {
    process.env.HOME = SAVED.HOME;
    process.env.USERPROFILE = SAVED.USERPROFILE;
    if (SAVED.DATA_DIR === undefined) delete process.env.AGENT_CONNECTOR_DATA_DIR;
    else process.env.AGENT_CONNECTOR_DATA_DIR = SAVED.DATA_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("persists the normalized logins verbatim (references only) and reads them back", () => {
    const resolved = defineConnector(withLogin("google", { redirectPort: 51001 }));
    const recordPath = registerConnector(resolved, modulePath, "user");
    const raw = readFileSync(recordPath, "utf8");
    expect(JSON.parse(raw).oauth).toEqual(resolved.oauth);
    expect(raw).toContain("${secret:google-client-secret}");
    const meta = readRegisteredMeta("seo-mcp")!;
    expect(meta.oauth).toEqual(resolved.oauth);
    expect(connectorFromMeta(meta).oauth).toEqual(resolved.oauth);
  });

  it("writes oauth: {} for a connector without logins and reads {} from a record written without the key", () => {
    const resolved = defineConnector({ id: "seo-mcp", server: STDIO });
    const recordPath = registerConnector(resolved, modulePath);
    expect(JSON.parse(readFileSync(recordPath, "utf8")).oauth).toEqual({});
    expect(readRegisteredMeta("seo-mcp")!.oauth).toEqual({});

    const legacy = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    delete legacy.oauth;
    writeFileSync(recordPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    expect(readFileSync(recordPath, "utf8")).not.toContain('"oauth"');
    const meta = readRegisteredMeta("seo-mcp")!;
    expect(meta.oauth).toEqual({});
    expect(connectorFromMeta(meta).oauth).toEqual({});
  });
});
