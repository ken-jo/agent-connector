/**
 * core/oauth/device — RFC 8628 Device Authorization Grant: request a user
 * code, tell the user where to enter it, poll the token endpoint at the
 * provider's interval (`slow_down` adds five seconds) until it answers.
 */

import { OAuthError, sanitizeProviderText } from "./errors.js";
import { applyClientAuth, postForm, providerError } from "./http.js";
import type { HttpOptions } from "./http.js";
import type { OAuthTokenEndpointAuth } from "../types.js";

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** Seconds. */
  expiresIn: number;
  /** Seconds between polls (RFC 8628 §3.2 default 5). */
  interval: number;
}

export interface DeviceClient {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuth: OAuthTokenEndpointAuth;
  headers?: Record<string, string>;
}

export async function requestDeviceAuthorization(
  endpoint: string,
  client: DeviceClient,
  scope: string,
  opts: HttpOptions,
): Promise<DeviceAuthorization> {
  const params: Record<string, string> = { scope };
  const headers: Record<string, string> = { ...(client.headers ?? {}) };
  applyClientAuth(client.tokenEndpointAuth, client.clientId, client.clientSecret, params, headers);
  const { status, body } = await postForm(endpoint, params, { ...opts, headers, what: "device authorization" });
  if (status >= 400 || typeof body.device_code !== "string") throw providerError(body, status, "device authorization");
  // The prompt is provider-controlled terminal output: the URIs must be web
  // URLs (https, or http on a loopback host for tests) and the code plain text.
  const verificationUri = verificationUrl(body.verification_uri ?? body.verification_url);
  if (verificationUri === null) {
    throw new OAuthError("provider", "device authorization failed: the response carried no https verification_uri");
  }
  const complete = verificationUrl(body.verification_uri_complete);
  return {
    deviceCode: body.device_code,
    userCode: sanitizeProviderText(body.user_code, 64),
    verificationUri,
    ...(complete !== null ? { verificationUriComplete: complete } : {}),
    expiresIn: finiteOr(body.expires_in, 1800, 1, 86_400),
    interval: finiteOr(body.interval, 5, 1, 3600),
  };
}

/** `value` when it is an https URL (or http on a loopback host), else null. */
function verificationUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
    if (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback)) return parsed.toString();
  } catch {
    /* not a URL */
  }
  return null;
}

/** `value` as a finite number clamped to [min, max]; `fallback` for anything else (a provider is not trusted to send numbers). */
function finiteOr(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** The user-facing prompt for a device authorization (one line). */
export function deviceCodePrompt(auth: DeviceAuthorization): string {
  return auth.verificationUriComplete
    ? `Visit ${auth.verificationUriComplete} to authorize (code ${auth.userCode})`
    : `Visit ${auth.verificationUri} and enter code ${auth.userCode}`;
}

export interface DevicePollOptions extends HttpOptions {
  /** Test seam: sleep between polls. */
  sleep?: (ms: number) => Promise<void>;
  /** Whole-flow deadline in ms since the epoch. */
  deadline: number;
}

/** A pause that ends early when `signal` aborts. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Polls until the provider issues the token set or ends the grant. */
export async function pollDeviceToken(
  tokenEndpoint: string,
  client: DeviceClient,
  auth: DeviceAuthorization,
  opts: DevicePollOptions,
): Promise<Record<string, unknown>> {
  // Never faster than one poll per second, whatever the provider says.
  let interval = finiteOr(auth.interval, 5, 1, 3600);
  for (;;) {
    if (Date.now() > opts.deadline) throw new OAuthError("timeout", "the device code was not authorized in time");
    if (opts.signal?.aborted) throw new OAuthError("timeout", "login aborted");
    // Never park past the deadline; an abort ends the pause at once.
    const pause = Math.min(interval * 1000, Math.max(0, opts.deadline - Date.now()));
    await (opts.sleep ? opts.sleep(pause) : abortableSleep(pause, opts.signal));
    if (opts.signal?.aborted) throw new OAuthError("timeout", "login aborted");
    const params: Record<string, string> = {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: auth.deviceCode,
    };
    const headers: Record<string, string> = { ...(client.headers ?? {}) };
    applyClientAuth(client.tokenEndpointAuth, client.clientId, client.clientSecret, params, headers);
    const { status, body } = await postForm(tokenEndpoint, params, { ...opts, headers, what: "device token" });
    if (status < 400 && typeof body.access_token === "string") return body;
    const error = typeof body.error === "string" ? body.error : "";
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      // RFC 8628 §3.5: add five seconds; GitHub also names the new interval.
      const named = finiteOr(body.interval, NaN, 1, 3600);
      interval = Number.isFinite(named) && named > interval ? named : Math.min(3600, interval + 5);
      continue;
    }
    if (error === "access_denied") throw new OAuthError("authorization", "the user denied the authorization");
    if (error === "expired_token") throw new OAuthError("timeout", "the device code expired before it was authorized");
    throw providerError(body, status, "device token");
  }
}
