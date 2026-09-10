/**
 * core/oauth — the generic OAuth 2.0 login the SDK gives every connector:
 * provider presets, RFC 8414 / OIDC discovery, authorization code + PKCE over a
 * 127.0.0.1 redirect (RFC 8252), the device grant (RFC 8628), refresh with
 * rotation, best-effort revocation. Refresh tokens live in the OS keystore via
 * core/secrets; a non-secret record of each login sits under `<dataRoot>/oauth/`.
 */

export { OAUTH_PRESET_IDS, getOAuthPreset } from "./presets.js";
export type { OAuthPreset } from "./presets.js";

export {
  DEFAULT_LOGIN_TIMEOUT_MS,
  buildAuthorizationUrl,
  chooseFlow,
  clearAccessTokenCache,
  clearDiscoveryCache,
  discoverEndpoints,
  discoveryUrls,
  getAccessToken,
  login,
  loginSecretNames,
  loginStatus,
  logout,
  registeredLoginDef,
  resolveLogin,
} from "./engine.js";
export type {
  AccessTokenOptions,
  LoginOptions,
  LoginResult,
  LoginStatus,
  LoginStatusOptions,
  LogoutOptions,
  OAuthEndpoints,
  OAuthNetOptions,
  ResolveLoginOptions,
  ResolvedLogin,
  TokenSet,
} from "./engine.js";

export { BROWSER_ENV, browserCommand, canOpenBrowser, openBrowser } from "./browser.js";
export type { OpenBrowserOptions } from "./browser.js";

export { createPkcePair, randomState } from "./pkce.js";
export { RESERVED_AUTHORIZATION_PARAMS } from "./reserved.js";
export { metadataPath, readMetadata, updateLoginRecord } from "./metadata.js";
export type { LoginRecord, OAuthMetadataFile } from "./metadata.js";
export { deviceCodePrompt } from "./device.js";
export { OAuthError, OAuthLoginRequiredError } from "./errors.js";
export type { OAuthErrorCode } from "./errors.js";

export type {
  OAuthFlow,
  OAuthLoginDef,
  OAuthPresetId,
  OAuthTokenEndpointAuth,
  ResolvedOAuthLoginDef,
} from "../types.js";
