/**
 * platform-data — the landing's platform wall, single-sourced from the adapter
 * registry. Dependency-free on purpose: the root drift test
 * (tests/docs/platform-drift.test.ts) imports this module directly and asserts
 * every entry — id, display name, paradigm, and ALL six surface flags — against
 * the loaded adapter's `capabilities`, so an edit here that disagrees with
 * src/adapters/<id>/index.ts fails the suite.
 *
 * Entries are in ADAPTER_REGISTRY order. Flag derivation (same as install):
 * mcp = capabilities.transports.length > 0; hooks = paradigm !== "mcp-only";
 * commands/skills/subagents/memory = the supports* flags (?? false).
 *
 * Each entry carries TWO surface profiles:
 *   - `surfaces`   — what agent-connector installs TODAY (drift-guarded).
 *   - `hostNative` — what the HOST itself natively offers, independent of us
 *     (research-sourced; provenance below). The wall renders three states from
 *     the pair: supported / host-has-it-we-don't-yet / host-doesn't-offer-it.
 *
 * INVARIANT (drift-tested): surfaces[k] === true ⟹ hostNative[k] === true.
 * We cannot install a surface the host does not offer; a violation means either
 * this data or the adapter is wrong — fix the data, never the test.
 */

export type ParadigmId = "json-stdio" | "mcp-only" | "ts-plugin";

/** The six integration surfaces, as shown on each agent's chip row. */
export interface PlatformSurfaces {
  /** MCP server registration (any transport). */
  mcp: boolean;
  /** Lifecycle hooks (json-stdio or ts-plugin paradigm). */
  hooks: boolean;
  /** Slash commands. */
  commands: boolean;
  /** Agent Skills. */
  skills: boolean;
  /** Subagents. */
  subagents: boolean;
  /** Memory (managed blocks in the host's rules file). */
  memory: boolean;
  /** Statusline/HUD handler wired at the home binary. */
  statusline: boolean;
  /** Action affordance (slash command / palette / exec-file) bound to the home binary. */
  actions: boolean;
}

export interface Platform {
  /** Registry adapter id (drift-test key). */
  id: string;
  /** Adapter display name. */
  name: string;
  paradigm: ParadigmId;
  /** What agent-connector installs today — drift-guarded vs the adapter. */
  surfaces: PlatformSurfaces;
  /** What the host natively offers, independent of our adapter coverage. */
  hostNative: PlatformSurfaces;
}

/** Chip metadata: compact label on the wall, full word in the tooltip. */
export interface SurfaceChip {
  key: keyof PlatformSurfaces;
  abbr: string;
  full: string;
}

export const surfaceChips: SurfaceChip[] = [
  { key: "mcp", abbr: "MCP", full: "MCP server" },
  { key: "hooks", abbr: "Hooks", full: "Hooks" },
  { key: "commands", abbr: "Cmd", full: "Commands" },
  { key: "skills", abbr: "Skills", full: "Skills" },
  { key: "subagents", abbr: "Agents", full: "Subagents" },
  { key: "memory", abbr: "Mem", full: "Memory" },
];

/**
 * Handler surfaces shown as positive-only lit badges on cards where
 * agent-connector actually wires them. NOT included in surfaceChips / the
 * 3-state chip row — no faded/negative rendering for these two.
 */
export const handlerChips: { key: "statusline" | "actions"; abbr: string; full: string }[] = [
  { key: "statusline", abbr: "Statusline", full: "Statusline handler" },
  { key: "actions", abbr: "Actions", full: "Action affordances" },
];

/**
 * The three chip states the wall renders, derived from (surfaces, hostNative):
 *   - "supported" — we install it (surfaces[k] = true).
 *   - "host-gap"  — the host natively offers the surface but agent-connector
 *                   has not wired it yet (our honest gap, visible by design).
 *   - "host-na"   — the platform itself does not offer the surface.
 */
export type SurfaceState = "supported" | "host-gap" | "host-na";

export function surfaceState(
  platform: Platform,
  key: keyof PlatformSurfaces,
): SurfaceState {
  if (platform.surfaces[key]) return "supported";
  return platform.hostNative[key] ? "host-gap" : "host-na";
}

const s = (
  mcp: boolean,
  hooks: boolean,
  commands: boolean,
  skills: boolean,
  subagents: boolean,
  memory: boolean,
  statusline: boolean,
  actions: boolean,
): PlatformSurfaces => ({ mcp, hooks, commands, skills, subagents, memory, statusline, actions });

/*
 * hostNative PROVENANCE (order: mcp/hooks/commands/skills/subagents/memory).
 * Fact base, strongest-first: the AC research corpus (docs/research/*.json +
 * each adapter's header comment), the 0.2.0 release skills audit, the 20-host
 * hook-extension survey (live official docs, 2026-06-11), the 35-host
 * memory-surface matrix, and targeted official-doc fetches (2026-06-12) for
 * cells the corpus left uncertain. Rule applied throughout: a claimed gap
 * (hostNative=true while surfaces=false) requires positive evidence; genuinely
 * uncertain cells default to matching our support — no guessed gaps.
 *
 * Cross-cutting facts:
 *   - memory: ALL 36 hosts natively read a rules/memory file (AGENTS.md or a
 *     host-specific equivalent — Amazon Q reads .amazonq/rules, Continue reads
 *     .continue Rules, Windsurf reads .windsurfrules/global rules).
 *     hostNative.memory=true everywhere.
 *   - hooks: the 25 json-stdio/ts-plugin hosts all expose a native hook or
 *     plugin layer (hook survey + Continue's PR #11029 Claude-compatible hooks,
 *     which promoted it out of mcp-only; Amp's .amp/plugins/*.ts TS-plugin API
 *     with thread-lifecycle events — ampcode.com/manual, Plugins — which promoted
 *     it to ts-plugin). Of the 10 remaining "mcp-only" hosts the survey lists as
 *     hook-less, ONE is a gap: Amazon Q has the agent-format hooks layer
 *     (cli-agents/*.json) — hostNative.hooks=true (our gap); the other nine stay
 *     false (Windsurf among them — no user-installable host hook layer).
 *   - skills: native SKILL.md readers verified by the release audit + official
 *     docs: claude-code, codex, cursor, vscode-copilot, copilot-cli,
 *     gemini-cli, opencode, antigravity(+cli), pi, jetbrains-copilot, PLUS the
 *     un-wired hosts kiro (kiro.dev/docs/skills), zed (.agents/skills, zed
 *     repo docs), qwen-code (.qwen/skills, official docs), kimi
 *     (~/.kimi-code/skills — flagged in our own adapter header), goose (press +
 *     skills.sh listing; dirs unverified → medium), warp
 *     (docs.warp.dev skills.mdx: .agents/.warp/.claude/… dirs), roo-code
 *     (docs.roocode.com/features/skills), kilo + kilo-cli
 *     (kilo.ai/docs/customize/skills), droid
 *     (docs.factory.ai/cli/configuration/skills), trae (docs.trae.ai/ide/
 *     skills), amp (ampcode.com/manual Agent Skills), codebuff
 *     (.agents/skills + ~/.agents/skills — CodebuffAI/codebuff
 *     sdk/src/skills/load-skills.ts, fetched 2026-06-12), openclaw
 *     (docs.openclaw.ai/tools/skills: <workspace>/skills, .agents/skills,
 *     ~/.openclaw/skills, fetched 2026-06-12), PLUS mux (.mux/skills |
 *     ~/.mux/skills — mux.coder.com/agents/agent-skills), crush (.crush/skills |
 *     ~/.config/crush/skills — charmbracelet/crush load.go), and hermes
 *     (~/.hermes/skills — hermes-agent.nousresearch.com docs), all fetched
 *     2026-06-16. NOT skills hosts: omp (no skills surface documented;
 *     defaulted to ours).
 *
 * Per-host nontrivial cells (only where hostNative ≠ surfaces, or negatives
 * worth a source):
 *   - codex.commands=true with a caveat: ~/.codex/prompts is user-scope only
 *     and DEPRECATED in 2026 in favor of Codex Skills — still functional.
 *   - copilot-cli.commands=false [high]: no user-defined slash-command surface
 *     (built-ins only; open FRs github/copilot-cli #618, #1113).
 *   - warp: hooks=false [high] (no lifecycle hook system; FR warpdotdev/warp
 *     #7834). commands=true [high] — skills are invocable as /{skill-name}
 *     with $ARGUMENTS, plus Warp Drive Agent Prompts (cloud-managed) in the
 *     slash menu (docs.warp.dev slash-commands.mdx). subagents=false
 *     [medium-high]: Agent Profiles are permission/model profiles, not
 *     definable subagents; FR warpdotdev/warp#9107 requests exactly this.
 *   - kilo-cli commands/skills/subagents=true: Kilo-Org/kilocode PR #5183
 *     (.kilocode/commands), kilo.ai/docs/customize/skills + custom-subagents
 *     ("Kilo Code's CLI supports custom subagents", `kilo agent create`).
 *   - droid commands/skills/subagents=true: docs.factory.ai/cli/configuration/
 *     custom-slash-commands, /skills, /custom-droids — Droid offers all six.
 *   - roo-code: hooks=false (no hook layer), commands=true
 *     (docs.roocode.com/features/slash-commands, .roo/commands),
 *     subagents=false (sequential mode delegation only; enhancement issues
 *     RooCodeInc/Roo-Code #11741, #12330).
 *   - kilo (VS Code ext): hooks=false (no hook layer); skills=true supersedes
 *     the stale low-confidence surfaces-matrix "false" row (kilo.ai docs).
 *   - trae: hooks=false; commands=false [uncertain → defaulted to ours; skills
 *     are slash-triggerable but no standalone command-file surface is
 *     documented]; subagents=true with a caveat — custom agents exist but are
 *     UI-created with no documented writable file path (docs.trae.ai/ide/
 *     agent), so this may stay a permanent gap chip.
 *   - antigravity(+cli).subagents=false [medium]: declarative subagents exist
 *     only inside plugin bundles — no user-level surface (surfaces-matrix).
 *   - zed: hooks=false (no hook pipeline); commands=false [uncertain →
 *     defaulted; WASM slash-command extensions target the legacy Assistant,
 *     not the current agent panel]; subagents=false [low; settings.json
 *     "profiles" are tool-sets, not subagents].
 *   - amp: hooks=true [high] — WIRED as ts-plugin (.amp/plugins/<id>.ts;
 *     session.start/agent.start/tool.call/tool.result/agent.end). subagents=true
 *     [medium-high, EXPERIMENTAL amp.experimental.createAgent plugin API] +
 *     skills=true [high] — all ampcode.com/manual; commands=false [medium]:
 *     no chat slash-command surface (plugin registerCommand() adds
 *     command-palette actions, not prompt commands).
 *   - codebuff: subagents=true [high] — user-defined TypeScript agents in
 *     .agents/ (created by /init; CodebuffAI/codebuff initial-agents-dir
 *     template, www.codebuff.com/docs/agents). hooks=false (no hook layer).
 *   - mux: skills=true [high] — mux.coder.com/agents/agent-skills documents
 *     dir-per-skill SKILL.md (.mux/skills | ~/.mux/skills); dir name must match
 *     ^[a-z0-9]+(?:-[a-z0-9]+)*$ (1–64 chars). commands/subagents=false — no
 *     such surfaces documented (instruction files only); defaulted to ours.
 *   - pi: mcp=false — pi has NO MCP config surface at all (adapter header:
 *     "no writable MCP config"); skills=true (native, badlogic/pi-mono docs).
 *   - jetbrains-copilot.subagents=false [low → defaulted]: no JetBrains
 *     subagent authoring surface documented (surfaces-matrix).
 *   - qwen-code.skills=true [high]: official Agent Skills docs; the QwenLM
 *     repo dogfoods .qwen/skills (our adapter's "no skills" comment is stale).
 *   - kiro: commands=false [uncertain → defaulted]; subagents=false [low;
 *     agent.json is a hooks/MCP descriptor, custom agents are /agent-swap
 *     modes, not delegatable subagents].
 *   - kimi: commands=false [uncertain → defaulted]; subagents=false [low; the
 *     hook survey shows SubagentStart/Stop EVENTS but no authoring surface].
 *   - crush: skills=true [high] — charmbracelet/crush load.go auto-discovers
 *     .crush/skills (project) + ~/.config/crush/skills (user), dir-per-skill
 *     SKILL.md. commands/subagents=false — no such surfaces; defaulted to ours.
 *   - hermes: skills=true [high] — hermes-agent.nousresearch.com docs:
 *     ~/.hermes/skills dir-per-skill SKILL.md (user scope only; no hermes-owned
 *     project skills dir). commands/subagents=false; defaulted to ours.
 *   - omp: skills=false [medium — pi fork, but no skills manifest field and no
 *     docs evidence]; commands/subagents=false [defaulted].
 *   - openclaw: skills=true [high, live-verified 2026-06-12 — supersedes the
 *     stale surfaces-matrix row researched against the plugin-only era];
 *     subagents=true [medium — docs.openclaw.ai/tools/subagents: sub-agent
 *     runs spawned from an agent run, agents user-definable in openclaw.json
 *     agents.list]; commands=false [built-in /commands + directives only; the
 *     user-defined invocable surface is skills].
 */
export const platforms: Platform[] = [
  {
    id: "codebuddy",
    name: "CodeBuddy",
    paradigm: "json-stdio",
    // Tencent CodeBuddy is a Claude Code fork (~/.codebuddy.json / .mcp.json →
    // mcpServers; settings.json hooks; .codebuddy/{commands,skills,agents};
    // CODEBUDDY.md memory). statusline: host HAS a statusLine key (bundle-
    // confirmed) but AC does not wire it yet (Claude-v1-only surface) → gap.
    surfaces: s(true, true, true, true, true, true, false, false),
    hostNative: s(true, true, true, true, true, true, true, false),
  },
  {
    id: "claude-code",
    name: "Claude Code",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, true, true, true, false),
    hostNative: s(true, true, true, true, true, true, true, false),
  },
  {
    id: "codex",
    name: "Codex CLI",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, true, true, false, false),
    // commands: ~/.codex/prompts — deprecated in favor of Codex Skills, still works.
    hostNative: s(true, true, true, true, true, true, false, false),
  },
  {
    id: "cursor",
    name: "Cursor",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, true, true, false, false),
    hostNative: s(true, true, true, true, true, true, false, false),
  },
  {
    id: "vscode-copilot",
    name: "VS Code Copilot",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, true, true, false, false),
    hostNative: s(true, true, true, true, true, true, false, false),
  },
  {
    id: "copilot-cli",
    name: "GitHub Copilot CLI",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, true, true, true, false, false),
    // commands: host N/A — built-ins only (FRs github/copilot-cli #618, #1113).
    hostNative: s(true, true, false, true, true, true, false, false),
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, true, true, false, false),
    hostNative: s(true, true, true, true, true, true, false, false),
  },
  {
    id: "warp",
    name: "Warp",
    paradigm: "mcp-only",
    surfaces: s(true, false, false, true, false, true, false, true),
    // skills now wired (.agents/skills/<name>/SKILL.md, project scope — Warp Drive
    // is cloud-managed so there is no documented user-scope dir; skills double as
    // /{skill-name} slash commands in Warp's UI).
    // GAP: commands (skills-as-/{skill-name}). N/A: hooks (FR #7834),
    // subagents (profiles ≠ subagents; FR #9107).
    hostNative: s(true, false, true, true, false, true, false, true),
  },
  {
    id: "opencode",
    name: "OpenCode",
    paradigm: "ts-plugin",
    surfaces: s(true, true, true, true, true, true, false, false),
    hostNative: s(true, true, true, true, true, true, false, false),
  },
  {
    id: "mimo-code",
    name: "MiMoCode",
    paradigm: "ts-plugin",
    surfaces: s(true, true, true, true, true, true, false, false),
    // Xiaomi MiMoCode (github.com/XiaomiMiMo/MiMo-Code, @mimo-ai/cli) is a FORK
    // of OpenCode — it inherits OpenCode's six surfaces (MCP root key "mcp",
    // ts-plugin hooks, commands/skills/subagents under <mcDir>, AGENTS.md +
    // CLAUDE.md memory). Mirrors the OpenCode wall row; no verified divergence.
    hostNative: s(true, true, true, true, true, true, false, false),
  },
  {
    id: "kilo-cli",
    name: "Kilo CLI",
    paradigm: "ts-plugin",
    surfaces: s(true, true, true, true, true, true, false, false),
    // OpenCode fork — all six surfaces now wired (commands → .kilo/command/,
    // skills → .kilo/skills/, subagents → .kilo/agent/ mode:subagent).
    hostNative: s(true, true, true, true, true, true, false, false),
  },
  {
    id: "droid",
    name: "Droid (Factory)",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, true, true, false, true),
    // All six wired: commands (.factory/commands), skills (.factory/skills),
    // subagents (.factory/droids/<name>.md — markdown). docs.factory.ai/cli.
    hostNative: s(true, true, true, true, true, true, false, true),
  },
  {
    id: "openhands",
    name: "OpenHands",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, false, false, true, false, false),
    // MCP at ~/.openhands/mcp.json ("mcpServers", FastMCP entry shape) + a
    // SEPARATE .openhands/hooks.json carrying the Claude-Code-plugin-compatible
    // nested-rule hooks (6 events: PreToolUse/PostToolUse/UserPromptSubmit/
    // SessionStart/SessionEnd/Stop). memory = AGENTS.md (BaseAdapter default).
    // commands/skills/subagents/statusline/actions: no first-party file layout
    // byte-confirmed (CEILING), so left false in BOTH columns — no guessed gap.
    hostNative: s(true, true, false, false, false, true, false, false),
  },
  {
    id: "roo-code",
    name: "Roo Code",
    paradigm: "mcp-only",
    surfaces: s(true, false, true, true, false, true, false, false),
    // commands (.roo/commands) + skills (.roo/skills, AgentSkills) wired —
    // docs.roocode.com. N/A: hooks, subagents.
    hostNative: s(true, false, true, true, false, true, false, false),
  },
  {
    id: "kilo",
    name: "Kilo Code",
    paradigm: "ts-plugin",
    surfaces: s(true, true, true, true, true, true, false, false),
    // 7.x rebuilt on the Kilo CLI server: hooks (ts-plugin, .kilo/plugin/) and
    // skills (.kilo/skills/) are now wired — all six surfaces supported. The ext
    // shares one config backend with kilo-cli (kilo.json + kilo.jsonc merge).
    hostNative: s(true, true, true, true, true, true, false, false),
  },
  {
    id: "cline",
    name: "Cline",
    paradigm: "mcp-only",
    surfaces: s(true, false, true, true, false, true, false, false),
    // The most-installed AI coding VS Code ext + the parent roo-code/kilo forked.
    // mcp-only: MCP at <vscodeUserDir>/globalStorage/saoudrizwan.claude-dev/
    // settings/cline_mcp_settings.json ("mcpServers" — cline/cline disk.ts
    // GlobalFileNames). Wired: commands (.clinerules/workflows + Documents/Cline/
    // Workflows), skills (.clinerules/skills/<name>/SKILL.md), memory (.clinerules
    // + Documents/Cline/Rules) — docs.cline.bot. subagents hostNative=false: the
    // VS Code ext has no verified on-disk subagent surface (only the separate
    // Cline CLI does). N/A: hooks (no event-callback plugin API).
    hostNative: s(true, false, true, true, false, true, false, false),
  },
  {
    id: "trae",
    name: "Trae",
    paradigm: "mcp-only",
    surfaces: s(true, false, false, true, false, true, false, false),
    // skills wired (.trae/skills/<name>/SKILL.md — docs.trae.ai/ide/skills).
    // PERMANENT GAP (adversarially confirmed): subagents are UI-created + imported
    // via cloud share links (s.trae.ai/a/<id>) — no on-disk agent file.
    // N/A: hooks, commands (no standalone command surface).
    hostNative: s(true, false, false, true, true, true, false, false),
  },
  {
    id: "antigravity-cli",
    name: "Antigravity CLI",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, false, true, true, false),
    // subagents: N/A — plugin-bundle-only, no user surface (matches the IDE).
    // statusline: the `agy` CLI's first-party custom status line (live-verified
    // v1.0.10 — settings.json `statusLine` { enabled, command }); CLI-only (the
    // IDE app's status payload is unverified, so the antigravity row stays false).
    hostNative: s(true, true, true, true, false, true, true, false),
  },
  {
    id: "antigravity",
    name: "Google Antigravity",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, false, true, false, false),
    hostNative: s(true, true, true, true, false, true, false, false),
  },
  {
    id: "zed",
    name: "Zed",
    paradigm: "mcp-only",
    surfaces: s(true, false, false, true, false, true, false, true),
    // skills wired (.agents/skills project, ~/.agents/skills user); actions wired
    // via tasks.json exec tasks (zed.dev/docs/tasks). N/A: hooks, commands, subagents.
    hostNative: s(true, false, false, true, false, true, false, true),
  },
  {
    id: "amp",
    name: "Amp",
    paradigm: "ts-plugin",
    surfaces: s(true, true, false, true, false, true, false, false),
    // hooks wired via the .amp/plugins/<id>.ts TS-plugin API: session.start /
    // agent.start / tool.call / tool.result / agent.end → 5 canonical events
    // (no session.end). skills wired (~/.config/agents/skills | .agents/skills).
    // REMAINING GAP (adversarially verified): subagents = experimental
    // amp.experimental.createAgent / role-specific .agents/checks.
    // ampcode.com/manual. N/A: commands.
    hostNative: s(true, true, false, true, true, true, false, false),
  },
  {
    id: "codebuff",
    name: "Codebuff",
    paradigm: "mcp-only",
    surfaces: s(true, false, false, true, true, true, false, false),
    // skills wired (.agents/skills, AgentSkills — docs + load-skills.ts verified).
    // subagents wired: project-scoped .agents/<id>.ts AgentDefinition modules
    // (default-exported object, no type-only import) — codebuff docs verified.
    hostNative: s(true, false, false, true, true, true, false, false),
  },
  {
    id: "mux",
    name: "Mux",
    paradigm: "mcp-only",
    surfaces: s(true, false, false, true, false, true, false, false),
    // skills now wired (.mux/skills project, ~/.mux/skills user; dir name must
    // match ^[a-z0-9]+(?:-[a-z0-9]+)*$ (1–64 chars) — mux.coder.com docs).
    hostNative: s(true, false, false, true, false, true, false, false),
  },
  // pi has NO writable MCP config (transports: []) — commands + skills + memory
  // + actions.
  {
    id: "pi",
    name: "Pi",
    paradigm: "mcp-only",
    surfaces: s(false, false, true, true, false, true, false, true),
    // mcp: N/A — pi offers no MCP surface at all (deliberate host design).
    // commands now wired (prompt templates: .pi/prompts/ project,
    // ~/.pi/agent/prompts/ user); skills fixed to ~/.pi/agent/skills/ (user).
    // actions wired via a generated pi.registerCommand extension module
    // (.pi/extensions/ project, ~/.pi/agent/extensions/ user) — the OMP fork's
    // action surface was inferred FROM pi, so hostNative.actions is true.
    hostNative: s(false, false, true, true, false, true, false, true),
  },
  {
    id: "jetbrains-copilot",
    name: "JetBrains Copilot",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, false, true, false, false),
    hostNative: s(true, true, true, true, false, true, false, false),
  },
  {
    id: "qwen-code",
    name: "Qwen CLI",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, true, true, true, false),
    // skills now wired (.qwen/skills project, ~/.qwen/skills user) — all six.
    hostNative: s(true, true, true, true, true, true, true, false),
  },
  {
    id: "kiro",
    name: "Kiro",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, true, false, true, false, true),
    // skills now wired (.kiro/skills project, ~/.kiro/skills user).
    // actions now wired (.kiro/hooks/<id>.kiro.hook Manual-Trigger + Shell-Command,
    // project scope only — Kiro does not scan ~/.kiro/hooks/).
    hostNative: s(true, true, false, true, false, true, false, true),
  },
  {
    id: "kimi",
    name: "Kimi CLI",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, true, false, true, false, false),
    // skills now wired (.kimi-code/skills project, ~/.kimi-code/skills user).
    hostNative: s(true, true, false, true, false, true, false, false),
  },
  {
    id: "crush",
    name: "Crush",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, true, false, true, false, false),
    // skills now wired (.crush/skills project, ~/.config/crush/skills user;
    // auto-discovered, paths hard-coded in charmbracelet/crush load.go).
    hostNative: s(true, true, false, true, false, true, false, false),
  },
  {
    id: "goose",
    name: "Goose",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, true, false, true, false, false),
    // skills wired (~/.agents/skills | .agents/skills, SKILL.md — goose-docs.ai,
    // live-verified; requires the built-in Summon extension v1.25.0+).
    hostNative: s(true, true, false, true, false, true, false, false),
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, true, false, true, false, true),
    // skills now wired (~/.hermes/skills user — auto-discovered "single source
    // of truth"; no hermes-owned project skills dir, so user scope only).
    hostNative: s(true, true, false, true, false, true, false, true),
  },
  {
    id: "omp",
    name: "Oh My Pi (OMP)",
    paradigm: "ts-plugin",
    surfaces: s(true, true, false, false, false, true, false, true),
    hostNative: s(true, true, false, false, false, true, false, true),
  },
  {
    id: "nemoclaw",
    name: "NVIDIA NemoClaw",
    paradigm: "ts-plugin",
    surfaces: s(true, true, false, true, false, true, false, true),
    // NVIDIA NemoClaw (github.com/NVIDIA/NemoClaw) WRAPS OpenClaw and writes the
    // SAME ~/.openclaw/openclaw.json — it extends OpenClawAdapter, so its surfaces
    // are OpenClaw's verbatim (MCP nested mcp.servers, ts-plugin hooks, memory, and
    // now skills — installSkills is INHERITED from OpenClawAdapter). NemoClaw ships
    // NO Claude-style hooks of its own, but inherits OpenClaw's plugin-hook
    // machinery → hooks stays honest. PERMANENT GAP mirrors OpenClaw: subagents
    // (runtime runs + inline agents.list[], no authored-file folder).
    hostNative: s(true, true, false, true, true, true, false, true),
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    paradigm: "ts-plugin",
    surfaces: s(true, true, false, true, false, true, false, true),
    // skills wired (<workspace>/skills/<name>/SKILL.md —
    // docs.openclaw.ai/tools/skills, live-verified). PERMANENT GAP (adversarially
    // confirmed): subagents are runtime runs + inline agents.list[] config — no
    // authored-file folder to write into.
    hostNative: s(true, true, false, true, true, true, false, true),
  },
  {
    id: "amazon-q",
    name: "Amazon Q Developer CLI",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, false, true, true, false, false),
    // json-stdio: AC installs MCP + hooks + subagents + memory. MCP at
    // ~/.aws/amazonq/mcp.json (user) and .amazonq/mcp.json (project), root key
    // "mcpServers". hooks WIRED: the agent-format hooks layer (cli-agents/*.json)
    // — an OBJECT keyed by trigger (agentSpawn/userPromptSubmit/preToolUse/
    // postToolUse/stop), each entry { command, matcher? }, JSON-over-STDIN,
    // exit-code 0/2. Hooks have no global file, so AC merges into the built-in
    // `q_cli_default` agent file (cli-agents/q_cli_default.json) at the install
    // scope — a bare default.json would be an inactive custom agent (mirrors
    // kiro's default-agent selection).
    // subagents WIRED: Amazon Q "agents" are per-agent JSON files where the
    // filename (minus .json) is the agent name (cli-agents/<name>.json, both
    // scopes — github.com/aws/amazon-q-developer-cli agent-file-locations.md +
    // agent-format.md). AC writes { name, description, prompt } (+ model/tools/
    // allowedTools when declared); a subagent named `q_cli_default` is refused
    // (would clobber the hooks/default-agent file).
    // memory WIRED:
    // .amazonq/rules/agent-connector.md (project; plain Markdown auto-applied as
    // context — docs.aws.amazon.com context-project-rules).
    // commands DEFERRED: the prompt library (~/.aws/amazonq/prompts/*.md) is only
    // documented for the IDE chat (q-in-IDE prompt-library page); the Q CLI repo
    // docs ship no prompts surface, so the CLI format/project-scope is unverified
    // → supportsCommands UNSET (no guessed surface). skills: no documented dir.
    hostNative: s(true, true, false, false, true, true, false, false),
  },
  {
    id: "continue",
    name: "Continue",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, false, false, true, false, false),
    // json-stdio: AC installs MCP + hooks + memory. MCP config is YAML — ~/.continue/
    // config.yaml (user) and <projectDir>/.continue/config.yaml (project); root
    // key "mcpServers" is a YAML ARRAY of { name, command, type?, args?, env?,
    // cwd?, url } entries (docs.continue.dev/customize/deep-dives/mcp +
    // /reference). hooks WIRED: the `cn` CLI ships a Claude-Code-COMPATIBLE hooks
    // system (continuedev/continue PR #11029, extensions/cli/src/hooks/*) — a
    // SEPARATE settings.json (<CONTINUE_GLOBAL_DIR|~/.continue>/settings.json user,
    // <projectDir>/.continue/settings.json project) under `hooks` with the
    // Claude-identical { matcher, hooks:[{type,command}] } shape. memory WIRED:
    // .continue/rules/agent-connector.md (project) with `alwaysApply: true`
    // frontmatter (always-included — docs.continue.dev/customize/deep-dives/rules).
    // N/A wired: commands/skills/subagents (no AC-wired user-authored dir).
    hostNative: s(true, true, false, false, false, true, false, false),
  },
  {
    id: "windsurf",
    name: "Windsurf",
    paradigm: "mcp-only",
    surfaces: s(true, false, true, true, false, true, false, false),
    // mcp-only: AC installs MCP + memory + commands + skills. MCP config is JSON
    // — USER/GLOBAL scope ONLY at ~/.codeium/windsurf/mcp_config.json (the docs
    // document no project path); root key "mcpServers" is a Claude-Desktop-style
    // OBJECT map keyed by server name (like cursor). stdio { command, args?, env? };
    // remote { serverUrl, headers? } (NOT `url`; no type/disabled).
    // docs.devin.ai/desktop/cascade/mcp. memory WIRED: .windsurf/rules/
    // agent-connector.md (workspace) with `trigger: always_on` frontmatter (full
    // content in the system prompt every message —
    // docs.windsurf.com/windsurf/cascade/rules).
    // commands WIRED: user-authored WORKFLOWS (each a /<name> slash command) at
    // project .windsurf/workflows/<name>.md AND user
    // ~/.codeium/windsurf/global_workflows/<name>.md (user dir is
    // `global_workflows`). skills WIRED: Agent SKILLS at project
    // .windsurf/skills/<name>/SKILL.md AND user
    // ~/.codeium/windsurf/skills/<name>/SKILL.md. Both scopes — docs.windsurf.com.
    // hooks: Windsurf is a GUI editor with no user-installable hook/plugin layer
    // → hostNative.hooks stays false (NOT a gap — there is no host hook surface).
    // N/A wired: subagents (no AC-wired user-authored dir).
    hostNative: s(true, false, true, true, false, true, false, false),
  },
  {
    id: "grok-cli",
    name: "Grok CLI",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, false, false, true, false, false),
    // Community superagent-ai/grok-cli (npm grok-dev, bin grok). USER-SCOPE only:
    // MCP servers (nested mcp.servers JSON ARRAY, keyed by id) AND hooks
    // (top-level hooks, Claude nested-rule shape) both live in
    // ~/.grok/user-settings.json. memory WIRED: AGENTS.md ("merged from git root
    // down; AGENTS.override.md wins per directory" — README). N/A: commands /
    // skills / subagents have no documented user-authored FILE surface (Grok's
    // sub-agents are JSON config + a /agents TUI flow, not a markdown dir);
    // statusline / actions absent.
    hostNative: s(true, true, false, false, false, true, false, false),
  },
];

export const platformCount = platforms.length;

/**
 * Host form-factor — how the user actually runs the agent. Orthogonal to the hook
 * paradigm (a `cli` can be json-stdio or ts-plugin, etc.); the wall shows form
 * factor as the grouping band and paradigm as the dot color. This is hand-curated
 * HOST-NATURE metadata, NOT registry-derivable, so the platform-drift test pins
 * these three lists to partition every platform id EXACTLY (a new or
 * misclassified host fails the guard).
 */
export type FormFactorId = "cli" | "extension" | "app";

export const formFactorIds: Record<FormFactorId, readonly string[]> = {
  // Terminal-native agent CLIs.
  cli: [
    "claude-code", "codebuddy", "codex", "gemini-cli", "copilot-cli", "qwen-code", "amp",
    "codebuff", "continue", "crush", "goose", "amazon-q", "droid", "openhands",
    "opencode", "kilo-cli", "omp", "openclaw", "nemoclaw", "hermes", "mimo-code",
    "kimi", "pi", "antigravity-cli", "grok-cli",
  ],
  // Editor extensions / plugins — run inside an IDE, no standalone CLI.
  extension: ["cline", "roo-code", "kilo", "vscode-copilot", "jetbrains-copilot"],
  // Standalone GUI apps / editors (Cursor is the IDE; antigravity is the app,
  // antigravity-cli is the CLI).
  app: ["cursor", "windsurf", "trae", "kiro", "zed", "warp", "mux", "antigravity"],
};

const formFactorById: Record<string, FormFactorId> = Object.fromEntries(
  (Object.entries(formFactorIds) as [FormFactorId, readonly string[]][]).flatMap(
    ([ff, ids]) => ids.map((id) => [id, ff] as const),
  ),
);

/** The form-factor of a platform id (undefined if unclassified). */
export function formFactorOf(id: string): FormFactorId | undefined {
  return formFactorById[id];
}
