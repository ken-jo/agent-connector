/**
 * tests/core/oauth-hardening — the review findings on the OAuth engine, each
 * pinned by the scenario that exposed it:
 *   concurrent getAccessToken calls share one refresh (a rotating provider
 *   would otherwise revoke the login), invalid_grant removes only the token
 *   that failed, provider numbers are not trusted, oversized responses are
 *   abandoned, extraAuthorizationParams cannot override the binding
 *   parameters, inherited object keys are not logins, and a provider that
 *   never echoes `state` is accepted only for a fixed-port login.
 */

import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import { defineConnector } from "../../src/core/define-connector.js";
import { registerConnector } from "../../src/core/load-connector.js";
import { packageConnector } from "../../src/core/package.js";
import {
  OAuthError,
  OAuthLoginRequiredError,
  RESERVED_AUTHORIZATION_PARAMS,
  buildAuthorizationUrl,
  clearAccessTokenCache,
  clearDiscoveryCache,
  getAccessToken,
  login,
  registeredLoginDef,
  resolveLogin,
} from "../../src/core/oauth/index.js";
import type { ResolvedOAuthLoginDef } from "../../src/core/oauth/index.js";
import { getJson, postForm, readBody } from "../../src/core/oauth/http.js";
import { requestDeviceAuthorization, pollDeviceToken } from "../../src/core/oauth/device.js";
import { startLoopback } from "../../src/core/oauth/loopback.js";
import { openSecretStore } from "../../src/core/secrets.js";
import type { OpenSecretStoreOptions } from "../../src/core/secrets.js";
import { startMockOAuthServer } from "../support/mock-oauth-server.js";
import type { MockOAuthServer, MockOAuthServerOptions } from "../support/mock-oauth-server.js";

const ENV: NodeJS.ProcessEnv = { AGENT_CONNECTOR_SECRETS_BACKEND: "file", AGENT_CONNECTOR_BROWSER: "always" };

let tmp: string;
let servers: MockOAuthServer[] = [];
let ids = 0;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "oauth-hardening-")));
  clearAccessTokenCache();
  clearDiscoveryCache();
});

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  rmSync(tmp, { recursive: true, force: true });
});

async function mock(options: MockOAuthServerOptions = {}): Promise<MockOAuthServer> {
  const server = await startMockOAuthServer(options);
  servers.push(server);
  return server;
}

function connectorId(): string {
  ids += 1;
  return `hard-${ids}`;
}

function storeOpts(id: string): OpenSecretStoreOptions {
  return { connectorId: id, dataRoot: join(tmp, "data"), backend: "file", env: ENV };
}

function loginDef(server: MockOAuthServer, overrides: Partial<ResolvedOAuthLoginDef> = {}): ResolvedOAuthLoginDef {
  return {
    key: "idp",
    provider: "generic",
    clientId: server.clientId,
    scopes: ["read"],
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

/** Follows the authorization redirect like a browser, after the engine is waiting. */
function fakeBrowser(edit?: (target: URL) => void): (url: string) => Promise<void> {
  return async (url) => {
    const res = await fetch(url, { redirect: "manual" });
    if (res.status !== 302) throw new Error(`authorize answered ${res.status}`);
    const target = new URL(res.headers.get("location") as string);
    edit?.(target);
    setTimeout(() => void fetch(target).catch(() => undefined), 10);
  };
}

function refreshRequests(server: MockOAuthServer) {
  return server.requests.filter((r) => r.method === "POST" && r.path === "/token" && r.body.grant_type === "refresh_token");
}

describe("concurrent getAccessToken calls (S1)", () => {
  it("share one refresh under rotation: every caller gets a token and the login survives", async () => {
    const server = await mock({ clientAuth: "none", rotateRefreshTokens: true });
    const id = connectorId();
    const def = loginDef(server);
    const seeded = server.seedRefreshToken("read");
    openSecretStore(storeOpts(id)).set(def.storeAs, seeded);
    const calls = Array.from({ length: 4 }, () =>
      getAccessToken({ connectorId: id, key: "idp", def, interactive: "never", env: ENV, secretStore: storeOpts(id) }),
    );
    const results = await Promise.allSettled(calls);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
    const tokens = new Set(results.map((r) => (r as PromiseFulfilledResult<{ accessToken: string }>).value.accessToken));
    expect(tokens.size).toBe(1);
    expect(refreshRequests(server)).toHaveLength(1);
    const stored = openSecretStore(storeOpts(id)).get(def.storeAs);
    expect(stored).not.toBeNull();
    expect(stored).not.toBe(seeded);
    expect(server.refreshTokenActive(stored as string)).toBe(true);
    // A later call, cache cleared, refreshes again with the rotated token.
    clearAccessTokenCache();
    await getAccessToken({ connectorId: id, key: "idp", def, interactive: "never", env: ENV, secretStore: storeOpts(id) });
    expect(refreshRequests(server)).toHaveLength(2);
  });

  it("interactive: always does not join an in-flight refresh", async () => {
    const server = await mock({ clientAuth: "none" });
    const id = connectorId();
    const def = loginDef(server);
    openSecretStore(storeOpts(id)).set(def.storeAs, server.seedRefreshToken("read"));
    const a = getAccessToken({ connectorId: id, key: "idp", def, interactive: "never", env: ENV, secretStore: storeOpts(id) });
    const b = getAccessToken({
      connectorId: id,
      key: "idp",
      def,
      interactive: "always",
      env: ENV,
      secretStore: storeOpts(id),
      openBrowser: fakeBrowser(),
      log: () => {},
    });
    await Promise.all([a, b]);
    expect(refreshRequests(server)).toHaveLength(1);
    expect(server.requests.filter((r) => r.path === "/authorize")).toHaveLength(1);
  });
});

describe("invalid_grant removes only the token that failed (S4)", () => {
  it("keeps a token another writer stored in the meantime", async () => {
    const rejecting = await mock({ clientAuth: "none", rejectRefresh: true });
    const id = connectorId();
    const def = loginDef(rejecting);
    const store = openSecretStore(storeOpts(id));
    store.set(def.storeAs, "stale-refresh-token");
    // The refresh is answered with invalid_grant; before the engine reacts a
    // second writer has already stored a new token (simulated through fetch).
    const fetchFn: typeof fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const res = await fetch(input, init);
      if (String(input).endsWith("/token")) store.set(def.storeAs, "fresh-refresh-token");
      return res;
    };
    const err = await getAccessToken({
      connectorId: id,
      key: "idp",
      def,
      interactive: "never",
      env: ENV,
      secretStore: storeOpts(id),
      fetch: fetchFn,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthLoginRequiredError);
    expect(store.get(def.storeAs)).toBe("fresh-refresh-token");
  });
});

describe("provider numbers are not trusted (S2)", () => {
  it("falls back to RFC defaults for non-numeric expires_in / interval and clamps a huge interval", async () => {
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    let polls = 0;
    const fetchFn = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/device")) return json({ device_code: "d", user_code: "U", verification_uri: "https://p/d", expires_in: "soon", interval: "later" });
      polls += 1;
      return polls < 3 ? json({ error: "authorization_pending" }, 400) : json({ access_token: "a", token_type: "Bearer" });
    }) as unknown as typeof fetch;
    const client = { clientId: "c", tokenEndpointAuth: "none" as const };
    const auth = await requestDeviceAuthorization("https://p/device", client, "s", { fetch: fetchFn });
    expect(auth.expiresIn).toBe(1800);
    expect(auth.interval).toBe(5);
    const sleeps: number[] = [];
    await pollDeviceToken("https://p/token", client, auth, {
      fetch: fetchFn,
      deadline: Date.now() + 60_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([5000, 5000, 5000]);
    // A poisoned interval on the authorization itself is clamped, never NaN.
    const poisoned = { ...auth, interval: Number.NaN, expiresIn: Number.POSITIVE_INFINITY };
    const sleeps2: number[] = [];
    polls = 0;
    await pollDeviceToken("https://p/token", client, poisoned, {
      fetch: fetchFn,
      deadline: Date.now() + 60_000,
      sleep: async (ms) => {
        sleeps2.push(ms);
      },
    });
    expect(sleeps2).toEqual([5000, 5000, 5000]);
    const big = await requestDeviceAuthorization("https://p/device", client, "s", {
      fetch: (async () => json({ device_code: "d", user_code: "U", verification_uri: "https://p/d", expires_in: 1e12, interval: 1e9 })) as unknown as typeof fetch,
    });
    expect(big.interval).toBe(3600);
    expect(big.expiresIn).toBe(86_400);
  });
});

describe("oversized provider responses are abandoned (S7)", () => {
  it("readBody stops past the cap; postForm / getJson map it to OAuthError(provider)", async () => {
    const srv = createServer((req, res) => {
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "application/json" });
        const chunk = Buffer.alloc(64 * 1024, "a");
        let sent = 0;
        const push = (): void => {
          while (sent < 2 * 1024 * 1024) {
            sent += chunk.length;
            if (!res.write(chunk)) {
              res.once("drain", push);
              return;
            }
          }
          res.end();
        };
        push();
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      }
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      await expect(readBody(await fetch(`${base}/big`), 1024)).rejects.toMatchObject({ code: "provider" });
      await expect(postForm(`${base}/big`, {}, { what: "t" })).rejects.toThrow(/larger than 1048576 bytes/);
      await expect(getJson(`${base}/big`, {})).rejects.toMatchObject({ code: "provider" });
      expect((await getJson(`${base}/small`, {})).body).toEqual({ ok: true });
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("extraAuthorizationParams cannot override the binding parameters (S6)", () => {
  it("the engine keeps redirect_uri, state and the PKCE challenge; defineConnector rejects the names", async () => {
    const server = await mock({ clientAuth: "none" });
    const def = loginDef(server, {
      extraAuthorizationParams: { redirect_uri: "https://evil.example/cb", state: "fixed", code_challenge: "x", prompt: "consent" },
    });
    const resolved = await resolveLogin(def, { connectorId: "hard-x", env: ENV });
    const url = new URL(buildAuthorizationUrl(resolved, { redirectUri: "http://127.0.0.1:1234/callback", state: "real", codeChallenge: "chal" }));
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1234/callback");
    expect(url.searchParams.get("state")).toBe("real");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("prompt")).toBe("consent");
    const noPkce = new URL(buildAuthorizationUrl(resolved, { redirectUri: "http://127.0.0.1:1/cb", state: "s" }));
    expect(noPkce.searchParams.has("code_challenge")).toBe(false);
    for (const name of RESERVED_AUTHORIZATION_PARAMS) {
      expect(() =>
        defineConnector({
          id: "hard-cfg",
          server: { transport: "stdio", command: "node", args: ["x.js"] },
          oauth: {
            idp: {
              provider: "generic",
              clientId: "cid",
              scopes: ["read"],
              authorizationEndpoint: "https://idp.example/authorize",
              tokenEndpoint: "https://idp.example/token",
              extraAuthorizationParams: { [name]: "x" },
            },
          },
        }),
      ).toThrow(`oauth.idp.extraAuthorizationParams: "${name}" is set by the login flow and cannot be overridden`);
    }
  });
});

describe("inherited object keys are not logins (S5)", () => {
  it("registeredLoginDef rejects __proto__, constructor and toString as unknown keys", () => {
    process.env.AGENT_CONNECTOR_DATA_DIR = join(tmp, "data");
    try {
      const id = "hard-proto";
      const connector = defineConnector({
        id,
        server: { transport: "stdio", command: "node", args: ["x.js"] },
        oauth: {
          idp: {
            provider: "generic",
            clientId: "cid",
            scopes: ["read"],
            authorizationEndpoint: "https://idp.example/authorize",
            tokenEndpoint: "https://idp.example/token",
          },
        },
      });
      registerConnector(connector, join(tmp, "connector.mjs"));
      expect(registeredLoginDef(id, "idp").provider).toBe("generic");
      for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
        expect(() => registeredLoginDef(id, key)).toThrow(`connector ${id} declares no login "${key}" (declared: idp)`);
      }
    } finally {
      delete process.env.AGENT_CONNECTOR_DATA_DIR;
    }
  });
});

describe("a provider that never echoes state (S3)", () => {
  it("is accepted only for a fixed-port login; a present state is still verified; other providers stay strict", async () => {
    // Loopback receiver semantics.
    const s = await startLoopback({ path: "/cb" });
    const relaxed = s.waitForCallback("expected", 5000, undefined, { requireState: false });
    const r = await fetch(`${s.redirectUri}?code=abc`);
    expect(r.status).toBe(200);
    await expect(relaxed).resolves.toEqual({ code: "abc" });
    await s.close();
    const s2 = await startLoopback({ path: "/cb" });
    const relaxedWrong = expect(s2.waitForCallback("expected", 5000, undefined, { requireState: false })).rejects.toMatchObject({ code: "authorization" });
    expect((await fetch(`${s2.redirectUri}?code=abc&state=other`)).status).toBe(400);
    await relaxedWrong;
    await s2.close();
    const s3 = await startLoopback({ path: "/cb" });
    const strict = expect(s3.waitForCallback("expected", 5000)).rejects.toMatchObject({ code: "authorization" });
    expect((await fetch(`${s3.redirectUri}?code=abc`)).status).toBe(400);
    await strict;
    await s3.close();

    // Engine wiring: a bing-webmaster login with a fixed port completes when the
    // provider drops `state`; the same provider on an ephemeral port does not.
    const server = await mock({ clientAuth: "post" });
    const id = connectorId();
    openSecretStore(storeOpts(id)).set("bing-secret", server.clientSecret);
    const dropState = fakeBrowser((target) => target.searchParams.delete("state"));
    const port = 40_000 + Math.floor(Math.random() * 10_000);
    const bing: ResolvedOAuthLoginDef = {
      key: "bing",
      provider: "bing-webmaster",
      clientId: server.clientId,
      clientSecret: "${secret:bing-secret}",
      scopes: ["webmaster.manage"],
      authorizationEndpoint: server.authorizationEndpoint,
      tokenEndpoint: server.tokenEndpoint,
      flow: "loopback",
      redirectPath: "/callback",
      redirectPort: port,
      storeAs: "oauth.bing.refresh-token",
    };
    const result = await login({ connectorId: id, key: "bing", def: bing, env: ENV, secretStore: storeOpts(id), openBrowser: dropState, log: () => {} });
    expect(result.obtainedVia).toBe("loopback");
    expect(openSecretStore(storeOpts(id)).has("oauth.bing.refresh-token")).toBe(true);

    const { redirectPort: _omit, ...ephemeral } = bing;
    const err = await login({
      connectorId: id,
      key: "bing",
      def: ephemeral,
      env: ENV,
      secretStore: storeOpts(id),
      openBrowser: dropState,
      log: () => {},
      loginTimeoutMs: 2000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("authorization");

    // A preset that echoes state (generic) stays strict even with a fixed port.
    const generic = loginDef(server, { flow: "loopback", redirectPort: port + 1 });
    const err2 = await login({ connectorId: id, key: "idp", def: generic, env: ENV, secretStore: storeOpts(id), openBrowser: dropState, log: () => {} }).catch((e: unknown) => e);
    expect((err2 as OAuthError).code).toBe("authorization");
  });
});

describe("a token response without expires_in (C2)", () => {
  it("is cached and reused for the documented hour instead of refreshed on every call", async () => {
    const server = await mock({ clientAuth: "none", omitExpiresIn: true });
    const id = connectorId();
    const def = loginDef(server);
    openSecretStore(storeOpts(id)).set(def.storeAs, server.seedRefreshToken("read"));
    const first = await getAccessToken({ connectorId: id, key: "idp", def, interactive: "never", env: ENV, secretStore: storeOpts(id) });
    expect(first.expiresAt).toBeUndefined();
    const second = await getAccessToken({ connectorId: id, key: "idp", def, interactive: "never", env: ENV, secretStore: storeOpts(id) });
    expect(second.accessToken).toBe(first.accessToken);
    expect(refreshRequests(server)).toHaveLength(1);
  });
});

describe("the generated package README names the logins (C1)", () => {
  function connectorWith(oauth: boolean, bin?: string) {
    return defineConnector({
      id: "hard-pkg",
      displayName: "Hard Pkg",
      publish: { author: { name: "Acme" } },
      ...(bin ? { mcp: { packageName: "@acme/hard-pkg", bin } } : {}),
      server: { transport: "stdio", command: "node", args: ["server.js"] },
      ...(oauth
        ? {
            oauth: {
              google: { provider: "google", clientId: "cid", scopes: ["openid"] },
              bing: {
                provider: "bing-webmaster",
                clientId: "cid",
                clientSecret: "${secret:bing}",
                scopes: ["webmaster.manage"],
                redirectPort: 8765,
              },
            },
          }
        : {}),
    });
  }
  it("mcpb and agent-plugin READMEs carry the sentence only for a connector with oauth logins", () => {
    const outA = join(tmp, "with");
    packageConnector(connectorWith(true, "hard-pkg"), { outDir: outA, format: "mcpb", homeBinPath: "/fake/bin/agent-connector" });
    const mcpb = readFileSync(join(outA, "README.md"), "utf8");
    const expected =
      "Providers declared under oauth.<key> (google, bing) are authorized once with `hard-pkg auth login google`, `hard-pkg auth login bing`; " +
      "a server that calls getAccessToken without a stored login opens the browser itself when it can.";
    expect(mcpb).toContain(expected);
    const plugin = packageConnector(connectorWith(true, "hard-pkg"), { outDir: join(tmp, "with-plugin"), homeBinPath: "/fake/bin/agent-connector" });
    expect(readFileSync(join(plugin.pluginDir, "README.md"), "utf8")).toContain(expected);

    const outB = join(tmp, "without");
    packageConnector(connectorWith(false), { outDir: outB, format: "mcpb", homeBinPath: "/fake/bin/agent-connector" });
    expect(readFileSync(join(outB, "README.md"), "utf8")).not.toContain("authorized once");
    const noPlugin = packageConnector(connectorWith(false), { outDir: join(tmp, "without-plugin"), homeBinPath: "/fake/bin/agent-connector" });
    expect(readFileSync(join(noPlugin.pluginDir, "README.md"), "utf8")).not.toContain("authorized once");

    // Without a bin name the package name is used through npx.
    const outC = join(tmp, "npx");
    packageConnector(connectorWith(true), { outDir: outC, format: "mcpb", homeBinPath: "/fake/bin/agent-connector" });
    expect(readFileSync(join(outC, "README.md"), "utf8")).toMatch(/`npx (@acme\/hard-pkg|<package>) auth login google`/);
  });
});

describe("an abort signal ends a login that is waiting for the user (C18)", () => {
  it("rejects promptly, closes the receiver and stores nothing", async () => {
    const server = await mock({ clientAuth: "none", autoApprove: false });
    const id = connectorId();
    const def = loginDef(server, { flow: "loopback" });
    const controller = new AbortController();
    let opened = "";
    const pending = login({
      connectorId: id,
      key: "idp",
      def,
      env: ENV,
      secretStore: storeOpts(id),
      openBrowser: async (url) => {
        opened = url;
      },
      log: () => {},
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toContain(server.authorizationEndpoint);
    controller.abort();
    await expect(pending).rejects.toThrow();
    const redirectUri = new URL(opened).searchParams.get("redirect_uri") as string;
    await expect(fetch(redirectUri)).rejects.toThrow();
    expect(openSecretStore(storeOpts(id)).has(def.storeAs)).toBe(false);
  });
});

describe("a provider that never echoes state needs a fixed port at define time (S3)", () => {
  it("defineConnector rejects a bing-webmaster login without redirectPort with the documented message", () => {
    const bad = () =>
      defineConnector({
        id: "hard-bing",
        server: { transport: "stdio", command: "node", args: ["x.js"] },
        oauth: { bing: { provider: "bing-webmaster", clientId: "cid", clientSecret: "${secret:bing}", scopes: ["webmaster.manage"] } },
      });
    expect(bad).toThrow(
      'oauth.bing.redirectPort: required for provider "bing-webmaster" (redirect URIs are matched exactly and the authorization response carries no state)',
    );
    const ok = defineConnector({
      id: "hard-bing",
      server: { transport: "stdio", command: "node", args: ["x.js"] },
      oauth: { bing: { provider: "bing-webmaster", clientId: "cid", clientSecret: "${secret:bing}", scopes: ["webmaster.manage"], redirectPort: 8765 } },
    });
    expect(ok.oauth.bing?.redirectPort).toBe(8765);
  });
});
