# seo-connector example — one MCP server, three OAuth logins

A runnable connector that reads **Google Search Console**, **Bing Webmaster
Tools** and **PostHog** from one stdio MCP server. It shows the `oauth.<key>`
login feature end to end: the config declares three providers — one per way
of supplying the OAuth app — the user authorizes each once with
`auth login <key>`, the refresh tokens live in the OS keystore, and the server
mints access tokens with `getAccessToken` right before each API call — under
the serve wrapper, inside a host plugin, or as a bare `node seo-mcp-server.mjs`.

## Files

- `agent-connector.config.mjs` — `defineConnector` with the server command and
  the three logins (`google`, `bing`, `posthog`): Google with a literal client
  id and a literal client secret (developer-provided), PostHog with a literal
  metadata-document URL (developer-provided), Bing with `${secret:…}`
  references to the user's own client id and secret (user-registered), plus a
  commented block that routes Bing through the developer's token exchange
  service instead. No `${env:…}` client id: a host-spawned server does not see
  shell exports.
- `seo-mcp-server.mjs` — the MCP server: `gsc_sites`, `gsc_search_analytics`,
  `bing_query_stats`, `posthog_projects`, `posthog_query`. Each tool calls
  `getAccessToken({ connectorId, key, def })` and turns an `OAuthError` into a
  tool result that names the `auth login` command to run.
- `token-exchange-service.mjs` — the developer's token exchange service
  (`node:http`, no dependencies): holds one app's client secret in its
  environment, accepts the connector's token requests with `client_id` only,
  adds the secret and forwards them to the provider, and returns the provider's
  answer unchanged.
- `bin.mjs` + `package.json` — the package-first wrapper: every framework
  command (`install`, `doctor`, `secrets`, `auth`, …) under the example's own
  bin, auto-scoped to this connector.

## Who supplies the app

A login needs an app registered at the provider. Three ways to supply it:

| Mode | Config | What the user does | Fits |
|---|---|---|---|
| Developer-provided | literal `clientId`; no `clientSecret` (public client), or a literal `clientSecret` only for `google` | nothing — `auth login <key>` | `google`, `microsoft`, `posthog`, GitHub's device flow |
| Developer-hosted token exchange | literal `clientId` + `tokenExchangeUrl` (the developer's service holds the secret; no `clientSecret`) | nothing — `auth login <key>` | any provider that requires a client secret: `bing-webmaster`, GitHub's browser flow, `generic` |
| User-registered | `clientId: "${secret:NAME}"` + `clientSecret: "${secret:NAME}"` | registers an app, `secrets set` for both names, then `auth login <key>` | any provider; needed where a client secret is demanded and the developer runs no service (`bing-webmaster`, GitHub's browser flow, a confidential `generic` client) |

The example uses all three: Google developer-provided, PostHog
developer-provided, Bing user-registered (with the token exchange variant
commented out in the config). Every registration below is free; none needs a
verified domain for a personal test.

### Google Search Console (`google`) — developer-provided

The developer registers the app once and ships both values in the config;
the user runs `auth login google` and nothing else.

1. Open https://console.cloud.google.com/ and pick or create a project.
2. **APIs & Services → Library** → enable **Google Search Console API**.
3. **APIs & Services → OAuth consent screen** → External, fill in the app name
   and support email, add the scope
   `https://www.googleapis.com/auth/webmasters.readonly`, and add the test
   users while the app is in *Testing* status.
   *Testing apps get refresh tokens that expire after 7 days; publish the app
   (or keep re-running `auth login google`) for a longer-lived token.*
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   application type **Desktop app**. Google issues a client id and a client
   secret. Both go into `agent-connector.config.mjs` as literals — Google, on
   installed apps: "The process results in a client ID and, in some cases, a
   client secret, which you embed in the source code of your application. (In
   this context, the client secret is obviously not treated as a secret.)"
   (https://developers.google.com/identity/protocols/oauth2). `google` is the
   only preset that accepts a literal `clientSecret`; every other preset
   rejects one with `oauth.<key>.clientSecret: must be a ${secret:NAME}
   reference (a literal secret is never written into a connector config)`.
5. No redirect URI to register: desktop clients accept any
   `http://127.0.0.1:<port>` loopback redirect.

```js
google: {
  provider: "google",
  clientId: "replace-with-the-desktop-client-id.apps.googleusercontent.com",
  clientSecret: "GOCSPX-replace-me",
  scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
},
```

### PostHog (`posthog`) — developer-provided

PostHog needs no registration at PostHog. The client id is the **https URL of
a Client ID Metadata Document** the developer hosts
(https://posthog.com/docs/api/oauth); there is no secret.

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
2. Put that URL in the config as the literal `clientId`. Scopes the example
   requests: `project:read`, `query:read`. Pick the region with
   `options.region` (`us` | `eu`); omit it and PostHog routes by account.

### Bing Webmaster Tools (`bing`) — user-registered

Bing's token endpoint requires the client secret, so a developer-provided app
would need a token exchange service (below). The example ships the
user-registered way instead: each user registers their own OAuth client and
stores its id and secret in the keystore; the config references them as
`${secret:bing-client-id}` and `${secret:bing-client-secret}`.

What the user does:

1. Sign in at https://www.bing.com/webmasters/ with the account that owns the
   sites to read.
2. **Settings (gear) → API access → OAuth** (Microsoft's guide:
   https://learn.microsoft.com/en-us/bingwebmaster/oauth2) → register an app:
   a name, and the redirect URI **`http://127.0.0.1:48213/callback`** — the
   example pins `redirectPort: 48213` because Bing matches redirect URIs
   exactly, port included. Bing issues a client id and a client secret.
3. Store both, then log in (each `secrets set` prompts with input hidden):

   ```bash
   seo-connector-example secrets set bing-client-id
   seo-connector-example secrets set bing-client-secret
   seo-connector-example auth login bing
   ```

Scopes: `webmaster.read` (reads) or `webmaster.manage` (submit URLs,
sitemaps…); the example asks for `webmaster.read`.

Until both values are stored, install and doctor say so — `install` warns per
missing name, before the login's "is not present" line, and exits 1:

```
login "bing" (bing-webmaster) references secret "bing-client-id" which is not set — run `secrets set bing-client-id` before `auth login bing`
login "bing" (bing-webmaster) references secret "bing-client-secret" which is not set — run `secrets set bing-client-secret` before `auth login bing`
login "bing" (bing-webmaster) is not present — run `auth login bing` before the server needs it
```

`doctor` reports one warning for the `seo-connector: logins` check:

```
secrets not set for login(s) bing: bing-client-id, bing-client-secret — run secrets set <name>
```

and `auth login bing` refuses to start (exit 1):

```
connector "seo-connector": 1 secret not set: bing-client-id. Run `secrets set <name> --connector-id seo-connector` for each (oauth.bing.clientId).
```

The Bing authorization response carries no `state` in Microsoft's
documentation; the login is bound by the exact redirect URI instead (see the
`bing-webmaster` preset notes in the root README). If you would rather not run
an OAuth app, Bing also offers a plain API key, which fits the `secrets` feature
instead of a login.

**Or the developer runs `token-exchange-service.mjs` and sets
`tokenExchangeUrl`.** The developer registers one Bing app (redirect URI
`http://127.0.0.1:48213/callback`), runs the service with that app's secret in
its environment, and ships the commented `bing` block from the config:

```js
bing: {
  provider: "bing-webmaster",
  clientId: "replace-with-the-developer-registered-client-id",
  tokenExchangeUrl: "https://seo.example.com/oauth/bing/token",
  scopes: ["webmaster.read"],
  redirectPort: 48213,
},
```

`clientSecret` and `tokenExchangeUrl` are exclusive (`oauth.bing: clientSecret
and tokenExchangeUrl are exclusive — the token exchange service holds the
client secret`), and `tokenExchangeUrl` must be https (`oauth.bing.tokenExchangeUrl:
must be an https URL`; `http://127.0.0.1` and `http://localhost` pass for
local runs). The user then runs `auth login bing` with nothing to register.

## Run it

> **Prerequisite.** From a repo clone, run `npm install && npm run build` at the
> repo root first; the example resolves agent-connector through the
> `"@ken-jo/agent-connector": "../.."` dependency in `package.json`.

From `examples/seo-connector/`:

```bash
npm install
seo-connector-example install --dry-run     # warns per absent login and per unset bing secret (exit 1 until they are present)
seo-connector-example secrets set bing-client-id      # prompts, never echoes
seo-connector-example secrets set bing-client-secret
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

## Run the token exchange service

`token-exchange-service.mjs` is the developer's process, not the user's: it
runs wherever the developer hosts it (behind https in production, rate-limited,
with body-free request logs) and reads its configuration from the environment
only.

| Variable | Meaning |
|---|---|
| `TOKEN_EXCHANGE_CLIENT_ID` | required — the app's client id; the only `client_id` the service accepts |
| `TOKEN_EXCHANGE_CLIENT_SECRET` | required — the app's client secret; never written to a file |
| `TOKEN_EXCHANGE_TOKEN_ENDPOINT` | required — the provider's token endpoint, https (http only on 127.0.0.1, localhost or [::1]), without credentials or a fragment (Bing: `https://www.bing.com/webmasters/oauth/token`) |
| `TOKEN_EXCHANGE_CLIENT_AUTH` | how the provider wants the secret: `post` (a `client_secret` form field, default) or `basic` (HTTP Basic) |
| `TOKEN_EXCHANGE_LISTEN` | `host:port` to listen on (default `127.0.0.1:48214`) |

A required variable that is unset exits 1 with a one-line reason. The two
commands — the developer's, then the user's:

```bash
TOKEN_EXCHANGE_CLIENT_ID="<the developer-registered client id>" \
TOKEN_EXCHANGE_CLIENT_SECRET="<its client secret>" \
TOKEN_EXCHANGE_TOKEN_ENDPOINT="https://www.bing.com/webmasters/oauth/token" \
node token-exchange-service.mjs
```

```bash
seo-connector-example auth login bing
```

`auth login` prints where the tokens go before the browser opens:

```
Tokens are exchanged through https://seo.example.com/oauth/bing/token (the connector's token exchange service)
```

The service implements the token exchange wire contract from the SDK guide
(`llms-full.txt`): the connector sends `POST <tokenExchangeUrl>` with
`content-type: application/x-www-form-urlencoded` and
`accept: application/json`, body one of

```
grant_type=authorization_code&code=…&redirect_uri=…&code_verifier=…&client_id=…
grant_type=refresh_token&refresh_token=…&client_id=…
grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=…&client_id=…
```

never `client_secret`. The service accepts only its own `client_id` and those
three `grant_type` values (`400 {"error":"invalid_request"}` otherwise, also
for a request that carries a `client_secret`), adds the secret the way the
provider wants it, forwards the form, returns the provider's status and body
unchanged, and logs one line per request to stderr — method, grant type (only
one of the three; `-` otherwise), upstream status — never a body. It refuses a
repeated parameter (RFC 6749 §3.2), forwards only the accepted grant's own
parameters plus `client_id` (an unknown parameter is dropped, never sent under
the developer's credentials), and never follows a redirect from the provider.
A provider that is unreachable, redirects, or has not answered within 20 s gets
the service's own `502 {"error":"server_error"}` — the connector then reports
`token refresh failed: server_error`.
The device authorization request and revocation on `logout` still go to the
provider directly, as a public client.

Trust boundary: the service sees the authorization code, the refresh token and
every access token in transit — it is the developer's own service and carries
the same trust as the connector's server code. PKCE stays on the client, so a
code intercepted elsewhere is useless without the verifier. One provider, one
client id: the service is not a public relay.

## Adapt it

- Swap the tools in `seo-mcp-server.mjs`; keep `token(key)` — one line per
  provider.
- Add a provider: another `oauth.<key>` entry with a preset (`google`,
  `microsoft`, `github`, `bing-webmaster`, `posthog`) or `generic` with an
  `issuer` / explicit endpoints, then `auth login <key>`. Pick the supply mode
  from the table above; a preset that requires a secret takes `${secret:…}`
  (user-registered) or `tokenExchangeUrl`.
- Ship it: `seo-connector-example package` renders the MCPB / plugin bundles;
  their READMEs list the logins to authorize.
