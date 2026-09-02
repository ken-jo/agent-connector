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
  /**
   * Fork-lineage family key, used only to keep same-lineage hosts adjacent when
   * coverage displays sort by paradigm → family → name. OPTIONAL and NOT
   * drift-asserted: `familyOf` (below) is the single source of truth, so leaving
   * this unset is the norm — `familyKey()` falls back to the host's own id.
   */
  family?: string;
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
 *   - memory: nearly every registered host natively reads a rules/memory file
 *     (AGENTS.md or a host-specific equivalent — Amazon Q reads .amazonq/rules,
 *     Continue reads .continue Rules, Windsurf reads .windsurfrules/global rules).
 *     hostNative.memory=true everywhere except mistral-vibe (MCP-only, no
 *     rules/memory surface byte-confirmed).
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
    id: "grok-build",
    name: "Grok Build",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, true, true, false, false),
    // xAI's OFFICIAL agent (xai-org/grok-build, Apache-2.0, bin `grok`), NOT the
    // community grok-cli below. All wired surfaces live under $GROK_HOME
    // (default ~/.grok): MCP in config.toml [mcp_servers.<id>]; hooks in
    // hooks/*.json (Claude-compatible JSON); commands/<n>.md, skills/<n>/SKILL.md
    // and agents/<n>.md; memory = AGENTS.md (project) / rules/*.md (user).
    // statusline hostNative=true but NOT wired by us — the host HAS
    // [ui.status_line] type="command" with JSON on stdin (25-status-line.md), so
    // this is a genuine AC gap, not a host N/A. actions=false both ways: Grok's
    // commands/*.md are prompt templates, with no shell-exec affordance to bind.
    hostNative: s(true, true, true, true, true, true, true, false),
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
  {
    id: "devin",
    name: "Devin CLI (Cognition)",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, true, false, true, false, false),
    // json-stdio: AC installs MCP + hooks + skills + memory, all byte-confirmed
    // from first-party docs (docs.devin.ai/cli/extensibility). MCP + hooks share
    // ONE config.json per scope (user ~/.config/devin/config.json,
    // %APPDATA%\devin\config.json on Windows; project .devin/config.json). MCP
    // root key "mcpServers" (object map; stdio { command, args?, env? }, remote
    // { url, transport?, headers? }; native ${env:VAR}). Hooks under the same
    // file's "hooks" key (Claude-compatible NESTED-rule shape; simple top-level
    // {decision:"approve"|"block"|"deny", reason} reply; exit 2 blocks) —
    // docs.devin.ai/cli/extensibility/hooks. memory WIRED: AGENTS.md (project
    // root) + user ~/.config/devin/AGENTS.md (docs.devin.ai/cli/extensibility/
    // rules). skills WIRED: <configDir>/skills/<name>/SKILL.md
    // (docs.devin.ai/cli/extensibility/skills).
    // hostNative commands + subagents = true: Devin documents native slash
    // commands (/cli/reference/commands) + subagents (/cli/subagents), but their
    // on-disk dir names aren't byte-confirmed from a first-party config
    // reference, so AC leaves them unwired (surfaces=false) rather than guess a
    // path — an honest CEILING, not a host gap.
    hostNative: s(true, true, true, true, true, true, false, false),
  },
  {
    id: "open-interpreter",
    name: "Open Interpreter",
    paradigm: "mcp-only",
    surfaces: s(true, false, false, false, false, false, false, false),
    // mcp-only here: AC installs MCP only. Open Interpreter is the new Rust
    // `interpreter`/`i` CLI and is a FORK of OpenAI's Codex (README: "Open
    // Interpreter is a fork of OpenAI's Codex"), so its native config is Codex's:
    // a TOML config.toml carrying [mcp_servers.<id>] tables (stdio { command,
    // args, env } / streamable-HTTP { url, bearer_token_env_var?, http_headers? }
    // — codex-rs/config/src/mcp_{edit,types}.rs). The config home is isolated from
    // Codex: the binary honors ONLY $INTERPRETER_HOME (NOT $CODEX_HOME) and
    // defaults to ~/.openinterpreter (codex-rs/utils/home-dir/src/lib.rs); install
    // script sets CODEX_COMMAND_NAME=interpreter, CODEX_HOME=$INTERPRETER_HOME.
    // hostNative hooks/commands/skills/subagents/memory = true: as a Codex fork it
    // inherits Codex's hook subsystem + content surfaces + AGENTS.md memory, but
    // the `interpreter` PRODUCT's live wire contract / on-disk dirs are not
    // first-party verified here, so AC leaves them UNWIRED (surfaces=false) rather
    // than guess — an honest CEILING / host-gap, not a host limitation.
    hostNative: s(true, true, true, true, true, true, false, false),
  },
  {
    id: "junie",
    name: "Junie",
    paradigm: "mcp-only",
    surfaces: s(true, false, false, false, false, true, false, false),
    // Junie is JetBrains' OWN LLM-agnostic coding agent (the `junie` CLI, npm
    // @jetbrains/junie, github.com/JetBrains/junie) — DISTINCT from
    // jetbrains-copilot (GitHub Copilot in JetBrains IDEs). mcp-only: AC installs
    // MCP + the AGENTS.md memory base default. MCP config is BYTE-CONFIRMED from
    // junie.jetbrains.com/docs/junie-cli-mcp-configuration.html — object map
    // "mcpServers" at <projectDir>/.junie/mcp/mcp.json (project) and
    // ~/.junie/mcp/mcp.json (user; the CLI uses the SAME MCP JSON as Junie in
    // JetBrains IDEs); stdio { command, args?, env? }, remote { url, headers? }
    // (`url`, not `serverUrl`; no type/disabled).
    // hostNative commands + skills + subagents = true: Junie documents custom
    // slash commands, Agent Skills, and subagents, but those content surfaces
    // are NOT wired by this adapter (initial scope = MCP-only) — an honest
    // CEILING, not a host gap. hooks: Junie documents NO user-installable
    // lifecycle hook surface → hostNative.hooks stays false (no host hook layer).
    hostNative: s(true, false, true, true, true, true, false, false),
  },
  {
    id: "mistral-vibe",
    name: "Mistral Vibe",
    paradigm: "mcp-only",
    surfaces: s(true, false, false, false, false, false, false, false),
    // mcp-only: AC installs the MCP server only. MCP config is TOML at
    // <projectDir>/.vibe/config.toml (project, precedence) → ~/.vibe/config.toml
    // (user); root key `mcp_servers` is a TOML ARRAY-OF-TABLES ([[mcp_servers]],
    // each entry carries a `name` short alias — distinct from codex's table-keyed
    // [mcp_servers.<name>]). stdio { name, transport:"stdio", command, args?, env? };
    // remote { name, transport:"http"|"streamable-http", url, headers? }. Byte-
    // confirmed from github.com/mistralai/mistral-vibe README + docs.mistral.ai/
    // vibe. hooks: Vibe ships only an experimental hook surface with no byte-
    // confirmed contract → hostNative.hooks stays false (honest CEILING, not a
    // promised gap). memory/commands/skills/subagents: no AC-wired surface
    // confirmed — left matching our support (no guessed gap).
    hostNative: s(true, false, false, false, false, false, false, false),
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
    "kimi", "pi", "antigravity-cli", "grok-build", "grok-cli", "devin", "open-interpreter",
    "junie", "mistral-vibe",
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

/** Short per-card form-factor label: CLI / IDE / Ext (from the host's form factor). */
const formFactorShortLabel: Record<FormFactorId, string> = {
  cli: "CLI",
  extension: "Ext",
  app: "IDE",
};

/** Compact form-factor chip label for a platform id (undefined if unclassified). */
export function formFactorShort(id: string): string | undefined {
  const ff = formFactorOf(id);
  return ff ? formFactorShortLabel[ff] : undefined;
}

/* ------------------------------------------------------------------ */
/* Coverage rank tiers — closed-vs-OSS hybrid                          */
/* ------------------------------------------------------------------ */

/**
 * Per-host open/closed status, the input to the wall's rank-tier coloring.
 *   - `{ closed: true }` → no open-source PRODUCT repo → the premium "Frontier"
 *     tier (these are flagship agents whose star count would misrepresent them:
 *     either there is no public repo, or the only public repo is an
 *     issues/docs tracker, not the product source).
 *   - `{ repo: "owner/name" }` → public product/source repo; ranked by that
 *     repo's GitHub stargazers_count into LoL-style tiers (see STAR_TIERS),
 *     unless the id is explicitly promoted in `promotedFrontierOssIds`.
 *
 * Each repo was VERIFIED to exist and to be the actual product source via
 * `gh api repos/<owner>/<name>` (stars/lang/homepage/fork checked, 2026-06-23);
 * basis cited inline. A host with no confirmable public PRODUCT repo is marked
 * `closed` rather than guessing a repo. Drift-guarded: every platform id must
 * have exactly one entry here (tests/docs/platform-drift.test.ts).
 */
export type HostSource = { closed: true } | { repo: string };

export const hostSource: Record<string, HostSource> = {
  // --- Public product/source repo verified ---
  codex: { repo: "openai/codex" },
  "gemini-cli": { repo: "google-gemini/gemini-cli" },
  opencode: { repo: "anomalyco/opencode" }, // SST rebranded to Anomaly; sst/opencode 301s here
  "mimo-code": { repo: "XiaomiMiMo/MiMo-Code" }, // adapter header cites this repo
  "kilo-cli": { repo: "Kilo-Org/kilocode" }, // OpenCode-fork CLI shares the kilocode source
  openhands: { repo: "OpenHands/OpenHands" }, // moved to its own org; All-Hands-AI/OpenHands 301s here
  "roo-code": { repo: "RooCodeInc/Roo-Code" }, // ARCHIVED upstream — see hostLifecycle
  kilo: { repo: "Kilo-Org/kilocode" }, // VS Code ext, same source repo as kilo-cli
  cline: { repo: "cline/cline" },
  zed: { repo: "zed-industries/zed" },
  codebuff: { repo: "CodebuffAI/freebuff" }, // repo + product renamed to Freebuff (freebuff.com); old path 301s here
  pi: { repo: "earendil-works/pi" }, // badlogic/pi-mono redirects here (canonical)
  omp: { repo: "earendil-works/pi" }, // OMP is a pi fork; same upstream source repo
  "qwen-code": { repo: "QwenLM/qwen-code" },
  kimi: { repo: "MoonshotAI/kimi-cli" }, // Kimi Code CLI, open product source
  crush: { repo: "charmbracelet/crush" },
  goose: { repo: "aaif-goose/goose" }, // moved out of the Block org; block/goose 301s here
  nemoclaw: { repo: "NVIDIA/NemoClaw" },
  openclaw: { repo: "openclaw/openclaw" }, // homepage openclaw.ai, active TS source
  "amazon-q": { repo: "aws/amazon-q-developer-cli" }, // the CLI IS open source (Rust)
  continue: { repo: "continuedev/continue" },
  "grok-build": { repo: "xai-org/grok-build" }, // xAI's official agent (Apache-2.0)
  "grok-cli": { repo: "superagent-ai/grok-cli" }, // community grok-cli (npm grok-dev)
  "open-interpreter": { repo: "openinterpreter/openinterpreter" }, // handle normalized; old path 301s here
  "mistral-vibe": { repo: "mistralai/mistral-vibe" },
  junie: { repo: "JetBrains/junie" }, // JetBrains' own open agent CLI
  mux: { repo: "coder/xum" }, // Coder renamed mux → Xum (xum.coder.com); coder/mux 301s here
  kiro: { repo: "kirodotdev/Kiro" }, // Kiro's public product repo
  hermes: { repo: "NousResearch/hermes-agent" }, // Nous Research's open Hermes Agent

  // --- Closed (no confirmable open-source product repo → Frontier) ---
  codebuddy: { closed: true }, // Tencent CodeBuddy — no public repo (404)
  "claude-code": { closed: true }, // product closed; anthropics/claude-code is issues-only
  cursor: { closed: true }, // product closed; getcursor/cursor is issues-only
  "vscode-copilot": { closed: true }, // GitHub Copilot in VS Code — closed
  "copilot-cli": { closed: true }, // github/copilot-cli is a feedback repo, product closed
  "jetbrains-copilot": { closed: true }, // GitHub Copilot in JetBrains — closed
  amp: { closed: true }, // Sourcegraph Amp — no public source repo
  warp: { closed: true }, // Warp terminal — closed (warpdotdev/warp is not the product src)
  droid: { closed: true }, // Factory Droid; Factory-AI/factory is docs/issues (lang null)
  "antigravity-cli": { closed: true }, // Google Antigravity CLI — closed
  antigravity: { closed: true }, // Google Antigravity IDE — closed
  trae: { closed: true }, // ByteDance Trae — no public repo (404)
  devin: { closed: true }, // Cognition Devin — no public repo (404)
  windsurf: { closed: true }, // Windsurf (Codeium) — no public product repo (404)
};

/**
 * Open-source hosts that still render as the premium Frontier band because the
 * product is a flagship agent from a frontier-model vendor. They keep the
 * Frontier badge, while the card still shows the actual GitHub star count.
 */
export const promotedFrontierOssIds = new Set<string>([
  "codex", // OpenAI
  "gemini-cli", // Google
  "qwen-code", // Alibaba / Qwen
  "amazon-q", // AWS
]);

/**
 * Per-host BRAND COLOR — the host's recognizable primary color, used to tint the
 * host NAME on the landing coverage marquee (CoverageMarquee.tsx). One hex per
 * platform id (registry-covered and drift-guarded — every platform id must have
 * exactly one entry, see tests/docs/platform-drift.test.ts).
 *
 * LEGIBILITY CONSTRAINT (the marquee renders on a near-black bg in dark mode and
 * a near-white bg in light mode, and the site defaults to dark): every hex is a
 * single MID-TONE shade tuned to clear WCAG large-text contrast (≥3:1) on BOTH
 * backgrounds simultaneously. That luminance window is narrow (~0.11–0.29), so
 * each color is the brand's recognizable hue rendered at a mid lightness rather
 * than its literal logo hex — e.g. Anthropic's warm orange as a deep rust
 * (#C2410C, not the lighter #D97757 which is invisible on white), AWS orange
 * darkened from #FF9900 to #C77400, OpenAI's near-black mark surfaced as a
 * readable teal-green (#157F66). Hosts with no obvious brand color get a
 * sensible hue-derived neutral (e.g. grok-cli → slate). Verified worst-case
 * contrast: 3.07:1 (dark) / 3.18:1 (light), both above the 3:1 bar.
 */
export const brandColor: Record<string, string> = {
  // --- frontier / closed-source ---
  "claude-code": "#C2410C", // Anthropic warm rust-orange (deep #D97757)
  codebuddy: "#3B6FE0", // Tencent CodeBuddy blue
  cursor: "#4B5EE0", // Cursor indigo-blue
  "vscode-copilot": "#2563C9", // VS Code blue
  "copilot-cli": "#7C3AED", // GitHub Copilot violet
  "jetbrains-copilot": "#9333A8", // JetBrains × Copilot magenta-purple
  amp: "#B85420", // Sourcegraph Amp orange (darkened)
  warp: "#1E8E86", // Warp teal (darkened)
  droid: "#C03A2B", // Factory Droid red-orange
  "antigravity-cli": "#3A6FD8", // Google Antigravity blue
  antigravity: "#3A6FD8", // Google Antigravity blue
  kiro: "#6D4FC0", // AWS Kiro purple
  trae: "#C0392B", // ByteDance Trae red
  devin: "#1F84B5", // Cognition Devin blue
  windsurf: "#1A8F6B", // Windsurf teal-green
  hermes: "#9A7B1F", // Nous Hermes gold (darkened)

  // --- famous-vendor OSS (the big tier alongside frontier) ---
  codex: "#157F66", // OpenAI near-black mark → readable teal-green
  "gemini-cli": "#3367D6", // Google blue
  "qwen-code": "#7A3FC0", // Alibaba/Qwen purple
  "amazon-q": "#C77400", // AWS orange (darkened from #FF9900)

  // --- other OSS ---
  opencode: "#C03A2B", // sst opencode red-orange
  "mimo-code": "#D2691E", // Xiaomi MiMoCode orange (darkened)
  "kilo-cli": "#2E8B3D", // Kilo green
  openhands: "#B5860B", // All-Hands OpenHands gold-amber
  "roo-code": "#9333A8", // Roo Code purple
  kilo: "#2E8B3D", // Kilo green (same source as kilo-cli)
  cline: "#1F8C84", // Cline teal
  zed: "#2D5FD0", // Zed blue (readable #084CCF)
  codebuff: "#C0492B", // Codebuff orange-red
  pi: "#6D4FC0", // pi violet
  omp: "#6D4FC0", // Oh My Pi violet (pi fork)
  kimi: "#6A55D6", // Moonshot Kimi indigo
  crush: "#C03A86", // Charm Crush pink-magenta
  goose: "#2E8B57", // Block goose green
  nemoclaw: "#5A9216", // NVIDIA NemoClaw green (darkened)
  openclaw: "#C06A1E", // OpenClaw orange
  continue: "#2C7FB8", // Continue blue
  "grok-build": "#1D1D1F", // xAI near-black (the x.ai / Grok wordmark ground)
  "grok-cli": "#5A6470", // xAI Grok neutral slate (no obvious brand hue)
  "open-interpreter": "#2E8B3D", // Open Interpreter green
  "mistral-vibe": "#D2691E", // Mistral Vibe orange (darkened)
  junie: "#9333A8", // JetBrains Junie magenta
  mux: "#3A6FD8", // Coder Mux blue
};

/**
 * GitHub-stars rank tier, highest threshold first. `frontier` is the premium
 * closed/promoted tier and is NOT in this list (it has no star threshold). The
 * thresholds were tuned against the real, fetched star spread (2026-06-23) so
 * the non-promoted OSS hosts land across all eight tiers rather than piling
 * into the top.
 */
export type StarTier =
  | "Challenger"
  | "Grandmaster"
  | "Master"
  | "Diamond"
  | "Platinum"
  | "Gold"
  | "Silver"
  | "Bronze";

export type CoverageTier = "frontier" | StarTier;

export const STAR_TIERS: readonly { tier: StarTier; min: number }[] = [
  { tier: "Challenger", min: 80000 },
  { tier: "Grandmaster", min: 50000 },
  { tier: "Master", min: 25000 },
  { tier: "Diamond", min: 15000 },
  { tier: "Platinum", min: 8000 },
  { tier: "Gold", min: 3000 },
  { tier: "Silver", min: 1000 },
  { tier: "Bronze", min: 0 },
];

/** The star-derived tier for a stargazers count. */
export function starTier(stars: number): StarTier {
  return (STAR_TIERS.find((t) => stars >= t.min) ?? STAR_TIERS[STAR_TIERS.length - 1]!).tier;
}

/**
 * The coverage tier for a host: `frontier` if closed-source or explicitly
 * promoted, else the star-derived tier from `stars` (its repo's stargazers_count,
 * 0 if unknown). Unknown ids default to `frontier` (treated as closed) so the
 * wall never renders an untiered card.
 */
export function tierOf(id: string, stars: number | undefined): CoverageTier {
  const src = hostSource[id];
  if (!src || "closed" in src || promotedFrontierOssIds.has(id)) return "frontier";
  return starTier(stars ?? 0);
}

/**
 * The public repos to refresh at build (id → "owner/name"), deduped by repo.
 * Read by site/scripts/fetch-coverage-stars.mjs (which transpiles this module).
 */
export const coverageRepos: readonly string[] = Array.from(
  new Set(
    Object.values(hostSource)
      .filter((s): s is { repo: string } => "repo" in s)
      .map((s) => s.repo),
  ),
);

/**
 * Per-host "go to the source" link, the target of each card's top-right icon.
 *   - kind "github" → a verified public GitHub repo (the icon is a GitHub mark).
 *     OSS hosts reuse their `hostSource` repo; closed hosts that nonetheless
 *     keep a public repo (issues/release/source) point there.
 *   - kind "home"   → no usable public repo found → the host's product homepage
 *     (the icon is an external-link mark).
 *
 * Every URL was VERIFIED to resolve (2026-06-23): GitHub repos via
 * `gh api repos/<owner>/<name>` (must return full_name); homepages via an
 * HTTP 200. No URL is fabricated — a host with neither a confirmable repo nor a
 * homepage would be given kind "home" with its documented site, never a guess.
 * Drift-guarded: every platform id has exactly one entry
 * (tests/docs/platform-drift.test.ts).
 */
export type HostLink = { kind: "github"; repo: string } | { kind: "home"; url: string };

const gh = (repo: string): HostLink => ({ kind: "github", repo });
const home = (url: string): HostLink => ({ kind: "home", url });

export const hostLinks: Record<string, HostLink> = {
  // OSS hosts → their product repo (same as hostSource).
  codex: gh("openai/codex"),
  "gemini-cli": gh("google-gemini/gemini-cli"),
  opencode: gh("anomalyco/opencode"),
  "mimo-code": gh("XiaomiMiMo/MiMo-Code"),
  "kilo-cli": gh("Kilo-Org/kilocode"),
  openhands: gh("OpenHands/OpenHands"),
  "roo-code": gh("RooCodeInc/Roo-Code"),
  kilo: gh("Kilo-Org/kilocode"),
  cline: gh("cline/cline"),
  zed: gh("zed-industries/zed"),
  codebuff: gh("CodebuffAI/freebuff"),
  pi: gh("earendil-works/pi"),
  omp: gh("earendil-works/pi"),
  "qwen-code": gh("QwenLM/qwen-code"),
  kimi: gh("MoonshotAI/kimi-cli"),
  crush: gh("charmbracelet/crush"),
  goose: gh("aaif-goose/goose"),
  nemoclaw: gh("NVIDIA/NemoClaw"),
  openclaw: gh("openclaw/openclaw"),
  "amazon-q": gh("aws/amazon-q-developer-cli"),
  continue: gh("continuedev/continue"),
  "grok-build": gh("xai-org/grok-build"),
  "grok-cli": gh("superagent-ai/grok-cli"),
  "open-interpreter": gh("openinterpreter/openinterpreter"),
  "mistral-vibe": gh("mistralai/mistral-vibe"),
  junie: gh("JetBrains/junie"),
  mux: gh("coder/xum"),
  kiro: gh("kirodotdev/Kiro"),
  hermes: gh("NousResearch/hermes-agent"),

  // Closed hosts with a VERIFIED public GitHub repo (issues / release / source).
  "claude-code": gh("anthropics/claude-code"),
  cursor: gh("cursor/cursor"),
  "copilot-cli": gh("github/copilot-cli"),
  "vscode-copilot": gh("microsoft/vscode-copilot-release"),
  warp: gh("warpdotdev/warp"),
  droid: gh("Factory-AI/factory"),
  trae: gh("Trae-AI/TRAE"),

  // Closed hosts with NO confirmable product repo → product homepage (verified 200).
  // (github/CopilotForXcode is a different product, so jetbrains-copilot points
  // at GitHub Copilot's official feature page rather than a wrong repo.)
  "jetbrains-copilot": home("https://github.com/features/copilot"),
  amp: home("https://ampcode.com"),
  devin: home("https://devin.ai"),
  windsurf: home("https://windsurf.com"),
  codebuddy: home("https://www.codebuddy.ai"),
  antigravity: home("https://antigravity.google"),
  "antigravity-cli": home("https://antigravity.google"),
};

/** Resolve a host's "go to source" URL (github repo URL or homepage). */
export function hostLinkUrl(id: string): string | undefined {
  const l = hostLinks[id];
  if (!l) return undefined;
  return l.kind === "github" ? `https://github.com/${l.repo}` : l.url;
}

/* ------------------------------------------------------------------ */
/* Agent Plugins 1.0.0 — per-host spec state                           */
/* ------------------------------------------------------------------ */

/**
 * How a host relates to Agent Plugins 1.0.0 (agent-plugins.org — the open
 * bundle spec Vercel maintains with AWS, Cursor, GitHub, Microsoft and
 * OpenAI). Three honest states, and NOT a capability claim about the host:
 *
 *   - "delivered" — agent-connector packages this host as the spec bundle
 *     (plugin.json · mcp.json · skills/ · its client namespace) AND the host's
 *     own marketplace/plugin flow installs it.
 *   - "delegated" — the SAME bundle reaches the host through a sibling
 *     client rather than a flow of its own. VS Code documents this outright
 *     ("automatically discovers plugins that you install with the GitHub
 *     Copilot CLI"); for Copilot in JetBrains the documented route is the
 *     Copilot CLI running in its integrated terminal, since GitHub documents
 *     no plugin-install path for the JetBrains IDE plugin itself.
 *   - "client"    — the host is a listed Agent Plugins client, but
 *     agent-connector still ships its client-specific format, because that is
 *     the one carrying hooks and commands there (Cursor).
 *
 * Client roster verified against https://agent-plugins.org/compatible-clients
 * (2026-09-02) — NINE clients: VS Code, GitHub Copilot, Cursor, ChatGPT &
 * Codex, Kiro, OpenClaw, Hermes Agent, Grok Bot, NanoClaw. Two near-misses are
 * deliberately NOT marked — xAI's "Grok Bot" is not the community `grok-cli`
 * we adapt, and Nanoco's "NanoClaw" is not NVIDIA's NemoClaw. GitHub Copilot
 * in JetBrains is NOT separately listed; it is marked "delegated" because it
 * reads the Copilot plugin store, not because the spec site names it.
 *
 * Drift-guarded (tests/docs/platform-drift.test.ts): the delivered ∪ delegated
 * ids must EQUAL the platforms that `MARKETPLACE_FORMAT_BY_PLATFORM` routes to
 * the `agent-plugin` format, so a routing change cannot silently rot the wall.
 */
export type AgentPluginState = "delivered" | "delegated" | "client";

export const agentPluginSupport: Record<string, AgentPluginState> = {
  // Packaged AND installed by a headless plugin verb we drive.
  codex: "delivered", // codex plugin marketplace add → plugin add
  "copilot-cli": "delivered", // copilot plugin marketplace add → plugin install
  kiro: "delivered", // listed client; one-click "Add to Kiro" install
  hermes: "delivered", // hermes plugins install → plugins enable
  // Same bundle, no headless verb of its own — it arrives through the editor's
  // own install command or the sibling Copilot CLI plugin store.
  "vscode-copilot": "delegated", // listed client; auto-discovers the CLI's store
  "jetbrains-copilot": "delegated", // reachable via Copilot CLI in its terminal
  // Listed clients whose OWN format carries hooks/commands — we ship that.
  cursor: "client", // .cursor-plugin/ carries rules, agents, commands, hooks
  openclaw: "client", // ai.openclaw namespace; we install the claude-plugin tree
};

/** Badge copy for the wall's Agent Plugins marker. */
export const agentPluginBadge: Record<
  AgentPluginState,
  { label: string; short: string; title: string }
> = {
  delivered: {
    label: "AP 1.0",
    short: "Agent Plugins bundle",
    title:
      "Agent Plugins 1.0.0 — agent-connector packages this host as the spec bundle (plugin.json · mcp.json · skills/) and the host's own plugin flow installs it",
  },
  delegated: {
    label: "AP 1.0",
    short: "Agent Plugins bundle, installed by a sibling flow",
    title:
      "Agent Plugins 1.0.0 — the same spec bundle, but this host has no headless install verb of its own: it arrives via the GitHub Copilot CLI (VS Code auto-discovers what the CLI installed; in JetBrains, run the CLI in the integrated terminal)",
  },
  client: {
    label: "AP client",
    short: "Agent Plugins client",
    title:
      "Listed Agent Plugins 1.0.0 client — agent-connector still ships this host its client-specific format, because that is the one carrying hooks and commands here",
  },
};

/** A host's Agent Plugins state, or undefined when it does not speak the spec. */
export function agentPluginStateOf(id: string): AgentPluginState | undefined {
  return agentPluginSupport[id];
}

/* ------------------------------------------------------------------ */
/* Host lifecycle — upstream status that outlives our adapter          */
/* ------------------------------------------------------------------ */

/**
 * Hosts whose UPSTREAM product is no longer on a normal active track. Absence
 * from this map means "active" — only the exceptions are listed, each with the
 * evidence that put it here. The adapter keeps working either way; this is an
 * honesty marker on the wall, not a capability change.
 *
 *   - "archived"   — the product repo is archived / the project has shut down.
 *   - "sunsetting" — still shipping, but the vendor has started winding it down
 *     or steering users to a successor.
 *
 * Drift-guarded (tests/docs/platform-drift.test.ts): every key must be a real
 * platform id, so a renamed or dropped host cannot leave a dangling marker.
 */
export type HostLifecycle = {
  status: "archived" | "sunsetting";
  label: string;
  note: string;
};

export const hostLifecycle: Record<string, HostLifecycle> = {
  "roo-code": {
    status: "archived",
    label: "EOL",
    note:
      "Upstream archived — RooCodeInc/Roo-Code is archived on GitHub (last push 2026-05-15) and the team wound the project down; migration guidance points users to Cline. The adapter still installs, but the host is no longer developed.",
  },
  "gemini-cli": {
    status: "sunsetting",
    label: "Sunsetting",
    note:
      "The repo is still active, but Google stopped serving Gemini CLI to personal accounts (free / AI Pro / Ultra) on 2026-06-18 and points users at Antigravity CLI as the successor.",
  },
};

/** A host's lifecycle exception, or undefined when it is on a normal active track. */
export function hostLifecycleOf(id: string): HostLifecycle | undefined {
  return hostLifecycle[id];
}

/**
 * Compact star label: rounded thousands with a "k" unit.
 *   ≥1000 → Math.round(stars/1000)+"k"   (1970→"2k", 105509→"106k", 380044→"380k")
 *   <1000 → (Math.round(stars/100)/10).toFixed(1)+"k"   (306→"0.3k")
 */
export function formatStars(stars: number): string {
  if (stars >= 1000) return `${Math.round(stars / 1000)}k`;
  return `${(Math.round(stars / 100) / 10).toFixed(1)}k`;
}

/* ------------------------------------------------------------------ */
/* Fork-lineage families — ordering metadata only (NOT drift-guarded)  */
/* ------------------------------------------------------------------ */

/**
 * Fork-lineage families: which hosts descend from a common parent. Used solely
 * to keep same-lineage hosts adjacent when coverage displays sort by
 * paradigm → family → name; it has no install/runtime effect.
 *
 * Single source of truth for the `family` ordering key. Each value is the
 * FAMILY ANCHOR id (the lineage parent); only multi-member families are listed
 * — every other host is its own family (familyKey falls back to the id), so
 * singletons sort by name within their paradigm.
 *
 * Fork families per src/adapters/registry.ts fork-ordering comments +
 * site/src/platform-data.ts host comments:
 *   - claude-code: codebuddy is a Claude Code fork (registry.ts "Claude Code fork").
 *   - codex: open-interpreter is "a fork of OpenAI's Codex" (registry.ts).
 *   - opencode: mimo-code + kilo-cli are OpenCode forks (registry.ts "OpenCode FORK").
 *   - cline: roo-code + kilo forked from cline ("the PARENT that roo-code and kilo forked").
 *   - copilot-cli: vscode-copilot + jetbrains-copilot share the GitHub Copilot surface.
 *   - pi: omp is a "pi fork" (platform-data.ts omp comment).
 *   - openclaw: nemoclaw wraps/extends OpenClaw (registry.ts "wraps OpenClaw").
 *   - antigravity: antigravity-cli is "a fork of the IDE" (registry.ts).
 */
export const familyOf: Record<string, string> = {
  // claude-code lineage
  "claude-code": "claude-code",
  codebuddy: "claude-code",
  // codex lineage
  codex: "codex",
  "open-interpreter": "codex",
  // opencode lineage
  opencode: "opencode",
  "mimo-code": "opencode",
  "kilo-cli": "opencode",
  // cline lineage
  cline: "cline",
  "roo-code": "cline",
  kilo: "cline",
  // GitHub Copilot lineage
  "copilot-cli": "copilot-cli",
  "vscode-copilot": "copilot-cli",
  "jetbrains-copilot": "copilot-cli",
  // pi lineage
  pi: "pi",
  omp: "pi",
  // openclaw lineage
  openclaw: "openclaw",
  nemoclaw: "openclaw",
  // antigravity lineage
  antigravity: "antigravity",
  "antigravity-cli": "antigravity",
};

/**
 * The lineage-family key for a platform id. Members of a documented fork family
 * share their anchor id; every other host is its own family (its id), so it
 * sorts purely by name within its paradigm.
 */
export function familyKey(id: string): string {
  return familyOf[id] ?? id;
}

/** Paradigm display/sort order (the `paradigms` index): json-stdio < mcp-only < ts-plugin. */
const paradigmRank: Record<ParadigmId, number> = {
  "json-stdio": 0,
  "mcp-only": 1,
  "ts-plugin": 2,
};

/**
 * Coverage-display comparator: order hosts by hook paradigm, then by fork-lineage
 * family (so forks stay adjacent), then alphabetically by display name. Reusable
 * across every coverage surface that lists hosts in an otherwise-arbitrary order,
 * keeping the ordering consistent and predictable. Sorts within whatever the
 * surface's primary grouping already is (e.g. a form-factor band) — it does not
 * change that grouping.
 */
export function byParadigmFamilyName(a: Platform, b: Platform): number {
  const pr = paradigmRank[a.paradigm] - paradigmRank[b.paradigm];
  if (pr !== 0) return pr;
  const fa = familyKey(a.id);
  const fb = familyKey(b.id);
  if (fa !== fb) return fa.localeCompare(fb);
  return a.name.localeCompare(b.name);
}
