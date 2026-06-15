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
): PlatformSurfaces => ({ mcp, hooks, commands, skills, subagents, memory });

/*
 * hostNative PROVENANCE (order: mcp/hooks/commands/skills/subagents/memory).
 * Fact base, strongest-first: the AC research corpus (docs/research/*.json +
 * each adapter's header comment), the 0.2.0 release skills audit, the 20-host
 * hook-extension survey (live official docs, 2026-06-11), the 31-host
 * memory-surface matrix, and targeted official-doc fetches (2026-06-12) for
 * cells the corpus left uncertain. Rule applied throughout: a claimed gap
 * (hostNative=true while surfaces=false) requires positive evidence; genuinely
 * uncertain cells default to matching our support — no guessed gaps.
 *
 * Cross-cutting facts:
 *   - memory: ALL 31 hosts natively read a rules/memory file (31-host memory
 *     matrix; AGENTS.md or a host-specific equivalent). hostNative.memory=true
 *     everywhere.
 *   - hooks: the 20 json-stdio/ts-plugin hosts all expose a native hook or
 *     plugin layer (hook survey). Of the 9 "mcp-only" hosts the survey lists
 *     as hook-less, ONE is stale: Amp now ships a TypeScript plugin system
 *     with thread-lifecycle events (ampcode.com/manual, Plugins) — so Amp is
 *     hostNative.hooks=true (our gap); the other eight stay false.
 *   - skills: native SKILL.md readers verified by the release audit + official
 *     docs: claude-code, codex, cursor, vscode-copilot, copilot-cli,
 *     gemini-cli, opencode, antigravity(+cli), pi, jetbrains-copilot, PLUS the
 *     un-wired hosts kiro (kiro.dev/docs/skills), zed (.agents/skills, zed
 *     repo docs), qwen-code (.qwen/skills, official docs), kimi
 *     (~/.kimi/skills — flagged in our own adapter header), goose (press +
 *     skills.sh listing; dirs unverified → medium), warp
 *     (docs.warp.dev skills.mdx: .agents/.warp/.claude/… dirs), roo-code
 *     (docs.roocode.com/features/skills), kilo + kilo-cli
 *     (kilo.ai/docs/customize/skills), droid
 *     (docs.factory.ai/cli/configuration/skills), trae (docs.trae.ai/ide/
 *     skills), amp (ampcode.com/manual Agent Skills), codebuff
 *     (.agents/skills + ~/.agents/skills — CodebuffAI/codebuff
 *     sdk/src/skills/load-skills.ts, fetched 2026-06-12), openclaw
 *     (docs.openclaw.ai/tools/skills: <workspace>/skills, .agents/skills,
 *     ~/.openclaw/skills, fetched 2026-06-12). NOT skills hosts: mux, crush,
 *     hermes, omp (no skills surface documented; defaulted to ours).
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
 *   - amp: hooks=true [high, supersedes stale corpus] + subagents=true
 *     [medium-high, EXPERIMENTAL amp.experimental.createAgent plugin API] +
 *     skills=true [high] — all ampcode.com/manual; commands=false [medium]:
 *     no chat slash-command surface (plugin registerCommand() adds
 *     command-palette actions, not prompt commands).
 *   - codebuff: subagents=true [high] — user-defined TypeScript agents in
 *     .agents/ (created by /init; CodebuffAI/codebuff initial-agents-dir
 *     template, www.codebuff.com/docs/agents). hooks=false (no hook layer).
 *   - mux: commands/skills/subagents=false — no such surfaces documented
 *     (mux.coder.com docs cover instruction files only); defaulted to ours.
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
 *   - crush/hermes: commands/skills/subagents=false — no such surfaces in the
 *     corpus or host docs; defaulted to ours.
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
    id: "claude-code",
    name: "Claude Code",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, true, true),
    hostNative: s(true, true, true, true, true, true),
  },
  {
    id: "codex",
    name: "Codex CLI",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, true, true),
    // commands: ~/.codex/prompts — deprecated in favor of Codex Skills, still works.
    hostNative: s(true, true, true, true, true, true),
  },
  {
    id: "cursor",
    name: "Cursor",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, true, true),
    hostNative: s(true, true, true, true, true, true),
  },
  {
    id: "vscode-copilot",
    name: "VS Code Copilot",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, true, true),
    hostNative: s(true, true, true, true, true, true),
  },
  {
    id: "copilot-cli",
    name: "GitHub Copilot CLI",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, true, true, true),
    // commands: host N/A — built-ins only (FRs github/copilot-cli #618, #1113).
    hostNative: s(true, true, false, true, true, true),
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, true, true),
    hostNative: s(true, true, true, true, true, true),
  },
  {
    id: "warp",
    name: "Warp",
    paradigm: "mcp-only",
    surfaces: s(true, false, false, true, false, true),
    // skills now wired (.agents/skills/<name>/SKILL.md, project scope — Warp Drive
    // is cloud-managed so there is no documented user-scope dir; skills double as
    // /{skill-name} slash commands in Warp's UI).
    // GAP: commands (skills-as-/{skill-name}). N/A: hooks (FR #7834),
    // subagents (profiles ≠ subagents; FR #9107).
    hostNative: s(true, false, true, true, false, true),
  },
  {
    id: "opencode",
    name: "OpenCode",
    paradigm: "ts-plugin",
    surfaces: s(true, true, true, true, true, true),
    hostNative: s(true, true, true, true, true, true),
  },
  {
    id: "mimo-code",
    name: "MiMoCode",
    paradigm: "ts-plugin",
    surfaces: s(true, true, true, true, true, true),
    // Xiaomi MiMoCode (github.com/XiaomiMiMo/MiMo-Code, @mimo-ai/cli) is a FORK
    // of OpenCode — it inherits OpenCode's six surfaces (MCP root key "mcp",
    // ts-plugin hooks, commands/skills/subagents under <mcDir>, AGENTS.md +
    // CLAUDE.md memory). Mirrors the OpenCode wall row; no verified divergence.
    hostNative: s(true, true, true, true, true, true),
  },
  {
    id: "kilo-cli",
    name: "Kilo CLI",
    paradigm: "ts-plugin",
    surfaces: s(true, true, true, true, true, true),
    // OpenCode fork — all six surfaces now wired (commands → .kilo/command/,
    // skills → .kilo/skills/, subagents → .kilo/agent/ mode:subagent).
    hostNative: s(true, true, true, true, true, true),
  },
  {
    id: "droid",
    name: "Droid (Factory)",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, true, true),
    // All six wired: commands (.factory/commands), skills (.factory/skills),
    // subagents (.factory/droids/<name>.md — markdown). docs.factory.ai/cli.
    hostNative: s(true, true, true, true, true, true),
  },
  {
    id: "roo-code",
    name: "Roo Code",
    paradigm: "mcp-only",
    surfaces: s(true, false, true, true, false, true),
    // commands (.roo/commands) + skills (.roo/skills, AgentSkills) wired —
    // docs.roocode.com. N/A: hooks, subagents.
    hostNative: s(true, false, true, true, false, true),
  },
  {
    id: "kilo",
    name: "Kilo Code",
    paradigm: "ts-plugin",
    surfaces: s(true, true, true, true, true, true),
    // 7.x rebuilt on the Kilo CLI server: hooks (ts-plugin, .kilo/plugin/) and
    // skills (.kilo/skills/) are now wired — all six surfaces supported. The ext
    // shares one config backend with kilo-cli (kilo.json + kilo.jsonc merge).
    hostNative: s(true, true, true, true, true, true),
  },
  {
    id: "trae",
    name: "Trae",
    paradigm: "mcp-only",
    surfaces: s(true, false, false, true, false, true),
    // skills wired (.trae/skills/<name>/SKILL.md — docs.trae.ai/ide/skills).
    // PERMANENT GAP (adversarially confirmed): subagents are UI-created + imported
    // via cloud share links (s.trae.ai/a/<id>) — no on-disk agent file.
    // N/A: hooks, commands (no standalone command surface).
    hostNative: s(true, false, false, true, true, true),
  },
  {
    id: "antigravity-cli",
    name: "Antigravity CLI",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, false, true),
    // subagents: N/A — plugin-bundle-only, no user surface (matches the IDE).
    hostNative: s(true, true, true, true, false, true),
  },
  {
    id: "antigravity",
    name: "Google Antigravity",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, false, true),
    hostNative: s(true, true, true, true, false, true),
  },
  {
    id: "zed",
    name: "Zed",
    paradigm: "mcp-only",
    surfaces: s(true, false, false, true, false, true),
    // skills now wired (.agents/skills project, ~/.agents/skills user).
    // N/A: hooks, commands, subagents.
    hostNative: s(true, false, false, true, false, true),
  },
  {
    id: "amp",
    name: "Amp",
    paradigm: "mcp-only",
    surfaces: s(true, false, false, true, false, true),
    // skills wired (~/.config/agents/skills | .agents/skills, SKILL.md).
    // REMAINING GAPS (adversarially verified): hooks = experimental Bun TS-plugin
    // API only (.amp/plugins/*.ts — no declarative hook file); subagents =
    // experimental amp.experimental.createAgent / role-specific .agents/checks.
    // ampcode.com/manual. N/A: commands.
    hostNative: s(true, true, false, true, true, true),
  },
  {
    id: "codebuff",
    name: "Codebuff",
    paradigm: "mcp-only",
    surfaces: s(true, false, false, true, false, true),
    // skills wired (.agents/skills, AgentSkills — docs + load-skills.ts verified).
    // GAP: subagents are executable .agents/*.ts AgentDefinition modules (not
    // markdown) — confirmed real, deferred (SDK-schema-coupled render).
    hostNative: s(true, false, false, true, true, true),
  },
  {
    id: "mux",
    name: "Mux",
    paradigm: "mcp-only",
    surfaces: s(true, false, false, false, false, true),
    hostNative: s(true, false, false, false, false, true),
  },
  // pi has NO writable MCP config (transports: []) — commands + skills + memory.
  {
    id: "pi",
    name: "Pi",
    paradigm: "mcp-only",
    surfaces: s(false, false, true, true, false, true),
    // mcp: N/A — pi offers no MCP surface at all (deliberate host design).
    // commands now wired (prompt templates: .pi/prompts/ project,
    // ~/.pi/agent/prompts/ user); skills fixed to ~/.pi/agent/skills/ (user).
    hostNative: s(false, false, true, true, false, true),
  },
  {
    id: "jetbrains-copilot",
    name: "JetBrains Copilot",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, false, true),
    hostNative: s(true, true, true, true, false, true),
  },
  {
    id: "qwen-code",
    name: "Qwen CLI",
    paradigm: "json-stdio",
    surfaces: s(true, true, true, true, true, true),
    // skills now wired (.qwen/skills project, ~/.qwen/skills user) — all six.
    hostNative: s(true, true, true, true, true, true),
  },
  {
    id: "kiro",
    name: "Kiro",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, true, false, true),
    // skills now wired (.kiro/skills project, ~/.kiro/skills user).
    hostNative: s(true, true, false, true, false, true),
  },
  {
    id: "kimi",
    name: "Kimi CLI",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, true, false, true),
    // skills now wired (.kimi/skills project, ~/.kimi/skills user).
    hostNative: s(true, true, false, true, false, true),
  },
  {
    id: "crush",
    name: "Crush",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, false, false, true),
    hostNative: s(true, true, false, false, false, true),
  },
  {
    id: "goose",
    name: "Goose",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, true, false, true),
    // skills wired (~/.agents/skills | .agents/skills, SKILL.md — goose-docs.ai,
    // live-verified; requires the built-in Summon extension v1.25.0+).
    hostNative: s(true, true, false, true, false, true),
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    paradigm: "json-stdio",
    surfaces: s(true, true, false, false, false, true),
    hostNative: s(true, true, false, false, false, true),
  },
  {
    id: "omp",
    name: "Oh My Pi (OMP)",
    paradigm: "ts-plugin",
    surfaces: s(true, true, false, false, false, true),
    hostNative: s(true, true, false, false, false, true),
  },
  {
    id: "nemoclaw",
    name: "NVIDIA NemoClaw",
    paradigm: "ts-plugin",
    surfaces: s(true, true, false, true, false, true),
    // NVIDIA NemoClaw (github.com/NVIDIA/NemoClaw) WRAPS OpenClaw and writes the
    // SAME ~/.openclaw/openclaw.json — it extends OpenClawAdapter, so its surfaces
    // are OpenClaw's verbatim (MCP nested mcp.servers, ts-plugin hooks, memory, and
    // now skills — installSkills is INHERITED from OpenClawAdapter). NemoClaw ships
    // NO Claude-style hooks of its own, but inherits OpenClaw's plugin-hook
    // machinery → hooks stays honest. PERMANENT GAP mirrors OpenClaw: subagents
    // (runtime runs + inline agents.list[], no authored-file folder).
    hostNative: s(true, true, false, true, true, true),
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    paradigm: "ts-plugin",
    surfaces: s(true, true, false, true, false, true),
    // skills wired (<workspace>/skills/<name>/SKILL.md —
    // docs.openclaw.ai/tools/skills, live-verified). PERMANENT GAP (adversarially
    // confirmed): subagents are runtime runs + inline agents.list[] config — no
    // authored-file folder to write into.
    hostNative: s(true, true, false, true, true, true),
  },
];

export const platformCount = platforms.length;
