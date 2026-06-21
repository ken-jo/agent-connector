/**
 * adapters/registry — single source of truth for the platforms agent-connector
 * targets. Generalized from context-mode's `ADAPTER_REGISTRY` pattern, adapted
 * to our `Adapter` / `AdapterFactory` contract (adapters/spi.ts).
 *
 * In context-mode the same platform set was redeclared in four places (env-var
 * detection, session-dir lookup, the lazy adapter loader, and per-adapter base
 * constructors); adding a platform meant editing all of them and missing one
 * was silent. Here the list lives ONCE below: each platform is one entry with a
 * lazy `load()` thunk that resolves the adapter singleton. Adding a platform is
 * a single new entry — `getFactory` / `loadAdapter` / `allAdapters` and the
 * detection cascade in detect.ts all derive from this list.
 *
 * `load()` returns the module's default export, which every adapter file is
 * required to provide as its singleton (`export default adapter;`). It is a
 * function (not an eager import) so module loading stays lazy: an adapter is
 * only imported when it is actually needed, keeping startup cheap.
 *
 * Order is load-bearing for runtime host detection (detect.ts iterates env
 * markers in registry order): forks MUST precede their parent so a session
 * running inside a derived shell is not misclassified as the parent. For the
 * three Phase-1 adapters this is moot, but the ordering convention is fixed now
 * so later additions (cursor is a VS Code fork, etc.) slot in correctly.
 */

import type { PlatformId } from "../core/types.js";
import type { Adapter, AdapterFactory } from "./spi.js";

/**
 * Authoritative list of installable platforms. One entry per platform; the
 * `load` thunk lazily imports the adapter module and returns its default-export
 * singleton. To add a platform: drop its `src/adapters/<id>/index.ts` in place
 * (default-exporting an `Adapter`) and add one entry here.
 */
export const ADAPTER_REGISTRY: readonly AdapterFactory[] = [
  // codebuddy (Tencent CodeBuddy) is a Claude Code fork that ALSO exports
  // CLAUDE_SESSION_ID at runtime (its bundle sets both CODEBUDDY_SESSION_ID and
  // CLAUDE_SESSION_ID), so it must precede claude-code: the fork's exclusive
  // runtime markers are checked first during host detection (fork-before-parent).
  {
    id: "codebuddy",
    load: () => import("./codebuddy/index.js").then((m) => m.default),
  },
  {
    id: "claude-code",
    load: () => import("./claude-code/index.js").then((m) => m.default),
  },
  {
    id: "codex",
    load: () => import("./codex/index.js").then((m) => m.default),
  },
  {
    id: "cursor",
    load: () => import("./cursor/index.js").then((m) => m.default),
  },
  // vscode-copilot after cursor: cursor is a VS Code fork, so the fork's runtime
  // markers must be checked first during host detection.
  {
    id: "vscode-copilot",
    load: () => import("./vscode-copilot/index.js").then((m) => m.default),
  },
  {
    id: "copilot-cli",
    load: () => import("./copilot-cli/index.js").then((m) => m.default),
  },
  {
    id: "gemini-cli",
    load: () => import("./gemini-cli/index.js").then((m) => m.default),
  },
  {
    id: "warp",
    load: () => import("./warp/index.js").then((m) => m.default),
  },
  // ts-plugin paradigm: OpenCode loads a generated plugin module that bridges
  // its in-process events to the universal hook entrypoint.
  {
    id: "opencode",
    load: () => import("./opencode/index.js").then((m) => m.default),
  },
  // mimo-code is Xiaomi's MiMoCode (@mimo-ai/cli, bin `mimo`) — an OpenCode FORK
  // (ts-plugin, MCP root key "mcp", ~/.config/mimocode/mimocode.json). Grouped
  // beside the OpenCode family whose config dialect + plugin contract it shares;
  // detected via the DISTINCT ~/.config/mimocode dir, so there is no fork-ordering
  // constraint vs opencode (no shared config file to disambiguate).
  {
    id: "mimo-code",
    load: () => import("./mimo-code/index.js").then((m) => m.default),
  },
  // kilo-cli is the SQLite-backed OpenCode FORK command-line product (ts-plugin,
  // loads @kilocode/plugin modules registered in kilo.jsonc's "plugin" array;
  // MCP root key "mcp", ~/.config/kilo/kilo.jsonc). Grouped beside the OpenCode
  // family whose plugin contract + config dialect it shares; distinct host from
  // the "kilo" extension so there is no fork-ordering constraint between them.
  {
    id: "kilo-cli",
    load: () => import("./kilo-cli/index.js").then((m) => m.default),
  },
  // Wave 1 — mcp-only adapters (no lifecycle hooks; MCP registration only).
  {
    id: "droid",
    load: () => import("./droid/index.js").then((m) => m.default),
  },
  // openhands is the All-Hands-AI OpenHands CLI (`openhands`, ex-OpenDevin) —
  // a standalone json-stdio host: MCP at ~/.openhands/mcp.json ("mcpServers",
  // FastMCP entry shape) + a SEPARATE .openhands/hooks.json carrying the
  // Claude-Code-plugin-compatible nested-rule hooks (6 events). Its persistence
  // dir (~/.openhands) is distinct, so there is no fork-ordering constraint.
  {
    id: "openhands",
    load: () => import("./openhands/index.js").then((m) => m.default),
  },
  {
    id: "roo-code",
    load: () => import("./roo-code/index.js").then((m) => m.default),
  },
  // kilo is the Kilo Code VS Code extension (kilocode.kilo-code) — a Roo/Cline
  // fork, so it sits beside roo-code (mcp-only, root key "mcpServers", VS Code
  // globalStorage / .kilocode project scope). Distinct host from "kilo-cli".
  {
    id: "kilo",
    load: () => import("./kilo/index.js").then((m) => m.default),
  },
  // cline is the Cline VS Code extension (saoudrizwan.claude-dev) — the most-
  // installed AI coding extension and the PARENT that roo-code and kilo forked.
  // mcp-only (no hook layer); MCP at the globalStorage cline_mcp_settings.json
  // ("mcpServers"); content lives in the .clinerules tree + ~/Documents/Cline.
  // NO runtime-marker collision with roo-code (rooveterinaryinc.roo-cline / .roo)
  // or kilo (kilocode.kilo-code / .kilo) — distinct ext ids + dotdirs — so there
  // is NO fork-before-parent ordering constraint here; it simply sits beside them.
  {
    id: "cline",
    load: () => import("./cline/index.js").then((m) => m.default),
  },
  {
    id: "trae",
    load: () => import("./trae/index.js").then((m) => m.default),
  },
  // antigravity-cli BEFORE antigravity: the `agy` CLI is a fork of the IDE
  // adapter with its own runtime markers (the universal hook command tags the
  // host as "antigravity-cli"), so the more-specific CLI marker must be checked
  // before the IDE/parent during host detection.
  {
    id: "antigravity-cli",
    load: () => import("./antigravity-cli/index.js").then((m) => m.default),
  },
  {
    id: "antigravity",
    load: () => import("./antigravity/index.js").then((m) => m.default),
  },
  {
    id: "zed",
    load: () => import("./zed/index.js").then((m) => m.default),
  },
  {
    id: "amp",
    load: () => import("./amp/index.js").then((m) => m.default),
  },
  {
    id: "codebuff",
    load: () => import("./codebuff/index.js").then((m) => m.default),
  },
  {
    id: "mux",
    load: () => import("./mux/index.js").then((m) => m.default),
  },
  // Pi — mcp-only host with no writable MCP config; drives the Agent Skills
  // surface only (writes <piDir>/skills/<name>/SKILL.md).
  {
    id: "pi",
    load: () => import("./pi/index.js").then((m) => m.default),
  },
  // Wave 2 — json-stdio adapters (full hook dispatch via the universal entrypoint).
  // jetbrains-copilot before vscode-copilot is unnecessary (distinct hosts); grouped here.
  {
    id: "jetbrains-copilot",
    load: () => import("./jetbrains-copilot/index.js").then((m) => m.default),
  },
  {
    id: "qwen-code",
    load: () => import("./qwen-code/index.js").then((m) => m.default),
  },
  {
    id: "kiro",
    load: () => import("./kiro/index.js").then((m) => m.default),
  },
  {
    id: "kimi",
    load: () => import("./kimi/index.js").then((m) => m.default),
  },
  {
    id: "crush",
    load: () => import("./crush/index.js").then((m) => m.default),
  },
  // Wave 3 — json-stdio adapters with YAML config (MCP in YAML; hooks per host).
  {
    id: "goose",
    load: () => import("./goose/index.js").then((m) => m.default),
  },
  {
    id: "hermes",
    load: () => import("./hermes/index.js").then((m) => m.default),
  },
  // Wave 4 — ts-plugin adapters (generate a bridge module to the universal entrypoint).
  {
    id: "omp",
    load: () => import("./omp/index.js").then((m) => m.default),
  },
  // nemoclaw BEFORE openclaw (fork-before-parent convention). NVIDIA NemoClaw
  // wraps OpenClaw and DRIVES the SAME ~/.openclaw/openclaw.json, so a NemoClaw
  // box carries BOTH the ~/.nemoclaw/ and ~/.openclaw/ markers. Exclusivity is
  // enforced at the SOURCE: OpenClawAdapter.detectInstalled BOWS OUT when
  // ~/.nemoclaw/ is present, so the shared config is never double-targeted as two
  // platforms. This ordering is the deterministic tie-break (matching the
  // antigravity-cli/antigravity precedent). nemoclaw extends OpenClawAdapter
  // (id/name/detection overridden), so inherited server/hook registration still
  // lands in the wrapped openclaw.json.
  {
    id: "nemoclaw",
    load: () => import("./nemoclaw/index.js").then((m) => m.default),
  },
  {
    id: "openclaw",
    load: () => import("./openclaw/index.js").then((m) => m.default),
  },
  // Wave 5 — mcp-only: Amazon Q Developer CLI. JSON MCP config under ~/.aws/amazonq/
  // (user) and .amazonq/ (project); root key "mcpServers"; bare stdio entry
  // { command, args, env, timeout? } or remote entry { type: "http", url } (no
  // headers) for http. The agent-format hooks layer (cli-agents/*.json) +
  // agents/prompts content surfaces are separate, not-yet-wired surfaces; this
  // adapter installs MCP entries + the .amazonq/rules memory surface.
  {
    id: "amazon-q",
    load: () => import("./amazon-q/index.js").then((m) => m.default),
  },
  // Continue (the `cn` terminal agent / Continue.dev, npm @continuedev/cli) —
  // json-stdio (Claude-compatible hooks). MCP config is YAML at ~/.continue/config.yaml (user) and
  // <projectDir>/.continue/config.yaml (project); root key "mcpServers" is a
  // YAML ARRAY of { name, command, type?, args?, env?, cwd?, url } entries (NOT a
  // keyed map). Hooks: a Claude-compatible json-stdio layer in settings.json
  // (~/.continue/settings.json — separate from the MCP config.yaml; PR #11029) +
  // nativeHooks for the host-specific events. Distinct ~/.continue marker — no
  // fork-ordering constraint vs any sibling.
  {
    id: "continue",
    load: () => import("./continue/index.js").then((m) => m.default),
  },
  // Windsurf (Codeium / Cognition's Cascade agent) — mcp-only. USER/GLOBAL scope
  // ONLY: MCP config is JSON at ~/.codeium/windsurf/mcp_config.json (the docs
  // document no project/workspace path), root key "mcpServers" is a Claude-
  // Desktop-style OBJECT map keyed by server name (like cursor). stdio entry
  // { command, args?, env? }; remote entry { serverUrl, headers? } (NOT `url`;
  // no type/disabled). No user-installable hook/plugin layer (GUI editor), so it
  // stays mcp-only paradigm — but content surfaces ARE wired: workflows
  // (.windsurf/workflows + ~/.codeium/windsurf/global_workflows), skills
  // (.windsurf/skills + ~/.codeium/windsurf/skills), and the .windsurf/rules
  // memory surface. Distinct ~/.codeium marker — no fork-ordering constraint.
  {
    id: "windsurf",
    load: () => import("./windsurf/index.js").then((m) => m.default),
  },
  // Grok CLI (the community superagent-ai/grok-cli, npm `grok-dev`, bin `grok`,
  // MIT) — json-stdio. Id is `grok-cli` (NOT `grok`) to stay distinct from xAI's
  // separate "Grok Build" product. USER-SCOPE ONLY: both MCP servers (nested
  // `mcp.servers` JSON ARRAY, keyed by `id`) and hooks (top-level `hooks`,
  // Claude nested-rule shape) live in ~/.grok/user-settings.json (project
  // .grok/settings.json holds neither — Grok excludes project hooks for
  // security). Distinct ~/.grok marker — no fork-ordering constraint vs any
  // sibling.
  {
    id: "grok-cli",
    load: () => import("./grok-cli/index.js").then((m) => m.default),
  },
];

/** O(1) lookup index, built once at module-load time. */
const REGISTRY_BY_ID: ReadonlyMap<PlatformId, AdapterFactory> = new Map(
  ADAPTER_REGISTRY.map((factory) => [factory.id, factory] as const),
);

/** Every platform id present in the registry (useful for matrix tests). */
export const REGISTERED_PLATFORM_IDS: ReadonlySet<PlatformId> = new Set(
  ADAPTER_REGISTRY.map((factory) => factory.id),
);

/**
 * Look up the lazy factory for a platform id. Returns `undefined` for ids that
 * are not registered (including `"unknown"` and typos) so callers can fall back
 * deliberately rather than crash.
 */
export function getFactory(id: PlatformId | string): AdapterFactory | undefined {
  return REGISTRY_BY_ID.get(id as PlatformId);
}

/**
 * Resolve a platform id to its adapter singleton. Returns `undefined` when the
 * id is not registered — callers decide whether to skip or fall back.
 */
export async function loadAdapter(id: PlatformId | string): Promise<Adapter | undefined> {
  const factory = getFactory(id);
  return factory ? factory.load() : undefined;
}

/**
 * Load every registered adapter. Imports run in parallel; the result preserves
 * registry order so downstream detection/install logic sees forks before
 * parents.
 */
export async function allAdapters(): Promise<Adapter[]> {
  return Promise.all(ADAPTER_REGISTRY.map((factory) => factory.load()));
}
