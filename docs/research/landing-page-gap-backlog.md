# Landing-page gap backlog — the `host-gap` cells to close

The landing page (`site/src/platform-data.ts`) renders a 3-state chip per (platform × surface):
`supported` (we install it), `host-gap` (the host natively offers it but agent-connector has NOT
wired it yet — an honest gap shown by design), `host-na` (the host doesn't offer it). The drift
test enforces `surfaces[k] === true ⟹ hostNative[k] === true`, so closing a gap means actually
implementing the surface in the adapter, then flipping `surfaces[k]` to true.

These are the `host-gap` cells as of this writing — the concrete "under-implemented per the
landing page" backlog (8 platforms, 16 cells):

| Platform | Paradigm | host-gap surfaces |
|---|---|---|
| droid | json-stdio | commands, skills, subagents |
| amp | mcp-only | **hooks**, skills, subagents |
| roo-code | mcp-only | commands, skills |
| trae | mcp-only | skills, subagents |
| codebuff | mcp-only | skills, subagents |
| openclaw | ts-plugin | skills, subagents |
| warp | mcp-only | commands |
| goose | json-stdio | skills |

Per surface: skills (7) · subagents (5) · commands (3) · hooks (1).

## STATUS — 10 of 16 closed (the rest are honest, evidence-backed non-gaps)

Each cell was first contract-verified by a research + **adversarial-refute** workflow against
primary sources (official docs / host source) before any wiring — a guessed path fails the
honesty bar. Result:

**✅ CLOSED (implemented + `surfaces[k]` flipped, drift-guard green):**
- droid — commands (`.factory/commands/<name>.md`), skills (`.factory/skills/<name>/SKILL.md`),
  subagents (`.factory/droids/<name>.md`, markdown)
- roo-code — commands (`.roo/commands`), skills (`.roo/skills`)
- trae — skills (`.trae/skills/<name>/SKILL.md`)
- codebuff — skills (`.agents/skills`, docs **and** `load-skills.ts` source verified)
- openclaw — skills (`<workspace>/skills`) → **nemoclaw inherits it** (extends OpenClawAdapter)
- amp — skills (`~/.config/agents/skills` | `.agents/skills`)
- goose — skills (`~/.agents/skills` | `.agents/skills`)

**🚫 PERMANENT GAP (host offers it, but no on-disk file surface to write — adversarially confirmed):**
- warp commands — app-managed Warp Drive prompts; FRs warpdotdev/warp#9107 & #6857 prove Warp does
  not read `.claude/commands` today (and the "commands" hostNative partly double-counted skills).
- trae subagents — UI-created + cloud share links (`s.trae.ai/a/<id>`), no `.trae/agents/` file.
- openclaw subagents — runtime runs + inline `agents.list[]` config, no authored-file folder.

**⏸ DEFERRED (real but not a clean markdown file-drop — needs a separate, careful pass):**
- amp hooks — only an experimental Bun TS-plugin API (`.amp/plugins/*.ts`); no declarative hook
  file (the earlier "amp.hooks array" was cross-contaminated from Codex's docs).
- amp subagents — only experimental `amp.experimental.createAgent` / role-specific `.agents/checks`.
- codebuff subagents — confirmed real, but an executable `.agents/*.ts` `AgentDefinition` module
  (SDK-schema-coupled), not markdown.

## How to close each (the work per cell)

Most are CONTENT surfaces (commands/skills/subagents) on mcp-only or specific hosts. Closing one:
1. **Verify the host's real surface contract first** — `hostNative=true` came from research/the
   provenance comments in platform-data.ts (lines ~97-180), some low-confidence. Confirm the host
   actually reads a commands/skills/subagents folder at a documented path BEFORE wiring (the same
   honesty bar as the mimo-code/nemoclaw adapter work — never ship a guessed path).
2. **Implement the adapter method** (`installCommands` / `installSkills` / `installSubagents`) +
   set the `supports*` capability flag true. BaseAdapter has the generic patterns; mirror an
   adapter that already does that surface.
3. **Flip `surfaces[k]` to true** in platform-data.ts (the drift test then passes because the
   adapter really does it) and re-verify the wall + drift guards.
4. **amp `hooks`** is the one non-content gap (a mcp-only host claiming a hook surface) — needs the
   most scrutiny: confirm amp's hook mechanism + paradigm before promoting it off mcp-only.

## Priority hint (cheapest, highest-confidence first)
- goose `skills`, warp `commands` — single-cell, content surfaces; quick if the path is confirmed.
- droid (3 cells, json-stdio) — droid (Factory) is well-documented (already a json-stdio adapter
  with a real statusLine); its commands/skills/subagents paths should be findable.
- roo-code / trae / codebuff / openclaw — VS Code-family / niche; verify each host actually reads
  the content folder (some may be plugin-bundle-only, i.e. a permanent gap, not a quick win).
- amp `hooks` — last (paradigm change, highest risk).

## Note — the reverse gap (page behind code)
The wall models only the 6 original surfaces (mcp/hooks/commands/skills/subagents/memory). The
NEW surfaces this branch added — `statusline`, `actions`, `configPatch`, `nativeHooks` — are NOT
on the wall yet. Adding them (+ their per-host hostNative provenance) is a separate site-update
task (code ahead of page), distinct from the host-gap backlog above.
