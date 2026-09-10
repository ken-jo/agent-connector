/**
 * core/oauth/presets — provider presets for `oauth.<key>` logins.
 *
 * A preset supplies what the flow engine cannot guess about a provider:
 * endpoints or a discovery issuer, whether PKCE and the device grant
 * (RFC 8628) are available, how the client authenticates at the token
 * endpoint, the extra authorization parameters a provider needs before it
 * returns a refresh token, and per-provider resolution (posthog region,
 * microsoft tenant). The engine is one implementation; presets only carry
 * facts. Every value was checked against the page in `docsUrl` on the
 * `verifiedOn` date, plus the provider's live discovery document where one
 * exists. Values in a connector's `oauth.<key>` override the preset.
 */

import type { OAuthPresetId, OAuthTokenEndpointAuth, ResolvedOAuthLoginDef } from "../types.js";

/** Endpoints a preset can resolve from a login's `options`. */
export type OAuthPresetEndpoints = Partial<
  Pick<
    OAuthPreset,
    "issuer" | "authorizationEndpoint" | "tokenEndpoint" | "deviceAuthorizationEndpoint" | "revocationEndpoint"
  >
>;

export interface OAuthPreset {
  id: OAuthPresetId;
  /** Human label (`auth login` prints "Opening <label> authorization…"). */
  label: string;
  /** The provider page every value in this preset was checked against. */
  docsUrl: string;
  /** ISO date (YYYY-MM-DD) of that check. */
  verifiedOn: string;
  /** RFC 8414 / OIDC discovery root. */
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  revocationEndpoint?: string;
  /** PKCE S256 on the authorization code grant. */
  pkce: boolean;
  /** How a client secret is sent to the token endpoint; a login without `clientSecret` sends `client_id` only. */
  tokenEndpointAuth: OAuthTokenEndpointAuth;
  /**
   * True when the provider documents an installed app's client secret as not
   * confidential — Google: "The process results in a client ID and, in some
   * cases, a client secret, which you embed in the source code of your
   * application. (In this context, the client secret is obviously not treated
   * as a secret.)" (https://developers.google.com/identity/protocols/oauth2) —
   * so defineConnector accepts a literal `clientSecret`. Default false.
   */
  clientSecretPublic?: boolean;
  /** Whether `flow: "auto"` may fall back to the device grant (RFC 8628). */
  deviceFlow: boolean;
  /** Query parameters added to every authorization request. */
  extraAuthorizationParams?: Record<string, string>;
  /** Headers added to every token-endpoint request. */
  tokenRequestHeaders?: Record<string, string>;
  /** Joins `scopes` into the `scope` parameter; default " ". */
  scopeSeparator?: string;
  /** Shown when the provider returns no refresh token. */
  refreshTokenHint?: string;
  /**
   * False for a provider whose authorization response carries no `state`
   * (RFC 6749 §4.1.2 makes the echo mandatory; Bing Webmaster documents the
   * response without it). The receiver then accepts a response without
   * `state` only for a login with a fixed `redirectPort` (exact-match redirect
   * URIs are the only reason to use such a provider) and still verifies a
   * `state` that is present. Default true.
   */
  echoesState?: boolean;
  /** Preset-specific resolution (posthog region → issuer, microsoft tenant → issuer). Pure. */
  resolve?(def: ResolvedOAuthLoginDef): OAuthPresetEndpoints;
}

export const OAUTH_PRESET_IDS: readonly OAuthPresetId[] = [
  "google",
  "microsoft",
  "github",
  "bing-webmaster",
  "posthog",
  "generic",
];

/** PostHog Cloud regions a posthog login may pin with `options.region`; omitted = the region-agnostic issuer. */
export const POSTHOG_REGIONS = ["us", "eu"] as const;
export type PostHogRegion = (typeof POSTHOG_REGIONS)[number];

const DEFAULT_MICROSOFT_TENANT = "common";

// ── Google ────────────────────────────────────────────────────────────────
// Endpoints: https://accounts.google.com/.well-known/openid-configuration.
// Installed-app flow (loopback redirect, PKCE S256, form-body client secret):
// https://developers.google.com/identity/protocols/oauth2/native-app. The
// device grant is limited to email / profile / openid, drive.appdata,
// drive.file, youtube and youtube.readonly
// (https://developers.google.com/identity/protocols/oauth2/limited-input-device#allowedscopes),
// so API scopes such as Search Console can never use it and `flow: "auto"`
// does not fall back to it. A refresh token is returned only for
// access_type=offline, and only on the first authorization unless
// prompt=consent forces a new grant
// (https://developers.google.com/identity/protocols/oauth2/web-server#offline).
// An installed app's client secret is documented as not confidential
// (https://developers.google.com/identity/protocols/oauth2: "the client secret
// is obviously not treated as a secret"), so a literal `clientSecret` is
// accepted in the connector config.
const google: OAuthPreset = {
  id: "google",
  label: "Google",
  docsUrl: "https://developers.google.com/identity/protocols/oauth2/native-app",
  verifiedOn: "2026-09-10",
  issuer: "https://accounts.google.com",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  deviceAuthorizationEndpoint: "https://oauth2.googleapis.com/device/code",
  revocationEndpoint: "https://oauth2.googleapis.com/revoke",
  pkce: true,
  tokenEndpointAuth: "client_secret_post",
  clientSecretPublic: true,
  deviceFlow: false,
  extraAuthorizationParams: { access_type: "offline", prompt: "consent" },
  refreshTokenHint:
    "Google returns a refresh token only for access_type=offline, and only once per grant unless prompt=consent is sent (this preset sends both); " +
    "remove the app's existing access at https://myaccount.google.com/permissions and log in again",
};

// ── Microsoft (Entra ID / Microsoft identity platform v2.0) ───────────────
// Authority `https://login.microsoftonline.com/<tenant>/v2.0` with OIDC
// discovery at `<authority>/.well-known/openid-configuration`
// (https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc);
// tenant = common | organizations | consumers | a tenant id or domain.
// The `common` discovery document's `issuer` is the template string
// `https://login.microsoftonline.com/{tenantid}/v2.0`, so the endpoints are
// spelled out here instead of discovered. PKCE S256 is recommended for every
// client type and required for single-page apps; `client_secret` travels in
// the form body and only web apps hold one
// (https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).
// Device grant at `<authority>/oauth2/v2.0/devicecode`
// (https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code);
// the app registration must allow public client flows for it. A refresh
// token requires the `offline_access` scope.
function microsoftEndpoints(tenant: string): Required<Omit<OAuthPresetEndpoints, "revocationEndpoint">> {
  const authority = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}`;
  return {
    issuer: `${authority}/v2.0`,
    authorizationEndpoint: `${authority}/oauth2/v2.0/authorize`,
    tokenEndpoint: `${authority}/oauth2/v2.0/token`,
    deviceAuthorizationEndpoint: `${authority}/oauth2/v2.0/devicecode`,
  };
}

const microsoft: OAuthPreset = {
  id: "microsoft",
  label: "Microsoft",
  docsUrl: "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow",
  verifiedOn: "2026-09-10",
  ...microsoftEndpoints(DEFAULT_MICROSOFT_TENANT),
  pkce: true,
  tokenEndpointAuth: "client_secret_post",
  deviceFlow: true,
  refreshTokenHint: "Microsoft returns a refresh token only when the offline_access scope is requested",
  resolve: (def) => microsoftEndpoints(def.options?.tenant || DEFAULT_MICROSOFT_TENANT),
};

// ── GitHub ────────────────────────────────────────────────────────────────
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps:
// authorize at /login/oauth/authorize, exchange and poll at
// /login/oauth/access_token, device codes at /login/device/code. The token
// endpoint answers form-encoded unless `Accept: application/json` is sent.
// PKCE (`code_challenge` S256 / `code_verifier`) is supported; `client_secret`
// is required for the web flow's exchange and not used by device-flow
// polling. A refresh token comes back only when the app uses expiring user
// tokens or the `offline_access` scope is requested
// (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).
// There is no RFC 7009 endpoint: revocation is `DELETE /applications/{client_id}/token`.
const github: OAuthPreset = {
  id: "github",
  label: "GitHub",
  docsUrl: "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps",
  verifiedOn: "2026-09-10",
  authorizationEndpoint: "https://github.com/login/oauth/authorize",
  tokenEndpoint: "https://github.com/login/oauth/access_token",
  deviceAuthorizationEndpoint: "https://github.com/login/device/code",
  pkce: true,
  tokenEndpointAuth: "client_secret_post",
  deviceFlow: true,
  tokenRequestHeaders: { Accept: "application/json" },
  refreshTokenHint:
    "GitHub returns a refresh token only when the app uses expiring user tokens (app settings) or the offline_access scope is requested",
};

// ── Bing Webmaster Tools ──────────────────────────────────────────────────
// https://learn.microsoft.com/en-us/bingwebmaster/oauth2: authorize at
// https://www.bing.com/webmasters/oauth/authorize (response_type=code,
// client_id, redirect_uri, scope), exchange and refresh at
// https://www.bing.com/webmasters/oauth/token with `client_id` and
// `client_secret` in the form body (`redirect_uri` on the code exchange only); scopes
// `webmaster.read` / `webmaster.manage`; a refresh token is returned with
// every exchange. The redirect URI must match the registered one exactly
// (scheme, host, port and path), so a loopback login needs a fixed
// `redirectPort`. No PKCE, device grant or revocation endpoint is documented,
// and the documented response (`?code=…` / `?error=access_denied`) carries no
// `state` (section "Handling the OAuth 2.0 server response").
const bingWebmaster: OAuthPreset = {
  id: "bing-webmaster",
  label: "Bing Webmaster Tools",
  docsUrl: "https://learn.microsoft.com/en-us/bingwebmaster/oauth2",
  verifiedOn: "2026-09-10",
  authorizationEndpoint: "https://www.bing.com/webmasters/oauth/authorize",
  tokenEndpoint: "https://www.bing.com/webmasters/oauth/token",
  pkce: false,
  tokenEndpointAuth: "client_secret_post",
  deviceFlow: false,
  echoesState: false,
  refreshTokenHint:
    "Bing Webmaster returns a refresh token with every authorization-code exchange; check that the client secret and the registered redirect URI (exact match, including the port) are the ones in the connector config",
};

// ── PostHog ───────────────────────────────────────────────────────────────
// https://posthog.com/docs/api/oauth: the client id is an https URL that
// serves a Client ID Metadata Document (no client secret; token endpoint
// auth `none`), PKCE S256 only, grants authorization_code + refresh_token
// (no device grant). RFC 8414 metadata at
// `<issuer>/.well-known/oauth-authorization-server` on the region-agnostic
// issuer https://oauth.posthog.com (routes to US or EU Cloud) and on the
// per-region issuers https://us.posthog.com / https://eu.posthog.com. A
// loopback redirect URI registered without a port
// (`http://127.0.0.1/callback`) matches any port (RFC 8252 §7.3).
const POSTHOG_AGNOSTIC_ORIGIN = "https://oauth.posthog.com";
const POSTHOG_REGION_ORIGINS: Record<PostHogRegion, string> = {
  us: "https://us.posthog.com",
  eu: "https://eu.posthog.com",
};

function posthogEndpoints(origin: string): Required<Omit<OAuthPresetEndpoints, "deviceAuthorizationEndpoint">> {
  return {
    issuer: origin,
    authorizationEndpoint: `${origin}/oauth/authorize/`,
    tokenEndpoint: `${origin}/oauth/token/`,
    revocationEndpoint: `${origin}/oauth/revoke/`,
  };
}

const posthog: OAuthPreset = {
  id: "posthog",
  label: "PostHog",
  docsUrl: "https://posthog.com/docs/api/oauth",
  verifiedOn: "2026-09-10",
  ...posthogEndpoints(POSTHOG_AGNOSTIC_ORIGIN),
  pkce: true,
  tokenEndpointAuth: "none",
  deviceFlow: false,
  refreshTokenHint:
    "PostHog returns a refresh token with every authorization-code exchange; check that the clientId URL serves the Client ID Metadata Document and that it lists the loopback redirect URI",
  resolve: (def) => {
    const region = def.options?.region;
    const pinned = region !== undefined && (POSTHOG_REGIONS as readonly string[]).includes(region);
    return posthogEndpoints(pinned ? POSTHOG_REGION_ORIGINS[region as PostHogRegion] : POSTHOG_AGNOSTIC_ORIGIN);
  },
};

// ── Generic ───────────────────────────────────────────────────────────────
// Any RFC 6749 server: endpoints from the login's `issuer` (RFC 8414
// `/.well-known/oauth-authorization-server`, then OpenID Connect
// `/.well-known/openid-configuration`) or spelled out in the login. PKCE is
// requested (a server that does not implement RFC 7636 ignores the
// parameters); the device grant is used when the server publishes a
// device_authorization_endpoint.
const generic: OAuthPreset = {
  id: "generic",
  label: "OAuth 2.0 provider",
  docsUrl: "https://www.rfc-editor.org/rfc/rfc8414",
  verifiedOn: "2026-09-10",
  pkce: true,
  tokenEndpointAuth: "client_secret_post",
  deviceFlow: true,
  refreshTokenHint:
    "check the provider's documentation for what requests offline access (often the offline_access scope or an access_type parameter) and add it to scopes or extraAuthorizationParams",
};

function freeze(preset: OAuthPreset): OAuthPreset {
  if (preset.extraAuthorizationParams) Object.freeze(preset.extraAuthorizationParams);
  if (preset.tokenRequestHeaders) Object.freeze(preset.tokenRequestHeaders);
  return Object.freeze(preset);
}

const PRESETS: Record<OAuthPresetId, OAuthPreset> = {
  google: freeze(google),
  microsoft: freeze(microsoft),
  github: freeze(github),
  "bing-webmaster": freeze(bingWebmaster),
  posthog: freeze(posthog),
  generic: freeze(generic),
};

/** The preset for `id`; throws for an id outside {@link OAUTH_PRESET_IDS}. */
export function getOAuthPreset(id: OAuthPresetId): OAuthPreset {
  const preset = Object.prototype.hasOwnProperty.call(PRESETS, id) ? PRESETS[id] : undefined;
  if (!preset) {
    throw new Error(`"${String(id)}" is not a known OAuth preset (${OAUTH_PRESET_IDS.join(", ")})`);
  }
  return preset;
}
