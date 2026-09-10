# seo-connector example — one MCP server, three OAuth logins

A runnable connector that reads **Google Search Console**, **Bing Webmaster
Tools** and **PostHog** from one stdio MCP server. It shows the `oauth.<key>`
login feature end to end: the config declares three providers, the user
authorizes each once with `auth login <key>`, the refresh tokens live in the OS
keystore, and the server mints access tokens with `getAccessToken` right before
each API call — under the serve wrapper, inside a host plugin, or as a bare
`node seo-mcp-server.mjs`.

## Files

- `agent-connector.config.mjs` — `defineConnector` with the server command and
  the three logins (`google`, `bing`, `posthog`). Client ids come from the
  environment (`${env:…}`), the two client secrets from the keystore
  (`${secret:…}`); nothing secret is in the file.
- `seo-mcp-server.mjs` — the MCP server: `gsc_sites`, `gsc_search_analytics`,
  `bing_query_stats`, `posthog_projects`, `posthog_query`. Each tool calls
  `getAccessToken({ connectorId, key, def })` and turns an `OAuthError` into a
  tool result that names the `auth login` command to run.
- `bin.mjs` + `package.json` — the package-first wrapper: every framework
  command (`install`, `doctor`, `secrets`, `auth`, …) under the example's own
  bin, auto-scoped to this connector.

## Register the apps

agent-connector ships no client ids: the connector author registers an app
with each provider once and hands the ids to the connector. Every registration
below is free; none needs a verified domain for a personal test.

### Google Search Console (`google`)

1. Open https://console.cloud.google.com/ and pick or create a project.
2. **APIs & Services → Library** → enable **Google Search Console API**.
3. **APIs & Services → OAuth consent screen** → External, fill in the app name
   and support email, add the scope
   `https://www.googleapis.com/auth/webmasters.readonly`, and add yourself as a
   test user while the app is in *Testing* status.
   *Testing apps get refresh tokens that expire after 7 days; publish the app
   (or keep re-running `auth login google`) for a longer-lived token.*
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   application type **Desktop app**. Google issues a client id and a client
   secret; a desktop client's secret is not treated as confidential by Google,
   but it still goes into the keystore, not into a file.
5. No redirect URI to register: desktop clients accept any
   `http://127.0.0.1:<port>` loopback redirect.

```bash
export SEO_GOOGLE_CLIENT_ID="<client id>.apps.googleusercontent.com"
seo-connector-example secrets set google-client-secret    # prompts, never echoes
```

### Bing Webmaster Tools (`bing`)

1. Sign in at https://www.bing.com/webmasters/ with the account that owns the
   sites you want to read.
2. **Settings (gear) → API access → OAuth** (Microsoft's guide:
   https://learn.microsoft.com/en-us/bingwebmaster/oauth2) → register an app:
   name, and the redirect URI **`http://127.0.0.1:48213/callback`** — the
   example pins `redirectPort: 48213` because Bing matches redirect URIs
   exactly, port included. Bing issues a client id and a client secret.
3. Scopes: `webmaster.read` (reads) or `webmaster.manage` (submit URLs,
   sitemaps…); the example asks for `webmaster.read`.

```bash
export SEO_BING_CLIENT_ID="<client id>"
seo-connector-example secrets set bing-client-secret
```

The Bing authorization response carries no `state` in Microsoft's
documentation; the login is bound by the exact redirect URI instead (see the
`bing-webmaster` preset notes in the root README). If you would rather not run
an OAuth app, Bing also offers a plain API key, which fits the `secrets` feature
instead of a login.

### PostHog (`posthog`)

PostHog needs no registration at PostHog. The client id is the **https URL of
a Client ID Metadata Document** you host (https://posthog.com/docs/api/oauth):

1. Put this JSON at a public https URL you control, e.g.
   `https://example.com/.well-known/seo-connector-oauth.json`:

   ```json
   {
     "client_id": "https://example.com/.well-known/seo-connector-oauth.json",
     "client_name": "SEO Connector",
     "redirect_uris": ["http://127.0.0.1/callback"]
   }
   ```

   `client_id` must equal the document's own URL; `client_name` and
   `redirect_uris` are required, `logo_uri` optional. A loopback redirect URI
   registered **without a port** matches any port, so the example keeps an
   ephemeral one.
2. Scopes the example requests: `project:read`, `query:read`. Pick the region
   with `options.region` (`us` | `eu`); omit it and PostHog routes by account.

```bash
export SEO_POSTHOG_CLIENT_ID="https://example.com/.well-known/seo-connector-oauth.json"
```

## Run it

> **Prerequisite.** From a repo clone, run `npm install && npm run build` at the
> repo root first; the example resolves agent-connector through the
> `"@ken-jo/agent-connector": "../.."` dependency in `package.json`.

From `examples/seo-connector/`:

```bash
npm install
seo-connector-example install --dry-run     # warns per absent login (and exits 1 until they are present)
seo-connector-example auth login google     # browser opens; refresh token → keystore
seo-connector-example auth login bing
seo-connector-example auth login posthog
seo-connector-example auth status           # key  provider  present  obtained  via
seo-connector-example install               # deploy to every detected host
seo-connector-example doctor                # <id>: logins → "3 login(s) present"
```

Without a stored login, a tool call answers with the exact command to run:

```
login "google" is not present for connector seo-connector — run `auth login google --connector-id seo-connector`
```

…unless a browser can be opened, in which case the server logs in on that
first call (`AGENT_CONNECTOR_BROWSER=never` turns that off).

## Adapt it

- Swap the tools in `seo-mcp-server.mjs`; keep `token(key)` — one line per
  provider.
- Add a provider: another `oauth.<key>` entry with a preset (`google`,
  `microsoft`, `github`, `bing-webmaster`, `posthog`) or `generic` with an
  `issuer` / explicit endpoints, then `auth login <key>`.
- Ship it: `seo-connector-example package` renders the MCPB / plugin bundles;
  their READMEs list the logins to authorize.
