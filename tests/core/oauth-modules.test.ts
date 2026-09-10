/**
 * tests/core/oauth-modules — unit-level cases of the engine's building blocks
 * that the flow-level suites do not reach:
 *   loopback: one response per receiver (409 afterwards), unknown paths (404),
 *             a fixed port that is in use;
 *   http:     JSON and form-encoded bodies, RFC 6749 error mapping without the
 *             raw body, per-call timeout, an outer abort signal;
 *   metadata: the tolerant read (absent, damaged, foreign keys), 0600 mode.
 * PKCE, the flows, browser detection and the device grant are covered end to
 * end by tests/core/oauth-engine.test.ts; the review findings by
 * tests/core/oauth-hardening.test.ts.
 */

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { OAuthError } from "../../src/core/oauth/errors.js";
import { assertSecureEndpoint, getJson, postForm, providerError } from "../../src/core/oauth/http.js";
import { startLoopback } from "../../src/core/oauth/loopback.js";
import { metadataPath, readMetadata, updateLoginRecord } from "../../src/core/oauth/metadata.js";

describe("loopback receiver", () => {
  it("answers one authorization response, then 409; other paths 404", async () => {
    const server = await startLoopback({ path: "/callback" });
    expect(server.redirectUri).toBe(`http://127.0.0.1:${server.port}/callback`);
    const wait = server.waitForCallback("st", 5000);
    const res = await fetch(`${server.redirectUri}?state=st&code=abc`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Signed in — you can close this window.");
    await expect(wait).resolves.toEqual({ code: "abc" });
    const again = await fetch(`${server.redirectUri}?state=st&code=abc`);
    expect(again.status).toBe(409);
    const other = await fetch(`http://127.0.0.1:${server.port}/other`);
    expect(other.status).toBe(404);
    await server.close();
  });

  it("reports a fixed port that is in use as a config error", async () => {
    const s = await startLoopback({ path: "/cb", port: 0 });
    const s2 = await startLoopback({ path: "/cb", port: s.port }).catch((e: unknown) => e);
    expect(s2).toBeInstanceOf(OAuthError);
    expect((s2 as OAuthError).code).toBe("config");
    expect((s2 as OAuthError).message).toMatch(/cannot listen on 127\.0\.0\.1/);
    await s.close();
  });
});

describe("http", () => {
  it("assertSecureEndpoint allows https and loopback http only", () => {
    expect(() => assertSecureEndpoint("http://example.com/t", "x")).toThrow(/must be an https URL/);
    expect(assertSecureEndpoint("http://127.0.0.1:1/t", "x").port).toBe("1");
    expect(assertSecureEndpoint("https://a.b/t", "x").host).toBe("a.b");
    expect(() => assertSecureEndpoint("nope", "x")).toThrow(/not a URL/);
  });

  it("parses JSON and form bodies, maps provider errors without the raw body, times out, honors an abort", async () => {
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/json") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ got: body, auth: req.headers.authorization ?? null }));
        } else if (req.url === "/form") {
          res.writeHead(200, { "content-type": "application/x-www-form-urlencoded" }).end("access_token=abc&token_type=bearer");
        } else if (req.url === "/err") {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant", error_description: "Bad[31m!", secret: "SHOULD-NOT-LEAK" }));
        } else if (req.url === "/hang") {
          /* never answers */
        } else if (req.url === "/meta") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ issuer: "x" }));
        } else {
          res.writeHead(404).end("no");
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const j = await postForm(`${base}/json`, { a: "1", b: "x y" }, { what: "t" });
      expect(j.body).toEqual({ got: "a=1&b=x+y", auth: null });
      const f = await postForm(`${base}/form`, {}, { what: "t" });
      expect(f.body).toEqual({ access_token: "abc", token_type: "bearer" });
      const e = await postForm(`${base}/err`, {}, { what: "t" });
      expect(e.status).toBe(400);
      const err = providerError(e.body, e.status, "token refresh");
      expect(err.message).toBe("token refresh failed: invalid_grant — Bad[31m!");
      expect(err.providerCode).toBe("invalid_grant");
      expect(err.message).not.toContain("SHOULD-NOT-LEAK");
      expect(err.message).not.toContain("");
      await expect(postForm(`${base}/hang`, {}, { what: "t", timeoutMs: 100 })).rejects.toMatchObject({ code: "timeout" });
      const m = await getJson(`${base}/meta`, {});
      expect(m.body).toEqual({ issuer: "x" });
      const nf = await getJson(`${base}/nope`, {});
      expect(nf.body).toBeNull();
      const ac = new AbortController();
      const p = postForm(`${base}/hang`, {}, { what: "t", signal: ac.signal });
      ac.abort(new Error("stop"));
      await expect(p).rejects.toThrow();
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("metadata", () => {
  it("round-trips a record, tolerates absent / damaged / foreign entries, writes 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "oauth-meta-"));
    expect(readMetadata(root, "c1")).toEqual({ version: 1, connectorId: "c1", logins: {} });
    updateLoginRecord(root, "c1", "google", { provider: "google", obtainedAt: "t", obtainedVia: "loopback", storeAs: "oauth.google.refresh-token", backend: "file" });
    const p = metadataPath(root, "c1");
    expect(p).toBe(join(root, "oauth", "c1.json"));
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    expect(parsed.logins.google.storeAs).toBe("oauth.google.refresh-token");
    if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o600);
    updateLoginRecord(root, "c1", "google", null);
    expect(readMetadata(root, "c1").logins).toEqual({});
    writeFileSync(p, "{not json");
    expect(() => readMetadata(root, "c1")).toThrow(OAuthError);
    // A damaged file does not fail the record that is being written.
    updateLoginRecord(root, "c1", "idp", { provider: "generic", obtainedAt: "t", obtainedVia: "device", storeAs: "oauth.idp.refresh-token", backend: "file" });
    expect(Object.keys(readMetadata(root, "c1").logins)).toEqual(["idp"]);
    writeFileSync(p, JSON.stringify({ logins: { bad: 1, ok: { storeAs: "x" }, __proto__: { storeAs: "y" }, "Not Valid": { storeAs: "z" } } }));
    const logins = readMetadata(root, "c1").logins;
    expect(Object.keys(logins)).toEqual(["ok"]);
    expect(Object.getPrototypeOf(logins)).toBe(Object.prototype);
    expect(() => metadataPath(root, "../escape")).toThrow(OAuthError);
  });
});
