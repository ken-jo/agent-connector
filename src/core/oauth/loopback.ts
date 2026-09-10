/**
 * core/oauth/loopback — the RFC 8252 §7.3 redirect receiver: an HTTP server
 * bound to 127.0.0.1 (a fixed or an ephemeral port) that accepts exactly one
 * authorization response on `path`, checks `state`, answers the browser with a
 * short page and hands the code to the caller.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { OAuthError, sanitizeProviderText } from "./errors.js";

export interface LoopbackServer {
  /** `http://127.0.0.1:<port><path>` — the redirect_uri for this login. */
  redirectUri: string;
  port: number;
  /**
   * Resolves with the authorization code once the browser hits `path` with the
   * expected state. `requireState: false` (a provider that never echoes it)
   * accepts a response without `state`; a `state` that is present is verified
   * either way.
   */
  waitForCallback(
    expectedState: string,
    timeoutMs: number,
    signal?: AbortSignal,
    options?: { requireState?: boolean },
  ): Promise<{ code: string }>;
  close(): Promise<void>;
}

export interface LoopbackOptions {
  /** 0 (default) asks the OS for an ephemeral port. */
  port?: number;
  path: string;
}

const PAGE_OK = "<!doctype html><meta charset=utf-8><title>Signed in</title><p>Signed in — you can close this window.</p>";
const PAGE_ERR = (text: string): string =>
  `<!doctype html><meta charset=utf-8><title>Authorization failed</title><p>${escapeHtml(text)}</p>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export async function startLoopback(opts: LoopbackOptions): Promise<LoopbackServer> {
  let pending:
    | { expectedState: string; requireState: boolean; resolve: (v: { code: string }) => void; reject: (e: Error) => void }
    | undefined;
  let settled = false;

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== opts.path) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    if (!pending || settled) {
      res.writeHead(409, { "content-type": "text/html; charset=utf-8" }).end(PAGE_ERR("No authorization is waiting here."));
      return;
    }
    const q = url.searchParams;
    const finish = (err: Error | null, code?: string): void => {
      settled = true;
      if (err) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE_ERR(err.message));
        pending?.reject(err);
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE_OK);
        pending?.resolve({ code: code as string });
      }
      pending = undefined;
    };
    const error = sanitizeProviderText(q.get("error"), 64);
    if (error !== "") {
      const description = sanitizeProviderText(q.get("error_description"));
      finish(new OAuthError("authorization", `authorization failed: ${error}${description !== "" ? ` — ${description}` : ""}`));
      return;
    }
    const state = q.get("state");
    if (state !== pending.expectedState && (state !== null || pending.requireState)) {
      finish(new OAuthError("authorization", "authorization response carried an unexpected state; nothing was exchanged"));
      return;
    }
    const code = q.get("code");
    if (!code) {
      finish(new OAuthError("authorization", "authorization response carried no code"));
      return;
    }
    finish(null, code);
  };

  const server: Server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err) => reject(new OAuthError("config", `cannot listen on 127.0.0.1:${opts.port ?? 0}: ${err.message}`)));
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);
  const redirectUri = `http://127.0.0.1:${port}${opts.path}`;

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => resolve());
      // Keep-alive connections from the browser must not hold the process open.
      server.closeAllConnections?.();
    });

  return {
    redirectUri,
    port,
    waitForCallback(expectedState, timeoutMs, signal, options) {
      return new Promise<{ code: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = undefined;
          settled = true;
          reject(new OAuthError("timeout", `no authorization response within ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
        const onAbort = (): void => {
          pending = undefined;
          settled = true;
          clearTimeout(timer);
          reject(signal?.reason instanceof Error ? signal.reason : new OAuthError("timeout", "login aborted"));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        pending = {
          expectedState,
          requireState: options?.requireState !== false,
          resolve: (v) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(e);
          },
        };
      });
    },
    close,
  };
}
