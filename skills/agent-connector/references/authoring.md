# Authoring Reference

Use this when creating or editing `agent-connector.config.*`.

## Imports

For new connector authoring, prefer the SDK subpath:

```ts
import {
  defineConnector,
  defineHook,
  defineMemory,
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

## Surfaces

- `server` — one MCP server descriptor. Stdio uses `command`/`args`/`env`;
  remote transports use `url`/`headers`/`auth`.
- `hooks` — normalized lifecycle hooks. Unsupported host events skip-warn.
- `commands`, `skills`, `subagents` — content-only surfaces rendered to native
  host files where supported.
- `memory` — standing guidance written as marker-fenced managed blocks into the
  memory/rules file each host actually reads, AGENTS.md-first with documented
  exceptions.
- `statusline` — singular fail-safe HUD render function.
- `actions` — user-invokable actions dispatched by the framework runtime.
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

