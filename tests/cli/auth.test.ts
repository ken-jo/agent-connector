/**
 * cli/auth — the `auth login | status | logout | token` command.
 *
 * Drives the real command through its io seams (`openBrowser`, `log`) against
 * a local OAuth provider mock on 127.0.0.1 and the `file` secrets backend in a
 * throwaway data root, so no browser opens, no OS keystore is touched and no
 * live provider is contacted. The byte-level contract under test:
 *   • login stores the refresh token under `storeAs`, writes the non-secret
 *     metadata record, and prints the fixed confirmation line (or LoginResult)
 *   • status is a fixed table (or LoginStatus[]) and never exits non-zero
 *   • logout forgets the token (revoking first when the provider can) and a
 *     second logout still exits 0
 *   • `auth token` prints the access token and NOTHING else; every other verb
 *     never prints a token, a code or a verifier anywhere
 *   • connector resolution (--connector-id needs a registered record; --connector
 *     <path>; the local config; the single registered connector)
 *   • usage errors exit 2 with the verb's signature; engine failures exit 1
 *   • `auth --help` prints the fixed signature lines; the root usage lists it
 *   • a branded CLI (createConnectorCli) auto-scopes `auth` to its connector
 *
 * The provider mock is local to this file (RFC 6749 authorization-code with
 * PKCE, refresh, revocation; RFC 8628 device authorization).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/app.js";
import { AUTH_USAGE_LINES, run } from "../../src/cli/commands/auth.js";
import type { AuthIo } from "../../src/cli/commands/auth.js";
import { createConnectorCli } from "../../src/cli/sdk.js";
import { defineConnector } from "../../src/core/define-connector.js";
import { registerConnector } from "../../src/core/load-connector.js";
import { clearAccessTokenCache, getOAuthPreset } from "../../src/core/oauth/index.js";
import { openSecretStore } from "../../src/core/secrets.js";
import type { ConnectorConfig } from "../../src/core/types.js";

// Sentinels: none of these may ever appear in a command's stdout/stderr/log,
// except the access token on `auth token`'s stdout.
const AUTH_CODE = "code-never-printed-4c1a";
const ACCESS_TOKEN = "at-never-printed-9f2c";
const REFRESHED_TOKEN = "at-refreshed-never-printed-5d0b";
const REFRESH_TOKEN = "rt-never-printed-7b1e";
const DEVICE_CODE = "dc-never-printed-2e8f";
const DEVICE_ACCESS_TOKEN = "at-device-never-printed-1a6d";
const DEVICE_REFRESH_TOKEN = "rt-device-never-printed-3c9e";
const USER_CODE = "ABCD-EFGH";
const SENTINELS = [
  AUTH_CODE,
  ACCESS_TOKEN,
  REFRESHED_TOKEN,
  REFRESH_TOKEN,
  DEVICE_CODE,
  DEVICE_ACCESS_TOKEN,
  DEVICE_REFRESH_TOKEN,
];

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  AGENT_CONNECTOR_DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  AGENT_CONNECTOR_SECRETS_BACKEND: process.env.AGENT_CONNECTOR_SECRETS_BACKEND,
  AGENT_CONNECTOR_BROWSER: process.env.AGENT_CONNECTOR_BROWSER,
};

// ── Provider mock ─────────────────────────────────────────────────────────
// Deliberately separate from tests/support/mock-oauth-server.ts: this one
// issues FIXED sentinel strings so the never-printed assertions below can
// grep every stream for them; the shared mock issues random `mock-*` values.

interface MockRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, string>;
}

interface MockProvider {
  url: string;
  requests: MockRequest[];
  /** When true, /authorize answers with error=access_denied instead of a code. */
  deny: boolean;
  close(): Promise<void>;
}

async function startMockProvider(): Promise<MockProvider> {
  const requests: MockRequest[] = [];
  const state = { deny: false, url: "" };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
    const body = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
    const query = Object.fromEntries(url.searchParams);
    requests.push({ method: req.method ?? "GET", path: url.pathname, query, body });
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    };
    switch (`${req.method} ${url.pathname}`) {
      case "GET /authorize": {
        const target = new URL(query.redirect_uri as string);
        if (state.deny) target.searchParams.set("error", "access_denied");
        else target.searchParams.set("code", AUTH_CODE);
        target.searchParams.set("state", query.state as string);
        res.writeHead(302, { location: target.toString() }).end();
        return;
      }
      case "POST /token": {
        if (body.grant_type === "authorization_code") {
          if (body.code !== AUTH_CODE || !body.code_verifier || !body.redirect_uri) {
            return json(400, { error: "invalid_grant", error_description: "bad code exchange" });
          }
          return json(200, {
            access_token: ACCESS_TOKEN,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: REFRESH_TOKEN,
            scope: "read write",
          });
        }
        if (body.grant_type === "refresh_token") {
          if (body.refresh_token !== REFRESH_TOKEN && body.refresh_token !== DEVICE_REFRESH_TOKEN) {
            return json(400, { error: "invalid_grant" });
          }
          return json(200, { access_token: REFRESHED_TOKEN, token_type: "Bearer", expires_in: 3600 });
        }
        if (body.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
          if (body.device_code !== DEVICE_CODE) return json(400, { error: "invalid_grant" });
          return json(200, {
            access_token: DEVICE_ACCESS_TOKEN,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: DEVICE_REFRESH_TOKEN,
          });
        }
        return json(400, { error: "unsupported_grant_type" });
      }
      case "POST /device_authorization":
        return json(200, {
          device_code: DEVICE_CODE,
          user_code: USER_CODE,
          verification_uri: `${state.url}/device`,
          expires_in: 600,
          interval: 1,
        });
      case "POST /revoke":
        return json(200, {});
      default:
        return json(404, { error: "not_found" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: state.url,
    requests,
    get deny() {
      return state.deny;
    },
    set deny(value: boolean) {
      state.deny = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** A port nobody is listening on right now. */
async function freePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

// ── Harness ───────────────────────────────────────────────────────────────

let tmp: string;
let dataDir: string;
let provider: MockProvider;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "ac-auth-cli-"));
  dataDir = join(tmp, ".agent-connector");
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.AGENT_CONNECTOR_DATA_DIR = dataDir;
  process.env.AGENT_CONNECTOR_SECRETS_BACKEND = "file";
  // `flow: "auto"` picks loopback only when a browser can be opened.
  process.env.AGENT_CONNECTOR_BROWSER = "always";
  // Every real CLI run is its own process; the engine's per-process access-token cache must not leak between tests.
  clearAccessTokenCache();
  provider = await startMockProvider();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await provider.close();
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function capture(stream: "stdout" | "stderr"): { restore: () => void; text: () => string } {
  let out = "";
  const spy = vi
    .spyOn(process[stream], "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
  return { restore: () => spy.mockRestore(), text: () => out };
}

/**
 * The browser seam a test hands to the command: fetches the authorization URL
 * (the provider answers with a redirect to the loopback receiver) and follows
 * that redirect on a later tick — the receiver only accepts the callback once
 * the engine is waiting for it.
 */
function browserSeam(): { openBrowser: (url: string) => Promise<void>; urls: string[]; failures: string[] } {
  const urls: string[] = [];
  const failures: string[] = [];
  return {
    urls,
    failures,
    openBrowser: async (url: string) => {
      urls.push(url);
      const res = await fetch(url, { redirect: "manual" });
      const location = res.headers.get("location");
      if (!location) {
        failures.push(`authorize answered ${res.status} without a redirect`);
        return;
      }
      setTimeout(() => {
        fetch(location)
          .then((r) => r.text())
          .catch((err: unknown) => failures.push(String(err)));
      }, 20);
    },
  };
}

interface Outcome {
  code: number;
  out: string;
  err: string;
  /** The lines the command handed to its `log` seam (stderr in production). */
  logs: string[];
  /** Authorization URLs handed to the browser seam. */
  urls: string[];
}

/** Run the command with both streams captured and the io seams wired to the mock. */
async function auth(argv: string[], io: Partial<AuthIo> = {}): Promise<Outcome> {
  const logs: string[] = [];
  const browser = browserSeam();
  const out = capture("stdout");
  const err = capture("stderr");
  let code: number;
  try {
    code = await run(argv, {
      log: (line) => logs.push(line),
      openBrowser: browser.openBrowser,
      loginTimeoutMs: 15_000,
      ...io,
    });
  } finally {
    out.restore();
    err.restore();
  }
  expect(browser.failures).toEqual([]);
  return { code, out: out.text(), err: err.text(), logs, urls: browser.urls };
}

/** A config with two generic logins pointed at the mock; `acme` can revoke and use device codes, `beta` cannot. */
function oauthConfig(id: string): ConnectorConfig {
  return {
    id,
    version: "1.0.0",
    memory: [{ content: `Use the ${id} tools.` }],
    oauth: {
      acme: {
        provider: "generic",
        clientId: "cid-123",
        scopes: ["read", "write"],
        authorizationEndpoint: `${provider.url}/authorize`,
        tokenEndpoint: `${provider.url}/token`,
        revocationEndpoint: `${provider.url}/revoke`,
        deviceAuthorizationEndpoint: `${provider.url}/device_authorization`,
        tokenEndpointAuth: "none",
        pkce: true,
      },
      beta: {
        provider: "generic",
        clientId: "cid-beta",
        scopes: ["read"],
        authorizationEndpoint: `${provider.url}/authorize`,
        tokenEndpoint: `${provider.url}/token`,
        tokenEndpointAuth: "none",
        pkce: true,
      },
    },
  };
}

function writeConfigJson(dir: string, id: string, name = "agent-connector.config.json"): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(oauthConfig(id)), "utf8");
  return p;
}

/** `--connector <cfg> --project <tmp>` — deterministic resolution from the config file. */
let cfgPath: string;
function byPath(): string[] {
  return ["--connector", cfgPath, "--project", tmp];
}

function store() {
  return openSecretStore({ connectorId: "acme-db", backend: "file", dataRoot: dataDir });
}

function expectNoSentinel(...texts: string[]): void {
  const joined = texts.join("\n");
  for (const s of SENTINELS) expect(joined, `must not contain ${s}`).not.toContain(s);
}

const LABEL = getOAuthPreset("generic").label;

describe("auth login", () => {
  beforeEach(() => {
    cfgPath = writeConfigJson(join(tmp, "proj"), "acme-db");
  });

  it("loopback: opens the authorization URL, stores the refresh token, writes token-free metadata", async () => {
    const r = await auth(["login", "acme", "--loopback", ...byPath()]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(`logged in to "acme" (${LABEL}) for connector acme-db — refresh token stored in file\n`);
    expect(r.err).toBe("");

    // The "Opening …" line, then the URL on its own line, on the log seam (stderr in production).
    const opening = r.logs.indexOf(`Opening ${LABEL} authorization in your browser…`);
    expect(opening, r.logs.join("\n")).toBeGreaterThanOrEqual(0);
    expect(r.logs[opening + 1]).toBe(r.urls[0]);

    // The authorization request the browser was handed: PKCE S256, our client, our scopes.
    const url = new URL(r.urls[0] as string);
    expect(`${url.origin}${url.pathname}`).toBe(`${provider.url}/authorize`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid-123");
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    // The code exchange carried the verifier and the same redirect_uri.
    const exchange = provider.requests.find((q) => q.path === "/token");
    expect(exchange?.body.grant_type).toBe("authorization_code");
    expect(exchange?.body.redirect_uri).toBe(url.searchParams.get("redirect_uri"));
    expect(exchange?.body.code_verifier).toBeTruthy();

    // Refresh token in the keystore under the default storeAs; metadata without any token.
    expect(store().get("oauth.acme.refresh-token")).toBe(REFRESH_TOKEN);
    const metaPath = join(dataDir, "oauth", "acme-db.json");
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      logins: Record<string, { provider: string; obtainedVia: string; storeAs: string; backend: string }>;
    };
    expect(meta.logins.acme).toMatchObject({
      provider: "generic",
      obtainedVia: "loopback",
      storeAs: "oauth.acme.refresh-token",
      backend: "file",
    });
    expectNoSentinel(readFileSync(metaPath, "utf8"), r.out, r.err, ...r.logs);
  });

  it("--json prints the LoginResult", async () => {
    const r = await auth(["login", "acme", "--loopback", "--json", ...byPath()]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      key: "acme",
      provider: "generic",
      obtainedVia: "loopback",
      backend: "file",
    });
    expectNoSentinel(r.out, r.err, ...r.logs);
  });

  it("the default flow (auto) runs the loopback when a browser can be opened", async () => {
    const r = await auth(["login", "beta", ...byPath()]);
    expect(r.code, r.err).toBe(0);
    expect(r.urls).toHaveLength(1);
    expect(store().get("oauth.beta.refresh-token")).toBe(REFRESH_TOKEN);
  });

  it("--port fixes the loopback port the redirect_uri names", async () => {
    const port = await freePort();
    const r = await auth(["login", "acme", "--loopback", "--port", String(port), ...byPath()]);
    expect(r.code, r.err).toBe(0);
    const authorize = provider.requests.find((q) => q.path === "/authorize");
    expect(authorize?.query.redirect_uri).toBe(`http://127.0.0.1:${port}/callback`);
  });

  it("--device: prints the engine's device prompt through the log seam, never opens a browser", async () => {
    const r = await auth(["login", "acme", "--device", ...byPath()]);
    expect(r.code, r.err).toBe(0);
    expect(r.urls).toEqual([]);
    expect(r.logs).toContain(`Visit ${provider.url}/device and enter code ${USER_CODE}`);
    expect(r.out).toBe(`logged in to "acme" (${LABEL}) for connector acme-db — refresh token stored in file\n`);
    expect(store().get("oauth.acme.refresh-token")).toBe(DEVICE_REFRESH_TOKEN);
    expect(provider.requests.some((q) => q.path === "/device_authorization")).toBe(true);
    expectNoSentinel(r.out, r.err, ...r.logs);
  });

  it("a denied authorization is an engine failure: exit 1 with the provider's error, nothing stored", async () => {
    provider.deny = true;
    const r = await auth(["login", "acme", "--loopback", ...byPath()]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("access_denied");
    expect(store().has("oauth.acme.refresh-token")).toBe(false);
    expectNoSentinel(r.out, r.err, ...r.logs);
  });

  it("an unknown key is a usage error naming the declared logins (exit 2)", async () => {
    const r = await auth(["login", "nope", ...byPath()]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`usage: agent-connector ${AUTH_USAGE_LINES[0]}`);
    expect(r.err).toContain('auth login: connector acme-db declares no login "nope" (declared: acme, beta)');
    expect(r.urls).toEqual([]);
  });
});

describe("auth status / token / logout", () => {
  beforeEach(() => {
    cfgPath = writeConfigJson(join(tmp, "proj"), "acme-db");
  });

  it("status: the fixed table before and after a login; --json is LoginStatus[]; always exit 0", async () => {
    const before = await auth(["status", ...byPath()]);
    expect(before.code).toBe(0);
    const lines = before.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^key\s+provider\s+present\s+obtained\s+via$/);
    expect(lines[1]).toMatch(/^acme\s+generic\s+no\s+-\s+-$/);
    expect(lines[2]).toMatch(/^beta\s+generic\s+no\s+-\s+-$/);

    expect((await auth(["login", "acme", "--loopback", ...byPath()])).code).toBe(0);

    const after = await auth(["status", ...byPath()]);
    expect(after.code).toBe(0);
    const afterLines = after.out.trimEnd().split("\n");
    expect(afterLines[1]).toMatch(/^acme\s+generic\s+yes\s+\d{4}-\d{2}-\d{2}T\S+\s+loopback$/);
    expect(afterLines[2]).toMatch(/^beta\s+generic\s+no\s+-\s+-$/);

    const json = await auth(["status", "--json", ...byPath()]);
    expect(json.code).toBe(0);
    const statuses = JSON.parse(json.out) as { key: string; provider: string; present: boolean | null; obtainedVia?: string }[];
    expect(statuses.map((s) => [s.key, s.provider, s.present])).toEqual([
      ["acme", "generic", true],
      ["beta", "generic", false],
    ]);
    expect(statuses[0]?.obtainedVia).toBe("loopback");
    expectNoSentinel(before.out, after.out, json.out, before.err, after.err, json.err);
  });

  it("token: prints ONLY the access token and a newline", async () => {
    expect((await auth(["login", "acme", "--loopback", ...byPath()])).code).toBe(0);
    const r = await auth(["token", "acme", ...byPath()]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toBe("");
    expect(r.logs).toEqual([]);
    expect(r.urls).toEqual([]);
    expect(r.out.endsWith("\n")).toBe(true);
    expect(r.out.trimEnd().split("\n")).toHaveLength(1);
    expect([ACCESS_TOKEN, REFRESHED_TOKEN]).toContain(r.out.trimEnd());
  });

  it("token: not logged in → exit 1 with the exact login-required message, no browser", async () => {
    const r = await auth(["token", "beta", ...byPath()]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain(
      'login "beta" is not present for connector acme-db — run `auth login beta --connector-id acme-db`',
    );
    expect(r.urls).toEqual([]);
  });

  it("logout: revokes when the provider can, forgets the token; a second logout still exits 0", async () => {
    expect((await auth(["login", "acme", "--loopback", ...byPath()])).code).toBe(0);
    const first = await auth(["logout", "acme", ...byPath()]);
    expect(first.code, first.err).toBe(0);
    expect(first.out).toBe('logged out of "acme" for connector acme-db (revoked at the provider)\n');
    expect(provider.requests.some((q) => q.path === "/revoke")).toBe(true);
    expect(store().has("oauth.acme.refresh-token")).toBe(false);
    const status = JSON.parse((await auth(["status", "--json", ...byPath()])).out) as { key: string; present: boolean }[];
    expect(status.find((s) => s.key === "acme")?.present).toBe(false);

    const second = await auth(["logout", "acme", ...byPath()]);
    expect(second.code).toBe(0);
    expect(second.out).toBe('logged out of "acme" for connector acme-db (nothing was stored)\n');
    expectNoSentinel(first.out, first.err, second.out, second.err);
  });

  it("logout without a revocation endpoint prints the plain line", async () => {
    expect((await auth(["login", "beta", "--loopback", ...byPath()])).code).toBe(0);
    const r = await auth(["logout", "beta", ...byPath()]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe('logged out of "beta" for connector acme-db\n');
    expect(provider.requests.some((q) => q.path === "/revoke")).toBe(false);
  });

  it("nothing but `auth token` ever prints a token, a code or a verifier", async () => {
    const seen: string[] = [];
    const push = (r: Outcome): void => {
      seen.push(r.out, r.err, ...r.logs);
    };
    push(await auth(["login", "acme", "--loopback", ...byPath()]));
    push(await auth(["login", "beta", "--loopback", "--json", ...byPath()]));
    push(await auth(["status", ...byPath()]));
    push(await auth(["status", "--json", ...byPath()]));
    push(await auth(["logout", "acme", ...byPath()]));
    push(await auth(["logout", "beta", ...byPath()]));
    expectNoSentinel(...seen);
    // The verifier is not a sentinel, but it is a secret: the code_challenge is the only PKCE value on the wire.
    const verifier = provider.requests.find((q) => q.body.code_verifier)?.body.code_verifier as string;
    expect(verifier).toBeTruthy();
    expect(seen.join("\n")).not.toContain(verifier);
  });
});

describe("auth — connector resolution", () => {
  it("--connector-id needs a registered record; a registered connector's logins come from the registry", async () => {
    const ghost = await auth(["status", "--connector-id", "ghost", "--project", tmp]);
    expect(ghost.code).toBe(1);
    expect(ghost.err).toContain('connector "ghost" is not registered here');

    registerConnector(defineConnector(oauthConfig("reg-conn")), join(tmp, "reg-conn.mjs"), "user");
    const byId = await auth(["status", "--json", "--connector-id", "reg-conn", "--project", tmp]);
    expect(byId.code, byId.err).toBe(0);
    expect((JSON.parse(byId.out) as { key: string }[]).map((s) => s.key)).toEqual(["acme", "beta"]);

    // …and the single registered connector is the fallback when nothing else resolves.
    const single = await auth(["status", "--json", "--project", tmp]);
    expect(single.code, single.err).toBe(0);
    expect((JSON.parse(single.out) as { key: string }[]).map((s) => s.key)).toEqual(["acme", "beta"]);
  });

  it("--connector <bad path> is an error (exit 1)", async () => {
    const r = await auth(["status", "--connector", join(tmp, "nope.json"), "--project", tmp]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot load connector");
  });

  it("finds agent-connector.config.* in --project", async () => {
    writeConfigJson(join(tmp, "proj"), "local-conn");
    const r = await auth(["status", "--json", "--project", join(tmp, "proj")]);
    expect(r.code, r.err).toBe(0);
    expect((JSON.parse(r.out) as { key: string }[]).map((s) => s.key)).toEqual(["acme", "beta"]);
  });

  it("with several registered connectors it asks for --connector-id (exit 1)", async () => {
    for (const id of ["reg-a", "reg-b"]) {
      registerConnector(
        defineConnector({ id, version: "1.0.0", memory: [{ content: "x" }] }),
        join(tmp, `${id}.mjs`),
      );
    }
    const r = await auth(["status", "--project", tmp]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("2 connectors are registered (reg-a, reg-b)");
  });

  it("with nothing to resolve, every verb fails asking for --connector-id (exit 1)", async () => {
    for (const argv of [["login", "k"], ["status"], ["logout", "k"], ["token", "k"]]) {
      const r = await auth([...argv, "--project", tmp]);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err).toContain("no connector found — pass --connector-id <id>");
    }
  });

  it("a connector without oauth: status says so (exit 0); a key is unknown with `declared: none`", async () => {
    registerConnector(
      defineConnector({ id: "plain", version: "1.0.0", memory: [{ content: "x" }] }),
      join(tmp, "plain.mjs"),
    );
    const status = await auth(["status", "--connector-id", "plain", "--project", tmp]);
    expect(status.code).toBe(0);
    expect(status.out).toBe("no logins declared for connector plain — add oauth.<key> to the connector config\n");
    expect(JSON.parse((await auth(["status", "--json", "--connector-id", "plain", "--project", tmp])).out)).toEqual([]);
    const login = await auth(["login", "google", "--connector-id", "plain", "--project", tmp]);
    expect(login.code).toBe(2);
    expect(login.err).toContain('auth login: connector plain declares no login "google" (declared: none)');
  });
});

describe("auth — usage", () => {
  beforeEach(() => {
    cfgPath = writeConfigJson(join(tmp, "proj"), "acme-db");
  });

  it("`auth --help` prints the fixed signature lines (exit 0)", async () => {
    const out = capture("stdout");
    const code = await main(["auth", "--help"]);
    out.restore();
    expect(code).toBe(0);
    expect(out.text()).toContain(`usage: agent-connector ${AUTH_USAGE_LINES[0]}`);
    for (const line of AUTH_USAGE_LINES) expect(out.text()).toContain(line);
  });

  it("the root usage lists auth after secrets", async () => {
    const out = capture("stdout");
    await main(["--help"]);
    out.restore();
    const text = out.text();
    const line =
      "  auth         Log in to the OAuth providers a connector declares (oauth.<key>) and keep the refresh tokens in the OS keystore (login | status | logout | token).";
    expect(text).toContain(line);
    expect(text.indexOf("  secrets      ")).toBeLessThan(text.indexOf(line));
  });

  it("a bare `auth` is a usage error: the signatures on stderr, exit 2", async () => {
    const out = capture("stdout");
    const err = capture("stderr");
    const code = await main(["auth"]);
    out.restore();
    err.restore();
    expect(code).toBe(2);
    expect(out.text()).toBe("");
    for (const line of AUTH_USAGE_LINES) expect(err.text()).toContain(line);
    expect(err.text()).toContain("auth: missing subcommand (login | status | logout | token)");
  });

  it("usage errors exit 2 with the verb's signature on stderr", async () => {
    const cases: [string[], string][] = [
      [["bogus"], 'unknown auth subcommand "bogus" (use login|status|logout|token)'],
      [["login"], "auth login: missing <key>"],
      [["logout"], "auth logout: missing <key>"],
      [["token"], "auth token: missing <key>"],
      [["status", "extra"], 'auth status: unexpected argument "extra"'],
      [["login", "acme", "extra"], 'auth login: unexpected argument "extra"'],
      [["status", "--device"], "--device is not accepted by `auth status`"],
      [["logout", "acme", "--json"], "--json is not accepted by `auth logout`"],
      [["token", "acme", "--port", "5000"], "--port is not accepted by `auth token`"],
      [["login", "acme", "--device", "--loopback"], "auth login: --device and --loopback are mutually exclusive"],
      [["login", "acme", "--port", "abc"], "auth login: --port expected an integer in 1024..65535"],
      [["login", "acme", "--port", "80"], "auth login: --port expected an integer in 1024..65535"],
    ];
    for (const [argv, message] of cases) {
      const r = await auth([...argv, ...byPath()]);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err, argv.join(" ")).toContain(message);
      expect(r.urls, argv.join(" ")).toEqual([]);
    }
    // an unknown flag is the dispatcher's friendly parse error (exit 2, usage shown)
    const errCap = capture("stderr");
    const code = await main(["auth", "status", "--no-such-flag"]);
    errCap.restore();
    expect(code).toBe(2);
    expect(errCap.text()).toContain("usage: agent-connector auth login <key>");
  });
});

describe("auth — branded CLI (createConnectorCli)", () => {
  it("auto-scopes `auth` to the package's connector config", async () => {
    const cfg = writeConfigJson(join(tmp, "pkg"), "brand-conn");
    const cli = createConnectorCli({ name: "brand-conn", connector: cfg });
    const out = capture("stdout");
    const err = capture("stderr");
    let code: number;
    try {
      code = await cli.run(["auth", "status", "--json", "--project", tmp]);
    } finally {
      out.restore();
      err.restore();
    }
    expect(code, err.text()).toBe(0);
    expect((JSON.parse(out.text()) as { key: string; present: boolean }[]).map((s) => [s.key, s.present])).toEqual([
      ["acme", false],
      ["beta", false],
    ]);

    // and the branded per-command help reads as the developer's tool
    const help = capture("stdout");
    const helpCode = await cli.run(["auth", "--help"]);
    help.restore();
    expect(helpCode).toBe(0);
    expect(help.text()).toContain(`usage: brand-conn ${AUTH_USAGE_LINES[0]}`);
  });
});
