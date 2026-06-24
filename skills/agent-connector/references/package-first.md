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
specific legacy or multi-instance reason.

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

## Agent Checklist

When generating or reviewing a connector:

1. Confirm `package.json` has `name`, `version`, `type: "module"`, a `bin`, and
   a dependency on `@ken-jo/agent-connector`.
2. Prefer `mcpName` when the MCP identity should be more stable or explicit
   than the npm name.
3. Ensure docs and commands foreground the branded package/bin.
4. Treat duplicate `defineConnector({ id, displayName, version })` values as a
   smell unless justified.
5. Keep examples aligned with the real package version.

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

Bad as normal user guidance:

```bash
npm i -g @ken-jo/agent-connector
agent-connector install --connector ./agent-connector.config.mjs
```

