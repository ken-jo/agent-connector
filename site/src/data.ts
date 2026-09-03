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
export const BRANDED_INSTALL_CMD = "npx @acme/acme-db-mcp install";

/* ------------------------------------------------------------------ */
/* Hook paradigms                                                      */
/* ------------------------------------------------------------------ */

import type { ParadigmId } from "./platform-data";

export type { ParadigmId };

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
/* Platforms — single-sourced in ./platform-data (registry order,       */
/* per-host surface profiles, drift-tested against the adapters).       */
/* ------------------------------------------------------------------ */

export {
  platforms,
  platformCount,
  surfaceChips,
  surfaceState,
  handlerChips,
  familyOf,
  familyKey,
  byParadigmFamilyName,
} from "./platform-data";
export type { Platform, PlatformSurfaces, SurfaceChip, SurfaceState } from "./platform-data";

/* ------------------------------------------------------------------ */
/* Form factor — how you run the agent (CLI / IDE extension / app),    */
/* orthogonal to the hook paradigm. The wall groups by this; paradigm  */
/* stays the dot color. Single-sourced + drift-tested in platform-data.*/
/* ------------------------------------------------------------------ */

export {
  formFactorIds,
  formFactorOf,
  formFactorShort,
} from "./platform-data";
export type { FormFactorId } from "./platform-data";

/* ------------------------------------------------------------------ */
/* Coverage rank tiers — closed=Frontier, else GitHub-stars tier.      */
/* ------------------------------------------------------------------ */

export {
  hostSource,
  brandColor,
  promotedFrontierOssIds,
  STAR_TIERS,
  starTier,
  tierOf,
  coverageRepos,
  hostLinks,
  hostLinkUrl,
  formatStars,
  agentPluginSupport,
  agentPluginBadge,
  agentPluginStateOf,
  hostLifecycle,
  hostLifecycleOf,
  majorVendorOssIds,
  isPublicCoverageHost,
  PUBLIC_INDEPENDENT_STAR_FLOOR,
} from "./platform-data";
export type {
  HostSource,
  StarTier,
  CoverageTier,
  HostLink,
  AgentPluginState,
  HostLifecycle,
} from "./platform-data";

import type { FormFactorId } from "./platform-data";

export interface FormFactor {
  id: FormFactorId;
  label: string;
  short: string;
}

export const formFactors: FormFactor[] = [
  { id: "cli", label: "CLI", short: "terminal agent CLIs" },
  { id: "extension", label: "IDE extension", short: "runs inside an editor" },
  { id: "app", label: "App / IDE", short: "standalone GUI app" },
];

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
    title: "One API → every covered host",
    summary:
      "Declare your server, hooks, commands, skills, subagents & memory once with defineConnector. Your branded package/bin detects every installed host and renders the right native config in each.",
    points: [
      {
        label: "3 hook paradigms",
        detail:
          "json-stdio · ts-plugin · mcp-only — 13 normalized lifecycle events, degrading gracefully per host.",
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
      "13 normalized lifecycle events synthesized per paradigm, plus a nativeHooks passthrough — every Claude Code hook event is expressible, and future events need no release.",
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
      "Write guidance once — it lands in the memory or rules file each host actually reads, with reversible managed blocks and host-native exception paths.",
    icon: BookOpen,
  },
];

/* ------------------------------------------------------------------ */
/* CLI commands                                                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Two install methods (direct + marketplace)                          */
/* ------------------------------------------------------------------ */

export interface InstallMethod {
  id: string;
  flag: string;
  title: string;
  summary: string;
  scope: string;
}

/**
 * The two delivery methods `install` supports. Marketplace is now an officially
 * supported, end-to-end-driven path for the catalog/plugin hosts (claude-code,
 * codex, agy/Antigravity) — live-verified on Linux AND native Windows — not just
 * a bundle the user installs by hand.
 */
export const installMethods: InstallMethod[] = [
  {
    id: "direct",
    flag: "--method direct",
    title: "Direct config-write",
    summary:
      "Writes each host's native MCP + hook/plugin config in place — idempotent, reversible, no submission or review.",
    scope: "Every covered host",
  },
  {
    id: "marketplace",
    flag: "--method marketplace",
    title: "Marketplace / plugin flow",
    summary:
      "Drives the host's OWN plugin install end-to-end — stage the bundle, register a local marketplace where the host has one, run its install verb. Double-install-guarded; doctor-checked. Other marketplace formats print exact manual commands.",
    scope:
      "Drives 11 hosts: Claude Code · Codex · GitHub Copilot CLI · OpenCode · Kilo (CLI + ext) · Antigravity (CLI + IDE) live-verified, + Droid · Qwen Code driver shipped, + Gemini CLI (legacy — sunsetting toward Antigravity)",
  },
];

export const cliCommands: { cmd: string; purpose: string }[] = [
  { cmd: "detect", purpose: "List installed platforms, scopes, capabilities & paradigm." },
  { cmd: "install", purpose: "Render + write MCP + hooks across detected targets (--method direct), OR drive the host's own marketplace/plugin flow for 11 hosts incl. Claude Code, Codex, GitHub Copilot CLI, Gemini CLI, OpenCode, Kilo, Antigravity, Droid & Qwen (--method marketplace); user-edited managed blocks are left alone unless --force (backs the file up first)." },
  { cmd: "uninstall", purpose: "Full inverse — removes everything we wrote." },
  { cmd: "upgrade", purpose: "Bring all current: re-render config, heal pointers, managed update (alias: update, sync)." },
  { cmd: "package", purpose: "One connector → 9 host formats via --format all (default agent-plugin, the portable Agent Plugins 1.0.0 bundle), plus opt-in official mcp-server-json / mcpb artifacts." },
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

const defineConnectorSource = `import { defineConnector } from "@ken-jo/agent-connector/sdk";

export default defineConnector({
  // package.json name/mcpName/bin/version provide the public identity.
  // Omit id/displayName/version unless you need a deliberate override.
  server: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@acme/acme-db-mcp"],
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
      "args": ["-y", "@acme/acme-db-mcp"],
      "env": { "ACME_DB_DSN": "\${env:ACME_DB_DSN}" }
    }
  }
}
// + hooks registered in ~/.claude/settings.json`;

const codexToml = `# ~/.codex/config.toml
[mcp_servers.acme-db]
command = "npx"
args = ["-y", "@acme/acme-db-mcp"]

[mcp_servers.acme-db.env]
ACME_DB_DSN = "\${env:ACME_DB_DSN}"

# + hooks registered in ~/.codex/hooks.json`;

const cursorJson = `// ~/.cursor/mcp.json
{
  "mcpServers": {
    "acme-db": {
      "command": "npx",
      "args": ["-y", "@acme/acme-db-mcp"],
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
