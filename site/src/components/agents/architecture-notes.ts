import { hostLinkUrl, platforms, type Platform } from "../../platform-data";
import {
  gapRows,
  hostArchitectureAxes,
  hostCoverageCeiling,
  hostSourceReviewNote,
  hostSpecificBrief,
} from "./host-architecture-model";

export type ArchitectureSource = {
  label: string;
  url: string;
};

export type ArchitectureSection = {
  title: string;
  body: string;
  bullets?: string[];
};

export type AgentArchitectureNote = {
  status: "researched" | "baseline";
  sequence: number;
  checkedAt: string;
  summary: string;
  sources: ArchitectureSource[];
  sections: ArchitectureSection[];
  limits?: string[];
};

export const architectureNotes: Record<string, AgentArchitectureNote> = {
  codex: {
    status: "researched",
    sequence: 3,
    checkedAt: "2026-07-05",
    summary:
      "Codex is a local terminal coding agent with adjacent IDE, desktop app, and cloud surfaces in the OpenAI product family. agent-connector currently targets the CLI adapter because it has a byte-addressable local config, MCP registration, hook files, and content surface directories.",
    sources: [
      {
        label: "OpenAI Codex docs",
        url: "https://developers.openai.com/codex/",
      },
      {
        label: "OpenAI Codex hooks",
        url: "https://developers.openai.com/codex/hooks",
      },
      {
        label: "openai/codex repository",
        url: "https://github.com/openai/codex",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The targeted surface is Codex CLI. The host owns the model loop, local shell/apply_patch/MCP tool execution, permission decisions, and transcript context. agent-connector stays outside that loop and writes the native files Codex already reads.",
        bullets: [
          "User scope resolves through CODEX_HOME or ~/.codex.",
          "Project scope mirrors the same shape under <project>/.codex.",
          "Codex App, IDE extension, and Codex Web are adjacent product surfaces, not this adapter id.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "The adapter renders TOML into config.toml under [mcp_servers.<id>]. Local stdio servers carry command, args, and env values; remote streamable HTTP servers use the Codex URL/header shape. Env references are resolved by agent-connector before writing because Codex does not provide the same native interpolation contract as some other hosts.",
      },
      {
        title: "Hook bridge",
        body:
          "Codex uses a json-stdio hook bridge. The host launches a command, sends a PascalCase event payload on stdin, and receives JSON plus an exit code. agent-connector's hook runtime normalizes that payload, runs the connector handler, then emits Codex's native reply envelope.",
        bullets: [
          "PreToolUse can provide context, deny, or modify supported tool inputs when Codex accepts the updatedInput envelope.",
          "PermissionRequest has its own decision envelope and should not be treated as a normal PreToolUse rewrite point.",
          "PostToolUse output rewriting is not exposed as a wired agent-connector capability here.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Codex has multiple local content surfaces. agent-connector writes prompt commands, skills, subagents, and memory/rules into the paths this adapter can verify, while keeping statusline and actions off because they are not wired for this host today.",
        bullets: [
          "Commands: user-scope prompt files under the Codex prompts directory.",
          "Skills: project .codex/skills plus the shared user skills location.",
          "Subagents: TOML definitions under the Codex agents directory.",
          "Memory: AGENTS.md-style standing guidance through the shared memory surface.",
        ],
      },
      {
        title: "Host-only affordances",
        body:
          "Codex spans CLI, IDE extension, desktop app, web, GitHub, Slack, Linear, app server, SDK, MCP server, skills, plugins, and subagents in the wider product documentation. This adapter page deliberately keeps those adjacent surfaces visible while treating only the CLI file and hook contracts as installed connector surfaces.",
        bullets: [
          "The CLI row should not imply support for Codex App, Codex Web, or IDE extension storage.",
          "OpenAI docs list hooks, AGENTS.md, MCP, plugins, skills, and subagents as configuration topics, so the archive should preserve those as separate study axes.",
          "Automation surfaces such as GitHub Action, App Server, SDK, and MCP Server are adjacent integration channels, not the local adapter target.",
        ],
      },
    ],
    limits: [
      "This page documents the CLI adapter, not Codex Web or the Codex desktop app runtime.",
      "Statusline and action affordances are intentionally shown as not wired until a native Codex surface exists.",
      "Hook behavior should continue to be checked against the current Codex hooks docs and the openai/codex source before changing claims.",
    ],
  },
  "claude-code": {
    status: "researched",
    sequence: 2,
    checkedAt: "2026-07-06",
    summary:
      "Claude Code is the richest CLI reference host in this archive: it is terminal-first, but its native architecture also exposes hooks, MCP scopes, slash commands, plugins, subagents, memory files, and statusline behavior as first-class surfaces.",
    sources: [
      {
        label: "anthropics/claude-code repository",
        url: "https://github.com/anthropics/claude-code",
      },
      {
        label: "Claude Code hooks reference",
        url: "https://code.claude.com/docs/en/hooks",
      },
      {
        label: "Claude Code MCP documentation",
        url: "https://code.claude.com/docs/en/mcp",
      },
      {
        label: "Claude Code subagents documentation",
        url: "https://code.claude.com/docs/en/sub-agents",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the local Claude Code CLI session. Claude Code owns the model loop, tool execution, permissions, and session state; agent-connector installs into the host's native configuration, command, plugin, memory, and agent file surfaces rather than wrapping the whole CLI.",
        bullets: [
          "The public repository describes Claude Code as a terminal agentic coding tool, while also pointing users to IDE and GitHub usage.",
          "Repository-visible `.claude/commands` and `.claude-plugin` paths make content and plugin surfaces concrete instead of only conceptual.",
          "The archive keeps Claude Code as a CLI row because the byte-addressable adapter target is the local command-line host.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Claude Code's MCP surface has local, project, user, plugin-provided, and connector scopes. agent-connector must preserve that scope model instead of treating MCP as a single global JSON file.",
        bullets: [
          "Project-scoped MCP servers are shareable through project-root `.mcp.json`.",
          "User-scoped MCP servers live in `~/.claude.json` and are private to the user account.",
          "Scope precedence matters because duplicate server names are resolved by source priority, not merged field-by-field.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Hooks are Claude Code's primary lifecycle interception layer. Command hooks receive event JSON on stdin, while HTTP, prompt, agent, and MCP-tool handlers expand the same lifecycle model beyond simple shell commands.",
        bullets: [
          "Events span session, prompt, tool, subagent, task, compaction, worktree, file, configuration, and elicitation surfaces.",
          "Hook placement is multi-scope: user settings, project settings, local project settings, managed policy, plugin hooks, and component frontmatter can all matter.",
          "Decision control is event-specific, so adapter claims need to stay tied to event envelopes rather than a generic allow/deny model.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Claude Code content is not one directory. Slash commands, skills, subagents, plugins, and memory each have separate file contracts and precedence rules.",
        bullets: [
          "Subagents are Markdown files with YAML frontmatter in project, user, managed, CLI, or plugin scopes.",
          "Project and user subagents are recursively scanned, while plugin subagents use plugin-scoped identifiers.",
          "Plugin subagents intentionally ignore some powerful frontmatter fields such as hooks, MCP servers, and permission mode.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "Claude Code is a plugin-marketplace shaped host, not just a hook target. Plugin-provided MCP servers, commands, agents, and hooks are distribution surfaces, while statusline remains a host-native CLI affordance.",
        bullets: [
          "agent-connector should model plugin delivery separately from runtime power: installing a plugin can add MCP, commands, agents, or hooks.",
          "Statusline support is host-owned UI state, so it remains separate from hooks and command content in the page inventory.",
        ],
      },
    ],
    limits: [
      "This page describes the local CLI adapter row, not Claude Code on the web or GitHub mention flows.",
      "Claude Code's hook event vocabulary is broad; each new event claim should be checked against the current hooks reference before adapter expansion.",
      "Plugin marketplace behavior should be kept distinct from direct file writes, even when both install similar artifacts.",
    ],
  },
  "gemini-cli": {
    status: "researched",
    sequence: 7,
    checkedAt: "2026-07-06",
    summary:
      "Gemini CLI is an open-source terminal-first agent with built-in tools, MCP extension, custom commands, GEMINI.md context, checkpointing, GitHub automation, and a fast-moving release cadence.",
    sources: [
      {
        label: "google-gemini/gemini-cli repository",
        url: "https://github.com/google-gemini/gemini-cli",
      },
      {
        label: "Gemini CLI documentation",
        url: "https://www.geminicli.com/docs",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the terminal CLI. Gemini CLI owns the interactive session, authentication, built-in tools, model calls, and optional headless scripting; agent-connector writes host-native config and content so Gemini can discover the connector through its existing runtime.",
        bullets: [
          "The public repository identifies Gemini CLI as an open-source agent that brings Gemini directly into the terminal.",
          "The CLI supports interactive use, headless prompts, stream-json output, and GitHub Action workflows.",
          "The archive keeps this separate from Google Antigravity so product-family claims do not leak across adapters.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "MCP is a documented extension path for Gemini CLI. The README points users to `~/.gemini/settings.json` for MCP servers, so adapter writes must preserve Gemini's settings shape rather than reuse another host's TOML or JSON layout.",
        bullets: [
          "MCP extends Gemini CLI with custom integrations beyond built-in file, shell, web fetch, and search tools.",
          "The CLI examples address external systems through named MCP servers, which makes server naming and enablement visible to users.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "agent-connector classifies Gemini CLI as a json-stdio runtime host. The page should therefore describe hook support through the local adapter contract while keeping externally documented Gemini capabilities, such as MCP and headless mode, separate from hook event claims.",
        bullets: [
          "Hook claims must remain adapter-backed because the public README foregrounds tools, MCP, commands, and context files more than lifecycle event schemas.",
          "The host's stream-json mode is useful for automation but is not by itself a lifecycle hook boundary.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Gemini CLI content is centered on GEMINI.md context, custom slash commands, checkpointing, and command-line modes. agent-connector should keep persistent context and command content separate from runtime hooks.",
        bullets: [
          "GEMINI.md is the persistent context file called out by the public docs.",
          "Custom commands and the commands reference are first-class documentation topics.",
          "Checkpointing and token caching are host features that affect session ergonomics, not connector install shape.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "Gemini CLI is open source with npm, Homebrew, preview, stable, and nightly release channels. The connector marketplace path should account for a fast-moving host whose extension and release behavior may shift weekly.",
        bullets: [
          "Built-in Google Search grounding and multimodal file understanding are host-only affordances outside MCP registration.",
          "GitHub Action support is a workflow surface, not the same as the local CLI adapter.",
        ],
      },
    ],
    limits: [
      "This page documents Gemini CLI, not Antigravity CLI or Antigravity desktop.",
      "Lifecycle hook details should be verified against the local adapter and any current Gemini hook documentation before adding event-level claims.",
      "Release-channel information is intentionally treated as host cadence, not as connector compatibility proof.",
    ],
  },
  opencode: {
    status: "researched",
    sequence: 9,
    checkedAt: "2026-07-06",
    summary:
      "OpenCode is the canonical TypeScript-plugin host for agent-connector: it is documented as a terminal, desktop, and IDE-capable open-source agent, but this adapter row focuses on the CLI/plugin file surfaces under OpenCode's JSON config and `.opencode` directories.",
    sources: [
      {
        label: "OpenCode repository",
        url: "https://github.com/anomalyco/opencode",
      },
      {
        label: "OpenCode docs",
        url: "https://opencode.ai/docs",
      },
      {
        label: "OpenCode config docs",
        url: "https://opencode.ai/docs/config",
      },
      {
        label: "OpenCode plugin docs",
        url: "https://opencode.ai/docs/plugins",
      },
      {
        label: "OpenCode agents docs",
        url: "https://opencode.ai/docs/agents",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "OpenCode loads a generated TypeScript plugin bridge rather than spawning a JSON-stdio hook command. The host owns the TUI, server, model provider, tool permissions, and session loop; the bridge maps host plugin events back to the stable agent-connector home binary.",
        bullets: [
          "The public docs describe OpenCode as available through a terminal interface, desktop app, or IDE extension.",
          "agent-connector keeps this adapter row scoped to the CLI/plugin file target so multi-surface product identity does not collapse the host-specific install path.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "OpenCode config explicitly includes MCP servers in the schema. The adapter must render OpenCode's JSON/JSONC config shape and respect config precedence rather than reuse another host's MCP dialect.",
        bullets: [
          "OpenCode config sources include remote, global, custom, project, `.opencode` directories, inline, managed files, and macOS managed preferences.",
          "Later config sources override earlier conflicts while preserving non-conflicting settings, so direct writes need to be scoped carefully.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Plugins are OpenCode's hook boundary. Local JavaScript or TypeScript files under `.opencode/plugins/` or global config plugins can subscribe to events; npm plugins are configured separately and cached by the host.",
        bullets: [
          "Plugin modules export functions that receive project, client, shell, directory, and worktree context.",
          "The plugin docs show event hooks such as tool execution interception, which maps naturally to a TypeScript bridge.",
          "Plugin load order separates global config, project config, global plugins, and project plugins.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "OpenCode's `.opencode` and global config directories include plural subdirectories for agents, commands, plugins, skills, tools, themes, and modes. These are durable host-native content surfaces rather than ad hoc generated files.",
        bullets: [
          "Agent configuration supports role-specific prompt files, model choices, temperatures, and step limits.",
          "OpenCode creates or reads AGENTS.md-style project memory during initialization.",
          "Commands and skills should be documented as content surfaces separate from the plugin hook layer.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "OpenCode can load npm plugin packages and local plugin files, so marketplace delivery and direct generated-plugin writes are both relevant. The adapter should distinguish drivable package install from direct bridge generation.",
        bullets: [
          "npm plugins are installed automatically at startup and cached under the host cache directory.",
          "The host also exposes sharing, web, IDE, GitHub, GitLab, permissions, LSP, and ACP support as product affordances outside the core connector surfaces.",
        ],
      },
    ],
    limits: [
      "This adapter page is about the CLI/plugin integration target even though OpenCode also presents desktop and IDE surfaces.",
      "Plugin event-level claims should track the current OpenCode plugin docs and adapter bridge tests.",
      "Config precedence makes unmanaged overwrites risky; adapter expansion should remain non-clobbering.",
    ],
  },
  cline: {
    status: "researched",
    sequence: 16,
    checkedAt: "2026-07-06",
    summary:
      "Cline is an editor-extension-centered agent row in agent-connector, even though the public project now also describes SDK and CLI assistant surfaces. Its integration shape is MCP and content oriented, with plugin/SDK lifecycle hooks treated as adjacent evidence rather than a wired extension hook surface.",
    sources: [
      {
        label: "cline/cline repository",
        url: "https://github.com/cline/cline",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target remains the IDE extension surface. VS Code owns activation, UI state, workspace trust, extension storage, and the agent panel; agent-connector writes MCP and content artifacts without claiming control of Cline's full SDK or CLI assistant runtime.",
        bullets: [
          "The public repository describes Cline as an autonomous coding agent available as SDK, IDE extension, or CLI assistant.",
          "The archive intentionally keeps this row in the extension band because that is the current adapter target.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Cline treats MCP servers as an extension mechanism for external databases, APIs, cloud infrastructure, and custom tools. agent-connector should therefore model MCP as a first-class extension host surface, not as a fallback.",
        bullets: [
          "The public README points to community servers and custom on-the-fly tool creation.",
          "The CLI can manage servers with `cline mcp`, but this adapter row should not imply the VS Code extension and CLI share the same writable path unless verified.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Cline's SDK/plugin text mentions lifecycle hooks programmatically, but the current agent-connector row is mcp-only from a runtime perspective. That distinction should stay visible so SDK-level hooks are not mistaken for a wired extension-host hook file.",
        bullets: [
          "Programmatic plugin hooks are useful architecture evidence for future SDK support.",
          "No file-authored extension lifecycle hook bridge is promoted by this page without an adapter path and runtime contract.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Cline content is extension/workspace oriented: rules, workflows, skills, and command-like content belong to the editor context rather than a terminal-only dot directory.",
        bullets: [
          "The adapter should keep global extension storage separate from project files.",
          "Rules and skills are memory/content surfaces; they do not prove lifecycle interception.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "Cline's public architecture now includes plugins, MCP servers, multi-agent teams, scheduled agents, and messaging integrations. These are host-only orchestration affordances unless agent-connector has a byte-confirmed writable contract for them.",
        bullets: [
          "Multi-agent teams and scheduled agents are product capabilities, not the same as agent-connector subagent files.",
          "Slack, Telegram, Discord, Google Chat, WhatsApp, and Linear integrations should be represented as host orchestration context rather than MCP by default.",
        ],
      },
    ],
    limits: [
      "Do not collapse Cline's SDK, CLI assistant, and IDE extension into one adapter target.",
      "SDK plugin lifecycle hooks are not treated as wired extension hooks in the current coverage matrix.",
      "Future expansion should verify exact extension storage and workspace file paths before promoting host-native gaps.",
    ],
  },
  "qwen-code": {
    status: "researched",
    sequence: 25,
    checkedAt: "2026-07-06",
    summary:
      "Qwen Code is a broad open-source terminal agent row with Auto-Memory, Auto-Skills, SubAgents, Agent Teams, hooks, MCP, IDE plugins, desktop, daemon mode, SDKs, and IM channels visible in the public repository.",
    sources: [
      {
        label: "QwenLM/qwen-code repository",
        url: "https://github.com/QwenLM/qwen-code",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the `qwen` terminal surface, not every Qwen ecosystem client. Qwen Code also advertises IDE plugins, desktop, daemon, SDK, and IM bot surfaces, so the page must distinguish the CLI adapter from the larger multi-platform product.",
        bullets: [
          "Interactive mode runs as `qwen`; headless mode uses `qwen -p` for scripts and batch processing.",
          "The README documents daemon mode over HTTP+SSE as experimental ACP, which is an adjacent host surface rather than this adapter's primary target.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "MCP is a first-class Qwen Code capability in the public feature matrix. agent-connector should treat MCP as part of the broad terminal-agent surface while keeping provider and protocol switching separate from server registration.",
        bullets: [
          "The README groups MCP with Plan Mode and LSP Integration.",
          "Multi-protocol model support covers OpenAI, Anthropic, Gemini, Qwen, third-party providers, and local models; that is not the same as MCP transport.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Qwen Code publicly claims hooks alongside Auto-Memory and Auto-Skills. agent-connector therefore treats it as a rich json-stdio host, but event-specific claims should remain tied to adapter tests and current Qwen docs.",
        bullets: [
          "The README states Qwen Code has been brought toward Claude Code feature parity.",
          "The hook surface should be documented as host-native and wired, while exact event vocabulary should not be invented from Claude Code by analogy.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Qwen Code's public feature list includes Auto-Memory, Auto-Skills, SubAgents, Agent Teams, built-in skills, dynamic workflows, and slash-command style interactive use. These surfaces make it one of the broadest CLI rows in the archive.",
        bullets: [
          "The repository includes `.qwen` content, which supports a Qwen-specific local convention rather than a generic `.agent` folder.",
          "Agent Teams and SubAgents are host affordances that should be kept separate in the inventory.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "Qwen Code's ecosystem reaches beyond the terminal through desktop, IDE plugins, SDKs, IM bots, and Qwen Code Claw delegation. These make it a frontier host for multi-surface study even when the adapter row remains CLI.",
        bullets: [
          "Computer Use, sandbox, git worktrees, Agent Arena, daemon mode, and IM channels are host-only affordances.",
          "The adapter should avoid treating those surfaces as connector support unless a concrete write or runtime contract exists.",
        ],
      },
    ],
    limits: [
      "The current adapter row is CLI-scoped despite Qwen Code's desktop, IDE, daemon, SDK, and IM surfaces.",
      "Feature-parity language should not be used to import Claude Code event details without Qwen-specific evidence.",
      "Daemon and ACP behavior need separate verification before they become install targets.",
    ],
  },
  hermes: {
    status: "researched",
    sequence: 40,
    checkedAt: "2026-07-06",
    summary:
      "Hermes is a CLI plus desktop host whose architecture centers on a learning loop: it creates and improves skills from experience, persists knowledge, searches past conversations, and can run away from the user's laptop through remote or messaging channels.",
    sources: [
      {
        label: "NousResearch/hermes-agent repository",
        url: "https://github.com/NousResearch/hermes-agent",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "Hermes is intentionally multi-surface in the archive. The same adapter id spans CLI and desktop because the public repository presents both Hermes Agent and Hermes Desktop, while also emphasizing cloud and messaging deployment.",
        bullets: [
          "The README describes a self-improving agent with a built-in learning loop.",
          "Hermes can run on a VPS, GPU cluster, serverless infrastructure, or cloud VM rather than being tied to a local laptop.",
          "The page should keep CLI and desktop badges together instead of forcing Hermes into one form factor.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Hermes belongs in the MCP-capable host set, but its public identity is broader than tools alone. MCP should be documented beside channels, memory, and learning loops rather than treated as the entire architecture.",
        bullets: [
          "The repository links a Linux desktop-control MCP server for Hermes and other MCP hosts.",
          "That community server evidence supports desktop-control integration, not a generic claim that every Hermes affordance is MCP.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "agent-connector wires Hermes as a json-stdio hook host, but the host-specific story is the feedback loop around skills and memory. Hook documentation should therefore explain how callbacks fit into learning and channel orchestration.",
        bullets: [
          "Hooks can be used to observe or shape the runtime boundary, while Hermes-owned learning remains a host behavior.",
          "The adapter should avoid flattening Hermes into a generic CLI event bridge.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Skills and memory are first-class Hermes concepts. The README says Hermes creates skills from experience, improves them during use, nudges itself to persist knowledge, searches past conversations, and builds a model of the user across sessions.",
        bullets: [
          "User-scope skills and memory are therefore not decorative content; they are central to the host identity.",
          "Past-conversation search and user modeling should be called out as host-owned memory behavior.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "Hermes has a Skills Hub, desktop application, model switching, messaging channels, and community bridges. These are host-only affordances that should remain visible next to standard connector surfaces.",
        bullets: [
          "Model switching through `hermes model` is a host control surface, not an agent-connector setting.",
          "Telegram, WeChat bridge, desktop-control MCP, and Skills Hub links show a gateway/channel architecture beyond a terminal process.",
        ],
      },
    ],
    limits: [
      "Hermes claims should keep CLI, desktop, cloud, and messaging surfaces distinct even under one adapter id.",
      "Learning-loop behavior is host-owned and should not be represented as generic agent-connector memory semantics.",
      "Community bridge links need separate verification before being promoted as core adapter install targets.",
    ],
  },
  droid: {
    status: "researched",
    sequence: 8,
    checkedAt: "2026-07-06",
    summary:
      "Factory Droid is a broad agent-native development platform whose public architecture spans CLI, web, Slack, Teams, Linear, Jira, mobile, IDE extension, ACP, SDK, GitHub Action, and plugin marketplace surfaces. The connector row stays CLI-scoped while preserving that multi-channel product shape.",
    sources: [
      {
        label: "Factory repository",
        url: "https://github.com/Factory-AI/factory",
      },
      {
        label: "Factory documentation",
        url: "https://docs.factory.ai/",
      },
      {
        label: "Factory website",
        url: "https://factory.ai/",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the local Droid CLI. Factory owns the hosted service, channels, model orchestration, and IDE/ACP clients; agent-connector installs only into the byte-addressable host surfaces that the CLI can read from local configuration and workspace files.",
        bullets: [
          "The public repository presents Factory as an agent-native development platform, not only a terminal wrapper.",
          "Droid can be reached through CLI, web, Slack, Teams, Linear, Jira, mobile, IDE, and ACP surfaces.",
          "The archive keeps Droid in the CLI band because the current adapter writes the local CLI contract.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Droid belongs in the MCP-capable CLI set, but Factory also exposes SDK and ACP integration paths. The page therefore treats MCP as one tool extension rail and keeps IDE/ACP connection setup separate from local MCP server registration.",
        bullets: [
          "MCP should remain a tool-server install target, not a proxy label for every Factory integration.",
          "ACP support for JetBrains and Zed is an adjacent client protocol and should not be folded into the CLI file contract.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "agent-connector models Droid as a json-stdio hook host. Hook claims should stay tied to the local adapter bridge because Factory's public product surface is channel-heavy and does not make every channel a lifecycle interception point.",
        bullets: [
          "The host owns channel routing and cloud-side execution decisions.",
          "The connector hook bridge should describe request and response normalization without implying control over Slack, Teams, Linear, Jira, or mobile clients.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Factory advertises plugins, an IDE extension, SDKs, GitHub automation, and agent workflows. agent-connector should represent commands, skills, memory, and subagent-like content only where the local Droid CLI or workspace contract can discover them.",
        bullets: [
          "Plugin marketplace content is a distribution surface and should be modeled separately from local generated command files.",
          "GitHub Action and ESLint plugin support are workflow integrations, not the local CLI runtime boundary.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "Factory's host-only affordances include a plugin marketplace, SDKs, ACP clients, mobile access, issue-tracker channels, and repository automation. Those features should be visible on the study page without being counted as implemented connector surfaces unless an adapter writes or invokes them.",
        bullets: [
          "The marketplace axis matters because plugin developers need to know whether distribution is host-native or connector-generated.",
          "Channel support should appear as host orchestration context, not as MCP or hook support by default.",
        ],
      },
    ],
    limits: [
      "This page documents the Droid CLI adapter row, not every Factory hosted or mobile surface.",
      "ACP and SDK claims need separate adapter work before they become connector install targets.",
      "Channel integrations should stay host-only unless agent-connector has a concrete write or runtime contract.",
    ],
  },
  openhands: {
    status: "researched",
    sequence: 10,
    checkedAt: "2026-07-06",
    summary:
      "OpenHands is a self-hosted developer control center for coding agents and automations. It can run OpenHands, Claude Code, Codex, Gemini, and ACP-compatible agents, so the architecture page must separate the local connector row from OpenHands as a multi-agent orchestration host.",
    sources: [
      {
        label: "OpenHands repository",
        url: "https://github.com/OpenHands/OpenHands",
      },
      {
        label: "OpenHands documentation",
        url: "https://docs.openhands.dev/",
      },
      {
        label: "OpenHands software-agent-sdk",
        url: "https://github.com/OpenHands/software-agent-sdk",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The connector row targets the OpenHands host surface, while OpenHands itself can dispatch multiple coding agents through local, remote, and cloud execution contexts. agent-connector must not collapse OpenHands into the agent it happens to launch.",
        bullets: [
          "The public repository describes a developer control center for agents and automations.",
          "OpenHands can host OpenHands, Claude Code, Codex, Gemini, and ACP-compatible agents.",
          "Agent Canvas and Agent Server indicate a split between UI orchestration and backend execution.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "MCP should be documented as an available tool and integration rail, but OpenHands' more important boundary is agent orchestration. The adapter page should distinguish tool servers from agent backends and ACP-compatible launches.",
        bullets: [
          "A target agent may have its own MCP config that is not the same as OpenHands' orchestration configuration.",
          "Connector support should record which layer receives the MCP server: OpenHands itself or a delegated agent runtime.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "agent-connector treats this row as a json-stdio host, but OpenHands' public architecture is service and automation oriented. Hook language should therefore be careful: lifecycle interception belongs to the adapter bridge or a specific agent backend, not to every OpenHands automation channel.",
        bullets: [
          "Slack, GitHub, and Linear automations are product channels and workflow triggers.",
          "Agent launch, session handoff, and backend selection are separate from connector hook payload normalization.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "OpenHands content surfaces include agent workspace context, automations, prompts, and control-center state. When agent-connector writes commands, skills, or memory, the archive should clarify whether those artifacts are consumed by OpenHands or by a hosted downstream agent.",
        bullets: [
          "The Agent Canvas and Agent Server split creates an important teaching example for UI/backend architecture.",
          "If a Claude Code or Codex backend is launched, that backend may still need its own native files.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "OpenHands' host-only affordance is orchestration across many agents plus automations for Slack, GitHub, and Linear. That makes it a reference host for control-plane architecture rather than a simple single-agent CLI adapter.",
        bullets: [
          "Students should read this row as a control-plane host with delegated agent runtimes.",
          "The page should show ACP compatibility as a host capability that can bridge to external agents.",
        ],
      },
    ],
    limits: [
      "Do not represent a delegated Claude Code, Codex, Gemini, or ACP agent feature as an OpenHands-native connector feature without layer-specific evidence.",
      "Automations are host workflows, not necessarily hook events.",
      "Agent Canvas, Agent Server, and software-agent-sdk references should be kept distinct in future source passes.",
    ],
  },
  kilo: {
    status: "researched",
    sequence: 19,
    checkedAt: "2026-07-06",
    summary:
      "Kilo Code is a multi-surface open-source coding agent spanning VS Code, JetBrains, CLI, cloud agents, MCP marketplace, code reviews, and specialized modes. The current connector row is extension-oriented, but the page must preserve the CLI and JetBrains overlap explicitly.",
    sources: [
      {
        label: "Kilo Code repository",
        url: "https://github.com/Kilo-Org/kilocode",
      },
      {
        label: "Kilo Code website",
        url: "https://kilo.ai/",
      },
      {
        label: "Kilo Code documentation",
        url: "https://kilo.ai/docs",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The current adapter row is an extension surface, while the public product spans VS Code, JetBrains, and CLI. agent-connector should show Kilo as multi-surface host nature without assuming all surfaces share one writable configuration model.",
        bullets: [
          "The README presents Kilo Code as available in VS Code, JetBrains, and CLI.",
          "The CLI is described as forked from OpenCode, which is architecture evidence but not proof of identical file paths.",
          "Cloud Agent and review surfaces are host workflows outside the local extension runtime.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Kilo advertises an MCP marketplace, so MCP should be treated as a first-class extension path. The connector must still identify whether a server is registered through the VS Code extension, JetBrains plugin, CLI, or cloud surface before claiming implementation.",
        bullets: [
          "Marketplace-backed MCP is a distribution concern as well as a tool registration concern.",
          "A multi-IDE host can expose the same conceptual MCP feature through different storage layers.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "The current connector matrix treats Kilo as a TypeScript-plugin style host. Hook documentation should describe the extension/plugin bridge and avoid assuming the same hook contract applies to the CLI fork or cloud agent until those runtimes are tested separately.",
        bullets: [
          "Plugin host events and local CLI events are separate runtime boundaries.",
          "Autonomous mode and code review automation are host behaviors, not necessarily connector hook events.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Kilo's public modes include Code, Plan, Ask, Debug, and Review, and the product also advertises custom workflow features. The page should show those as host-native content surfaces while keeping agent-connector skills, commands, and memory tied to verified adapter paths.",
        bullets: [
          "Mode names are a useful teaching bridge between editor UX and agent architecture.",
          "KiloClaw and cloud-agent naming should be represented as host affordances, not generic connector subagents.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "Kilo's MCP marketplace, multi-IDE distribution, CLI lineage, cloud agent, and code-review surfaces make it a strong example of product-family architecture. The coverage matrix needs to show which of those are host-native versus agent-connector implemented.",
        bullets: [
          "VS Code, JetBrains, and CLI should remain visible as separate surface labels.",
          "The OpenCode lineage is relevant to plugin architecture but should not replace Kilo-specific source review.",
        ],
      },
    ],
    limits: [
      "Do not assume Kilo CLI, VS Code, JetBrains, and cloud surfaces share one config path.",
      "MCP marketplace availability should be separated from local adapter implementation.",
      "OpenCode lineage is evidence to investigate, not a substitute for Kilo-specific runtime verification.",
    ],
  },
  cursor: {
    status: "researched",
    sequence: 13,
    checkedAt: "2026-09-07",
    summary:
      "Cursor is a source-light desktop IDE host: the public GitHub repository is an issue tracker rather than full product source, while the product surface exposes agent workflows, rules, commands, extension-like behavior, and MCP-style tool integration through the IDE.",
    sources: [
      {
        label: "Cursor repository",
        url: "https://github.com/cursor/cursor",
      },
      {
        label: "Cursor website",
        url: "https://cursor.com/",
      },
      {
        label: "Cursor features",
        url: "https://cursor.com/features",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the desktop IDE host, not a transparent open-source CLI. Cursor owns the editor shell, chat/agent UI, indexing, model selection, extension runtime, and workspace trust boundaries, while agent-connector can only document verified writable surfaces.",
        bullets: [
          "The GitHub repository functions as a public issue tracker and download pointer rather than complete runtime source.",
          "Claims about internals should therefore be source-light and evidence-labeled.",
          "The row belongs in the desktop band because the product is an IDE-style host.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Cursor registers MCP servers in JSON files the adapter writes directly: user scope ~/.cursor/mcp.json and project scope <project>/.cursor/mcp.json, both under the mcpServers root key. Cursor supports its own ${env:VAR} interpolation, so environment, header, and URL values are rewritten to that token instead of being baked into the file.",
        bullets: [
          "The paths come from the adapter (adapters/cursor), not from Visual Studio Code ancestry.",
          "Project-scope MCP is workspace-visible and can be committed alongside rules and commands.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Cursor is a json-stdio hook host. The adapter writes <configDir>/hooks.json with the shape { version, hooks: { <cursorEvent>: [ { command, matcher? } ] } }; each entry is a flat command object rather than Claude's { matcher, hooks: [...] } wrapper. Replies are one JSON object on stdout with exit 0.",
        bullets: [
          "deny and ask carry permission plus user_message; modify carries updated_input.",
          "Context injection uses agent_message on PreToolUse and additional_context on PostToolUse and SessionStart.",
          "IDE commands and agent modes remain host UI affordances outside the hook contract.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Cursor's useful content surfaces are rules, agent instructions, commands, project context, and editor-indexed knowledge. These should be represented as IDE content and memory surfaces rather than copied into CLI dot-directory assumptions.",
        bullets: [
          "Rules and project context are central to the host learning experience.",
          "Workspace indexing and codebase search are host-owned capabilities outside agent-connector's file writer.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "Cursor's host-only value is the integrated IDE experience: agent UI, codebase index, model routing, editor actions, and extension ecosystem compatibility. The archive should mark it as source-light so students know which claims come from product surface evidence rather than source inspection.",
        bullets: [
          "Source-light does not mean unsupported; it means internal architecture claims need stricter wording.",
          "Feature parity with VS Code extensions should not be assumed for connector writes.",
        ],
      },
    ],
    limits: [
      "Cursor internals are not fully visible through the public tracker repository; file contracts above come from the adapter and Cursor's hooks and MCP documentation.",
      "Statusline and actions are not host surfaces here, so those coverage chips stay off by design.",
      "Avoid deriving further file paths from VS Code without current Cursor-specific documentation.",
    ],
  },
  zed: {
    status: "researched",
    sequence: 38,
    checkedAt: "2026-07-06",
    summary:
      "Zed is a desktop editor host with three AI paths: the built-in Zed Agent, External Agents through ACP, and Terminal Threads that run CLI/TUI agents directly. Its MCP story depends on which path receives the tool server.",
    sources: [
      {
        label: "Zed repository",
        url: "https://github.com/zed-industries/zed",
      },
      {
        label: "Zed AI overview",
        url: "https://zed.dev/docs/ai/overview",
      },
      {
        label: "Zed MCP docs",
        url: "https://zed.dev/docs/ai/mcp",
      },
      {
        label: "Zed skills docs",
        url: "https://zed.dev/docs/ai/skills",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the desktop Zed host. Zed owns editor panes, tool permissions, profiles, skills, instructions, and the choice between built-in agent, ACP external agent, and Terminal Thread execution.",
        bullets: [
          "Zed Agent is the built-in path with tools, profiles, skills, instructions, and MCP servers.",
          "External Agents are ACP-integrated and may have their own capabilities.",
          "Terminal Threads run a CLI or TUI agent directly in the editor terminal.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Zed's MCP docs are unusually explicit: Zed supports MCP tools and prompts, watches list_changed notifications, and can expose MCP to built-in or ACP paths depending on configuration. agent-connector must model the recipient path, not only the server entry.",
        bullets: [
          "Custom MCP servers are configured through `context_servers` settings.",
          "MCP servers can also be packaged as Zed extensions.",
          "External Agents may receive MCP through ACP forwarding or through their own native configuration.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Zed is currently represented as MCP-only in the connector matrix. The editor has rich AI controls, but there is no current agent-connector hook bridge that intercepts Zed Agent lifecycle events through generated files.",
        bullets: [
          "Tool permission UI is host-owned and should not be documented as a connector hook.",
          "ACP forwarding is a protocol bridge to another agent, not a Zed-native PreToolUse hook surface.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Zed's study value is high because it separates instructions, skills, profiles, MCP, External Agents, and Terminal Threads. Those content surfaces should be shown as editor-native organization rather than forced into the CLI command/skill model.",
        bullets: [
          "Skills and instructions are native Zed Agent context surfaces.",
          "Terminal Threads can inherit the downstream CLI agent's files, creating a layered-host example.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "Zed's host-only affordances include extension-packaged MCP servers, ACP external agents, profiles, native editor collaboration, and terminal-thread hosting. These make it a key desktop architecture case even though the connector coverage remains MCP-first.",
        bullets: [
          "The diagram should show two possible tool paths: Zed Agent MCP and external agent MCP.",
          "Students should not treat Terminal Threads as proof that Zed itself implements the downstream agent's hooks.",
        ],
      },
    ],
    limits: [
      "Zed Agent, External Agents, and Terminal Threads must remain separate runtime paths.",
      "MCP forwarding through ACP should not be counted as Zed-native hook support.",
      "A downstream CLI's capabilities should not be promoted into Zed coverage without layer-specific evidence.",
    ],
  },
  windsurf: {
    status: "researched",
    sequence: 31,
    checkedAt: "2026-07-06",
    summary:
      "Windsurf has transitioned into Devin Desktop. The archive keeps the Windsurf row for compatibility and history, but the current architecture should point readers to Devin Desktop as the maintained desktop command center with ACP, agents, Spaces, extensions, and MCP servers.",
    sources: [
      {
        label: "Devin Desktop",
        url: "https://devin.ai/desktop",
      },
      {
        label: "Windsurf website",
        url: "https://windsurf.com/",
      },
      {
        label: "Devin Desktop docs",
        url: "https://docs.devin.ai/desktop/getting-started",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The historical Windsurf row should now be read as a desktop IDE transition row. Devin Desktop owns the IDE shell, local and cloud agent coordination, ACP connections, Spaces, extensions, and migration from Windsurf settings.",
        bullets: [
          "The current product messaging states that Windsurf is now Devin Desktop.",
          "The desktop host can manage local and cloud agents from one IDE command center.",
          "The coverage page should preserve Windsurf as a legacy label while pointing users to the maintained architecture.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Devin Desktop advertises MCP servers and extensions as part of the desktop command center. The connector archive should mark MCP as desktop-host integration while avoiding assumptions about old Windsurf paths after migration.",
        bullets: [
          "MCP setup belongs to the current Devin Desktop host for new claims.",
          "Existing Windsurf user settings may migrate, but migration does not prove stable connector paths.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "The current connector matrix treats Windsurf as MCP-only. Agent orchestration through Devin Cloud, Devin Local, Codex, Claude, OpenCode, or Cascade is a host capability, but it does not create a generic Windsurf lifecycle hook bridge.",
        bullets: [
          "ACP can connect desktop UI to external agents and should be diagrammed as a protocol edge.",
          "The downstream agent may have hooks, but those hooks belong to the downstream runtime unless Devin Desktop exposes its own bridge.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "The post-Windsurf content model includes Spaces, worktrees, extensions, MCP servers, IDE settings, and agent context shared between local and cloud execution. These are desktop workspace surfaces rather than terminal dot-file content.",
        bullets: [
          "Spaces are important because they bind context and git worktrees across agents.",
          "Extensions and workflows should be represented as host configuration surfaces, not connector commands by default.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The important host-only affordance is the desktop command center that can manage Devin Cloud, Devin Local, Codex, Claude, OpenCode, Cascade, and ACP-compatible agents. That makes Windsurf/Devin Desktop a layered-host case similar to Zed and OpenHands.",
        bullets: [
          "The page should visually distinguish the legacy Windsurf label from the current Devin Desktop product.",
          "JetBrains continuation and settings migration are product support facts, not direct adapter implementation evidence.",
        ],
      },
    ],
    limits: [
      "Treat Windsurf as a legacy row whose current maintained product is Devin Desktop.",
      "Do not assume old Windsurf file paths remain valid after migration.",
      "Downstream agent capabilities should remain separated from Devin Desktop host capabilities.",
    ],
  },
  devin: {
    status: "researched",
    sequence: 33,
    checkedAt: "2026-07-06",
    summary:
      "Devin is a cloud, CLI, and desktop software-engineering agent platform. Its architecture includes long-running planning/execution, PR review, visual QA, docs, migrations, issue triage, knowledge, skills, automations, MCP Marketplace, shell, browser, and IDE surfaces.",
    sources: [
      {
        label: "Devin website",
        url: "https://devin.ai/",
      },
      {
        label: "Devin introduction docs",
        url: "https://docs.devin.ai/get-started/devin-intro",
      },
      {
        label: "Devin CLI docs",
        url: "https://docs.devin.ai/desktop/cli",
      },
      {
        label: "Devin Desktop",
        url: "https://devin.ai/desktop",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "Devin should be modeled as a platform host, not a simple CLI. The cloud service, CLI handoff, desktop IDE, embedded shell, browser, and workspace state are all part of the product architecture, while the connector row must name the concrete surface it installs into.",
        bullets: [
          "Devin can plan and execute complex engineering tasks, review PRs, run visual QA, update docs, migrate code, and triage issues.",
          "The docs describe Cloud, CLI, and Desktop surfaces.",
          "CLI handoff can move local context to cloud execution, creating a cross-surface boundary.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Devin exposes an MCP Marketplace, so MCP is not just a local JSON setting. agent-connector should represent MCP as a platform marketplace and tool-extension surface, with separate treatment for local CLI, desktop, and cloud session attachment.",
        bullets: [
          "Marketplace MCP servers may be installed through Devin platform UX rather than local file writes.",
          "Cloud sessions can have different authority and network reach than a local terminal adapter.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "agent-connector classifies Devin as a json-stdio host in the current matrix, but the product architecture is broader. Hook documentation should distinguish local CLI bridge behavior from cloud automations, scheduled work, and PR review triggers.",
        bullets: [
          "Automations and scheduled chores are host workflow triggers.",
          "The CLI can hand off to cloud, so a hook event observed locally may not cover the whole task lifecycle after handoff.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Devin's docs call out Knowledge, Skills, Automations, MCP Marketplace, shell, browser, and IDE state. These surfaces make it a major reference for plugin developers because content may be persistent platform knowledge rather than only repository files.",
        bullets: [
          "Skills and Knowledge should be treated as platform memory/content surfaces.",
          "Embedded browser and shell are host execution affordances that affect test and QA workflows.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "Devin's host-only affordances include multi-week multi-repo execution, learning from past sessions, Slack/Linear/GitHub integrations, MCP Marketplace, cloud compute, local CLI, and desktop command-center UX. The archive should show these as platform capabilities beside connector coverage chips.",
        bullets: [
          "Long-running autonomy and session memory are host-owned behaviors.",
          "PR review, visual QA, migrations, and issue triage are workflow products, not a generic hook API.",
        ],
      },
    ],
    limits: [
      "Keep Cloud, CLI, and Desktop surfaces separate when claiming connector support.",
      "Do not count platform automations as local lifecycle hooks without adapter evidence.",
      "Marketplace and knowledge features may require authenticated platform state that agent-connector cannot write directly.",
    ],
  },
  "amazon-q": {
    status: "researched",
    sequence: 29,
    checkedAt: "2026-07-06",
    summary:
      "Amazon Q Developer CLI is now a legacy/open-source reference row because the public repository says it is no longer actively maintained and points users toward the closed-source Kiro CLI. The architecture page should preserve the terminal-agent design while clearly marking the maintenance transition.",
    sources: [
      {
        label: "Amazon Q Developer CLI repository",
        url: "https://github.com/aws/amazon-q-developer-cli",
      },
      {
        label: "Amazon Q Developer CLI docs",
        url: "https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line.html",
      },
      {
        label: "Kiro",
        url: "https://kiro.dev/",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter row targets the local terminal CLI that historically shipped as Amazon Q Developer CLI. The repository now marks the project as not actively maintained and redirects general availability attention to Kiro CLI, so status must appear in the architecture page.",
        bullets: [
          "The open-source repository contains the `chat_cli` terminal application and project layout.",
          "The current maintenance note limits future compatibility expectations for this adapter row.",
          "Kiro CLI is a related successor path but is not open-source-equivalent evidence.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Amazon Q belongs in the MCP-capable CLI family in the local matrix, but the maintenance transition means new MCP claims should be checked against current AWS or Kiro documentation before expansion.",
        bullets: [
          "Historical Amazon Q CLI behavior should not be projected into Kiro without Kiro-specific source or docs.",
          "AWS account, identity, and region configuration can affect tool authority beyond local file installation.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "agent-connector classifies Amazon Q as a json-stdio host, so local hook support should be described through the adapter contract. The page should avoid implying active upstream hook evolution from a repository that is now security-fix-only.",
        bullets: [
          "Legacy status makes regression tests more important than roadmap inference.",
          "Hook event vocabulary should stay adapter-backed and should not be borrowed from Kiro by analogy.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Amazon Q's CLI content surfaces include terminal chat, project context, and AWS-oriented developer assistance. Because the repository is in maintenance mode, the archive should show current connector support while steering future feature study toward Kiro as a separate host.",
        bullets: [
          "Project context and AWS identity are part of the terminal-agent operating environment.",
          "Do not merge Kiro specs, steering files, or IDE behavior into this row without adapter separation.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only story is the AWS developer ecosystem and the Kiro transition. Amazon Q Developer CLI remains valuable as an open-source reference, but plugin marketplace and new agent-host affordances should be studied on Kiro or AWS docs separately.",
        bullets: [
          "Maintenance status should appear beside any flagship or frontier badges.",
          "AWS ecosystem integration is a host affordance, not a connector implementation guarantee.",
        ],
      },
    ],
    limits: [
      "Treat the open-source Amazon Q Developer CLI as legacy unless current AWS docs say otherwise.",
      "Do not transfer Kiro CLI behavior back into Amazon Q without direct evidence.",
      "Security-fix-only maintenance means compatibility should be verified by tests before claims expand.",
    ],
  },
  "vscode-copilot": {
    status: "researched",
    sequence: 6,
    checkedAt: "2026-07-06",
    summary:
      "VS Code Copilot is an editor-native agent host with chat, local agents, Copilot CLI handoff, remote sessions, MCP servers, hooks, memory, subagents, prompt files, custom agents, and plugins documented as separate VS Code agent surfaces.",
    sources: [
      {
        label: "VS Code chat overview",
        url: "https://code.visualstudio.com/docs/chat/chat-overview",
      },
      {
        label: "VS Code MCP servers",
        url: "https://code.visualstudio.com/docs/agent-customization/mcp-servers",
      },
      {
        label: "VS Code agent hooks",
        url: "https://code.visualstudio.com/docs/agent-customization/hooks",
      },
      {
        label: "VS Code agent memory",
        url: "https://code.visualstudio.com/docs/agents/memory",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the VS Code extension and agent runtime. VS Code owns the editor window, chat surfaces, local agent harness, integrated terminal, workspace trust, extension tools, permissions, and background session UI.",
        bullets: [
          "VS Code exposes an Agents window, Chat view, inline chat, and quick chat as separate user surfaces.",
          "Local agents run inside the editor harness, while Copilot CLI sessions run outside VS Code in the background.",
          "The connector page must not collapse the VS Code host with Copilot CLI even though VS Code can start and monitor CLI sessions.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "MCP is first-class in VS Code agent customization. The docs distinguish adding servers, managing server trust, enabling or disabling servers, synchronizing configuration, and centrally managing access, so connector writes need to respect editor policy boundaries.",
        bullets: [
          "MCP servers extend chat with external tools and can be added through the VS Code agent customization path.",
          "Trust, sandboxing, and centrally managed access are host-owned policy surfaces.",
          "Copilot CLI has its own MCP limitations and should be documented separately from VS Code local agents.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "VS Code documents agent hooks as a preview customization surface. agent-connector should treat this as an editor-native hook system, while keeping current adapter support tied to the exact generated files and event envelopes it can verify.",
        bullets: [
          "Hooks belong to agent customization rather than ordinary chat commands.",
          "Preview status means the page should avoid over-promising stable hook semantics.",
          "Hook support is distinct from MCP tools and from Copilot CLI's separate hook surface.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "VS Code agent content includes instructions, agent skills, custom agents, prompt files, memory, and workspace context. These are editor-scoped content surfaces that interact with settings, workspace files, and extension APIs rather than a pure terminal dot directory.",
        bullets: [
          "Slash commands and prompt files are user-facing shortcuts, not lifecycle hooks.",
          "Memory is a documented agent surface and should be separated from repository instructions.",
          "Custom agents and subagents define personas and task decomposition inside the VS Code agent UX.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only story is VS Code's integrated agent control plane: multiple chat surfaces, extension-contributed tools, MCP, hooks, custom agents, notifications, checkpoints, and Copilot CLI handoff from one editor shell.",
        bullets: [
          "Extension-contributed tools are available to VS Code local agents but not necessarily to Copilot CLI sessions.",
          "The archive should show VS Code as an editor host with both local and delegated background agents.",
        ],
      },
    ],
    limits: [
      "Keep VS Code local agents distinct from Copilot CLI sessions.",
      "Hook claims should track the preview documentation and local adapter tests.",
      "Editor extension tools should not be counted as Copilot CLI tool availability.",
    ],
  },
  "copilot-cli": {
    status: "researched",
    sequence: 5,
    checkedAt: "2026-07-06",
    summary:
      "GitHub Copilot CLI is a background-capable local terminal agent that can be launched from VS Code, used directly from the terminal, remote-controlled from GitHub or mobile, customized with hooks, MCP, skills, custom agents, plugins, and run in worktree or folder isolation.",
    sources: [
      {
        label: "VS Code Copilot CLI sessions",
        url: "https://code.visualstudio.com/docs/agents/agent-types/copilot-cli",
      },
      {
        label: "GitHub Copilot CLI overview",
        url: "https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli",
      },
      {
        label: "GitHub Copilot CLI MCP",
        url: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers",
      },
      {
        label: "GitHub Copilot CLI hooks",
        url: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the Copilot CLI agent harness. VS Code can install, launch, monitor, and hand off to it, but the CLI sessions run outside the editor and can continue in the background after the editor window closes.",
        bullets: [
          "Sessions can use worktree isolation or folder isolation.",
          "VS Code surfaces progress, approvals, and chat steering for the background CLI.",
          "The terminal command is a distinct host row from VS Code Copilot and JetBrains Copilot.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Copilot CLI has a documented customization path for adding MCP servers, but VS Code documents an important limitation: Copilot CLI sessions can currently access local MCP servers that do not require authentication.",
        bullets: [
          "MCP support should be documented as CLI-specific, not inherited from VS Code local agents.",
          "Authentication limitations matter for plugin developers packaging MCP servers.",
          "MCP setup belongs beside permissions, isolation, and remote-control constraints.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "GitHub documents Copilot CLI hooks as a customization feature, and VS Code lists hooks among slash-command surfaced CLI capabilities. agent-connector can therefore model a CLI hook bridge while keeping event details tied to GitHub's current hook docs.",
        bullets: [
          "The CLI also supports `/compact`, `/research`, `/yolo`, and `/autoApprove` as chat commands.",
          "Hook semantics should not be copied from VS Code preview hooks or Copilot SDK hooks without checking CLI docs.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Copilot CLI content includes custom instructions, agent skills, custom agents, plugins, LSP servers, research mode, session data, and remote-control state. These surfaces are CLI-owned even when launched from an editor.",
        bullets: [
          "Custom agents can be selected for Copilot CLI sessions from VS Code when enabled.",
          "Session data can sync to remote control surfaces such as GitHub and GitHub Mobile.",
          "Worktree commits and rollback behavior are part of the host's operating model.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is GitHub ecosystem reach: Actions automation, GitHub task pages, mobile remote control, custom agents, plugins, LSP servers, and cloud/local sandbox integration around one CLI agent harness.",
        bullets: [
          "Remote control mirrors status, tool activity, and approvals across VS Code and GitHub.",
          "GitHub Actions automation and scheduled prompts are workflow surfaces, not local hook events.",
        ],
      },
    ],
    limits: [
      "Do not treat VS Code local-agent extension tools as available to Copilot CLI.",
      "MCP authentication limitations should stay visible until GitHub changes the CLI docs.",
      "Remote control is a GitHub session feature, not a generic connector transport.",
    ],
  },
  warp: {
    status: "researched",
    sequence: 7,
    checkedAt: "2026-07-06",
    summary:
      "Warp is a terminal, local-agent, third-party-agent, and cloud-agent orchestration host. Its architecture includes MCP servers, skills, slash commands, rules, terminal use, codebase context, profiles, remote control, cloud agents, and multi-agent orchestration.",
    sources: [
      {
        label: "Warp MCP documentation",
        url: "https://docs.warp.dev/agent-platform/capabilities/mcp/",
      },
      {
        label: "Warp agents documentation",
        url: "https://docs.warp.dev/agent-platform/",
      },
      {
        label: "Warp website",
        url: "https://www.warp.dev/",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the Warp desktop terminal host, not a conventional CLI binary. Warp owns terminal blocks, local agents, third-party CLI agent hosting, remote control, cloud agents, permissions, and app-level settings.",
        bullets: [
          "Warp separates Terminal and Agent modes and can host third-party CLI agents such as Claude Code, Codex, and OpenCode.",
          "The cloud-agent layer includes Oz platform concepts, triggers, integrations, and handoff.",
          "The connector row should remain desktop/terminal host scoped rather than claiming downstream agent internals.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Warp's MCP docs are explicit and unusually rich. Warp supports command-based servers, streamable HTTP or SSE servers, custom headers, environment variables, shared servers, OAuth, logs, and file-based project or global config.",
        bullets: [
          "Warp global config lives at `~/.warp/.mcp.json` and project config at `.warp/.mcp.json`.",
          "Warp can also read Claude Code, Codex, and other-agent MCP files when third-party auto-spawn is enabled.",
          "Project-scoped servers require explicit approval, which is a host security boundary.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Warp is currently represented as MCP-only in agent-connector. Its local agents have many controls, but the connector should not describe PreToolUse or PostToolUse hooks unless Warp exposes a file or plugin lifecycle bridge for that purpose.",
        bullets: [
          "Rules, profiles, permissions, and prompt queueing are host UX controls.",
          "Third-party hosted agents may have their own hook systems, but those hooks belong to the downstream agent runtime.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Warp content surfaces include slash commands, skills, task lists, rules, codebase context, profiles, permissions, full terminal use, computer use, and cloud-synced conversations. These belong to the Warp app and cloud platform.",
        bullets: [
          "The built-in `/agent-add-mcp` skill can create or update file-based MCP definitions.",
          "Session sharing and cloud-synced conversations are host memory/collaboration features.",
          "Rules and skills should be displayed separately from MCP server registration.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "Warp's host-only affordances include shared MCP servers, cloud agents, Slack and Linear integrations, GitHub Actions, cloud handoff, hosted agents, self-hosted workers, and third-party CLI agent embedding inside the terminal app.",
        bullets: [
          "Warp is a layered host: it can run its own agents and host other agents.",
          "The study page should distinguish local Warp Agent MCP from cloud-agent MCP workflows.",
        ],
      },
    ],
    limits: [
      "MCP support should not be treated as a lifecycle hook bridge.",
      "Downstream Claude Code, Codex, or OpenCode features should not be promoted into Warp coverage without layer-specific evidence.",
      "Cloud-agent features may require Warp account state and should not be represented as local file writes.",
    ],
  },
  trae: {
    status: "researched",
    sequence: 15,
    checkedAt: "2026-07-06",
    summary:
      "Trae is a ByteDance-backed coding-agent family with an open-source Trae Agent research/runtime project and a proprietary Trae AI IDE product. The connector row should keep CLI-style agent evidence and IDE product evidence separate.",
    sources: [
      {
        label: "Trae Agent repository",
        url: "https://github.com/bytedance/trae-agent",
      },
      {
        label: "Trae website",
        url: "https://www.trae.ai/",
      },
      {
        label: "Trae Agent paper",
        url: "https://arxiv.org/abs/2507.23370",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The archive should treat Trae as a split evidence host: the open-source Trae Agent is a software-engineering agent project, while Trae AI is an IDE product. The adapter row must name which runtime it can install into.",
        bullets: [
          "The open repository frames Trae Agent as a general-purpose software-engineering agent.",
          "The paper describes ensemble reasoning for repository-level issue resolution.",
          "The website is product-facing and does not by itself reveal every local storage contract.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Trae should be represented as MCP-capable only where the local adapter or public source gives a concrete server registration shape. Product-level integration language should not be converted into an MCP file contract without evidence.",
        bullets: [
          "Open-source agent evidence can guide CLI architecture review.",
          "IDE product evidence should remain source-light until exact extension or settings paths are verified.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "The current connector matrix classifies Trae as MCP-only. That means architecture notes should avoid claiming lifecycle hooks even if the agent research system has modular stages, pruning, generation, or selection agents.",
        bullets: [
          "Research-agent modules are not automatically installable hook events.",
          "Future hook support should identify a concrete local API or file-based bridge.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Trae's useful study surfaces are repository understanding, issue resolution, multi-stage agent reasoning, IDE product UX, and model/provider integration. These are content and orchestration concepts, not necessarily connector-owned command files.",
        bullets: [
          "The paper's generator, pruning, and selection roles are architecture evidence for multi-agent reasoning.",
          "IDE rules, prompts, or workspace state need separate source review before page chips are upgraded.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "Trae's host-only affordance is the combination of an agentic IDE product and an open research agent lineage. The page should show that duality so students can compare productized IDE agents with research/runtime agents.",
        bullets: [
          "The open-source row is useful for algorithmic architecture study.",
          "The proprietary IDE row should remain cautious about storage, hooks, and marketplace claims.",
        ],
      },
    ],
    limits: [
      "Do not merge Trae Agent research architecture with Trae IDE implementation details without evidence.",
      "MCP-only coverage should remain separate from lifecycle hooks.",
      "The product website is source-light and should not be used for undocumented internals.",
    ],
  },
  amp: {
    status: "researched",
    sequence: 41,
    checkedAt: "2026-07-06",
    summary:
      "Amp is a frontier terminal and editor coding agent with explicit docs for CLI, IDE integration, AGENTS.md, skills, subagents, oracle, librarian, painter, MCP, permissions, plugins, remote control, SDK, and plugin API reference.",
    sources: [
      {
        label: "Amp owner manual",
        url: "https://ampcode.com/manual",
      },
      {
        label: "Amp install",
        url: "https://ampcode.com/install",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is Amp's CLI/editor agent surface. Amp owns model selection, tools, shell execution, permissions, thread state, remote machines called Orbs, thread sharing, and IDE connections across JetBrains, Neovim, VS Code-family editors, and Zed.",
        bullets: [
          "Amp documents `deep`, `smart`, and `rush` modes.",
          "The CLI can connect to an IDE through the command palette and `ide connect` flow.",
          "The web UI is used for thread sharing rather than being the local file adapter target.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Amp supports MCP directly and also lets skills bundle MCP servers through an `mcp.json` file in the skill directory. This makes MCP part of both always-on configuration and lazily loaded skill packaging.",
        bullets: [
          "Skill-bundled MCP servers start when Amp launches but keep tools hidden until the skill is loaded.",
          "Amp examples include local command-based and remote HTTP MCP servers.",
          "MCP tool exposure is intentionally managed to reduce context bloat.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Amp's plugin system is the key hook and extension boundary. The manual includes plugin locations, writing plugins, event examples, command/tool/UI examples, custom agent modes, custom subagents, and permissions plugins.",
        bullets: [
          "Plugin events should be treated as Amp-native lifecycle surfaces.",
          "Permissions plugins are an important policy hook example for agent-connector SDK design.",
          "Do not reduce Amp plugins to MCP because plugins can add commands, tools, UI, modes, and subagents.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Amp uses AGENTS.md guidance, skills, subagents, Oracle, Librarian, Painter, thread references, images, @file mentions, and shared threads as content surfaces. Skills can live in project and multiple user-wide locations.",
        bullets: [
          "Amp reads AGENTS.md from cwd, parents, subtrees, user config, system config, and compatible filenames.",
          "Skill precedence spans shared `.agents/skills`, user config, `.claude/skills`, plugins, and built-ins.",
          "Subagents and Oracle are host-native specialization surfaces.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "Amp's host-only affordances include Orbs, thread sharing, remote control, plugin API reference, SDK, built-in skills, subagents, Oracle, Librarian, Painter, and an explicit no-backcompat frontier product stance.",
        bullets: [
          "The plugin API and SDK make Amp especially relevant for hook SDK requirements.",
          "Thread search and thread references are host memory features, not generic connector memory.",
        ],
      },
    ],
    limits: [
      "Amp evolves quickly and explicitly deprioritizes legacy compatibility, so source checks must stay fresh.",
      "MCP, skills, plugins, and subagents are separate surfaces and should not be collapsed.",
      "Thread sharing and Orbs may require Amp account state outside local file writes.",
    ],
  },
  codebuff: {
    status: "researched",
    sequence: 20,
    checkedAt: "2026-09-07",
    summary:
      "Freebuff (the product formerly named Codebuff; the adapter id stays codebuff) is an open-source terminal coding agent with a codebase-indexing product story, an npm CLI install path, and repository folders for agents, CLI, docs, evals, packages, and SDK. Its connector surfaces are MCP, skills, subagents, and memory under .agents.",
    sources: [
      {
        label: "Freebuff website",
        url: "https://freebuff.com/",
      },
      {
        label: "Freebuff repository",
        url: "https://github.com/CodebuffAI/freebuff",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the terminal CLI. Codebuff owns project indexing, code edits, command execution, conversation flow, and product account behavior; agent-connector should only claim the local files and runtime hooks it can verify.",
        bullets: [
          "The npm package and binary were renamed from codebuff to freebuff; the config contract did not move.",
          "The repository contains CLI, agents, docs, evals, packages, and SDK folders.",
          "The product story emphasizes whole-codebase understanding and multi-turn workflows.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "MCP registration is the adapter's runtime surface: sdk/src/agents/load-mcp-config.ts searches <cwd>/.agents/mcp.json, <cwd>/../.agents/mcp.json, and ~/.agents/mcp.json for the mcpServers root key, and the adapter writes that file.",
        bullets: [
          "The lookup order means a parent-directory .agents/mcp.json can serve several sibling projects.",
          "Do not infer additional MCP semantics from the repository's SDK folder alone.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Freebuff is mcp-only in the connector matrix: no user-installable lifecycle hook file is documented, so agent-connector wires no hook bridge. Benchmark, indexing, and terminal workflow behavior stay Freebuff-owned agent logic.",
        bullets: [
          "Runtime interception, if it ever appears, would need a documented hook file or event contract before the coverage chip changes.",
          "Project indexing and code-generation loops are host behavior, not hook semantics.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Content surfaces are wired under .agents: skills as .agents/skills (AgentSkills format, verified in load-skills.ts) and subagents as project-scoped .agents/<id>.ts AgentDefinition modules that default-export one object. Memory is AGENTS.md. Slash commands are not a host surface.",
        bullets: [
          "Subagent modules must not use type-only imports; the host loads them as plain modules.",
          "The .codebuffignore file is a host-specific project filter, separate from these content surfaces.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is fast whole-codebase indexing plus a public benchmark and SDK story around terminal coding. That makes Freebuff useful for comparing codebase-awareness architectures against editor-first agents.",
        bullets: [
          "BuffBench and generated workflow evaluation are product/evaluation surfaces.",
          "The SDK folder is a future integration signal, not automatic connector SDK compatibility.",
        ],
      },
    ],
    limits: [
      "MCP and hook claims need local adapter or source evidence rather than product-page inference.",
      "The public website is marketing-heavy; detailed internals should come from repository/docs review.",
      "SDK presence should be separated from implemented agent-connector support.",
    ],
  },
  "continue": {
    status: "researched",
    sequence: 30,
    checkedAt: "2026-07-06",
    summary:
      "Continue is an open-source coding-agent family with CLI, VS Code, JetBrains, docs, and a repository that currently signals a maintenance or transition status. The connector row should treat it as a multi-surface host while marking current source status clearly.",
    sources: [
      {
        label: "Continue repository",
        url: "https://github.com/continuedev/continue",
      },
      {
        label: "Continue docs",
        url: "https://docs.continue.dev/",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "Continue spans CLI and IDE surfaces, so the adapter row should identify whether a local CLI process, VS Code extension, JetBrains plugin, or hosted configuration service is the actual target. The page should not hide its current repository status.",
        bullets: [
          "The public repository describes an open-source coding agent.",
          "Continue has historically shipped VS Code, JetBrains, and CLI-facing surfaces.",
          "If the repository is read-only or redirected, that status should be visible beside compatibility claims.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Continue is tracked as a json-stdio host in the connector matrix, but MCP support should be described with path-specific evidence. IDE and CLI surfaces may not share one MCP configuration model.",
        bullets: [
          "A VS Code extension can manage tools through editor storage or configuration.",
          "A CLI can manage tools through local project or user files.",
          "Docs and source must be checked before moving MCP support between surfaces.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "agent-connector treats Continue as a json-stdio hook host. Hook claims should remain local-adapter claims unless current Continue docs expose an independent extension or CLI lifecycle API.",
        bullets: [
          "IDE command palettes and chat actions are not lifecycle hooks by themselves.",
          "Current maintenance status increases the need for regression tests before expanding hooks.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Continue content surfaces include assistant configuration, model and context providers, custom instructions, prompts, commands, and IDE-specific state. The archive should keep CLI and IDE content paths separate.",
        bullets: [
          "Model/provider configuration is central to Continue's identity.",
          "Prompt and context-provider setup is content architecture, not only UI preference.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "Continue's host-only affordance is broad IDE and CLI configurability around open-source agent workflows. The study page should preserve it as a source-visible architecture while marking any current maintenance transition.",
        bullets: [
          "JetBrains and VS Code support should not be collapsed into the CLI adapter row.",
          "Hosted or hub-style configuration should be separated from local files.",
        ],
      },
    ],
    limits: [
      "Verify current repository maintenance status before publishing compatibility language.",
      "Do not assume CLI, VS Code, and JetBrains share storage.",
      "Hook support should stay adapter-backed unless Continue docs expose a native hook API.",
    ],
  },
  kiro: {
    status: "researched",
    sequence: 39,
    checkedAt: "2026-07-06",
    summary:
      "Kiro is an AWS-backed agentic IDE with product tabs for CLI, IDE, Web, Mobile, and Enterprise. Its docs emphasize specs, steering, hooks, agentic chat, MCP servers, privacy controls, and a downloads-based IDE setup.",
    sources: [
      {
        label: "Kiro docs",
        url: "https://kiro.dev/docs/",
      },
      {
        label: "Kiro website",
        url: "https://kiro.dev/",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the IDE/extension style host, while Kiro product navigation now also exposes CLI, Web, Mobile, and Enterprise surfaces. agent-connector should show Kiro as multi-surface and avoid assuming one file contract across all clients.",
        bullets: [
          "Kiro docs describe it as an agentic IDE.",
          "The docs list specs, steering, hooks, agentic chat, MCP servers, and privacy controls as core capabilities.",
          "The product is AWS-branded through site terms and policy links.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Kiro documents MCP Servers as a core capability for connecting external tools and data sources. The connector should keep MCP configuration scoped to the Kiro surface being targeted, especially now that CLI and IDE tabs both exist.",
        bullets: [
          "MCP server support is host-native rather than inferred.",
          "CLI and IDE configuration paths should be verified independently.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Kiro explicitly documents hooks as intelligent triggers for repetitive tasks. This makes Kiro an important extension-host case for hook SDK design, but event-level claims should stay tied to Kiro docs and adapter tests.",
        bullets: [
          "Hooks are a documented core capability, not only a generic extension concept.",
          "Specs and steering should remain separate from hook triggers.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Kiro content surfaces include specs, steering, agentic chat context, MCP server setup, and privacy controls. Specs are especially important because they turn planning artifacts into a first-class host workflow.",
        bullets: [
          "Specs plan and build features through structured specifications.",
          "Steering guides the AI with custom rules and context.",
          "Agentic chat is the conversational execution surface.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "Kiro's host-only affordance is the combination of specs, steering, hooks, MCP, and multi-client product surfaces under a single agentic IDE brand. This makes it a strong reference for extension and IDE architecture.",
        bullets: [
          "The row should show IDE, CLI, Web, Mobile, and Enterprise as host nature labels where supported.",
          "Amazon Q Developer CLI successor context should be kept related but separate.",
        ],
      },
    ],
    limits: [
      "Do not transfer Amazon Q Developer CLI behavior into Kiro without Kiro-specific evidence.",
      "Verify CLI and IDE storage separately before claiming shared adapter support.",
      "Hook event details require current Kiro documentation, not generic trigger language.",
    ],
  },
  goose: {
    status: "researched",
    sequence: 26,
    checkedAt: "2026-07-06",
    summary:
      "goose is now under the Agentic AI Foundation and presents itself as a native open-source AI agent with desktop app, CLI, API, provider support, ACP, MCP extensions, and custom distributions across code and non-code workflows.",
    sources: [
      {
        label: "goose repository",
        url: "https://github.com/aaif-goose/goose",
      },
      {
        label: "goose docs",
        url: "https://goose-docs.ai/",
      },
      {
        label: "Agentic AI Foundation",
        url: "https://aaif.io/",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the local goose agent runtime, which can appear as a desktop app, CLI, or API. goose owns provider selection, local execution, extension loading, and app state; agent-connector writes only verified host-native surfaces.",
        bullets: [
          "The repository says the project moved from Block to the Agentic AI Foundation.",
          "goose is described as desktop app, CLI, and API for code, workflows, and other tasks.",
          "The implementation is Rust-based and cross-platform.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "MCP is central to goose: the README says it connects to many extensions through the Model Context Protocol. Extension loading should be treated as a first-class host architecture axis.",
        bullets: [
          "goose also supports ACP for using existing Claude, ChatGPT, or Gemini subscriptions.",
          "MCP extensions should be distinguished from model providers.",
          "Custom distributions can preconfigure providers, extensions, and branding.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "agent-connector currently models goose as a json-stdio host, but public goose docs foreground extensions and providers more than lifecycle hooks. Hook claims should therefore remain adapter-backed and source-checked.",
        bullets: [
          "MCP extension support does not automatically imply connector lifecycle hooks.",
          "The API surface may allow embedding, but embedding APIs are not the same as hook files.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "goose content surfaces include hints, AGENTS.md-style files in the repository, workflow recipes, custom distributions, provider settings, and extension configuration. These are broader than coding-only command prompts.",
        bullets: [
          "The repository contains `.goosehints`, AGENTS.md, workflow_recipes, and custom distro documentation.",
          "The agent is explicitly positioned for research, writing, automation, data analysis, and coding.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "goose's host-only affordance is open extensibility under AAIF: desktop, CLI, API, custom distributions, many providers, ACP, and MCP extensions. It is a major open-source reference for multi-surface local agents.",
        bullets: [
          "AAIF transition status should remain visible in the source review ledger.",
          "Custom distributions are packaging architecture, not ordinary connector config.",
        ],
      },
    ],
    limits: [
      "Desktop, CLI, and API surfaces should remain distinct when claiming adapter support.",
      "MCP extension support should not be described as lifecycle hook support without evidence.",
      "AAIF transition may change docs URLs and source ownership over time.",
    ],
  },
  "open-interpreter": {
    status: "researched",
    sequence: 34,
    checkedAt: "2026-09-07",
    summary:
      "Open Interpreter is an open-source terminal coding agent for local and open models. The current interpreter (also installed as i) is a Rust fork of OpenAI's Codex, so its native config is Codex-shaped: a TOML config.toml under an isolated home, $INTERPRETER_HOME (default ~/.openinterpreter), never $CODEX_HOME.",
    sources: [
      {
        label: "Open Interpreter repository",
        url: "https://github.com/openinterpreter/openinterpreter",
      },
      {
        label: "Open Interpreter docs",
        url: "https://docs.openinterpreter.com/getting-started/introduction",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the local interpreter CLI. As a Codex fork it inherits Codex's agent loop, permission model, and config layout, but runs under its own home: the binary honors only $INTERPRETER_HOME, and the install script sets CODEX_COMMAND_NAME=interpreter and CODEX_HOME=$INTERPRETER_HOME.",
        bullets: [
          "The README states that Open Interpreter is a fork of OpenAI's Codex; the repository positions it for open models such as DeepSeek, Kimi, and Qwen.",
          "The isolated home keeps an Open Interpreter install from reading or writing a Codex install on the same machine.",
          "The row stays CLI-scoped rather than editor-extension scoped.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "MCP is the one wired surface. The adapter writes [mcp_servers.<id>] tables into $INTERPRETER_HOME/config.toml: stdio servers carry command, args, and env; streamable-HTTP servers carry url with optional bearer_token_env_var and http_headers, the same shapes as codex-rs/config mcp_edit and mcp_types.",
        bullets: [
          "Local execution authority is the central risk boundary for any MCP tool exposed here.",
          "TOML has no interpolation, so environment references resolve to literals at install time.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Open Interpreter is mcp-only in the connector matrix. As a Codex fork the host inherits Codex's hook subsystem, so hooks are host-native, but the interpreter product's live wire contract and on-disk hook directory are not first-party verified, so agent-connector leaves hooks unwired rather than guess. That is a coverage ceiling, not a host limitation.",
        bullets: [
          "The same reasoning keeps commands, skills, subagents, and AGENTS.md memory host-native but unwired.",
          "Provider and model choice are host settings rather than hook semantics.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Inherited from Codex: prompts and skills directories, agent definitions, and AGENTS.md memory exist in the host, but none is wired by the adapter until the interpreter product documents its own paths. Local code execution keeps the safety concerns of a terminal agent rather than a cloud-hosted IDE.",
        bullets: [
          "Open-model support makes provider configuration a first-class study axis.",
          "Local code execution requires clear permission and sandbox language on the page.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is local openness: users can run with open models, control their environment, and execute code locally. That makes Open Interpreter useful for comparing terminal agents against cloud and editor hosts.",
        bullets: [
          "Model openness is a host affordance, not an agent-connector feature.",
          "Computer-use behavior should remain separate from MCP and hook coverage.",
        ],
      },
    ],
    limits: [
      "Local code execution authority needs careful safety wording.",
      "Hook, command, skill, subagent, and memory paths are inherited from Codex and stay unwired until verified against the interpreter product itself.",
      "Open model support is not equivalent to connector plugin support.",
    ],
  },
  "antigravity-cli": {
    status: "researched",
    sequence: 17,
    checkedAt: "2026-07-06",
    summary:
      "Antigravity CLI is the terminal surface of Google's Antigravity platform. Current public evidence indicates a migration path from Gemini CLI toward Antigravity, with CLI, desktop app, SDK, plugins, hooks, skills, and subagents positioned as a unified multi-agent backend.",
    sources: [
      {
        label: "Google Antigravity",
        url: "https://antigravity.google/",
      },
      {
        label: "Antigravity 2.0 migration report",
        url: "https://www.techradar.com/pro/google-is-making-gemini-cli-users-switch-to-its-new-antigravity-2-0-so-what-will-it-mean-for-you",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the Antigravity terminal CLI, but the current product story is a unified backend shared with a desktop app and SDK. The page must separate the CLI install target from the larger Antigravity platform.",
        bullets: [
          "Public reporting says Gemini CLI users were directed toward Antigravity CLI in 2026.",
          "The CLI is described as part of a multi-agent platform rather than a standalone terminal experiment.",
          "The official Antigravity site is source-light, so internal claims should remain cautious.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "MCP should be documented only where the Antigravity CLI or local adapter exposes a concrete registration contract. Migration from Gemini CLI does not automatically transfer Gemini's settings shape or MCP behavior.",
        bullets: [
          "A unified backend may change how tools are registered across desktop and CLI.",
          "The connector archive should avoid reusing Gemini CLI file paths for Antigravity.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Current public reporting says hooks were among the Gemini CLI features ported to Antigravity, but event details need official Antigravity docs or adapter tests before they become hard claims.",
        bullets: [
          "The page can mark hooks as a reported/platform capability with evidence boundaries.",
          "Exact event names and payloads should not be copied from Gemini CLI by analogy.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Antigravity CLI content surfaces should be separated into skills, subagents, plugins, extensions, SDK workflows, and CLI prompts. These are likely platform-level artifacts rather than simple terminal prompt files.",
        bullets: [
          "Agent Skills and Subagents are reported as supported migration features.",
          "Extensions becoming Antigravity plugins suggests a marketplace or plugin packaging layer.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is Google's unified multi-agent platform direction: CLI, desktop, SDK, plugins, background tasks, and migration from Gemini CLI. The row should be marked source-light until official docs expose stable local contracts.",
        bullets: [
          "The Antigravity CLI and desktop app should stay separate rows in the coverage page.",
          "Migration status is important for users who expect Gemini CLI parity.",
        ],
      },
    ],
    limits: [
      "Official Antigravity docs were source-light during this pass.",
      "Do not import Gemini CLI paths or event schemas without Antigravity-specific evidence.",
      "Reported migration features need fresh source checks before release claims expand.",
    ],
  },
  antigravity: {
    status: "researched",
    sequence: 18,
    checkedAt: "2026-07-06",
    summary:
      "Google Antigravity is a desktop and platform host distinct from Antigravity CLI. It should be described as an agent-first multi-agent development platform with desktop app, SDK, plugins, hooks, skills, subagents, and a unified backend, while keeping source-light caveats visible.",
    sources: [
      {
        label: "Google Antigravity",
        url: "https://antigravity.google/",
      },
      {
        label: "Antigravity 2.0 report",
        url: "https://www.techradar.com/pro/google-is-making-gemini-cli-users-switch-to-its-new-antigravity-2-0-so-what-will-it-mean-for-you",
      },
      {
        label: "Antigravity desktop report",
        url: "https://timesofindia.indiatimes.com/technology/tech-news/google-antigravity-2-0-goes-after-claude-code-and-openai-codex-with-a-full-agent-first-rebuild/articleshow/131209670.cms",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the desktop/platform host, not the CLI row. Antigravity owns multi-agent task orchestration, desktop UX, backend session state, SDK workflows, and plugin distribution.",
        bullets: [
          "Public reporting describes Antigravity 2.0 as an agent-first platform with an updated desktop app.",
          "The CLI exists beside the desktop app and should not be merged into one adapter claim.",
          "The official site is a source-light SPA in this pass.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "MCP support should remain evidence-bounded. Antigravity's plugin and extension language may cover tools, but the page should not infer local MCP file registration without current official docs.",
        bullets: [
          "Desktop tool registration may be platform-managed rather than file-managed.",
          "SDK workflows could expose integrations that are not MCP servers.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Hooks are reported as part of the Antigravity migration feature set, but the desktop host needs its own event documentation before agent-connector treats it as a wired hook target.",
        bullets: [
          "Desktop hooks may differ from CLI hooks if a unified backend mediates events.",
          "Hook support should be tagged as source-light until official event schemas are available.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Antigravity content surfaces include skills, subagents, plugins, SDK workflows, background tasks, desktop sessions, and migration artifacts from Gemini CLI. These should be displayed as platform surfaces.",
        bullets: [
          "Plugins are the renamed extension distribution surface in public reporting.",
          "Skills and subagents are separate from MCP and should get their own inventory chips.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is a Google-managed multi-agent platform intended to replace or absorb Gemini CLI and Code Assist individual usage. The archive should make migration and source-light status unmistakable.",
        bullets: [
          "Desktop app, CLI, SDK, and plugins should appear as separate architecture nodes.",
          "Source-light status protects the page from overstating unpublished internals.",
        ],
      },
    ],
    limits: [
      "Official Antigravity documentation was not sufficiently text-exposed in this pass.",
      "Keep desktop and CLI rows separate.",
      "Reported migration claims need fresh checks before release or compatibility promises.",
    ],
  },
  "jetbrains-copilot": {
    status: "researched",
    sequence: 42,
    checkedAt: "2026-07-06",
    summary:
      "GitHub Copilot in JetBrains IDEs is an IDE-plugin host row. It belongs beside, but not inside, VS Code Copilot and Copilot CLI because JetBrains owns the plugin runtime, editor UI, tool windows, authentication, and IDE-specific availability.",
    sources: [
      {
        label: "GitHub Copilot in JetBrains",
        url: "https://docs.github.com/en/copilot/concepts/agents/copilot-in-jetbrains",
      },
      {
        label: "JetBrains Copilot plugin",
        url: "https://plugins.jetbrains.com/plugin/17718-github-copilot--your-ai-pair-programmer",
      },
      {
        label: "GitHub Copilot docs",
        url: "https://docs.github.com/en/copilot",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the JetBrains plugin environment. JetBrains owns IDE lifecycle, editor APIs, project model, tool windows, plugin settings, and authentication UI, while GitHub owns Copilot service behavior.",
        bullets: [
          "This row is distinct from VS Code Copilot because the extension host and storage model differ.",
          "It is also distinct from Copilot CLI because the CLI session harness runs outside the IDE.",
          "The GitHub docs list Copilot in JetBrains as its own agent concept surface.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "MCP support for JetBrains Copilot should not be assumed from VS Code Copilot or Copilot CLI. The page should only claim MCP when GitHub or JetBrains documentation exposes a JetBrains-specific configuration path.",
        bullets: [
          "IDE-specific plugin settings may differ from VS Code settings JSON or Copilot CLI config.",
          "MCP in Copilot cloud or CLI does not automatically imply JetBrains plugin support.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "The current connector matrix treats JetBrains Copilot conservatively. GitHub's broader Copilot platform documents hooks, but a JetBrains plugin hook bridge requires JetBrains-specific implementation evidence.",
        bullets: [
          "GitHub Copilot SDK hooks are not the same as JetBrains plugin hooks.",
          "Editor actions and tool windows are host UI, not lifecycle hook files.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "JetBrains Copilot content surfaces include IDE chat, code suggestions, project context, GitHub authentication, and potentially custom instructions or agent features as GitHub exposes them to the plugin.",
        bullets: [
          "JetBrains project model and indexing differ from VS Code workspace context.",
          "Any repository instruction support should be verified through GitHub's IDE-specific docs.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is JetBrains Marketplace distribution and deep integration with IntelliJ-platform IDEs. The archive should show it as an extension/IDE host rather than a terminal or GitHub cloud agent.",
        bullets: [
          "Marketplace installation, IDE compatibility, and plugin versioning are central support facts.",
          "Copilot service features may arrive at different times across JetBrains, VS Code, CLI, and GitHub web.",
        ],
      },
    ],
    limits: [
      "Do not inherit VS Code or Copilot CLI storage paths.",
      "Do not claim hooks or MCP without JetBrains-specific evidence.",
      "Distinguish JetBrains plugin runtime from GitHub Copilot service features.",
    ],
  },
  kimi: {
    status: "researched",
    sequence: 24,
    checkedAt: "2026-07-06",
    summary:
      "Kimi is best treated as a source-light model/product host row in this archive. Moonshot AI's Kimi family is strong in long-context and coding benchmarks, but connector claims must distinguish Kimi model/provider capability from a concrete local agent host.",
    sources: [
      {
        label: "Kimi website",
        url: "https://www.kimi.com/",
      },
      {
        label: "Moonshot AI platform",
        url: "https://platform.moonshot.ai/",
      },
      {
        label: "Kimi K2 report",
        url: "https://arxiv.org/abs/2504.07491",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter row should be cautious: public Kimi evidence is strongest for Moonshot AI models, chatbot, API platform, and agentic model capabilities, while local host mechanics need separate confirmation.",
        bullets: [
          "Kimi should not be treated like a fully source-visible terminal host without local runtime evidence.",
          "Provider capability and agent-host capability are different architecture layers.",
          "Open Interpreter and other hosts may use Kimi models without becoming Kimi hosts.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "MCP support should stay adapter-backed. A model API or chatbot product does not by itself define a host-side MCP server registry, and the archive should not infer one from Kimi's coding benchmark strength.",
        bullets: [
          "If a Kimi Code or local Kimi agent exposes MCP, it needs a separate source pass.",
          "Moonshot API provider setup is not equivalent to MCP tool server setup.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "agent-connector currently records Kimi through local adapter evidence rather than rich public hook docs. Hook claims should therefore be minimal and tied to tests, not to model-family agentic performance.",
        bullets: [
          "Long-context reasoning and tool-call capability are model traits, not hook APIs.",
          "A local hook bridge needs an executable host surface.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Kimi content surfaces should be described as model/API context, chatbot sessions, long-context documents, and any separately verified local agent configuration. The page should teach the model-vs-host distinction explicitly.",
        bullets: [
          "Kimi's long-context identity is relevant to context architecture.",
          "Local memory, commands, and skills need host evidence beyond model docs.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is mostly provider-side today: Kimi models, API platform, chatbot, and agentic benchmark positioning. That makes this row useful for explaining why model providers and agent hosts should not be conflated.",
        bullets: [
          "The coverage page should mark source-light status clearly.",
          "If a concrete Kimi Code host matures, it should receive a separate deeper source pass.",
        ],
      },
    ],
    limits: [
      "Kimi model capability is not proof of local host capability.",
      "MCP, hooks, commands, skills, and memory need local host evidence before upgrade.",
      "Current source pass should be treated as source-light compared with open CLI projects.",
    ],
  },
  codebuddy: {
    status: "researched",
    sequence: 1,
    checkedAt: "2026-07-06",
    summary:
      "CodeBuddy is a Tencent Cloud source-light host row spanning IDE, plugin, and CLI product surfaces. Public text points to an end-to-end product/design/code/deploy workflow, but local connector claims must stay tied to adapter evidence.",
    sources: [
      {
        label: "CodeBuddy website",
        url: "https://www.codebuddy.ai/",
      },
      {
        label: "CodeBuddy overview",
        url: "https://zh.wikipedia.org/wiki/Codebuddy",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the local CLI-style CodeBuddy surface, while the public product spans plugin, standalone IDE, and CLI channels. The architecture page should mark this as source-light because the website does not expose full local internals in text.",
        bullets: [
          "Public descriptions tie CodeBuddy to Tencent Cloud, Hunyuan, DeepSeek, and product-to-deploy workflows.",
          "The CLI channel is relevant to DevOps and terminal users, but exact storage paths need adapter evidence.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "MCP support should be described only through the current connector adapter and verified local files. Cloud ecosystem integration and deployment automation are not the same as an MCP server registry.",
        bullets: [
          "Tencent Cloud integration may involve cloud credentials and deployment APIs.",
          "The page should avoid inferring local MCP semantics from broad product workflow claims.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "agent-connector tracks CodeBuddy as a json-stdio host, so hook support should be framed as an adapter bridge. Product agents such as planning, design, coding, and deploy roles should not be treated as lifecycle hook events.",
        bullets: [
          "Multi-agent product roles are orchestration concepts.",
          "Hook payloads and decisions need local runtime tests before event-level claims expand.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "CodeBuddy content surfaces are likely split across product requirements, design artifacts, code generation, deployment plans, and CLI prompts. The archive should distinguish those cloud/product artifacts from local commands, skills, and memory.",
        bullets: [
          "The product-to-deploy flow is useful for workflow architecture study.",
          "Source-light status means concrete file locations should remain conservative.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is Tencent Cloud's end-to-end agent workflow across idea, design, implementation, and deployment. That should be visible without overstating unsupported local connector surfaces.",
        bullets: [
          "Cloud deployment and design-to-code features are host product capabilities.",
          "The page should show CodeBuddy as a multi-surface product host, not just a terminal process.",
        ],
      },
    ],
    limits: [
      "Source-light official pages require cautious internals language.",
      "Cloud workflow claims are not local MCP or hook contracts.",
      "Exact CLI config paths should remain adapter-backed.",
    ],
  },
  "mimo-code": {
    status: "researched",
    sequence: 11,
    checkedAt: "2026-07-06",
    summary:
      "MiMoCode is a terminal-native Xiaomi MiMo coding assistant with agents, persistent SQLite FTS5 memory, checkpoint reconstruction, task tracking, subagents, goal judging, compose mode, voice input, and JSON/JSONC config files.",
    sources: [
      {
        label: "MiMo-Code repository",
        url: "https://github.com/XiaomiMiMo/MiMo-Code",
      },
      {
        label: "MiMo website",
        url: "https://mimo.xiaomi.com/",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the terminal-native `mimo` CLI. MiMoCode owns the TUI, command execution, Git operations, provider selection, memory injection, subagent scheduling, checkpointing, and voice input.",
        bullets: [
          "The repository describes MiMoCode as terminal-native and able to read/write code, run commands, and manage Git.",
          "Install paths include curl, npm, and Windows PowerShell.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "MiMoCode is tracked as a TypeScript-plugin style host in the connector matrix, but the public README emphasizes memory, agents, provider setup, and workflow modes more than MCP. MCP claims should stay adapter-backed.",
        bullets: [
          "Configuration files live under `.mimocode` for projects and `~/.config/mimocode` globally.",
          "Provider setup supports MiMo Auto, Xiaomi MiMo Platform, Claude Code import, and custom OpenAI-compatible APIs.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "MiMoCode's runtime has rich lifecycle concepts, but connector hook support should be described through the TypeScript/plugin adapter. Subagent lifecycle tracking, checkpointing, and goal judging are host behavior unless exposed as plugin events.",
        bullets: [
          "The `/goal` command uses an independent judge model to prevent premature stops.",
          "Subagents can run in parallel with lifecycle tracking, cancellation, and background execution.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "MiMoCode content surfaces are explicit: `MEMORY.md`, `checkpoint.md`, `notes.md`, per-task progress logs, compose-mode skills, task trees, and config files. This row should be a reference for memory architecture.",
        bullets: [
          "Memory is powered by SQLite FTS5 and injected on resume.",
          "`/dream` extracts persistent knowledge and `/distill` packages repeated workflows into skills, subagents, or commands.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is a self-improving terminal workflow with persistent memory, dream/distill loops, voice, task hierarchy, and compose mode. Those features should be visible beside connector chips.",
        bullets: [
          "MiMo models also work in other agents such as Cursor, Cline, and Zed.",
          "Voice and ASR features are host capabilities, not generic connector features.",
        ],
      },
    ],
    limits: [
      "Do not equate MiMo model provider support in other tools with MiMoCode host support.",
      "MCP and hook specifics should stay adapter-tested.",
      "Memory semantics are MiMoCode-owned and richer than generic connector memory.",
    ],
  },
  "kilo-cli": {
    status: "researched",
    sequence: 12,
    checkedAt: "2026-07-06",
    summary:
      "Kilo CLI is the terminal surface of Kilo Code 1.0, built from the kilocode repository and documented as sharing underlying technology with the IDE extensions while exposing MCP, ACP, agents, sessions, remote relay, plugins, permissions, config, and local reviews.",
    sources: [
      {
        label: "Kilo CLI docs",
        url: "https://kilo.ai/docs/code-with-ai/platforms/cli",
      },
      {
        label: "Kilo Code repository",
        url: "https://github.com/Kilo-Org/kilocode",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the `kilo` CLI/TUI, not the Kilo VS Code or JetBrains extension row. Kilo CLI owns terminal navigation, provider credentials, sessions, daemon/server modes, remote relay, and GitHub commands.",
        bullets: [
          "Install uses `npm install -g @kilocode/cli` or platform release binaries.",
          "The docs say the CLI uses the same underlying technology as IDE extensions, but storage still needs CLI-specific handling.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Kilo CLI has explicit MCP commands and config: `kilo mcp`, `/mcps`, and `mcp` entries in `kilo.jsonc`. This should be documented as a terminal-native MCP surface.",
        bullets: [
          "Global config is `~/.config/kilo/kilo.json[c]` with project config in `./kilo.json[c]` or `./.kilo/`.",
          "Kilo can also start an ACP server with `kilo acp`.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Kilo CLI is a TypeScript-plugin style host in the connector matrix, but public CLI docs emphasize plugins, permissions, and command surfaces. Hook event claims should stay tied to adapter bridge behavior and source tests.",
        bullets: [
          "`kilo plugin <module>` installs a plugin and updates config.",
          "Permission rules can allow, ask, or deny tools globally or with granular patterns.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Kilo CLI content surfaces include agent modes, Agent Skills, custom agents, AGENTS.md initialization, sessions, review commands, model/provider config, TUI config, attention notifications, and external-directory permissions.",
        bullets: [
          "Built-in modes include Architect, Ask, Debug, Orchestrator, and custom modes.",
          "`/review` supports local code review of staged, unstaged, branches, commits, and PRs.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is the CLI as an OpenCode-lineage, multi-model, MCP/ACP/plugin-capable terminal agent that also connects to Kilo Gateway, Cloud Agent, and Console surfaces.",
        bullets: [
          "Kilo CLI should be separate from the Kilo extension row even when technologies overlap.",
          "Remote relay and gateway profile features may require account state.",
        ],
      },
    ],
    limits: [
      "Do not assume Kilo CLI and IDE extension storage are identical.",
      "OpenCode lineage should not replace Kilo-specific verification.",
      "Plugin and hook behavior need adapter-level tests before event details expand.",
    ],
  },
  mux: {
    status: "researched",
    sequence: 37,
    checkedAt: "2026-07-06",
    summary:
      "Mux is a Coder desktop/browser host for isolated, parallel agentic development. It provides isolated workspaces, multi-model support, central git status, rich markdown outputs, MCP servers, policy, secrets, hooks, workspaces, CLI, ACP editor integration, and mobile-responsive server UI.",
    sources: [
      {
        label: "Mux documentation",
        url: "https://mux.coder.com/",
      },
      {
        label: "Mux repository",
        url: "https://github.com/coder/mux",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the Mux desktop/browser orchestration host, not a single underlying agent. Mux owns isolated workspaces, git status overview, model selection, browser/desktop UI, server mode, and agent management.",
        bullets: [
          "Docs describe Mux as running parallel coding agents, each with its own isolated workspace.",
          "The repository describes a desktop app for isolated, parallel agentic development.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Mux docs list MCP Servers as a configuration topic. The page should treat MCP as a host-level tool integration for workspaces and agents, not as a capability inherited from a downstream agent by default.",
        bullets: [
          "Project secrets and policy files are adjacent configuration surfaces.",
          "MCP should be diagrammed beside workspace isolation and runtime policy.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Mux docs expose hooks as a workspace/runtime topic, but agent-connector currently tracks Mux as MCP-only. The architecture page should explain host hooks without upgrading connector hook coverage until adapter support exists.",
        bullets: [
          "Host hooks may shape workspace workflows rather than CLI tool events.",
          "Downstream agents can have their own hooks, but those are separate layers.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Mux content surfaces include workspaces, forking workspaces, `.muxignore`, compaction, runtimes, instruction files, agent skills, plan mode, system prompt, and Best-of-N orchestration.",
        bullets: [
          "Instruction files and agent skills are agent content surfaces.",
          "Compaction and context boundaries are host-level context management features.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is parallel orchestration: isolated workspaces, central git status, multi-model support, desktop/browser UI, mobile-responsive server mode, and ACP editor integrations.",
        bullets: [
          "Mux is useful for studying multi-agent control planes rather than single-agent CLIs.",
          "AGPL licensing and Coder ownership should be visible source facts.",
        ],
      },
    ],
    limits: [
      "Do not promote Mux host hooks into connector hook coverage while the row remains MCP-only.",
      "Downstream agent capabilities should remain separated from Mux orchestration.",
      "Workspace and server-mode features may have account or deployment assumptions.",
    ],
  },
  pi: {
    status: "researched",
    sequence: 21,
    checkedAt: "2026-07-06",
    summary:
      "Pi is a minimal, aggressively extensible agent harness with CLI/TUI, print/JSON, RPC, and SDK modes. It intentionally skips baked-in features like MCP, subagents, plan mode, and permission popups so users can build or install them as extensions, skills, prompts, and packages.",
    sources: [
      {
        label: "Pi website",
        url: "https://pi.dev/",
      },
      {
        label: "Pi repository",
        url: "https://github.com/earendil-works/pi",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the Pi CLI/TUI harness. Pi owns the minimal agent loop, provider API, TUI, session tree, print/JSON mode, RPC mode, SDK embedding, and extension runtime.",
        bullets: [
          "Pi positions itself as a minimal harness that adapts to user workflows.",
          "It can run interactive, print/JSON, RPC, and SDK modes.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Pi explicitly says the core has no built-in MCP, and that users can build CLI tools with READMEs or build an extension that adds MCP support. This makes Pi a crucial counterexample in the coverage matrix.",
        bullets: [
          "MCP should not be counted as native Pi host support by default.",
          "OMP can represent a package or extension surface that changes what Pi provides.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Pi extensions are TypeScript modules with access to tools, commands, keyboard shortcuts, events, and the full TUI. That is the host's extension boundary and should be kept distinct from generic lifecycle hook support.",
        bullets: [
          "Dynamic context injection can be implemented by extensions before each turn.",
          "Permission gates, path protection, sandboxing, and custom status bars are extension examples.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Pi content includes AGENTS.md, SYSTEM.md, skills, prompt templates, themes, session trees, branchable/shareable history, extensions, packages, and dynamic context filters.",
        bullets: [
          "AGENTS.md loads from `~/.pi/agent/`, parent directories, and the current directory.",
          "Skills use progressive disclosure and prompt templates expand through slash commands.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is minimalism plus customization. Pi packages bundle extensions, skills, prompts, and themes, installable from npm or git, which makes the package layer the marketplace story.",
        bullets: [
          "Pi intentionally leaves many features to packages or extensions.",
          "Session sharing to gists and tree history are host collaboration features.",
        ],
      },
    ],
    limits: [
      "Pi core explicitly does not include built-in MCP.",
      "Subagents, plan mode, and permissions may exist through packages, not core host guarantees.",
      "OMP should be documented as a separate package/profile row rather than plain Pi core.",
    ],
  },
  omp: {
    status: "researched",
    sequence: 22,
    checkedAt: "2026-07-06",
    summary:
      "Oh My Pi (OMP) is best understood as a Pi package/profile ecosystem row rather than Pi core. It sits on Pi's extension, skills, prompts, themes, RPC, and SDK primitives to provide opinionated workflows and connector-style package surfaces.",
    sources: [
      {
        label: "Pi website",
        url: "https://pi.dev/",
      },
      {
        label: "Pi repository",
        url: "https://github.com/earendil-works/pi",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the OMP layer on top of Pi's harness. Pi owns the executable runtime, while OMP should be documented as packaged configuration, extensions, skills, prompts, or workflows.",
        bullets: [
          "Pi packages can be installed from npm or git.",
          "The OMP row should not duplicate Pi core unless the package changes behavior.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Because Pi core has no built-in MCP, OMP must be explicit about whether it adds MCP through an extension or package. The page should not count Pi's extensibility as OMP MCP support without package evidence.",
        bullets: [
          "MCP integration is named as something users can build with extensions.",
          "Connector coverage should distinguish package-provided behavior from core host behavior.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "OMP should be treated as a TypeScript extension/package surface over Pi. Hook-like behavior can come from extension events, dynamic context injection, keyboard shortcuts, and tool wrappers rather than a fixed core event contract.",
        bullets: [
          "Extensions can access commands, tools, keyboard shortcuts, events, and the TUI.",
          "Agent-connector should document OMP as package-mediated unless a stable event schema exists.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "OMP content is expected to live in Pi's package primitives: skills, prompt templates, themes, extensions, SYSTEM.md, AGENTS.md, and dynamic context handlers. This makes it a distribution row.",
        bullets: [
          "Pi package install can bundle multiple artifact types together.",
          "Workflow opinion belongs to OMP, while runtime mechanics belong to Pi.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is package distribution over a minimal harness. OMP should be used to teach how package overlays can change a host's surface without changing the core runtime.",
        bullets: [
          "This row helps separate base host from ecosystem overlay.",
          "The package layer can provide stronger defaults while preserving Pi's minimalism.",
        ],
      },
    ],
    limits: [
      "Do not count Pi core limitations or features as OMP package behavior without evidence.",
      "MCP and hook support should be package-specific.",
      "Keep OMP and Pi diagrams related but distinct.",
    ],
  },
  crush: {
    status: "researched",
    sequence: 25,
    checkedAt: "2026-07-06",
    summary:
      "Crush is a Charm terminal coding agent with multi-model support, session-based workflows, LSP context, MCP over stdio/http/sse, cross-platform terminal support, project/global JSON config, environment expansion, and built-in configuration skills.",
    sources: [
      {
        label: "Crush repository",
        url: "https://github.com/charmbracelet/crush",
      },
      {
        label: "Crush website",
        url: "https://charm.land/crush/",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the Crush terminal runtime. Crush owns the TUI, session state, LSP context, provider/model switching, package installs, cross-platform behavior, and Charm ecosystem integration.",
        bullets: [
          "Crush supports macOS, Linux, Windows PowerShell/WSL, Android, FreeBSD, OpenBSD, and NetBSD.",
          "It can switch LLMs mid-session while preserving context.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Crush has explicit MCP support over `stdio`, `http`, and `sse`, with shell-style value expansion in command, args, env, headers, and URL. That makes its MCP surface stronger than many source-light hosts.",
        bullets: [
          "Config priority is `.crush.json`, `crush.json`, then `$HOME/.config/crush/crush.json`.",
          "Unset variables and required variable syntax are handled by Crush's embedded shell expansion.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "agent-connector tracks Crush as a json-stdio hook host. Public source also shows a `docs/hooks` folder, so hook claims should be expanded from source review rather than generic terminal behavior.",
        bullets: [
          "Hook docs in the repository make this a good candidate for deeper event-level analysis.",
          "LSP and MCP should remain separate from lifecycle hooks.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Crush content surfaces include project/global config, LSP definitions, provider settings, context paths, TUI options, AGENTS.md, `.agents/skills`, and built-in `crush-config` skill behavior.",
        bullets: [
          "The repository includes `.agents/skills`, `AGENTS.md`, `crush.json`, and schema files.",
          "LSP context makes editor-like code intelligence available from the terminal.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is a polished Charm terminal stack: portable TUI, broad package-manager installs, LSP-aware context, MCP transport variety, and a strong open-source repository.",
        bullets: [
          "Charm ecosystem packaging should be visible as a support surface.",
          "Crush is a good reference for terminal-first but IDE-like context design.",
        ],
      },
    ],
    limits: [
      "Hook event details should be sourced from Crush's hook docs before adapter expansion.",
      "MCP support is strong but does not replace separate hook verification.",
      "Provider model lists may change quickly.",
    ],
  },
  nemoclaw: {
    status: "researched",
    sequence: 27,
    checkedAt: "2026-07-06",
    summary:
      "NVIDIA NemoClaw is a managed inference and OpenShell sandbox host for running agents such as Hermes and OpenClaw more securely. Its architecture centers on sandbox lifecycle, network policy, MCP servers, plugins, workspace files, and managed inference.",
    sources: [
      {
        label: "NemoClaw docs",
        url: "https://docs.nvidia.com/nemoclaw/latest/",
      },
      {
        label: "NemoClaw repository",
        url: "https://github.com/NVIDIA/NemoClaw",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is NemoClaw as a sandbox and managed-inference host, not the downstream Hermes or OpenClaw agent alone. NemoClaw owns OpenShell, sandbox lifecycle, network policy, inference routing, and monitoring.",
        bullets: [
          "Docs are organized separately for OpenClaw agents and Hermes agents.",
          "The repository describes running agents inside NVIDIA OpenShell with managed inference.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "NemoClaw docs include setup for MCP servers under sandbox management. The page should describe MCP in relation to sandbox lifecycle, workspace files, and network policy rather than ordinary local config.",
        bullets: [
          "MCP servers run inside or beside managed sandbox contexts.",
          "Network policy approval and sandbox hardening can constrain tool access.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "NemoClaw is tracked as a TypeScript-plugin style host, but the host-specific control point is sandbox/runtime policy. Hook-like behavior should be separated from network policy, runtime controls, and downstream agent hooks.",
        bullets: [
          "Runtime controls and network request approval are host safety surfaces.",
          "Downstream Hermes or OpenClaw hooks remain their own runtime layers.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "NemoClaw content surfaces include declarative multi-agent manifests, task-specific subagents, workspace files, plugins, MCP servers, prompts, skills, network policies, and sandbox backup/restore state.",
        bullets: [
          "The docs include prompts, MCP, and skills resources.",
          "Architecture details and host files/state deserve a dedicated diagram node.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is managed and auditable execution: OpenShell sandboxing, network policy, managed inference, remote GPU deployment, Brev web UI, monitoring, and plugin installation.",
        bullets: [
          "This row should teach sandbox-first agent architecture.",
          "Security and trusted-computing-base docs are central source material.",
        ],
      },
    ],
    limits: [
      "Do not conflate NemoClaw with OpenClaw or Hermes runtime internals.",
      "MCP and plugin behavior should be interpreted through sandbox policy.",
      "Managed inference may depend on NVIDIA infrastructure or credentials.",
    ],
  },
  openclaw: {
    status: "researched",
    sequence: 28,
    checkedAt: "2026-07-06",
    summary:
      "OpenClaw is a personal AI assistant host positioned as cross-OS and cross-platform, with a large TypeScript-centered repository, Swift/Kotlin client presence, and NemoClaw integration for secure OpenShell execution.",
    sources: [
      {
        label: "OpenClaw repository",
        url: "https://github.com/openclaw/openclaw",
      },
      {
        label: "OpenClaw website",
        url: "https://openclaw.ai/",
      },
      {
        label: "NemoClaw docs for OpenClaw",
        url: "https://docs.nvidia.com/nemoclaw/latest/",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is OpenClaw as a personal assistant host, while NemoClaw can provide a sandboxed NVIDIA OpenShell environment around it. The page should show both standalone and managed execution possibilities.",
        bullets: [
          "The repository positions OpenClaw as a personal assistant for any OS and platform.",
          "Language mix suggests desktop/mobile/client surfaces beyond a terminal-only tool.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "OpenClaw MCP behavior should be documented through direct OpenClaw source or through NemoClaw's managed MCP setup when running under that host. Those are two different layers.",
        bullets: [
          "NemoClaw can set up MCP servers around OpenClaw agents.",
          "Standalone OpenClaw tool registration needs OpenClaw-specific source evidence.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "agent-connector tracks OpenClaw as a TypeScript-plugin style host. Hook claims should be tied to OpenClaw's plugin/event source, while NemoClaw runtime policy should remain a separate managed-host layer.",
        bullets: [
          "OpenClaw plugin behavior should not be replaced by NemoClaw sandbox controls.",
          "Cross-platform UI clients may not expose the same hook surface.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "OpenClaw content surfaces likely span assistant state, plugins, prompts, platform clients, user data, and managed execution files. The archive should preserve the own-your-data angle without inventing exact paths.",
        bullets: [
          "The repository topics include own-your-data and personal assistant positioning.",
          "NemoClaw docs add workspace files, plugins, and prompts/skills when managed.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is personal cross-platform assistant architecture plus optional secure managed execution through NemoClaw. This makes OpenClaw useful for studying assistant hosts beyond coding-only CLIs.",
        bullets: [
          "Swift and Kotlin source share hints at native app surfaces.",
          "Managed execution should be shown as an optional surrounding host.",
        ],
      },
    ],
    limits: [
      "Separate standalone OpenClaw from NemoClaw-managed OpenClaw.",
      "Cross-platform claims should not imply one shared config path.",
      "Plugin and hook details need OpenClaw-specific source review before expansion.",
    ],
  },
  "grok-build": {
    status: "researched",
    sequence: 43,
    checkedAt: "2026-09-07",
    summary:
      "Grok Build is xAI's official open-source coding agent: a Rust harness plus terminal UI installed as `grok`. It keeps every writable surface under $GROK_HOME (default ~/.grok) with TOML config, a Claude-compatible hook directory, flat markdown commands, Anthropic-format skills, markdown subagents, and AGENTS.md project rules.",
    sources: [
      {
        label: "xai-org/grok-build repository",
        url: "https://github.com/xai-org/grok-build",
      },
      {
        label: "Grok Build user guide (in-repo docs)",
        url: "https://github.com/xai-org/grok-build/tree/main/crates/codegen/xai-grok-pager/docs/user-guide",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the Grok Build CLI process. The host owns the model loop, permission system, folder trust, and the TUI; agent-connector writes only the files the user guide documents under $GROK_HOME and <project>/.grok.",
        bullets: [
          "Project-scope config.toml contributes exactly [mcp_servers], [plugins], [permission], and [mcp] max_output_bytes; every other table is read from the user file only.",
          "Project hooks require folder trust; user hooks are always trusted.",
          "This is not the community Grok CLI: same default directory, different vendor, product, and config file.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "MCP servers live in TOML under [mcp_servers.<name>] with stdio keys (command, args, env, enabled, startup_timeout_sec, tool_timeout_sec) or remote keys (url, headers). TOML has no interpolation, so environment references resolve to literals at install time.",
        bullets: [
          "User scope: $GROK_HOME/config.toml. Project scope: <project>/.grok/config.toml.",
          "Detection keys on config.toml so the shared ~/.grok directory is never misreported as a Grok CLI install.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Hooks are JSON files in $GROK_HOME/hooks/*.json or <project>/.grok/hooks/*.json using the Claude-compatible { hooks: { <Event>: [ { matcher, hooks: [ { type: \"command\", command, timeout } ] } ] } } shape. agent-connector writes its own file instead of merging into the user's config.toml [[hooks.<Event>]] block.",
        bullets: [
          "Twelve PascalCase events map 1:1 to canonical names, from SessionStart to PostCompact.",
          "StopFailure, StopCancelled, and PermissionDenied have no canonical analog and ride the nativeHooks escape hatch.",
          "PermissionRequest stays unset: PermissionDenied fires after the denial and is documented as non-blocking.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Commands are flat markdown files whose filename stem is the slash-command name, skills are <name>/SKILL.md with Anthropic-format frontmatter, and subagents are agents/<name>.md with name, description, tools, and model frontmatter.",
        bullets: [
          "Memory is AGENTS.md loaded from the repo root down to the cwd, deeper files winning; user scope adds $GROK_HOME/rules/*.md.",
          "Commands are prompt templates with no shell-exec affordance, so the actions surface is a host N/A rather than an adapter gap.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "Grok Build has a native [ui.status_line] type=\"command\" surface that receives JSON on stdin. The host supports it, the adapter does not write it yet, so it is the one genuine coverage gap on this row.",
        bullets: [
          "A [plugins] table exists in project config, but no marketplace driver is wired for it.",
          "Official xAI ownership is the affordance to highlight against the community Grok CLI row.",
        ],
      },
    ],
    limits: [
      "Statusline is host-native but unwired; the page must show it as an adapter gap, not as unsupported.",
      "Facts come from the in-repo user guide and hook event schema; product docs outside the repository were not reviewed.",
      "Do not merge this row with grok-cli even though both default to ~/.grok.",
    ],
  },
  "grok-cli": {
    status: "researched",
    sequence: 32,
    checkedAt: "2026-07-06",
    summary:
      "Grok CLI is a community open-source terminal coding agent for the xAI Grok API. It exposes interactive and headless modes, JSON event streaming, subagents by default, Telegram remote control, scheduling, MCP, skills, custom subagents, hooks, media generation, and a macOS computer subagent.",
    sources: [
      {
        label: "Grok CLI repository",
        url: "https://github.com/superagent-ai/grok-cli",
      },
      {
        label: "xAI API",
        url: "https://x.ai/api",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the community Grok CLI process, not xAI's official product. Grok CLI owns the OpenTUI terminal UI, Bun runtime, headless mode, session state, schedules, and Telegram bridge.",
        bullets: [
          "The README states the project is community-built and not affiliated with xAI.",
          "Headless mode can emit newline-delimited JSON step events.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Grok CLI supports MCP servers configured through `/mcps` in the TUI or `.grok/settings.json` under `mcpServers`. This is a concrete terminal-native MCP surface.",
        bullets: [
          "MCP is listed alongside skills, sessions, headless mode, and custom subagents.",
          "API key state lives in env, `.env`, CLI flags, or `~/.grok/user-settings.json`.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Grok CLI documents hooks that execute shell commands at key lifecycle events and configures them in `~/.grok/user-settings.json`. This makes it a strong json-stdio hook host.",
        bullets: [
          "The README shows `PreToolUse` hooks with matchers and command entries.",
          "Hooks can enforce policy, run linters, trigger tests, or log activity.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Grok CLI content includes `.agents/skills`, `~/.agents/skills`, custom foreground subagents in `~/.grok/user-settings.json`, schedules, generated media, computer screenshots, and persistent sessions.",
        bullets: [
          "Built-in subagents include task delegation and a computer subagent.",
          "Telegram remote control pairs a phone with a running CLI process.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is Grok API alignment: live X search, web search, media generation, speech-to-text remote control, batch API runs, and community TypeScript hackability.",
        bullets: [
          "The macOS computer subagent depends on accessibility permissions.",
          "Community status should stay visible so users do not assume official xAI support.",
        ],
      },
    ],
    limits: [
      "Community project status must be explicit.",
      "Computer subagent support is macOS-targeted in current docs.",
      "xAI API model names and pricing can change quickly.",
    ],
  },
  junie: {
    status: "researched",
    sequence: 35,
    checkedAt: "2026-07-06",
    summary:
      "Junie is JetBrains' LLM-agnostic coding agent that runs from terminal, IDE, or CI/CD. It supports JetBrains account login, API keys, BYOK providers, channelized installers, GitHub Action setup, issue/PR/CI workflows, and JetBrains service terms.",
    sources: [
      {
        label: "Junie repository",
        url: "https://github.com/JetBrains/junie",
      },
      {
        label: "Junie website",
        url: "https://junie.jetbrains.com/",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target should distinguish Junie terminal, IDE, and CI/CD surfaces. JetBrains owns account login, installer channels, service terms, and IDE integration, while the CLI process owns local task execution.",
        bullets: [
          "The README says Junie lives in terminal, integrates with IDE and CI/CD pipelines.",
          "Install channels include stable, EAP, nightly, and experimental.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Junie is tracked as MCP-only in the connector matrix. MCP or tool configuration should be described conservatively unless JetBrains documents a local server registry for the specific terminal or IDE surface.",
        bullets: [
          "BYOK providers include Anthropic, OpenAI, Google, xAI, OpenRouter, and Copilot.",
          "Provider flexibility is not the same as MCP server registration.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "Junie workflows include GitHub Action setup and CI/CD interactions, but those should not be described as lifecycle hooks unless Junie exposes a hook API or generated file surface.",
        bullets: [
          "`/install-github-action` sets up GitHub automation.",
          "Issue, PR, and CI reactions are workflow integrations rather than local hook events.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Junie content surfaces include natural-language tasks, IDE context, CI/CD workflows, GitHub Action setup, authentication methods, channel registries, and any prompt or configuration templates in the repository.",
        bullets: [
          "The repository includes templates and install scripts rather than full product source.",
          "BYOK and JetBrains account flows are important setup surfaces.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is JetBrains distribution across terminal, IDE, and CI/CD with official account and BYOK support. The architecture should show it as a JetBrains platform agent, not a generic CLI.",
        bullets: [
          "The JetBrains brand and service terms are support boundaries.",
          "GitHub automation is a host workflow surface.",
        ],
      },
    ],
    limits: [
      "MCP-only coverage should not imply hook support.",
      "Terminal, IDE, and CI/CD surfaces need separate verification.",
      "The repository is installer/configuration oriented, so internals claims should stay cautious.",
    ],
  },
  "mistral-vibe": {
    status: "researched",
    sequence: 36,
    checkedAt: "2026-07-06",
    summary:
      "Mistral Vibe is Mistral's open-source CLI coding assistant with interactive chat, file and shell tools, todo tracking, user questions, subagent delegation, project-aware context, skills, custom slash commands, MCP server configuration, config.toml, ACP editor support, and notifications.",
    sources: [
      {
        label: "Mistral Vibe repository",
        url: "https://github.com/mistralai/mistral-vibe",
      },
      {
        label: "Mistral AI",
        url: "https://mistral.ai/",
      },
    ],
    sections: [
      {
        title: "Runtime boundary",
        body:
          "The adapter target is the Vibe CLI process. Vibe owns Python packaging, interactive chat, terminal state, project scanning, Git status context, approval prompts, config home, and ACP-facing editor integrations.",
        bullets: [
          "The README calls Vibe Mistral's open-source CLI coding assistant.",
          "It officially targets UNIX environments while also working on Windows.",
        ],
      },
      {
        title: "MCP registration",
        body:
          "Vibe documents MCP Server Configuration as part of its configuration system. The page should represent MCP through Vibe's `config.toml` and `VIBE_HOME` layout rather than a generic MCP file.",
        bullets: [
          "Default home is `~/.vibe/`, with `VIBE_HOME` override.",
          "The home directory contains config, env, agents, prompts, tools, and logs.",
        ],
      },
      {
        title: "Hook bridge",
        body:
          "agent-connector currently tracks Mistral Vibe as MCP-only. Vibe has tool approvals and interactive questions, but the page should not claim lifecycle hooks without a native hook API or adapter bridge.",
        bullets: [
          "Tool execution approval is a safety prompt, not a hook event.",
          "Subagent delegation through `task` is host behavior separate from hooks.",
        ],
      },
      {
        title: "Content surfaces",
        body:
          "Vibe content surfaces include custom system prompts, custom agent configurations, skills, custom slash commands via skills, tools, prompts, logs, session data, and multimodal file attachments.",
        bullets: [
          "Built-in tools include read/write/edit, bash, grep, todo management, questions, and task delegation.",
          "ACP lets compatible editors and IDEs use Vibe.",
        ],
      },
      {
        title: "Marketplace and host-only affordances",
        body:
          "The host-only affordance is a Mistral-owned open-source CLI with project-aware context, approvals, notifications, ACP editor support, and configurable model/tool behavior through simple files.",
        bullets: [
          "Telemetry and crash reporting can be disabled in config.",
          "Update checks query PyPI at most once per day during a session.",
        ],
      },
    ],
    limits: [
      "MCP support should remain Vibe-config specific.",
      "Do not treat approvals or questions as lifecycle hook support.",
      "Windows support exists but UNIX is the officially targeted environment.",
    ],
  },
};

function platformSequence(platform: Platform) {
  const index = platforms.findIndex((candidate) => candidate.id === platform.id);
  return index >= 0 ? index + 1 : 0;
}

function sourcePassSection(review: NonNullable<ReturnType<typeof hostSourceReviewNote>>) {
  return {
    title: "Source pass",
    body:
      "Current source review findings are kept as the first architecture section so readers can separate external evidence from the generated local coverage model.",
    bullets: review.findings,
  };
}

function axisSections(platform: Platform): ArchitectureSection[] {
  return hostArchitectureAxes(platform).map((axis) => ({
    title: axis.title,
    body: axis.body,
    bullets: axis.bullets,
  }));
}

function sourceReviewedArchitectureNote(platform: Platform): AgentArchitectureNote | undefined {
  const review = hostSourceReviewNote(platform);
  const sourceUrl = hostLinkUrl(platform.id);
  if (!review || !sourceUrl) return undefined;

  const gaps = gapRows(platform);

  return {
    status: "researched",
    sequence: platformSequence(platform),
    checkedAt: review.checkedAt,
    summary: hostSpecificBrief(platform),
    sources: [
      {
        label: review.source,
        url: sourceUrl,
      },
    ],
    sections: [
      sourcePassSection(review),
      ...axisSections(platform),
    ],
    limits: [
      `Coverage ceiling: ${hostCoverageCeiling(platform)}`,
      gaps.length > 0
        ? `Visible native gaps remain: ${gaps.map((gap) => gap.label).join(", ")}.`
        : "No visible host-native gap is recorded in the current coverage matrix.",
      "This profile does not infer proprietary or undocumented runtime internals beyond the linked source review and local adapter evidence.",
    ],
  };
}

export function architectureNoteForPlatform(
  platform: Platform,
): AgentArchitectureNote | undefined {
  const manual = architectureNotes[platform.id];
  if (manual) {
    const review = hostSourceReviewNote(platform);
    const sourceUrl = hostLinkUrl(platform.id);
    const sourcePassAlreadyPresent = manual.sections.some(
      (section) => section.title === "Source pass",
    );
    const sources =
      review && sourceUrl && !manual.sources.some((source) => source.url === sourceUrl)
        ? [...manual.sources, { label: review.source, url: sourceUrl }]
        : manual.sources;
    const sections =
      review && !sourcePassAlreadyPresent
        ? [sourcePassSection(review), ...manual.sections]
        : manual.sections;
    const titles = new Set(sections.map((section) => section.title));
    const missingAxisSections = axisSections(platform).filter(
      (section) => !titles.has(section.title),
    );

    return {
      ...manual,
      checkedAt: review?.checkedAt ?? manual.checkedAt,
      sequence: platformSequence(platform),
      sources,
      sections: [...sections, ...missingAxisSections],
    };
  }
  return sourceReviewedArchitectureNote(platform);
}
