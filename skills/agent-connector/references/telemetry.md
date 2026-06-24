# Telemetry And Usage Reference

Use this for token, usage, leaderboard, privacy, or opt-out questions.

## Two Separate Axes

There are two token-measurement axes. They measure different things and must not
be summed or blurred.

## Developer Telemetry

Developer telemetry measures the developer's own wrapped stdio MCP server.

- Command family: `telemetry report|export|leaderboard`
- Requires a registered connector.
- Requires serve-proxy traffic.
- Stdio servers are wrapped by default when telemetry is enabled.
- Remote `http`/`sse`/`ws` servers are registered but not wrapped, so they do not
  produce per-tool telemetry.
- It can report per-MCP, per-tool, per-surface, per-session, and per-project
  aggregate counts for the connector's own surfaces.

Examples:

```bash
acme-db telemetry report --by tool --since 7d
acme-db telemetry leaderboard --by mcp
acme-db leaderboard
```

This is the only path that can answer "which of my own MCP tools costs the most
tokens?"

## Connector-Free Usage

Connector-free usage is for an agent-CLI user who has not authored a connector.

- Command family: `usage report|export|leaderboard`
- Requires no connector.
- Requires no install.
- Reads each host's own session logs/databases read-only.
- Reports whole-conversation totals only.
- Group-by dimensions are platform, project, session, model, and day.
- It cannot report per-MCP or per-tool cost because agent CLIs do not log
  per-tool token attribution.

Examples:

```bash
npx @ken-jo/agent-connector usage report --by platform --since 7d
npx @ken-jo/agent-connector usage leaderboard --by model
npx @ken-jo/agent-connector usage export --format csv --out usage.csv
```

Global framework install is acceptable here as a convenience for repeated
connector-free usage:

```bash
npm i -g @ken-jo/agent-connector
agent-connector usage report
```

Do not use this global install guidance as the normal branded MCP package
install path.

## Leaderboards

The unified leaderboard shows origin-labeled boards with different prerequisites:

- MCP/plugin board: needs connector + serve traffic.
- host/user board: connector-free CLI log scan.
- live host-native turns board: opt-in host-native turn capture where supported.

Never sum these boards together.

## Privacy

Telemetry stores aggregate counts only. Raw prompts, tool arguments, and tool
results are not stored. Default behavior is local-first with zero network egress.

Opt out:

```bash
AGENT_CONNECTOR_TELEMETRY=0
```

or in connector config:

```ts
telemetry: { enabled: false }
```

Network calibration and host-native turn capture are opt-in only.
