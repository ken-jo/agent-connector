#!/usr/bin/env node
// token-exchange-service.mjs — the developer's token exchange service for one
// OAuth app. The connector sends every token request here with `client_id`
// and never a client secret; this process adds the secret and forwards the
// form to the provider's token endpoint; the provider's status and body go
// back unchanged. The secret lives in this process's environment, never in a
// file.
//
// Environment:
//   TOKEN_EXCHANGE_CLIENT_ID       required — the app's client id, the only one accepted
//   TOKEN_EXCHANGE_CLIENT_SECRET   required — the app's client secret
//   TOKEN_EXCHANGE_TOKEN_ENDPOINT  required — the provider's token endpoint
//   TOKEN_EXCHANGE_CLIENT_AUTH     how the provider wants the secret: `post`
//                                  (client_secret form field, default) or
//                                  `basic` (HTTP Basic, RFC 6749 §2.3.1)
//   TOKEN_EXCHANGE_LISTEN          host:port to listen on (default 127.0.0.1:48214)
//
// Run: node token-exchange-service.mjs — then point the connector at it with
// oauth.<key>.tokenExchangeUrl (https in production; every path is the token
// endpoint). Duties: accept only its own client_id and the three grant types
// the engine sends; answer 400 {"error":"invalid_request"} to anything else,
// including a request that carries a client_secret (the connector never
// sends one) or a repeated parameter (RFC 6749 §3.2); forward only the
// accepted grant's own parameters plus client_id, never an unknown one;
// never follow a redirect from the provider; return the provider's response
// unchanged; log one line per request — method, grant_type (only a known
// one; "-" otherwise), status — and never a body. One provider, one client
// id: this is not a public relay. Put it behind https, rate-limit it, and
// keep its logs body-free.

import { createServer } from "node:http";

const REQUIRED = ["TOKEN_EXCHANGE_CLIENT_ID", "TOKEN_EXCHANGE_CLIENT_SECRET", "TOKEN_EXCHANGE_TOKEN_ENDPOINT"];
/** The grants the engine sends, each with the parameters it may carry (client_id is added by the service). */
const GRANTS = {
  authorization_code: ["code", "redirect_uri", "code_verifier"],
  refresh_token: ["refresh_token"],
  "urn:ietf:params:oauth:grant-type:device_code": ["device_code"],
};
const MAX_BODY_BYTES = 64 * 1024;
/** A provider that has not answered by then gets the service's own 502 (the connector's own timeout is 20 s). */
const UPSTREAM_TIMEOUT_MS = 20_000;

const log = (line) => process.stderr.write(`token-exchange-service: ${line}\n`);

/** The configuration from the environment, or null after one line and exit code 1. */
function configure(env) {
  const fail = (reason) => {
    log(reason);
    process.exitCode = 1;
    return null;
  };
  const missing = REQUIRED.find((name) => (env[name] ?? "").trim() === "");
  if (missing) return fail(`${missing} is not set`);
  if (!isSecureEndpoint(env.TOKEN_EXCHANGE_TOKEN_ENDPOINT)) {
    return fail("TOKEN_EXCHANGE_TOKEN_ENDPOINT must be an https URL without credentials or a fragment (http only on 127.0.0.1, localhost or [::1])");
  }
  const clientAuth = env.TOKEN_EXCHANGE_CLIENT_AUTH ?? "post";
  if (clientAuth !== "post" && clientAuth !== "basic") return fail(`TOKEN_EXCHANGE_CLIENT_AUTH must be post or basic, not "${clientAuth}"`);
  const listen = env.TOKEN_EXCHANGE_LISTEN ?? "127.0.0.1:48214";
  const colon = listen.lastIndexOf(":");
  const port = Number(listen.slice(colon + 1));
  if (colon < 1 || !Number.isInteger(port) || port < 0 || port > 65535) return fail(`TOKEN_EXCHANGE_LISTEN must be host:port, not "${listen}"`);
  const host = listen.slice(0, colon);
  return {
    clientId: env.TOKEN_EXCHANGE_CLIENT_ID,
    clientSecret: env.TOKEN_EXCHANGE_CLIENT_SECRET,
    tokenEndpoint: env.TOKEN_EXCHANGE_TOKEN_ENDPOINT,
    clientAuth,
    // `[::1]:48214` → host `::1` (listen takes the bare address).
    host: host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host,
    port,
  };
}

/** https, or http on a loopback host — the secret travels on this connection. */
function isSecureEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

function answer(res, status, body, contentType = "application/json") {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

function start(config) {
  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const form = method === "POST" ? await readForm(req).catch(() => null) : null;
    const grantType = form?.get("grant_type") ?? "-";
    const allowed = Object.hasOwn(GRANTS, grantType) ? GRANTS[grantType] : null;
    // The log names a grant type only when it is one of the three (inbound text never reaches the log).
    const shownGrant = allowed ? grantType : "-";
    const repeated = form !== null && [...new Set(form.keys())].some((key) => form.getAll(key).length > 1);
    const accepted = allowed !== null && !repeated && form.get("client_id") === config.clientId && !form.has("client_secret");
    if (!accepted) {
      log(`${method} ${shownGrant} → 400`);
      return answer(res, 400, JSON.stringify({ error: "invalid_request" }));
    }
    // The upstream form holds the grant's own parameters and client_id — nothing
    // else the caller sent is forwarded under the developer's credentials.
    const upstreamForm = new URLSearchParams({ grant_type: grantType, client_id: config.clientId });
    for (const key of allowed) if (form.has(key)) upstreamForm.set(key, form.get(key));
    const headers = { "content-type": "application/x-www-form-urlencoded", accept: req.headers.accept ?? "application/json" };
    if (config.clientAuth === "basic") {
      const credentials = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
    } else {
      upstreamForm.set("client_secret", config.clientSecret);
    }
    let status;
    let body;
    let contentType;
    try {
      // A token endpoint never redirects; following one would re-send the secret elsewhere.
      const upstream = await fetch(config.tokenEndpoint, {
        method: "POST",
        headers,
        body: upstreamForm.toString(),
        redirect: "error",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      status = upstream.status;
      body = await upstream.text();
      contentType = upstream.headers.get("content-type") ?? "application/json";
    } catch {
      // Unreachable, redirecting, or slower than UPSTREAM_TIMEOUT_MS: the service's own answer, never an upstream echo.
      log(`${method} ${shownGrant} → 502`);
      return answer(res, 502, JSON.stringify({ error: "server_error" }));
    }
    log(`${method} ${shownGrant} → ${status}`);
    answer(res, status, body, contentType);
  });
  // A port in use or an unresolvable host: one line, exit code 1, no stack.
  server.on("error", (err) => {
    log(err.message);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    const bound = server.address();
    const host = bound.address.includes(":") ? `[${bound.address}]` : bound.address;
    log(`listening on http://${host}:${bound.port}, forwarding to ${config.tokenEndpoint} (client_secret_${config.clientAuth})`);
  });
}

const config = configure(process.env);
if (config) start(config);
