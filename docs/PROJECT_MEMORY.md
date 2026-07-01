# Project Memory

Last updated: 2026-07-01

## Current Product Direction

agent-connector should focus on MCP implementers: developers who already have, or are about to build, an MCP server and need to ship it across agent CLIs, IDE extensions, and apps without maintaining one integration per host.

The public site should not read like a generic agent-user tool. It should explain MCP terms, implementation steps, packaging choices, host coverage confidence, and why the framework belongs in the developer's own branded MCP package.

## Improvements To Finish First

1. Keep marketing coverage focused on recognizable or production-relevant hosts. Public coverage surfaces should hide open-source hosts below 1,000 GitHub stars, while preserving the full adapter registry in code and technical references.
2. Keep the root-level `/docs/guides` track focused on beginner education. The agent-connector beginner guide should teach protocol architecture, terms, surfaces, tool contracts, server lifecycle, tool-call flow, transports, verification, debugging, and safety while explaining how agent-connector maps those concepts into host CLIs; adjacent guide pages should explain host hooks, HUD/statusline, actions, and special surfaces in beginner terms.
3. Add a blog surface for AI and product writing. Until editorial direction is reviewed, publish only a single BUILDING test post that verifies routing, RSS, and image rendering instead of exposing draft-like articles.
4. Keep release and verification hygiene visible: repository version, npm latest, GitHub release, CI, and live host verification should not drift silently.
5. Keep low-memory development ergonomics documented and scriptable; the README warns about single-fork testing, so package scripts should expose that path directly.

## Next Development Direction

- Make the scaffold/wizard path the primary onboarding path for MCP developers.
- Expand `install <source>` beyond GitHub source specs toward npm/registry/archive intake.
- Increase live verification depth by tier, not by raw platform count: full E2E where possible, live-accept where auth blocks model turns, install/doctor placement for GUI-only hosts.
- Continue reducing duplicated support claims by generating public docs from adapter capabilities and keeping human-authored provenance separate.
- Keep statusline/action customization conservative and capability-driven. SDK knobs should expose only what adapters can honestly map today; hosts with preset-only or undocumented UI should skip-warn instead of being forced into a fake `render(ctx)` or action affordance model.

## Completed Direction Work

- Added `audit` as a pre-install package identity lint for branded MCP packages. It checks package name/version/bin, `@ken-jo/agent-connector` runtime dependency placement, connector id/version drift, and `files` coverage before users run install.
- Moved first-touch developer onboarding into a root-level `/docs/guides` track and the scaffold wizard: `/docs/guides/mcp-beginner` starts with neutral MCP concepts, includes an architecture diagram plus ASCII flows for host/server/tool/hook behavior, and mentions agent-connector only after a one-host server works. The Guides track now has expandable beginner pages for how agent-connector fits, host hooks by CLI paradigm, HUD/statusline behavior, actions, and commands/skills/subagents/memory.
- Expanded `install <source>` intake beyond GitHub/raw git to include explicit `npm:<package>[@version]` packages and tarball archives (`archive:<path-or-url>` or direct `.tgz` / `.tar.gz`), with the same stable cache and connector package gate.
- Added a generated adapter capability snapshot for the public site. Coverage and platform docs can now summarize what agent-connector actually wires from the adapter registry, while human-authored host-native provenance remains separate in `platform-data.ts`.
- Added a generated host verification snapshot from `docs/host-verification-results.csv` and surfaced a public verification ladder on `/coverage`, separating full E2E, live-accept/auth-blocked, and install+doctor placement confidence.
- Added a generated release hygiene snapshot for `/coverage`, showing repository package version, npm latest, GitHub release snapshot availability, and CI/deploy workflow presence so release drift is visible instead of hidden in README badges only.
- Added blog discovery plumbing: prerender now emits `/feed.xml`, the site head advertises it as an RSS alternate, and the blog index links to the feed directly. The public blog currently carries one BUILDING test post with a cover image so image rendering can be reviewed before real articles are published.
- Hardened the statusline/action SDK around currently supportable host behavior. Statusline now has shared/per-host options (`refreshInterval`, `respectUserColors`, `hideContextIndicator`, framework-enforced `maxLines`) and adapters write only supported command-driven settings for `antigravity-cli`, `claude-code`, and `qwen-code`. Actions now carry UI metadata (`label`, `icon`, `placement`, `confirm`) plus per-host overrides and capability metadata describing whether the host affordance is exec, exec-file, manual-hook, paste, plugin-command, or task. Verified with `npm run typecheck`, `npm run build`, and the focused statusline/action/docs drift regression suite.

## Public Coverage Rule

Public-facing support lists should highlight:

- closed-source flagship hosts, because stars do not apply;
- open-source hosts with at least 1,000 GitHub stars;
- all lower-star or early-stage adapters only in developer/reference contexts.

This keeps the first impression focused and avoids listing immature or low-signal support targets as if they were equally important launch platforms.
