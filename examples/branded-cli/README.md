# branded-cli example — ship your own CLI on top of AgentConnect

This is a realistic developer package, `acme-db-tools`, that depends on
`agentconnect` and ships its **own** branded CLI, `acme-db`. The consumer
never installs `agentconnect` globally and never types `--connector` — every
subcommand is auto-scoped to the connector this package ships.

## How it works

Three files:

- `agentconnect.config.mjs` — the connector: a stdio MCP server (wrapped for
  per-tool token telemetry), a `PreToolUse` guard hook, and an `/acme-schema`
  command. Declared once via `defineConnector`.
- `bin.mjs` — the `acme-db` bin. It calls `createConnectorCli({ name, connector })`
  from `agentconnect/cli` and runs it.
- `package.json` — `bin: { "acme-db": "./bin.mjs" }` + a dependency on
  `agentconnect`.

```js
// bin.mjs (essence)
import { fileURLToPath } from "node:url";
import { createConnectorCli } from "agentconnect/cli";

createConnectorCli({
  name: "acme-db",
  connector: fileURLToPath(new URL("./agentconnect.config.mjs", import.meta.url)),
}).run();
```

## Using the branded CLI

After `npm install` (which links the `acme-db` bin):

```bash
# Deploy the acme-db connector across every detected agent platform.
# Auto-scoped: no --connector needed.
acme-db install
acme-db install --dry-run          # preview the plan, nothing written
acme-db sync                       # idempotent re-install
acme-db doctor                     # health-check every platform for acme-db

# Telemetry + leaderboards, scoped to the acme-db connector.
acme-db leaderboard                # the 🔌 MCP/plugin + 🛰️ host-native sections show acme-db
acme-db telemetry report --by tool # acme-db's per-tool token telemetry
acme-db telemetry leaderboard      # "which acme-db tool costs the most"

# Package the connector as an installable plugin/extension bundle.
acme-db package --format claude-plugin

# Every agentconnect subcommand is available, branded as `acme-db`:
acme-db --help
```

The consumer can still override the auto-scope when they need to — passing an
explicit `--connector <path>` or `--connector-id <id>` wins over the injected
default.

> Note: the `acme-db leaderboard` 🖥️ host/user section stays connector-agnostic
> (host CLI logs carry no connector attribution), so only the 🔌 MCP/plugin and
> 🛰️ host-native-turns sections are filtered to `acme-db`.
