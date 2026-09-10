# Authoring Reference

Use this when creating or editing `agent-connector.config.*`.

## Imports

For new connector authoring, prefer the SDK subpath:

```ts
import {
  defineAction,
  defineConnector,
  defineHook,
  defineMemory,
  defineStatusline,
  hostsSupporting,
} from "@ken-jo/agent-connector/sdk";
```

The root export remains available for compatibility, but `/sdk` is the
consolidated authoring surface. It includes:

- `defineConnector`
- typed identity helpers: `defineHook`, `defineCommand`, `defineSkill`,
  `defineSubagent`, `defineMemory`, `defineStatusline`, `defineAction`,
  `defineConfigPatch`, `defineNativeHook`
- introspection helpers: `capabilitiesOf`, `hostsSupporting`, `surfaceSupport`,
  `SURFACE_PREDICATES`
- public types

Use `@ken-jo/agent-connector/sdk/test` for offline checks:

- `explain(connector)` — per-host surface support matrix
- `explainHooks(connector, hosts)` — event honor/degrade/drop matrix
- `simulate(connector, { surface, host, event?, input })` — real
  parse→handler→format path without touching host config

## Minimal Config

```ts
import { defineConnector } from "@ken-jo/agent-connector/sdk";

export default defineConnector({
  // package.json name/mcpName/bin/version provide identity.
  // Omit id/displayName/version unless this is a deliberate override.
  server: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@acme/acme-db-mcp"],
    env: { ACME_DB_DSN: "${env:ACME_DB_DSN}" },
  },
  hooks: {
    PreToolUse: {
      matcher: "acme_write",
      async handler(evt) {
        return evt.toolName === "acme_write"
          ? { decision: "ask", reason: "Confirm Acme DB write" }
          : { decision: "allow" };
      },
    },
  },
  telemetry: { enabled: true },
  targets: "auto",
});
```

**Secrets.** `${env:VAR}` reads a variable the host process already has. For a
value that must not appear in any host config (an API key, a DSN with a password)
write `"${secret:NAME}"` instead, in a stdio server's `env` only, and tell the user
to run `<bin> secrets set NAME` once: agent-connector keeps the value in the OS
keystore (macOS Keychain, Linux Secret Service, Windows Credential Manager, or an
opt-in plaintext `file` store), the host config carries only a `{secret:NAME}`
placeholder, and the serve wrapper injects the value into the server's environment
at launch. `install` warns and `doctor` reports `<id>: secrets` while the value is
missing. `defineConnector` rejects `${secret:…}` in `args`, `headers`, `url` and
remote servers (a per-host override is judged by the transport it inherits). A
value may mix both forms — `"pg://${env:DB_USER}:${secret:db-pass}@h/db"` — the
wrapper expands the `${env:…}` part at launch and never expands the secret. A
per-host `env` override replaces the base `env` and its secrets alike.

**Logins.** For an API behind OAuth 2.0 declare the provider under `oauth.<key>`
with a preset (`google`, `microsoft`, `github`, `bing-webmaster`, `posthog`, or
`generic` for any RFC 8414 / OIDC provider), the app's own client id and the
scopes — `oauth: { google: { provider: "google", clientId: "…", clientSecret:
"${secret:google-client-secret}", scopes: ["…"] } }` — and tell the user to run
`<bin> auth login <key>` once: agent-connector runs the browser loopback or
device-code flow and keeps the refresh token in the OS keystore as
`oauth.<key>.refresh-token`. The server mints access tokens by calling
`getAccessToken({ connectorId, key })` from `@ken-jo/agent-connector/sdk` (it
refreshes and caches in process memory; with no stored login it opens the browser
itself when it can and otherwise fails with the exact `auth login` command, so a
plugin install works without `install`). Never pass an access token through
`env` — they expire; a server that refreshes on its own may read the refresh
token via `env: { X: "${secret:oauth.<key>.refresh-token}" }`. Register the app
with the provider yourself, or have each user register their own, and ship
`clientId` (a literal, `${env:VAR}`, or `${secret:NAME}` when each user registers
their own app) — agent-connector has no client ids of its own; a `clientSecret`
is a `${secret:NAME}` reference (a literal only for `google`, whose provider
documents it as not confidential), or `tokenExchangeUrl` names the developer's
own token exchange service that holds it. `install` warns and `doctor` reports
`<id>: logins` while a login is missing or a referenced secret is unset.

## Server Shape Is Product-Specific

Do not assume every MCP is a Node package launched with `npx` or a database
integration with write guards. Match the server block to the MCP you are
building:

Package-runner MCP:

```ts
server: {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@acme/acme-db-mcp"],
}
```

Local server-process MCP:

```ts
server: {
  transport: "stdio",
  command: "node",
  args: [serverPath],
}
```

Python MCP:

```ts
server: {
  transport: "stdio",
  command: "uv",
  args: ["run", "--with", "mcp", "./my_mcp_server.py"],
}
```

Use direct `python ./my_mcp_server.py` only when the runtime environment is
already managed by the package or deployment wrapper.

CLI-based MCP:

```ts
server: {
  transport: "stdio",
  command: "local-tools",
  args: ["mcp", "serve"],
}
```

Remote server MCP:

```ts
server: {
  transport: "http",
  url: "https://mcp.example.com/mcp",
}
```

For optional surfaces, describe only the product behavior the MCP actually
provides. Do not add database write-confirmation hooks unless the server
actually mutates data.

## Framework Wiring

Keep the layers separate:

1. `package.json` — public identity (`name`, `mcpName`, `bin`, `version`).
2. `bin.mjs` — branded command using
   `createConnectorCli({ packageJson, connector })`.
3. `agent-connector.config.*` — `defineConnector({ server, ...surfaces })`.
4. Host native config — generated by `install` for each detected adapter.

For stdio shapes (`npx`, `node`, `python`, `uv`, or another CLI), install points
the host at the stable agent-connector home binary, which launches the real MCP
command and can measure per-tool traffic. For remote server MCPs, install writes
the URL where the host supports remote MCP; there is no local stdio process to
wrap.

## Surfaces

- `server` — one MCP server descriptor. Stdio uses `command`/`args`/`env`;
  remote transports use `url`/`headers`/`auth`.
- `hooks` — normalized lifecycle hooks. Unsupported host events skip-warn.
- `commands`, `skills`, `subagents` — content-only surfaces rendered to native
  host files where supported.
- `memory` — standing guidance written as marker-fenced managed blocks into the
  memory/rules file each host actually reads, AGENTS.md-first with documented
  exceptions.
- `statusline` — singular fail-safe HUD render function. Use top-level
  `render(ctx)` as the fallback, `hosts.<id>.render` only for host-specific
  formatting, and `options` / `hosts.<id>.options` for supported knobs such as
  `refreshInterval`, `respectUserColors`, `hideContextIndicator`, and
  framework-enforced `maxLines`.
- `actions` — user-invokable actions dispatched by the framework runtime.
  Actions support `label`, `description`, `icon`, `placement`, `confirm`,
  top-level `run(ctx)`, and host overrides for metadata or execution.
- `platforms` — escape hatch for per-host overrides, `nativeHooks`,
  `configPatch`, memory tuning, disabling a surface, or forcing scope.
- `targets` — `"auto"` for detected hosts, or an explicit platform list.
- `publish` — metadata for official MCP artifacts such as `mcp-server-json` and
  `mcpb`.

## Validation Rules To Preserve

A connector must declare at least one of `server`, `hooks`, `commands`,
`skills`, `subagents`, `memory`, `statusline`, `actions`, or a per-platform
`nativeHooks`/`configPatch` declaration.

`defineConnector` throws `ConnectorConfigError` for invalid ids, missing required
server fields, non-function handlers, duplicate surface names, unsafe skill
resource paths, over-large memory entries, normalized event names placed in
`nativeHooks`, or refused configPatch keys.

## Escape Hatch Discipline

Use normalized cross-host fields first. Use `platforms.<id>.extra`,
`nativeHooks`, and `configPatch` only when the platform has a real native feature
the universal model does not cover.

Unsupported surfaces should be reported as skip-warn or disabled, never silently
dropped.
