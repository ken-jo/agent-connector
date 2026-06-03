# Antigravity paths — CONFIRMED by local install (2026-06-03)

Observed on a real machine with Antigravity IDE + `agy` CLI v1.0.0 installed. This
**supersedes** the medium-confidence guesses in `antigravity-plan.md`. Apply these
corrections to the adapters + usage readers.

## Antigravity IDE — real layout under `~/.gemini/antigravity/`
- **MCP config (CANONICAL): `~/.gemini/antigravity/mcp_config.json`** — exists (empty until servers added). There is **NO `~/.gemini/config/mcp_config.json`** on this install.
  - → **CORRECTION:** the plan's "BUG 2 reorder so `config/` is the default" is WRONG. The default/canonical user MCP path is `~/.gemini/antigravity/mcp_config.json`. Keep path-probing (prefer existing) but the **fresh-install default must be `antigravity/`, not `config/`**. (`antigravity-cli/` and `config/` stay as probed fallbacks only.)
- **Workflows (commands): `~/.gemini/antigravity/global_workflows/*.md`** — confirmed (brainstorm.md, coordinate.md, plan.md, review.md, setup.md, …). Markdown bodies. ✓ matches plan.
- **Conversations / usage: `~/.gemini/antigravity/conversations/<uuid>.pb`** — **protobuf**, no public schema. `brain/<uuid>/` holds media + `*.metadata.json` only. **There are NO `transcript*.jsonl` files.**
  - → **CORRECTION (usage reader):** Antigravity native usage is protobuf (`.pb`) and NOT parseable without the schema. The reader must NOT claim to read native JSONL transcripts. Behavior: read the tokscale synced-cache if present; otherwise emit nothing and report "native store is protobuf (.pb), not readable" (like the other synced platforms). Treat as `kind:"synced"` / host-estimated, not local-jsonl.
- **Hooks / skills: NOT present** on this install (no `hooks.json`, no `skills/`, no `.agents/` global). These remain MEDIUM-confidence → keep path-probing + doctor "verify for your version"; do not hard-fail. The IDE customization root is clearly `~/.gemini/antigravity/` (not `~/.gemini/config/`).
- Other dirs (do NOT write): `brain/`, `conversations/`, `annotations/`, `browser_recordings/`, `code_tracker/`, `context_state/`, `html_artifacts/`, `implicit/`, `knowledge/`, `prompting/`.

## Antigravity CLI (`agy` v1.0.0) — SHARES the IDE dir
- `agy` binary at `~/.local/bin/agy`. Subcommands: `install`, `plugin`/`plugins` (install/uninstall/list/enable/disable), `update`, `changelog`.
- **No distinct config dir:** `~/.gemini/antigravity-cli/`, `~/.config/antigravity*`, `~/.agy` all ABSENT. `agy` shares **`~/.gemini/antigravity/`** with the IDE.
  - → **CORRECTION (antigravity-cli adapter):** user-scope config = the SAME `~/.gemini/antigravity/mcp_config.json` (do NOT target `~/.gemini/antigravity-cli/`). Distinguish the platform by the `agy` binary + runtime markers, not a separate dir. Its extension surface is the **`agy plugin`** system (future: deploy as an agy plugin); MCP/workflows share the IDE files (so installing both is idempotent — already observed as skip).
- `~/.antigravity-server/` = the VS Code-server-style host (extensions/, bin/, data/User) — IDE backend, not a config target.
- `~/.cache/antigravity/staging` = cache, not a config target.

## Net corrections to apply (after the enrichers workflow merges, to avoid file conflict)
1. `src/adapters/antigravity/index.ts`: user MCP default = `~/.gemini/antigravity/mcp_config.json` (probe order: existing → `antigravity/` default → `config/`/`antigravity-cli/` fallbacks). Customization root for hooks/skills = `~/.gemini/antigravity/` (not `config/`). Workflows global = `~/.gemini/antigravity/global_workflows`.
2. `src/adapters/antigravity-cli/index.ts`: share `~/.gemini/antigravity/` (override detection to the `agy` binary; drop the `~/.gemini/antigravity-cli/` user paths).
3. `src/usage/readers/antigravity.ts` + `antigravity-cli.ts`: native store is `conversations/*.pb` (protobuf, unreadable) → tokscale-cache fallback else skip; do not parse `transcript*.jsonl` (none exist). Reclassify toward `synced`/host-estimated.
4. `src/usage/registry.ts` + `paths.ts`: align with the above (antigravity readers are synced-cache-or-skip, not local-jsonl).
