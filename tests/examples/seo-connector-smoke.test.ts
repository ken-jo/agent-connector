/**
 * tests/examples/seo-connector-smoke — the three-login example is runnable.
 *
 * Executes the example the way a reader would (`node bin.mjs …`, the MCP
 * server over stdio, and the token exchange service as its own process)
 * against the repo build, in a sandboxed HOME with the file secrets backend
 * and no browser. The CLI plans an install and names the unset Bing secrets
 * before the absent logins, `secrets set` clears those lines, the server
 * answers the MCP handshake and turns a tool call without a login into the
 * exact `auth login` command, and the sample token exchange service carries a
 * loopback login and a refresh for a `tokenExchangeUrl` login against the mock
 * provider — the secret is seen by the provider only. No live provider is
 * contacted anywhere.
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clearAccessTokenCache, getAccessToken, login } from "../../src/core/oauth/index.js";
import type { ResolvedOAuthLoginDef } from "../../src/core/oauth/index.js";
import { openSecretStore } from "../../src/core/secrets.js";
import type { OpenSecretStoreOptions } from "../../src/core/secrets.js";
import { startMockOAuthServer } from "../support/mock-oauth-server.js";
import { expectNoLeak, tokenRequests } from "../support/oauth-fixtures.js";
import type { MockOAuthServer, MockOAuthServerOptions } from "../support/mock-oauth-server.js";

const EXAMPLE = join(__dirname, "..", "..", "examples", "seo-connector");
const BIN = join(EXAMPLE, "bin.mjs");
const SERVER = join(EXAMPLE, "seo-mcp-server.mjs");
const SERVICE = join(EXAMPLE, "token-exchange-service.mjs");
const LINK = join(__dirname, "..", "..", "node_modules", "@ken-jo", "agent-connector");
const DIST = join(__dirname, "..", "..", "dist", "cli", "sdk.js");

let sandbox: string;
let env: NodeJS.ProcessEnv;
let servers: MockOAuthServer[] = [];
let children: ChildProcess[] = [];

beforeAll(() => {
  // The example resolves @ken-jo/agent-connector through the workspace link
  // and the built dist: `npm install && npm run build` at the repo root.
  expect(existsSync(LINK) && existsSync(DIST), "run `npm install && npm run build` at the repo root before this test").toBe(true);
});

beforeEach(() => {
  sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "ac-seo-smoke-")));
  mkdirSync(join(sandbox, ".claude"), { recursive: true });
  writeFileSync(join(sandbox, ".claude", "settings.json"), "{}", "utf8");
  env = {
    ...process.env,
    HOME: sandbox,
    USERPROFILE: sandbox,
    AGENT_CONNECTOR_DATA_DIR: join(sandbox, ".agent-connector"),
    AGENT_CONNECTOR_SECRETS_BACKEND: "file",
    AGENT_CONNECTOR_BROWSER: "never",
  };
});

afterEach(async () => {
  await Promise.all(children.map((child) => stop(child)));
  children = [];
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  rmSync(sandbox, { recursive: true, force: true });
});

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill();
  });
}

function runExample(args: string[], input?: string): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env, ...(input === undefined ? {} : { input }) });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const absentLine = (key: string, provider: string): string =>
  `login "${key}" (${provider}) is not present — run \`auth login ${key}\` before the server needs it`;
const unsetLine = (name: string): string =>
  `login "bing" (bing-webmaster) references secret "${name}" which is not set — run \`secrets set ${name}\` before \`auth login bing\``;

async function mock(options: MockOAuthServerOptions = {}): Promise<MockOAuthServer> {
  const server = await startMockOAuthServer(options);
  servers.push(server);
  return server;
}

interface Service {
  /** `http://127.0.0.1:<port>/token` — the connector's `tokenExchangeUrl`. */
  url: string;
  stderr: () => string;
}

/** Start the sample token exchange service on an ephemeral port; resolves once it reports its address. */
async function startService(vars: Record<string, string>): Promise<Service> {
  const child = spawn(process.execPath, [SERVICE], {
    env: { ...process.env, ...vars, TOKEN_EXCHANGE_LISTEN: "127.0.0.1:0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  let stderr = "";
  const origin = await new Promise<string>((resolve, reject) => {
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const bound = /listening on (http:\/\/127\.0\.0\.1:\d+),/.exec(stderr);
      if (bound) resolve(bound[1]!);
    });
    child.once("exit", (code) => reject(new Error(`token exchange service exited with ${code}: ${stderr}`)));
  });
  return { url: `${origin}/token`, stderr: () => stderr };
}

/** POST a form to the service the way the engine does and parse the JSON answer. */
async function postForm(url: string, fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("examples/seo-connector — the CLI over the built package", () => {
  it("`install --dry-run` names the two unset bing secrets before bing's absent-login line; google and posthog are only absent (exit 1: the warn convention)", () => {
    const { code, stdout } = runExample(["install", "--dry-run", "--targets", "claude-code"]);
    // install exits 1 whenever a host entry carries a warn record — here the
    // two unset secrets and the three absent logins.
    expect(code).toBe(1);
    expect(stdout).toContain("Would install seo-connector to 1 host");
    for (const [key, provider] of [
      ["google", "google"],
      ["bing", "bing-webmaster"],
      ["posthog", "posthog"],
    ] as const) {
      expect(stdout).toContain(absentLine(key, provider));
    }
    const at = (line: string): number => {
      const index = stdout.indexOf(line);
      expect(index, line).toBeGreaterThanOrEqual(0);
      return index;
    };
    // clientId first, then clientSecret, then the login's own line.
    expect(at(unsetLine("bing-client-id"))).toBeLessThan(at(unsetLine("bing-client-secret")));
    expect(at(unsetLine("bing-client-secret"))).toBeLessThan(at(absentLine("bing", "bing-webmaster")));
    // google (literal id + literal secret) and posthog (literal id) reference no secret.
    const referencing = stdout.split("\n").filter((line) => line.includes("references secret"));
    expect(referencing.length).toBeGreaterThanOrEqual(2);
    for (const line of referencing) expect(line).toMatch(/^.*login "bing" \(bing-webmaster\) references secret "bing-client-(id|secret)"/);
  });

  it("after `secrets set` for both bing names (file backend) only the three absent-login lines remain", () => {
    for (const [name, value] of [
      ["bing-client-id", "test-bing-client-id"],
      ["bing-client-secret", "test-bing-client-secret"],
    ] as const) {
      const set = runExample(["secrets", "set", name, "--stdin"], `${value}\n`);
      expect(set.code, set.stderr).toBe(0);
      expect(set.stdout).toContain(`stored "${name}" for connector seo-connector in file`);
      expect(set.stdout + set.stderr).not.toContain(value);
    }
    const { code, stdout } = runExample(["install", "--dry-run", "--targets", "claude-code"]);
    expect(code).toBe(1);
    expect(stdout).not.toContain("references secret");
    for (const [key, provider] of [
      ["google", "google"],
      ["bing", "bing-webmaster"],
      ["posthog", "posthog"],
    ] as const) {
      expect(stdout).toContain(absentLine(key, provider));
    }
  });

  it("`auth status --json` lists the three logins as absent without touching the network", () => {
    const { code, stdout } = runExample(["auth", "status", "--json"]);
    expect(code).toBe(0);
    const statuses = JSON.parse(stdout) as Array<{ key: string; provider: string; present: boolean | null }>;
    expect(statuses.map((s) => [s.key, s.provider, s.present])).toEqual([
      ["google", "google", false],
      ["bing", "bing-webmaster", false],
      ["posthog", "posthog", false],
    ]);
  });

  it("the MCP server answers the handshake, lists five tools, and a tool call without a login names the auth login command", async () => {
    const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    const waiters = new Map<number, (v: unknown) => void>();
    createInterface({ input: child.stdout! }).on("line", (line) => {
      const msg = JSON.parse(line) as { id: number };
      waiters.get(msg.id)?.(msg);
    });
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
    const call = (id: number, method: string, params?: unknown): Promise<unknown> =>
      new Promise((resolve) => {
        waiters.set(id, resolve);
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
      });
    const init = (await call(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } })) as {
      result: { serverInfo: { name: string }; capabilities: { tools: object } };
    };
    expect(init.result.serverInfo.name).toBe("seo-mcp-server");
    expect(init.result.capabilities.tools).toEqual({});
    const list = (await call(2, "tools/list")) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["gsc_sites", "gsc_search_analytics", "bing_query_stats", "posthog_query", "posthog_projects"]);
    const gsc = (await call(3, "tools/call", { name: "gsc_sites", arguments: {} })) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(gsc.result.isError).toBe(true);
    expect(gsc.result.content[0]?.text).toBe(
      'login "google" is not present for connector seo-connector — run `auth login google --connector-id seo-connector`',
    );
    const unknown = (await call(4, "tools/call", { name: "nope", arguments: {} })) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32602);
    expect(stderr).not.toMatch(/token|secret/i);
  });
});

describe("examples/seo-connector — the token exchange service", () => {
  const CONNECTOR_ID = "seo-connector-exchange";
  /** The engine's env: the file backend under the sandbox; the browser "opens" through the seam below. */
  const engineEnv = (): NodeJS.ProcessEnv => ({
    HOME: sandbox,
    USERPROFILE: sandbox,
    AGENT_CONNECTOR_DATA_DIR: join(sandbox, ".agent-connector"),
    AGENT_CONNECTOR_SECRETS_BACKEND: "file",
    AGENT_CONNECTOR_BROWSER: "always",
  });
  const storeOpts = (): OpenSecretStoreOptions => ({
    connectorId: CONNECTOR_ID,
    dataRoot: join(sandbox, ".agent-connector"),
    backend: "file",
    env: engineEnv(),
  });

  /** A `generic` login whose token requests go to the service instead of the provider. */
  function exchangeLogin(server: MockOAuthServer, service: Service): ResolvedOAuthLoginDef {
    return {
      key: "bing",
      provider: "generic",
      clientId: server.clientId,
      tokenExchangeUrl: service.url,
      scopes: ["webmaster.read"],
      authorizationEndpoint: server.authorizationEndpoint,
      tokenEndpoint: server.tokenEndpoint,
      flow: "loopback",
      redirectPath: "/callback",
      storeAs: "oauth.bing.refresh-token",
    };
  }

  /** The browser seam: GET the authorization URL without following redirects, then GET the loopback redirect. */
  function fakeBrowser(): (url: string) => Promise<void> {
    return async (url) => {
      const res = await fetch(url, { redirect: "manual" });
      expect(res.status).toBe(302);
      const target = res.headers.get("location")!;
      setTimeout(() => void fetch(target).catch(() => undefined), 10);
    };
  }

  it("carries a loopback login and a refresh: the provider sees the secret, the service's inbound requests never do", async () => {
    const server = await mock({ clientAuth: "post", pkce: true });
    const service = await startService({
      TOKEN_EXCHANGE_CLIENT_ID: server.clientId,
      TOKEN_EXCHANGE_CLIENT_SECRET: server.clientSecret,
      TOKEN_EXCHANGE_TOKEN_ENDPOINT: server.tokenEndpoint,
    });
    const def = exchangeLogin(server, service);
    const log: string[] = [];

    const result = await login({
      connectorId: CONNECTOR_ID,
      key: "bing",
      def,
      env: engineEnv(),
      secretStore: storeOpts(),
      openBrowser: fakeBrowser(),
      log: (line) => log.push(line),
    });

    expect(result.obtainedVia).toBe("loopback");
    expect(log).toContain(`Tokens are exchanged through ${service.url} (the connector's token exchange service)`);
    expect(server.tokensIssued).toHaveLength(1);
    const issued = server.tokensIssued[0]!;
    expect(openSecretStore(storeOpts()).get("oauth.bing.refresh-token")).toBe(issued.refreshToken);

    // The provider's token request came from the service with the secret added.
    const [exchange] = tokenRequests(server);
    expect(exchange!.body).toMatchObject({
      grant_type: "authorization_code",
      client_id: server.clientId,
      client_secret: server.clientSecret,
    });
    expect(exchange!.body.code).toMatch(/^mock-code-/);
    expect(exchange!.body.code_verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(exchange!.headers["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(exchange!.headers.accept).toBe("application/json");

    // A refresh goes through the service too.
    clearAccessTokenCache();
    const set = await getAccessToken({ connectorId: CONNECTOR_ID, key: "bing", def, interactive: "never", env: engineEnv(), secretStore: storeOpts() });
    expect(server.tokensIssued).toHaveLength(2);
    expect(set.accessToken).toBe(server.tokensIssued[1]!.accessToken);
    const [, refresh] = tokenRequests(server);
    expect(refresh!.body).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: issued.refreshToken,
      client_id: server.clientId,
      client_secret: server.clientSecret,
    });

    // The service refuses any request that carries a client_secret, so two
    // forwarded requests prove the engine sent none; its log names the
    // method, grant type and upstream status only.
    const lines = service.stderr().split("\n").filter((line) => line.includes(" → "));
    expect(lines).toEqual(["token-exchange-service: POST authorization_code → 200", "token-exchange-service: POST refresh_token → 200"]);
    expectNoLeak(service.stderr());
    expect(service.stderr()).not.toContain(server.clientSecret);
  });

  it("accepts only its own client_id, the three grant types and no client_secret; passes the provider's status and body through unchanged", async () => {
    const server = await mock({ clientAuth: "post" });
    const service = await startService({
      TOKEN_EXCHANGE_CLIENT_ID: server.clientId,
      TOKEN_EXCHANGE_CLIENT_SECRET: server.clientSecret,
      TOKEN_EXCHANGE_TOKEN_ENDPOINT: server.tokenEndpoint,
    });
    const seeded = server.seedRefreshToken("webmaster.read");

    const refusals: Record<string, string>[] = [
      { grant_type: "refresh_token", refresh_token: seeded, client_id: "someone-else" },
      { grant_type: "password", username: "u", password: "p", client_id: server.clientId },
      { grant_type: "refresh_token", refresh_token: seeded, client_id: server.clientId, client_secret: "mock-client-secret" },
    ];
    for (const fields of refusals) {
      const refused = await postForm(service.url, fields);
      expect(refused, JSON.stringify(fields)).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    const get = await fetch(service.url);
    expect(get.status).toBe(400);
    expect(await get.json()).toEqual({ error: "invalid_request" });
    expect(tokenRequests(server)).toHaveLength(0);

    // A valid refresh: the provider's 200 and JSON body, unchanged.
    const ok = await postForm(service.url, { grant_type: "refresh_token", refresh_token: seeded, client_id: server.clientId });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ token_type: "Bearer", access_token: server.tokensIssued[0]!.accessToken });
    // A dead refresh token: the provider's 400 invalid_grant, unchanged.
    const dead = await postForm(service.url, { grant_type: "refresh_token", refresh_token: "mock-refresh-revoked", client_id: server.clientId });
    expect(dead.status).toBe(400);
    expect(dead.body).toMatchObject({ error: "invalid_grant" });
    expect(tokenRequests(server).map((r) => r.body.client_secret)).toEqual([server.clientSecret, server.clientSecret]);

    const lines = service.stderr().split("\n").filter((line) => line.includes(" → "));
    expect(lines).toEqual([
      "token-exchange-service: POST refresh_token → 400",
      // An unknown grant type is logged as "-": inbound text never reaches the log.
      "token-exchange-service: POST - → 400",
      "token-exchange-service: POST refresh_token → 400",
      "token-exchange-service: GET - → 400",
      "token-exchange-service: POST refresh_token → 200",
      "token-exchange-service: POST refresh_token → 400",
    ]);
    expectNoLeak(service.stderr());
  });

  it("refuses a repeated parameter, forwards only the accepted grant's own parameters, and logs `-` for a grant type it does not know", async () => {
    const server = await mock({ clientAuth: "post" });
    const service = await startService({
      TOKEN_EXCHANGE_CLIENT_ID: server.clientId,
      TOKEN_EXCHANGE_CLIENT_SECRET: server.clientSecret,
      TOKEN_EXCHANGE_TOKEN_ENDPOINT: server.tokenEndpoint,
    });
    const seeded = server.seedRefreshToken("webmaster.read");
    const raw = async (body: string): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await fetch(service.url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    // A second grant_type (RFC 6749 §3.2 forbids a repeated parameter) never reaches the provider.
    const repeated = await raw(`grant_type=refresh_token&refresh_token=${seeded}&client_id=${server.clientId}&grant_type=client_credentials&scope=admin`);
    expect(repeated).toEqual({ status: 400, body: { error: "invalid_request" } });
    // A grant type carrying a forged log line and an escape sequence is refused and logged as "-".
    const forged = await raw(`grant_type=x%0Atoken-exchange-service:%20POST%20refresh_token%20%E2%86%92%20200%0A%1B[31m&client_id=${server.clientId}`);
    expect(forged).toEqual({ status: 400, body: { error: "invalid_request" } });
    expect(tokenRequests(server)).toHaveLength(0);
    // Unknown parameters are dropped: the provider gets the grant's own parameters, client_id and the secret.
    const ok = await raw(`grant_type=refresh_token&refresh_token=${seeded}&client_id=${server.clientId}&scope=admin&audience=https%3A%2F%2Fapi.example`);
    expect(ok.status).toBe(200);
    expect(Object.keys(tokenRequests(server)[0]!.body).sort()).toEqual(["client_id", "client_secret", "grant_type", "refresh_token"]);

    const lines = service.stderr().split("\n").filter((line) => line.includes(" → "));
    expect(lines).toEqual([
      "token-exchange-service: POST refresh_token → 400",
      "token-exchange-service: POST - → 400",
      "token-exchange-service: POST refresh_token → 200",
    ]);
    // eslint-disable-next-line no-control-regex
    expect(service.stderr()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expectNoLeak(service.stderr());
  });

  it("refuses a provider endpoint that is not https (http only on a loopback host)", () => {
    const res = spawnSync(process.execPath, [SERVICE], {
      env: { ...process.env, TOKEN_EXCHANGE_CLIENT_ID: "app", TOKEN_EXCHANGE_CLIENT_SECRET: "mock-client-secret", TOKEN_EXCHANGE_TOKEN_ENDPOINT: "http://idp.example/token" },
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toBe(
      "token-exchange-service: TOKEN_EXCHANGE_TOKEN_ENDPOINT must be an https URL without credentials or a fragment (http only on 127.0.0.1, localhost or [::1])\n",
    );
    expect(res.stdout).toBe("");
  });

  it("sends the secret as HTTP Basic when TOKEN_EXCHANGE_CLIENT_AUTH=basic", async () => {
    const server = await mock({ clientAuth: "basic" });
    const service = await startService({
      TOKEN_EXCHANGE_CLIENT_ID: server.clientId,
      TOKEN_EXCHANGE_CLIENT_SECRET: server.clientSecret,
      TOKEN_EXCHANGE_TOKEN_ENDPOINT: server.tokenEndpoint,
      TOKEN_EXCHANGE_CLIENT_AUTH: "basic",
    });
    const seeded = server.seedRefreshToken("webmaster.read");
    const ok = await postForm(service.url, { grant_type: "refresh_token", refresh_token: seeded, client_id: server.clientId });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ access_token: server.tokensIssued[0]!.accessToken });
    const [request] = tokenRequests(server);
    expect(request!.headers.authorization).toBe(`Basic ${Buffer.from(`${server.clientId}:${server.clientSecret}`, "utf8").toString("base64")}`);
    expect(request!.body.client_secret).toBeUndefined();
    expect(service.stderr()).toContain("(client_secret_basic)");
    expectNoLeak(service.stderr());
  });

  it("exits 1 with a one-line reason when a required variable is unset", () => {
    const withoutSecret: NodeJS.ProcessEnv = { ...process.env, TOKEN_EXCHANGE_CLIENT_ID: "mock-client", TOKEN_EXCHANGE_TOKEN_ENDPOINT: "http://127.0.0.1:1/token" };
    delete withoutSecret.TOKEN_EXCHANGE_CLIENT_SECRET;
    const res = spawnSync(process.execPath, [SERVICE], { encoding: "utf8", env: withoutSecret });
    expect(res.status).toBe(1);
    expect(res.stderr).toBe("token-exchange-service: TOKEN_EXCHANGE_CLIENT_SECRET is not set\n");
    expect(res.stdout).toBe("");
  });
});
