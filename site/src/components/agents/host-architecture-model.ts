import {
  formFactorLabel,
  formFactorsOf,
  handlerChips,
  hostLinkUrl,
  hostSource,
  surfaceChips,
  surfaceState,
  type FormFactorId,
  type Platform,
  type PlatformSurfaces,
} from "../../data";

type SurfaceRow = {
  key: keyof PlatformSurfaces;
  label: string;
  group: "content" | "runtime";
};

export type HostArchitectureNode = {
  label: string;
  detail: string;
  tone: "entry" | "adapter" | "artifact" | "runtime" | "surface" | "gap";
};

export type HostComponentDiagramNode = {
  id: "host" | "connector" | "adapter" | "artifacts" | "runtime" | "user";
  label: string;
  detail: string;
  tone: HostArchitectureNode["tone"];
};

export type HostSequenceFlowStep = {
  id: "invoke" | "resolve" | "render" | "load" | "operate" | "observe";
  actor: string;
  label: string;
  detail: string;
  tone: HostArchitectureNode["tone"];
};

export type HostArchitectureAxis = {
  title: string;
  body: string;
  bullets?: string[];
};

export type HostArchitectureEvidence = {
  label: string;
  detail: string;
  kind: "external" | "local";
  href?: string;
  path?: string;
};

export type HostFeatureInventoryRow = {
  id: "hooks" | "mcp" | "memory" | "marketplace" | "host-affordances";
  label: string;
  status: string;
  tone: "supported" | "gap" | "native" | "neutral";
  detail: string;
};

export type HostSurfaceProfile = {
  factor: FormFactorId;
  label: string;
  entry: string;
  hostOwns: string;
  connectorRole: string;
  implementationConsequence: string;
};

export type HostSourceReviewNote = {
  checkedAt: string;
  source: string;
  findings: string[];
};

const surfaceRows: SurfaceRow[] = [
  ...surfaceChips.map((chip) => ({
    key: chip.key,
    label: chip.full,
    group: "content" as const,
  })),
  ...handlerChips.map((chip) => ({
    key: chip.key,
    label: chip.full,
    group: "runtime" as const,
  })),
];

export const marketplaceDriverIds = new Set<string>([
  "claude-code",
  "codex",
  "copilot-cli",
  "antigravity-cli",
  "gemini-cli",
  "qwen-code",
  "droid",
  "opencode",
  "antigravity",
  "kilo",
  "kilo-cli",
]);

const formFactorArchitectureCopy = {
  cli: {
    label: "CLI",
    detail:
      "Terminal agent process reads user/project config and invokes the connector home binary for runtime callbacks.",
  },
  desktop: {
    label: "Desktop",
    detail:
      "Desktop or standalone editor app reads global/product storage plus workspace files before handing control to its embedded agent runtime.",
  },
  extension: {
    label: "Extension",
    detail:
      "IDE extension host reads extension global storage and workspace-scoped files while the editor owns activation and UI.",
  },
} satisfies Record<FormFactorId, { label: string; detail: string }>;

const formFactorSurfaceCopy = {
  cli: {
    entry:
      "A terminal command owns the process, current working directory, stdin/stdout, shell environment, and project file discovery.",
    hostOwns:
      "The CLI host owns agent loop timing, approval prompts, tool execution, session files, and how hook or MCP subprocesses are launched.",
    connectorRole:
      "agent-connector can only write the host's documented CLI config, prompt, memory, hook, MCP, or package files and point them at the home binary.",
    implementationConsequence:
      "A CLI surface is byte-addressable and smoke-testable from a temporary HOME, but terminal UI behavior still belongs to the host process.",
  },
  desktop: {
    entry:
      "A desktop app or standalone editor owns window state, sign-in, project indexing, embedded terminal behavior, and local product storage.",
    hostOwns:
      "The desktop host owns orchestration UI, model routing, approval UX, background jobs, and any cloud or app-store managed extension points.",
    connectorRole:
      "agent-connector can write documented workspace/global config and content files, but it does not replace the desktop runtime or UI shell.",
    implementationConsequence:
      "Desktop surfaces need source-review separation because product pages often document capabilities while runtime state lives in app-managed storage.",
  },
  extension: {
    entry:
      "An IDE extension host runs inside VS Code, JetBrains, or another editor and receives workspace/editor context through that host's extension APIs.",
    hostOwns:
      "The editor owns activation, command palette placement, sidebar/chat UI, extension storage, trust prompts, and workspace permission boundaries.",
    connectorRole:
      "agent-connector targets documented extension-readable config, MCP, commands, skills, rules, and memory files without claiming control of the IDE.",
    implementationConsequence:
      "Extension surfaces must distinguish file-backed connector artifacts from UI affordances that only the editor or marketplace extension can expose.",
  },
} satisfies Record<
  FormFactorId,
  {
    entry: string;
    hostOwns: string;
    connectorRole: string;
    implementationConsequence: string;
  }
>;

export const hostArchitectureBriefs: Record<string, string> = {
  codebuddy:
    "CodeBuddy follows the Claude Code family: MCP, hooks, commands, skills, agents, and CODEBUDDY.md memory are file-driven, while its native statusLine key is still a visible adapter gap.",
  "claude-code":
    "Claude Code is the reference rich json-stdio host: settings hooks, MCP servers, slash commands, skills, subagents, memory, plugin-provided MCP, and local plugin marketplace all exist as native concepts.",
  codex:
    "Codex CLI is a local terminal agent with MCP, hooks, prompts/skills/subagents, and AGENTS.md memory; statusline and action affordances are intentionally not treated as wired surfaces.",
  cursor:
    "Cursor is a desktop IDE surface backed by local MCP, hooks, rules, commands, skills, and subagent-style configuration; the adapter targets the byte-addressable desktop/editor files rather than a terminal CLI process.",
  "vscode-copilot":
    "VS Code Copilot is an editor-extension host: the UI and activation live inside VS Code, while agent-connector targets the local Copilot-compatible MCP, hooks, skills, commands, subagents, and memory surfaces.",
  "copilot-cli":
    "GitHub Copilot CLI is terminal-native but narrower than Copilot in editors: MCP, hooks, skills, subagents, memory, and marketplace driver support are tracked, while user slash commands remain absent.",
  "gemini-cli":
    "Gemini CLI is a broad json-stdio example with MCP, hooks, commands, skills, subagents, memory, and marketplace delivery; it remains useful as the legacy terminal sibling to Antigravity.",
  warp:
    "Warp is a desktop terminal-agent host with MCP, skills-as-slash-style prompts, memory, and generated actions; lifecycle hooks and true subagents are not confirmed native surfaces.",
  opencode:
    "OpenCode is the canonical ts-plugin host: the generated plugin bridge is the hook boundary and the same adapter owns MCP, commands, skills, subagents, and memory artifacts.",
  "mimo-code":
    "MiMoCode follows the OpenCode fork architecture: ts-plugin bridge plus MCP, commands, skills, subagents, and memory until a verified product divergence appears.",
  "kilo-cli":
    "Kilo CLI is an OpenCode-lineage ts-plugin host with all six core content/runtime surfaces wired and a local npm marketplace driver.",
  droid:
    "Factory Droid exposes the full CLI surface set: MCP, hooks, commands, skills, droids-as-subagents, memory, and action affordances.",
  openhands:
    "OpenHands keeps MCP and hooks in separate native files and uses AGENTS.md memory; commands, skills, subagents, statusline, and actions remain outside confirmed writable layouts.",
  kilo:
    "Kilo Code is the VS Code extension sibling of Kilo CLI: it shares the Kilo backend conventions and uses a ts-plugin bridge with MCP, commands, skills, subagents, and memory.",
  cline:
    "Cline is a VS Code extension host centered on extension global storage plus workspace rules/workflows/skills; it is mcp-only from agent-connector's runtime perspective.",
  trae:
    "Trae is a desktop IDE host with MCP, skills, and memory wired; custom agents are host-native but UI/cloud-share driven, so they remain a visible file-surface gap.",
  "antigravity-cli":
    "Antigravity CLI is the terminal surface for Google's Antigravity family with MCP, json-stdio hooks, commands, skills, memory, and statusline wired; subagents are plugin-bundle-only rather than a user file surface.",
  antigravity:
    "Google Antigravity desktop is a json-stdio desktop agent host with MCP, hooks, commands, skills, and memory tracked, while statusline and subagent file surfaces stay separate from the CLI row.",
  zed:
    "Zed is a desktop editor host with MCP, skills, memory, and task-backed actions; hooks, prompt-command files, and subagent authoring are not confirmed for the agent panel.",
  amp:
    "Amp is a ts-plugin host whose .amp plugin lifecycle is the hook boundary; skills and memory are wired, while command prompts and experimental createAgent subagents are treated separately.",
  codebuff:
    "Codebuff is mcp-only for runtime interception but has strong project content: skills, memory, and TypeScript AgentDefinition modules for subagents.",
  mux:
    "Mux is Coder's desktop/web-adjacent agent host with MCP, skills, and memory; no command, hook, or subagent writable surface is currently documented for this adapter.",
  pi:
    "Pi deliberately has no MCP registration surface; its architecture centers on prompt commands, skills, memory, and generated command actions.",
  "jetbrains-copilot":
    "JetBrains Copilot is an IDE-extension host: MCP, json-stdio hooks, commands, skills, and memory are tracked, while subagent, statusline, and action surfaces are not confirmed.",
  "qwen-code":
    "Qwen CLI is one of the broadest json-stdio hosts: MCP, hooks, commands, skills, subagents, memory, and statusline are wired.",
  kiro:
    "Kiro is a desktop IDE/agent host with MCP, hooks, skills, memory, and manual-trigger actions wired; command prompts and writable subagents remain outside the adapter surface.",
  kimi:
    "Kimi CLI wires MCP, hooks, skills, and memory through json-stdio conventions, but command files, subagents, statusline, and actions are not confirmed writable surfaces.",
  crush:
    "Crush is a json-stdio CLI host with MCP, hooks, skills, and memory; commands, subagents, statusline, and actions are intentionally left absent.",
  goose:
    "Goose is a json-stdio CLI host where skills depend on the Summon path; MCP, hooks, skills, and memory are wired, while commands and subagents are not.",
  hermes:
    "Hermes spans CLI and desktop under one adapter id: the architecture emphasizes learning loops, gateway channels, user-scope skills, memory, and actions.",
  omp:
    "Oh My Pi follows Pi lineage but adds a ts-plugin bridge and actions; skills, commands, and subagents are not treated as confirmed writable host surfaces.",
  nemoclaw:
    "NVIDIA NemoClaw wraps OpenClaw and inherits its openclaw.json ts-plugin, MCP, skills, memory, and action behavior while keeping subagents as a host-native config gap.",
  openclaw:
    "OpenClaw is a ts-plugin host with MCP, plugin hooks, skills, memory, and actions; subagents exist as runtime/config concepts rather than an authored folder.",
  "amazon-q":
    "Amazon Q Developer CLI is a json-stdio host with MCP, agent-format hooks, JSON-file subagents, and project rules memory; prompt commands and skills remain unwired.",
  continue:
    "Continue uses YAML MCP configuration, Claude-compatible hooks, and .continue rules memory; commands, skills, subagents, statusline, and actions are outside current adapter coverage.",
  windsurf:
    "Windsurf is a desktop IDE host with MCP, workflows-as-commands, skills, and rules memory; it has no confirmed user-installable lifecycle hook layer.",
  "grok-build":
    "Grok Build is xAI's official Rust CLI agent: MCP in $GROK_HOME/config.toml, Claude-compatible hook JSON under .grok/hooks, commands, skills, agents, and AGENTS.md memory are wired; its native [ui.status_line] command is an adapter gap.",
  "grok-cli":
    "Grok CLI stores MCP and hooks in user settings and reads AGENTS.md-style memory; commands, skills, subagents, statusline, and actions are not confirmed file surfaces.",
  devin:
    "Devin CLI wires MCP, hooks, skills, and rules in first-party config paths; native commands and subagents are documented but remain path-unconfirmed adapter gaps.",
  "open-interpreter":
    "Open Interpreter is tracked as a Codex-derived mcp-only product surface: MCP is wired, while inherited Codex-like hooks/content/memory are treated as unverified host gaps.",
  junie:
    "Junie has MCP and memory wired, with commands, skills, and subagents documented but not yet path-wired; lifecycle hooks are not a confirmed native layer.",
  "mistral-vibe":
    "Mistral Vibe is an mcp-only host with TOML array-of-tables MCP configuration; experimental hooks and content surfaces are not promoted without a stable contract.",
};

export const hostSourceReviewNotes: Record<string, HostSourceReviewNote> = {
  "claude-code": {
    checkedAt: "2026-07-06",
    source: "Claude Code hooks reference",
    findings: [
      "The hook system is a native lifecycle layer, not a generic MCP callback: command, HTTP, prompt, agent, and MCP-tool handlers can be attached to named lifecycle events.",
      "Hook location is scoped: user settings, project settings, local project settings, managed policy, plugin hooks, and component frontmatter are distinct placement surfaces.",
      "The event vocabulary includes session, prompt, tool, subagent, task, compaction, worktree, file, configuration, and MCP elicitation events, which explains why this host is the reference rich json-stdio adapter.",
    ],
  },
  codex: {
    checkedAt: "2026-07-06",
    source: "OpenAI Codex docs and openai/codex repository",
    findings: [
      "The public repository identifies Codex CLI as a local terminal coding agent, while also distinguishing IDE, desktop app, and cloud Codex surfaces from the CLI adapter target.",
      "The repository layout exposes the CLI and Rust implementation roots, matching the adapter's local config/runtime focus rather than a browser-only integration.",
      "Hook behavior remains tied to Codex-specific hook docs and source, so this page treats statusline/actions as absent rather than inferring them from other hosts.",
    ],
  },
  "gemini-cli": {
    checkedAt: "2026-07-06",
    source: "google-gemini/gemini-cli repository",
    findings: [
      "Gemini CLI is explicitly an open-source terminal agent, so the architecture is classified as CLI even though it shares product lineage with Google's desktop Antigravity host.",
      "Its wide adapter surface makes it a useful json-stdio reference beside Claude Code and Codex: MCP, hooks, commands, skills, subagents, memory, and marketplace delivery are all tracked.",
      "The page keeps Gemini CLI separate from Antigravity CLI/Desktop so lifecycle and marketplace claims do not leak across Google host surfaces.",
    ],
  },
  opencode: {
    checkedAt: "2026-07-06",
    source: "anomalyco/opencode repository",
    findings: [
      "OpenCode is treated as the canonical ts-plugin architecture for this project: a generated plugin bridge is the hook boundary instead of a spawned JSON-stdio command.",
      "The source target is open and active, so fork-lineage hosts such as Kilo CLI and MiMoCode can be compared against OpenCode before claiming divergence.",
      "Because the plugin bridge is a runtime integration, marketplace delivery is tracked separately from the hook paradigm.",
    ],
  },
  cursor: {
    checkedAt: "2026-07-06",
    source: "cursor/cursor public tracker",
    findings: [
      "The public repository is a product tracker with download and feature links rather than full product source, so the page classifies Cursor as closed/product-homepage evidence.",
      "Cursor is a desktop IDE/editor surface, not a terminal CLI row, which is why its entry-point diagram starts from Desktop.",
      "Architecture claims should stay conservative: local file surfaces are represented through agent-connector adapter and platform research, while proprietary runtime internals are not inferred.",
    ],
  },
  cline: {
    checkedAt: "2026-07-06",
    source: "cline/cline repository",
    findings: [
      "The repository describes Cline as an autonomous coding agent available as SDK, IDE extension, or CLI assistant, but this adapter row targets the IDE extension surface.",
      "The repo exposes .cline and .clinerules content paths in its root, supporting the page's model of extension storage plus workspace rules/workflows/skills.",
      "No lifecycle hook bridge is claimed for this row; it stays mcp-only from agent-connector's runtime perspective.",
    ],
  },
  kilo: {
    checkedAt: "2026-07-06",
    source: "Kilo-Org/kilocode repository",
    findings: [
      "Kilo is presented as an agentic engineering platform, and the same repository backs both the VS Code extension and Kilo CLI rows.",
      "The extension row is therefore linked to Kilo's shared backend conventions, while form factor metadata keeps it separate from the CLI adapter id.",
      "Because Kilo Code and Kilo CLI share source lineage, marketplace and ts-plugin claims must be scoped to the specific adapter id shown on the page.",
    ],
  },
  windsurf: {
    checkedAt: "2026-07-06",
    source: "Devin Desktop / Windsurf official page",
    findings: [
      "Windsurf is now presented through Devin Desktop branding, so the page treats it as a desktop IDE/product surface rather than an open product repository.",
      "The adapter's architecture stays mcp-only for lifecycle interception: workflows, skills, rules, and MCP can be represented without claiming a user-installable hook layer.",
      "The source link remains an official product destination, while deeper file-path claims must continue to come from adapter evidence and platform research.",
    ],
  },
  zed: {
    checkedAt: "2026-07-06",
    source: "zed-industries/zed repository",
    findings: [
      "Zed is an open-source high-performance editor, so its host row is a desktop editor surface rather than a terminal CLI.",
      "The page models Zed as MCP/content/action capable without claiming a lifecycle hook bridge for the agent panel.",
      "Task-backed actions are tracked as host-only affordances separate from MCP and memory.",
    ],
  },
  kiro: {
    checkedAt: "2026-07-06",
    source: "kirodotdev/Kiro repository",
    findings: [
      "Kiro describes itself as an agentic IDE, matching the desktop form-factor classification.",
      "The adapter treats skills, memory, hooks, MCP, and manual-trigger actions as writable, while command prompt and subagent file surfaces remain outside current coverage.",
      "Because Kiro is open, follow-up passes can inspect repository paths before promoting command or subagent gaps.",
    ],
  },
  hermes: {
    checkedAt: "2026-07-06",
    source: "NousResearch/hermes-agent repository",
    findings: [
      "Hermes is open source and product-described as an agent that grows with the user, so the page keeps its learning-loop identity visible rather than flattening it into a generic CLI.",
      "The same adapter id spans CLI and desktop entry points; the diagram therefore renders CLI + Desktop together.",
      "Gateway channels, user-scope skills, memory, and actions are the important host-only affordance cluster for this row.",
    ],
  },
  "copilot-cli": {
    checkedAt: "2026-07-06",
    source: "github/copilot-cli repository",
    findings: [
      "GitHub Copilot CLI is a terminal-native coding agent, so the architecture page keeps it separate from the VS Code extension row.",
      "The repository states that the CLI uses GitHub workflow context and ships with GitHub's MCP server by default, with custom MCP servers as an extension point.",
      "Action approval is a host-native control surface, but agent-connector should not infer generic lifecycle hooks or subagent folders from that approval model.",
    ],
  },
  "vscode-copilot": {
    checkedAt: "2026-07-06",
    source: "microsoft/vscode-copilot-release repository",
    findings: [
      "The public tracker is archived and deprecated, which makes the row a product/extension evidence surface rather than an implementation source.",
      "The repository scope is VS Code Copilot Chat and completions UX feedback, so this host remains an IDE extension row rather than a CLI row.",
      "Because the public tracker points feedback elsewhere, architecture claims should stay tied to documented extension behavior and local adapter metadata.",
    ],
  },
  warp: {
    checkedAt: "2026-07-06",
    source: "warpdotdev/warp repository",
    findings: [
      "Warp describes itself as an agentic development environment born out of the terminal, so the row is a terminal-centered host with a product shell.",
      "The repository explicitly supports built-in coding agents and bring-your-own CLI agents such as Claude Code, Codex, and Gemini CLI.",
      "Warp's Oz workflows and web-compiled terminal sessions are host-only orchestration affordances, not simple MCP or hook surfaces.",
    ],
  },
  droid: {
    checkedAt: "2026-07-06",
    source: "Factory-AI/factory repository",
    findings: [
      "Factory presents Droid as part of an agent-native development platform across CLI, web, Slack/Teams, Linear/Jira, and mobile.",
      "The repository installation path is a `droid` CLI, while the same ecosystem also advertises a VS Code extension and ACP support for JetBrains and Zed.",
      "Factory exposes SDKs, a GitHub Action, and a plugins marketplace, so Droid's page needs host-only ecosystem notes beyond basic CLI configuration.",
    ],
  },
  openhands: {
    checkedAt: "2026-07-06",
    source: "OpenHands/OpenHands repository",
    findings: [
      "OpenHands Agent Canvas is a self-hosted control center that can run multiple agent backends locally, remotely, or in cloud infrastructure.",
      "The architecture source says Agent Canvas is powered by an Agent Server REST API and can connect to multiple agent servers from one frontend.",
      "Because OpenHands can run third-party agents such as Claude Code, Codex, and Gemini, this row should be treated as an orchestration host, not only a CLI.",
    ],
  },
  "mimo-code": {
    checkedAt: "2026-07-06",
    source: "XiaomiMiMo/MiMo-Code repository",
    findings: [
      "MiMoCode is documented as a terminal-native AI coding assistant that reads and writes code, runs commands, manages Git, and keeps persistent memory.",
      "The repository exposes first-party project and user config paths under `.mimocode` and user config directories, matching a CLI-local architecture.",
      "Multiple agents, persistent memory, checkpoints, task progress, and goal judging are host-native primitives that should remain visible in the archive page.",
    ],
  },
  "kilo-cli": {
    checkedAt: "2026-07-06",
    source: "Kilo-Org/kilocode repository",
    findings: [
      "Kilo CLI shares source lineage with Kilo Code but is a separate adapter id, so the architecture must not collapse CLI and extension rows together.",
      "The CLI row inherits the ts-plugin bridge expectations from the Kilo family while keeping entry point and install target separate from the IDE extension.",
      "Marketplace and plugin statements must be scoped by adapter id because Kilo Code and Kilo CLI expose related but not identical host surfaces.",
    ],
  },
  codebuff: {
    checkedAt: "2026-07-06",
    source: "CodebuffAI/codebuff repository",
    findings: [
      "Codebuff is a terminal coding agent with installable CLI packages, and its free Freebuff variant keeps the same terminal-first usage shape.",
      "The repository describes a multi-agent flow with file picker, planner, editor, and reviewer agents, so subagent support is a host-native concept here.",
      "`knowledge.md` and `.agents/types` are generated by `/init`, which makes memory and custom agent authoring concrete file-backed surfaces.",
    ],
  },
  pi: {
    checkedAt: "2026-07-06",
    source: "earendil-works/pi repository",
    findings: [
      "Pi is an agent harness with an interactive coding agent CLI, an agent runtime package, and a unified multi-provider LLM API.",
      "The repository's package split separates the coding CLI, core runtime, model API, and terminal UI, which explains its mcp-only adapter posture.",
      "Pi explicitly lacks a built-in permission boundary and recommends container or sandbox patterns, so safety claims should remain host-external.",
    ],
  },
  omp: {
    checkedAt: "2026-07-06",
    source: "earendil-works/pi repository",
    findings: [
      "OMP is tracked as a Pi-family plugin surface, so it should reference the Pi harness while keeping its adapter id and ts-plugin flow separate.",
      "The Pi repository exposes `.pi` and package-level runtime folders, giving OMP a concrete local project/user artifact story without inventing a new host.",
      "Because Pi distinguishes CLI, runtime, and TUI packages, OMP's page should describe the plugin bridge rather than flatten it into Pi's CLI row.",
    ],
  },
  "qwen-code": {
    checkedAt: "2026-07-06",
    source: "QwenLM/qwen-code repository",
    findings: [
      "Qwen Code is an open-source terminal AI coding agent with auto-memory, auto-skills, subagents, agent teams, dynamic workflows, and MCP.",
      "The same product line also documents IDE plugins, a desktop app, daemon mode, SDKs, and IM bots, so the CLI row must avoid leaking those surfaces.",
      "The capability table claims hooks and Claude Code parity, making Qwen Code a rich json-stdio host rather than an MCP-only integration.",
    ],
  },
  kimi: {
    checkedAt: "2026-07-06",
    source: "MoonshotAI/kimi-cli repository",
    findings: [
      "Kimi CLI is a terminal AI agent that can read and edit code, execute shell commands, search/fetch web pages, and plan during execution.",
      "It supports ACP as an agent server for compatible IDEs such as Zed and JetBrains, but this adapter row remains the terminal CLI entry point.",
      "MCP is managed through `kimi mcp` and ad-hoc config files, so the page should treat MCP as a first-party CLI management surface.",
    ],
  },
  crush: {
    checkedAt: "2026-07-06",
    source: "charmbracelet/crush repository",
    findings: [
      "Crush is a terminal coding agent with multi-model support, session context, LSP-assisted context, and MCP extensibility.",
      "Configuration is resolved from project and user JSON files, and ephemeral state is stored separately under user data directories.",
      "Crush MCP supports stdio, HTTP, and SSE transports with shell-style expansion, which is a host-specific config behavior the archive should note.",
    ],
  },
  goose: {
    checkedAt: "2026-07-06",
    source: "aaif-goose/goose repository",
    findings: [
      "Goose has moved under the Agentic AI Foundation and is documented as a native open source AI agent with desktop app, CLI, and API surfaces.",
      "The host supports many model providers and connects to a large extension ecosystem through MCP, so the row is broader than a simple CLI wrapper.",
      "Because Goose spans desktop, terminal, and embeddable API usage, its page should emphasize multi-surface architecture and extension routing.",
    ],
  },
  nemoclaw: {
    checkedAt: "2026-07-06",
    source: "NVIDIA/NemoClaw repository",
    findings: [
      "NemoClaw is a reference stack for running agents more safely inside NVIDIA OpenShell sandboxes with managed inference and lifecycle control.",
      "The supported agents list includes OpenClaw and Hermes, which makes NemoClaw a sandbox/orchestration wrapper around other hosts.",
      "Guided onboarding, network policy, hardened blueprints, and lifecycle management are host-only controls beyond MCP, hooks, or memory files.",
    ],
  },
  openclaw: {
    checkedAt: "2026-07-06",
    source: "openclaw/openclaw repository",
    findings: [
      "OpenClaw is a personal AI assistant that runs on a user's own devices and exposes many messaging and collaboration channels.",
      "The repository distinguishes a Gateway control plane from the assistant product, so the page should describe control-plane architecture explicitly.",
      "Voice, live canvas, and multi-channel delivery are host-only affordances that should not be reduced to command or hook support.",
    ],
  },
  "amazon-q": {
    checkedAt: "2026-07-06",
    source: "aws/amazon-q-developer-cli repository",
    findings: [
      "The Amazon Q Developer CLI repository states it is no longer actively maintained except for critical security fixes and points latest usage to Kiro CLI.",
      "The project layout identifies `chat_cli` as the `q` CLI entry point, with Rust crates and technical docs as the implementation structure.",
      "Because the upstream is effectively superseded, adapter coverage should preserve current paths while making future feature claims conservative.",
    ],
  },
  continue: {
    checkedAt: "2026-07-06",
    source: "continuedev/continue repository",
    findings: [
      "Continue is now read-only, but the repository explicitly describes a coding agent available as CLI, VS Code extension, and JetBrains plugin.",
      "The final 2.0.0 release covered the VS Code extension, CLI, and JetBrains plugin, so the archive should show multi-surface heritage.",
      "The repository contains `.continue`, extension, GUI, binary, actions, packages, and skills folders, supporting a file-backed configuration story.",
    ],
  },
  "grok-build": {
    checkedAt: "2026-09-07",
    source: "xai-org/grok-build repository (user guide + xai-grok-hooks event schema)",
    findings: [
      "Grok Build is xAI's official agent (Apache-2.0, binary artifact xai-grok-pager, installed as `grok`), distinct from the community superagent-ai/grok-cli behind the grok-cli adapter id.",
      "Both products default to ~/.grok but never share a file: Grok Build keys on config.toml, Grok CLI on user-settings.json, so each adapter claims the directory only when the sibling's marker is absent.",
      "Hooks fire PascalCase events that map 1:1 to twelve canonical agent-connector events; StopFailure, StopCancelled, and PermissionDenied ride the nativeHooks escape hatch, and PermissionRequest stays unset because PermissionDenied is a post-decision observation.",
    ],
  },
  "grok-cli": {
    checkedAt: "2026-07-06",
    source: "superagent-ai/grok-cli repository",
    findings: [
      "Grok CLI is a community-built terminal coding agent for the Grok API with OpenTUI, headless mode, subagents, schedules, and Telegram remote control.",
      "It documents shell-command hooks with JSON stdin/stdout and lifecycle events such as PreToolUse, UserPromptSubmit, SessionStart, and SubagentStart.",
      "Project settings, AGENTS-style instructions, skills, MCP servers, sandbox mode, and desktop computer subagents are distinct host-only affordances.",
    ],
  },
  "open-interpreter": {
    checkedAt: "2026-07-06",
    source: "openinterpreter/openinterpreter repository",
    findings: [
      "Open Interpreter's current repository describes a new Rust version and identifies itself as a low-cost-model coding agent.",
      "It is a fork of OpenAI Codex focused on harness emulation, which explains why its adapter should avoid assuming unique hook semantics.",
      "The `/harness` selector can emulate native, Claude Code, Kimi CLI, Qwen Code, SWE-agent, and minimal modes, making harness choice the key host surface.",
    ],
  },
  junie: {
    checkedAt: "2026-07-06",
    source: "JetBrains/junie repository",
    findings: [
      "Junie is an LLM-agnostic coding agent by JetBrains that lives in the terminal and integrates with IDE and CI/CD workflows.",
      "The repository provides install paths for shell, PowerShell, Homebrew, and npm, making the CLI entry point concrete for the adapter.",
      "Authentication supports JetBrains account OAuth, Junie API keys, and bring-your-own-key providers, so identity is a host-native integration axis.",
    ],
  },
  mux: {
    checkedAt: "2026-07-06",
    source: "coder/mux repository",
    findings: [
      "Mux is a desktop and browser application for parallel agentic development, not a single terminal agent runtime.",
      "Its features center on isolated workspaces, git divergence views, local/worktree/SSH execution modes, and multi-model agent execution.",
      "The repository includes desktop app, browser, mobile, VS Code, and `.mux` artifacts, so the page should present Mux as an orchestration host.",
    ],
  },
  amp: {
    checkedAt: "2026-07-06",
    source: "Amp official site",
    findings: [
      "Amp presents itself as a frontier coding agent with a CLI that starts agents in the terminal and lets users continue from other surfaces.",
      "The official site highlights plugins that hook into events, add tools, and standardize policy, which maps directly to hook SDK concerns.",
      "Remote Orbs, larger-thread reading, custom agents, and direct diff review are host-only affordances that should be documented separately from MCP.",
    ],
  },
  codebuddy: {
    checkedAt: "2026-07-06",
    source: "CodeBuddy official site",
    findings: [
      "The official page identifies Tencent Cloud Code Assistant CodeBuddy as an AI code editor, so the row stays product-homepage evidence rather than open-source code evidence.",
      "Because the rendered public page exposes little inspectable architecture text, this page should remain conservative about hooks, MCP, memory, and CLI internals.",
      "The adapter still models CodeBuddy as a json-stdio host from local registry data, but source review should call out that public architecture details are thin.",
    ],
  },
  trae: {
    checkedAt: "2026-07-06",
    source: "Trae-AI/TRAE repository",
    findings: [
      "The public repository is explicitly the official GitHub for TRAE, but it is a thin tracker rather than a full source tree for the product runtime.",
      "TRAE should therefore be documented as a product/IDE host with source-light evidence, not as a fully inspectable open-source implementation.",
      "The adapter can describe MCP-only coverage and known product source links, while avoiding unverified claims about file-authored hooks or subagents.",
    ],
  },
  "antigravity-cli": {
    checkedAt: "2026-07-06",
    source: "Google Antigravity official site",
    findings: [
      "Google Antigravity's official site presents a next-generation agent platform with download-first product onboarding and multi-surface use cases.",
      "The CLI adapter row should stay separate from the desktop IDE row because agent-connector installs a command-line integration target here.",
      "Official page evidence supports an agent-platform classification, but hook, MCP, and memory details still need local adapter evidence before expansion.",
    ],
  },
  antigravity: {
    checkedAt: "2026-07-06",
    source: "Google Antigravity official site",
    findings: [
      "The rendered official page describes Antigravity as a next-generation agent platform and exposes editor, terminal, dashboard, repository, and merge-related signals.",
      "This adapter row is the desktop/product surface, so the diagram should not collapse it into the separate Antigravity CLI entry point.",
      "Because the official product page is high-level, page claims should focus on entry point and orchestration shape while leaving hook details to adapter evidence.",
    ],
  },
  "jetbrains-copilot": {
    checkedAt: "2026-07-06",
    source: "GitHub Copilot official product page",
    findings: [
      "GitHub Copilot's official product page positions Copilot across editor and enterprise workflows, with agents, Copilot CLI, and VS Code explicitly called out.",
      "The JetBrains row is therefore an IDE integration surface for Copilot, not the Copilot CLI and not the VS Code Copilot extension row.",
      "Copilot guidance emphasizes developer oversight and review, so agent-connector should avoid treating suggestions as autonomous hook/action execution.",
    ],
  },
  devin: {
    checkedAt: "2026-07-06",
    source: "Devin official site and docs",
    findings: [
      "Devin is documented as an autonomous AI software engineer that can write, run, and test code across engineering tasks and team workflows.",
      "The docs include Devin CLI, MCP Marketplace, knowledge, skills, automations, playbooks, computer use, and handoff to cloud Devins as first-party surfaces.",
      "This row should highlight cloud/team orchestration and CLI handoff behavior, not just local json-stdio installation mechanics.",
    ],
  },
  "mistral-vibe": {
    checkedAt: "2026-07-06",
    source: "mistralai/mistral-vibe repository",
    findings: [
      "Mistral Vibe is an open-source CLI coding assistant with file editing, shell execution, search, todo tracking, interactive questions, and task delegation.",
      "It includes built-in agent profiles, subagents, trusted folder configuration, programmatic mode, and skills-backed custom slash commands.",
      "MCP configuration and skill directories are first-party documented surfaces, so this row should no longer read like an unexpanded mcp-only stub.",
    ],
  },
};

export function hostSourceReviewNote(platform: Platform): HostSourceReviewNote | undefined {
  return hostSourceReviewNotes[platform.id];
}

export function pathForAdapter(platform: Platform) {
  return `src/adapters/${platform.id}/index.ts`;
}

export function hostEntryPoint(platform: Platform) {
  const factors = formFactorsOf(platform.id);
  if (factors.length === 0) return "Unclassified host entrypoint";
  return factors.map((factor) => formFactorArchitectureCopy[factor].label).join(" + ");
}

export function hostEntryPointDetail(platform: Platform) {
  const factors = formFactorsOf(platform.id);
  if (factors.length === 0) return "No form-factor metadata is registered for this adapter.";
  return factors.map((factor) => formFactorArchitectureCopy[factor].detail).join(" ");
}

export function nativeRows(platform: Platform) {
  return surfaceRows.filter((row) => platform.hostNative[row.key]);
}

export function wiredRows(platform: Platform) {
  return surfaceRows.filter((row) => platform.surfaces[row.key]);
}

export function gapRows(platform: Platform) {
  return surfaceRows.filter((row) => surfaceState(platform, row.key) === "host-gap");
}

function listLabels(rows: SurfaceRow[]) {
  return rows.length > 0 ? rows.map((row) => row.label).join(", ") : "none";
}

export function nativeInstallTargets(platform: Platform) {
  const targets: string[] = [];
  if (platform.surfaces.mcp) targets.push("MCP config");
  if (platform.surfaces.hooks) {
    targets.push(platform.paradigm === "ts-plugin" ? "plugin module" : "hook config");
  }
  if (platform.surfaces.commands || platform.surfaces.skills || platform.surfaces.subagents) {
    targets.push("content files");
  }
  if (platform.surfaces.memory) targets.push("memory/rules");
  if (platform.surfaces.statusline) targets.push("statusline");
  if (platform.surfaces.actions) targets.push("actions");
  if (marketplaceDriverIds.has(platform.id)) targets.push("marketplace bundle");
  if (targets.length > 0) {
    return `Adapter writes ${targets.join(" + ")} through this host's native file, package, or marketplace surface.`;
  }
  return "Adapter has no writable install target yet, so this page stays evidence-only until a host-native artifact is confirmed.";
}

export function runtimeBoundary(platform: Platform) {
  if (platform.paradigm === "json-stdio") {
    return platform.surfaces.hooks
      ? "host launches JSON-stdio hook command"
      : "host runtime is not intercepted";
  }
  if (platform.paradigm === "ts-plugin") {
    return "host loads generated TypeScript plugin bridge";
  }
  if (platform.surfaces.mcp) return "host calls MCP tools through its client";
  return "No lifecycle runtime bridge is wired; connector behavior remains limited to static host artifacts.";
}

export function userVisibleSurfaces(platform: Platform) {
  const visible: string[] = [];
  if (platform.surfaces.commands) visible.push("commands");
  if (platform.surfaces.skills) visible.push("skills");
  if (platform.surfaces.subagents) visible.push("subagents");
  if (platform.surfaces.statusline) visible.push("statusline");
  if (platform.surfaces.actions) visible.push("actions");
  if (platform.surfaces.memory) visible.push("memory");
  if (visible.length === 0 && platform.surfaces.mcp) {
    return "Users see the installed connector through host-exposed MCP tools; no separate prompt, memory, or action files are wired.";
  }
  if (visible.length > 0) {
    return `Users see managed ${visible.join(" + ")} surfaces after install; runtime-only surfaces stay behind the host boundary.`;
  }
  return "The adapter proves placement or runtime metadata only; no end-user prompt, memory, or action surface is wired yet.";
}

export function hostSurfaceProfiles(platform: Platform): HostSurfaceProfile[] {
  return formFactorsOf(platform.id).map((factor) => {
    const copy = formFactorSurfaceCopy[factor];
    const wired = listLabels(wiredRows(platform));
    const gaps = gapRows(platform);
    const gapText =
      gaps.length > 0
        ? `Visible host-native gaps for this surface: ${listLabels(gaps)}.`
        : "No visible host-native gap is currently tracked for this surface.";

    return {
      factor,
      label: formFactorLabel[factor],
      entry: copy.entry,
      hostOwns: copy.hostOwns,
      connectorRole: `${copy.connectorRole} Current wired connector surfaces: ${wired}.`,
      implementationConsequence: `${copy.implementationConsequence} ${gapText}`,
    };
  });
}

export function hostCoverageCeiling(platform: Platform) {
  const gaps = gapRows(platform);
  if (gaps.length === 0) return "No visible host-native gap in the current coverage matrix.";
  return `${gaps.map((gap) => gap.label).join(", ")} are host-native but not wired yet.`;
}

export function hostDiagramNodes(platform: Platform): HostArchitectureNode[] {
  return [
    {
      label: `Entry point: ${hostEntryPoint(platform)}`,
      detail: hostEntryPointDetail(platform),
      tone: "entry",
    },
    {
      label: "Connector package",
      detail: "defineConnector package declares server, hooks, content, memory, and actions.",
      tone: "adapter",
    },
    {
      label: `Adapter module: ${platform.id}`,
      detail: `${platform.paradigm} renderer at ${pathForAdapter(platform)}.`,
      tone: "adapter",
    },
    {
      label: "Native host artifacts",
      detail: nativeInstallTargets(platform),
      tone: "artifact",
    },
    {
      label: "Runtime boundary",
      detail: runtimeBoundary(platform),
      tone: "runtime",
    },
    {
      label: "User-visible surface",
      detail: userVisibleSurfaces(platform),
      tone: "surface",
    },
    {
      label: "Coverage ceiling",
      detail: `${wiredRows(platform).length}/${nativeRows(platform).length} native surfaces wired. ${hostCoverageCeiling(platform)}`,
      tone: "gap",
    },
  ];
}

export function hostComponentDiagramNodes(platform: Platform): HostComponentDiagramNode[] {
  return [
    {
      id: "host",
      label: `${platform.name} host`,
      detail: `${hostEntryPoint(platform)} surface owns the model loop, UI shell, config discovery, and native lifecycle for this integration.`,
      tone: "entry",
    },
    {
      id: "connector",
      label: "agent-connector package",
      detail: "Normalizes connector declarations into MCP, hook, memory, content, and action payloads before delegating to a host adapter.",
      tone: "adapter",
    },
    {
      id: "adapter",
      label: `${platform.id} adapter`,
      detail: `Implements the ${platform.paradigm} translation layer in ${pathForAdapter(platform)}.`,
      tone: "adapter",
    },
    {
      id: "artifacts",
      label: "Native artifacts",
      detail: nativeInstallTargets(platform),
      tone: "artifact",
    },
    {
      id: "runtime",
      label: "Runtime bridge",
      detail: runtimeBoundary(platform),
      tone: "runtime",
    },
    {
      id: "user",
      label: "User-visible surface",
      detail: userVisibleSurfaces(platform),
      tone: "surface",
    },
  ];
}

export function hostSequenceFlowSteps(platform: Platform): HostSequenceFlowStep[] {
  return [
    {
      id: "invoke",
      actor: "User / project",
      label: "Choose host adapter",
      detail: `Install or update starts against ${platform.name}; the selected surface is ${hostEntryPoint(platform)}.`,
      tone: "entry",
    },
    {
      id: "resolve",
      actor: "agent-connector",
      label: "Resolve connector declaration",
      detail: `The package reads connector metadata and routes it to the ${platform.id} adapter instead of exposing a generic host contract.`,
      tone: "adapter",
    },
    {
      id: "render",
      actor: `${platform.id} adapter`,
      label: "Render host-native shape",
      detail: nativeInstallTargets(platform),
      tone: "artifact",
    },
    {
      id: "load",
      actor: platform.name,
      label: "Host loads artifacts",
      detail: runtimeBoundary(platform),
      tone: "runtime",
    },
    {
      id: "operate",
      actor: "Agent runtime",
      label: "Run through host boundary",
      detail: userVisibleSurfaces(platform),
      tone: "surface",
    },
    {
      id: "observe",
      actor: "Coverage matrix",
      label: "Expose remaining ceiling",
      detail: `${wiredRows(platform).length}/${nativeRows(platform).length} native surfaces wired. ${hostCoverageCeiling(platform)}`,
      tone: "gap",
    },
  ];
}

export function hostSpecificBrief(platform: Platform) {
  return (
    hostArchitectureBriefs[platform.id] ??
    `Native surfaces: ${listLabels(nativeRows(platform))}. Wired today: ${listLabels(wiredRows(platform))}.`
  );
}

function hookBody(platform: Platform) {
  if (platform.surfaces.hooks) {
    if (platform.paradigm === "ts-plugin") {
      return "Hooks enter through a generated plugin module that the host loads in its own runtime.";
    }
    return "Hooks enter through a host-launched command that exchanges event JSON over stdio.";
  }
  if (platform.hostNative.hooks) {
    return "The host exposes a native hook-like concept, but this adapter keeps it unwired until the exact file/runtime contract is confirmed.";
  }
  return "No user-installable lifecycle hook boundary is confirmed for this host.";
}

function mcpBody(platform: Platform) {
  if (platform.surfaces.mcp) {
    return "The adapter writes this host's native MCP registration dialect, including its root key, scope, transport fields, and environment syntax.";
  }
  if (platform.hostNative.mcp) {
    return "The host has an MCP concept, but this adapter does not write it yet.";
  }
  return "No writable MCP registration surface is tracked for this host.";
}

function memoryBody(platform: Platform) {
  if (platform.surfaces.memory) {
    return "Managed memory text is written into the rules or memory file this host actually reads, with ownership markers for reversible uninstall.";
  }
  if (platform.hostNative.memory) {
    return "The host has a memory/rules concept, but this adapter has not wired its exact file path or format.";
  }
  return "No byte-confirmed memory/rules surface is tracked, so the adapter avoids writing managed context into an inferred file.";
}

function marketplaceBody(platform: Platform) {
  if (marketplaceDriverIds.has(platform.id)) {
    return "A marketplace or plugin-driver path is wired, so install/update/uninstall can be driven rather than only emitted as files.";
  }
  if (platform.paradigm === "ts-plugin") {
    return "The plugin bridge is generated directly, but there is no separate drivable marketplace path in the current driver registry.";
  }
  return "Current install is a direct native-file write path; any package artifact is manual unless a driver is added.";
}

function affordanceBullets(platform: Platform) {
  const gaps = gapRows(platform);
  return [
    `Form factor: ${formFactorsOf(platform.id).map((ff) => formFactorLabel[ff]).join(" + ") || "unclassified"}.`,
    `Native surfaces: ${listLabels(nativeRows(platform))}.`,
    `Wired surfaces: ${listLabels(wiredRows(platform))}.`,
    gaps.length > 0 ? `Visible gaps: ${listLabels(gaps)}.` : "Visible gaps: none.",
  ];
}

export function hostArchitectureAxes(platform: Platform): HostArchitectureAxis[] {
  return [
    {
      title: "Host-specific shape",
      body: hostSpecificBrief(platform),
      bullets: affordanceBullets(platform),
    },
    {
      title: "Hooks",
      body: hookBody(platform),
    },
    {
      title: "MCP",
      body: mcpBody(platform),
    },
    {
      title: "Memory",
      body: memoryBody(platform),
    },
    {
      title: "Marketplace and affordances",
      body: marketplaceBody(platform),
      bullets: [
        `Runtime handlers: ${listLabels(surfaceRows.filter((row) => row.group === "runtime" && platform.surfaces[row.key]))}.`,
        `User-visible affordances: ${userVisibleSurfaces(platform)}.`,
      ],
    },
  ];
}

function featureTone(platform: Platform, key: keyof PlatformSurfaces): HostFeatureInventoryRow["tone"] {
  const state = surfaceState(platform, key);
  if (state === "supported") return "supported";
  if (state === "host-gap") return "gap";
  return "neutral";
}

function featureStatus(platform: Platform, key: keyof PlatformSurfaces) {
  const state = surfaceState(platform, key);
  if (state === "supported") return "Wired";
  if (state === "host-gap") return "Host-native gap";
  return "Not confirmed";
}

function hostAffordanceStatus(platform: Platform): HostFeatureInventoryRow["status"] {
  const affordanceKeys: Array<keyof PlatformSurfaces> = [
    "commands",
    "skills",
    "subagents",
    "statusline",
    "actions",
  ];
  const nativeCount = affordanceKeys.filter((key) => platform.hostNative[key]).length;
  const wiredCount = affordanceKeys.filter((key) => platform.surfaces[key]).length;
  if (nativeCount > 0) return `${wiredCount}/${nativeCount} wired`;
  if (wiredCount > 0) return `${wiredCount} wired`;
  return "Not confirmed";
}

function hostAffordanceTone(platform: Platform): HostFeatureInventoryRow["tone"] {
  const affordanceKeys: Array<keyof PlatformSurfaces> = [
    "commands",
    "skills",
    "subagents",
    "statusline",
    "actions",
  ];
  if (affordanceKeys.some((key) => surfaceState(platform, key) === "host-gap")) {
    return "gap";
  }
  if (affordanceKeys.some((key) => platform.surfaces[key])) return "supported";
  if (affordanceKeys.some((key) => platform.hostNative[key])) return "native";
  return "neutral";
}

function hostAffordanceDetail(platform: Platform) {
  const affordanceKeys: Array<keyof PlatformSurfaces> = [
    "commands",
    "skills",
    "subagents",
    "statusline",
    "actions",
  ];
  const wired = surfaceRows.filter(
    (row) => affordanceKeys.includes(row.key) && platform.surfaces[row.key],
  );
  const gaps = surfaceRows.filter(
    (row) => affordanceKeys.includes(row.key) && surfaceState(platform, row.key) === "host-gap",
  );
  const absent = surfaceRows.filter(
    (row) => affordanceKeys.includes(row.key) && surfaceState(platform, row.key) === "host-na",
  );
  return `Wired host affordances: ${listLabels(wired)}. Host-native gaps: ${listLabels(gaps)}. Not confirmed: ${listLabels(absent)}.`;
}

export function hostFeatureInventory(platform: Platform): HostFeatureInventoryRow[] {
  return [
    {
      id: "hooks",
      label: "Lifecycle hooks",
      status: featureStatus(platform, "hooks"),
      tone: featureTone(platform, "hooks"),
      detail: hookBody(platform),
    },
    {
      id: "mcp",
      label: "MCP registration",
      status: featureStatus(platform, "mcp"),
      tone: featureTone(platform, "mcp"),
      detail: mcpBody(platform),
    },
    {
      id: "memory",
      label: "Memory and rules",
      status: featureStatus(platform, "memory"),
      tone: featureTone(platform, "memory"),
      detail: memoryBody(platform),
    },
    {
      id: "marketplace",
      label: "Marketplace delivery",
      status: marketplaceDriverIds.has(platform.id)
        ? "Driver wired"
        : platform.paradigm === "ts-plugin"
          ? "Direct plugin"
          : "Direct files",
      tone: marketplaceDriverIds.has(platform.id)
        ? "supported"
        : platform.paradigm === "ts-plugin"
          ? "native"
          : "neutral",
      detail: marketplaceBody(platform),
    },
    {
      id: "host-affordances",
      label: "Host-only affordances",
      status: hostAffordanceStatus(platform),
      tone: hostAffordanceTone(platform),
      detail: hostAffordanceDetail(platform),
    },
  ];
}

export function hostArchitectureEvidence(platform: Platform): HostArchitectureEvidence[] {
  const source = hostSource[platform.id];
  const sourceUrl = hostLinkUrl(platform.id);
  const evidence: HostArchitectureEvidence[] = [];

  if (sourceUrl) {
    evidence.push({
      label: source && "repo" in source ? `Public source: ${source.repo}` : "Product source",
      detail:
        source && "repo" in source
          ? "Primary public repository or product source used for current host status and source links."
          : "Official product homepage or public tracker used when no open product repository is confirmed.",
      kind: "external",
      href: sourceUrl,
    });
  }

  evidence.push(
    {
      label: "Local adapter implementation",
      detail:
        "Defines the install/uninstall behavior, native config rendering, capability flags, and any runtime parse/format bridge for this host.",
      kind: "local",
      path: pathForAdapter(platform),
    },
    {
      label: "Platform metadata and host-native matrix",
      detail:
        "Records the form factor, public source target, ranking source, native host surfaces, and current agent-connector coverage cells.",
      kind: "local",
      path: "site/src/platform-data.ts",
    },
    {
      label: "Architecture drift guard",
      detail:
        "Asserts that every registered host has a page, diagram, host-specific brief, source link, form-factor band, and adapter-aligned surface data.",
      kind: "local",
      path: "tests/docs/platform-drift.test.ts",
    },
  );

  if (marketplaceDriverIds.has(platform.id)) {
    evidence.push({
      label: "Marketplace driver registry",
      detail:
        "Shows this host has a drivable package/plugin install path beyond direct native-file writes.",
      kind: "local",
      path: "src/core/marketplace-drivers/registry.ts",
    });
  }

  return evidence;
}
