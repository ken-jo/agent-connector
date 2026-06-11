import {
  Boxes,
  GitBranch,
  TerminalSquare,
  Sparkles,
  Bot,
  BookOpen,
  type LucideIcon,
} from "lucide-react";

export const REPO_URL = "https://github.com/ken-jo/agent-connector";
export const INSTALL_CMD = "npm install @ken-jo/agent-connector";

/* ------------------------------------------------------------------ */
/* Hook paradigms                                                      */
/* ------------------------------------------------------------------ */

export type ParadigmId = "json-stdio" | "mcp-only" | "ts-plugin";

export interface Paradigm {
  id: ParadigmId;
  label: string;
  short: string;
  description: string;
  /** Tailwind classes for the dot + pill accent. */
  dot: string;
}

export const paradigms: Paradigm[] = [
  {
    id: "json-stdio",
    label: "json-stdio",
    short: "Full hook dispatch",
    description:
      "One universal hook entrypoint reads host JSON over stdio; the adapter normalizes it, your handler runs, the reply is formatted back.",
    dot: "bg-indigo-500",
  },
  {
    id: "mcp-only",
    label: "mcp-only",
    short: "MCP registration only",
    description:
      "No hook layer on these hosts — we install the MCP server (or, on Pi, the skills surface) and detection reports that hooks are unavailable here.",
    dot: "bg-cyan-500",
  },
  {
    id: "ts-plugin",
    label: "ts-plugin",
    short: "Generated bridge module",
    description:
      "The framework generates an exported plugin module that imports your handler — the native shape these hosts expect.",
    dot: "bg-amber-500",
  },
];

/* ------------------------------------------------------------------ */
/* Platforms (29)                                                      */
/* ------------------------------------------------------------------ */

export interface Platform {
  name: string;
  paradigm: ParadigmId;
}

export const platforms: Platform[] = [
  // json-stdio
  { name: "Claude Code", paradigm: "json-stdio" },
  { name: "Codex", paradigm: "json-stdio" },
  { name: "Cursor", paradigm: "json-stdio" },
  { name: "VS Code Copilot", paradigm: "json-stdio" },
  { name: "JetBrains Copilot", paradigm: "json-stdio" },
  { name: "Copilot CLI", paradigm: "json-stdio" },
  { name: "Gemini CLI", paradigm: "json-stdio" },
  { name: "Qwen", paradigm: "json-stdio" },
  { name: "Kiro", paradigm: "json-stdio" },
  { name: "Kimi", paradigm: "json-stdio" },
  { name: "Crush", paradigm: "json-stdio" },
  { name: "Goose", paradigm: "json-stdio" },
  { name: "Hermes", paradigm: "json-stdio" },
  { name: "Antigravity", paradigm: "json-stdio" },
  { name: "Antigravity CLI", paradigm: "json-stdio" },
  { name: "Droid", paradigm: "json-stdio" },
  // mcp-only
  { name: "Warp", paradigm: "mcp-only" },
  { name: "Kilo", paradigm: "mcp-only" },
  { name: "Roo Code", paradigm: "mcp-only" },
  { name: "Trae", paradigm: "mcp-only" },
  { name: "Zed", paradigm: "mcp-only" },
  { name: "Amp", paradigm: "mcp-only" },
  { name: "Codebuff", paradigm: "mcp-only" },
  { name: "Mux", paradigm: "mcp-only" },
  { name: "Pi", paradigm: "mcp-only" },
  // ts-plugin
  { name: "OpenCode", paradigm: "ts-plugin" },
  { name: "Kilo CLI", paradigm: "ts-plugin" },
  { name: "OMP", paradigm: "ts-plugin" },
  { name: "OpenClaw", paradigm: "ts-plugin" },
];

export const platformCount = platforms.length;

/* ------------------------------------------------------------------ */
/* Two pillars                                                         */
/* ------------------------------------------------------------------ */

export interface PillarPoint {
  label: string;
  detail: string;
}

export interface Pillar {
  eyebrow: string;
  title: string;
  summary: string;
  points: PillarPoint[];
}

export const pillars: Pillar[] = [
  {
    eyebrow: "Pillar 01",
    title: "One API → 29 platforms",
    summary:
      "Declare your server, hooks, commands, skills, subagents & memory once with defineConnector. The CLI detects every installed host and renders the right native config in each.",
    points: [
      {
        label: "3 hook paradigms",
        detail:
          "json-stdio · ts-plugin · mcp-only — 12 normalized lifecycle events, degrading gracefully per host.",
      },
      {
        label: "install · upgrade · uninstall · doctor",
        detail: "Idempotent, reversible, and --dry-run-able everywhere.",
      },
      {
        label: "Per-host escape hatches",
        detail:
          "platforms[host] extra · nativeHooks · configPatch — verbatim config merges, host-native hook events, and ownership-tracked, reversible settings keys (claude-code v1). No fork required.",
      },
      {
        label: "Thin native pointers",
        detail:
          "Every config we write points back to one stable home binary — update once, propagate everywhere.",
      },
    ],
  },
  {
    eyebrow: "Pillar 02",
    title: "Token telemetry, by default",
    summary:
      "No host reports per-tool usage back to an MCP server. agent-connector measures your server's own bytes and tokenizes them locally — the metric MCP devs actually want.",
    points: [
      {
        label: "Three origin-labeled leaderboards",
        detail:
          "A plugin/MCP board (which tool costs the most tokens), a user/host board, and an opt-in host-native turns board — never summed across origins.",
      },
      {
        label: "Platform-independent",
        detail:
          "Measured identically across all hosts from the server's own I/O — not host-billed usage.",
      },
      {
        label: "Local-first, opt-out",
        detail:
          "Aggregate counts only, stored locally, zero egress by default. AGENT_CONNECTOR_TELEMETRY=0.",
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Six surfaces                                                        */
/* ------------------------------------------------------------------ */

export interface Surface {
  name: string;
  description: string;
  icon: LucideIcon;
}

export const surfaces: Surface[] = [
  {
    name: "MCP servers",
    description: "Transport-polymorphic server descriptors, rendered into each dialect.",
    icon: Boxes,
  },
  {
    name: "Hooks",
    description:
      "12 normalized lifecycle events synthesized per paradigm, plus a nativeHooks passthrough — every Claude Code hook event (all 30) is expressible, and future events need no release.",
    icon: GitBranch,
  },
  {
    name: "Commands",
    description: "Author once; install native commands across hosts that support them.",
    icon: TerminalSquare,
  },
  {
    name: "Skills",
    description: "Portable skill definitions deployed to skill-aware platforms.",
    icon: Sparkles,
  },
  {
    name: "Subagents",
    description: "Specialized agents shipped natively wherever the host allows.",
    icon: Bot,
  },
  {
    name: "Memory",
    description:
      "Write guidance once — it lands in the standard AGENTS.md on 27 of 29 hosts as reversible managed blocks (CLAUDE.md / GEMINI.md natively on the rest).",
    icon: BookOpen,
  },
];

/* ------------------------------------------------------------------ */
/* CLI commands                                                        */
/* ------------------------------------------------------------------ */

export const cliCommands: { cmd: string; purpose: string }[] = [
  { cmd: "detect", purpose: "List installed platforms, scopes, capabilities & paradigm." },
  { cmd: "install", purpose: "Render + write MCP + hooks across detected targets; user-edited managed blocks are left alone unless --force (backs the file up first)." },
  { cmd: "uninstall", purpose: "Full inverse — removes everything we wrote." },
  { cmd: "upgrade", purpose: "Bring all current: re-render config, heal pointers, managed update (alias: update, sync)." },
  { cmd: "package", purpose: "One connector → 9 marketplace/extension formats via --format all, plus opt-in official mcp-server-json / mcpb artifacts." },
  { cmd: "doctor", purpose: "Per-platform health checks; --probe runs a live MCP handshake." },
  { cmd: "status", purpose: "Light install-state: which connectors are present on which hosts (exits 0)." },
  { cmd: "telemetry", purpose: "Per-tool token footprint, input/output split." },
  { cmd: "usage", purpose: "Whole-conversation token totals per agent CLI / model / project / session — no connector needed." },
  { cmd: "leaderboard", purpose: "Ranked MCP/plugin, host/user, and opt-in host-native turn boards — never summed across origins." },
];

/* ------------------------------------------------------------------ */
/* Write once → N dialects                                             */
/* ------------------------------------------------------------------ */

export interface DialectSnippet {
  id: string;
  label: string;
  language: string;
  filename: string;
  code: string;
}

const defineConnectorSource = `import { defineConnector } from "@ken-jo/agent-connector";

export default defineConnector({
  id: "acme-db",
  server: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@acme/db-mcp"],
    env: { ACME_DB_DSN: "\${env:ACME_DB_DSN}" },
  },
  hooks: {
    PreToolUse: {
      matcher: "acme_write",
      async handler(evt) {
        return evt.toolName === "acme_write"
          ? { decision: "ask", reason: "Confirm write" }
          : { decision: "allow" };
      },
    },
  },
  // telemetry is on by default
});`;

const claudeCodeJson = `// ~/.claude.json
{
  "mcpServers": {
    "acme-db": {
      "command": "npx",
      "args": ["-y", "@acme/db-mcp"],
      "env": { "ACME_DB_DSN": "\${env:ACME_DB_DSN}" }
    }
  }
}
// + hooks registered in ~/.claude/settings.json`;

const codexToml = `# ~/.codex/config.toml
[mcp_servers.acme-db]
command = "npx"
args = ["-y", "@acme/db-mcp"]

[mcp_servers.acme-db.env]
ACME_DB_DSN = "\${env:ACME_DB_DSN}"

# + hooks registered in ~/.codex/hooks.json`;

const cursorJson = `// ~/.cursor/mcp.json
{
  "mcpServers": {
    "acme-db": {
      "command": "npx",
      "args": ["-y", "@acme/db-mcp"],
      "env": { "ACME_DB_DSN": "\${env:ACME_DB_DSN}" }
    }
  }
}
// + hooks registered in ~/.cursor/hooks.json`;

export const dialectSource: DialectSnippet = {
  id: "source",
  label: "defineConnector",
  language: "ts",
  filename: "agent-connector.config.mjs",
  code: defineConnectorSource,
};

export const dialectSnippets: DialectSnippet[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    language: "json",
    filename: "~/.claude.json",
    code: claudeCodeJson,
  },
  {
    id: "codex",
    label: "Codex",
    language: "toml",
    filename: "~/.codex/config.toml",
    code: codexToml,
  },
  {
    id: "cursor",
    label: "Cursor",
    language: "json",
    filename: "~/.cursor/mcp.json",
    code: cursorJson,
  },
];

/* ------------------------------------------------------------------ */
/* Telemetry leaderboards (mock CLI output)                           */
/* ------------------------------------------------------------------ */

export interface LeaderRow {
  rank: number;
  name: string;
  calls: string;
  tokens: string;
  confidence: "exact" | "approx" | "heuristic";
}

export const mcpLeaderboard: LeaderRow[] = [
  { rank: 1, name: "acme-db", calls: "12.4k", tokens: "4.81M", confidence: "exact" },
  { rank: 2, name: "weather", calls: "3.1k", tokens: "0.92M", confidence: "exact" },
  { rank: 3, name: "github", calls: "2.7k", tokens: "0.74M", confidence: "approx" },
  { rank: 4, name: "filesystem", calls: "5.9k", tokens: "0.41M", confidence: "exact" },
  { rank: 5, name: "playwright", calls: "0.8k", tokens: "0.33M", confidence: "heuristic" },
];

export const hostLeaderboard: LeaderRow[] = [
  { rank: 1, name: "claude-code @ macbook", calls: "18.2k", tokens: "5.10M", confidence: "exact" },
  { rank: 2, name: "cursor @ macbook", calls: "4.4k", tokens: "1.12M", confidence: "approx" },
  { rank: 3, name: "codex @ devbox", calls: "2.1k", tokens: "0.66M", confidence: "exact" },
];

/* ------------------------------------------------------------------ */
/* How it works                                                       */
/* ------------------------------------------------------------------ */

export interface HowItWorksStep {
  title: string;
  detail: string;
}

export const howItWorks: HowItWorksStep[] = [
  {
    title: "One home binary",
    detail:
      "The runtime installs once under ~/.agent-connector (override AGENT_CONNECTOR_DATA_DIR).",
  },
  {
    title: "Thin native pointers",
    detail:
      "Every platform config is a pointer back to that single binary — never relocating a host's own files.",
  },
  {
    title: "Per-project data",
    detail:
      "Telemetry is keyed by stable project identity (git remote or normalized path), surviving git clean.",
  },
  {
    title: "Managed upgrade",
    detail:
      "agent-connector upgrade refreshes the one binary pointer — explicit, never silent. One bad release can't break everything.",
  },
  {
    title: "Windows-safe",
    detail:
      "No symlinks, no POSIX-only assumptions. Per-OS home resolution and safe spawn/quoting helpers.",
  },
];
