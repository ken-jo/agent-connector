# CLI Workflow Reference

Use this when wiring bins, install/doctor/uninstall flows, packaging, or
marketplace behavior.

## Branded CLI

The developer package should expose its own bin:

```js
#!/usr/bin/env node
import { createConnectorCli } from "@ken-jo/agent-connector/cli";

process.exitCode = await createConnectorCli({
  packageJson: new URL("./package.json", import.meta.url),
  connector: new URL("./agent-connector.config.mjs", import.meta.url),
}).run();
```

`createConnectorCli({ packageJson, connector })` derives the bin name/version
from `package.json`, exposes every agent-connector subcommand under the
developer's brand, and auto-scopes commands to that connector.

## User-Facing Commands

Foreground the developer package/bin:

```bash
npx @acme/acme-db-mcp detect
npx @acme/acme-db-mcp install --dry-run
npx @acme/acme-db-mcp install
npx @acme/acme-db-mcp doctor --probe
npx @acme/acme-db-mcp upgrade
npx @acme/acme-db-mcp uninstall
```

Installed-bin form is equivalent:

```bash
acme-db install
acme-db doctor --probe
```

Framework fallback for local development/debugging:

```bash
npx @ken-jo/agent-connector install --dry-run --connector ./agent-connector.config.mjs
```

Do not present the fallback as the normal user path for a branded MCP package.

## Install Semantics

- `detect` lists installed platforms, scopes, capabilities, and hook paradigm.
- `install --method direct` writes native MCP/hook/content config.
- `install --method marketplace` drives supported host plugin flows when
  possible and prints manual commands for non-drivable formats.
- `--dry-run` previews without writes.
- `--targets` restricts to explicit platform ids.
- default target selection is detected hosts intersected with the registry; it
  never blindly installs to every registered adapter.
- double-install guards prevent the same connector being installed by both
  direct and marketplace methods.

## Day-2 Commands

- `upgrade` (aliases `sync`, `update`) re-renders configs idempotently and heals
  the stable home-binary pointer.
- `doctor` checks config presence, registration drift, and surface health.
- `doctor --probe` runs a live stdio MCP handshake:
  initialize → ping → tools/list.
- `status` reports which connectors are installed on which hosts.
- `uninstall --method auto` reverses the actual installed method.
- `uninstall --purge` additionally removes registered framework state and the
  home binary when no connectors remain.

## Packaging

`package` emits marketplace/extension bundles or official MCP artifacts.

Marketplace formats include host plugin/extension bundles such as Claude Code,
Codex, Gemini/Antigravity, Qwen, Cursor, Kimi, and npm-plugin forms. Official
MCP artifacts such as `mcp-server-json` and `mcpb` require the connector
`publish` block and describe the developer's real server, not the telemetry
wrapper.

## Verification

For code changes, run local typecheck/tests. For integration changes, prefer:

```bash
npx @acme/acme-db-mcp install --dry-run
npx @acme/acme-db-mcp doctor --probe
```

Use SDK offline harnesses before touching host config when the question is about
hook or surface behavior.

