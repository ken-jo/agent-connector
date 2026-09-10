/**
 * core/oauth/engine — the generic OAuth 2.0 client behind `auth login|status|
 * logout|token` and the SDK's `getAccessToken`.
 *
 *   resolveLogin     preset → connector overrides → RFC 8414 / OIDC discovery;
 *                    a `${secret:NAME}` client id or secret is read from the
 *                    secret store; a `tokenExchangeUrl` reroutes every
 *                    token-endpoint request to the connector's own service
 *   login            authorization code + PKCE over a 127.0.0.1 redirect, or the
 *                    device grant; the refresh token goes to the secret store,
 *                    a non-secret record to `<dataRoot>/oauth/<id>.json`
 *   getAccessToken   per-process cache → refresh grant → (interactive) login
 *   logout           best-effort revocation, then secret + record removal
 *   loginStatus      metadata + "does the store hold the refresh token" (no network)
 *
 * Refresh tokens exist only inside the secret store; access tokens only in
 * process memory (and on `auth token`'s stdout); neither ever reaches a log
 * line, an error message or the metadata file.
 */

import { readRegisteredMeta } from "../load-connector.js";
import { resolve as resolvePath } from "node:path";

import { dataRoot as resolveDataRoot } from "../paths.js";
import { resolveEnvRefs } from "../interpolate.js";
import { SecretResolutionError, openSecretStore, wholeSecretRefName } from "../secrets.js";
import type { OpenSecretStoreOptions, SecretBackendId, SecretStore } from "../secrets.js";
import type { OAuthFlow, OAuthPresetId, OAuthTokenEndpointAuth, ResolvedOAuthLoginDef } from "../types.js";
import { canOpenBrowser, openBrowser as defaultOpenBrowser } from "./browser.js";
import { deviceCodePrompt, pollDeviceToken, requestDeviceAuthorization } from "./device.js";
import type { DeviceClient } from "./device.js";
import { OAuthError, OAuthLoginRequiredError, sanitizeProviderText } from "./errors.js";
import { applyClientAuth, assertSecureEndpoint, getJson, postForm, providerError } from "./http.js";
import type { HttpOptions } from "./http.js";
import { startLoopback } from "./loopback.js";
import { readMetadata, updateLoginRecord } from "./metadata.js";
import type { LoginRecord } from "./metadata.js";
import { createPkcePair, randomState } from "./pkce.js";
import { RESERVED_AUTHORIZATION_PARAMS } from "./reserved.js";
import { getOAuthPreset } from "./presets.js";
import type { OAuthPreset } from "./presets.js";

// ── Discovery ─────────────────────────────────────────────────────────────

export interface OAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint?: string;
  revocationEndpoint?: string;
  /** The login's token exchange service; when set, every token-endpoint request goes here instead of `tokenEndpoint`. */
  tokenExchangeUrl?: string;
}

export interface OAuthNetOptions {
  fetch?: typeof fetch;
  /** Per HTTP call; default 20_000. */
  timeoutMs?: number;
  /** Aborts the HTTP calls (and, on `login`, the wait for the user). */
  signal?: AbortSignal;
}

const discoveryCache = new Map<string, Promise<OAuthEndpoints>>();

/** Test seam: forget discovered endpoints (the cache lives for the process). */
export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * The well-known URLs for `issuer`, RFC 8414 §3.1 first (the suffix is inserted
 * between host and path), then OpenID Connect Discovery (appended), then the
 * RFC 8414 §5 compatibility form of the OIDC document for issuers with a path.
 */
export function discoveryUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  const origin = `${u.protocol}//${u.host}`;
  const urls = [`${origin}/.well-known/oauth-authorization-server${path}`, `${origin}${path}/.well-known/openid-configuration`];
  if (path !== "") urls.push(`${origin}/.well-known/openid-configuration${path}`);
  return urls;
}

/** Discovery for `issuer`; the result is cached per process (a cached lookup ignores `signal`). */
export async function discoverEndpoints(issuer: string, opts: OAuthNetOptions = {}): Promise<OAuthEndpoints> {
  const key = issuer.replace(/\/+$/, "");
  const cached = discoveryCache.get(key);
  if (cached) return cached;
  const pending = discover(key, opts).catch((err: unknown) => {
    discoveryCache.delete(key);
    throw err;
  });
  discoveryCache.set(key, pending);
  return pending;
}

async function discover(issuer: string, opts: OAuthNetOptions): Promise<OAuthEndpoints> {
  const parsed = assertSecureEndpoint(issuer, "issuer");
  const net: HttpOptions = { fetch: opts.fetch, timeoutMs: opts.timeoutMs, signal: opts.signal };
  const tried: string[] = [];
  for (const url of discoveryUrls(parsed.toString())) {
    tried.push(url);
    const { body } = await getJson(url, net);
    if (!body) continue;
    const auth = body.authorization_endpoint;
    const token = body.token_endpoint;
    // A JSON body that is not a metadata document (a catch-all API) does not
    // end the search; the next well-known location may still answer.
    if (typeof auth !== "string" || typeof token !== "string") continue;
    // The document must describe the issuer it was fetched for (RFC 8414 §3.3);
    // the comparison is by host because some providers publish a templated
    // issuer path (Microsoft's `{tenantid}`).
    if (typeof body.issuer === "string") {
      try {
        if (new URL(body.issuer).host !== parsed.host) {
          throw new OAuthError("discovery", `${url}: the metadata document belongs to ${body.issuer}, not ${issuer}`);
        }
      } catch (err) {
        if (err instanceof OAuthError) throw err;
        throw new OAuthError("discovery", `${url}: the metadata document carries an invalid issuer`);
      }
    }
    return {
      authorizationEndpoint: auth,
      tokenEndpoint: token,
      ...(typeof body.device_authorization_endpoint === "string"
        ? { deviceAuthorizationEndpoint: body.device_authorization_endpoint }
        : {}),
      ...(typeof body.revocation_endpoint === "string" ? { revocationEndpoint: body.revocation_endpoint } : {}),
    };
  }
  throw new OAuthError(
    "discovery",
    `no authorization server metadata at ${issuer} (tried ${tried.join(", ")})`,
    "set authorizationEndpoint and tokenEndpoint on the login instead of issuer",
  );
}

// ── Resolution ────────────────────────────────────────────────────────────

export interface ResolvedLogin {
  key: string;
  def: ResolvedOAuthLoginDef;
  preset: OAuthPreset;
  endpoints: OAuthEndpoints;
  clientId: string;
  clientSecret?: string;
  pkce: boolean;
  tokenEndpointAuth: OAuthTokenEndpointAuth;
  /** Scopes joined with the preset's separator. */
  scope: string;
}

export interface ResolveLoginOptions extends OAuthNetOptions {
  connectorId: string;
  env?: NodeJS.ProcessEnv;
  secretStore?: OpenSecretStoreOptions;
}

/** Test seam: the `OpenSecretStoreOptions` passthrough without its `connectorId` (the engine supplies that). */
type StorePassthrough = Partial<Omit<OpenSecretStoreOptions, "connectorId">>;

/**
 * The store options for `connectorId`: the caller's passthrough, with the
 * data root and environment the engine resolved (so the metadata file and
 * the secret store always come from the same root, whichever `env` the
 * caller supplied).
 */
function storeOptions(connectorId: string, passthrough: OpenSecretStoreOptions | undefined, env: NodeJS.ProcessEnv): OpenSecretStoreOptions {
  const rest: StorePassthrough = { ...(passthrough ?? {}) };
  delete (rest as { connectorId?: string }).connectorId;
  return { env, ...rest, connectorId, dataRoot: dataRootOf(passthrough, env) };
}

/**
 * `secretStore.dataRoot`, else `AGENT_CONNECTOR_DATA_DIR` from `env`, else the
 * process's own override (a caller-supplied `env` serves `${env:VAR}` expansion
 * and the browser check; a partial one must not relocate the data root), else
 * the default root.
 */
function dataRootOf(passthrough: OpenSecretStoreOptions | undefined, env: NodeJS.ProcessEnv): string {
  if (passthrough?.dataRoot) return passthrough.dataRoot;
  const override = env.AGENT_CONNECTOR_DATA_DIR;
  if (override && override.trim() !== "") return resolvePath(override);
  return resolveDataRoot();
}

/**
 * The `${secret:NAME}` names a login's `clientId` and `clientSecret` reference
 * (clientId first, deduped); `[]` when both are literals. Install and doctor
 * name these before `auth login` can run.
 */
export function loginSecretNames(def: ResolvedOAuthLoginDef): string[] {
  const names: string[] = [];
  for (const value of [def.clientId, def.clientSecret]) {
    const name = value === undefined ? null : wholeSecretRefName(value);
    if (name !== null && !names.includes(name)) names.push(name);
  }
  return names;
}

export async function resolveLogin(def: ResolvedOAuthLoginDef, opts: ResolveLoginOptions): Promise<ResolvedLogin> {
  const where = `oauth.${def.key}`;
  const env = opts.env ?? process.env;
  const preset = getOAuthPreset(def.provider);
  const fromPreset = preset.resolve ? preset.resolve(def) : {};
  const issuer = def.issuer ?? fromPreset.issuer ?? preset.issuer;
  let authorizationEndpoint = def.authorizationEndpoint ?? fromPreset.authorizationEndpoint ?? preset.authorizationEndpoint;
  let tokenEndpoint = def.tokenEndpoint ?? fromPreset.tokenEndpoint ?? preset.tokenEndpoint;
  let deviceAuthorizationEndpoint =
    def.deviceAuthorizationEndpoint ?? fromPreset.deviceAuthorizationEndpoint ?? preset.deviceAuthorizationEndpoint;
  let revocationEndpoint = def.revocationEndpoint ?? fromPreset.revocationEndpoint ?? preset.revocationEndpoint;

  if ((!authorizationEndpoint || !tokenEndpoint) && issuer) {
    const discovered = await discoverEndpoints(issuer, opts);
    authorizationEndpoint ??= discovered.authorizationEndpoint;
    tokenEndpoint ??= discovered.tokenEndpoint;
    deviceAuthorizationEndpoint ??= discovered.deviceAuthorizationEndpoint;
    revocationEndpoint ??= discovered.revocationEndpoint;
  }
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new OAuthError("config", `${where}: no authorization/token endpoint — set issuer, or authorizationEndpoint and tokenEndpoint`);
  }
  assertSecureEndpoint(authorizationEndpoint, `${where}.authorizationEndpoint`);
  assertSecureEndpoint(tokenEndpoint, `${where}.tokenEndpoint`);
  if (deviceAuthorizationEndpoint) assertSecureEndpoint(deviceAuthorizationEndpoint, `${where}.deviceAuthorizationEndpoint`);
  if (revocationEndpoint) assertSecureEndpoint(revocationEndpoint, `${where}.revocationEndpoint`);

  const tokenExchangeUrl = def.tokenExchangeUrl;
  if (tokenExchangeUrl !== undefined) assertSecureEndpoint(tokenExchangeUrl, `${where}.tokenExchangeUrl`);
  if (tokenExchangeUrl !== undefined && def.clientSecret !== undefined) {
    throw new OAuthError(
      "config",
      `${where}: clientSecret and tokenExchangeUrl are exclusive — the token exchange service holds the client secret`,
    );
  }

  // Both credentials read the store the refresh token goes to, so a caller's
  // backend choice applies to all three. SecretResolutionError when unset.
  let opened: SecretStore | undefined;
  const store = (): SecretStore => (opened ??= openSecretStore(storeOptions(opts.connectorId, opts.secretStore, env)));
  let clientId: string;
  const clientIdRef = wholeSecretRefName(def.clientId);
  if (clientIdRef !== null) {
    // Each user registered their own app and stored its id with `secrets set`.
    const value = store().get(clientIdRef);
    if (value === null) throw new SecretResolutionError(opts.connectorId, [clientIdRef], `${where}.clientId`);
    clientId = value;
  } else {
    clientId = resolveEnvRefs(def.clientId, env).trim();
    if (clientId === "") {
      throw new OAuthError("config", `${where}.clientId: "${def.clientId}" resolves to an empty value`);
    }
  }
  let clientSecret: string | undefined;
  if (def.clientSecret !== undefined) {
    const name = wholeSecretRefName(def.clientSecret);
    if (name === null) {
      // A literal: defineConnector admits one only for a preset whose provider
      // documents the secret as not confidential; used verbatim, never expanded.
      clientSecret = def.clientSecret;
    } else {
      const value = store().get(name);
      if (value === null) throw new SecretResolutionError(opts.connectorId, [name], `${where}.clientSecret`);
      clientSecret = value;
    }
  }
  const pkce = def.pkce ?? preset.pkce;
  // No client secret → `client_id` only. An exchange login never carries one
  // (the exclusivity check above), so through a service the connector is a
  // public client whatever `tokenEndpointAuth` says; the service adds the secret.
  const tokenEndpointAuth: OAuthTokenEndpointAuth =
    clientSecret === undefined ? "none" : (def.tokenEndpointAuth ?? preset.tokenEndpointAuth);
  const scope = def.scopes.join(preset.scopeSeparator ?? " ");
  return {
    key: def.key,
    def,
    preset,
    endpoints: {
      authorizationEndpoint,
      tokenEndpoint,
      ...(deviceAuthorizationEndpoint ? { deviceAuthorizationEndpoint } : {}),
      ...(revocationEndpoint ? { revocationEndpoint } : {}),
      ...(tokenExchangeUrl !== undefined ? { tokenExchangeUrl } : {}),
    },
    clientId,
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    pkce,
    tokenEndpointAuth,
    scope,
  };
}

// ── Tokens ────────────────────────────────────────────────────────────────

export interface TokenSet {
  accessToken: string;
  tokenType: string;
  /** ms since the epoch. */
  expiresAt?: number;
  refreshToken?: string;
  scope?: string;
  idToken?: string;
}

function toTokenSet(body: Record<string, unknown>, what: string): TokenSet {
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new OAuthError("token", `${what}: the response carried no access_token`);
  }
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    tokenType: typeof body.token_type === "string" && body.token_type !== "" ? body.token_type : "Bearer",
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    ...(typeof body.refresh_token === "string" && body.refresh_token !== "" ? { refreshToken: body.refresh_token } : {}),
    ...(typeof body.scope === "string" && body.scope !== "" ? { scope: body.scope } : {}),
    ...(typeof body.id_token === "string" ? { idToken: body.id_token } : {}),
  };
}

/** The token set handed to callers: the refresh token stays in the secret store. */
function withoutRefreshToken(set: TokenSet): TokenSet {
  const { refreshToken: _omit, ...rest } = set;
  return rest;
}

const EXPIRY_SKEW_MS = 60_000;
/** A token without `expires_in` is reused for this long. */
const UNKNOWN_LIFETIME_MS = 3_600_000;

interface CacheEntry {
  set: TokenSet;
  obtainedAt: number;
}

const tokenCache = new Map<string, CacheEntry>();

/** Test seam: drop every cached access token. */
export function clearAccessTokenCache(): void {
  tokenCache.clear();
}

function cacheKey(connectorId: string, key: string): string {
  return `${connectorId}/${key}`;
}

function isFresh(entry: CacheEntry, now = Date.now()): boolean {
  if (entry.set.expiresAt !== undefined) return now < entry.set.expiresAt - EXPIRY_SKEW_MS;
  return now < entry.obtainedAt + UNKNOWN_LIFETIME_MS;
}

function clientOf(resolved: ResolvedLogin): DeviceClient {
  return {
    clientId: resolved.clientId,
    ...(resolved.clientSecret !== undefined ? { clientSecret: resolved.clientSecret } : {}),
    tokenEndpointAuth: resolved.tokenEndpointAuth,
    ...(resolved.preset.tokenRequestHeaders ? { headers: resolved.preset.tokenRequestHeaders } : {}),
  };
}

/**
 * Where every token-endpoint request goes: the login's token exchange service
 * when it names one (the code exchange, refresh and device-code polling alike),
 * else the provider's token endpoint.
 */
function tokenUrl(resolved: ResolvedLogin): string {
  return resolved.endpoints.tokenExchangeUrl ?? resolved.endpoints.tokenEndpoint;
}

async function tokenRequest(
  resolved: ResolvedLogin,
  params: Record<string, string>,
  net: HttpOptions,
  what: string,
): Promise<Record<string, unknown>> {
  const client = clientOf(resolved);
  const headers: Record<string, string> = { ...(client.headers ?? {}) };
  const body: Record<string, string> = { ...params };
  applyClientAuth(client.tokenEndpointAuth, client.clientId, client.clientSecret, body, headers);
  const res = await postForm(tokenUrl(resolved), body, { ...net, headers, what });
  if (res.status >= 400 || typeof res.body.error === "string") throw providerError(res.body, res.status, what);
  return res.body;
}

export function buildAuthorizationUrl(
  resolved: ResolvedLogin,
  params: { redirectUri: string; state: string; codeChallenge?: string },
): string {
  const url = new URL(resolved.endpoints.authorizationEndpoint);
  // Extras go first: the parameters that bind the response (redirect_uri,
  // state, the PKCE challenge) are set after them and cannot be overridden.
  const extra = { ...(resolved.preset.extraAuthorizationParams ?? {}), ...(resolved.def.extraAuthorizationParams ?? {}) };
  for (const [k, v] of Object.entries(extra)) {
    if (!RESERVED_AUTHORIZATION_PARAMS.has(k)) url.searchParams.set(k, v);
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", resolved.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", resolved.scope);
  url.searchParams.set("state", params.state);
  if (params.codeChallenge) {
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  } else {
    url.searchParams.delete("code_challenge");
    url.searchParams.delete("code_challenge_method");
  }
  return url.toString();
}

// ── Login ─────────────────────────────────────────────────────────────────

export interface LoginOptions extends OAuthNetOptions {
  connectorId: string;
  key: string;
  def: ResolvedOAuthLoginDef;
  /** Overrides `def.flow`. */
  flow?: OAuthFlow;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Passthrough to the secret store (dataRoot, backend, exec…). */
  secretStore?: OpenSecretStoreOptions;
  /** Default: {@link openBrowser}. */
  openBrowser?: (url: string) => Promise<void> | void;
  /** Default: stderr. */
  log?: (line: string) => void;
  /** Whole flow; default 300_000. */
  loginTimeoutMs?: number;
  /** Test seam: the pause between device-flow polls. */
  sleep?: (ms: number) => Promise<void>;
}

export interface LoginResult {
  key: string;
  provider: OAuthPresetId;
  obtainedVia: "loopback" | "device";
  backend: SecretBackendId;
  scope?: string;
  expiresAt?: number;
}

export const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;

const stderrLog = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** The flow a login runs: the caller's choice, else the connector's, `auto` decided here. */
export function chooseFlow(
  requested: OAuthFlow,
  resolved: ResolvedLogin,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): "loopback" | "device" {
  const deviceEndpoint = resolved.endpoints.deviceAuthorizationEndpoint;
  if (requested === "device") {
    if (!deviceEndpoint) {
      throw new OAuthError(
        "config",
        `oauth.${resolved.key}: ${resolved.preset.label} has no device authorization endpoint`,
        "run the login without --device, or set deviceAuthorizationEndpoint on the login",
      );
    }
    return "device";
  }
  if (requested === "loopback") return "loopback";
  if (canOpenBrowser(env, platform)) return "loopback";
  const deviceKnown = deviceEndpoint !== undefined && (resolved.preset.deviceFlow || resolved.def.deviceAuthorizationEndpoint !== undefined);
  return deviceKnown ? "device" : "loopback";
}

export async function login(opts: LoginOptions): Promise<LoginResult> {
  const { connectorId, key, def } = opts;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const log = opts.log ?? stderrLog;
  const net: HttpOptions = { fetch: opts.fetch, timeoutMs: opts.timeoutMs, signal: opts.signal };
  const resolved = await resolveLogin(def, {
    connectorId,
    env,
    secretStore: opts.secretStore,
    fetch: opts.fetch,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  const flow = chooseFlow(opts.flow ?? def.flow, resolved, env, platform);
  const deadline = Date.now() + (opts.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
  // The URL as configured, so the user can match it to the connector's docs.
  if (resolved.endpoints.tokenExchangeUrl !== undefined) {
    // The framework-owned line that says where tokens go: sanitized so a config
    // value can never redraw it (byte-identical for a well-formed URL).
    log(`Tokens are exchanged through ${sanitizeProviderText(resolved.endpoints.tokenExchangeUrl, 2048)} (the connector's token exchange service)`);
  }

  let body: Record<string, unknown>;
  if (flow === "device") {
    // The device authorization request goes to the provider itself, as a
    // public client; only the polling goes through the exchange service.
    const endpoint = resolved.endpoints.deviceAuthorizationEndpoint as string;
    const auth = await requestDeviceAuthorization(endpoint, clientOf(resolved), resolved.scope, net);
    log(deviceCodePrompt(auth));
    body = await pollDeviceToken(tokenUrl(resolved), clientOf(resolved), auth, {
      ...net,
      deadline: Math.min(deadline, Date.now() + auth.expiresIn * 1000),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
  } else {
    const server = await startLoopback({ port: def.redirectPort, path: def.redirectPath });
    try {
      const state = randomState();
      const pkce = resolved.pkce ? createPkcePair() : undefined;
      const url = buildAuthorizationUrl(resolved, { redirectUri: server.redirectUri, state, codeChallenge: pkce?.challenge });
      // The receiver is armed before the browser gets the URL, so a callback
      // that arrives while the opener is still running is not turned away.
      const callback = server.waitForCallback(state, Math.max(1, deadline - Date.now()), opts.signal, {
        requireState: resolved.preset.echoesState !== false || def.redirectPort === undefined,
      });
      callback.catch(() => undefined);
      // The URL is printed when no browser opens for it (the opener prints its
      // own line otherwise — the CLI announces "Opening … in your browser").
      if (canOpenBrowser(env, platform)) {
        try {
          await (opts.openBrowser ?? ((u: string) => defaultOpenBrowser(u, { platform, env })))(url);
        } catch (err) {
          log(`Could not open a browser (${err instanceof Error ? err.message : String(err)}). Authorize ${resolved.preset.label} at: ${url}`);
        }
      } else {
        log(`Authorize ${resolved.preset.label} at: ${url}`);
      }
      const { code } = await callback;
      body = await tokenRequest(
        resolved,
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: server.redirectUri,
          ...(pkce ? { code_verifier: pkce.verifier } : {}),
        },
        net,
        "token exchange",
      );
    } finally {
      await server.close();
    }
  }

  const set = toTokenSet(body, "login");
  if (!set.refreshToken) {
    throw new OAuthError(
      "token",
      `the provider returned no refresh token — ${resolved.preset.refreshTokenHint ?? "check that the provider issues refresh tokens for this client and scope"}`,
    );
  }
  const store = openSecretStore(storeOptions(connectorId, opts.secretStore, env));
  const entry = store.set(def.storeAs, set.refreshToken);
  const scope = set.scope ?? resolved.scope;
  const record: LoginRecord = {
    provider: def.provider,
    scope,
    obtainedAt: new Date().toISOString(),
    obtainedVia: flow,
    ...(set.expiresAt !== undefined ? { expiresAt: set.expiresAt } : {}),
    storeAs: def.storeAs,
    backend: entry.backend,
  };
  updateLoginRecord(dataRootOf(opts.secretStore, env), connectorId, key, record);
  tokenCache.set(cacheKey(connectorId, key), { set: withoutRefreshToken(set), obtainedAt: Date.now() });
  return {
    key,
    provider: def.provider,
    obtainedVia: flow,
    backend: entry.backend,
    scope,
    ...(set.expiresAt !== undefined ? { expiresAt: set.expiresAt } : {}),
  };
}

// ── Access tokens ─────────────────────────────────────────────────────────

export interface AccessTokenOptions extends OAuthNetOptions {
  connectorId: string;
  key: string;
  /** Default: the registered connector's `oauth[key]`; absent → OAuthError("config"). */
  def?: ResolvedOAuthLoginDef;
  /** Default "auto": log in when no refresh token is stored and a browser can be opened. */
  interactive?: "auto" | "never" | "always";
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  secretStore?: OpenSecretStoreOptions;
  openBrowser?: (url: string) => Promise<void> | void;
  log?: (line: string) => void;
  loginTimeoutMs?: number;
}

/** `oauth[key]` of the registered connector `connectorId`. */
export function registeredLoginDef(connectorId: string, key: string): ResolvedOAuthLoginDef {
  const meta = readRegisteredMeta(connectorId);
  if (!meta) {
    throw new OAuthError(
      "config",
      `connector ${connectorId} is not registered`,
      "install the connector first, or pass the login definition (def) explicitly",
    );
  }
  const logins = meta.oauth ?? {};
  const def = Object.prototype.hasOwnProperty.call(logins, key) ? logins[key] : undefined;
  if (!def) {
    const declared = Object.keys(logins);
    throw new OAuthError(
      "config",
      `connector ${connectorId} declares no login "${key}"${declared.length ? ` (declared: ${declared.join(", ")})` : ""}`,
    );
  }
  return def;
}

function readStoredRefreshToken(store: SecretStore, name: string): string | null {
  return store.get(name);
}

/** Refresh/login work in progress per `<connectorId>/<key>`: concurrent callers share one outcome. */
const inFlight = new Map<string, Promise<TokenSet>>();

export async function getAccessToken(opts: AccessTokenOptions): Promise<TokenSet> {
  const { connectorId, key } = opts;
  const def = opts.def ?? registeredLoginDef(connectorId, key);
  const interactive = opts.interactive ?? "auto";
  const ck = cacheKey(connectorId, key);

  if (interactive !== "always") {
    const cached = tokenCache.get(ck);
    if (cached && isFresh(cached)) return cached.set;
    // A refresh (or login) already under way answers every concurrent caller;
    // two refreshes with one rotating token would revoke each other.
    const pending = inFlight.get(ck);
    if (pending) return pending;
  }
  const work = obtainAccessToken(opts, def, interactive, ck).finally(() => {
    if (inFlight.get(ck) === work) inFlight.delete(ck);
  });
  inFlight.set(ck, work);
  return work;
}

async function obtainAccessToken(
  opts: AccessTokenOptions,
  def: ResolvedOAuthLoginDef,
  interactive: "auto" | "never" | "always",
  ck: string,
): Promise<TokenSet> {
  const { connectorId, key } = opts;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const net: HttpOptions = { fetch: opts.fetch, timeoutMs: opts.timeoutMs, signal: opts.signal };

  const store = openSecretStore(storeOptions(connectorId, opts.secretStore, env));
  const refreshToken = interactive === "always" ? null : readStoredRefreshToken(store, def.storeAs);
  if (refreshToken !== null) {
    const resolved = await resolveLogin(def, {
      connectorId,
      env,
      secretStore: opts.secretStore,
      fetch: opts.fetch,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    try {
      const body = await tokenRequest(resolved, { grant_type: "refresh_token", refresh_token: refreshToken }, net, "token refresh");
      const set = toTokenSet(body, "token refresh");
      // Rotation: the new refresh token is stored before anything returns.
      if (set.refreshToken && set.refreshToken !== refreshToken) store.set(def.storeAs, set.refreshToken);
      const visible = withoutRefreshToken(set);
      tokenCache.set(ck, { set: visible, obtainedAt: Date.now() });
      return visible;
    } catch (err) {
      if (!(err instanceof OAuthError && err.code === "provider" && err.providerCode === "invalid_grant")) throw err;
      // The provider no longer honors the refresh token: forget it (the record
      // keeps the time) and fall through to the interactive rule. Only the
      // value that failed is removed — a token another writer stored since
      // stays.
      try {
        if (store.get(def.storeAs) === refreshToken) store.delete(def.storeAs);
      } catch {
        /* the stale item is reported by loginStatus */
      }
      const root = dataRootOf(opts.secretStore, env);
      const existing = readMetadataTolerant(root, connectorId)[key];
      if (existing) updateLoginRecord(root, connectorId, key, { ...existing, revokedAt: new Date().toISOString() });
      tokenCache.delete(ck);
    }
  }

  const mayLogin = interactive === "always" || (interactive === "auto" && canOpenBrowser(env, platform));
  if (!mayLogin) throw new OAuthLoginRequiredError(connectorId, key);
  await login({
    connectorId,
    key,
    def,
    env,
    platform,
    secretStore: opts.secretStore,
    openBrowser: opts.openBrowser,
    log: opts.log,
    fetch: opts.fetch,
    timeoutMs: opts.timeoutMs,
    loginTimeoutMs: opts.loginTimeoutMs,
    signal: opts.signal,
  });
  const fresh = tokenCache.get(ck);
  if (!fresh) throw new OAuthError("token", "login completed without an access token");
  return fresh.set;
}

function readMetadataTolerant(root: string, connectorId: string): Record<string, LoginRecord> {
  try {
    return readMetadata(root, connectorId).logins;
  } catch {
    return {};
  }
}

// ── Logout ────────────────────────────────────────────────────────────────

export interface LogoutOptions extends OAuthNetOptions {
  connectorId: string;
  key: string;
  def?: ResolvedOAuthLoginDef;
  secretStore?: OpenSecretStoreOptions;
  env?: NodeJS.ProcessEnv;
}

export async function logout(opts: LogoutOptions): Promise<{ removed: boolean; revoked: boolean }> {
  const { connectorId, key } = opts;
  const env = opts.env ?? process.env;
  const root = dataRootOf(opts.secretStore, env);
  const record = readMetadataTolerant(root, connectorId)[key];
  let def = opts.def;
  if (!def) {
    try {
      def = registeredLoginDef(connectorId, key);
    } catch {
      def = undefined;
    }
  }
  const storeAs = def?.storeAs ?? record?.storeAs ?? `oauth.${key}.refresh-token`;
  const store = openSecretStore(storeOptions(connectorId, opts.secretStore, env));
  let refreshToken: string | null = null;
  try {
    refreshToken = store.get(storeAs);
  } catch {
    refreshToken = null;
  }
  let revoked = false;
  if (refreshToken !== null && def) {
    try {
      const resolved = await resolveLogin(def, {
        connectorId,
        env,
        secretStore: opts.secretStore,
        fetch: opts.fetch,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      });
      const endpoint = resolved.endpoints.revocationEndpoint;
      if (endpoint) {
        const client = clientOf(resolved);
        const headers: Record<string, string> = { ...(client.headers ?? {}) };
        const params: Record<string, string> = { token: refreshToken, token_type_hint: "refresh_token" };
        applyClientAuth(client.tokenEndpointAuth, client.clientId, client.clientSecret, params, headers);
        const res = await postForm(endpoint, params, { fetch: opts.fetch, timeoutMs: opts.timeoutMs, headers, what: "revocation" });
        revoked = res.status < 400;
      }
    } catch {
      revoked = false;
    }
  }
  // `removed` reports the secret alone: a record left behind by a revoked
  // token is cleared here too, but "nothing was stored" stays true.
  let removed = false;
  try {
    removed = store.delete(storeAs);
  } catch {
    removed = false;
  }
  if (record) updateLoginRecord(root, connectorId, key, null);
  tokenCache.delete(cacheKey(connectorId, key));
  return { removed, revoked };
}

// ── Status ────────────────────────────────────────────────────────────────

export interface LoginStatus {
  key: string;
  provider: OAuthPresetId;
  /** Whether the secret store holds the refresh token; null when the backend is unavailable. */
  present: boolean | null;
  backend?: SecretBackendId;
  obtainedAt?: string;
  obtainedVia?: "loopback" | "device";
  scope?: string;
  revokedAt?: string;
}

export interface LoginStatusOptions {
  connectorId: string;
  logins: Record<string, ResolvedOAuthLoginDef>;
  secretStore?: OpenSecretStoreOptions;
  env?: NodeJS.ProcessEnv;
}

/** No network: the metadata record plus whether the store holds the refresh token. */
export function loginStatus(opts: LoginStatusOptions): LoginStatus[] {
  const { connectorId } = opts;
  const env = opts.env ?? process.env;
  const records = readMetadataTolerant(dataRootOf(opts.secretStore, env), connectorId);
  let store: SecretStore | null = null;
  try {
    store = openSecretStore(storeOptions(connectorId, opts.secretStore, env));
  } catch {
    store = null;
  }
  return Object.entries(opts.logins).map(([key, def]) => {
    const rec = records[key];
    let present: boolean | null = null;
    if (store) {
      try {
        present = store.has(def.storeAs);
      } catch {
        present = null;
      }
    }
    return {
      key,
      provider: def.provider,
      present,
      ...(rec?.backend ? { backend: rec.backend } : {}),
      ...(rec?.obtainedAt ? { obtainedAt: rec.obtainedAt } : {}),
      ...(rec?.obtainedVia ? { obtainedVia: rec.obtainedVia } : {}),
      ...(rec?.scope ? { scope: rec.scope } : {}),
      ...(rec?.revokedAt ? { revokedAt: rec.revokedAt } : {}),
    };
  });
}
