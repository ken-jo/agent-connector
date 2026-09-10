/**
 * core/oauth/http — the one place the engine talks HTTP: form POSTs to token,
 * device-authorization and revocation endpoints, JSON GETs for discovery, with
 * a per-call timeout and RFC 6749 §5.2 error mapping. Response bodies are
 * parsed, never echoed into an error.
 */

import { OAuthError, sanitizeProviderText } from "./errors.js";
import type { OAuthTokenEndpointAuth } from "../types.js";

export type FetchFn = typeof fetch;

export interface HttpOptions {
  fetch?: FetchFn;
  /** Per HTTP call. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_HTTP_TIMEOUT_MS = 20_000;
/** Largest response body read from a provider (metadata documents and token responses are a few KB). */
export const MAX_RESPONSE_BYTES = 1_048_576;

/** The response text, read in chunks and abandoned past {@link MAX_RESPONSE_BYTES}. */
export async function readBody(res: Response, max = MAX_RESPONSE_BYTES): Promise<string> {
  const stream = res.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new OAuthError("provider", `the response is larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reject an endpoint that would carry credentials in the clear (loopback is
 * exempt: tests, local IdPs), one that embeds userinfo or a fragment (RFC 6749
 * §3.2), or one that carries a control character — `new URL()` strips CR / LF
 * silently, so the string is checked before it is parsed, and the value echoed
 * in a message is sanitized (byte-identical for a well-formed URL).
 */
export function assertSecureEndpoint(url: string, what: string): URL {
  const shown = sanitizeProviderText(url, 2048);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(url)) {
    throw new OAuthError("config", `${what} is not a URL: ${shown}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OAuthError("config", `${what} is not a URL: ${shown}`);
  }
  const loopback =
    parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new OAuthError("config", `${what} must be an https URL: ${shown}`);
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    throw new OAuthError("config", `${what} must not carry credentials or a fragment: ${shown}`);
  }
  return parsed;
}

function withTimeout(opts: HttpOptions): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const ms = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new OAuthError("timeout", `no response within ${ms} ms`)), ms);
  const onOuter = (): void => controller.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) onOuter();
    else opts.signal.addEventListener("abort", onOuter, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuter);
    },
  };
}

function abortReason(err: unknown, signal: AbortSignal): OAuthError {
  if (signal.reason instanceof OAuthError) return signal.reason;
  if (err instanceof OAuthError) return err;
  const name = err instanceof Error && err.name === "AbortError" ? "aborted" : "network error";
  // undici wraps the reason in `cause` ("fetch failed" alone says nothing about a redirect or a DNS miss).
  const cause = err instanceof Error && err.cause instanceof Error && err.cause.message !== "" ? ` (${sanitizeProviderText(err.cause.message)})` : "";
  return new OAuthError("provider", `${name}: ${err instanceof Error ? err.message : String(err)}${cause}`);
}

/** `application/x-www-form-urlencoded` params → JSON (or form-encoded) response body. */
export async function postForm(
  url: string,
  params: Record<string, string>,
  opts: HttpOptions & { headers?: Record<string, string>; what: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fetchFn = opts.fetch ?? fetch;
  const t = withTimeout(opts);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        ...(opts.headers ?? {}),
      },
      body: new URLSearchParams(params).toString(),
      // A token, device or revocation endpoint never redirects; following one
      // would re-send the form — a code and its verifier, a refresh token — to
      // whatever origin the Location names (307/308), so a redirect is an error.
      redirect: "error",
      signal: t.signal,
    });
    const body = await parseBody(res);
    return { status: res.status, body };
  } catch (err) {
    throw abortReason(err, t.signal);
  } finally {
    t.done();
  }
}

export async function getJson(url: string, opts: HttpOptions): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const fetchFn = opts.fetch ?? fetch;
  const t = withTimeout(opts);
  try {
    const res = await fetchFn(url, { method: "GET", headers: { accept: "application/json" }, signal: t.signal });
    if (!res.ok) return { status: res.status, body: null };
    const text = await readBody(res);
    try {
      const parsed: unknown = JSON.parse(text);
      return { status: res.status, body: isRecord(parsed) ? parsed : null };
    } catch {
      return { status: res.status, body: null };
    }
  } catch (err) {
    throw abortReason(err, t.signal);
  } finally {
    t.done();
  }
}

async function parseBody(res: Response): Promise<Record<string, unknown>> {
  const text = await readBody(res);
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json") || text.trimStart().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  // GitHub answers with form encoding unless asked for JSON.
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** RFC 6749 §5.2: `{ error, error_description }` → OAuthError("provider"); never the raw body. */
export function providerError(body: Record<string, unknown>, status: number, what: string): OAuthError {
  const code = typeof body.error === "string" ? sanitizeProviderText(body.error, 64) : undefined;
  const described = sanitizeProviderText(body.error_description);
  const description = described !== "" ? ` — ${described}` : "";
  return new OAuthError("provider", `${what} failed: ${code || `HTTP ${status}`}${description}`, undefined, code);
}

/** Client authentication for the token endpoint (RFC 6749 §2.3.1). */
export function applyClientAuth(
  method: OAuthTokenEndpointAuth,
  clientId: string,
  clientSecret: string | undefined,
  params: Record<string, string>,
  headers: Record<string, string>,
): void {
  if (method === "client_secret_basic" && clientSecret !== undefined) {
    const raw = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
    headers.authorization = `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
    return;
  }
  params.client_id = clientId;
  if (method === "client_secret_post" && clientSecret !== undefined) params.client_secret = clientSecret;
}
