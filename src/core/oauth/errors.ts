/**
 * core/oauth/errors — the error types every OAuth engine path throws.
 *
 * Messages never carry a token, an authorization code, a code verifier or a
 * client secret; a provider's `error` / `error_description` is quoted, its
 * request body is not.
 */

export type OAuthErrorCode =
  | "config"
  | "discovery"
  | "authorization"
  | "token"
  | "timeout"
  | "login-required"
  | "browser-unavailable"
  | "provider";

export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  readonly hint?: string;
  /** The provider's RFC 6749 §5.2 `error` value (code "provider" only). */
  readonly providerCode?: string;

  constructor(code: OAuthErrorCode, message: string, hint?: string, providerCode?: string) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
    if (hint !== undefined) this.hint = hint;
    if (providerCode !== undefined) this.providerCode = providerCode;
  }
}

/** No stored refresh token and no interactive login allowed: the command that fixes it is in `command`. */
export class OAuthLoginRequiredError extends OAuthError {
  readonly connectorId: string;
  readonly key: string;
  readonly command: string;

  constructor(connectorId: string, key: string) {
    const command = `auth login ${key} --connector-id ${connectorId}`;
    super(
      "login-required",
      `login "${key}" is not present for connector ${connectorId} — run \`${command}\``,
    );
    this.name = "OAuthLoginRequiredError";
    this.connectorId = connectorId;
    this.key = key;
    this.command = command;
  }
}

/**
 * Provider-controlled text (an `error_description`, a user code) before it is
 * folded into a message that reaches a terminal: control characters (ANSI
 * sequences included) are dropped and the length is capped.
 */
export function sanitizeProviderText(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  // C0 / C1 controls and Unicode format characters (bidi overrides, zero-width
  // joiners) — the ones that can redraw or reorder a terminal line.
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, "").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
