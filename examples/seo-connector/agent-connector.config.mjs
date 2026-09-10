// SEO example connector — three OAuth logins on one MCP server, one per way
// of supplying the OAuth app.
//
// The server (seo-mcp-server.mjs) reads Google Search Console, Bing Webmaster
// Tools and PostHog with access tokens it mints through `getAccessToken`; the
// user authorizes each provider once:
//
//   seo-connector-example auth login google
//   seo-connector-example auth login bing
//   seo-connector-example auth login posthog
//
// Who supplies the app (README.md, "Who supplies the app"):
//
//   google   developer-provided — a literal client id and a literal client
//            secret; Google documents a desktop client's secret as not
//            confidential, so it may sit in this file.
//   posthog  developer-provided — the client id is the https URL of a Client
//            ID Metadata Document the developer hosts; no secret.
//   bing     user-registered — each user registers an OAuth client at Bing and
//            stores its id and secret with `secrets set`; the config only
//            references them as `${secret:NAME}`. The commented block below
//            shows the alternative: the developer's token exchange service
//            (token-exchange-service.mjs) holds the secret instead.
//
// No `${env:VAR}` client id: a host-spawned server does not see shell exports.

import { fileURLToPath } from "node:url";
import { defineConnector } from "@ken-jo/agent-connector/sdk";

// Host CLIs spawn MCP servers from their own CWD: resolve the server to an
// absolute path.
const serverPath = fileURLToPath(new URL("./seo-mcp-server.mjs", import.meta.url));

export default defineConnector({
  // A fixed id: it names the keystore namespace the logins live in, so the
  // server can mint tokens with the same id under every launch path.
  id: "seo-connector",
  displayName: "SEO Connector",
  publish: { author: { name: "Acme" } },

  server: {
    transport: "stdio",
    command: "node",
    args: [serverPath],
    tools: { include: ["*"] },
    timeoutMs: 60_000,
  },

  oauth: {
    // Google Search Console — a "Desktop app" OAuth client the developer
    // registered. Both values are literals: Google, on installed apps — "The
    // process results in a client ID and, in some cases, a client secret,
    // which you embed in the source code of your application. (In this
    // context, the client secret is obviously not treated as a secret.)"
    // (https://developers.google.com/identity/protocols/oauth2). `google` is
    // the only preset that accepts a literal clientSecret.
    google: {
      provider: "google",
      clientId: "replace-with-the-desktop-client-id.apps.googleusercontent.com",
      clientSecret: "GOCSPX-replace-me",
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    },
    // Bing Webmaster Tools — user-registered: the user's own OAuth client, its
    // id and secret stored with `secrets set bing-client-id` and
    // `secrets set bing-client-secret`; install and doctor name the commands
    // still to run. Bing matches redirect URIs exactly, port included, so the
    // loopback listener uses a fixed port: the user registers
    // http://127.0.0.1:48213/callback with the app.
    bing: {
      provider: "bing-webmaster",
      clientId: "${secret:bing-client-id}",
      clientSecret: "${secret:bing-client-secret}",
      scopes: ["webmaster.read"],
      redirectPort: 48213,
    },
    // The developer-hosted alternative for Bing: one app registered by the
    // developer, whose secret lives in token-exchange-service.mjs's
    // environment. Every token request goes to the service with `client_id`
    // only; the service adds the secret and forwards it to Bing. Replace the
    // `bing` login above with this block to use it (clientSecret and
    // tokenExchangeUrl are exclusive).
    //
    // bing: {
    //   provider: "bing-webmaster",
    //   clientId: "replace-with-the-developer-registered-client-id",
    //   tokenExchangeUrl: "https://seo.example.com/oauth/bing/token",
    //   scopes: ["webmaster.read"],
    //   redirectPort: 48213,
    // },
    //
    // PostHog — no registration at PostHog: the client id is the https URL of
    // a Client ID Metadata Document the developer hosts (README.md). PKCE, no
    // secret.
    posthog: {
      provider: "posthog",
      clientId: "https://example.com/.well-known/seo-connector-oauth.json",
      scopes: ["project:read", "query:read"],
      // "us" | "eu" pins a region; omit it to let PostHog route by account.
      options: { region: "us" },
    },
  },

  telemetry: { enabled: true },
  targets: "auto",
});
