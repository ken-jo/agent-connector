---
name: agent-connector
description: Use when building, reviewing, installing, packaging, or diagnosing an agent-connector integration. Two audiences: MCP developers use agent-connector as a framework dependency inside their own branded MCP package/bin, while agent-CLI users use connector-free `agent-connector usage` for whole-conversation token totals. Always keep package.json name/mcpName/bin/version as the default identity source; explicit id/displayName/bin/version are advanced overrides only.
---

# agent-connector

agent-connector serves two distinct audiences. Pick the track first.

- **MCP developer**: building an MCP integration. They depend on
  `@ken-jo/agent-connector`, write `defineConnector({...})`, expose their own
  branded package/bin, and deploy to detected agent hosts through that brand.
- **Agent-CLI user**: not authoring a connector. They use
  `agent-connector usage` only, which scans agent CLI logs read-only and reports
  whole-conversation totals by CLI/model/project/session/day.

The accuracy boundary is strict: developer telemetry can measure per-MCP and
per-tool tokens only for the developer's own wrapped stdio server. Connector-free
`usage` cannot itemize arbitrary MCPs or tools because agent CLIs do not log
per-tool attribution.

## Read The Right Reference

This skill is intentionally small. Read the relevant reference file before
acting:

- `references/package-first.md` — required for any scaffold, code review,
  wizard, docs, or naming/identity decision. It defines the package-first
  contract and what not to ask the user for.
- `references/authoring.md` — required when creating or editing
  `agent-connector.config.*`, SDK imports, hooks, commands, skills, subagents,
  memory, statusline, actions, or platform escape hatches.
- `references/cli-workflow.md` — required when wiring `bin.mjs`, install,
  uninstall, upgrade/sync/update, doctor, package, or marketplace/direct install
  flows.
- `references/telemetry.md` — required for any token, usage, leaderboard,
  privacy, opt-out, or "which MCP/tool costs tokens?" question.
- `references/agent-readiness.md` — required when improving agent-facing docs,
  skills, scaffold/boilerplate, lint/audit, MCP-server affordances, or other
  "make this easy for AI agents" surfaces.

For exhaustive field-level detail, use `llms-full.txt`. For the short map, use
`llms.txt`. For current host coverage and platform count, use the website
`/coverage` page; do not copy a fixed count into this skill. The public website
mirrors developer docs under `/docs/dev`.

## Default Agent Procedure

1. Inspect the target package's `package.json` first.
2. Use `package.json` `name`, `mcpName`, `bin`, and `version` as the source of
   truth for MCP identity, host alias/display label, public command, and
   connector version.
3. Do not request separate connector id, display name, bin name, or version
   unless metadata is absent or the user explicitly needs a legacy/multi-instance
   override.
4. Import new authoring code from `@ken-jo/agent-connector/sdk`.
5. Put `createConnectorCli({ packageJson, connector })` in the developer's
   package bin from `@ken-jo/agent-connector/cli`.
6. Foreground the developer's brand in user-facing commands:
   `npx @acme/acme-db-mcp install`, `acme-db doctor --probe`, etc.
7. Use `npx @ken-jo/agent-connector ... --connector` only as a local framework
   development/debug fallback.
8. Verify with typecheck/tests, SDK offline harnesses when relevant, then
   `doctor --probe` when a real stdio server/host is available.

## Hard Do-Nots

- Do not use agent-connector to write a brand-new MCP server protocol
  implementation. It deploys and measures an existing server command/URL.
- Do not present global `@ken-jo/agent-connector` install as the normal user
  install path for a branded MCP package.
- Do not claim connector-free `usage` can report per-MCP or per-tool cost.
- Do not duplicate package metadata in `defineConnector` unless there is a real
  override case.
- Do not silently drop unsupported host surfaces; the expected behavior is
  native support, disabled, or skip-warn with a reason.
