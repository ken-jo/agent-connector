# kilo-cli / kilo (VS Code ext) / pi — surface ground truth

Behavioral re-derivation, 2026-06-13. Triggered by the owner's observation that
**kilo-cli is an OpenCode fork yet our wall showed it as hooks-only** while
opencode shows commands+skills+subagents — "a fork should inherit the loaders."
The intuition was correct.

Method: live behavioral tests on the real `kilo` binary (@kilocode/cli **7.3.16**)
in an isolated mkdtemp HOME (since removed); planted fixtures then observed
`kilo debug skill`, `kilo agent list`, `kilo debug config`, `kilo mcp list`,
`kilo config check`. Corroborated by `strings` over the compiled binary and by
kilo's own built-in **"kilo-config" skill** (an official config reference shipped
inside the binary). Pi: official README (badlogic/pi-mono,
packages/coding-agent/README.md + docs/prompt-templates.md), fetched live — no pi
binary on this box.

---

## kilo-cli (binary `kilo`) — confirmed OpenCode fork (ships `.opencode/*` compat loaders)

Every content surface IS host-native. Our adapter under-claimed three of them.

| Surface | Truth | Dirs (verified) |
|---|---|---|
| MCP | YES | root `mcp` key in `kilo.jsonc`/`kilo.json`; user `~/.config/kilo/`, project `.kilo/`. local `{type:"local",command:[exe,...args]}`, remote `{type:"remote",url}`. `kilo mcp add/list`. |
| Hooks | YES (ts-plugin) | `plugin` array **AND** auto-discovery: project `.kilo/plugin/*.js`, user `~/.config/kilo/plugin/*.js`. Events tool.execute.before/after, experimental.chat.system.transform, permission.ask. |
| Commands | **YES** (adapter said NO) | `*.md` from `.kilo/command/`, `.kilo/commands/`, `.kilocode/commands/`, `.opencode/command/`, `.kilocode/workflows/` (auto→commands), user `~/.config/kilo/command/`; `$ARGUMENTS`. Global roots `~/.kilo`, `~/.kilocode`, `~/.opencode`. |
| Skills | **YES** (adapter said NO) | `{skill,skills}/<name>/SKILL.md` inside ANY config dir — incl. `.agents/skills` and `.claude/skills`. `kilo debug skill` listed 12/12 planted fixtures. |
| Subagents | **YES** (adapter said NO) | agent `*.md` frontmatter `mode:primary\|subagent\|all`; `.kilo/agent/`, `.kilo/agents/`, `.kilocode/agents/`, `.opencode/agent/`; `kilo agent list`, `kilo agent create`. |
| Memory | YES | AGENTS.md, CLAUDE.md, CONTEXT.md; rules `.kilo/rules` (preferred) + `.kilocode/rules` (legacy, binary emits migrate hint). Detection marker `~/.local/share/kilo/kilo.db`. |

**Adapter deltas** (`src/adapters/kilo-cli/index.ts`):
1. `supportsCommands/Skills/Subagents=false` + header "no confirmed writable
   command/skill/subagent dir (the .kilocode/ tree belongs to the VS Code
   extension)" are **disproven**. Targets: commands→`.kilo/command/` (user
   `~/.config/kilo/command/`), skills→`.kilo/skills/` or `.agents/skills/`,
   subagents→`.kilo/agent/` with `mode:subagent`.
2. Header "this fork does NOT auto-discover by directory — reads an explicit
   `plugin` ARRAY" is **stale (v7.3.16)**: `.kilo/plugin/` and
   `~/.config/kilo/plugin/` ARE auto-discovered. Array write still works (also
   loaded) so installs function — but the rationale is wrong and the array write
   is redundant; OpenCode-style write-file-only would suffice.
3. CORRECT: MCP dialect, memory targets, detection marker, event names, transports.

**Wall** (`site/src/platform-data.ts`): kilo-cli `hostNative` all-true row is
**CORRECT** (now behaviorally proven — upgrade provenance from docs-cite). The
"hooks only" the owner saw is our **surfaces** row = an adapter gap, not a wall error.

---

## kilo (Kilo Code VS Code extension, 7.x — rebuilt on the Kilo CLI server)

Shares ONE backend with kilo-cli; configs **MERGE** (`kilo.json` AND `kilo.jsonc`
at user / project-root / `.kilo/` levels — 3-way merge verified, 3 servers in
`kilo mcp list`).

- **MCP** YES — root `mcp` key, local/remote, `{env:VARIABLE_NAME}` interpolation
  documented. Legacy globalStorage `mcp_settings.json` (root `mcpServers`) is
  VSCode-(Legacy)-tab/migration-only (adapter's existing note correct).
- **Hooks** YES host-native — **wall says NO, WRONG.** plugins doc banner "applies
  to current VSCode extension & CLI"; same ts-plugin layer kilo-cli uses; dirs
  `.kilo/plugin/`, `~/.config/kilo/plugin/`.
- **Commands** YES — global `~/.config/kilo/commands/`, project `.kilo/commands/`,
  `/name`; legacy `.kilocode/workflows/` auto-migrated.
- **Skills** YES (since 7.x rebuild) — wall `hostNative.skills=true` CORRECT;
  loads `.kilocode/skills/<n>/SKILL.md` (same tree the adapter already writes
  commands into → trivially closable; canonical `.kilo/skills` project,
  `~/.kilo/skills` global).

**Adapter deltas** (`src/adapters/kilo/index.ts`, paradigm `mcp-only`):
1. **Hooks**: paradigm "mcp-only" + all hook caps false + "hooks unavailable" are
   WRONG for the rebuilt extension. `hostNative.hooks` → true; the N/A becomes a
   closable gap (ts-plugin to `.kilo/plugin/`).
2. **Skills**: header "Kilo Code has NO Agent Skill (SKILL.md) surface" WRONG;
   `supportsSkills=false` should flip true (`.kilo/skills/`).
3. **MCP**: header "ext writes kilo.json, CLI writes kilo.jsonc, their config
   files never merge" is **FALSE** — one shared backend merges both at all three
   levels; dedupe/collision logic should treat kilo + kilo-cli as one store.
   "kilo.json documents no native `${env:VAR}` token" is STALE.

---

## pi (badlogic/pi-mono) — docs-only (no binary on this box)

- **Commands**: adapter `supportsCommands:false` + wall `commands=false` are
  WRONG — pi has file-based slash commands = **prompt templates**
  (docs/prompt-templates.md): `~/.pi/agent/prompts/*.md` + `.pi/prompts/*.md`,
  `/name` invocation. Real missed surface, easy file-writer add.
- **Skills USER-SCOPE PATH BUG**: adapter writes `<configDir>/skills` with user
  configDir `~/.pi` → `~/.pi/skills/<n>/SKILL.md`, but pi loads GLOBAL skills only
  from `~/.pi/agent/skills/` or `~/.agents/skills/`. **User-scope skill installs
  are silently dead files.** Project scope `.pi/skills/` is correct. Our own
  `surfaces-matrix.json` had the right dirs; the adapter diverged.
- **allowed-tools rendering**: `renderSkill` joins tools with `", "` but pi's
  `allowed-tools` is **space-delimited** — emit space-joined for pi.
- **paradigm label backwards**: adapter/wall say `mcp-only` while the same header
  says "no writable MCP config." pi is THE no-MCP host → "mcp-only" is the
  opposite of the truth (cosmetic but confusing). `mcp=false` is correct.
- **Hooks taxonomy**: header "Pi has no lifecycle hook system" is wrong as
  written — extensions ARE a lifecycle event system (tool_call block/modify,
  session events, context injection) droppable into `.pi/extensions/`. Precedent:
  amp got `hooks=true` on the wall via its plugin API; consistency → pi hooks
  hostNative should be true (programmatic) or amp footnoted. (Taxonomy call;
  lower priority than the dead-files bug.)

Confidence: kilo-cli HIGH (live behavioral, every surface), kilo MED-HIGH (shared
backend live-probed + official docs), pi MED-HIGH (official docs; the
`~/.pi/agent/skills` dead-files bug + prompt-templates surface deserve a
behavioral re-check on a box with pi installed).

---

## Already-known skills gaps (merge into the same gap-closing batch)

Hosts that read `SKILL.md` natively but our skills surface doesn't yet write:
warp (`.agents/skills` + skills-as-slash-commands), kiro (`.kiro/skills` +
`~/.kiro/skills`), zed (`.agents/skills` + `~/.agents/skills`), qwen-code
(`.qwen/skills`), goose (dirs need confirmation), kimi (`~/.kimi/skills`).
