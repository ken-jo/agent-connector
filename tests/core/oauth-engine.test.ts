/**
 * core/oauth — the login engine against a mock authorization server.
 *
 * Loopback (authorization code + PKCE over 127.0.0.1) and device (RFC 8628)
 * logins, refresh with rotation, the per-process access-token cache and its
 * 60 s skew, the interactive rules, `invalid_grant` clearing a dead token,
 * discovery order, provider error mapping, logout with revocation, status,
 * and the browser helpers through their seams. Every test runs on a
 * throwaway data root with the file secret backend; no provider is contacted.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OAuthError,
  OAuthLoginRequiredError,
  canOpenBrowser,
  createPkcePair,
  discoverEndpoints,
  getAccessToken,
  getOAuthPreset,
  login,
  loginStatus,
  logout,
  metadataPath,
  openBrowser,
  resolveLogin,
} from "../../src/core/oauth/index.js";
import type { ResolvedOAuthLoginDef } from "../../src/core/oauth/index.js";
import { SecretResolutionError, openSecretStore } from "../../src/core/secrets.js";
import type { OpenSecretStoreOptions } from "../../src/core/secrets.js";
import { startMockOAuthServer } from "../support/mock-oauth-server.js";
import type { MockOAuthServer, MockOAuthServerOptions } from "../support/mock-oauth-server.js";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  BACKEND: process.env.AGENT_CONNECTOR_SECRETS_BACKEND,
};

/** The process env every engine call sees: a browser can always be "opened" (the seam decides). */
const ENV: NodeJS.ProcessEnv = { AGENT_CONNECTOR_SECRETS_BACKEND: "file", AGENT_CONNECTOR_BROWSER: "always" };
const NO_BROWSER_ENV: NodeJS.ProcessEnv = { AGENT_CONNECTOR_SECRETS_BACKEND: "file", AGENT_CONNECTOR_BROWSER: "never" };

let tmp: string;
let servers: MockOAuthServer[] = [];
let ids = 0;

beforeEach(() => {
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "ac-oauth-")));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(tmp, "data");
  process.env.AGENT_CONNECTOR_SECRETS_BACKEND = "file";
});

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  process.env.HOME = SAVED.HOME;
  process.env.USERPROFILE = SAVED.USERPROFILE;
  for (const [key, value] of [
    ["AGENT_CONNECTOR_DATA_DIR", SAVED.DATA_DIR],
    ["AGENT_CONNECTOR_SECRETS_BACKEND", SAVED.BACKEND],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function mock(options: MockOAuthServerOptions = {}): Promise<MockOAuthServer> {
  const server = await startMockOAuthServer(options);
  servers.push(server);
  return server;
}

/** A fresh connector id per test: the access-token cache is keyed by connector id + login key. */
function connectorId(): string {
  ids += 1;
  return `acme-${ids}`;
}

function storeOpts(id: string): OpenSecretStoreOptions {
  return { connectorId: id, dataRoot: join(tmp, "data"), backend: "file", env: ENV };
}

const CLIENT_SECRET_NAME = "acme-client-secret";

/** A generic login pointing at `server`; `withSecret` stores the mock's client secret and references it. */
function loginDef(
  server: MockOAuthServer,
  id: string,
  withSecret: boolean,
  overrides: Partial<ResolvedOAuthLoginDef> = {},
): ResolvedOAuthLoginDef {
  if (withSecret) openSecretStore(storeOpts(id)).set(CLIENT_SECRET_NAME, server.clientSecret);
  return {
    key: "idp",
    provider: "generic",
    clientId: server.clientId,
    ...(withSecret ? { clientSecret: `\${secret:${CLIENT_SECRET_NAME}}` } : {}),
    scopes: ["read", "write"],
    authorizationEndpoint: server.authorizationEndpoint,
    tokenEndpoint: server.tokenEndpoint,
    deviceAuthorizationEndpoint: server.deviceAuthorizationEndpoint,
    revocationEndpoint: server.revocationEndpoint,
    flow: "auto",
    redirectPath: "/callback",
    storeAs: "oauth.idp.refresh-token",
    ...overrides,
  };
}

/**
 * The browser seam: GET the authorization URL without following redirects,
 * then hit the loopback redirect a moment later (after the engine is waiting
 * for it). `tamper` edits the redirect before it is followed.
 */
function fakeBrowser(tamper?: (target: URL) => void): { open: (url: string) => Promise<void>; page: Promise<Response> } {
  let settle!: (r: Promise<Response>) => void;
  const page = new Promise<Response>((resolve, reject) => {
    settle = (p) => p.then(resolve, reject);
  });
  return {
    page,
    async open(url) {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status !== 302) throw new Error(`authorize answered ${res.status}`);
      const target = new URL(res.headers.get("location")!);
      tamper?.(target);
      setTimeout(() => settle(fetch(target)), 10);
    },
  };
}

function tokenRequests(server: MockOAuthServer) {
  return server.requests.filter((r) => r.method === "POST" && r.path === "/token");
}

const LEAK_MARKERS = ["mock-access-", "mock-refresh-", "mock-code-", "mock-device-", "mock-client-secret"];
function expectNoLeak(text: string): void {
  for (const marker of LEAK_MARKERS) expect(text).not.toContain(marker);
}

describe("createPkcePair / metadataPath", () => {
  it("makes an RFC 7636 verifier and its S256 challenge, fresh every time", () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier, "ascii").digest("base64url"));
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it("places the metadata record under <dataRoot>/oauth/<connectorId>.json", () => {
    expect(metadataPath("/data", "seo-mcp")).toBe(join("/data", "oauth", "seo-mcp.json"));
  });
});

describe("login — loopback", () => {
  it("runs authorization code + PKCE over 127.0.0.1, stores the refresh token, writes a token-free record", async () => {
    const server = await mock({ pkce: true, clientAuth: "post" });
    const id = connectorId();
    const def = loginDef(server, id, true);
    const browser = fakeBrowser();
    const log: string[] = [];

    const result = await login({ connectorId: id, key: "idp", def, env: ENV, secretStore: storeOpts(id), openBrowser: browser.open, log: (l) => log.push(l) });

    expect(result).toEqual({ key: "idp", provider: "generic", obtainedVia: "loopback", backend: "file", scope: "read write", expiresAt: expect.any(Number) });
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(server.tokensIssued).toHaveLength(1);
    const issued = server.tokensIssued[0]!;
    expect(openSecretStore(storeOpts(id)).get("oauth.idp.refresh-token")).toBe(issued.refreshToken);

    // The browser saw the sign-in page after the exchange.
    const page = await browser.page;
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Signed in — you can close this window.");

    // The authorization request: RFC 6749 §4.1.1 + RFC 7636 §4.3.
    const authorize = server.requests.find((r) => r.path === "/authorize")!;
    expect(authorize.query.response_type).toBe("code");
    expect(authorize.query.client_id).toBe(server.clientId);
    expect(authorize.query.scope).toBe("read write");
    expect(authorize.query.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(authorize.query.state!.length).toBeGreaterThanOrEqual(22);
    expect(authorize.query.code_challenge_method).toBe("S256");
    expect(authorize.query.code_challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);

    // The token request: same redirect_uri, the verifier, the secret in the body (client_secret_post).
    const [exchange] = tokenRequests(server);
    expect(exchange!.body).toMatchObject({
      grant_type: "authorization_code",
      redirect_uri: authorize.query.redirect_uri,
      client_id: server.clientId,
      client_secret: server.clientSecret,
    });
    expect(exchange!.body.code).toMatch(/^mock-code-/);
    expect(createHash("sha256").update(exchange!.body.code_verifier!, "ascii").digest("base64url")).toBe(authorize.query.code_challenge);

    // The non-secret record: 0600, names the login, carries no token.
    const recordPath = metadataPath(join(tmp, "data"), id);
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    const raw = readFileSync(recordPath, "utf8");
    expectNoLeak(raw);
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      connectorId: id,
      logins: {
        idp: {
          provider: "generic",
          scope: "read write",
          obtainedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          obtainedVia: "loopback",
          expiresAt: result.expiresAt,
          storeAs: "oauth.idp.refresh-token",
          backend: "file",
        },
      },
    });

    // The opener took the URL, so the engine printed nothing (the CLI announces the browser itself).
    expect(log).toEqual([]);

    // The access token is cached for the process: no second request.
    const set = await getAccessToken({ connectorId: id, key: "idp", def, interactive: "never", env: ENV, secretStore: storeOpts(id) });
    expect(set).toEqual({ accessToken: issued.accessToken, tokenType: "Bearer", expiresAt: result.expiresAt, scope: "read write" });
    expect(tokenRequests(server)).toHaveLength(1);
  });

  it("sends the secret as HTTP Basic for client_secret_basic and nothing but client_id for a public client", async () => {
    const basic = await mock({ clientAuth: "basic" });
    const id1 = connectorId();
    await login({
      connectorId: id1,
      key: "idp",
      def: loginDef(basic, id1, true, { tokenEndpointAuth: "client_secret_basic", pkce: false }),
      env: ENV,
      secretStore: storeOpts(id1),
      openBrowser: fakeBrowser().open,
      log: () => {},
    });
    const [viaBasic] = tokenRequests(basic);
    const expected = Buffer.from(`${encodeURIComponent(basic.clientId)}:${encodeURIComponent(basic.clientSecret)}`).toString("base64");
    expect(viaBasic!.headers.authorization).toBe(`Basic ${expected}`);
    expect(viaBasic!.body.client_secret).toBeUndefined();
    expect(basic.tokensIssued).toHaveLength(1);

    const pub = await mock({ clientAuth: "none", pkce: true });
    const id2 = connectorId();
    const def = loginDef(pub, id2, false);
    const resolved = await resolveLogin(def, { connectorId: id2, env: ENV, secretStore: storeOpts(id2) });
    expect(resolved.tokenEndpointAuth).toBe("none");
    expect(resolved.clientSecret).toBeUndefined();
    await login({ connectorId: id2, key: "idp", def, env: ENV, secretStore: storeOpts(id2), openBrowser: fakeBrowser().open, log: () => {} });
    const [viaNone] = tokenRequests(pub);
    expect(viaNone!.body.client_id).toBe(pub.clientId);
    expect(viaNone!.body.client_secret).toBeUndefined();
    expect(viaNone!.headers.authorization).toBeUndefined();
    expect(pub.tokensIssued).toHaveLength(1);
  });

  it("rejects a callback whose state does not match and exchanges nothing", async () => {
    const server = await mock({ pkce: true });
    const id = connectorId();
    const browser = fakeBrowser((target) => target.searchParams.set("state", "forged"));
    const err = await login({ connectorId: id, key: "idp", def: loginDef(server, id, true), env: ENV, secretStore: storeOpts(id), openBrowser: browser.open, log: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("authorization");
    expect((err as OAuthError).message).toContain("unexpected state");
    const page = await browser.page;
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("unexpected state");
    expect(tokenRequests(server)).toHaveLength(0);
    expect(openSecretStore(storeOpts(id)).has("oauth.idp.refresh-token")).toBe(false);
    expect(existsSync(metadataPath(join(tmp, "data"), id))).toBe(false);
  });

  it("surfaces access_denied from the authorization response as an authorization error", async () => {
    const server = await mock({ deny: true });
    const id = connectorId();
    const err = await login({ connectorId: id, key: "idp", def: loginDef(server, id, true), env: ENV, secretStore: storeOpts(id), openBrowser: fakeBrowser().open, log: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("authorization");
    expect((err as OAuthError).message).toContain("access_denied");
    expect(tokenRequests(server)).toHaveLength(0);
  });

  it("fails with the preset's hint when the provider returns no refresh token, storing nothing", async () => {
    const server = await mock({ issueRefreshToken: false });
    const id = connectorId();
    const err = await login({ connectorId: id, key: "idp", def: loginDef(server, id, true), env: ENV, secretStore: storeOpts(id), openBrowser: fakeBrowser().open, log: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("token");
    expect((err as OAuthError).message).toBe(`the provider returned no refresh token — ${getOAuthPreset("generic").refreshTokenHint}`);
    expect(openSecretStore(storeOpts(id)).has("oauth.idp.refresh-token")).toBe(false);
    expect(existsSync(metadataPath(join(tmp, "data"), id))).toBe(false);
  });

  it("maps a token-endpoint error to OAuthError(provider) with error + error_description and no secret", async () => {
    const server = await mock({ clientAuth: "post" });
    const id = connectorId();
    const def = loginDef(server, id, true);
    openSecretStore(storeOpts(id)).set(CLIENT_SECRET_NAME, "not-the-registered-secret");
    const err = await login({ connectorId: id, key: "idp", def, env: ENV, secretStore: storeOpts(id), openBrowser: fakeBrowser().open, log: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("provider");
    expect((err as OAuthError).providerCode).toBe("invalid_client");
    expect((err as OAuthError).message).toBe("token exchange failed: invalid_client — client authentication failed");
    expect((err as OAuthError).message).not.toContain("not-the-registered-secret");
    expectNoLeak((err as OAuthError).message);
  });

  it("times out when nobody completes the authorization, and prints the URL when no browser can open", async () => {
    const server = await mock({ autoApprove: false });
    const id = connectorId();
    const log: string[] = [];
    const err = await login({
      connectorId: id,
      key: "idp",
      def: loginDef(server, id, true, { deviceAuthorizationEndpoint: undefined }),
      env: NO_BROWSER_ENV,
      secretStore: storeOpts(id),
      openBrowser: () => {
        throw new Error("the seam must not be called when no browser can open");
      },
      log: (l) => log.push(l),
      loginTimeoutMs: 300,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("timeout");
    expect(log.some((l) => l.startsWith(`Authorize OAuth 2.0 provider at: ${server.authorizationEndpoint}?`))).toBe(true);
  });

  it("prints the URL and keeps waiting when the opener fails, so the login can be finished by hand", async () => {
    const server = await mock({ pkce: true });
    const id = connectorId();
    const log: string[] = [];
    const browser = fakeBrowser();
    const pending = login({
      connectorId: id,
      key: "idp",
      def: loginDef(server, id, true),
      env: ENV,
      secretStore: storeOpts(id),
      openBrowser: () => {
        throw new Error("no opener on this box");
      },
      log: (l) => log.push(l),
    });
    for (let i = 0; log.length === 0 && i < 200; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^Could not open a browser \(no opener on this box\)\. Authorize OAuth 2\.0 provider at: http:\/\/127\.0\.0\.1:\d+\/authorize\?/);
    expectNoLeak(log[0]!);
    // The user opens the printed URL: the same flow completes.
    await browser.open(log[0]!.slice(log[0]!.indexOf("http://")));
    const result = await pending;
    expect(result.obtainedVia).toBe("loopback");
    expect(await (await browser.page).text()).toContain("Signed in — you can close this window.");
    expect(log).toHaveLength(1);
    expect(openSecretStore(storeOpts(id)).get("oauth.idp.refresh-token")).toBe(server.tokensIssued[0]!.refreshToken);
  });

  it("refuses the loopback flow with a fixed redirectPort that is in use, without a shell or a token", async () => {
    const server = await mock();
    const id = connectorId();
    const taken = await mock();
    const port = Number(new URL(taken.url).port);
    const err = await login({ connectorId: id, key: "idp", def: loginDef(server, id, true, { redirectPort: port, flow: "loopback" }), env: ENV, secretStore: storeOpts(id), openBrowser: fakeBrowser().open, log: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("config");
    expect((err as OAuthError).message).toContain(`127.0.0.1:${port}`);
  });
});

describe("login — device", () => {
  it("prompts with the user code, honors interval and slow_down, and stores the refresh token", async () => {
    const server = await mock({ deviceSequence: ["authorization_pending", "slow_down", "ok"], deviceInterval: 2 });
    const id = connectorId();
    const log: string[] = [];
    const sleeps: number[] = [];
    const result = await login({
      connectorId: id,
      key: "idp",
      def: loginDef(server, id, true, { flow: "device" }),
      env: ENV,
      secretStore: storeOpts(id),
      openBrowser: () => {
        throw new Error("device flow opens no browser");
      },
      log: (l) => log.push(l),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result).toMatchObject({ key: "idp", provider: "generic", obtainedVia: "device", backend: "file", scope: "read write" });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(new RegExp(`^Visit ${server.url}/device and enter code [A-F0-9]{4}-[A-F0-9]{4}$`));
    expectNoLeak(log[0]!);
    // RFC 8628 §3.5: the interval, then five more seconds after slow_down.
    expect(sleeps).toEqual([2000, 2000, 7000]);
    const auth = server.requests.find((r) => r.path === "/device_authorization")!;
    expect(auth.body).toMatchObject({ client_id: server.clientId, client_secret: server.clientSecret, scope: "read write" });
    const polls = tokenRequests(server);
    expect(polls).toHaveLength(3);
    for (const poll of polls) {
      expect(poll.body.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
      expect(poll.body.device_code).toMatch(/^mock-device-/);
    }
    expect(openSecretStore(storeOpts(id)).get("oauth.idp.refresh-token")).toBe(server.tokensIssued[0]!.refreshToken);
    expect(JSON.parse(readFileSync(metadataPath(join(tmp, "data"), id), "utf8")).logins.idp.obtainedVia).toBe("device");
  });

  it("uses verification_uri_complete when the provider gives one", async () => {
    const server = await mock({ verificationUriComplete: true });
    const id = connectorId();
    const log: string[] = [];
    await login({ connectorId: id, key: "idp", def: loginDef(server, id, true, { flow: "device" }), env: ENV, secretStore: storeOpts(id), log: (l) => log.push(l), sleep: async () => {} });
    expect(log[0]).toMatch(new RegExp(`^Visit ${server.url}/device\\?user_code=[A-F0-9]{4}-[A-F0-9]{4} to authorize \\(code [A-F0-9]{4}-[A-F0-9]{4}\\)$`));
  });

  it("stops on access_denied and expired_token", async () => {
    for (const [step, code] of [
      ["access_denied", "authorization"],
      ["expired_token", "timeout"],
    ] as const) {
      const server = await mock({ deviceSequence: ["authorization_pending", step] });
      const id = connectorId();
      const err = await login({ connectorId: id, key: "idp", def: loginDef(server, id, true, { flow: "device" }), env: ENV, secretStore: storeOpts(id), log: () => {}, sleep: async () => {} }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).code).toBe(code);
      expect(tokenRequests(server)).toHaveLength(2);
      expect(openSecretStore(storeOpts(id)).has("oauth.idp.refresh-token")).toBe(false);
    }
  });

  it("auto picks the device grant when no browser can open and the endpoint is known; device is refused without one", async () => {
    const server = await mock();
    const id = connectorId();
    const result = await login({ connectorId: id, key: "idp", def: loginDef(server, id, true), env: NO_BROWSER_ENV, secretStore: storeOpts(id), log: () => {}, sleep: async () => {} });
    expect(result.obtainedVia).toBe("device");

    const id2 = connectorId();
    const err = await login({ connectorId: id2, key: "idp", def: loginDef(server, id2, true, { flow: "device", deviceAuthorizationEndpoint: undefined }), env: ENV, secretStore: storeOpts(id2), log: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("config");
    expect((err as OAuthError).message).toBe("oauth.idp: OAuth 2.0 provider has no device authorization endpoint");
  });
});

describe("getAccessToken", () => {
  it("refreshes with the stored token, stores a rotated one before returning, then serves the cache", async () => {
    const server = await mock({ rotateRefreshTokens: true });
    const id = connectorId();
    const def = loginDef(server, id, true);
    const seeded = server.seedRefreshToken("read write");
    openSecretStore(storeOpts(id)).set("oauth.idp.refresh-token", seeded);

    const first = await getAccessToken({ connectorId: id, key: "idp", def, interactive: "never", env: ENV, secretStore: storeOpts(id) });
    expect(first).toEqual({ accessToken: server.tokensIssued[0]!.accessToken, tokenType: "Bearer", expiresAt: expect.any(Number), scope: "read write" });
    expect(Object.keys(first)).not.toContain("refreshToken");
    const [refresh] = tokenRequests(server);
    expect(refresh!.body).toMatchObject({ grant_type: "refresh_token", refresh_token: seeded, client_id: server.clientId, client_secret: server.clientSecret });
    const rotated = server.tokensIssued[0]!.refreshToken!;
    expect(rotated).not.toBe(seeded);
    expect(openSecretStore(storeOpts(id)).get("oauth.idp.refresh-token")).toBe(rotated);
    expect(server.refreshTokenActive(seeded)).toBe(false);

    const second = await getAccessToken({ connectorId: id, key: "idp", def, interactive: "never", env: ENV, secretStore: storeOpts(id) });
    expect(second).toEqual(first);
    expect(tokenRequests(server)).toHaveLength(1);
  });

  it("keeps the old refresh token when the provider returns none, and re-refreshes inside the 60 s skew", async () => {
    const server = await mock({ accessTokenTtl: 30 });
    const id = connectorId();
    const def = loginDef(server, id, true);
    const seeded = server.seedRefreshToken("read write");
    openSecretStore(storeOpts(id)).set("oauth.idp.refresh-token", seeded);

    const a = await getAccessToken({ connectorId: id, key: "idp", def, interactive: "never", env: ENV, secretStore: storeOpts(id) });
    const b = await getAccessToken({ connectorId: id, key: "idp", def, interactive: "never", env: ENV, secretStore: storeOpts(id) });
    expect(a.accessToken).not.toBe(b.accessToken);
    expect(tokenRequests(server)).toHaveLength(2);
    expect(openSecretStore(storeOpts(id)).get("oauth.idp.refresh-token")).toBe(seeded);
  });

  it("throws OAuthLoginRequiredError with the exact message when nothing is stored and login is not allowed", async () => {
    const server = await mock();
    const id = connectorId();
    const def = loginDef(server, id, true);
    for (const env of [ENV, NO_BROWSER_ENV]) {
      const err = await getAccessToken({ connectorId: id, key: "idp", def, interactive: "never", env, secretStore: storeOpts(id) }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OAuthLoginRequiredError);
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthLoginRequiredError).code).toBe("login-required");
      expect((err as OAuthLoginRequiredError).message).toBe(`login "idp" is not present for connector ${id} — run \`auth login idp --connector-id ${id}\``);
      expect((err as OAuthLoginRequiredError).connectorId).toBe(id);
      expect((err as OAuthLoginRequiredError).key).toBe("idp");
      expect((err as OAuthLoginRequiredError).command).toBe(`auth login idp --connector-id ${id}`);
    }
    // "auto" without a browser: the same error; the provider is never contacted.
    const auto = await getAccessToken({ connectorId: id, key: "idp", def, env: NO_BROWSER_ENV, secretStore: storeOpts(id) }).catch((e: unknown) => e);
    expect(auto).toBeInstanceOf(OAuthLoginRequiredError);
    expect(server.requests).toHaveLength(0);
  });

  it("logs in lazily under interactive auto when a browser can open, and always under interactive always", async () => {
    const server = await mock({ pkce: true });
    const id = connectorId();
    const def = loginDef(server, id, true);
    const set = await getAccessToken({ connectorId: id, key: "idp", def, env: ENV, secretStore: storeOpts(id), openBrowser: fakeBrowser().open, log: () => {} });
    expect(set.accessToken).toBe(server.tokensIssued[0]!.accessToken);
    expect(openSecretStore(storeOpts(id)).get("oauth.idp.refresh-token")).toBe(server.tokensIssued[0]!.refreshToken);
    expect(server.tokensIssued[0]!.grant).toBe("authorization_code");

    const again = await getAccessToken({ connectorId: id, key: "idp", def, interactive: "always", env: ENV, secretStore: storeOpts(id), openBrowser: fakeBrowser().open, log: () => {} });
    expect(server.tokensIssued).toHaveLength(2);
    expect(server.tokensIssued[1]!.grant).toBe("authorization_code");
    expect(again.accessToken).toBe(server.tokensIssued[1]!.accessToken);
  });

  it("clears a refresh token the provider rejects with invalid_grant, stamps revokedAt, then applies the interactive rule", async () => {
    // A 30 s access token is inside the 60 s skew, so the next call must refresh.
    const good = await mock({ accessTokenTtl: 30 });
    const id = connectorId();
    await login({ connectorId: id, key: "idp", def: loginDef(good, id, true), env: ENV, secretStore: storeOpts(id), openBrowser: fakeBrowser().open, log: () => {} });
    const stored = openSecretStore(storeOpts(id)).get("oauth.idp.refresh-token")!;

    const bad = await mock({ rejectRefresh: true });
    const dead = loginDef(bad, id, true);
    const err = await getAccessToken({ connectorId: id, key: "idp", def: dead, interactive: "never", env: ENV, secretStore: storeOpts(id) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthLoginRequiredError);
    const [refresh] = tokenRequests(bad);
    expect(refresh!.body).toMatchObject({ grant_type: "refresh_token", refresh_token: stored });
    expect(openSecretStore(storeOpts(id)).has("oauth.idp.refresh-token")).toBe(false);
    const record = JSON.parse(readFileSync(metadataPath(join(tmp, "data"), id), "utf8"));
    expect(record.logins.idp.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record.logins.idp.obtainedVia).toBe("loopback");
    expectNoLeak(JSON.stringify(record));
    expect(loginStatus({ connectorId: id, logins: { idp: dead }, secretStore: storeOpts(id) })).toEqual([
      expect.objectContaining({ key: "idp", present: false, revokedAt: record.logins.idp.revokedAt }),
    ]);

    // With a browser, "auto" runs a fresh login; the new record carries no revokedAt.
    const set = await getAccessToken({ connectorId: id, key: "idp", def: dead, env: ENV, secretStore: storeOpts(id), openBrowser: fakeBrowser().open, log: () => {} });
    expect(bad.tokensIssued).toEqual([expect.objectContaining({ grant: "authorization_code", accessToken: set.accessToken })]);
    expect(openSecretStore(storeOpts(id)).get("oauth.idp.refresh-token")).toBe(bad.tokensIssued[0]!.refreshToken);
    expect(JSON.parse(readFileSync(metadataPath(join(tmp, "data"), id), "utf8")).logins.idp.revokedAt).toBeUndefined();
  });

  it("needs a login definition: an unregistered connector without def is a config error", async () => {
    const err = await getAccessToken({ connectorId: "never-registered", key: "idp", interactive: "never", env: ENV, secretStore: storeOpts("never-registered") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("config");
    expect((err as OAuthError).message).toContain("never-registered is not registered");
  });
});

describe("discovery and resolution", () => {
  it("tries oauth-authorization-server before openid-configuration and caches the result per process", async () => {
    const rfc = await mock({ oidc: true });
    const endpoints = await discoverEndpoints(rfc.issuer);
    expect(endpoints).toEqual({
      authorizationEndpoint: rfc.authorizationEndpoint,
      tokenEndpoint: rfc.tokenEndpoint,
      deviceAuthorizationEndpoint: rfc.deviceAuthorizationEndpoint,
      revocationEndpoint: rfc.revocationEndpoint,
    });
    expect(rfc.requests.map((r) => r.path)).toEqual(["/.well-known/oauth-authorization-server"]);
    await discoverEndpoints(`${rfc.issuer}/`);
    expect(rfc.requests).toHaveLength(1);

    const oidc = await mock({ oauthMetadata: false, oidc: true, advertiseDevice: false });
    const fromOidc = await discoverEndpoints(oidc.issuer);
    expect(fromOidc.deviceAuthorizationEndpoint).toBeUndefined();
    expect(fromOidc.tokenEndpoint).toBe(oidc.tokenEndpoint);
    expect(oidc.requests.map((r) => r.path)).toEqual(["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]);

    const tenant = await mock({ issuerPath: "/tenant-a" });
    await discoverEndpoints(tenant.issuer);
    expect(tenant.requests.map((r) => r.path)).toEqual(["/.well-known/oauth-authorization-server/tenant-a"]);

    const none = await mock({ oauthMetadata: false });
    const err = await discoverEndpoints(none.issuer).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("discovery");
    expect((err as OAuthError).hint).toContain("authorizationEndpoint and tokenEndpoint");
  });

  it("resolves preset → login overrides → discovery, expands ${env:} in clientId, reads the secret from the store", async () => {
    const server = await mock({ clientId: "env-client" });
    const id = connectorId();
    openSecretStore(storeOpts(id)).set(CLIENT_SECRET_NAME, server.clientSecret);
    const def: ResolvedOAuthLoginDef = {
      key: "idp",
      provider: "generic",
      clientId: "${env:IDP_CLIENT_ID}",
      clientSecret: `\${secret:${CLIENT_SECRET_NAME}}`,
      scopes: ["a", "b"],
      issuer: server.issuer,
      flow: "auto",
      redirectPath: "/callback",
      storeAs: "oauth.idp.refresh-token",
    };
    const resolved = await resolveLogin(def, { connectorId: id, env: { ...ENV, IDP_CLIENT_ID: "env-client" }, secretStore: storeOpts(id) });
    expect(resolved.clientId).toBe("env-client");
    expect(resolved.clientSecret).toBe(server.clientSecret);
    expect(resolved.endpoints).toEqual({
      authorizationEndpoint: server.authorizationEndpoint,
      tokenEndpoint: server.tokenEndpoint,
      deviceAuthorizationEndpoint: server.deviceAuthorizationEndpoint,
      revocationEndpoint: server.revocationEndpoint,
    });
    expect(resolved.pkce).toBe(true);
    expect(resolved.tokenEndpointAuth).toBe("client_secret_post");
    expect(resolved.scope).toBe("a b");
    expect(resolved.preset.id).toBe("generic");

    const idMissing = connectorId();
    const missing = await resolveLogin(def, { connectorId: idMissing, env: { ...ENV, IDP_CLIENT_ID: "env-client" }, secretStore: storeOpts(idMissing) }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(SecretResolutionError);
    expect((missing as SecretResolutionError).missing).toEqual([CLIENT_SECRET_NAME]);
  });
});

describe("logout and status", () => {
  it("revokes at the provider, removes the secret and the record, and reports both", async () => {
    const server = await mock({ clientAuth: "post" });
    const id = connectorId();
    const def = loginDef(server, id, true);
    await login({ connectorId: id, key: "idp", def, env: ENV, secretStore: storeOpts(id), openBrowser: fakeBrowser().open, log: () => {} });
    const refreshToken = server.tokensIssued[0]!.refreshToken!;

    const before = loginStatus({ connectorId: id, logins: { idp: def }, secretStore: storeOpts(id) });
    expect(before).toEqual([
      { key: "idp", provider: "generic", present: true, backend: "file", obtainedAt: expect.stringMatching(/^\d{4}/), obtainedVia: "loopback", scope: "read write" },
    ]);

    expect(await logout({ connectorId: id, key: "idp", def, env: ENV, secretStore: storeOpts(id) })).toEqual({ removed: true, revoked: true });
    expect(server.revoked).toEqual([refreshToken]);
    const revoke = server.requests.find((r) => r.path === "/revoke")!;
    expect(revoke.body).toMatchObject({ token: refreshToken, token_type_hint: "refresh_token", client_id: server.clientId, client_secret: server.clientSecret });
    expect(openSecretStore(storeOpts(id)).has("oauth.idp.refresh-token")).toBe(false);
    expect(JSON.parse(readFileSync(metadataPath(join(tmp, "data"), id), "utf8")).logins).toEqual({});
    expect(loginStatus({ connectorId: id, logins: { idp: def }, secretStore: storeOpts(id) })).toEqual([{ key: "idp", provider: "generic", present: false }]);

    // The cache is gone too: the next token needs a login.
    const err = await getAccessToken({ connectorId: id, key: "idp", def, interactive: "never", env: ENV, secretStore: storeOpts(id) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthLoginRequiredError);

    expect(await logout({ connectorId: id, key: "idp", def, env: ENV, secretStore: storeOpts(id) })).toEqual({ removed: false, revoked: false });
  });

  it("reports absent logins without touching the network", async () => {
    const server = await mock();
    const id = connectorId();
    const def = loginDef(server, id, false);
    expect(loginStatus({ connectorId: id, logins: { idp: def, other: { ...def, key: "other", storeAs: "oauth.other.refresh-token" } }, secretStore: storeOpts(id) })).toEqual([
      { key: "idp", provider: "generic", present: false },
      { key: "other", provider: "generic", present: false },
    ]);
    expect(server.requests).toHaveLength(0);
  });
});

describe("browser helpers", () => {
  it("canOpenBrowser: the env override, SSH on macOS / Windows, a display on Linux", () => {
    expect(canOpenBrowser({ AGENT_CONNECTOR_BROWSER: "never" }, "darwin")).toBe(false);
    expect(canOpenBrowser({ AGENT_CONNECTOR_BROWSER: "always" }, "linux")).toBe(true);
    expect(canOpenBrowser({}, "darwin")).toBe(true);
    expect(canOpenBrowser({}, "win32")).toBe(true);
    expect(canOpenBrowser({ SSH_CONNECTION: "10.0.0.2 51000 10.0.0.1 22" }, "darwin")).toBe(false);
    expect(canOpenBrowser({ SSH_TTY: "/dev/pts/0" }, "win32")).toBe(false);
    expect(canOpenBrowser({}, "linux")).toBe(false);
    expect(canOpenBrowser({ DISPLAY: ":0" }, "linux")).toBe(true);
    expect(canOpenBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true);
    expect(canOpenBrowser({ DISPLAY: ":0", SSH_CONNECTION: "x" }, "linux")).toBe(true);
    expect(canOpenBrowser({ DISPLAY: ":0" }, "freebsd")).toBe(true);
  });

  it("openBrowser spawns the platform opener detached without a shell, and rejects non-http URLs", async () => {
    const calls: Array<{ file: string; args: string[]; options: unknown }> = [];
    let unrefs = 0;
    const spawnOk = (file: string, args: string[], options: unknown) => {
      calls.push({ file, args, options });
      return {
        once(event: "spawn" | "error", listener: (err?: Error) => void) {
          if (event === "spawn") setImmediate(() => listener());
          return this;
        },
        unref() {
          unrefs += 1;
        },
      };
    };
    const url = "https://accounts.example.com/authorize?client_id=x&state=y";
    await openBrowser(url, { platform: "darwin", spawn: spawnOk });
    await openBrowser(url, { platform: "win32", spawn: spawnOk });
    await openBrowser(url, { platform: "linux", spawn: spawnOk });
    expect(calls.map((c) => [c.file, ...c.args])).toEqual([
      ["open", url],
      ["rundll32", "url.dll,FileProtocolHandler", url],
      ["xdg-open", url],
    ]);
    for (const call of calls) expect(call.options).toEqual({ detached: true, stdio: "ignore" });
    expect(unrefs).toBe(3);

    for (const bad of ["file:///etc/hosts", "javascript:alert(1)", "not a url", "ftp://example.com/x"]) {
      const err = await openBrowser(bad, { platform: "darwin", spawn: spawnOk }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).code).toBe("config");
    }
    expect(calls).toHaveLength(3);

    const spawnFails = () => ({
      once(event: "spawn" | "error", listener: (err?: Error) => void) {
        if (event === "error") setImmediate(() => listener(new Error("ENOENT")));
        return this;
      },
      unref() {},
    });
    const failed = await openBrowser(url, { platform: "linux", spawn: spawnFails }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(OAuthError);
    expect((failed as OAuthError).code).toBe("browser-unavailable");
    expect((failed as OAuthError).message).toContain("xdg-open");
  });
});
