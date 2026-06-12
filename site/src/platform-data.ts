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
  surfaces: PlatformSurfaces;
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

const s = (
  mcp: boolean,
  hooks: boolean,
  commands: boolean,
  skills: boolean,
  subagents: boolean,
  memory: boolean,
): PlatformSurfaces => ({ mcp, hooks, commands, skills, subagents, memory });

export const platforms: Platform[] = [
  { id: "claude-code", name: "Claude Code", paradigm: "json-stdio", surfaces: s(true, true, true, true, true, true) },
  { id: "codex", name: "Codex CLI", paradigm: "json-stdio", surfaces: s(true, true, true, true, true, true) },
  { id: "cursor", name: "Cursor", paradigm: "json-stdio", surfaces: s(true, true, true, true, true, true) },
  { id: "vscode-copilot", name: "VS Code Copilot", paradigm: "json-stdio", surfaces: s(true, true, true, true, true, true) },
  { id: "copilot-cli", name: "GitHub Copilot CLI", paradigm: "json-stdio", surfaces: s(true, true, false, true, true, true) },
  { id: "gemini-cli", name: "Gemini CLI", paradigm: "json-stdio", surfaces: s(true, true, true, true, true, true) },
  { id: "warp", name: "Warp", paradigm: "mcp-only", surfaces: s(true, false, false, false, false, true) },
  { id: "opencode", name: "OpenCode", paradigm: "ts-plugin", surfaces: s(true, true, true, true, true, true) },
  { id: "kilo-cli", name: "Kilo CLI", paradigm: "ts-plugin", surfaces: s(true, true, false, false, false, true) },
  { id: "droid", name: "Droid (Factory)", paradigm: "json-stdio", surfaces: s(true, true, false, false, false, true) },
  { id: "roo-code", name: "Roo Code", paradigm: "mcp-only", surfaces: s(true, false, false, false, false, true) },
  { id: "kilo", name: "Kilo Code", paradigm: "mcp-only", surfaces: s(true, false, true, false, true, true) },
  { id: "trae", name: "Trae", paradigm: "mcp-only", surfaces: s(true, false, false, false, false, true) },
  { id: "antigravity-cli", name: "Antigravity CLI", paradigm: "json-stdio", surfaces: s(true, true, true, true, false, true) },
  { id: "antigravity", name: "Google Antigravity", paradigm: "json-stdio", surfaces: s(true, true, true, true, false, true) },
  { id: "zed", name: "Zed", paradigm: "mcp-only", surfaces: s(true, false, false, false, false, true) },
  { id: "amp", name: "Amp", paradigm: "mcp-only", surfaces: s(true, false, false, false, false, true) },
  { id: "codebuff", name: "Codebuff", paradigm: "mcp-only", surfaces: s(true, false, false, false, false, true) },
  { id: "mux", name: "Mux", paradigm: "mcp-only", surfaces: s(true, false, false, false, false, true) },
  // pi has NO writable MCP config (transports: []) — skills + memory host.
  { id: "pi", name: "Pi", paradigm: "mcp-only", surfaces: s(false, false, false, true, false, true) },
  { id: "jetbrains-copilot", name: "JetBrains Copilot", paradigm: "json-stdio", surfaces: s(true, true, true, true, false, true) },
  { id: "qwen-code", name: "Qwen CLI", paradigm: "json-stdio", surfaces: s(true, true, true, false, true, true) },
  { id: "kiro", name: "Kiro", paradigm: "json-stdio", surfaces: s(true, true, false, false, false, true) },
  { id: "kimi", name: "Kimi CLI", paradigm: "json-stdio", surfaces: s(true, true, false, false, false, true) },
  { id: "crush", name: "Crush", paradigm: "json-stdio", surfaces: s(true, true, false, false, false, true) },
  { id: "goose", name: "Goose", paradigm: "json-stdio", surfaces: s(true, true, false, false, false, true) },
  { id: "hermes", name: "Hermes Agent", paradigm: "json-stdio", surfaces: s(true, true, false, false, false, true) },
  { id: "omp", name: "Oh My Pi (OMP)", paradigm: "ts-plugin", surfaces: s(true, true, false, false, false, true) },
  { id: "openclaw", name: "OpenClaw", paradigm: "ts-plugin", surfaces: s(true, true, false, false, false, true) },
];

export const platformCount = platforms.length;
