# Agent Readiness Reference

Use this when improving how AI agents discover, scaffold, install, validate, or
document agent-connector integrations.

This reference is informed by shadcn/ui's public agent-facing surfaces:

- `https://ui.shadcn.com/llms.txt` — short, link-dense map for LLMs.
- `https://ui.shadcn.com/docs/skills` — small skill entry point that reads
  project config and routes the assistant to focused knowledge.
- `https://ui.shadcn.com/docs/mcp` and
  `https://ui.shadcn.com/docs/registry/mcp` — MCP server that lets assistants
  browse/search/install registry items through natural language.
- `https://ui.shadcn.com/docs/components-json` — structured project config used
  by CLI/agents to understand framework, aliases, and generation rules.
- `https://ui.shadcn.com/docs/registry/registry-json` and
  `https://ui.shadcn.com/docs/registry/registry-item-json` — schema-backed
  registry/index/item metadata with descriptions, dependencies, and files.

## Patterns To Adopt

### 1. Short skill, deep references

Keep `SKILL.md` as a router. Put details in `references/*.md`, and make each
reference answer one class of task. The skill should tell agents which file to
read, not carry every rule inline.

Current references:

- `package-first.md` — identity and naming.
- `authoring.md` — SDK and `defineConnector`.
- `cli-workflow.md` — branded bin and lifecycle commands.
- `telemetry.md` — telemetry/usage split.
- `agent-readiness.md` — this meta-reference.

### 2. Structured project context first

shadcn agents read `components.json` through `shadcn info --json`. For
agent-connector, the equivalent source of truth is:

1. `package.json`
2. `agent-connector.config.*`
3. optional generated/explain output from SDK test helpers or doctor

Agents should not ask users to re-enter values already present in
`package.json`.

Future-friendly CLI shape:

```bash
agent-connector audit --json
agent-connector info --json
agent-connector init --dry-run
```

Do not document those as shipped commands until implemented. Track them as
boilerplate/lint/audit feature work.

### 3. Machine-readable maps

Maintain both:

- `llms.txt` — compact map, routing, package-first rules, common commands.
- `llms-full.txt` — exhaustive contract with field tables, examples, CLI
  details, adapter behavior, telemetry boundaries, and agent authoring contract.

Do not make agents scrape prose pages when a short machine-readable route exists.

### 4. Agent-visible examples

Examples should be complete enough for an agent to copy into a package:

- `package.json`
- `bin.mjs`
- `agent-connector.config.mjs`
- optional server stub
- verification commands

Examples should foreground the developer package:

```bash
npx @acme/acme-db-mcp install
acme-db doctor --probe
```

Framework fallback belongs in notes, not as the primary path.

Keep the example set balanced. Do not let a database MCP become the only mental
model. Include or validate multiple launch shapes when changing scaffolds or
docs: package runner, local server process, CLI-based MCP, and remote server MCP.

### 5. Natural-language MCP affordance

shadcn's MCP server lets assistants browse/search/install registry items from
configured registries. The analogous future surface for agent-connector is an
MCP server or CLI-backed tool layer that can:

- inspect package identity
- explain connector config
- list supported hosts/surfaces
- scaffold a branded CLI package
- run offline `explain`/`simulate`
- run dry-run install plans
- report doctor/probe status

Until implemented, keep this as a design target and rely on CLI commands plus
skill references.

### 6. Schema-backed distribution

shadcn registries are schema-backed and dependency-aware. agent-connector should
apply the same idea to future boilerplate/template distribution:

- template manifest
- declared files
- dependencies/devDependencies
- verification commands
- supported host surfaces
- required env vars/secrets
- clear descriptions for agent selection

This belongs in future boilerplate/registry work, not in ad hoc prose snippets.

## Agent Acceptance Checklist

An agent-facing change is ready when:

- The agent can find the right entry point from `llms.txt` or `SKILL.md`.
- The required detailed reference is small enough to read on demand.
- The first step is structured context inspection, usually `package.json`.
- Generated commands use the branded package/bin by default.
- Unsupported host behavior is explicit: native, disabled, or skip-warn.
- The validation path is concrete: typecheck/test, SDK offline harness, dry-run,
  and `doctor --probe` when available.
- Claims about shipped commands and APIs match the current code.
