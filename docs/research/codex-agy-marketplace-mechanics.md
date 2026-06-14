# codex / agy marketplace driver mechanics (empirically confirmed)

Live-probed 2026-06-14 with codex-cli **0.139.0** and agy **1.0.7** in isolated
sandboxes against the CURRENT emitter output. These are the ground facts the
`install --method marketplace` drivers for codex + agy are built on.

## codex (format `codex-plugin`) — mirrors the claude driver closely

Emitter layout for `package --format codex-plugin --out <root>`:
- `<root>/.agents/plugins/marketplace.json` — SHARED catalog at the root
  (`{ name:"agent-connector", owner, plugins:[{name,source:"./<id>",description}] }`),
  exactly analogous to claude's `<root>/.claude-plugin/marketplace.json`.
- `<root>/<id>/.codex-plugin/plugin.json` + `.mcp.json` + `commands/` + `hooks/hooks.json` + `skills/`.

Lifecycle (all exit 0, all probe-first idempotent):
- `codex plugin marketplace add <root>` → registers marketplace `agent-connector`
  (config.toml `[marketplaces.agent-connector] source_type="local" source="<root>"`).
  Prints a harmless `WARNING: … Refusing to create helper binaries under temporary dir`
  when CODEX_HOME is under /tmp — install still proceeds.
- `codex plugin add <id>@agent-connector` → installs to
  `<CODEX_HOME>/plugins/cache/agent-connector/<id>/<version>/`; config.toml gains
  `[plugins."<id>@agent-connector"] enabled = true`. Re-add = idempotent reinstall (exit 0).
- `codex plugin list` → `PLUGIN  STATUS  VERSION  PATH`; STATUS `installed, enabled` vs `not installed`.
- `codex plugin remove <id>@agent-connector` → removes the plugin (config.toml entry gone).
- `codex plugin marketplace remove agent-connector` → removes the marketplace.
  After both, config.toml is **0 bytes**; empty cache dirs `plugins/cache/agent-connector/`
  linger (codex quirk, harmless — no files, no config).

State probes (read-only, parse `<CODEX_HOME>/config.toml`; CODEX_HOME defaults to `~/.codex`):
- **installed**: `[plugins."<id>@agent-connector"]` table present. (Do NOT use the cache
  dir — empty dirs linger after uninstall.)
- **marketplace registered path** (collision check): `[marketplaces.agent-connector].source`.

Differences from claude: catalog dir `.agents/plugins` (vs `.claude-plugin`); install
verb `plugin add` (vs `plugin install`); remove verb `plugin remove` (vs `plugin uninstall`);
state in TOML `config.toml` (vs JSON installed_plugins/known_marketplaces); `CODEX_HOME`
env (vs `CLAUDE_CONFIG_DIR`). No separate `plugin validate` needed — `marketplace add`
validates. Update: no `plugin update` verb — re-stage + `plugin add` (idempotent;
version-cached, so bump connector.version for the new copy to win, same caveat as claude).

## agy (format `agy-plugin`) — direct install-by-path, NO marketplace

Emitter layout for `package --format agy-plugin --out <root>`: `<root>/<id>/` with root
`plugin.json` + `hooks.json` (ROOT, post-fix) + `mcp_config.json` + `commands/` + `skills/`.
NO catalog ships (agy installs by path).

Lifecycle (all exit 0, fully idempotent both directions):
- `agy plugin validate <root>/<id>` → ok (warns if the embedded home-bin path is absent —
  harmless for staging; exits 0).
- `agy plugin install <root>/<id>` → copies the bundle to `~/.gemini/config/plugins/<id>/`
  and records it in `~/.gemini/config/plugins/import_manifest.json`
  (`{ "imports":[{ name, source:"antigravity", importedAt, components:[…] }] }`).
  Re-install = silent idempotent overwrite (exit 0, no warning).
- `agy plugin list` → prints the manifest JSON, or `No imported plugins.` when empty.
- `agy plugin uninstall <id>` → `Uninstalled plugin "<id>"`, removes the dir, manifest
  becomes `{ "imports": null }`. Idempotent: uninstalling an absent plugin still exits 0.

State probe (read-only): `~/.gemini/config/plugins/import_manifest.json` → `imports[]`
contains an entry with `name === <id>`. (Fallback: `~/.gemini/config/plugins/<id>/plugin.json`
exists.) agy roots at `~/.gemini/` with NO dedicated config-dir env — isolation is via HOME.

No marketplace registration → no name-collision check, no de-registration step; cleanup
is just removing the staged bundle dir. The host copies the bundle into its own store, so
the staged dir is only needed at install time (still staged under the data-root for
upgrade re-staging + drift hashing).

## Driver design (shared)

Both reuse `marketplace-drivers/shared.ts` (`findOnPath`, `runHostCommand` — no shell,
stdin ignored, hard timeout, never throws). A `MarketplaceDriver` interface abstracts:
`binary()`, `stagingRoot()`, `pluginDir(id)`, `installed(id)`, `stage(connector)→hash`,
`planInstall/planUninstall` (dry-run hints), `driveInstall/driveUninstall/driveUpdate`,
`finishUninstall` (cleanup). claude + codex are "catalog" drivers (shared root + catalog +
marketplace register); agy is a "direct" driver (install-by-path). The orchestrator in
marketplace.ts dispatches every target through `getDriver(platform)`; platforms without a
driver keep the existing manual-hint skip/warn path. DRIVABLE set → claude-code, codex,
antigravity, antigravity-cli.
