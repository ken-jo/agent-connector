import * as React from "react";
import { Link } from "react-router-dom";
import { CodeBlock } from "@/components/ui/code-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyButton } from "@/components/ui/copy-button";
import { Badge } from "@/components/ui/badge";
import {
  adapterCapabilityCount,
  adapterCapabilityProfiles,
  generatedSurfaceKeys,
  generatedSurfaceLabels,
  type GeneratedSurfaceKey,
} from "@/adapter-capabilities.generated";
// `platformCount` is the internal full adapter registry. Public-facing guide
// prose uses the production-relevant coverage count instead, so low-star OSS
// hosts can stay supported without becoming marketing noise.
import { platformCount } from "@/data";
import {
  PUBLIC_OSS_STAR_FLOOR,
  publicCapabilityProfiles,
  publicCoverageCount,
} from "@/components/coverage-wall/public-coverage";
import {
  DocSection,
  H3,
  H4,
  Lead,
  P,
  C,
  List,
  LI,
  Callout,
} from "./prose";
import { DocsTable, FieldTable, Th, Td, Code } from "./DocsTable";
import * as S from "./snippets";
import {
  connectorConfigFields,
  resolvedConnectorFields,
  serverDefFields,
  hookEventRows,
  hookResponseFields,
  decisionSemantics,
  paradigmRows,
  commandDefFields,
  skillDefFields,
  subagentDefFields,
  memoryDefFields,
  memoryTargetRows,
  surfaceSupportRows,
  telemetryConfigFields,
  confidenceSources,
  platformOverrideFields,
  configPatchFields,
  cliCommands,
  internalEntrypoints,
  sharedFlags,
  jsonStdioPlatforms,
  mcpOnlyPlatforms,
  tsPluginPlatforms,
  doctorStatusRows,
  configErrorRows,
  syncedPlatforms,
  telemetryEmptyRows,
  telemetryAxes,
  telemetrySurfaces,
  telemetryReconcileRows,
  eventScopeRows,
  surfaceKindRows,
  surfaceLeaderboardColumns,
  type PlatformEntry,
} from "./docs-data";
import { HooksGuideSection } from "./HooksGuide";
import { PackagingGuideSection } from "./PackagingGuide";

const mcp101ArchitectureFlow = `User asks a question
        |
        v
Agent host (chat app / IDE / CLI)
        |
        | 1. Host shows the model available MCP capabilities
        |    - tools: actions the model may request
        |    - resources: readable context
        |    - prompts: reusable task templates
        v
Model decides: "I should call schema_summary"
        |
        | 2. Host applies its approval / policy / UI rules
        v
MCP client inside the host
        |
        | 3. JSON-RPC over stdio or Streamable HTTP
        v
Your MCP server process
        |
        | 4. Validate arguments, call your app/database/API
        v
Tool result content
        |
        | 5. Host gives result back to the model
        v
Model writes the final answer to the user`;

const mcp101ServerLifecycleFlow = `Host starts server process
  -> server connects to stdio or Streamable HTTP transport
  -> host sends initialize with its client capabilities
  -> server replies with protocol version + server capabilities
  -> host requests tools/list, resources/list, or prompts/list
  -> user asks a task
  -> model selects a tool
  -> host applies approval / policy
  -> host sends tools/call
  -> server validates input
  -> server runs your handler
  -> server returns content + optional structuredContent
  -> host gives result to the model`;

const mcp101ToolCallFlow = `tools/list
  Host: "What tools do you provide?"
  Server: [{ name, title?, description, inputSchema, outputSchema? }]

tools/call
  Host: "Call schema_summary with { table: 'users' }"
  Server:
    1. Check the tool name
    2. Validate the arguments
    3. Run only the allowed operation
    4. Return compact text content
    5. Include structuredContent when the host/model benefits from JSON
    6. Throw a clear error for bad input`;

const mcp101HookFlow = `Host lifecycle event
  -> adapter normalizes host-specific payload
  -> connector hook handler receives one event shape
  -> handler returns a response
  -> adapter translates response back to host-native format
  -> host continues, blocks, warns, or adds context`;

const connectorConceptsFlow = `Plain MCP server works in one host
        |
        v
defineConnector({ server, optional surfaces })
        |
        v
agent-connector installer detects selected hosts
        |
        v
Per-host adapters render native config
  - MCP server registration
  - hook bridge where the host supports hooks
  - commands / skills / subagents / memory files
  - statusline / actions affordances where wired
        |
        v
doctor verifies the installed shape per host`;

const hostHooksParadigmFlow = `Connector declares a normalized hook handler
        |
        v
Target host adapter decides the hook paradigm
        |
        +-- json-stdio: host config calls the home-bin hook command
        |
        +-- ts-plugin: generated plugin module imports/dispatches handlers
        |
        +-- mcp-only: no host hook layer, so hooks skip with a warning
        |
        v
Handler returns context / allow / block / warn where supported`;

const statuslineFlow = `Host UI asks for a statusline render
        |
        v
Adapter calls agent-connector statusline runtime
        |
        v
statusline.render(ctx) returns short text
        |
        v
Host displays it in its native HUD/statusline area`;

const actionsFlow = `User invokes a host action
        |
        v
Host affordance calls the agent-connector action entrypoint
        |
        v
Runtime resolves connector + action id
        |
        v
action.run(ctx) executes deliberate user command
        |
        v
Result is returned to the host affordance`;

const specialSurfacesFlow = `Static content surfaces
  commands  -> host slash-command files
  skills    -> host skill directories
  subagents -> host agent definitions
  memory    -> host rules / memory files

Runtime handler surfaces
  server     -> MCP tools/resources/prompts
  hooks      -> host lifecycle callbacks
  statusline -> host UI render callback
  actions    -> user-invoked action handlers`;

const mcp101ServerSnippet = `// my-mcp-server.mjs
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "acme-db", version: "0.1.0" });

server.registerTool(
  "schema_summary",
  {
    title: "Schema summary",
    description: "Return a short, read-only summary of the database schema.",
    inputSchema: {
      table: z.string().min(1).optional().describe("Optional table name"),
    },
    outputSchema: {
      summary: z.string(),
      table: z.string().optional(),
    },
  },
  async ({ table }) => {
    const structuredContent = {
      table,
      summary: table
        ? \`Schema summary for \${table}: id, email, created_at\`
        : "Schema summary for all tables: users, orders, invoices",
    };

    return {
      structuredContent,
      content: [{ type: "text", text: structuredContent.summary }],
    };
  },
);

await server.connect(new StdioServerTransport());`;

const mcpFirstServerSetupSnippet = `mkdir acme-db-mcp
cd acme-db-mcp
npm init -y
npm install @modelcontextprotocol/sdk@^1.29.0 zod@^3`;

const mcpInspectorSnippet = `npx -y @modelcontextprotocol/inspector node ./my-mcp-server.mjs

# In Inspector:
# 1. Connect to the stdio server.
# 2. Open Tools.
# 3. Call schema_summary with:
#    { "table": "users" }`;

const mcp101PackageSnippet = `{
  "name": "@acme/acme-db-mcp",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.25.0"
  }
}`;

const mcp101HostConfigSnippet = `{
  "mcpServers": {
    "acme-db": {
      "command": "node",
      "args": ["/absolute/path/to/acme-db-mcp/my-mcp-server.mjs"]
    }
  }
}`;

const mcp101AgentConnectorDropSnippet = `// agent-connector.config.mjs
import { fileURLToPath } from "node:url";
import { defineConnector } from "@ken-jo/agent-connector/sdk";

const serverPath = fileURLToPath(new URL("./my-mcp-server.mjs", import.meta.url));

export default defineConnector({
  server: {
    transport: "stdio",
    command: "node",
    args: [serverPath],
  },
});`;

const mcp101VerifySnippet = `npm install
npx -y @modelcontextprotocol/inspector node ./my-mcp-server.mjs

# Then connect the same absolute node + args pair in one host.
# Success means the host lists schema_summary and one call returns text
# plus structuredContent instead of crashing or writing protocol logs to stdout.`;

const firstHostLaunchFlow = `One host settings file or UI
  -> server name: acme-db
  -> command: node
  -> args: [absolute path to my-mcp-server.mjs]
  -> host starts the process
  -> initialize handshake
  -> tools/list shows schema_summary
  -> one tools/call returns expected result`;

const firstHostWindowsPathSnippet = `{
  "mcpServers": {
    "acme-db": {
      "command": "node",
      "args": ["D:/work/acme-db-mcp/my-mcp-server.mjs"]
    }
  }
}`;

const connectorSurfaceStarterSnippet = `import {
  defineAction,
  defineConnector,
  defineStatusline,
} from "@ken-jo/agent-connector/sdk";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("./my-mcp-server.mjs", import.meta.url));

const statusline = defineStatusline({
  description: "Show acme-db MCP usage state.",
  render(ctx) {
    const calls = ctx.usage?.calls ?? 0;
    return \`acme-db: \${calls} tool calls\`;
  },
});

const refreshIndex = defineAction({
  id: "refresh-index",
  description: "Refresh the local schema index.",
  async run(ctx) {
    return { message: \`Refreshed schema index for \${ctx.host}\` };
  },
});

export default defineConnector({
  server: { transport: "stdio", command: "node", args: [serverPath] },
  statusline,
  actions: [refreshIndex],
});`;

const hookConnectorPolicySnippet = `import {
  defineConnector,
  defineHook,
} from "@ken-jo/agent-connector/sdk";

const guardRiskyWrites = defineHook("PreToolUse", {
  matcher: "Bash|Write|Edit|apply_patch|mcp__acme_db__.*",
  handler(evt) {
    const input = JSON.stringify(evt.toolInput ?? {});

    if (evt.toolName === "Bash" && /\\brm\\s+-rf\\b/.test(input)) {
      return {
        decision: "deny",
        reason: "rm -rf is blocked by acme-db policy.",
      };
    }

    if (evt.toolName.startsWith("mcp__acme_db__")) {
      return {
        decision: "context",
        additionalContext: "acme-db MCP tools are read-only in this connector.",
      };
    }
  },
});

export default defineConnector({
  server: { transport: "stdio", command: "node", args: ["./my-mcp-server.mjs"] },
  hooks: { PreToolUse: guardRiskyWrites },
});`;

const claudeHookSettingsSnippet = `{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "agent-connector hook claude-code PreToolUse --connector acme-db"
          }
        ]
      }
    ]
  }
}`;

const geminiHookSettingsSnippet = `{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "agent-connector hook gemini-cli PreToolUse --connector acme-db"
          }
        ]
      }
    ],
    "AfterTool": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "agent-connector hook gemini-cli PostToolUse --connector acme-db"
          }
        ]
      }
    ]
  }
}`;

const codexHookSettingsSnippet = `{
  "PreToolUse": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "agent-connector hook codex PreToolUse --connector acme-db"
        }
      ],
      "matcher": "Bash|apply_patch|mcp__acme_db__.*"
    }
  ]
}`;

const opencodePluginShapeSnippet = `// Abridged generated plugin shape; connector authors do not hand-write this file.
export default async function plugin(ctx) {
  const PROJECT_DIR = ctx?.directory ?? process.cwd();

  return {
    "tool.execute.before": async (input, output) => {
      const res = bridge("PreToolUse", {
        toolName: input.tool ?? "",
        toolInput: output?.args ?? {},
        projectDir: PROJECT_DIR,
      });

      if (res?.decision === "deny" || res?.decision === "ask") {
        throw new Error(res.reason || "Blocked by acme-db");
      }
      if (res?.updatedInput && output?.args) {
        Object.assign(output.args, res.updatedInput);
      }
    },
  };
}`;

const statuslineConnectorSnippet = `import { defineConnector, defineStatusline } from "@ken-jo/agent-connector/sdk";

const statusline = defineStatusline({
  description: "Show acme-db connector state.",
  options: {
    refreshInterval: 5,
    maxLines: 2,
  },
  render(ctx) {
    const model = ctx.model?.displayName ?? ctx.model?.id ?? "model";
    const calls = ctx.usage?.calls ?? 0;
    const pct = ctx.context?.percent;
    const context = pct == null ? "" : \` · ctx \${Math.round(pct)}%\`;

    return \`acme-db · \${model} · \${calls} calls\${context}\`;
  },
  hosts: {
    "claude-code": {
      render(ctx) {
        return \`acme-db · \${ctx.cwd ?? ctx.projectDir ?? "workspace"}\`;
      },
    },
    "qwen-code": {
      options: {
        respectUserColors: true,
        hideContextIndicator: true,
      },
    },
  },
});

export default defineConnector({
  server: { transport: "stdio", command: "node", args: ["./my-mcp-server.mjs"] },
  statusline,
});`;

const claudeStatuslineSettingsSnippet = `{
  "statusLine": {
    "type": "command",
    "command": "agent-connector statusline claude-code --connector acme-db",
    "refreshInterval": 5
  }
}`;

const actionConnectorSnippet = `import { defineAction, defineConnector } from "@ken-jo/agent-connector/sdk";

const refreshIndex = defineAction({
  id: "refresh-index",
  label: "Refresh schema index",
  description: "Refresh the local schema index.",
  icon: "refresh-cw",
  placement: "command-palette",
  confirm: {
    title: "Refresh schema index",
    message: "Rebuild the local acme-db schema index now?",
  },
  async run(ctx) {
    await refreshLocalSchemaIndex(ctx.projectDir);
    return { message: \`Refreshed acme-db index for \${ctx.host}\` };
  },
  hosts: {
    warp: {
      label: "Refresh acme-db",
      description: "Refresh the schema index for this Warp workspace.",
      placement: "workflow",
      confirm: false,
      async run(ctx) {
        await refreshLocalSchemaIndex(ctx.projectDir);
        return { message: "Warp workspace index refreshed." };
      },
    },
  },
});

export default defineConnector({
  server: { transport: "stdio", command: "node", args: ["./my-mcp-server.mjs"] },
  actions: [refreshIndex],
});`;

const actionCliSnippet = `# Same action through the universal fallback entrypoint
agent-connector action warp refresh-index --connector acme-db
agent-connector action hermes open-dashboard --connector acme-db

# Prefer this fallback in docs and support runbooks.
# Host-native buttons/commands can call the same entrypoint where wired.`;

const connectorSurfaceOrderFlow = `Plain MCP server works
  -> one host can call one read-only tool
  -> defineConnector({ server })
  -> install/doctor proves host config rendering
  -> add static surfaces when users need reusable context
  -> add hooks for lifecycle policy where hosts support hooks
  -> add statusline for glanceable state
  -> add actions for deliberate user commands`;

const beginnerLabProjectTree = `acme-db-mcp/
  package.json
  my-mcp-server.mjs
  agent-connector.config.mjs
  scripts/
    demo-smoke.mjs`;

const beginnerLabPackageJson = `{
  "name": "@acme/acme-db-mcp",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "demo": "node scripts/demo-smoke.mjs",
    "inspect": "npx -y @modelcontextprotocol/inspector node ./my-mcp-server.mjs"
  },
  "dependencies": {
    "@ken-jo/agent-connector": "^0.4.98",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.25.0"
  }
}`;

const beginnerLabServer = `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const tables = {
  users: ["id", "email", "created_at", "plan"],
  orders: ["id", "user_id", "total_usd", "status"],
  invoices: ["id", "customer_id", "due_date", "paid"],
};

const server = new McpServer({
  name: "acme-db-demo",
  version: "0.1.0",
});

server.registerTool(
  "schema_summary",
  {
    title: "Schema summary",
    description:
      "Return a short read-only schema summary for the demo database. Use this before writing SQL.",
    inputSchema: {
      table: z.enum(["users", "orders", "invoices"]).optional(),
      includeColumns: z.boolean().default(false),
    },
    outputSchema: {
      table: z.string().optional(),
      summary: z.string(),
      columns: z.array(z.string()).optional(),
    },
  },
  async ({ table, includeColumns }) => {
    const tableNames = Object.keys(tables);
    const selected = table ? tables[table] : undefined;
    const structuredContent = {
      table,
      summary: table
        ? \`\${table} has \${selected.length} demo columns.\`
        : \`Demo database has \${tableNames.length} tables: \${tableNames.join(", ")}.\`,
      columns: includeColumns ? selected : undefined,
    };

    return {
      structuredContent,
      content: [{ type: "text", text: structuredContent.summary }],
    };
  },
);

await server.connect(new StdioServerTransport());`;

const beginnerLabSmoke = `import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["./my-mcp-server.mjs"],
});

const client = new Client({
  name: "acme-db-demo-smoke",
  version: "0.1.0",
});

await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((tool) => tool.name).join(", "));

const result = await client.callTool({
  name: "schema_summary",
  arguments: { table: "users", includeColumns: true },
});

console.log("text:", result.content?.[0]?.text);
console.log("structured:", JSON.stringify(result.structuredContent, null, 2));

await client.close();`;

const beginnerLabConnector = `import {
  defineAction,
  defineConnector,
  defineStatusline,
} from "@ken-jo/agent-connector/sdk";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("./my-mcp-server.mjs", import.meta.url));

const statusline = defineStatusline({
  description: "Show the demo connector state.",
  options: { refreshInterval: 5, maxLines: 1 },
  render(ctx) {
    const calls = ctx.usage?.calls ?? 0;
    const host = ctx.host === "unknown" ? "host" : ctx.host;
    return \`acme-db demo · \${host} · \${calls} calls\`;
  },
});

const showTables = defineAction({
  id: "show-demo-tables",
  label: "Show demo tables",
  description: "Print the demo table list.",
  placement: "command-palette",
  run(ctx) {
    return {
      message: \`Demo tables for \${ctx.host}: users, orders, invoices\`,
    };
  },
});

export default defineConnector({
  displayName: "Acme DB Demo",
  server: {
    transport: "stdio",
    command: "node",
    args: [serverPath],
  },
  statusline,
  actions: [showTables],
});`;

const beginnerLabCommands = `npm install
npm run demo
npm run inspect

# After the server works:
npx @ken-jo/agent-connector audit --connector ./agent-connector.config.mjs
npx @ken-jo/agent-connector install --connector ./agent-connector.config.mjs --targets claude-code --dry-run
npx @ken-jo/agent-connector action claude-code show-demo-tables --connector acme-db-demo`;

const beginnerLabHostPrompt = `You have an MCP tool named schema_summary.

Please inspect the users table, explain what columns exist, and suggest one safe
read-only query a beginner could try next.`;

const beginnerLabCustomizeTool = `// Change the catalog first.
const tables = {
  products: ["id", "sku", "name", "price_usd"],
  inventory: ["id", "product_id", "warehouse", "quantity"],
};

// Then update the enum so invalid table names still fail early.
table: z.enum(["products", "inventory"]).optional()`;

function DemoScreenshotFrame({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background shadow-sm">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {eyebrow}
          </div>
          <div className="text-sm font-semibold text-foreground">{title}</div>
        </div>
        <div className="flex gap-1">
          <span className="h-2 w-2 rounded-full bg-red-400" />
          <span className="h-2 w-2 rounded-full bg-amber-400" />
          <span className="h-2 w-2 rounded-full bg-emerald-400" />
        </div>
      </div>
      <div className="min-h-36 bg-card/40 p-4 text-sm text-muted-foreground">
        {children}
      </div>
    </div>
  );
}

const generatedCapabilitySummaryRows: {
  key: GeneratedSurfaceKey;
  label: string;
  count: number;
}[] = generatedSurfaceKeys.map((key) => ({
  key,
  label: generatedSurfaceLabels[key],
  count: adapterCapabilityProfiles.filter((p) => p.surfaces[key]).length,
}));

const publicSurfaceHostNames = (key: GeneratedSurfaceKey): string[] =>
  publicCapabilityProfiles
    .filter((p) => p.surfaces[key])
    .map((p) => p.name);

const statuslineHostNames = publicSurfaceHostNames("statusline");
const actionHostNames = publicSurfaceHostNames("actions");

const hookCrossValidationRows = [
  {
    host: "Claude Code",
    local: "json-stdio adapter, settings.json hooks, claude-code tests",
    external: "Official Claude Code hooks docs",
    url: "https://docs.anthropic.com/en/docs/claude-code/hooks",
  },
  {
    host: "Gemini CLI",
    local: "json-stdio adapter, BeforeTool/AfterTool mapping, gemini-cli tests",
    external: "Official Gemini CLI hooks reference",
    url: "https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md",
  },
  {
    host: "Codex CLI",
    local: "hooks.json adapter, codex tests, command hook dispatcher",
    external: "Official Codex hooks docs",
    url: "https://developers.openai.com/codex/hooks/",
  },
  {
    host: "OpenCode",
    local: "ts-plugin adapter, generated plugin module, opencode tests",
    external: "Official OpenCode plugin docs",
    url: "https://opencode.ai/docs/plugins/",
  },
  {
    host: "MCP-only hosts",
    local: "mcp-only paradigm list is registry-derived and drift-guarded",
    external: "Host MCP docs where available; hooks intentionally unsupported",
    url: "https://docs.warp.dev/knowledge-and-collaboration/mcp",
  },
];

const statuslineCrossValidationRows = [
  {
    host: "Claude Code",
    adapter: "supportsStatusline + settings.json statusLine command",
    evidence: "Official statusLine docs + tests/core/statusline.test.ts",
    url: "https://docs.anthropic.com/en/docs/claude-code/statusline",
  },
  {
    host: "Qwen CLI",
    adapter: "supportsStatusline + ~/.qwen/settings.json ui.statusLine command",
    evidence: "Qwen status-line docs + tests/adapters/qwen-code.test.ts",
    url: "https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/status-line.md",
  },
  {
    host: "Antigravity CLI",
    adapter: "supportsStatusline + agy statusLine { enabled, command }",
    evidence: "Live-verified agy adapter fixture + tests/adapters/antigravity-cli.test.ts",
    url: "https://github.com/google-gemini/gemini-cli",
  },
];

const actionCrossValidationRows = [
  {
    host: "Warp",
    adapter: "supportsActions + owned workflow YAML",
    evidence: "Warp workflows docs + tests/adapters/warp.test.ts",
    url: "https://docs.warp.dev/terminal/entry/yaml-workflows",
  },
  {
    host: "Droid (Factory)",
    adapter: "supportsActions + owned executable command file",
    evidence: "adapter implementation + tests/adapters/droid.test.ts",
  },
  {
    host: "Zed",
    adapter: "supportsActions + .zed/tasks.json task entry",
    evidence: "Zed tasks docs + tests/adapters/zed.test.ts",
    url: "https://zed.dev/docs/tasks",
  },
  {
    host: "Pi",
    adapter: "supportsActions + registerCommand-style action bridge",
    evidence: "adapter implementation + tests/adapters/pi.test.ts",
    url: "https://github.com/earendil-works/pi",
  },
  {
    host: "Kiro",
    adapter: "supportsActions + manual hook-panel action emitter",
    evidence: "adapter implementation + tests/adapters/kiro.test.ts",
    url: "https://kiro.dev",
  },
  {
    host: "Hermes Agent",
    adapter: "supportsActions + Hermes native command bridge",
    evidence: "adapter implementation + tests/adapters/hermes.test.ts",
  },
  {
    host: "Oh My Pi (OMP)",
    adapter: "supportsActions + registerCommand plugin surface",
    evidence: "adapter implementation + tests/adapters/omp.test.ts",
  },
  {
    host: "NVIDIA NemoClaw",
    adapter: "inherits OpenClaw action bridge",
    evidence: "inherited adapter implementation + tests/adapters/nemoclaw.test.ts",
    url: "https://github.com/NVIDIA/NemoClaw",
  },
  {
    host: "OpenClaw",
    adapter: "supportsActions + registerCommand plugin surface",
    evidence: "adapter implementation + tests/adapters/openclaw.test.ts",
    url: "https://github.com/openclaw/openclaw",
  },
];

/* ================================================================== */
/* Getting Started                                                     */
/* ================================================================== */

export function Introduction() {
  return (
    <DocSection id="introduction" eyebrow="Getting Started" title="Introduction">
      <Lead>
        The <strong>MCP-developer track</strong>. You write your MCP server +
        hooks (and optionally commands, skills, subagents, memory){" "}
        <strong>once</strong> with <C>defineConnector(&#123;...&#125;)</C>, then
        deploy across every detected agent platform under your{" "}
        <strong>branded MCP package</strong>. agent-connector is the framework
        underneath; your users should see <C>npx @acme/acme-db-mcp install</C>, not a
        foreground framework brand. You get per-MCP and per-tool token counts
        for <strong>your own wrapped server</strong>.
      </Lead>

      <P>
        Just <strong>use</strong> agent CLIs and have <strong>not</strong>{" "}
        authored a connector?{" "}
        <Link className="underline hover:text-foreground" to="/docs/user">
          See the agent-CLI user track →
        </Link>{" "}
        (one connector-free command — no <C>defineConnector</C>, no install).
      </P>

      <Callout title="The one accuracy-critical line between the tracks" tone="warn">
        &quot;See what <em>your</em> tools cost&quot; (per-MCP / per-tool, from
        your own wrapped server&apos;s serve proxy) is never the same as
        &quot;see what the MCPs you use cost&quot; (only available as
        whole-conversation host totals). The connector-free{" "}
        <Link className="underline hover:text-foreground" to="/docs/user/usage#per-mcp-vs-host">
          <C>usage</C> path
        </Link>{" "}
        cannot itemize per MCP server or tool — the canonical explanation covers
        why and which track gives you per-tool numbers.
      </Callout>

      <H3 id="two-pillars">Two pillars</H3>
      <List>
        <LI>
          <strong>Single-API multi-platform deployment.</strong> One declarative
          + programmatic <C>defineConnector(&#123;...&#125;)</C> → per-platform
          adapters render it into each host&apos;s native MCP registration, hook
          config, and content files; your branded package&apos;s CLI
          installs/syncs/uninstalls every <strong>detected</strong> host.
        </LI>
        <LI>
          <strong>Default per-MCP token telemetry for your own server.</strong>{" "}
          Platform-independent, local-first, privacy-preserving (aggregate
          counts, never content). On by default for the stdio server your
          connector wraps.
        </LI>
      </List>

      <P>
        It generalizes context-mode&apos;s proven adapter layer into a reusable
        framework: where context-mode hardcoded the served identity, here the MCP
        package metadata (<C>package.json</C> <C>name</C>, <C>bin</C>, and{" "}
        <C>mcpName</C>) becomes the source of truth. Public guides focus on{" "}
        <strong>{publicCoverageCount} production-relevant agents</strong>:
        closed-source flagship hosts plus open-source hosts with{" "}
        {PUBLIC_OSS_STAR_FLOOR.toLocaleString()}+ GitHub stars. The internal
        adapter registry can stay broader for compatibility, while install still
        targets only the hosts detected on your machine or the targets you name.
        It is Windows-first (no symlinks, no POSIX-only assumptions).
      </P>
    </DocSection>
  );
}

export function McpBeginnerGuide() {
  return (
    <DocSection id="mcp-beginner" eyebrow="Guides" title="Agent-connector beginner guide">
      <Lead>
        This page is for developers who are new to agent-connector and need the
        MCP concepts underneath it. Start with the protocol roles, then learn
        how agent-connector maps servers, hooks, HUD/statusline, actions,
        commands, skills, subagents, and memory into the host CLIs you target.
      </Lead>

      <Callout title="What MCP is">
        MCP is a standard way for an agent host to talk to external capability
        providers. Your server exposes tools, resources, or prompts; the host
        decides when to show them to the model and when a user must approve a
        call. The protocol is the boundary between those two sides.
      </Callout>

      <P>
        For the canonical protocol reference, keep the{" "}
        <a
          className="underline hover:text-foreground"
          href="https://modelcontextprotocol.io/introduction"
          rel="noreferrer"
          target="_blank"
        >
          official MCP docs
        </a>{" "}
        open while you build. This page is the short practical path for a first
        implementation.
      </P>

      <Callout title="Reference refresh: current MCP docs">
        This guide was refreshed against the official MCP docs for protocol
        version <C>2025-11-25</C> and the npm-published{" "}
        <C>@modelcontextprotocol/sdk</C> <C>1.29.0</C>. For current protocol
        details, keep the{" "}
        <a
          className="underline hover:text-foreground"
          href="https://modelcontextprotocol.io/specification/latest/server/tools"
          rel="noreferrer"
          target="_blank"
        >
          tools spec
        </a>
        ,{" "}
        <a
          className="underline hover:text-foreground"
          href="https://modelcontextprotocol.io/specification/latest/basic/transports"
          rel="noreferrer"
          target="_blank"
        >
          transports spec
        </a>
        , and{" "}
        <a
          className="underline hover:text-foreground"
          href="https://modelcontextprotocol.io/docs/tools/inspector"
          rel="noreferrer"
          target="_blank"
        >
          MCP Inspector
        </a>{" "}
        open while you build.
      </Callout>

      <Callout title="What this Guides track teaches">
        The Guides track is the concept bridge. It explains MCP basics, the
        agent-connector distribution layer, and what each connector surface does
        inside a host CLI: what the model can call, what the host triggers, what
        the user invokes, what the host UI renders, and what files the host
        loads as standing context.
      </Callout>

      <figure className="not-prose mt-8 overflow-hidden rounded-xl border border-border bg-card/40">
        <img
          src="/docs/mcp-beginner-architecture.svg"
          alt="MCP architecture diagram showing a user, agent host, embedded MCP client, transport, MCP server, and application data boundary"
          width={1280}
          height={720}
          className="aspect-video w-full object-cover"
        />
        <figcaption className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          The host owns the conversation. Your MCP server owns capabilities. The
          transport is only the protocol pipe between them.
        </figcaption>
      </figure>

      <H3 id="mcp-architecture-map">Architecture map: who owns what?</H3>
      <P>
        Beginners often confuse the model, the host, and the MCP server. Keep
        them separate. The model decides whether a capability is useful, the host
        mediates approval and sends protocol messages, and your server validates
        input before touching your app, database, or files.
      </P>
      <CodeBlock code={mcp101ArchitectureFlow} language="text" filename="mcp-flow.txt" />

      <H3 id="mcp-terms">1. Learn the nouns before writing code</H3>
      <DocsTable>
        <thead>
          <tr>
            <Th>Term</Th>
            <Th>Meaning</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>
              <Code>MCP server</Code>
            </Td>
            <Td className="text-muted-foreground">
              Your process or remote endpoint. It advertises capabilities and
              handles requests from the host.
            </Td>
          </tr>
          <tr>
            <Td>
              <Code>Host</Code>
            </Td>
            <Td className="text-muted-foreground">
              The agent app that loads the server, shows its capabilities to the
              model, and mediates user approval.
            </Td>
          </tr>
          <tr>
            <Td>
              <Code>Tool</Code>
            </Td>
            <Td className="text-muted-foreground">
              A callable function with a name, description, JSON input schema,
              and result content. Start here; tools are the easiest surface to
              test.
            </Td>
          </tr>
          <tr>
            <Td>
              <Code>Resource</Code>
            </Td>
            <Td className="text-muted-foreground">
              Data the host can read from your server, such as a file-like URI
              or application state. Use it when the model needs context, not an
              action.
            </Td>
          </tr>
          <tr>
            <Td>
              <Code>Prompt</Code>
            </Td>
            <Td className="text-muted-foreground">
              A reusable prompt template your server can offer to the host. It
              is not the same thing as a tool call.
            </Td>
          </tr>
          <tr>
            <Td>
              <Code>Transport</Code>
            </Td>
            <Td className="text-muted-foreground">
              How the host reaches your server. Most local packages use{" "}
              <Code>stdio</Code>; hosted servers usually use Streamable HTTP.
            </Td>
          </tr>
          <tr>
            <Td>
              <Code>structuredContent</Code>
            </Td>
            <Td className="text-muted-foreground">
              Optional JSON returned beside human-readable tool content. Use it
              when the result has a stable shape the host or model should not
              parse out of prose.
            </Td>
          </tr>
          <tr>
            <Td>
              <Code>Roots</Code>
            </Td>
            <Td className="text-muted-foreground">
              Client-provided filesystem boundaries. Servers can use roots to
              understand which workspaces are in scope, but roots are not a
              substitute for server-side validation.
            </Td>
          </tr>
          <tr>
            <Td>
              <Code>Sampling</Code> / <Code>Elicitation</Code>
            </Td>
            <Td className="text-muted-foreground">
              Client features a server can request when supported: sampling asks
              the host/model to generate text; elicitation asks the user for
              more information. Beginners should build tools first.
            </Td>
          </tr>
          <tr>
            <Td>
              <Code>Client</Code>
            </Td>
            <Td className="text-muted-foreground">
              The protocol peer inside the host. Most beginners do not write a
              client; they write a server and let a host connect to it.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <H3 id="mcp-first-surface">2. Pick the first surface deliberately</H3>
      <P>
        MCP has multiple surfaces, but a beginner should not start with all of
        them. Choose the smallest surface that proves the idea, then add the
        others only when the product shape demands them.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Surface</Th>
            <Th>Use it when</Th>
            <Th>Beginner advice</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>
              <Code>Tool</Code>
            </Td>
            <Td className="text-muted-foreground">
              The model needs to ask your app to do something: query, calculate,
              fetch, search, summarize, or mutate.
            </Td>
            <Td className="text-muted-foreground">
              Start here with one read-only tool.
            </Td>
          </tr>
          <tr>
            <Td>
              <Code>Resource</Code>
            </Td>
            <Td className="text-muted-foreground">
              The model needs context that can be read by URI: documents,
              records, workspace state, logs, or generated reports.
            </Td>
            <Td className="text-muted-foreground">
              Add after the first tool works; resources are context, not
              commands.
            </Td>
          </tr>
          <tr>
            <Td>
              <Code>Prompt</Code>
            </Td>
            <Td className="text-muted-foreground">
              You want to offer a reusable workflow prompt with named arguments.
            </Td>
            <Td className="text-muted-foreground">
              Add when users keep asking the same task in the same shape.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <H3 id="mcp-tool-contract">3. Design one good tool contract</H3>
      <P>
        A tool is a product API for an agent. The host and model only see the
        name, description, input schema, and result. Small wording choices change
        whether the model calls the tool correctly.
      </P>
      <List>
        <LI>
          Use an action-oriented, stable name such as <C>schema_summary</C>, not
          a vague name such as <C>run</C> or <C>query</C>.
        </LI>
        <LI>
          Write the description as a decision rule: when should the model call
          this tool, and what will it get back?
        </LI>
        <LI>
          Keep the input schema narrow. Prefer explicit fields and enums over
          free-form strings.
        </LI>
        <LI>
          Return compact, structured text first. Add large payloads, binary
          data, or multi-step workflows later.
        </LI>
        <LI>
          Decide the failure shape now: unknown tool, invalid argument, missing
          auth, timeout, and upstream unavailable should produce predictable
          errors.
        </LI>
      </List>
      <CodeBlock code={mcp101ToolCallFlow} language="text" filename="tool-call-flow.txt" />
      <Callout title="The model requests, your server decides">
        The model may ask for a tool call, but your server is still responsible
        for validation and authorization. Treat every argument as untrusted input
        even when it came through a friendly host UI.
      </Callout>

      <H3 id="mcp-server-first">4. Build the smallest useful server</H3>
      <P>
        Keep the first server boring: one read-only tool, one clear description,
        one input object, and one deterministic text result. Avoid auth,
        databases, writes, background jobs, and remote deployment until this
        local loop works.
      </P>
      <CodeBlock code={mcp101ServerSnippet} language="ts" filename="my-mcp-server.mjs" />

      <Callout title="stdio rule that saves hours" tone="warn">
        A stdio MCP server uses stdout for protocol messages. Do not print debug
        logs to stdout; write logs to stderr or a file. Random stdout text can
        corrupt the JSON-RPC stream and make the host look broken.
      </Callout>

      <H3 id="mcp-server-runtime">How an MCP server actually runs</H3>
      <P>
        An MCP server is not a web page and not an agent. It is a capability
        process. The host starts it, performs a protocol handshake, asks what the
        server can do, and later sends specific requests such as{" "}
        <C>tools/call</C>. Your server should stay boring: declare capability,
        validate input, run the handler, return content, repeat.
      </P>
      <CodeBlock code={mcp101ServerLifecycleFlow} language="text" filename="server-lifecycle.txt" />

      <H4 id="mcp-server-owns">What your server owns</H4>
      <List>
        <LI>
          <strong>Capability metadata.</strong> Tool names, descriptions,
          schemas, resource URIs, and prompt templates.
        </LI>
        <LI>
          <strong>Validation.</strong> Never trust the model to send safe input.
          Check required fields, enum values, paths, identifiers, and sizes.
        </LI>
        <LI>
          <strong>Application boundary.</strong> Your server is the only side
          that should touch your database, local files, third-party APIs, or
          private business logic.
        </LI>
        <LI>
          <strong>Result shape.</strong> Return enough context for the model to
          answer, but avoid dumping raw tables, secrets, or huge payloads.
        </LI>
      </List>

      <H4 id="mcp-host-owns">What the host owns</H4>
      <List>
        <LI>
          It chooses when to expose your server&apos;s capabilities to the model.
        </LI>
        <LI>
          It handles user approval, UI affordances, and host-specific policy.
        </LI>
        <LI>
          It decides how errors are shown to the user and whether a failed tool
          call should be retried.
        </LI>
        <LI>
          It injects the tool result back into the model&apos;s conversation.
        </LI>
      </List>

      <H3 id="mcp-package-identity">5. Add only the package metadata you need</H3>
      <P>
        For a first local server, the package only needs ESM and the MCP SDK.
        Package branding, bins, publishing, and multi-host installers can wait
        until you have one host successfully calling one tool.
      </P>
      <CodeBlock code={mcp101PackageSnippet} language="json" filename="package.json" />

      <H3 id="mcp-connect">6. Connect it to one host</H3>
      <P>
        Every host has its own settings file or UI, but the core launch shape is
        the same: give the host a server name, command, and args. Use an absolute
        path first so you are debugging MCP behavior, not path resolution.
      </P>
      <CodeBlock code={mcp101HostConfigSnippet} language="json" filename="host MCP settings" />

      <H3 id="mcp-verify">7. Verify one call before adding features</H3>
      <P>
        The first success criterion is simple: the host lists the server, sees
        the <C>schema_summary</C> tool, and returns the expected text from one
        call. After that, test bad input, unknown tool names, and restart
        behavior.
      </P>
      <CodeBlock code={mcp101VerifySnippet} language="bash" filename="terminal" />

      <H3 id="mcp-debug-loop">8. Debug in this order</H3>
      <P>
        MCP failures are easier to isolate if you test one boundary at a time.
        Do not change the server, host config, and package shape in the same
        debugging pass.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Check</Th>
            <Th>What it proves</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>node my-mcp-server.mjs</Code>
            </Td>
            <Td className="text-muted-foreground">
              The process starts without import, syntax, or missing dependency
              errors.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">Tool list</Td>
            <Td className="text-muted-foreground">
              The host can launch the server and read its advertised tool
              metadata.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">One valid call</Td>
            <Td className="text-muted-foreground">
              JSON input, handler routing, and result serialization all work.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">One invalid call</Td>
            <Td className="text-muted-foreground">
              Your errors are understandable and do not crash the server.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">Restart host</Td>
            <Td className="text-muted-foreground">
              The config is durable and not dependent on a dev shell session.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <H3 id="mcp-safety">9. Add safety before writes</H3>
      <P>
        Write tools are where MCP stops being a demo and starts touching user
        state. Add them only after read tools are stable, then make approval,
        scoping, and auditability explicit.
      </P>
      <List>
        <LI>
          Keep secrets out of tool arguments and results. Read credentials from
          the environment, keychain, or the host&apos;s secret mechanism.
        </LI>
        <LI>
          Scope dangerous tools to one project, account, database, or workspace
          rather than a whole machine.
        </LI>
        <LI>
          Prefer dry-run and preview outputs before mutation. Show the exact
          thing that will change.
        </LI>
        <LI>
          Treat model-provided text as untrusted input. Validate paths, SQL,
          shell arguments, URLs, and identifiers before use.
        </LI>
        <LI>
          Give every write operation a clear success message and a recoverable
          error message.
        </LI>
      </List>

      <Callout title="Common first MCP mistakes" tone="warn">
        Starting with a write tool. Vague tool descriptions. Loose schemas that
        accept anything. Logging to stdout. Depending on relative paths before
        the server works. Assuming every host exposes the same UI, approval
        flow, or error messages.
      </Callout>

      <H3 id="mcp-hooks">Hooks: the layer around MCP, not the MCP server itself</H3>
      <P>
        Hooks are easy to misunderstand because they feel like tools. They are
        different. A tool is a capability the model can request through MCP. A
        hook is a host lifecycle callback: the host says something happened, and
        your integration can add context, warn, allow, block, or record a
        measurement depending on what that host supports.
      </P>
      <CodeBlock code={mcp101HookFlow} language="text" filename="hook-flow.txt" />

      <H4 id="mcp-hooks-when">When hooks run</H4>
      <P>
        Hook timing is host-specific, but the mental model is stable: hooks run
        around host events. Common examples are session start, before or after a
        tool call, permission request, compacting context, or subagent lifecycle
        events. Some hosts expose many lifecycle points; some expose none.
      </P>

      <H4 id="mcp-hooks-vs-tools">Hooks vs tools</H4>
      <DocsTable>
        <thead>
          <tr>
            <Th>Question</Th>
            <Th>Tool</Th>
            <Th>Hook</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>Who initiates it?</Td>
            <Td className="text-muted-foreground">
              The model requests it through the host.
            </Td>
            <Td className="text-muted-foreground">
              The host emits it when a lifecycle event happens.
            </Td>
          </tr>
          <tr>
            <Td>Is it MCP core?</Td>
            <Td className="text-muted-foreground">Yes, tools are an MCP surface.</Td>
            <Td className="text-muted-foreground">
              No. Hooks are host/plugin surfaces that agent-connector can
              normalize where hosts support them.
            </Td>
          </tr>
          <tr>
            <Td>What should it do?</Td>
            <Td className="text-muted-foreground">
              Perform a bounded capability and return result content.
            </Td>
            <Td className="text-muted-foreground">
              Add policy, context, telemetry, warnings, or host-side decisions
              around an event.
            </Td>
          </tr>
          <tr>
            <Td>Beginner rule</Td>
            <Td className="text-muted-foreground">
              Build one read-only tool first.
            </Td>
            <Td className="text-muted-foreground">
              Add hooks only after the MCP server is working in one host.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <Callout title="Do not put core safety only in hooks" tone="warn">
        Hooks are not universal across hosts. If an operation must be safe, put
        the hard validation in the MCP server handler itself. Hooks can add
        extra host-side policy, but they should not be the only line of defense.
      </Callout>

      <H3 id="mcp-next">Add agent-connector only after the server works</H3>
      <P>
        Once your neutral MCP server works in one host, agent-connector becomes
        the distribution layer: one declaration can render that same server into
        many host configs and add optional telemetry, skills, hooks, and install
        checks. It should not be the first thing you debug.
      </P>
      <CodeBlock
        code={mcp101AgentConnectorDropSnippet}
        language="ts"
        filename="agent-connector.config.mjs"
      />
      <P>
        After that, move to the{" "}
        <Link className="underline hover:text-foreground" to="/docs/guides/beginner-demo-lab">
          beginner demo lab
        </Link>
        ,{" "}
        <Link className="underline hover:text-foreground" to="/docs/guides/first-mcp-server">
          Build your first MCP server
        </Link>
        ,{" "}
        <Link className="underline hover:text-foreground" to="/docs/guides/connect-first-host">
          Connect your first host
        </Link>
        , or{" "}
        <Link className="underline hover:text-foreground" to="/docs/dev/quick-start">
          Quick start
        </Link>{" "}
        for the framework-specific flow. You can also{" "}
        <Link className="underline hover:text-foreground" to="/wizard">
          use the wizard
        </Link>{" "}
        when you want a package-specific scaffold.
      </P>

      <Callout title="Next guide pages">
        The rest of this Guides track explains the agent-connector-specific
        layer around a working MCP server and what each piece can do in host
        CLIs:{" "}
        <Link className="underline hover:text-foreground" to="/docs/guides/beginner-demo-lab">
          beginner demo lab
        </Link>
        ,{" "}
        <Link className="underline hover:text-foreground" to="/docs/guides/first-mcp-server">
          first MCP server
        </Link>
        ,{" "}
        <Link className="underline hover:text-foreground" to="/docs/guides/connect-first-host">
          first host connection
        </Link>
        ,{" "}
        <Link
          className="underline hover:text-foreground"
          to="/docs/guides/first-connector-surfaces"
        >
          first connector surfaces
        </Link>
        ,{" "}
        <Link className="underline hover:text-foreground" to="/docs/guides/connector-concepts">
          how agent-connector fits
        </Link>
        ,{" "}
        <Link className="underline hover:text-foreground" to="/docs/guides/host-hooks">
          host hooks by CLI
        </Link>
        ,{" "}
        <Link className="underline hover:text-foreground" to="/docs/guides/hud-statusline">
          HUD/statusline
        </Link>
        ,{" "}
        <Link className="underline hover:text-foreground" to="/docs/guides/actions-guide">
          actions
        </Link>
        , and{" "}
        <Link className="underline hover:text-foreground" to="/docs/guides/special-surfaces">
          commands, skills, subagents, and memory
        </Link>
        .
      </Callout>
    </DocSection>
  );
}

export function BeginnerDemoLabGuide() {
  return (
    <DocSection id="beginner-demo-lab" eyebrow="Guides" title="Beginner demo lab">
      <Lead>
        A copy-paste lab for first-time MCP and agent-connector developers. You
        will create one local MCP server, run a smoke test without any host UI,
        open it in Inspector, add a connector config, customize the demo data,
        and compare your result against simple screenshot-style frames.
      </Lead>

      <Callout title="What you will have at the end">
        A working <C>schema_summary</C> MCP tool, a repeatable{" "}
        <C>npm run demo</C> script, an Inspector check, a connector config with
        a HUD/statusline and action, and a small set of visual checkpoints you
        can use when writing docs or release notes for your own package.
      </Callout>

      <H3 id="demo-lab-map">0. The whole path</H3>
      <P>
        The lab is intentionally linear. Finish each checkpoint before moving to
        the next one; that keeps protocol problems, host problems, and connector
        problems separate.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Step</Th>
            <Th>You do</Th>
            <Th>Done when</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>Server</Td>
            <Td className="text-muted-foreground">Create files and one read-only tool.</Td>
            <Td className="text-muted-foreground">
              <C>npm run demo</C> prints the tool result.
            </Td>
          </tr>
          <tr>
            <Td>Inspector</Td>
            <Td className="text-muted-foreground">Open a protocol-aware UI.</Td>
            <Td className="text-muted-foreground">
              Inspector lists and calls <C>schema_summary</C>.
            </Td>
          </tr>
          <tr>
            <Td>Customize</Td>
            <Td className="text-muted-foreground">Change the demo data and schema.</Td>
            <Td className="text-muted-foreground">
              Bad table names fail; valid table names return new data.
            </Td>
          </tr>
          <tr>
            <Td>Connector</Td>
            <Td className="text-muted-foreground">Add statusline and action surfaces.</Td>
            <Td className="text-muted-foreground">
              Audit and dry-run install show concrete host output.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <H3 id="demo-lab-files">1. Create the files</H3>
      <P>
        Start with this folder shape. The server is neutral MCP. The connector
        config is the agent-connector layer you add after the server works.
      </P>
      <CodeBlock code={beginnerLabProjectTree} language="text" filename="project tree" />
      <CodeBlock code={beginnerLabPackageJson} language="json" filename="package.json" />

      <H3 id="demo-lab-server">2. Paste the demo MCP server</H3>
      <P>
        This server has one safe read-only tool. The table list is deliberately
        fake so beginners can edit it without touching a real database.
      </P>
      <CodeBlock code={beginnerLabServer} language="ts" filename="my-mcp-server.mjs" />

      <Callout title="Beginner checkpoint">
        You should be able to explain this file in one sentence: the server
        exposes a tool named <C>schema_summary</C> that validates a table name
        and returns text plus structured JSON.
      </Callout>

      <H3 id="demo-lab-smoke-script">3. Add the smoke-test script</H3>
      <P>
        A smoke script is easier than opening a host while you are still
        learning. It starts your stdio server as a client would, lists tools,
        calls one tool, prints the result, and closes the connection.
      </P>
      <CodeBlock code={beginnerLabSmoke} language="ts" filename="scripts/demo-smoke.mjs" />
      <CodeBlock code={beginnerLabCommands} language="bash" filename="terminal" />

      <H3 id="demo-lab-inspector">4. Open Inspector and capture the first demo frame</H3>
      <P>
        Inspector is the best first screenshot because it proves the MCP layer
        works before any host-specific install is involved. Capture the tool
        list and one successful <C>schema_summary</C> call.
      </P>
      <div className="not-prose grid gap-4 md:grid-cols-2">
        <DemoScreenshotFrame eyebrow="Terminal" title="npm run demo">
          <div className="font-mono text-xs leading-6 text-foreground">
            <div>$ npm run demo</div>
            <div className="text-emerald-500">tools: schema_summary</div>
            <div>text: users has 4 demo columns.</div>
            <div className="text-muted-foreground">
              structured: {"{"} &quot;table&quot;: &quot;users&quot;, &quot;columns&quot;: [...]
              {"}"}
            </div>
          </div>
        </DemoScreenshotFrame>
        <DemoScreenshotFrame eyebrow="Inspector" title="schema_summary call">
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-background p-3">
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Tool
              </div>
              <div className="font-mono text-foreground">schema_summary</div>
            </div>
            <div className="rounded-md border border-border bg-background p-3">
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Arguments
              </div>
              <div className="font-mono text-foreground">
                {"{ \"table\": \"users\", \"includeColumns\": true }"}
              </div>
            </div>
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-emerald-700 dark:text-emerald-300">
              users has 4 demo columns.
            </div>
          </div>
        </DemoScreenshotFrame>
      </div>

      <H3 id="demo-lab-customize">5. Customize one thing on purpose</H3>
      <P>
        The first customization should change data without changing the mental
        model. Replace the fake table catalog, update the enum, and rerun the
        same script. This teaches the right habit: schema and implementation
        move together.
      </P>
      <CodeBlock code={beginnerLabCustomizeTool} language="ts" filename="customize table catalog" />
      <DocsTable>
        <thead>
          <tr>
            <Th>Try</Th>
            <Th>What you learn</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>Rename the tables</Td>
            <Td className="text-muted-foreground">
              Tool descriptions and schemas should match the actual domain.
            </Td>
          </tr>
          <tr>
            <Td>Add one boolean option</Td>
            <Td className="text-muted-foreground">
              Optional arguments should have a clear default and visible result.
            </Td>
          </tr>
          <tr>
            <Td>Call an invalid table</Td>
            <Td className="text-muted-foreground">
              Zod validation should fail before your handler touches app logic.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <H3 id="demo-lab-connector">6. Add agent-connector surfaces</H3>
      <P>
        After the MCP tool works, add the connector layer. This example keeps it
        small: one server declaration, one HUD/statusline string, and one
        user-invoked action. Unsupported hosts skip-warn; supported hosts emit
        native affordances.
      </P>
      <CodeBlock
        code={beginnerLabConnector}
        language="ts"
        filename="agent-connector.config.mjs"
      />

      <div className="not-prose grid gap-4 md:grid-cols-2">
        <DemoScreenshotFrame eyebrow="Host chat prompt" title="Ask a useful first question">
          <pre className="whitespace-pre-wrap font-mono text-xs leading-5 text-foreground">
            {beginnerLabHostPrompt}
          </pre>
        </DemoScreenshotFrame>
        <DemoScreenshotFrame eyebrow="HUD + action preview" title="What the user should see">
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground">
              acme-db demo · claude-code · 1 calls
            </div>
            <div className="rounded-md border border-border bg-background p-3">
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Action output
              </div>
              <div className="text-foreground">
                Demo tables for claude-code: users, orders, invoices
              </div>
            </div>
          </div>
        </DemoScreenshotFrame>
      </div>

      <H3 id="demo-lab-recording">7. Capture docs-ready demo screenshots</H3>
      <P>
        For a beginner-facing README or release note, capture only the screens
        that prove a boundary. More screenshots are not better; they become
        noise unless each one answers a different question.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Screenshot</Th>
            <Th>Proves</Th>
            <Th>Keep visible</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>Terminal smoke test</Td>
            <Td className="text-muted-foreground">The server can be called without a host UI.</Td>
            <Td className="text-muted-foreground">
              Tool name, text result, structured JSON.
            </Td>
          </tr>
          <tr>
            <Td>Inspector call</Td>
            <Td className="text-muted-foreground">The MCP protocol layer works.</Td>
            <Td className="text-muted-foreground">
              Arguments and successful result, not unrelated browser chrome.
            </Td>
          </tr>
          <tr>
            <Td>Host chat answer</Td>
            <Td className="text-muted-foreground">A real host can use the tool.</Td>
            <Td className="text-muted-foreground">
              The prompt, the host&apos;s answer, and the tool result summary.
            </Td>
          </tr>
          <tr>
            <Td>HUD/action preview</Td>
            <Td className="text-muted-foreground">agent-connector surfaces are wired.</Td>
            <Td className="text-muted-foreground">
              Short HUD string and one explicit action result.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <Callout title="Next pages">
        Continue with{" "}
        <Link className="underline hover:text-foreground" to="/docs/guides/first-mcp-server">
          Build your first MCP server
        </Link>{" "}
        for the protocol walkthrough, then{" "}
        <Link className="underline hover:text-foreground" to="/docs/guides/connect-first-host">
          Connect your first host
        </Link>{" "}
        and{" "}
        <Link
          className="underline hover:text-foreground"
          to="/docs/guides/first-connector-surfaces"
        >
          Add connector surfaces
        </Link>
        .
      </Callout>
    </DocSection>
  );
}

export function FirstMcpServerGuide() {
  return (
    <DocSection id="first-mcp-server" eyebrow="Guides" title="Build your first MCP server">
      <Lead>
        This page turns the beginner concepts into a runnable local server. Keep
        the first pass deliberately small: one stdio server, one read-only tool,
        one structured result, and one Inspector call before touching host
        installs or agent-connector surfaces.
      </Lead>

      <H3 id="first-server-reference">Reference baseline</H3>
      <P>
        The implementation below follows the current official TypeScript SDK
        style: <C>McpServer</C>, <C>registerTool</C>, Zod-backed input schemas,
        optional <C>outputSchema</C>, and <C>structuredContent</C> beside text
        content. It also keeps the first transport local with <C>stdio</C>.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Reference</Th>
            <Th>Use it for</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>
              <a
                className="underline hover:text-foreground"
                href="https://modelcontextprotocol.io/quickstart/server"
                rel="noreferrer"
                target="_blank"
              >
                Build an MCP server
              </a>
            </Td>
            <Td className="text-muted-foreground">
              The official quickstart for the TypeScript SDK and stdio server
              shape.
            </Td>
          </tr>
          <tr>
            <Td>
              <a
                className="underline hover:text-foreground"
                href="https://modelcontextprotocol.io/specification/latest/server/tools"
                rel="noreferrer"
                target="_blank"
              >
                Tools spec
              </a>
            </Td>
            <Td className="text-muted-foreground">
              Tool metadata, input schemas, optional output schemas, and result
              content.
            </Td>
          </tr>
          <tr>
            <Td>
              <a
                className="underline hover:text-foreground"
                href="https://modelcontextprotocol.io/docs/tools/inspector"
                rel="noreferrer"
                target="_blank"
              >
                MCP Inspector
              </a>
            </Td>
            <Td className="text-muted-foreground">
              A protocol-aware test client. Use it before debugging a real host
              UI.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <H3 id="first-server-create-project">1. Create the project</H3>
      <P>
        Use a new folder so you can tell package errors apart from host errors.
        The SDK version below was current when this guide was refreshed; re-run{" "}
        <C>npm view @modelcontextprotocol/sdk version</C> before changing a
        published tutorial package.
      </P>
      <CodeBlock code={mcpFirstServerSetupSnippet} language="bash" filename="terminal" />

      <H3 id="first-server-write-tool">2. Write one read-only tool</H3>
      <P>
        This example returns both text and structured JSON. Text is useful for
        the model&apos;s answer; <C>structuredContent</C> is useful when the result
        has fields that should remain machine-readable.
      </P>
      <CodeBlock code={mcp101ServerSnippet} language="ts" filename="my-mcp-server.mjs" />

      <Callout title="Why not start with resources, prompts, sampling, or elicitation?">
        They are important MCP features, but a first server needs one tight loop:
        advertise a capability, receive arguments, validate them, and return a
        predictable result. Add other protocol surfaces after this loop is
        boring.
      </Callout>

      <H3 id="first-server-run-inspector">3. Run with MCP Inspector</H3>
      <P>
        A stdio MCP server waits for JSON-RPC messages on stdin, so running{" "}
        <C>node my-mcp-server.mjs</C> directly can look idle. Inspector starts
        the process as a host would and lets you list and call tools.
      </P>
      <CodeBlock code={mcpInspectorSnippet} language="bash" filename="terminal" />

      <H3 id="first-server-success">4. What success looks like</H3>
      <DocsTable>
        <thead>
          <tr>
            <Th>Check</Th>
            <Th>Expected result</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>Tool list</Td>
            <Td className="text-muted-foreground">
              Inspector shows <C>schema_summary</C> with the title,
              description, and input schema.
            </Td>
          </tr>
          <tr>
            <Td>Valid call</Td>
            <Td className="text-muted-foreground">
              Calling with <C>{"{ \"table\": \"users\" }"}</C> returns a short
              text result and structured JSON.
            </Td>
          </tr>
          <tr>
            <Td>Invalid call</Td>
            <Td className="text-muted-foreground">
              Bad input returns a clear validation error instead of corrupting
              the stdio stream.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <P>
        After these checks pass, continue to{" "}
        <Link className="underline hover:text-foreground" to="/docs/guides/connect-first-host">
          Connect your first host
        </Link>
        .
      </P>
    </DocSection>
  );
}

export function ConnectFirstHostGuide() {
  return (
    <DocSection id="connect-first-host" eyebrow="Guides" title="Connect your first host">
      <Lead>
        A host connection proves that a real agent CLI can launch your server,
        list its tools, call one tool, and surface errors. Do this in one host
        before trying to support every CLI agent-connector can target.
      </Lead>

      <H3 id="first-host-one-target">1. Pick one host and one scope</H3>
      <P>
        Choose the host you use every day and one install scope, usually project
        scope while developing. Cross-host packaging comes later; the first goal
        is to remove uncertainty about paths, Node, working directory, and host
        approval UI.
      </P>

      <H3 id="first-host-launch-shape">2. Use the same launch shape everywhere</H3>
      <P>
        Host settings differ, but the local stdio launch shape is stable: a
        server name, a command, and args. Start with an absolute server path so
        path resolution is not mixed into protocol debugging.
      </P>
      <CodeBlock code={firstHostLaunchFlow} language="text" filename="host-launch-flow.txt" />
      <CodeBlock code={mcp101HostConfigSnippet} language="json" filename="host MCP settings" />

      <Callout title="Windows path rule">
        In JSON config, prefer forward slashes in absolute Windows paths, or
        escape backslashes. <C>D:/work/acme-db-mcp/my-mcp-server.mjs</C> is less
        error-prone than an unescaped <C>D:\work\...</C> string.
      </Callout>
      <CodeBlock code={firstHostWindowsPathSnippet} language="json" filename="windows-host-settings.json" />

      <H3 id="first-host-verify">3. Verify the host, not the package</H3>
      <DocsTable>
        <thead>
          <tr>
            <Th>Host check</Th>
            <Th>What it proves</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>Server appears</Td>
            <Td className="text-muted-foreground">
              The host parsed your config and can spawn the command.
            </Td>
          </tr>
          <tr>
            <Td>Tool appears</Td>
            <Td className="text-muted-foreground">
              Initialize and <C>tools/list</C> completed successfully.
            </Td>
          </tr>
          <tr>
            <Td>One call works</Td>
            <Td className="text-muted-foreground">
              The host can send <C>tools/call</C>, receive the result, and feed it
              back into the conversation.
            </Td>
          </tr>
          <tr>
            <Td>Host restart still works</Td>
            <Td className="text-muted-foreground">
              The config is durable and does not depend on your current terminal
              session.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <H3 id="first-host-failures">4. Isolate failures by boundary</H3>
      <DocsTable>
        <thead>
          <tr>
            <Th>Symptom</Th>
            <Th>Likely boundary</Th>
            <Th>First fix</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>Host cannot find server</Td>
            <Td className="text-muted-foreground">Config path or command</Td>
            <Td className="text-muted-foreground">
              Use an absolute path and verify <C>node</C> resolves outside your
              dev shell.
            </Td>
          </tr>
          <tr>
            <Td>Server starts, no tools</Td>
            <Td className="text-muted-foreground">Handshake or tool metadata</Td>
            <Td className="text-muted-foreground">
              Re-test with Inspector and check stderr for import errors.
            </Td>
          </tr>
          <tr>
            <Td>Call crashes</Td>
            <Td className="text-muted-foreground">Handler validation</Td>
            <Td className="text-muted-foreground">
              Send the smallest valid JSON input, then test invalid input.
            </Td>
          </tr>
          <tr>
            <Td>Random protocol errors</Td>
            <Td className="text-muted-foreground">stdio contamination</Td>
            <Td className="text-muted-foreground">
              Move logs to stderr or a file; stdout belongs to JSON-RPC.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <H3 id="first-host-agent-connector">5. Let agent-connector take over later</H3>
      <P>
        Once one host can call one tool, agent-connector can own repeatable
        rendering: server registration, install/doctor checks, optional hooks,
        statusline, actions, commands, skills, subagents, memory, and telemetry.
        Continue with{" "}
        <Link
          className="underline hover:text-foreground"
          to="/docs/guides/first-connector-surfaces"
        >
          Add your first connector surfaces
        </Link>
        .
      </P>
    </DocSection>
  );
}

export function FirstConnectorSurfacesGuide() {
  return (
    <DocSection
      id="first-connector-surfaces"
      eyebrow="Guides"
      title="Add your first connector surfaces"
    >
      <Lead>
        agent-connector starts after the neutral MCP server works. This page
        shows the first useful expansion path: declare the server, verify the
        install, then add host surfaces only when they solve a real user problem.
      </Lead>

      <H3 id="connector-surfaces-order">1. Use a staged expansion order</H3>
      <P>
        Do not add every surface because it exists. Each surface answers a
        different question: what the model can call, what the host triggers, what
        the user invokes, what the host displays, and what context files it
        loads.
      </P>
      <CodeBlock code={connectorSurfaceOrderFlow} language="text" filename="surface-order.txt" />

      <H3 id="connector-surfaces-server-only">2. Start server-only</H3>
      <P>
        The first connector config should only wrap the MCP server you already
        tested. That keeps install/doctor failures separate from hook or surface
        handler failures.
      </P>
      <CodeBlock
        code={mcp101AgentConnectorDropSnippet}
        language="ts"
        filename="agent-connector.config.mjs"
      />

      <H3 id="connector-surfaces-runtime">3. Add runtime surfaces deliberately</H3>
      <P>
        Statusline and actions are runtime-dispatched handler surfaces. They are
        re-imported from the connector module, so keep handlers deterministic,
        fast, and safe to run without ambient process state.
      </P>
      <CodeBlock
        code={connectorSurfaceStarterSnippet}
        language="ts"
        filename="agent-connector.config.mjs"
      />

      <H3 id="connector-surfaces-choose">4. Choose by user need</H3>
      <DocsTable>
        <thead>
          <tr>
            <Th>Need</Th>
            <Th>Surface</Th>
            <Th>Beginner rule</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>The model should call a capability</Td>
            <Td className="text-muted-foreground">MCP tool</Td>
            <Td className="text-muted-foreground">Keep validation in the server.</Td>
          </tr>
          <tr>
            <Td>The host lifecycle should add policy/context</Td>
            <Td className="text-muted-foreground">Hook</Td>
            <Td className="text-muted-foreground">
              Test one host per hook paradigm; MCP-only hosts skip hooks.
            </Td>
          </tr>
          <tr>
            <Td>The human needs a compact state signal</Td>
            <Td className="text-muted-foreground">Statusline / HUD</Td>
            <Td className="text-muted-foreground">
              Return short text; never block on network calls.
            </Td>
          </tr>
          <tr>
            <Td>The human wants to trigger a command</Td>
            <Td className="text-muted-foreground">Action</Td>
            <Td className="text-muted-foreground">
              Use clear command names and surface errors to the user.
            </Td>
          </tr>
          <tr>
            <Td>Users repeat the same instructions</Td>
            <Td className="text-muted-foreground">Command, skill, subagent, or memory</Td>
            <Td className="text-muted-foreground">
              Prefer static files for durable guidance; keep memory small.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <H3 id="connector-surfaces-verify">5. Verify after each added surface</H3>
      <List>
        <LI>
          Run install in one target host and read the generated diff or warning.
        </LI>
        <LI>Run doctor before adding the next surface.</LI>
        <LI>
          Confirm unsupported hosts skip with a warning instead of pretending the
          surface works.
        </LI>
        <LI>
          Keep hard safety in the MCP tool handler; hooks and actions are not a
          substitute for server validation.
        </LI>
      </List>
    </DocSection>
  );
}

export function ConnectorConceptsGuide() {
  return (
    <DocSection
      id="connector-concepts"
      eyebrow="Guides"
      title="How agent-connector fits"
    >
      <Lead>
        agent-connector is not the MCP protocol and not a replacement for your
        MCP server. It starts after a plain MCP server works: it packages that
        server, renders host-native installs, and adds optional host surfaces
        such as hooks, commands, skills, subagents, memory, statusline, actions,
        and telemetry.
      </Lead>

      <H3 id="connector-boundary">The boundary: MCP first, connector second</H3>
      <P>
        A beginner should make one server work in one host before adding
        agent-connector. MCP proves the capability contract. agent-connector
        proves the distribution and host-integration contract.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Layer</Th>
            <Th>Owns</Th>
            <Th>Beginner question</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>MCP server</Code>
            </Td>
            <Td className="text-muted-foreground">
              Tools, resources, prompts, argument validation, and application
              access.
            </Td>
            <Td className="text-muted-foreground">
              Can one host call one useful capability?
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>agent-connector</Code>
            </Td>
            <Td className="text-muted-foreground">
              Package identity, per-host config rendering, hook bridges, content
              surfaces, statusline/actions dispatch, doctor checks, and local
              telemetry.
            </Td>
            <Td className="text-muted-foreground">
              Can the same package install cleanly across hosts?
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <H3 id="connector-distribution-layer">The distribution layer</H3>
      <P>
        <C>defineConnector</C> is the declaration that says, &quot;this package
        exposes this MCP server and these optional host surfaces.&quot; From that
        declaration, adapters render the native shape each host expects instead
        of forcing every host into one invented config format.
      </P>
      <CodeBlock
        code={connectorConceptsFlow}
        language="text"
        filename="connector-flow.txt"
      />

      <H3 id="connector-install-pipeline">What install actually does</H3>
      <List>
        <LI>
          <strong>Resolve package identity.</strong> The package name, version,
          bin, and optional MCP metadata become the public connector identity.
        </LI>
        <LI>
          <strong>Detect or target hosts.</strong> The installer works against
          detected hosts or the explicit <C>--targets</C> list, not every known
          platform blindly.
        </LI>
        <LI>
          <strong>Render native files.</strong> MCP config, plugin manifests,
          command files, skill folders, rules files, and hook bridge entries are
          written in the host&apos;s own dialect.
        </LI>
        <LI>
          <strong>Point runtime hooks at one home binary.</strong> Hook,
          statusline, action, and serve-wrapper dispatch go through the stable
          home binary so upgrades do not require rewriting every handler.
        </LI>
        <LI>
          <strong>Verify with doctor.</strong> Installation is followed by
          host-specific checks that distinguish pass, warn, and fail states.
        </LI>
      </List>

      <H3 id="connector-when-not">When not to add it yet</H3>
      <P>
        Do not reach for agent-connector while the basic server contract is
        still unclear. If the tool name, schema, stdout behavior, result shape,
        or first host config is broken, fix MCP first. Add the connector layer
        when the next problem is distribution, cross-host parity, hooks, content
        surfaces, or telemetry for your package.
      </P>
    </DocSection>
  );
}

export function HostHooksGuide() {
  return (
    <DocSection id="host-hooks" eyebrow="Guides" title="Host hooks by CLI">
      <Lead>
        Hooks are host lifecycle callbacks, not MCP tool calls. The hard part is
        that each CLI exposes hooks differently. agent-connector groups those
        differences into paradigms so a connector author can write one normalized
          handler and still get honest per-host behavior.
      </Lead>

      <H3 id="hook-mental-model">The hook mental model</H3>
      <P>
        A hook runs because the host emitted an event: session started, a tool
        is about to run, a permission decision is needed, a tool failed, context
        was compacted, or a subagent changed state. The model does not choose a
        hook the way it chooses an MCP tool.
      </P>
      <CodeBlock
        code={hostHooksParadigmFlow}
        language="text"
        filename="hook-paradigms.txt"
      />

      <H3 id="hook-official-hosts">Official host surfaces to know first</H3>
      <P>
        Start by separating three facts: MCP tools are model-selected, hooks are
        host lifecycle callbacks, and each host chooses its own hook transport.
        The links below are the current public references used by this guide.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Host family</Th>
            <Th>Native hook surface</Th>
            <Th>How agent-connector connects it</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td className="whitespace-nowrap">
              <a
                className="underline hover:text-foreground"
                href="https://docs.anthropic.com/en/docs/claude-code/hooks"
                target="_blank"
                rel="noreferrer"
              >
                Claude Code
              </a>
            </Td>
            <Td className="text-muted-foreground">
              Settings JSON registers hook events such as <C>PreToolUse</C> with
              a matcher and command hook entries.
            </Td>
            <Td className="text-muted-foreground">
              The adapter writes the command entry and dispatches stdin JSON into
              your normalized <C>defineHook</C> handler.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">
              <a
                className="underline hover:text-foreground"
                href="https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md"
                target="_blank"
                rel="noreferrer"
              >
                Gemini CLI
              </a>
            </Td>
            <Td className="text-muted-foreground">
              Gemini uses its own event vocabulary: <C>BeforeTool</C>,{" "}
              <C>AfterTool</C>, <C>PreCompress</C>, <C>BeforeAgent</C>, and
              related lifecycle events.
            </Td>
            <Td className="text-muted-foreground">
              agent-connector maps normalized events such as <C>PreToolUse</C>{" "}
              and <C>PostToolUse</C> to the Gemini event names before writing
              hooks.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">
              <a
                className="underline hover:text-foreground"
                href="https://developers.openai.com/codex/hooks/"
                target="_blank"
                rel="noreferrer"
              >
                Codex CLI
              </a>
            </Td>
            <Td className="text-muted-foreground">
              Codex exposes hook configuration separately from MCP server
              registration, with command hooks for supported lifecycle events.
            </Td>
            <Td className="text-muted-foreground">
              The Codex adapter renders a <C>hooks.json</C> entry that points at
              the same home-bin hook dispatcher.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">
              <a
                className="underline hover:text-foreground"
                href="https://opencode.ai/docs/plugins/"
                target="_blank"
                rel="noreferrer"
              >
                OpenCode family
              </a>
            </Td>
            <Td className="text-muted-foreground">
              OpenCode loads a plugin module with event functions such as{" "}
              <C>tool.execute.before</C> and <C>permission.ask</C>.
            </Td>
            <Td className="text-muted-foreground">
              The adapter generates a plugin file that calls the connector
              runtime; connector authors still write normalized hooks.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">
              <a
                className="underline hover:text-foreground"
                href="https://docs.warp.dev/knowledge-and-collaboration/mcp"
                target="_blank"
                rel="noreferrer"
              >
                MCP-only hosts
              </a>
            </Td>
            <Td className="text-muted-foreground">
              Some hosts document MCP server registration but do not expose a
              hook layer to connector packages.
            </Td>
            <Td className="text-muted-foreground">
              The installer keeps MCP working and reports hooks as unsupported
              instead of pretending the policy will run.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <H3 id="hook-cross-validation">Cross-validation before a hook claim</H3>
      <P>
        The full host lists below are generated from adapter metadata, not typed
        by hand. A host is presented as hook-capable only when the registry
        reports a non-MCP-only paradigm and the docs drift tests keep the list in
        lock-step with loaded adapters. The examples table adds external evidence
        for representative host families.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Host or family</Th>
            <Th>Local proof</Th>
            <Th>External proof</Th>
          </tr>
        </thead>
        <tbody>
          {hookCrossValidationRows.map((row) => (
            <tr key={row.host}>
              <Td className="whitespace-nowrap">{row.host}</Td>
              <Td className="text-muted-foreground">{row.local}</Td>
              <Td className="text-muted-foreground">
                <a
                  className="underline hover:text-foreground"
                  href={row.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {row.external}
                </a>
              </Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>

      <H3 id="hook-paradigm-map">CLI behavior by hook paradigm</H3>
      <DocsTable>
        <thead>
          <tr>
            <Th>Paradigm</Th>
            <Th>How it works</Th>
            <Th>Hosts in this repo</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>json-stdio</Code>
            </Td>
            <Td className="text-muted-foreground">
              The host calls a configured command. agent-connector receives a
              JSON payload on the home-bin hook entrypoint, normalizes it, runs
              your handler, and prints the host&apos;s expected response shape.
            </Td>
            <Td className="text-muted-foreground">
              {jsonStdioPlatforms.map((p) => p.name).join(", ")}
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>ts-plugin</Code>
            </Td>
            <Td className="text-muted-foreground">
              The package emits a host plugin/module. That module exports the
              lifecycle functions the host expects and dispatches into the
              connector runtime.
            </Td>
            <Td className="text-muted-foreground">
              {tsPluginPlatforms.map((p) => p.name).join(", ")}
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>mcp-only</Code>
            </Td>
            <Td className="text-muted-foreground">
              The host can register MCP servers but exposes no hook layer to
              agent-connector. Declared hooks are skipped with a warning instead
              of pretending to run.
            </Td>
            <Td className="text-muted-foreground">
              {mcpOnlyPlatforms.map((p) => p.name).join(", ")}
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <H3 id="hook-connector-authoring">Write the connector hook once</H3>
      <P>
        The connector author writes against agent-connector&apos;s normalized event
        type. This example blocks one dangerous shell pattern, injects context
        for this connector&apos;s MCP tools, and leaves unsupported host behavior to
        the adapter.
      </P>
      <CodeBlock
        code={hookConnectorPolicySnippet}
        language="ts"
        filename="agent-connector.config.ts"
      />
      <Callout>
        A hook is not a replacement for server-side validation. If the MCP tool
        can mutate data, the tool handler must validate the operation even when a
        host hook is installed.
      </Callout>

      <H3 id="hook-rendered-shapes">What host config can look like</H3>
      <P>
        These are representative rendered shapes, not extra files you maintain by
        hand. The stable part is the home-bin command:{" "}
        <C>agent-connector hook &lt;host&gt; &lt;event&gt; --connector &lt;id&gt;</C>.
      </P>
      <Tabs defaultValue="claude" className="not-prose">
        <TabsList className="flex h-auto flex-wrap justify-start gap-1">
          <TabsTrigger value="claude">Claude Code</TabsTrigger>
          <TabsTrigger value="gemini">Gemini CLI</TabsTrigger>
          <TabsTrigger value="codex">Codex CLI</TabsTrigger>
          <TabsTrigger value="opencode">OpenCode</TabsTrigger>
        </TabsList>
        <TabsContent value="claude" className="mt-4">
          <CodeBlock
            code={claudeHookSettingsSnippet}
            language="json"
            filename="settings.json"
          />
        </TabsContent>
        <TabsContent value="gemini" className="mt-4">
          <CodeBlock
            code={geminiHookSettingsSnippet}
            language="json"
            filename=".gemini/settings.json"
          />
        </TabsContent>
        <TabsContent value="codex" className="mt-4">
          <CodeBlock
            code={codexHookSettingsSnippet}
            language="json"
            filename="hooks.json"
          />
        </TabsContent>
        <TabsContent value="opencode" className="mt-4">
          <CodeBlock
            code={opencodePluginShapeSnippet}
            language="ts"
            filename=".opencode/plugin/acme-db.js"
          />
        </TabsContent>
      </Tabs>

      <H3 id="hook-dispatch-flow">What happens during dispatch</H3>
      <List>
        <LI>
          The host emits a native lifecycle payload in its own format.
        </LI>
        <LI>
          The adapter converts that payload into one normalized event shape where
          the host has a matching concept.
        </LI>
        <LI>
          The connector hook handler receives the event and returns context,
          allow/block, warning text, or another supported response.
        </LI>
        <LI>
          The adapter translates that response back to the native host contract.
        </LI>
        <LI>
          If the host cannot support that event or response, the installer and
          doctor surface the limitation as a warning or unavailable capability.
        </LI>
      </List>

      <H3 id="hook-customization">How to customize behavior safely</H3>
      <List>
        <LI>
          Use <C>matcher</C> to narrow the hook to specific tool names or MCP
          tool prefixes before adding logic.
        </LI>
        <LI>
          Use <C>hosts</C> overrides only when one host has different semantics;
          the top-level handler stays the mandatory fallback.
        </LI>
        <LI>
          Use <C>platforms.&lt;id&gt;.nativeHooks</C> for host-specific events
          that have no normalized event yet, then keep the payload parsing local
          to that host.
        </LI>
        <LI>
          Disable a surface per host with <C>platforms.&lt;id&gt;.hooks = false</C>{" "}
          when the host behavior is not mature enough for your package.
        </LI>
      </List>

      <H3 id="hook-safety-rules">Beginner safety rules</H3>
      <Callout title="Hooks are additive policy, not your only guardrail" tone="warn">
        If a tool can delete files, run SQL, or mutate production state, the MCP
        tool handler itself must validate the operation. Hooks can add host-side
        policy and UX, but an MCP-only host may never run them.
      </Callout>
      <List>
        <LI>
          Keep hook handlers fast. A hook sits on the host&apos;s interaction path.
        </LI>
        <LI>
          Return small context. Large hook output becomes model context or host
          UI noise.
        </LI>
        <LI>
          Treat hook payloads as host-specific observations, not guaranteed
          universal state.
        </LI>
        <LI>
          Test one host from each paradigm before claiming cross-host behavior.
        </LI>
      </List>
    </DocSection>
  );
}

export function HudStatuslineGuide() {
  return (
    <DocSection id="hud-statusline" eyebrow="Guides" title="HUD / statusline">
      <Lead>
        A HUD or statusline is a host UI surface. It is not an MCP tool, not a
        resource, and not something the model calls. The host asks for a short
        render result, and agent-connector dispatches your{" "}
        <C>statusline.render(ctx)</C> handler where that host supports it.
      </Lead>

      <H3 id="hud-not-mcp">Why it is separate from MCP</H3>
      <P>
        MCP moves capability messages between a host and a server. A statusline
        is the host displaying state to a human: current connector, project,
        token state, warning flags, or another compact signal. It belongs in the
        host UI layer, not in the MCP server&apos;s tool list.
      </P>
      <CodeBlock code={statuslineFlow} language="text" filename="statusline-flow.txt" />

      <H3 id="hud-official-hosts">Official host model</H3>
      <P>
        The clearest official model is Claude Code&apos;s{" "}
        <a
          className="underline hover:text-foreground"
          href="https://docs.anthropic.com/en/docs/claude-code/statusline"
          target="_blank"
          rel="noreferrer"
        >
          statusLine command
        </a>
        : the host runs a command, passes session metadata on stdin, and displays
        the command&apos;s short stdout. agent-connector uses that command-stdin
        shape where a host exposes a comparable connector-owned statusline
        surface.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Host surface</Th>
            <Th>What the host owns</Th>
            <Th>What the connector owns</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>statusLine</Code> command
            </Td>
            <Td className="text-muted-foreground">
              When to refresh, what metadata is passed, and where the text is
              displayed in the CLI UI.
            </Td>
            <Td className="text-muted-foreground">
              The render handler, compact text, telemetry read, and per-host
              fallback behavior.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">Host preset only</Td>
            <Td className="text-muted-foreground">
              Built-in compact or verbose status UI with no command entrypoint.
            </Td>
            <Td className="text-muted-foreground">
              Leave it to host settings; it is not a <C>render(ctx)</C> surface
              yet.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">Unsupported host</Td>
            <Td className="text-muted-foreground">
              No documented place to render a connector-owned HUD.
            </Td>
            <Td className="text-muted-foreground">
              Skip with a warning and keep MCP server installation independent.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <H3 id="hud-render-context">The render callback</H3>
      <P>
        The connector declares one statusline surface. At runtime, the host
        adapter asks the home binary to resolve the connector and call{" "}
        <C>render(ctx)</C>. The handler should be deterministic, quick, and
        short enough for the host&apos;s native status area.
      </P>
      <List>
        <LI>
          Use it for glanceable state, not instructions or long explanations.
        </LI>
        <LI>
          Avoid network calls; status UI may refresh often and should not block
          the host.
        </LI>
        <LI>
          Return plain text unless a host-specific adapter explicitly supports
          richer output.
        </LI>
      </List>

      <H3 id="hud-connector-example">Define a connector statusline</H3>
      <P>
        The handler receives normalized host context. The same handler can read
        the current host, model, workspace, context usage, and this connector&apos;s
        telemetry rollup where the runtime can provide it.
      </P>
      <CodeBlock
        code={statuslineConnectorSnippet}
        language="ts"
        filename="agent-connector.config.ts"
      />

      <H3 id="hud-rendered-host-shape">Rendered host config</H3>
      <P>
        For Claude Code, the adapter owns a <C>statusLine</C> settings key and
        points it at the universal statusline entrypoint. The connector author
        edits the <C>defineStatusline</C> code above, not this generated settings
        leaf. Options are mapped only when the host capability says the native
        setting supports them.
      </P>
      <CodeBlock
        code={claudeStatuslineSettingsSnippet}
        language="json"
        filename="settings.json"
      />

      <H3 id="hud-cross-validation">Cross-validation for supported hosts</H3>
      <P>
        The supported-host list below is not a marketing list. It is generated
        from adapters that set <C>supportsStatusline</C>, and each listed host
        must have a concrete write path plus tests that prove the configured
        command belongs to agent-connector.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Host</Th>
            <Th>Adapter proof</Th>
            <Th>Reference / test proof</Th>
          </tr>
        </thead>
        <tbody>
          {statuslineCrossValidationRows.map((row) => (
            <tr key={row.host}>
              <Td className="whitespace-nowrap">{row.host}</Td>
              <Td className="text-muted-foreground">{row.adapter}</Td>
              <Td className="text-muted-foreground">
                <a
                  className="underline hover:text-foreground"
                  href={row.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {row.evidence}
                </a>
              </Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>

      <H3 id="hud-supported-hosts">Where it is wired today</H3>
      <P>
        Public coverage metadata currently marks statusline support in{" "}
        <strong>
          {statuslineHostNames.length} / {publicCapabilityProfiles.length}
        </strong>{" "}
        production-relevant adapters:
      </P>
      <P>{statuslineHostNames.join(", ") || "No statusline hosts are wired."}</P>
      <Callout>
        Unsupported hosts should skip this surface with a clear warning. That is
        expected behavior, not a failed MCP install.
      </Callout>

      <H3 id="hud-customization">Customization checklist</H3>
      <List>
        <LI>
          Keep the top-level <C>render(ctx)</C> as the universal fallback.
        </LI>
        <LI>
          Add <C>hosts.&lt;id&gt;.render</C> only when one host exposes better or
          different metadata.
        </LI>
        <LI>
          Use <C>options</C> for common intent and <C>hosts.&lt;id&gt;.options</C>
          when one host supports extra statusline settings.
        </LI>
        <LI>
          Read <C>ctx.usage</C> for this connector&apos;s own recorded MCP usage;
          read <C>ctx.context</C> only for host-provided context-window state.
        </LI>
        <LI>
          Return an empty or simple string on missing data. A statusline should
          fail quiet, unlike a user-invoked action.
        </LI>
      </List>

      <H3 id="hud-design-rules">Design rules for beginners</H3>
      <List>
        <LI>
          Make the first version a single stable sentence or compact counter.
        </LI>
        <LI>
          Keep it useful without interaction. Actions belong in the actions
          surface, not in statusline text.
        </LI>
        <LI>
          Never put secrets, raw prompts, or raw tool arguments in a HUD.
        </LI>
      </List>
    </DocSection>
  );
}

export function ActionsGuide() {
  return (
    <DocSection id="actions-guide" eyebrow="Guides" title="Actions">
      <Lead>
        Actions are deliberate user-invoked commands exposed through
        agent-connector&apos;s runtime. They are useful when a human wants a
        button/menu/command affordance, but the operation is not a model-selected
        MCP tool and not a lifecycle hook.
      </Lead>

      <H3 id="actions-not-tools">Actions vs tools vs hooks</H3>
      <P>
        MCP tools are for the model. Hooks are for host lifecycle events. Actions
        are for a human deliberately invoking a connector command from a CLI,
        palette, button, menu, or generated host command where the target host has
        an affordance.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Surface</Th>
            <Th>Who starts it?</Th>
            <Th>Use it for</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>MCP tool</Code>
            </Td>
            <Td className="text-muted-foreground">The model requests it through the host.</Td>
            <Td className="text-muted-foreground">
              Capabilities the model may need while answering.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>Hook</Code>
            </Td>
            <Td className="text-muted-foreground">The host emits a lifecycle event.</Td>
            <Td className="text-muted-foreground">
              Policy, context, telemetry, and host-side decisions around events.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>Action</Code>
            </Td>
            <Td className="text-muted-foreground">The user invokes an affordance.</Td>
            <Td className="text-muted-foreground">
              Intentional commands such as refresh, open report, repair install,
              clear cache, or run a package-specific workflow.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <H3 id="actions-cli-fallback">Always keep a CLI fallback</H3>
      <P>
        The universal form is <C>agent-connector action &lt;host&gt; &lt;id&gt;</C>.
        Host-native buttons and commands can call the same entrypoint, but a
        documented CLI path makes support and automation possible on every host.
      </P>
      <CodeBlock code={actionCliSnippet} language="bash" filename="actions.sh" />

      <H3 id="actions-dispatch-flow">The dispatch flow</H3>
      <CodeBlock code={actionsFlow} language="text" filename="actions-flow.txt" />
      <P>
        The important beginner distinction is authority: an action is a human
        command, so its UX should make the operation obvious before it runs. If
        the model should decide when to call something, it belongs in MCP tools.
      </P>

      <H3 id="actions-connector-example">Define an action in a connector</H3>
      <P>
        An action has a kebab-case id and a <C>run(ctx)</C> handler. Add{" "}
        <C>label</C>, <C>icon</C>, <C>placement</C>, and <C>confirm</C> when the
        host affordance can display them. Use <C>hosts</C> only when one host
        needs different user-facing metadata or execution path; the top-level
        handler remains the fallback.
      </P>
      <CodeBlock
        code={actionConnectorSnippet}
        language="ts"
        filename="agent-connector.config.ts"
      />

      <H3 id="actions-host-model">How host affordances map</H3>
      <P>
        Host documentation usually describes commands, plugins, menus, workflows,
        or MCP registration separately. agent-connector treats actions as a
        connector-level runtime surface and lets adapters bind that runtime to a
        native affordance only where the host has a verified place to do so.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Case</Th>
            <Th>What the user sees</Th>
            <Th>Recommended connector behavior</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td className="whitespace-nowrap">Native affordance exists</Td>
            <Td className="text-muted-foreground">
              A generated command, palette item, menu item, or plugin command.
            </Td>
            <Td className="text-muted-foreground">
              Bind the affordance to <C>agent-connector action</C> and return a
              concise <C>message</C>.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">Different host shape</Td>
            <Td className="text-muted-foreground">
              A workflow, task, plugin command, slash command, hook panel, or
              paste-based command.
            </Td>
            <Td className="text-muted-foreground">
              Inspect <C>actionInvocationMode</C> and{" "}
              <C>actionAffordanceKind</C>; override only the metadata that host
              needs.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">MCP-only host</Td>
            <Td className="text-muted-foreground">
              The host can call MCP tools but has no separate action UI.
            </Td>
            <Td className="text-muted-foreground">
              Keep the MCP server installed, skip action affordances, and publish
              the CLI fallback.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">Plugin host</Td>
            <Td className="text-muted-foreground">
              A host plugin can register lifecycle or command handlers, as in the{" "}
              <a
                className="underline hover:text-foreground"
                href="https://opencode.ai/docs/plugins/"
                target="_blank"
                rel="noreferrer"
              >
                OpenCode plugin model
              </a>
              .
            </Td>
            <Td className="text-muted-foreground">
              Let the adapter generate glue and keep package logic inside{" "}
              <C>defineAction</C>.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <H3 id="actions-cross-validation">Cross-validation for action hosts</H3>
      <P>
        An action host is listed only when its adapter sets{" "}
        <C>supportsActions</C> and implements a concrete host affordance emitter,
        not merely because the universal <C>agent-connector action</C> CLI exists.
        The fallback CLI works everywhere, but the supported-host list is only for
        hosts with generated native affordances.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Host</Th>
            <Th>Adapter proof</Th>
            <Th>Reference / test proof</Th>
          </tr>
        </thead>
        <tbody>
          {actionCrossValidationRows.map((row) => (
            <tr key={row.host}>
              <Td className="whitespace-nowrap">{row.host}</Td>
              <Td className="text-muted-foreground">{row.adapter}</Td>
              <Td className="text-muted-foreground">
                {row.url ? (
                  <a
                    className="underline hover:text-foreground"
                    href={row.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {row.evidence}
                  </a>
                ) : (
                  row.evidence
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>

      <H3 id="actions-supported-hosts">Where host affordances are wired today</H3>
      <P>
        Public coverage metadata currently marks action affordance support in{" "}
        <strong>
          {actionHostNames.length} / {publicCapabilityProfiles.length}
        </strong>{" "}
        production-relevant adapters:
      </P>
      <P>{actionHostNames.join(", ") || "No action hosts are wired."}</P>

      <H3 id="actions-customization">Customization checklist</H3>
      <List>
        <LI>
          Name the id as a command, not a noun: <C>refresh-index</C>,{" "}
          <C>open-dashboard</C>, <C>repair-install</C>.
        </LI>
        <LI>
          Keep the operation user-triggered. If the model should choose when to
          run it, expose it as an MCP tool instead.
        </LI>
        <LI>
          Use per-host <C>hosts.&lt;id&gt;.run</C> overrides for UI text,
          platform-specific paths, or affordance-specific behavior.
        </LI>
        <LI>
          Return a short <C>message</C>. Actions surface errors to the user; they
          do not fail silently like statusline rendering.
        </LI>
      </List>

      <H3 id="actions-design-rules">Design rules for beginners</H3>
      <List>
        <LI>
          Name actions like UI commands: <C>refresh-index</C>,{" "}
          <C>open-dashboard</C>, <C>repair-install</C>.
        </LI>
        <LI>
          Keep action output concise and user-facing. It is not a tool result
          optimized for model reasoning.
        </LI>
        <LI>
          Do not hide dangerous writes behind vague labels. Use confirmations or
          dry-run previews where the host affordance supports them.
        </LI>
        <LI>
          Provide a CLI fallback path for important operations because not every
          host exposes action affordances yet.
        </LI>
      </List>
    </DocSection>
  );
}

export function SpecialSurfacesGuide() {
  return (
    <DocSection
      id="special-surfaces"
      eyebrow="Guides"
      title="Commands, skills, subagents & memory"
    >
      <Lead>
        agent-connector can ship more than an MCP server. Some surfaces are
        static files the host loads as context or commands; others are runtime
        handlers. Understanding that split keeps beginner docs from treating
        every feature as MCP.
      </Lead>

      <H3 id="surfaces-map">The surface map</H3>
      <CodeBlock
        code={specialSurfacesFlow}
        language="text"
        filename="surface-map.txt"
      />

      <H3 id="static-vs-runtime">Static content vs runtime handlers</H3>
      <DocsTable>
        <thead>
          <tr>
            <Th>Surface</Th>
            <Th>Kind</Th>
            <Th>Beginner mental model</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>commands</Code>
            </Td>
            <Td className="text-muted-foreground">Static host files</Td>
            <Td className="text-muted-foreground">
              Slash-command prompts or command definitions the host loads from
              disk.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>skills</Code>
            </Td>
            <Td className="text-muted-foreground">Static host files</Td>
            <Td className="text-muted-foreground">
              Reusable skill instructions and resources, usually loaded by a
              skill-aware host.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>subagents</Code>
            </Td>
            <Td className="text-muted-foreground">Static host files</Td>
            <Td className="text-muted-foreground">
              Named agent roles or prompts rendered into each host&apos;s native
              agent directory.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>memory</Code>
            </Td>
            <Td className="text-muted-foreground">Static managed blocks</Td>
            <Td className="text-muted-foreground">
              Standing instructions written into the file that host actually
              reads for project/user memory.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>statusline</Code>
            </Td>
            <Td className="text-muted-foreground">Runtime UI handler</Td>
            <Td className="text-muted-foreground">
              A short render callback for host HUD/statusline UI.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>actions</Code>
            </Td>
            <Td className="text-muted-foreground">Runtime user command handler</Td>
            <Td className="text-muted-foreground">
              A deliberate user-invoked operation exposed by host affordances or
              a CLI fallback.
            </Td>
          </tr>
        </tbody>
      </DocsTable>

      <H3 id="memory-rules">Memory is the easiest surface to overuse</H3>
      <P>
        Memory should hold durable guidance the host should remember, not
        temporary task state. agent-connector writes managed blocks with markers
        so installs, upgrades, and uninstalls can update its own content without
        taking ownership of the entire file.
      </P>
      <List>
        <LI>
          Put universal project behavior in memory only when every future task
          should see it.
        </LI>
        <LI>
          Keep large tutorials in docs or skills, not memory.
        </LI>
        <LI>
          Treat host-specific memory target differences as adapter concerns.
        </LI>
      </List>

      <H3 id="surface-expansion-path">A sane expansion path</H3>
      <P>
        For a new package, start with the MCP server, then add surfaces only
        when they solve a user-visible problem. A practical order is: one tool,
        one host install, one doctor pass, then commands or skills for repeated
        workflows, memory for durable guidance, hooks for lifecycle policy,
        statusline for glanceable state, and actions for user-invoked commands.
      </P>
    </DocSection>
  );
}

export function Installation() {
  return (
    <DocSection id="installation" eyebrow="Getting Started" title="Installation">
      <Lead>
        agent-connector is an <strong>SDK you depend on</strong>, not a global
        tool your connector users install first. Add it to your MCP package,
        then ship a <strong>branded CLI</strong> your users drive directly
        (<C>npx @acme/acme-db-mcp install</C>). Developers use the framework
        command for local fallback or packaging; agent-CLI users use the global
        CLI for connector-free token telemetry.
      </Lead>
      <P>
        Add agent-connector as a dependency of the package that holds your{" "}
        <C>agent-connector.config</C>:
      </P>
      <CodeBlock code={S.installSnippet} language="bash" filename="terminal" />
      <P>
        Then expose every subcommand under your own brand with{" "}
        <C>createConnectorCli</C> from the <C>@ken-jo/agent-connector/cli</C> export — the{" "}
        <Link className="underline hover:text-foreground" to="/docs/dev/embed-cli">
          branded-CLI flow
        </Link>
        . Each command is auto-scoped to your connector, so your users never type{" "}
        <C>--connector</C>:
      </P>
      <CodeBlock
        code={S.brandedCliSnippet}
        language="ts"
        filename="bin.mjs"
      />
      <Callout title="Engines">
        Node <C>&gt;=18.17</C>, ESM only. Runtime deps are pure-JS / WASM (
        <C>gpt-tokenizer</C>, <C>sql.js</C>, <C>fzstd</C>, <C>@iarna/toml</C>,{" "}
        <C>yaml</C>) — no native build. License: Apache-2.0 © KenJo.
      </Callout>

      <H3 id="optional-global">Optional: global framework CLI</H3>
      <P>
        You do <strong>not</strong> need a global install for branded MCP
        package installs. Use the framework CLI directly for connector-free
        token telemetry across the agent CLIs you already use. Developers can
        run framework tooling with <C>npx @ken-jo/agent-connector ...</C> from
        their MCP package:
      </P>
      <CodeBlock code={S.globalInstallSnippet} language="bash" filename="terminal" />

      <H3 id="from-source">From source</H3>
      <CodeBlock code={S.fromSourceSnippet} language="bash" filename="terminal" />
    </DocSection>
  );
}

export function SdkOverview() {
  return (
    <DocSection id="sdk" eyebrow="Getting Started" title="SDK overview">
      <Lead>
        The SDK is the framework surface for <strong>MCP-package authors</strong>.
        Your package owns the public identity and binary; agent-connector supplies
        the authoring API, host adapters, installer, doctor, telemetry wrapper,
        and packaging machinery underneath that brand.
      </Lead>

      <H3 id="sdk-package-identity">Package identity is the source of truth</H3>
      <P>
        In the normal path, do <strong>not</strong> ask for a separate connector
        id, display name, binary name, or version. Those values already exist in
        your package metadata. <C>package.json</C> <C>name</C> / <C>mcpName</C>{" "}
        identify the MCP server, <C>bin</C> names the command users run, and{" "}
        <C>version</C> becomes the connector version. Override fields in{" "}
        <C>defineConnector</C> only for legacy configs or deliberate
        multi-instance aliases.
      </P>
      <CodeBlock
        code={S.sdkPackageIdentitySnippet}
        language="json"
        filename="package.json"
      />

      <H3 id="sdk-authoring-imports">Authoring imports</H3>
      <P>
        New connector packages should reach for{" "}
        <C>@ken-jo/agent-connector/sdk</C>. It re-exports{" "}
        <C>defineConnector</C>, the typed <C>define*</C> identity helpers for
        individual surfaces, host capability helpers such as{" "}
        <C>hostsSupporting</C>, and the public types. The root package export
        remains available, but <C>/sdk</C> is the consolidated authoring entry
        point.
      </P>
      <CodeBlock
        code={S.sdkAuthoringSnippet}
        language="ts"
        filename="agent-connector.config.mjs"
      />

      <H3 id="sdk-server-shapes">MCP server launch shapes</H3>
      <P>
        Not every MCP starts the same way. A package-runner MCP can launch with{" "}
        <C>npx -y &lt;package&gt;</C>, a local Node/process MCP can launch with{" "}
        <C>node &lt;server-file&gt;</C>, a Python MCP should usually launch with{" "}
        <C>uv run --with mcp &lt;server.py&gt;</C>, a CLI-based MCP can launch an
        existing executable, and a remote server MCP should use HTTP transport.
        In all cases, keep the wrapper package&apos;s <C>package.json</C> as the
        public identity and point the server block at the real MCP process or
        URL.
      </P>
      <CodeBlock
        code={S.serverLaunchShapesSnippet}
        language="ts"
        filename="agent-connector.config.mjs"
      />

      <Callout title="How the framework wires it">
        <C>package.json</C> supplies public identity. Your <C>bin.mjs</C> wraps{" "}
        <C>createConnectorCli</C> under that brand. <C>defineConnector</C> points
        at the real MCP process or URL. Install then renders native host config
        from that single declaration. Stdio processes can be launched through the
        stable home binary for per-tool telemetry; remote HTTP servers are
        registered by URL where the host supports them.
      </Callout>

      <H3 id="sdk-cli-boundary">CLI boundary</H3>
      <P>
        <C>@ken-jo/agent-connector/cli</C> is a separate boundary: use{" "}
        <C>createConnectorCli</C> in your package&apos;s <C>bin</C> so users run
        your command, for example <C>acme-db install</C> or{" "}
        <C>npx @acme/acme-db-mcp install</C>. The framework CLI remains useful
        for framework development and connector-free usage telemetry, not as the
        foreground installer brand for your MCP package.
      </P>
      <CodeBlock code={S.brandedCliSnippet} language="ts" filename="bin.mjs" />

      <H3 id="sdk-audit">What the framework can audit</H3>
      <P>
        Because package metadata and <C>defineConnector</C> are both structured,
        <C>audit</C> can verify that the package identity, branded bin, install
        command, MCP server command, runtime dependency, and rendered host
        aliases stay aligned before users install anything. In a branded package
        that means <C>acme-db audit</C>; from the framework CLI it is{" "}
        <C>agent-connector audit --connector ./agent-connector.config.mjs</C>.
        That audit surface is why the SDK keeps identity in one place instead
        of asking the wizard or docs reader to duplicate it.
      </P>
      <Callout title="Framework first in code, brand first for users">
        Developers install <C>@ken-jo/agent-connector</C> as a dependency.
        Users install or run <em>your</em> MCP package. Connector-free token
        telemetry is the exception where the framework package can be used
        directly.
      </Callout>

      <H3 id="sdk-agent-readiness">Agent-ready references</H3>
      <P>
        Most connector packages will be scaffolded, reviewed, and repaired by AI
        agents. The repo therefore ships machine-readable and skill-friendly
        references: <C>llms.txt</C> for the short route map,{" "}
        <C>llms-full.txt</C> for the exhaustive contract, and{" "}
        <C>skills/agent-connector/SKILL.md</C> as a small router into focused
        files under <C>skills/agent-connector/references/</C>. Agents should read
        only the reference they need, then validate with SDK offline harnesses,
        dry-run install plans, and <C>doctor --probe</C> when a real stdio server
        is available.
      </P>
      <P>
        This mirrors the pattern used by agent-ready toolchains such as
        shadcn/ui: keep a compact LLM map, read structured project config before
        generating code, expose a small skill entry point, and reserve deeper
        reference files for task-specific detail.
      </P>
    </DocSection>
  );
}

export function QuickStart() {
  return (
    <DocSection id="quick-start" eyebrow="Getting Started" title="Quick start">
      <Lead>
        The <strong>MCP developer</strong> deploying their own MCP everywhere —
        three steps: depend on agent-connector, declare your connector with{" "}
        <C>defineConnector</C>, then ship a branded CLI/package. During
        development you can still run the framework command from the project as
        a fallback.
      </Lead>

      <Callout title="Just want to see the usage of the CLIs you already use?" tone="note">
        No <C>defineConnector</C>, no config file, no install. If you simply want
        to know how many tokens your agent CLIs are burning, that is the{" "}
        <Link className="underline hover:text-foreground" to="/docs/user">
          agent-CLI user track
        </Link>{" "}
        — one connector-free command that reads their own session logs
        read-only.
      </Callout>

      <Callout title="Don't have an MCP server yet?" tone="note">
        agent-connector <strong>deploys</strong> an MCP server you already have —
        it doesn&apos;t write one for you, so step 0 is having a server file. The{" "}
        <a
          className="underline hover:text-foreground"
          href="https://modelcontextprotocol.io/quickstart/server"
          target="_blank"
          rel="noreferrer"
        >
          official MCP SDK quickstart
        </a>{" "}
        is the fastest on-ramp, and{" "}
        <C>examples/acme-db/acme-db-mcp-server.mjs</C> in this repo is a
        self-contained stub you can copy. Once you have a server file, point the
        connector&apos;s <C>server</C> at it (next step).
      </Callout>

      <P>
        Add the dependency and create an{" "}
        <C>agent-connector.config.&#123;mjs,js,json&#125;</C> at your project root
        (found by walking up from the project dir, or pass{" "}
        <C>--connector &lt;path&gt;</C>):
      </P>
      <CodeBlock code={S.quickStartSnippet} language="bash" filename="terminal" />
      <P>
        The config below is the canonical example — see{" "}
        <Link className="underline hover:text-foreground" to="/docs/dev/define-connector">
          defineConnector
        </Link>{" "}
        for the full field reference. Every command is idempotent, reversible,
        and <C>--dry-run</C>-able. <C>install</C> targets the hosts{" "}
        <strong>detected</strong> on your machine (or an explicit{" "}
        <C>--targets</C> list), intersected with the adapter registry. The{" "}
        <C>server</C> below points at a published package
        (<C>command: &quot;npx&quot;</C> + <C>args: [&quot;-y&quot;, &quot;@acme/acme-db-mcp&quot;]</C>);
        while you&apos;re still developing, the same field can be{" "}
        <C>command: &quot;node&quot;</C> + a local server-file path (the{" "}
        <C>acme-db-mcp-server.mjs</C> stub above) — then switch to the{" "}
        <C>npx</C>-plus-package shape once you publish.
      </P>
      <CodeBlock
        code={S.defineConnectorSnippet}
        language="ts"
        filename="agent-connector.config.mjs"
      />
      <Callout title="Branded package first">
        Ship a <strong>branded CLI</strong> so your users run{" "}
        <C>&lt;your-tool&gt; install</C> / <C>&lt;your-tool&gt; leaderboard</C>{" "}
        (auto-scoped to your connector — see{" "}
        <Link className="underline hover:text-foreground" to="/docs/dev/embed-cli">
          Embed it / branded CLI
        </Link>
        ). Use <C>npx @ken-jo/agent-connector …</C> from the project only as a
        development fallback. Per-tool telemetry for your own wrapped server is
        automatic for <strong>stdio</strong> servers; remote servers are
        registered but not wrapped.
      </Callout>
    </DocSection>
  );
}

export function EmbedCli() {
  return (
    <DocSection
      id="embed-cli"
      eyebrow="Getting Started"
      title="Embed it / ship a branded CLI"
    >
      <Lead>
        agent-connector is an <strong>SDK a connector developer depends on</strong>
        . With <C>createConnectorCli(&#123; packageJson, connector &#125;)</C> you expose{" "}
        <strong>every</strong> agent-connector subcommand under your own brand —
        fully delegated and <strong>auto-scoped</strong> to the connector your
        package ships. <C>packageJson</C> supplies public identity;{" "}
        <C>connector</C> supplies behavior, so these are separate layers rather
        than duplicate prompts. Your users run <C>&lt;your-tool&gt; install</C> /{" "}
        <C>&lt;your-tool&gt; leaderboard</C> / <C>&lt;your-tool&gt; telemetry</C>{" "}
        without a framework global install or <C>--connector</C> for branded MCP
        install commands.
      </Lead>

      <H3 id="embed-package">1. Depend on it + add a bin</H3>
      <P>
        agent-connector is a normal <C>dependency</C> (not <C>-g</C>). Your
        package declares a <C>bin</C>; installing your package links that bin onto
        the user&apos;s PATH.
      </P>
      <CodeBlock
        code={S.brandedPackageJsonSnippet}
        language="json"
        filename="package.json"
      />

      <H3 id="embed-bin">2. createConnectorCli in your bin</H3>
      <P>
        Import <C>createConnectorCli</C> from the <C>@ken-jo/agent-connector/cli</C>{" "}
        export, point it at your shipped config, and <C>.run()</C> it. That is the
        whole bin — every command behavior still lives in agent-connector; this is
        pure brand + auto-scope.
      </P>
      <CodeBlock code={S.brandedBinSnippet} language="ts" filename="bin.mjs" />

      <H3 id="embed-usage">3. Your users drive your brand</H3>
      <P>
        After installing <em>your</em> package, the consumer runs your bin. Each
        subcommand targets your connector with no <C>--connector</C>:
      </P>
      <CodeBlock
        code={S.brandedUsageSnippet}
        language="bash"
        filename="terminal"
      />

      <H3 id="embed-scoping">Auto-scoping &amp; the shared home binary</H3>
      <P>
        A branded subcommand is just the matching agent-connector command with
        your connector pre-injected — argument transformation only, no duplicated
        logic. Config-path commands (<C>install</C>, <C>upgrade</C> [+ <C>sync</C>/
        <C>update</C> aliases], <C>doctor</C>, <C>status</C>, <C>uninstall</C>,{" "}
        <C>package</C>) get your config <strong>path</strong>;{" "}
        <C>leaderboard</C> / <C>telemetry</C> get your connector{" "}
        <strong>id</strong> as a filter; <C>serve</C> / <C>hook</C> get the id for
        the runtime.
      </P>
      <CodeBlock
        code={S.brandedScopingSnippet}
        language="bash"
        filename="branded ≈ agent-connector"
      />
      <Callout title="One home binary underneath every brand">
        Branded CLIs are a thin scoping layer over the <strong>same</strong>{" "}
        single home binary: <C>serve</C> and <C>hook</C> still route through the
        one <C>~/.agent-connector</C> runtime that <C>&lt;your-tool&gt; install</C>{" "}
        wires every host&apos;s native config back to. Two packages that each ship
        their own brand share that infrastructure — see the{" "}
        <Link className="underline hover:text-foreground" to="/docs/dev/operating-model">
          operating model
        </Link>
        .
      </Callout>
    </DocSection>
  );
}

/* ================================================================== */
/* Core API                                                            */
/* ================================================================== */

export function DefineConnector() {
  return (
    <DocSection id="define-connector" eyebrow="Core API" title="defineConnector">
      <Lead>
        <C>defineConnector(config: ConnectorConfig): ResolvedConnector</C> — the
        public, write-once surface. It validates eagerly and{" "}
        <strong>throws <C>ConnectorConfigError</C></strong> on any violation,
        returning a fully-defaulted <C>ResolvedConnector</C> that adapters and
        the CLI consume.
      </Lead>

      <P>
        The typed per-surface identity helpers and host-capability introspection
        live at the consolidated <C>@ken-jo/agent-connector/sdk</C> subpath:{" "}
        <C>defineStatusline</C>, <C>defineAction</C>, <C>defineHook</C>,{" "}
        <C>defineCommand</C>, <C>defineSkill</C>, <C>defineSubagent</C>,{" "}
        <C>defineMemory</C>, <C>defineConfigPatch</C>, <C>defineNativeHook</C>,
        plus <C>hostsSupporting</C> / <C>capabilitiesOf</C> /{" "}
        <C>surfaceSupport</C>. The root <C>@ken-jo/agent-connector</C> export is
        unchanged for backward compatibility — these helpers are also
        re-exported from root.
      </P>

      <H3 id="connector-config">ConnectorConfig</H3>
      <FieldTable rows={connectorConfigFields} />

      <H3 id="validation-rules">Top-level validation rules</H3>
      <List>
        <LI>
          <C>config</C> must be an object; if supplied, <C>id</C> must match the
          kebab-case regex <C>^[a-z0-9][a-z0-9-]*$</C>. Otherwise it is derived
          from package identity metadata.
        </LI>
        <LI>
          A connector must declare <strong>at least one</strong> of <C>server</C>
          , <C>hooks</C>, <C>commands</C>, <C>skills</C>, <C>subagents</C>,{" "}
          <C>memory</C>, <C>statusline</C>, <C>actions</C> (or a per-platform{" "}
          <C>nativeHooks</C> / <C>configPatch</C> declaration) — else it throws.
        </LI>
        <LI>
          If <C>server</C> is present: stdio transport requires a string{" "}
          <C>command</C>; any remote transport (<C>http</C>/<C>sse</C>/<C>ws</C>)
          requires a string <C>url</C>.
        </LI>
        <LI>Every present hook entry&apos;s <C>handler</C> must be a function.</LI>
      </List>

      <H3 id="resolved-connector">ResolvedConnector</H3>
      <P>
        What <C>defineConnector</C> returns: every optional <C>ConnectorConfig</C>{" "}
        field is resolved to a concrete value. <C>hookEvents</C> lists the events
        that have a function handler (what adapters install), and <C>telemetry</C>{" "}
        is fully defaulted. <C>commands</C> / <C>skills</C> / <C>subagents</C> /{" "}
        <C>memory</C> are normalized to <C>[]</C> when none.
      </P>
      <FieldTable rows={resolvedConnectorFields} />

      <H3 id="platform-override">PlatformOverride (escape hatch)</H3>
      <P>
        Per-platform overrides keep the universal core thin. Use <C>extra</C> to
        reach platform-exclusive features the core doesn&apos;t model — a thin
        universal core with a fat per-adapter tail.
      </P>
      <FieldTable rows={platformOverrideFields} />
      <CodeBlock
        code={S.platformOverrideSnippet}
        language="ts"
        filename="agent-connector.config.mjs"
      />

      <H3 id="config-patch">Host-config key patches (configPatch)</H3>
      <P>
        <C>extra</C> merges into the native MCP server <em>entry</em> — it
        cannot reach a sibling top-level settings key like Claude Code&apos;s{" "}
        <C>env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS</C>.{" "}
        <C>platforms.&lt;id&gt;.configPatch</C> declares those as
        ownership-tracked patches: you name a platform + key,{" "}
        <strong>never a file path</strong> — the adapter owns the key→file
        mapping (claude-code: <C>settings.json</C> at the install scope).
        <C>statusLine</C> is reserved for the first-class <C>statusline</C>{" "}
        surface instead of raw configPatch.
      </P>
      <FieldTable rows={configPatchFields} />
      <CodeBlock
        code={S.configPatchSnippet}
        language="ts"
        filename="agent-connector.config.mjs"
      />
      <Callout title="Fixed semantics — set-if-absent, skip-warn, refcounted ownership">
        The value is written <strong>only when the key is absent</strong>; ANY
        conflict (key already present, drifted value, non-object intermediate)
        is a skip-warn that prints current vs desired plus the exact manual
        edit — never an overwrite, delete, or deep merge. Ownership is
        refcounted in a persisted ledger
        (<C>&lt;dataRoot&gt;/state/config-patches.json</C>): co-owners share a
        key, and uninstall (run first, before other surfaces) deletes a key
        only when the <strong>last</strong> owner releases it AND the current
        value still equals what was written AND the key was absent before
        install — after backing up the file. <C>doctor</C> reports each patch
        as ok / drifted / missing / orphaned and <strong>never</strong>{" "}
        auto-fixes drift. Only claude-code sets <C>supportsConfigPatch</C>{" "}
        today; other adapters skip-warn with the per-patch manual edit. VS Code{" "}
        <C>inputs</C> arrays and Zed <C>context_servers.&lt;id&gt;.settings</C>{" "}
        are deliberately NOT configPatch targets (entry-coupled adapter
        dialect), and TOML hosts are out of v1 (comment-destroying round-trips
        are banned). A patch graduates to a typed cross-host knob only when ≥3
        hosts ship an analog.
      </Callout>
    </DocSection>
  );
}

export function ServerSection() {
  return (
    <DocSection id="server" eyebrow="Core API" title="Server">
      <Lead>
        <C>ServerDef</C> is a normalized, transport-polymorphic MCP server
        descriptor — declared once, rendered into each host&apos;s native dialect.
      </Lead>

      <CodeBlock code={S.serverDefSnippet} language="ts" filename="ServerDef" />
      <FieldTable rows={serverDefFields} />

      <H3 id="transports">Transports &amp; dialects</H3>
      <P>
        The <strong>root key and field names differ per host</strong> (constant
        per adapter): <C>mcpServers</C> (Claude Code, Cursor, Copilot CLI,
        Codebuff, Warp, Antigravity, …), <C>servers</C> (VS Code Copilot),{" "}
        <C>mcp_servers</C> (Codex TOML), <C>mcp</C> (Crush, OpenCode, Kilo), a
        flat dotted <C>amp.mcpServers</C> (Amp), <C>context_servers</C> (Zed).
        Field renames like{" "}
        <C>cwd</C>↔<C>working_directory</C> and <C>env</C>↔<C>environment</C> are
        handled per adapter. An adapter that cannot honor a requested transport{" "}
        <strong>downgrades-or-skips and reports it — it never throws</strong>.
      </P>
      <P>
        <C>$&#123;env:VAR&#125;</C> / <C>$&#123;env:VAR:-default&#125;</C>{" "}
        interpolation is universal; where a host supports native interpolation the
        reference is translated rather than baked in.
      </P>

      <H3 id="per-dialect-output">Per-dialect output</H3>
      <P>
        For the example server, <C>npx @acme/acme-db-mcp install</C> writes each
        host&apos;s native shape (hooks land in a sibling settings file, all pointing
        back to the one stable home binary):
      </P>
      <Tabs defaultValue="claude" className="not-prose">
        <TabsList className="flex h-auto flex-wrap justify-start gap-1">
          <TabsTrigger value="claude">Claude Code</TabsTrigger>
          <TabsTrigger value="codex">Codex CLI</TabsTrigger>
          <TabsTrigger value="cursor">Cursor</TabsTrigger>
          <TabsTrigger value="vscode">VS Code Copilot</TabsTrigger>
        </TabsList>
        <TabsContent value="claude" className="mt-4">
          <CodeBlock code={S.claudeCodeOutput} language="json" filename="Claude Code" />
        </TabsContent>
        <TabsContent value="codex" className="mt-4">
          <CodeBlock code={S.codexOutput} language="toml" filename="Codex CLI" />
        </TabsContent>
        <TabsContent value="cursor" className="mt-4">
          <CodeBlock code={S.cursorOutput} language="json" filename="Cursor" />
        </TabsContent>
        <TabsContent value="vscode" className="mt-4">
          <CodeBlock code={S.vscodeOutput} language="json" filename="VS Code Copilot" />
        </TabsContent>
      </Tabs>
    </DocSection>
  );
}

export function HooksSection() {
  return (
    <DocSection id="hooks" eyebrow="Core API" title="Hooks">
      <Lead>
        Declare lifecycle hooks once against normalized events; the framework
        synthesizes the right shape per host paradigm and formats your reply into
        the host&apos;s native control surface.
      </Lead>

      <Callout title="Hooks vary the most across hosts">
        This page is the API reference. For the full canonical-event × platform{" "}
        <strong>mapping matrix</strong>, per-platform tabs, and the Claude Code ↔
        Kilo CLI comparison, see the dedicated{" "}
        <Link className="underline hover:text-foreground" to="/docs/dev/hooks-guide">
          Hooks: cross-platform guide
        </Link>
        .
      </Callout>

      <CodeBlock code={S.hooksConfigSnippet} language="ts" filename="HooksConfig" />
      <P>
        <C>matcher</C> is a regex matched against the tool name (tool events,
        incl. <C>PermissionRequest</C> / <C>PostToolUseFailure</C>) or against
        the agent type (<C>SubagentStart</C> / <C>SubagentStop</C>); empty or
        omitted matches all. It is rendered into each host&apos;s native matcher
        syntax where supported, else evaluated by the universal entrypoint at
        runtime.
      </P>

      <H3 id="hook-events">Normalized events</H3>
      <P>
        Every event extends a base{" "}
        <C>
          &#123; hostPlatform, connectorId, sessionId, projectDir?, raw &#125;
        </C>{" "}
        (<C>sessionId</C> is <C>&quot;&quot;</C> when the host provides none;{" "}
        <C>raw</C> is the verbatim host payload for escape-hatch use):
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Event</Th>
            <Th>Extra payload fields</Th>
          </tr>
        </thead>
        <tbody>
          {hookEventRows.map((r) => (
            <tr key={r.event}>
              <Td className="whitespace-nowrap">
                <code className="font-mono text-[0.82rem] font-medium text-foreground">
                  {r.event}
                </code>
              </Td>
              <Td>
                <Code>{r.payload}</Code>
              </Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>

      <H3 id="hook-response">HookResponse</H3>
      <P>
        Return a subset of these fields; the adapter formats it into the
        host&apos;s native reply (exit codes / JSON / control fields) and{" "}
        <strong>drops fields the host can&apos;t honor</strong>, reporting the
        degradation.
      </P>
      <FieldTable rows={hookResponseFields} />

      <H4>Decision semantics</H4>
      <DocsTable>
        <thead>
          <tr>
            <Th>decision</Th>
            <Th>Meaning</Th>
          </tr>
        </thead>
        <tbody>
          {decisionSemantics.map((r) => (
            <tr key={r.decision}>
              <Td className="whitespace-nowrap">
                <Code>{r.decision}</Code>
              </Td>
              <Td className="text-muted-foreground">{r.meaning}</Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>
      <CodeBlock
        code={S.hookHandlerSnippet}
        language="ts"
        filename="agent-connector.config.mjs"
      />

      <H3 id="paradigms">Three paradigms</H3>
      <P>
        The framework picks the right synthesis from the host&apos;s detected
        paradigm:
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Paradigm</Th>
            <Th>Hosts</Th>
            <Th>How hooks are delivered</Th>
          </tr>
        </thead>
        <tbody>
          {paradigmRows.map((r) => (
            <tr key={r.id}>
              <Td className="whitespace-nowrap">
                <Code>{r.label}</Code>
              </Td>
              <Td>
                {/* Count derives from the registry-backed platform lists (drift-
                    guarded in tests/docs/platform-drift.test.ts) so it can never
                    rot independently of the adapters like the old 16/7/8 did. */}
                <Badge variant="muted">
                  {
                    {
                      "json-stdio": jsonStdioPlatforms.length,
                      "ts-plugin": tsPluginPlatforms.length,
                      "mcp-only": mcpOnlyPlatforms.length,
                    }[r.id]
                  }
                </Badge>
              </Td>
              <Td className="text-muted-foreground">{r.description}</Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>
      <Callout title="Fail-open runtime contract">
        The hook entrypoint never rejects, so a framework or handler bug
        can&apos;t wedge a host&apos;s tool call.
      </Callout>

      <H3 id="native-hooks">Native hooks passthrough</H3>
      <P>
        The normalized union stays small on purpose — hosts ship far more events
        than 13 (Claude Code alone has <strong>30</strong>). For host-only
        events, <C>platforms.&lt;id&gt;.nativeHooks</C> wires{" "}
        <strong>any</strong> native event by its verbatim name — including
        events a host adds in the future — with zero agent-connector releases:
      </P>
      <CodeBlock
        code={S.nativeHooksSnippet}
        language="ts"
        filename="agent-connector.config.mjs"
      />
      <Callout title="Raw in, verbatim out — and exit 0 only">
        No normalization and no <C>HookResponse</C> mapping: the handler reads
        the host&apos;s raw stdin payload (<C>evt.raw</C>) and its return value
        is the verbatim stdout JSON reply. <C>void</C> → exit 0 with no output;
        any throw fails open. Exit-2 blocking semantics are{" "}
        <strong>not modeled</strong> in v1 — JSON-on-exit-0 decision control
        covers Claude Code&apos;s events. Declaring one of the 13 normalized
        event names here is a <C>ConnectorConfigError</C> (use <C>hooks</C> for
        those). 16 adapters set <C>supportsNativeHooks</C> today (claude-code,
        codebuddy, opencode, cursor, gemini-cli, qwen-code, amp, kimi, omp, hermes,
        jetbrains-copilot, copilot-cli, continue, nemoclaw, openclaw, grok-cli); adapters
        that leave it unset skip-warn, never silently. An event is promoted into the
        normalized union once ≥3 hosts ship a native analog —{" "}
        <C>TaskCreated</C> / <C>TaskCompleted</C> are the first candidates.
      </Callout>
    </DocSection>
  );
}

export function SurfacesSection() {
  return (
    <DocSection
      id="surfaces"
      eyebrow="Core API"
      title="Commands, Skills, Subagents, Memory, Statusline & Actions"
    >
      <Lead>
        Content surfaces are <strong>content-only</strong> (markdown / TOML
        files): no runtime dispatch, no telemetry wrapping, no home-bin pointer —
        pure file writers. Each supporting adapter writes the native file(s);
        unsupporting adapters skip + warn. <C>memory</C> is the fourth content
        surface with the same contract, except it edits a <strong>shared,
        user-authored</strong> memory/rules file (AGENTS.md / CLAUDE.md /
        GEMINI.md) via marker-fenced managed blocks instead of writing files
        agent-connector wholly owns — see{" "}
        <a className="underline hover:text-foreground" href="#memory-def">
          MemoryDef
        </a>{" "}
        below.
      </Lead>
      <P>
        <C>SurfaceToolPolicy</C> is shared:{" "}
        <C>&#123; allow?: string[]; deny?: string[] &#125;</C> — rendered to each
        host&apos;s allowed-tools / tools[] / readonly.
      </P>
      <P>
        Plus two runtime-dispatched handler surfaces beyond the content writers —
        a singular <C>statusline</C> and <C>actions</C>, each set up below.
      </P>

      <H3 id="statusline">Status line</H3>
      <P>
        A singular <C>statusline</C> — a HUD <C>render(ctx)</C> handler with
        top-level/per-host options; claude-code and antigravity-cli (top-level
        statusLine) and qwen-code (nested ui.statusLine in settings.json) today,
        other hosts skip-warn.
      </P>

      <H3 id="actions">Actions</H3>
      <P>
        <C>actions</C> — user-invokable <C>run(ctx)</C> handlers dispatched by{" "}
        <C>agent-connector action</C> with label/icon/placement/confirm metadata;
        v1 ships the dispatch backbone, and host affordance emitters now ship for
        droid, hermes, kiro, omp, openclaw, pi, warp, and zed (plus the nemoclaw
        fork, which inherits openclaw&apos;s emitter); hosts with no verifiable
        emission target skip-warn.
      </P>

      <H3 id="command-def">CommandDef</H3>
      <P>A slash command.</P>
      <FieldTable rows={commandDefFields} />

      <H3 id="skill-def">SkillDef</H3>
      <P>An Agent Skill (folder + SKILL.md, Agent Skills open standard).</P>
      <FieldTable rows={skillDefFields} />

      <H3 id="subagent-def">SubagentDef</H3>
      <P>A named subagent (system-prompt + tool/model scoping).</P>
      <FieldTable rows={subagentDefFields} />

      <CodeBlock
        code={S.commandSnippet}
        language="ts"
        filename="agent-connector.config.mjs"
      />

      <H3 id="memory-def">MemoryDef</H3>
      <P>
        Standing guidance declared once and upserted by every supporting adapter
        as a <strong>managed block</strong> into the memory/rules file that host
        actually reads. Unlike the three surfaces above, the target file is{" "}
        <strong>shared and user-authored</strong> — agent-connector never touches
        bytes outside its own marker pair.
      </P>
      <FieldTable rows={memoryDefFields} />
      <CodeBlock
        code={S.memorySnippet}
        language="ts"
        filename="agent-connector.config.mjs"
      />

      <H3 id="memory-managed-blocks">Managed blocks: markers, hashes, reversibility</H3>
      <P>
        Every memory write goes through one dependency-free engine
        (<C>core/managed-block.ts</C>). The block is fenced by HTML-comment
        markers carrying the blockId (<C>&lt;connectorId&gt;/&lt;name&gt;</C> —
        unique per connector, so multiple connectors coexist in one file) and a
        content hash (first 12 hex of sha256 over the normalized inner content):
      </P>
      <CodeBlock code={S.managedBlockSnippet} language="markdown" filename="AGENTS.md" />
      <List>
        <LI>
          <strong>Idempotent:</strong> unchanged content → an O(1) <C>skip</C>{" "}
          (no mtime/git churn); replacement is <strong>in place</strong> — zero
          bytes outside the marker pair ever change, no move-to-top, no
          blank-line reflow. New blocks append at EOF with exactly one blank
          separator line; a missing file is created and recorded as
          agent-connector-created.
        </LI>
        <LI>
          <strong>Edit detection:</strong> if the actual inner hash differs from
          the recorded <C>hash=</C>, the user edited inside the block — sync{" "}
          <C>warn</C>s and leaves the edit intact; only{" "}
          <C>install --force</C> overwrites, after a timestamped backup.
        </LI>
        <LI>
          <strong>Robust scanning:</strong> line-anchored, CRLF-preserving,
          BOM-safe, and fence-aware (marker text quoted inside code fences never
          matches); lone stray markers are recovered safely and duplicate pairs
          collapse on upsert.
        </LI>
        <LI>
          <strong>Fully reversible:</strong> memory installs last among the
          content surfaces and is removed <strong>first</strong> on uninstall —
          a prefix scan over the connector&apos;s marker namespace (plus the
          persisted ownership ledger) excises every block, reclaims the blank
          separator line, and deletes the file only when agent-connector created
          it and nothing else remains. <C>doctor</C> verifies each installed
          block: file present / block present / hash intact / user-edited.
        </LI>
      </List>

      <H3 id="memory-targets">AGENTS.md-first: where the block goes</H3>
      <P>
        <strong>AGENTS.md adopters read the open{" "}
        <a
          className="underline hover:text-foreground"
          href="https://agents.md"
          target="_blank"
          rel="noreferrer"
        >
          AGENTS.md
        </a>{" "}
        standard file</strong> (the Linux Foundation-stewarded &quot;README
        for agents&quot; format) — so you write the guidance once and it lands in
        the standard file across adopter hosts. agent-connector never flips
        host settings to make AGENTS.md readable (probe-and-respect only), and
        the non-reader hosts are wired per their own official docs — CLAUDE.md
        and GEMINI.md, plus the dedicated rules-dir hosts (.amazonq/rules,
        .continue/rules, .windsurf/rules):
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Host</Th>
            <Th>project scope</Th>
            <Th>user scope</Th>
            <Th>Notes</Th>
          </tr>
        </thead>
        <tbody>
          {memoryTargetRows.map((r) => (
            <tr key={r.host}>
              <Td className="whitespace-nowrap">
                <code className="font-mono text-[0.8rem] text-foreground">
                  {r.host}
                </code>
              </Td>
              <Td className="text-muted-foreground">
                <span className="font-mono text-[0.75rem]">{r.project}</span>
              </Td>
              <Td className="text-muted-foreground">
                <span className="font-mono text-[0.75rem]">{r.user}</span>
              </Td>
              <Td className="text-muted-foreground">{r.note}</Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>
      <Callout title="Why HTML-comment markers are correct for CLAUDE.md">
        Claude Code strips HTML comments from CLAUDE.md before injecting it into
        the model&apos;s context — so the markers and the do-not-edit notice are{" "}
        <strong>invisible to Claude</strong> while remaining fully parseable by
        agent-connector for sync / doctor / uninstall. On AGENTS.md hosts (which
        inline the whole file into the prompt) the one-line notice doubles as an
        in-prompt &quot;do not edit&quot; instruction to the host&apos;s own
        agent.
      </Callout>

      <H3 id="surface-validation">Validation rules</H3>
      <List>
        <LI>
          Each <C>name</C> must be kebab-case <C>^[a-z0-9][a-z0-9-]*$</C>; no
          duplicate <C>name</C> within a single surface array.
        </LI>
        <LI>
          Required non-empty strings: command <C>prompt</C>; skill{" "}
          <C>description</C> + <C>body</C>; subagent <C>description</C> +{" "}
          <C>prompt</C>.
        </LI>
        <LI>
          Skill <C>description</C> length must be <C>&lt;= 1024</C> (throws
          otherwise).
        </LI>
        <LI>
          Skill <C>resources</C> keys must be SAFE relative paths inside the
          skill dir — empty, <C>.</C>, absolute, or any <C>..</C>-traversal key
          is rejected.
        </LI>
        <LI>
          Memory <C>content</C> must be non-empty; hard{" "}
          <C>ConnectorConfigError</C> above 16 KiB (it is injected into every
          prompt of every targeted host) or when it contains the literal marker
          tokens <C>agent-connector:begin</C> / <C>agent-connector:end</C>. A
          soft 4 KiB budget is an install-time <C>warn</C>, not a config error.
        </LI>
      </List>

      <H3 id="surface-support">Per-platform surface support</H3>
      <P>
        Adapters that don&apos;t support a surface skip with a warning.{" "}
        <C>&lt;n&gt;</C> is the surface name; skills are uniformly
        folder-per-skill <C>SKILL.md</C> (only the parent dir differs per
        platform). Memory targets are listed separately under{" "}
        <a className="underline hover:text-foreground" href="#memory-targets">
          AGENTS.md-first
        </a>{" "}
        above.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Platform</Th>
            <Th>command</Th>
            <Th>skill</Th>
            <Th>subagent</Th>
          </tr>
        </thead>
        <tbody>
          {surfaceSupportRows.map((r) => (
            <tr key={r.platform}>
              <Td className="whitespace-nowrap">
                <code className="font-mono text-[0.8rem] text-foreground">
                  {r.platform}
                </code>
              </Td>
              <Td className="text-muted-foreground">
                <span className="font-mono text-[0.75rem]">{r.command}</span>
              </Td>
              <Td className="text-muted-foreground">
                <span className="font-mono text-[0.75rem]">{r.skill}</span>
              </Td>
              <Td className="text-muted-foreground">
                <span className="font-mono text-[0.75rem]">{r.subagent}</span>
              </Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>
    </DocSection>
  );
}

/* ================================================================== */
/* Track your agent-CLI usage (the user track — Audience B)            */
/* ================================================================== */

export function UserOverview() {
  return (
    <DocSection
      id="overview"
      eyebrow="Agent-CLI user · start here"
      title="See your agent-CLI usage"
    >
      <Lead>
        For the <strong>agent-CLI user</strong> who has <strong>not</strong>{" "}
        authored a connector. With zero setup — no <C>defineConnector</C>, no
        config file, no install — <C>agent-connector usage</C> scans each agent
        CLI&apos;s own native session logs/DBs and shows token usage aggregated
        by agent CLI, model, project, session, or day.
      </Lead>

      <P>
        This track is three pages:{" "}
        <Link className="underline hover:text-foreground" to="/docs/user/overview">
          Overview &amp; quick start
        </Link>{" "}
        (this page — run it in one command),{" "}
        <Link className="underline hover:text-foreground" to="/docs/user/usage">
          Reports &amp; leaderboards
        </Link>{" "}
        (every <C>usage</C> flag, grouping, and export), and{" "}
        <Link className="underline hover:text-foreground" to="/docs/user/coverage-confidence">
          Coverage &amp; confidence
        </Link>{" "}
        (which hosts are exact vs estimated, and the requires-sync rows).
      </P>

      <Callout title="This is the connector-free track" tone="note">
        Everything here works straight from <C>npx @ken-jo/agent-connector</C>{" "}
        with no setup. <C>usage</C> reads your local agent-CLI logs{" "}
        <strong>read-only</strong> and never writes any host config, never runs{" "}
        <C>install</C>, and never needs a connector. Counts only — never your
        prompts or results.
      </Callout>

      {/* The qs-user anchor id is load-bearing: the legacy
          /docs/quick-start#qs-user deep link redirects here and scrolls to it. */}
      <H3 id="qs-user">Run it — zero setup</H3>
      <P>
        No <C>defineConnector</C>, no config file, no install. If you simply want
        to know how many tokens your agent CLIs are burning, run one command and
        agent-connector reads their own session logs read-only:
      </P>
      <CodeBlock code={S.usageQuickStartSnippet} language="bash" filename="terminal" />
      <Callout title="What this can and cannot show" tone="warn">
        <C>usage</C> reports <strong>whole-conversation totals</strong>, not
        per-MCP / per-tool cost — see the{" "}
        <Link className="underline hover:text-foreground" to="/docs/user/usage#per-mcp-vs-host">
          canonical per-MCP vs host-scan explanation
        </Link>{" "}
        for why, and which track gives you per-tool numbers.
      </Callout>
    </DocSection>
  );
}

export function Usage() {
  return (
    <DocSection
      id="usage"
      eyebrow="Track your agent-CLI usage"
      title="Usage reports & leaderboards"
    >
      <Lead>
        <C>agent-connector usage</C> scans each agent CLI&apos;s own native
        session logs/DBs <strong>read-only</strong> and shows token usage
        aggregated by agent CLI, model, project, session, or day — as a report,
        a leaderboard, or an export.
      </Lead>

      <H3 id="usage-run">Run it</H3>
      <P>
        Group with <C>--by platform|project|session|model|day</C>, scope a
        window with <C>--since 7d</C>, restrict to one host with{" "}
        <C>--platform &lt;id&gt;</C>, and add <C>--json</C> for machine-readable
        output. <C>usage leaderboard --by platform</C> ranks hosts with the
        columns RANK / PLATFORM / IN / OUT / CACHE_R / CACHE_W / REASON /
        TOTAL / SESS / CONF (use <C>--by model</C> to rank by model
        instead). <C>usage export --format csv|json --out &lt;file&gt;</C> writes
        the raw aggregate rows.
      </P>
      <CodeBlock code={S.usageReportSnippet} language="text" filename="terminal" />

      <H3 id="per-mcp-vs-host">
        Per-MCP (serve-proxy) vs connector-free (host-scan)
      </H3>
      <Callout
        title="What usage does NOT show: per-MCP / per-tool cost"
        tone="warn"
      >
        <em>This is the canonical explanation of the two telemetry sources — the
        rest of the docs link here.</em> The connector-free <C>usage</C>{" "}
        host-scan reports <strong>whole-conversation totals</strong> per agent
        CLI / model / project / session / day — it does <strong>not</strong>{" "}
        itemize cost per individual MCP server or per tool. Agent CLIs fold tool
        results into the session&apos;s input tokens and never attribute them to
        a tool name, so the connector-free path can only report
        whole-conversation totals. This is a current capability boundary of host
        logs. <strong>Per-MCP and per-tool token costs require the MCP to run
        through agent-connector&apos;s serve proxy</strong>, which is the{" "}
        <Link className="underline hover:text-foreground" to="/docs/dev/telemetry-overview?from=user/usage">
          MCP-developer telemetry track
        </Link>{" "}
        — and even then only for a server <em>your own</em> connector declares
        and wraps, not for an arbitrary MCP you didn&apos;t author.
      </Callout>

      <P>
        See the{" "}
        <Link className="underline hover:text-foreground" to="/docs/dev/cli?from=user/usage">
          CLI reference
        </Link>{" "}
        for every <C>usage</C> flag. <C>usage</C> is the only token view that
        works with no setup — the unified{" "}
        <Link className="underline hover:text-foreground" to="/docs/dev/leaderboards?from=user/usage">
          leaderboard
        </Link>
        &apos;s other two boards need a connector or the opt-in usage hook.
      </P>
    </DocSection>
  );
}

export function CoverageConfidence() {
  return (
    <DocSection
      id="coverage-confidence"
      eyebrow="Track your agent-CLI usage"
      title="Coverage & confidence"
    >
      <Lead>
        Local readers (claude-code, codex, gemini-cli, and others) report
        host-logged <strong>exact</strong> counts; a few readers are{" "}
        <strong>host-estimated</strong> (labeled in the CONFIDENCE column, e.g.
        Kiro char/4). Five &quot;synced&quot; platforms are reported as skipped
        (<C>requires sync — no local cache found</C>) unless a tokscale-style
        local cache already exists, because agent-connector does not populate
        that cache:
      </Lead>
      <List>
        {syncedPlatforms.map((p) => (
          <LI key={p}>
            <Code>{p}</Code>
          </LI>
        ))}
      </List>
      <P>
        See the{" "}
        <Link className="underline hover:text-foreground" to="/docs/dev/troubleshooting?from=user/coverage-confidence#requires-sync">
          troubleshooting notes
        </Link>{" "}
        for what the skip line means (informational, not an error), and the{" "}
        <Link className="underline hover:text-foreground" to="/docs/dev/cli?from=user/coverage-confidence">
          CLI reference
        </Link>{" "}
        for every <C>usage</C> flag.
      </P>
    </DocSection>
  );
}

/* ================================================================== */
/* Telemetry (MCP developers — Audience A)                             */
/* ================================================================== */

export function TelemetryOverview() {
  return (
    <DocSection
      id="telemetry-overview"
      eyebrow="Telemetry"
      title="Overview"
    >
      <Lead>
        The only data identical across hosts is the server&apos;s own bytes. The{" "}
        <C>agent-connector serve</C> proxy intercepts every <C>tools/call</C> at
        the server boundary and tokenizes input and output locally.
      </Lead>
      <P>
        Input = <C>params.arguments</C>, output = <C>result.content[]</C> +{" "}
        <C>structuredContent</C>. With <C>measureToolDefs</C> (default on) it
        also tokenizes the <C>tools/list</C> schemas once → the fixed
        &quot;cost of merely defining my tools&quot; per-turn overhead. This
        measures the server <strong>your connector declares and wraps</strong>;
        to see per-CLI token totals without authoring a connector, use the{" "}
        <Link className="underline hover:text-foreground" to="/docs/user/usage">
          connector-free usage track
        </Link>{" "}
        instead.
      </P>
      <CodeBlock code={S.serveSnippet} language="bash" filename="wrapped MCP entry" />

      <H3 id="telemetry-config">TelemetryConfig</H3>
      <FieldTable rows={telemetryConfigFields} />
      <CodeBlock
        code={S.telemetrySnippet}
        language="ts"
        filename="agent-connector.config.mjs"
      />

      <H3 id="tokenizer">Tokenizer</H3>
      <P>
        Default <C>gpt-tokenizer</C> (pure-JS, no native build →
        Windows/single-binary safe): <C>o200k_base</C> for every family — exact
        for OpenAI/Codex-family, and a documented approximation for
        Anthropic-family (no offline Claude tokenizer ships).
        Family is auto-selected from <C>initialize.clientInfo</C> or{" "}
        <C>modelFamilyHint</C>. Fallback is a plain <C>chars/4</C> heuristic —
        explicitly labeled so it&apos;s never mistaken for exact. Separately,
        binary content blocks (image/audio/resource) are never base64-tokenized —
        each gets a flat per-modality token estimate (~85 each).
      </P>

      <H3 id="confidence-sources">Confidence sources</H3>
      <P>Every telemetry row carries one confidence source:</P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Source</Th>
            <Th>Meaning</Th>
          </tr>
        </thead>
        <tbody>
          {confidenceSources.map((r) => (
            <tr key={r.source}>
              <Td className="whitespace-nowrap">
                <Code>{r.source}</Code>
              </Td>
              <Td className="text-muted-foreground">{r.meaning}</Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>

      <H3 id="store">Store</H3>
      <P>
        Local, under the data-root, <strong>aggregate counts only — never raw
        args/results</strong>. MVP is an append-atomic NDJSON event log + derived
        rollups behind a <C>TelemetryStore</C> interface (<C>store: &quot;sqlite&quot;</C>{" "}
        is a drop-in upgrade). Rows are keyed roughly by{" "}
        <C>
          connectorId, toolName, scope (call|tool_defs|model_turn|hook), hostPlatform,
          sessionId, projectKey, projectDir, inputTokens, outputTokens,
          confidenceSource, isError, ts
        </C>
        .
      </P>

      <H3 id="host-usage-layer">Host usage layer</H3>
      <P>
        A separate read-only subsystem (<C>src/usage/</C>) parses each agent
        CLI&apos;s native logs/DBs (JSONL / JSON / SQLite via pure-WASM{" "}
        <C>sql.js</C> / synced-cache artifacts) to report
        per-platform/project/session/model/day usage. Confidence is{" "}
        <C>host-reported</C> (real numbers) vs <C>host-estimated</C> (e.g. Kiro
        char/4, Crush cost-only). It never writes host config and never collides
        with the serve-proxy store. Some hosts (cursor / antigravity /
        antigravity-cli / trae / warp) need an external sync agent-connector does
        not perform → those rows
        are &quot;requires sync, skipped&quot; unless a local cache already
        exists.
      </P>
    </DocSection>
  );
}

export function TelemetrySurfaces() {
  return (
    <DocSection
      id="telemetry-surfaces"
      eyebrow="Telemetry"
      title="The 5-surface model"
    >
      <Lead>
        Telemetry has <strong>two axes</strong>. The <strong>user/host axis</strong>{" "}
        measures whole-conversation usage (what the user spent); the{" "}
        <strong>developer/surface axis</strong> measures what the connector costs
        — now across <strong>all five</strong> developer surfaces.
      </Lead>

      <H3 id="two-axes">The two axes</H3>
      <div className="not-prose my-6 grid gap-4 md:grid-cols-2">
        {telemetryAxes.map((a) => (
          <div
            key={a.axis}
            className="rounded-xl border border-border bg-card/40 p-5 shadow-sm"
          >
            <div className="mb-2 flex items-center gap-2">
              <span aria-hidden className="text-lg">
                {a.glyph}
              </span>
              <span className="text-base font-semibold text-foreground">
                {a.axis}
              </span>
            </div>
            <p className="text-sm leading-relaxed text-foreground/90">
              {a.measures}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {a.source}
            </p>
          </div>
        ))}
      </div>

      <H3 id="telemetry-vocab">One table, four vocabularies</H3>
      <P>
        The telemetry types use four names for closely-related things — the{" "}
        <strong>developer surface</strong>, its <C>EventScope</C>(s), its{" "}
        <C>SurfaceKind</C>, and whether it is <strong>RUNTIME</strong>-measured or
        a <strong>STATIC</strong> footprint. On the developer surfaces{" "}
        <C>EventScope</C> and <C>SurfaceKind</C> co-vary, so this one table lines
        all four up. The detailed per-vocabulary tables follow below.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Surface</Th>
            <Th>EventScope(s)</Th>
            <Th>SurfaceKind</Th>
            <Th>RUNTIME / STATIC</Th>
            <Th>What it is</Th>
          </tr>
        </thead>
        <tbody>
          {telemetryReconcileRows.map((r) => (
            <tr key={`${r.surface}-${r.eventScope}`}>
              <Td className="whitespace-nowrap">
                <Code>{r.surface}</Code>
              </Td>
              <Td className="whitespace-nowrap">
                <Code>{r.eventScope}</Code>
              </Td>
              <Td className="whitespace-nowrap">
                <Code>{r.surfaceKind}</Code>
              </Td>
              <Td className="whitespace-nowrap">
                {r.kind === "—" ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <Badge
                    variant="muted"
                    className={
                      r.kind === "RUNTIME"
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                    }
                  >
                    {r.kind}
                  </Badge>
                )}
              </Td>
              <Td className="text-muted-foreground">{r.note}</Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>

      <H3 id="five-surfaces">The five developer surfaces</H3>
      <P>
        Two surfaces are <strong>RUNTIME</strong> (measured live, producing store
        rows): <C>server</C> (per-MCP-tool <C>call</C> + <C>tool_defs</C> via the
        serve-proxy) and <C>hooks</C> (per-event, measured at the home-bin hook
        entrypoint). Three are <strong>STATIC</strong> footprints computed
        on-demand from the connector — <C>command</C>, <C>skill</C>,{" "}
        <C>subagent</C> — the context cost the host pays to load them.{" "}
        <strong>Static footprints are sizes, not usage</strong>, and are never
        written as fake rows.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Surface</Th>
            <Th>Kind</Th>
            <Th>What is measured</Th>
            <Th>Detail</Th>
          </tr>
        </thead>
        <tbody>
          {telemetrySurfaces.map((s) => (
            <tr key={s.surface}>
              <Td className="whitespace-nowrap">
                <Code>{s.surface}</Code>
              </Td>
              <Td className="whitespace-nowrap">
                <Badge
                  variant="muted"
                  className={
                    s.kind === "RUNTIME"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                  }
                >
                  {s.kind}
                </Badge>
              </Td>
              <Td className="text-muted-foreground">
                <span className="font-mono text-[0.75rem]">{s.measured}</span>
              </Td>
              <Td className="text-muted-foreground">{s.detail}</Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>
      <Callout title="hook scope + surfaceKind are new">
        The runtime hook surface adds a new <C>EventScope</C> value{" "}
        <C>&quot;hook&quot;</C> and stamps <C>surfaceKind: &quot;hook&quot;</C> on
        each row. Measurement happens at the home-bin hook entrypoint and is{" "}
        <strong>fail-open</strong>: a telemetry error can never break a
        host&apos;s hook.
      </Callout>

      <H3 id="event-scope">EventScope &amp; SurfaceKind</H3>
      <P>
        Every store row carries an <C>EventScope</C> (what it measures) and an
        optional <C>SurfaceKind</C> (which developer surface). The four scopes are{" "}
        <strong>distinct origins that must never be summed</strong>:
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>EventScope</Th>
            <Th>Meaning</Th>
          </tr>
        </thead>
        <tbody>
          {eventScopeRows.map((r) => (
            <tr key={r.scope}>
              <Td className="whitespace-nowrap">
                <Code>{r.scope}</Code>
              </Td>
              <Td className="text-muted-foreground">{r.meaning}</Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>
      <DocsTable>
        <thead>
          <tr>
            <Th>SurfaceKind</Th>
            <Th>Meaning</Th>
          </tr>
        </thead>
        <tbody>
          {surfaceKindRows.map((r) => (
            <tr key={r.kind}>
              <Td className="whitespace-nowrap">
                <Code>{r.kind}</Code>
              </Td>
              <Td className="text-muted-foreground">{r.meaning}</Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>
      <P>
        <C>surfaceKind</C> is optional and backward-compatible: rows written
        before the field existed (every legacy serve-proxy{" "}
        <C>call</C>/<C>tool_defs</C> row) lack it and are read as <C>server</C>.
        The <C>command</C>/<C>skill</C>/<C>subagent</C> kinds only ever appear on
        static footprints — they never produce store rows.
      </P>

      <H3 id="guarantees">Local-first, zero-egress, opt-out</H3>
      <List>
        <LI>
          <strong>Local-first.</strong> Everything is tokenized locally and
          stored under the home data-root — aggregate counts only, never raw
          arguments or results.
        </LI>
        <LI>
          <strong>Zero network egress by default.</strong> The hot path makes no
          network call; only the opt-in calibration sampler ever sends content
          off-box.
        </LI>
        <LI>
          <strong>Opt-out.</strong> <C>AGENT_CONNECTOR_TELEMETRY=0</C> is a
          global kill switch honored by both the serve-proxy and the hook
          runtime. <C>telemetry: &#123; enabled: false &#125;</C> suppresses the
          serve-proxy telemetry wrap at install time (<C>shouldWrapForTelemetry</C>{" "}
          gates on <C>enabled === true</C>), but is NOT currently consulted by the
          hook runtime — an installed hook still records telemetry rows unless the
          env var is set.
        </LI>
      </List>

      <H3 id="confidence">Confidence sources</H3>
      <P>
        Every row (and every static footprint) carries one confidence source so
        an estimate is never read as exact — see{" "}
        <Link
          className="underline hover:text-foreground"
          to="/docs/dev/telemetry-overview#confidence-sources"
        >
          the confidence sources table
        </Link>
        . Static footprints are labeled with the tokenizer source for the
        connector&apos;s family (<C>tokenizer-exact</C> for OpenAI-family,{" "}
        <C>tokenizer-approx</C> otherwise).
      </P>

      <H3 id="per-surface-leaderboard">The per-surface leaderboard</H3>
      <P>
        <C>agent-connector telemetry leaderboard --by mcp|tool|surface</C> ranks
        the per-MCP telemetry by connector (the default <C>--by mcp</C>,
        &quot;which MCP server costs the most&quot;), by tool, or — new —{" "}
        <strong>by developer-axis surface</strong>. The <C>--by surface</C> view
        folds the runtime <C>server</C>/<C>hook</C> store rows together with the
        static <C>command</C>/<C>skill</C>/<C>subagent</C> footprints of the
        registered connector(s). Its columns:
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Column</Th>
            <Th>Meaning</Th>
          </tr>
        </thead>
        <tbody>
          {surfaceLeaderboardColumns.map((c) => (
            <tr key={c.column}>
              <Td className="whitespace-nowrap">
                <Code>{c.column}</Code>
              </Td>
              <Td className="text-muted-foreground">{c.meaning}</Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>
      <CodeBlock
        code={S.surfaceLeaderboardSnippet}
        language="text"
        filename="terminal"
      />
      <Callout title="Sizes are never summed with usage" tone="warn">
        Static footprints are <strong>sizes</strong> (the context-load cost of a
        surface), not runtime usage. The <C>KIND</C> column keeps{" "}
        <C>runtime</C> vs <C>static</C> explicit so the two are never silently
        conflated, and the whole-conversation <C>model_turn</C> rows are excluded
        from this view entirely (they get their own leaderboard section).
      </Callout>
    </DocSection>
  );
}

export function Leaderboards() {
  return (
    <DocSection id="leaderboards" eyebrow="Telemetry" title="Leaderboards">
      <Lead>
        The unified <C>agent-connector leaderboard</C> prints{" "}
        <strong>three origin-labeled boards that measure different things and
        are NEVER summed.</strong> Each has its own prerequisite, so for any
        given person some boards may be empty — read the PREREQUISITE column.
      </Lead>
      <Callout title="Agent-CLI users: use `usage`, not this unified board" tone="note">
        Only the 🖥️ Host/User board works with <strong>no setup</strong>. If you
        haven&apos;t authored a connector, the connector-free{" "}
        <Link className="underline hover:text-foreground" to="/docs/user/usage">
          <C>agent-connector usage</C>
        </Link>{" "}
        command is your primary entry point — it draws from the same
        connector-free host-scan source.
      </Callout>
      <DocsTable>
        <thead>
          <tr>
            <Th>Board</Th>
            <Th>Origin</Th>
            <Th>Measures</Th>
            <Th>Prerequisite</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td className="whitespace-nowrap">🔌 MCP / Plugin</Td>
            <Td>
              <Code>mcp-self</Code>
            </Td>
            <Td className="text-muted-foreground">
              Serve-proxy telemetry (per-MCP <C>call</C> + <C>tool_defs</C> rows;
              excludes host-native <C>model_turn</C> rows). &quot;Which MCP server
              costs the most tokens&quot; — for a server <strong>your own
              connector declares and wraps</strong>.
            </Td>
            <Td className="text-muted-foreground">
              A registered connector + serve traffic (stdio). Empty for an
              agent-CLI user with no connector.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">🖥️ Host / User</Td>
            <Td>
              <Code>host-scan-logs</Code>
            </Td>
            <Td className="text-muted-foreground">
              Host usage from scanning CLI logs. &quot;Which CLI/host spent the
              most.&quot; Whole-conversation totals only — no per-MCP/per-tool
              dimension.
            </Td>
            <Td className="text-muted-foreground">
              None — works with no setup. The only board an agent-CLI user sees.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">🛰️ Host-native turns</Td>
            <Td>
              <Code>host-native-live</Code>
            </Td>
            <Td className="text-muted-foreground">
              The opt-in AfterModel / PostInvocation usage hook (scope{" "}
              <C>model_turn</C>, confidence <C>host-native</C>). Whole-conversation,
              live and exact.
            </Td>
            <Td className="text-muted-foreground">
              The opt-in usage hook, installed only by the Gemini CLI and
              Antigravity adapters, and requires <C>--connector</C> at runtime.
            </Td>
          </tr>
        </tbody>
      </DocsTable>
      <P>
        The unified command <C>agent-connector leaderboard --scope &lt;slice&gt;</C>{" "}
        slices only the MCP section; <C>--json</C> emits{" "}
        <C>&#123; mcp, host, hostSkipped, hostNativeTurns &#125;</C>. The{" "}
        <strong>scope dimension</strong> applies to the MCP board, letting you
        narrow per-MCP rows to a slice without affecting the host boards.
      </P>
      <CodeBlock code={S.leaderboardSnippet} language="bash" filename="terminal" />

      <H3 id="connector-scoped">Scoped to your connector</H3>
      <P>
        As a connector developer you usually want only <strong>your</strong>{" "}
        connector&apos;s usage. Pass <C>--connector &lt;id&gt;</C> to filter the{" "}
        🔌 MCP/Plugin section — and that is exactly what a{" "}
        <Link className="underline hover:text-foreground" to="/docs/dev/embed-cli">
          branded CLI
        </Link>{" "}
        injects for you: <C>&lt;your-tool&gt; leaderboard</C> ≈{" "}
        <C>agent-connector leaderboard --connector &lt;id&gt;</C>. The 🖥️ Host/User
        board stays connector-agnostic (host CLI logs carry no connector
        attribution), so only the 🔌 MCP/Plugin and 🛰️ host-native sections are
        filtered.
      </P>
      <CodeBlock
        code={S.connectorLeaderboardSnippet}
        language="bash"
        filename="terminal"
      />
      <P>
        For the developer/connector axis there is also{" "}
        <C>agent-connector telemetry leaderboard --by mcp|tool|surface</C>: the{" "}
        <C>--by surface</C> variant ranks across the{" "}
        <Link className="underline hover:text-foreground" to="/docs/dev/telemetry-surfaces">
          five developer surfaces
        </Link>{" "}
        (server + hook runtime rows plus the static command/skill/subagent
        footprints), with the columns <C>SURFACE</C> | <C>NAME</C> | <C>IN</C> |{" "}
        <C>OUT</C> | <C>TOTAL</C> | <C>KIND</C>.
      </P>
      <Callout title="Why two non-summed boards" tone="warn">
        Per-MCP server bytes (🔌) measure your server&apos;s own I/O; host/user
        usage (🖥️) measures whole-conversation usage from CLI logs; live
        host-native turns (🛰️) are whole-conversation usage from a real-time hook.
        These are different things — totals are never added across origins. (For
        the per-MCP vs host-scan distinction specifically, see the{" "}
        <Link className="underline hover:text-foreground" to="/docs/user/usage#per-mcp-vs-host">
          canonical explanation
        </Link>
        .)
      </Callout>
    </DocSection>
  );
}

export function Privacy() {
  return (
    <DocSection id="privacy" eyebrow="Telemetry" title="Privacy & opt-out">
      <Lead>
        Both telemetry paths are <strong>local-first</strong> with{" "}
        <strong>zero network egress by default</strong>, and store{" "}
        <strong>aggregate counts only — never your prompts, arguments, or
        results</strong>. Nothing leaves your machine unless you explicitly
        opt in (the calibration sampler is the only off-box path, and it is off
        by default).
      </Lead>

      <H3 id="privacy-usage">The connector-free <C>usage</C> host-scan</H3>
      <P>
        The <Link className="underline hover:text-foreground" to="/docs/user/usage">
          <C>usage</C>
        </Link>{" "}
        command needs no connector and writes nothing. It reads each agent
        CLI&apos;s <strong>own</strong> native session logs / DBs{" "}
        <strong>read-only</strong>, reports{" "}
        <strong>counts only — never your prompts or results</strong>, writes{" "}
        <strong>zero host config</strong> (it never runs <C>install</C>), and is
        local-first: the scan stays entirely on your machine. It is a separate
        read-only subsystem (<C>src/usage/</C>) that never collides with the
        serve-proxy store below.
      </P>

      <H3 id="privacy-serve-proxy">The serve-proxy per-tool numbers</H3>
      <P>
        The per-MCP / per-tool telemetry comes from the{" "}
        <Link className="underline hover:text-foreground" to="/docs/dev/telemetry-overview">
          serve proxy
        </Link>{" "}
        a connector developer&apos;s own wrapped server runs — it tokenizes the
        server&apos;s I/O locally and stores aggregate counts only.
      </P>
      <Callout title="Scope of the &quot;estimate&quot; label" tone="note">
        Reported per-tool numbers are <strong>estimates from the server&apos;s
        own I/O</strong>, not host-billed usage — this caveat applies
        specifically to the serve-proxy per-tool counts (every row carries its{" "}
        <Link
          className="underline hover:text-foreground"
          to="/docs/dev/telemetry-overview#confidence-sources"
        >
          confidence source
        </Link>{" "}
        so an estimate is never read as exact). It is <em>not</em> a statement
        that all telemetry is approximate: the connector-free <C>usage</C> scan
        above reports the host&apos;s own logged counts.
      </Callout>

      <H3 id="privacy-switches">Opt-out switches</H3>
      <DocsTable>
        <thead>
          <tr>
            <Th>Switch</Th>
            <Th>Effect</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>AGENT_CONNECTOR_TELEMETRY=0</Code>
            </Td>
            <Td className="text-muted-foreground">
              Global kill switch (equivalent to{" "}
              <C>telemetry: &#123; enabled: false &#125;</C>).
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>AGENT_CONNECTOR_HOST_NATIVE=1</Code>
            </Td>
            <Td className="text-muted-foreground">
              Forces the opt-in host-native turn capture on at install.
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">
              <Code>calibration.anthropicCountTokens</Code>
            </Td>
            <Td className="text-muted-foreground">
              Opt-in only — the calibration sampler sends content off-box; off by
              default.
            </Td>
          </tr>
        </tbody>
      </DocsTable>
      <List>
        <LI>
          Aggregate counts only — never raw arguments or results are stored.
        </LI>
        <LI>
          Per-layer opt-in for measure / calibrate / host-native; the hot path
          never makes a network call.
        </LI>
        <LI>
          Telemetry is keyed by stable project identity (
          <C>gitRemote || normalizedAbsPath</C>, hashed), stored under the home
          data-root — survives <C>git clean</C>, isn&apos;t committed.
        </LI>
      </List>
    </DocSection>
  );
}

/* ================================================================== */
/* Reference                                                           */
/* ================================================================== */

export function CliSection() {
  return (
    <DocSection id="cli" eyebrow="Reference" title="CLI">
      <Lead>
        <C>agent-connector &lt;command&gt; [flags]</C>. Run{" "}
        <C>agent-connector &lt;command&gt; --help</C> for command-specific flags.{" "}
        <C>--help</C>/<C>-h</C>/<C>help</C> print usage; <C>--version</C>/
        <C>-v</C> prints the program name and version.
      </Lead>

      <H3 id="shared-flags">Shared flags</H3>
      <DocsTable>
        <thead>
          <tr>
            <Th>Flag</Th>
            <Th>Description</Th>
          </tr>
        </thead>
        <tbody>
          {sharedFlags.map((f) => (
            <tr key={f.flag}>
              <Td className="whitespace-nowrap">
                <Code>{f.flag}</Code>
              </Td>
              <Td className="text-muted-foreground">{f.desc}</Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>

      <H3 id="commands">Commands</H3>
      <div className="not-prose mt-4 space-y-6">
        {cliCommands.map((cmd) => (
          <div
            key={cmd.name}
            className="rounded-xl border border-border bg-card/40 p-5 shadow-sm"
          >
            <div className="flex items-center gap-2">
              <code className="font-mono text-sm font-semibold text-foreground">
                {cmd.name}
              </code>
            </div>
            <div className="mt-3 flex items-stretch gap-2">
              <code className="block flex-1 overflow-x-auto rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[0.78rem] text-foreground/90">
                {cmd.signature}
              </code>
              <CopyButton
                value={cmd.signature}
                label={`Copy ${cmd.name} command`}
                className="h-auto self-stretch"
              />
            </div>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {cmd.summary}
            </p>
            {cmd.flags ? (
              <ul className="mt-3 space-y-2 border-t border-border/60 pt-3">
                {cmd.flags.map((f) => (
                  <li key={f.flag} className="text-sm">
                    <code className="font-mono text-[0.75rem] text-foreground">
                      {f.flag}
                    </code>
                    <span className="ml-2 text-muted-foreground">{f.desc}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>

      <H3 id="since-syntax">--since syntax</H3>
      <P>
        Used by telemetry / usage / leaderboard: <C>Ns</C>, <C>Nm</C>, <C>Nh</C>,{" "}
        <C>Nd</C> (seconds / minutes / hours / days), e.g. <C>30s</C>, <C>15m</C>,{" "}
        <C>24h</C>, <C>7d</C>. Empty = no lower bound; malformed = error.
      </P>

      <H3 id="internal-entrypoints">Internal entrypoints</H3>
      <P>
        Hosts point at these; they are omitted / hidden from the top-level help.
      </P>
      <div className="not-prose mt-4 space-y-3">
        {internalEntrypoints.map((e) => (
          <div
            key={e.signature}
            className="rounded-xl border border-border bg-card/40 p-4 shadow-sm"
          >
            <div className="flex items-start gap-2">
              <code className="block min-w-0 flex-1 overflow-x-auto font-mono text-[0.78rem] text-foreground">
                {e.signature}
              </code>
              <CopyButton
                value={e.signature}
                label="Copy entrypoint command"
              />
            </div>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {e.desc}
            </p>
          </div>
        ))}
      </div>
    </DocSection>
  );
}

function PlatformTable({
  title,
  count,
  blurb,
  entries,
}: {
  title: string;
  count: number;
  blurb: string;
  entries: PlatformEntry[];
}) {
  return (
    <>
      <H3 id={`paradigm-${title}`}>
        <span className="font-mono">{title}</span>{" "}
        <Badge variant="muted" className="ml-1 align-middle">
          {count}
        </Badge>
      </H3>
      <P>{blurb}</P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Platform</Th>
            <Th>id</Th>
            <Th>MCP native target</Th>
          </tr>
        </thead>
        <tbody>
          {entries.map((p) => (
            <tr key={p.id}>
              <Td className="whitespace-nowrap font-medium">{p.name}</Td>
              <Td className="whitespace-nowrap">
                <Code>{p.id}</Code>
              </Td>
              <Td className="text-muted-foreground">
                <span className="font-mono text-[0.75rem]">{p.target}</span>
              </Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>
    </>
  );
}

export function PlatformsSection() {
  return (
    <DocSection id="platforms" eyebrow="Reference" title="Platforms">
      <Lead>
        <C>PlatformId</C> is a closed union with one adapter registry entry per
        platform — the internal full registry currently has{" "}
        <strong>{platformCount}</strong> hosts, grouped by hook paradigm (the
        deepest cross-platform divergence). Public coverage pages intentionally
        hide open-source hosts below the star threshold.
      </Lead>
      <P>
        Prefer a visual, filterable view?{" "}
        <Link className="underline hover:text-foreground" to="/coverage">
          See the full interactive coverage matrix on the dedicated coverage page →
        </Link>
      </P>
      <H3 id="generated-capability-snapshot">Generated capability snapshot</H3>
      <P>
        The support counts below are generated from the adapter registry before
        the site builds. They describe what agent-connector wires today; the
        host-native gap/provenance notes stay separate on the coverage matrix.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Surface</Th>
            <Th>Adapters wired</Th>
          </tr>
        </thead>
        <tbody>
          {generatedCapabilitySummaryRows.map((row) => (
            <tr key={row.key}>
              <Td className="whitespace-nowrap font-medium">{row.label}</Td>
              <Td className="text-muted-foreground">
                <Code>{row.count}</Code> / <Code>{adapterCapabilityCount}</Code>
              </Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>
      {/* counts derive from the entry lists (which the drift-guard test pins
          to the adapter registry) so they can never rot independently again. */}
      <PlatformTable
        title="json-stdio"
        count={jsonStdioPlatforms.length}
        blurb="Full hook dispatch. One universal hook entrypoint binary handles all of them."
        entries={jsonStdioPlatforms}
      />
      <PlatformTable
        title="mcp-only"
        count={mcpOnlyPlatforms.length}
        blurb="MCP registration only, no hook layer. Detection surfaces “hooks unavailable here.”"
        entries={mcpOnlyPlatforms}
      />
      <PlatformTable
        title="ts-plugin"
        count={tsPluginPlatforms.length}
        blurb="Framework-generated bridge module exporting lifecycle functions that import your handler."
        entries={tsPluginPlatforms}
      />
      <Callout>
        <C>PlatformId</C> also includes <C>synthetic</C> and <C>unknown</C>{" "}
        sentinels used internally.
      </Callout>
    </DocSection>
  );
}

/* ================================================================== */
/* Guides                                                              */
/* ================================================================== */

export function AddPlatform() {
  return (
    <DocSection id="add-a-platform" eyebrow="Guides" title="Add a platform">
      <Lead>
        Adding a platform is <strong>one registry entry + one adapter</strong> —
        the framework&apos;s core design guarantee.
      </Lead>
      <List>
        <LI>
          <strong>Registry</strong> (<C>src/adapters/registry.ts</C>): one{" "}
          <C>&#123; id, load: () =&gt; import(...) &#125;</C> entry, lazily
          loaded. Order is load-bearing for runtime host detection.
        </LI>
        <LI>
          <strong>Adapter</strong> (<C>src/adapters/&lt;id&gt;/index.ts</C>): a
          class (typically extending <C>BaseAdapter</C>) declaring <C>id</C>,{" "}
          <C>name</C>, <C>readonly paradigm</C>, a <C>capabilities</C> literal,{" "}
          <C>detectInstalled</C>, the MCP <C>installServer</C>/<C>uninstallServer</C>, hook
          install per paradigm (or inherit the <C>mcp-only</C> skip), optional
          content-surface writers, and <C>doctor</C> health checks.
        </LI>
      </List>
      <CodeBlock code={S.addPlatformSnippet} language="ts" filename="adapter" />
      <P>
        The escape hatch keeps the core thin: platform-exclusive MCP-server
        fields go through <C>platforms.&lt;id&gt;.server</C> (shallow-merged into
        the <C>ServerDef</C>), and per-surface verbatim fields go through{" "}
        <C>extra</C> on a <C>CommandDef</C> / <C>SkillDef</C> / <C>SubagentDef</C>{" "}
        (merged into the rendered frontmatter) — a thin universal core with a fat
        per-adapter tail.
      </P>
    </DocSection>
  );
}

export function OperatingModel() {
  return (
    <DocSection id="operating-model" eyebrow="Guides" title="Operating model">
      <Lead>
        Home-dir-centric, single binary, per-project data. The runtime installs
        once under <C>~/.agent-connector</C> (override{" "}
        <C>AGENT_CONNECTOR_DATA_DIR</C>).
      </Lead>
      <CodeBlock
        code={S.operatingModelSnippet}
        language="text"
        filename="~/.agent-connector"
      />
      <List>
        <LI>
          <strong>One home binary.</strong> Every host config we write is a thin
          pointer back to this one stable binary (a hook command is{" "}
          <C>agent-connector hook &lt;platform&gt; &lt;event&gt; --connector &lt;id&gt;</C>;
          a wrapped MCP entry runs{" "}
          <C>agent-connector serve --connector &lt;id&gt; -- &lt;real cmd&gt;</C>
          ). Updating that single binary updates behavior in every host.
        </LI>
        <LI>
          <strong>Native config stays native.</strong>{" "}
          <C>AGENT_CONNECTOR_DATA_DIR</C> relocates only framework-owned state; a
          host&apos;s own settings files are never relocated.
        </LI>
        <LI>
          <strong>Per-project data.</strong> Telemetry/state is keyed by a stable
          project identity (<C>gitRemote || normalizedAbsPath</C>, hashed),
          surviving <C>git clean</C> and shared by every host opening that
          project.
        </LI>
        <LI>
          <strong>Explicit upgrades.</strong> <C>agent-connector upgrade</C>{" "}
          refreshes the one binary pointer — never silent auto-update, so one bad
          release can&apos;t break every project at once.
        </LI>
        <LI>
          <strong>Windows-first.</strong> Resolves home per-OS; no symlinks, no
          POSIX-only assumptions.
        </LI>
      </List>
    </DocSection>
  );
}

export function Troubleshooting() {
  return (
    <DocSection id="troubleshooting" eyebrow="Guides" title="Troubleshooting">
      <Lead>
        How to read <C>doctor</C> output, why some hosts report hooks as
        unavailable, what the &quot;requires sync, skipped&quot; usage rows mean,
        the common <C>ConnectorConfigError</C> messages, and why telemetry can
        show nothing.
      </Lead>

      <H3 id="reading-doctor">Reading doctor output</H3>
      <P>
        <C>agent-connector doctor</C> loads each detected host adapter, runs its
        checks, and prints one status line per check. Any single{" "}
        <C>[FAIL]</C> makes the command exit <C>1</C>; warnings alone never fail
        it.
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Status</Th>
            <Th>Meaning</Th>
          </tr>
        </thead>
        <tbody>
          {doctorStatusRows.map((r) => (
            <tr key={r.status}>
              <Td className="whitespace-nowrap">
                <Code>{r.status}</Code>
              </Td>
              <Td className="text-muted-foreground">{r.meaning}</Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>
      <P>
        A line reads{" "}
        <C>
          &nbsp;&#91;pass&#93; &lt;check&gt; — &lt;message&gt;
        </C>
        ; a failing or warning check adds an indented <C>fix:</C> line with the
        suggested remedy. Run it scoped with{" "}
        <C>doctor --targets &lt;a,b&gt;</C> or against a specific config with{" "}
        <C>--connector &lt;path&gt;</C>; <C>--json</C> emits the per-platform
        results array.
      </P>

      <H3 id="hooks-unavailable">&quot;hooks unavailable here&quot;</H3>
      <P>
        {/* Count + list derive from the drift-guarded mcpOnlyPlatforms export
            (pinned to the registry mcp-only set in
            tests/docs/platform-drift.test.ts) so this prose can't drift —
            Amp is ts-plugin and is correctly absent. */}
        The <strong>{mcpOnlyPlatforms.length} mcp-only hosts</strong> (
        {mcpOnlyPlatforms.map((p) => p.name).join(", ")}) have no hook layer —
        only the MCP server is installed. Detection and <C>doctor</C> surface{" "}
        <strong>&quot;hooks unavailable here&quot;</strong> for them; this is
        expected, not an error. Declared hooks are simply skipped (with a
        warning) on those targets. See{" "}
        <Link className="underline hover:text-foreground" to="/docs/dev/hooks#paradigms">
          the three paradigms
        </Link>
        .
      </P>

      <H3 id="warn-exit-1">The warn action → exit 1</H3>
      <P>
        <C>install</C> and <C>upgrade</C> exit <C>1</C> when any change in the diff
        is a <C>warn</C> (glyph <C>!</C>) — for example a host that can&apos;t
        honor a requested transport (it downgrades-or-skips and reports it) or a
        surface an adapter doesn&apos;t support (it skips + warns). The write
        still succeeds; the non-zero exit is a signal to inspect the warnings,
        not a failure. This is distinct from <C>doctor</C>, where a{" "}
        <C>[warn]</C> does <strong>not</strong> change the exit code (only a{" "}
        <C>[FAIL]</C> does).
      </P>

      <H3 id="requires-sync">&quot;requires sync, skipped&quot; usage rows</H3>
      <P>
        The host-usage layer reads each CLI&apos;s own logs read-only. Some hosts
        keep their usage data behind an external sync agent-connector does not
        perform, so <C>agent-connector usage report</C> prints those platforms as{" "}
        <strong>&quot;requires sync, skipped&quot;</strong> unless a local cache
        already exists:
      </P>
      <List>
        {syncedPlatforms.map((p) => (
          <LI key={p}>
            <Code>{p}</Code>
          </LI>
        ))}
      </List>
      <P>
        This is informational — it only means those rows are absent from the
        host-usage totals, not that anything is broken. Other hosts populate
        immediately.
      </P>

      <H3 id="config-errors">Common ConnectorConfigError messages</H3>
      <P>
        <C>defineConnector</C> validates eagerly and throws{" "}
        <C>ConnectorConfigError</C> on the first violation. The most common ones:
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Message</Th>
            <Th>Cause &amp; fix</Th>
          </tr>
        </thead>
        <tbody>
          {configErrorRows.map((r) => (
            <tr key={r.message}>
              <Td>
                <span className="font-mono text-[0.75rem] text-foreground">
                  {r.message}
                </span>
              </Td>
              <Td className="text-muted-foreground">{r.cause}</Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>

      <H3 id="telemetry-empty">Telemetry shows nothing</H3>
      <P>
        If <C>agent-connector telemetry report</C> is empty, work through these
        in order:
      </P>
      <DocsTable>
        <thead>
          <tr>
            <Th>Reason</Th>
            <Th>Fix</Th>
          </tr>
        </thead>
        <tbody>
          {telemetryEmptyRows.map((r) => (
            <tr key={r.reason}>
              <Td>
                <span className="font-mono text-[0.75rem] text-foreground">
                  {r.reason}
                </span>
              </Td>
              <Td className="text-muted-foreground">{r.fix}</Td>
            </tr>
          ))}
        </tbody>
      </DocsTable>
    </DocSection>
  );
}

/* ================================================================== */
/* Per-section registry                                                 */
/* ================================================================== */

/**
 * Each leaf section id → the component that renders ONLY that section's
 * content. DocsPage looks the active :section param up here and renders the
 * single matching node, so /docs/<track>/:section is its own page (not the
 * whole doc). HooksGuideSection / PackagingGuideSection are already standalone
 * components — registered here by their own section id (hooks-guide /
 * packaging).
 */
export const sectionRegistry: Record<string, () => React.JSX.Element> = {
  "mcp-beginner": McpBeginnerGuide,
  "beginner-demo-lab": BeginnerDemoLabGuide,
  "first-mcp-server": FirstMcpServerGuide,
  "connect-first-host": ConnectFirstHostGuide,
  "first-connector-surfaces": FirstConnectorSurfacesGuide,
  "connector-concepts": ConnectorConceptsGuide,
  "host-hooks": HostHooksGuide,
  "hud-statusline": HudStatuslineGuide,
  "actions-guide": ActionsGuide,
  "special-surfaces": SpecialSurfacesGuide,
  introduction: Introduction,
  installation: Installation,
  sdk: SdkOverview,
  "quick-start": QuickStart,
  "embed-cli": EmbedCli,
  "define-connector": DefineConnector,
  server: ServerSection,
  hooks: HooksSection,
  "hooks-guide": HooksGuideSection,
  surfaces: SurfacesSection,
  packaging: PackagingGuideSection,
  overview: UserOverview,
  usage: Usage,
  "coverage-confidence": CoverageConfidence,
  "telemetry-overview": TelemetryOverview,
  "telemetry-surfaces": TelemetrySurfaces,
  leaderboards: Leaderboards,
  privacy: Privacy,
  cli: CliSection,
  platforms: PlatformsSection,
  "add-a-platform": AddPlatform,
  "operating-model": OperatingModel,
  troubleshooting: Troubleshooting,
};
