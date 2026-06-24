# Package-First Contract

agent-connector is a framework for developer-branded MCP packages. The
developer's package is the foreground product; `@ken-jo/agent-connector` is the
dependency underneath.

## Identity Source Of Truth

Read `package.json` first. For normal packaged connectors:

- `name` is the npm package users install or run with `npx`.
- `mcpName` is the MCP package/server identity when present.
- `bin` is the public command users type.
- `version` is the connector/package version.

Do not ask the user for these values again when they already exist. In
`defineConnector`, omit `id`, `displayName`, and `version` unless there is a
specific legacy or multi-instance reason. The host-native ids written during
install are generated artifacts; do not copy those generated ids back into
`defineConnector({ id })` as if they were another required input.

Example:

```json
{
  "name": "@acme/acme-db-mcp",
  "version": "1.0.0",
  "type": "module",
  "mcpName": "io.github.acme/acme-db",
  "bin": {
    "acme-db": "./bin.mjs"
  },
  "dependencies": {
    "@ken-jo/agent-connector": "^0.4.94"
  }
}
```

## Correct Mental Model

- Developer installs the framework as a package dependency.
- Developer ships their own MCP package and bin.
- User runs the developer's brand: `npx @acme/acme-db-mcp install` or
  `acme-db install`.
- The framework writes native host configs and routes runtime `serve`/`hook`
  through the shared home binary.
- Global `@ken-jo/agent-connector` is primarily for framework development,
  debug fallback, or connector-free token usage reports.

## Command Boundary

Do not collapse every command into one brand rule.

- MCP lifecycle/runtime commands are brand-first: `install`, `doctor`,
  `update`/`upgrade`, `uninstall`, `telemetry`, and connector-scoped
  `leaderboard` should be shown under the developer's package/bin.
- Framework tooling commands are framework-first: `package` emits host plugin
  bundles and MCP distribution artifacts from a config, so show it as
  `npx @ken-jo/agent-connector package --connector ./agent-connector.config.mjs`
  or global `agent-connector package --connector ...`.
- Connector-free user telemetry is also framework-first:
  `npx @ken-jo/agent-connector usage report` reads agent CLI logs when the user
  has not authored a connector.

## Balanced Example Families

Use examples that match the MCP's product category:

- Package-runner MCP: wrapper package/bin owns install/doctor/uninstall and
  `server.command` launches `npx -y <package>`.
- Local server-process MCP: wrapper package/bin owns install/doctor/uninstall
  and `server.command` launches `node <server-file>` or another bundled process.
- Python MCP: wrapper package/bin owns install/doctor/uninstall and
  `server.command` should usually launch `uv run --with mcp <server.py>`; use
  direct `python <server.py>` only when the environment is managed elsewhere.
- CLI-based MCP: wrapper package/bin owns install/doctor/uninstall and
  `server.command` launches an existing executable such as `local-tools mcp
  serve`.
- Remote server MCP: wrapper package/bin still owns install/doctor/uninstall,
  while `server.transport: "http"` points at the remote MCP endpoint.

The package-first rule is the same in all cases. Only the server launch shape
and optional guidance surfaces change.

## Agent Checklist

When generating or reviewing a connector:

1. Confirm `package.json` has `name`, `version`, `type: "module"`, a `bin`, and
   a dependency on `@ken-jo/agent-connector`.
2. Prefer `mcpName` when the MCP identity should be more stable or explicit
   than the npm name.
3. Ensure MCP lifecycle/runtime docs and commands foreground the branded package/bin.
4. Ensure packaging/distribution artifact docs use the framework `package`
   command with an explicit `--connector`.
5. Treat duplicate `defineConnector({ id, displayName, version })` values as a
   smell unless justified. If a generated host config shows an id, add a comment
   that it is an install artifact derived from package metadata, not a second
   value the user must maintain.
6. Keep examples aligned with the real package version.

## Good vs Bad

Good:

```bash
npx @acme/acme-db-mcp install
acme-db doctor --probe
```

Development fallback:

```bash
npx @ken-jo/agent-connector install --connector ./agent-connector.config.mjs
```

Good for framework packaging/distribution artifacts:

```bash
npx @ken-jo/agent-connector package --connector ./agent-connector.config.mjs --format all
```

Good for connector-free token telemetry:

```bash
npm i -g @ken-jo/agent-connector
agent-connector usage report
```

Bad as normal user guidance:

```bash
# bad as normal user install guidance; use only as framework fallback/debug
npm i -g @ken-jo/agent-connector
agent-connector install --connector ./agent-connector.config.mjs
```
