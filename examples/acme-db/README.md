# acme-db example - copyable MCP server template

This is the minimal Acme DB connector example that the root README points to
when you want a small MCP server stub to copy and adapt. It keeps the runtime
shape close to a real connector without adding domain-specific behavior.

## How it works

Core files:

- `acme-db-mcp-server.mjs` - a self-contained stdio MCP stub that answers
  `initialize`, `ping`, and `tools/list`. Replace this file with your real MCP
  server when you build your own connector.
- `agent-connector.config.mjs` - the `defineConnector` config that declares the
  server command, normalized hooks, telemetry defaults, statusline, actions, and
  target platforms once.
- `package.json` - package identity (`name`, `mcpName`, `bin`) plus the local
  `"@ken-jo/agent-connector": "../.."` dependency used from a repo checkout.

The directory also includes `bin.mjs`, a package-first wrapper that exposes the
framework CLI as the example's own `acme-db-example` bin and auto-scopes
commands to this connector.

## Using the framework CLI

> **Prerequisite.** From a repo clone, run `npm install && npm run build` at the
> repo root first; the example resolves agent-connector through the
> `"@ken-jo/agent-connector": "../.."` dependency in `package.json`.

After the root build, run these from `examples/acme-db/`:

```bash
agent-connector detect             # see which platforms are installed
agent-connector install --dry-run  # preview what would be written, everywhere
agent-connector install            # deploy MCP + hooks across all detected hosts
agent-connector telemetry report   # per-tool token footprint, platform-independent
```

For package-first local testing, install this example directory and use its
branded bin:

```bash
npm install
acme-db-example install --dry-run
acme-db-example doctor
```

The branded path is useful for checking how a published connector package feels
to users; the framework CLI path is the shortest route when you are copying the
stub into your own package.
