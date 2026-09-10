// SEO example connector — three OAuth logins on one MCP server.
//
// The server (seo-mcp-server.mjs) reads Google Search Console, Bing Webmaster
// Tools and PostHog with access tokens it mints through `getAccessToken`; the
// user authorizes each provider once:
//
//   seo-connector-example auth login google
//   seo-connector-example auth login bing
//   seo-connector-example auth login posthog
//
// agent-connector ships no client ids. Register the app with each provider
// (README.md, "Register the apps") and hand the ids in through the environment
// — `${env:VAR}` is expanded per host at install time — and the one client
// secret through the keystore: `seo-connector-example secrets set bing-client-secret`.
// Nothing secret is ever written into this file or a host config.

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
    // Google Search Console — a "Desktop app" OAuth client. Google does not
    // treat a desktop client's secret as confidential, but it is still kept in
    // the keystore rather than in this file.
    google: {
      provider: "google",
      clientId: "${env:SEO_GOOGLE_CLIENT_ID}",
      clientSecret: "${secret:google-client-secret}",
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    },
    // Bing Webmaster Tools — redirect URIs are matched exactly, port included,
    // so the loopback listener uses a fixed port: register
    // http://127.0.0.1:48213/callback with the app.
    bing: {
      provider: "bing-webmaster",
      clientId: "${env:SEO_BING_CLIENT_ID}",
      clientSecret: "${secret:bing-client-secret}",
      scopes: ["webmaster.read"],
      redirectPort: 48213,
    },
    // PostHog — no registration at PostHog: the client id is the https URL of
    // a Client ID Metadata Document you host (README.md). PKCE, no secret.
    posthog: {
      provider: "posthog",
      clientId: "${env:SEO_POSTHOG_CLIENT_ID}",
      scopes: ["project:read", "query:read"],
      // "us" | "eu" pins a region; omit it to let PostHog route by account.
      options: { region: "us" },
    },
  },

  telemetry: { enabled: true },
  targets: "auto",
});
