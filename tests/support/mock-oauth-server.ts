/**
 * tests/support/mock-oauth-server — an OAuth 2.0 authorization server on
 * 127.0.0.1 for the engine and CLI tests. No provider is contacted; every
 * request is recorded; every response shape follows the RFC that defines it.
 *
 * Routes (under `url`; metadata under `issuer` = `url` + `issuerPath`):
 *   GET  /.well-known/oauth-authorization-server[<issuerPath>]  RFC 8414 §3 (the
 *        well-known segment is inserted between host and issuer path); off with
 *        `oauthMetadata: false`.
 *   GET  [<issuerPath>]/.well-known/openid-configuration  OpenID Connect
 *        Discovery 1.0 §4 (same document); on with `oidc: true`.
 *   GET  /authorize      RFC 6749 §4.1.1. Records the query. `autoApprove`
 *        (default) redirects to redirect_uri with `code` + `state`; `deny`
 *        redirects with `error=access_denied`; `autoApprove: false` answers
 *        200 and never redirects (the flow hangs until the client gives up).
 *   POST /token          RFC 6749 §4.1.3 authorization_code (PKCE S256 verified
 *        when `pkce`, RFC 7636 §4.6), §6 refresh_token (rotated when
 *        `rotateRefreshTokens`), RFC 8628 §3.4 device_code (scripted by
 *        `deviceSequence`).
 *   POST /device_authorization  RFC 8628 §3.2; `interval` from `deviceInterval`.
 *   POST /revoke         RFC 7009: 200 with an empty body; a revoked refresh
 *        token stops refreshing.
 *   GET  /device         the verification page (200, HTML).
 * Client authentication at /token and /revoke follows `clientAuth`:
 *   "post"  client_id + client_secret in the form body (RFC 6749 §2.3.1),
 *   "basic" Authorization: Basic base64(urlencode(id):urlencode(secret)); a
 *           client_secret in the body is rejected (§2.3: one method only),
 *   "none"  public client: client_id in the body only.
 * Issued strings are prefixed `mock-code-`, `mock-access-`, `mock-refresh-`
 * and `mock-device-` so a test can assert that none of them leaked anywhere.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type MockClientAuth = "post" | "basic" | "none";
export type MockDeviceStep = "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "ok";

export interface MockOAuthServerOptions {
  /** Serve `/.well-known/oauth-authorization-server` (default true). */
  oauthMetadata?: boolean;
  /** Also serve `/.well-known/openid-configuration` (default false). */
  oidc?: boolean;
  /** Path component of the issuer, e.g. "/tenant-a" (default "": the issuer is the origin). */
  issuerPath?: string;
  /** Advertise `device_authorization_endpoint` in the metadata (default true). */
  advertiseDevice?: boolean;
  /** Require and verify PKCE S256 (default false). */
  pkce?: boolean;
  /** How the client must authenticate at /token and /revoke (default "post"). */
  clientAuth?: MockClientAuth;
  clientId?: string;
  clientSecret?: string;
  /** /authorize redirects with a code at once (default true). */
  autoApprove?: boolean;
  /** /authorize redirects with error=access_denied (default false). */
  deny?: boolean;
  /** Return a new refresh token on every refresh and retire the old one (default false). */
  rotateRefreshTokens?: boolean;
  /** Omit refresh_token from the authorization-code / device responses (default false). */
  issueRefreshToken?: boolean;
  /** Answer every refresh with `invalid_grant` (default false). */
  rejectRefresh?: boolean;
  /** `expires_in` of every access token, seconds (default 3600). */
  accessTokenTtl?: number;
  /** Omit `expires_in` from every token response (a provider that does not state a lifetime; default false). */
  omitExpiresIn?: boolean;
  /** Outcomes of successive device-code polls; the last entry repeats (default ["ok"]). */
  deviceSequence?: MockDeviceStep[];
  /** `interval` in the device authorization response, seconds (default 1). */
  deviceInterval?: number;
  /** Include `verification_uri_complete` in the device authorization response (default false). */
  verificationUriComplete?: boolean;
}

export interface MockOAuthRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Record<string, string>;
  at: number;
}

export interface MockIssuedToken {
  grant: "authorization_code" | "refresh_token" | "device_code";
  accessToken: string;
  refreshToken?: string;
  scope: string;
}

export interface MockOAuthServer {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** `url` + `issuerPath`. */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint: string;
  revocationEndpoint: string;
  clientId: string;
  clientSecret: string;
  /** Every request, in order. */
  requests: MockOAuthRequest[];
  /** Every token response, in order. */
  tokensIssued: MockIssuedToken[];
  /** Timestamps (ms) of the device_code polls. */
  devicePolls: number[];
  /** Tokens presented to /revoke. */
  revoked: string[];
  /** Register a refresh token the server will accept (for refresh tests); returns it. */
  seedRefreshToken(scope?: string, token?: string): string;
  /** Whether `token` currently refreshes. */
  refreshTokenActive(token: string): boolean;
  close(): Promise<void>;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge?: string;
  used: boolean;
}

interface DeviceCode {
  userCode: string;
  scope: string;
  steps: MockDeviceStep[];
}

let counter = 0;
function fresh(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}-${randomBytes(6).toString("hex")}`;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function toRecord(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    pragma: "no-cache",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function oauthError(res: ServerResponse, error: string, description?: string, status = 400): void {
  sendJson(res, status, { error, ...(description ? { error_description: description } : {}) });
}

export async function startMockOAuthServer(options: MockOAuthServerOptions = {}): Promise<MockOAuthServer> {
  const oauthMetadata = options.oauthMetadata ?? true;
  const oidc = options.oidc ?? false;
  const issuerPath = options.issuerPath ?? "";
  const advertiseDevice = options.advertiseDevice ?? true;
  const pkce = options.pkce ?? false;
  const clientAuth: MockClientAuth = options.clientAuth ?? "post";
  const clientId = options.clientId ?? "mock-client";
  const clientSecret = options.clientSecret ?? "mock-client-secret";
  const autoApprove = options.autoApprove ?? true;
  const deny = options.deny ?? false;
  const rotate = options.rotateRefreshTokens ?? false;
  const issueRefreshToken = options.issueRefreshToken ?? true;
  const rejectRefresh = options.rejectRefresh ?? false;
  const accessTokenTtl = options.accessTokenTtl ?? 3600;
  const omitExpiresIn = options.omitExpiresIn ?? false;
  const deviceSequence: MockDeviceStep[] = options.deviceSequence ? [...options.deviceSequence] : ["ok"];
  const deviceInterval = options.deviceInterval ?? 1;
  const verificationUriComplete = options.verificationUriComplete ?? false;

  const requests: MockOAuthRequest[] = [];
  const tokensIssued: MockIssuedToken[] = [];
  const devicePolls: number[] = [];
  const revoked: string[] = [];
  const codes = new Map<string, AuthorizationCode>();
  const refreshTokens = new Map<string, { scope: string; active: boolean }>();
  const deviceCodes = new Map<string, DeviceCode>();

  let url = "";
  const endpoint = (p: string): string => `${url}${p}`;

  function metadata(): Record<string, unknown> {
    return {
      issuer: `${url}${issuerPath}`,
      authorization_endpoint: endpoint("/authorize"),
      token_endpoint: endpoint("/token"),
      ...(advertiseDevice ? { device_authorization_endpoint: endpoint("/device_authorization") } : {}),
      revocation_endpoint: endpoint("/revoke"),
      response_types_supported: ["code"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        ...(advertiseDevice ? ["urn:ietf:params:oauth:grant-type:device_code"] : []),
      ],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        clientAuth === "post" ? "client_secret_post" : clientAuth === "basic" ? "client_secret_basic" : "none",
      ],
    };
  }

  function issue(grant: MockIssuedToken["grant"], scope: string, withRefresh: boolean): Record<string, unknown> {
    const accessToken = fresh("mock-access-");
    const record: MockIssuedToken = { grant, accessToken, scope };
    const body: Record<string, unknown> = {
      access_token: accessToken,
      token_type: "Bearer",
      ...(omitExpiresIn ? {} : { expires_in: accessTokenTtl }),
      scope,
    };
    if (withRefresh) {
      const refreshToken = fresh("mock-refresh-");
      refreshTokens.set(refreshToken, { scope, active: true });
      record.refreshToken = refreshToken;
      body.refresh_token = refreshToken;
    }
    tokensIssued.push(record);
    return body;
  }

  /** RFC 6749 §2.3.1 / RFC 7009 §2.1 client authentication. Returns an error name or null. */
  function authenticate(req: IncomingMessage, body: Record<string, string>): { error: string; description: string; status: number } | null {
    const header = req.headers.authorization;
    if (clientAuth === "basic") {
      if (body.client_secret !== undefined) {
        return { error: "invalid_request", description: "client_secret in the body with HTTP Basic authentication", status: 400 };
      }
      if (!header || !header.startsWith("Basic ")) {
        return { error: "invalid_client", description: "HTTP Basic client authentication required", status: 401 };
      }
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      const id = decodeURIComponent(sep < 0 ? decoded : decoded.slice(0, sep));
      const secret = sep < 0 ? "" : decodeURIComponent(decoded.slice(sep + 1));
      if (id !== clientId || secret !== clientSecret) {
        return { error: "invalid_client", description: "client authentication failed", status: 401 };
      }
      return null;
    }
    if (body.client_id !== clientId) {
      return { error: "invalid_client", description: "unknown client_id", status: 401 };
    }
    if (clientAuth === "post" && body.client_secret !== clientSecret) {
      return { error: "invalid_client", description: "client authentication failed", status: 401 };
    }
    return null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = new URL(req.url ?? "/", url);
    const raw = await readBody(req);
    const body = toRecord(new URLSearchParams(raw));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : (v ?? "");
    requests.push({
      method: req.method ?? "GET",
      path: parsed.pathname,
      query: toRecord(parsed.searchParams),
      headers,
      body,
      at: Date.now(),
    });
    const method = req.method ?? "GET";
    const path = parsed.pathname;

    if (method === "GET" && oauthMetadata && path === `/.well-known/oauth-authorization-server${issuerPath}`) {
      return sendJson(res, 200, metadata());
    }
    if (method === "GET" && oidc && path === `${issuerPath}/.well-known/openid-configuration`) {
      return sendJson(res, 200, metadata());
    }

    if (method === "GET" && path === "/authorize") {
      const q = parsed.searchParams;
      const redirectUri = q.get("redirect_uri");
      if (q.get("client_id") !== clientId || !redirectUri) {
        return oauthError(res, "invalid_request", "client_id or redirect_uri missing or unknown");
      }
      const target = new URL(redirectUri);
      const state = q.get("state");
      if (state !== null) target.searchParams.set("state", state);
      const fail = (error: string, description: string): void => {
        target.searchParams.set("error", error);
        target.searchParams.set("error_description", description);
        res.writeHead(302, { location: target.toString() });
        res.end();
      };
      if (q.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
      const challenge = q.get("code_challenge");
      if (pkce && !challenge) return fail("invalid_request", "code_challenge required");
      if (challenge && q.get("code_challenge_method") !== "S256") {
        return fail("invalid_request", "code_challenge_method must be S256");
      }
      if (deny) return fail("access_denied", "the user denied the request");
      if (!autoApprove) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body>authorization pending</body></html>");
        return;
      }
      const code = fresh("mock-code-");
      codes.set(code, {
        clientId,
        redirectUri,
        scope: q.get("scope") ?? "",
        ...(challenge ? { codeChallenge: challenge } : {}),
        used: false,
      });
      target.searchParams.set("code", code);
      res.writeHead(302, { location: target.toString() });
      res.end();
      return;
    }

    if (method === "GET" && path === "/device") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body>enter your code</body></html>");
      return;
    }

    if (method === "POST" && path === "/device_authorization") {
      if (body.client_id !== clientId) return oauthError(res, "invalid_client", "unknown client_id", 401);
      const deviceCode = fresh("mock-device-");
      const userCode = `${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
      deviceCodes.set(deviceCode, { userCode, scope: body.scope ?? "", steps: [...deviceSequence] });
      return sendJson(res, 200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: endpoint("/device"),
        ...(verificationUriComplete ? { verification_uri_complete: `${endpoint("/device")}?user_code=${userCode}` } : {}),
        expires_in: 600,
        interval: deviceInterval,
      });
    }

    if (method === "POST" && path === "/token") {
      const auth = authenticate(req, body);
      if (auth) {
        return oauthError(res, auth.error, auth.description, auth.status);
      }
      const grant = body.grant_type;
      if (grant === "authorization_code") {
        const record = body.code ? codes.get(body.code) : undefined;
        if (!record || record.used) return oauthError(res, "invalid_grant", "unknown or used code");
        if (body.redirect_uri !== record.redirectUri) return oauthError(res, "invalid_grant", "redirect_uri mismatch");
        if (record.codeChallenge !== undefined) {
          if (!body.code_verifier || s256(body.code_verifier) !== record.codeChallenge) {
            return oauthError(res, "invalid_grant", "PKCE verification failed");
          }
        } else if (pkce) {
          return oauthError(res, "invalid_grant", "code issued without a code_challenge");
        }
        record.used = true;
        return sendJson(res, 200, issue("authorization_code", record.scope, issueRefreshToken));
      }
      if (grant === "refresh_token") {
        const current = body.refresh_token ? refreshTokens.get(body.refresh_token) : undefined;
        if (!current || !current.active || rejectRefresh) {
          return oauthError(res, "invalid_grant", "refresh token is unknown, revoked or expired");
        }
        if (rotate) {
          current.active = false;
          return sendJson(res, 200, issue("refresh_token", current.scope, true));
        }
        return sendJson(res, 200, issue("refresh_token", current.scope, false));
      }
      if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
        devicePolls.push(Date.now());
        const record = body.device_code ? deviceCodes.get(body.device_code) : undefined;
        if (!record) return oauthError(res, "invalid_grant", "unknown device_code");
        const step = record.steps.length > 1 ? record.steps.shift()! : (record.steps[0] ?? "ok");
        if (step === "ok") {
          deviceCodes.delete(body.device_code!);
          return sendJson(res, 200, issue("device_code", record.scope, issueRefreshToken));
        }
        return oauthError(res, step);
      }
      return oauthError(res, "unsupported_grant_type", `grant_type ${String(grant)} is not supported`);
    }

    if (method === "POST" && path === "/revoke") {
      const auth = authenticate(req, body);
      if (auth) return oauthError(res, auth.error, auth.description, auth.status);
      if (!body.token) return oauthError(res, "invalid_request", "token required");
      revoked.push(body.token);
      const current = refreshTokens.get(body.token);
      if (current) current.active = false;
      res.writeHead(200, { "content-length": "0" });
      res.end();
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: "server_error", error_description: String(err) });
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  url = `http://127.0.0.1:${port}`;

  return {
    url,
    issuer: `${url}${issuerPath}`,
    authorizationEndpoint: endpoint("/authorize"),
    tokenEndpoint: endpoint("/token"),
    deviceAuthorizationEndpoint: endpoint("/device_authorization"),
    revocationEndpoint: endpoint("/revoke"),
    clientId,
    clientSecret,
    requests,
    tokensIssued,
    devicePolls,
    revoked,
    seedRefreshToken(scope = "", token = fresh("mock-refresh-")) {
      refreshTokens.set(token, { scope, active: true });
      return token;
    },
    refreshTokenActive(token) {
      return refreshTokens.get(token)?.active === true;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
