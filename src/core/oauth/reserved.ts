/**
 * core/oauth/reserved — the authorization-request parameters the login flow
 * owns. A connector's `extraAuthorizationParams` cannot set them: they bind
 * the response to this login (redirect_uri, state, the PKCE challenge) or
 * identify the client. Dependency-free so define-connector can validate
 * against the same list the engine enforces.
 */

export const RESERVED_AUTHORIZATION_PARAMS: ReadonlySet<string> = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
]);
