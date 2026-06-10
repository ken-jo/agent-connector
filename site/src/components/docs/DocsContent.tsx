import * as React from "react";
import { Link } from "react-router-dom";
import { CodeBlock } from "@/components/ui/code-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyButton } from "@/components/ui/copy-button";
import { Badge } from "@/components/ui/badge";
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
  surfaceSupportRows,
  telemetryConfigFields,
  confidenceSources,
  platformOverrideFields,
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
  eventScopeRows,
  surfaceKindRows,
  surfaceLeaderboardColumns,
  type PlatformEntry,
} from "./docs-data";
import { HooksGuideSection } from "./HooksGuide";
import { PackagingGuideSection } from "./PackagingGuide";

/* ================================================================== */
/* Getting Started                                                     */
/* ================================================================== */

export function Introduction() {
  return (
    <DocSection id="introduction" eyebrow="Getting Started" title="Introduction">
      <Lead>
        agent-connector lets you write your MCP server + hooks (and slash
        commands, Agent Skills, and subagents) <strong>once</strong> with{" "}
        <C>defineConnector(&#123;...&#125;)</C>. The CLI detects every installed
        AI-agent host, renders the right config in each one&apos;s native
        dialect, installs / syncs / uninstalls them, and gives you default,
        platform-independent, local-first per-tool token telemetry.
      </Lead>

      <H3 id="two-pillars">Two pillars</H3>
      <List>
        <LI>
          <strong>Single-API multi-platform deployment.</strong> One declarative
          + programmatic <C>defineConnector(&#123;...&#125;)</C> → per-platform
          adapters render it into each host&apos;s native MCP registration, hook
          config, and content files; one CLI installs/syncs/uninstalls
          everywhere.
        </LI>
        <LI>
          <strong>Default per-MCP token telemetry.</strong>{" "}
          Platform-independent, local-first, privacy-preserving (aggregate
          counts, never content). On by default.
        </LI>
      </List>

      <P>
        It generalizes context-mode&apos;s proven adapter layer into a reusable
        framework: where context-mode hardcoded the served identity, here the
        identity is a parameter you supply via <C>defineConnector</C>. It targets{" "}
        <strong>29 platforms</strong> grouped into three hook paradigms, and is
        Windows-first (no symlinks, no POSIX-only assumptions).
      </P>
    </DocSection>
  );
}

export function Installation() {
  return (
    <DocSection id="installation" eyebrow="Getting Started" title="Installation">
      <Lead>
        agent-connector is an <strong>SDK you depend on</strong>, not a global
        tool. Add it to your connector package, then either ship a{" "}
        <strong>branded CLI</strong> your users drive directly, or run it with{" "}
        <C>npx</C> from the project. Your consumers never need a separate global
        install.
      </Lead>
      <P>
        Add agent-connector as a dependency of the package that holds your{" "}
        <C>agent-connector.config</C>:
      </P>
      <CodeBlock code={S.installSnippet} language="bash" filename="terminal" />
      <P>
        Then expose every subcommand under your own brand with{" "}
        <C>createConnectorCli</C> from the <C>agent-connector/cli</C> export — the{" "}
        <Link className="underline hover:text-foreground" to="/docs/embed-cli">
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

      <H3 id="optional-global">Optional: use the CLI directly</H3>
      <P>
        You do <strong>not</strong> need a global install for the SDK flow above
        — <C>npx agent-connector …</C> runs it straight from your project. A
        global install is a convenience only, for trying the CLI by hand outside
        any connector package:
      </P>
      <CodeBlock code={S.globalInstallSnippet} language="bash" filename="terminal" />

      <H3 id="from-source">From source</H3>
      <CodeBlock code={S.fromSourceSnippet} language="bash" filename="terminal" />
    </DocSection>
  );
}

export function QuickStart() {
  return (
    <DocSection id="quick-start" eyebrow="Getting Started" title="Quick start">
      <Lead>
        Three steps: depend on agent-connector, declare your connector with{" "}
        <C>defineConnector</C>, then <strong>either</strong> ship a branded CLI{" "}
        <strong>or</strong> run <C>npx agent-connector</C> from the project.
      </Lead>
      <P>
        Add the dependency and create an{" "}
        <C>agent-connector.config.&#123;mjs,js,json&#125;</C> at your project root
        (found by walking up from the project dir, or pass{" "}
        <C>--connector &lt;path&gt;</C>):
      </P>
      <CodeBlock code={S.quickStartSnippet} language="bash" filename="terminal" />
      <P>
        The config below is the canonical example — see{" "}
        <Link className="underline hover:text-foreground" to="/docs/define-connector">
          defineConnector
        </Link>{" "}
        for the full field reference. Every command is idempotent, reversible,
        and <C>--dry-run</C>-able.
      </P>
      <CodeBlock
        code={S.defineConnectorSnippet}
        language="ts"
        filename="agent-connector.config.mjs"
      />
      <Callout title="Two ways to drive it">
        Ship a <strong>branded CLI</strong> so your users run{" "}
        <C>&lt;your-tool&gt; install</C> / <C>&lt;your-tool&gt; leaderboard</C>{" "}
        (auto-scoped to your connector — see{" "}
        <Link className="underline hover:text-foreground" to="/docs/embed-cli">
          Embed it / branded CLI
        </Link>
        ), or just run <C>npx agent-connector …</C> from the project. Either way,
        no separate global install is required.
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
        . With <C>createConnectorCli(&#123; name, connector &#125;)</C> you expose{" "}
        <strong>every</strong> agent-connector subcommand under your own brand —
        fully delegated and <strong>auto-scoped</strong> to the connector your
        package ships. Your users run <C>&lt;your-tool&gt; install</C> /{" "}
        <C>&lt;your-tool&gt; leaderboard</C> / <C>&lt;your-tool&gt; telemetry</C>{" "}
        and never install agent-connector globally or type <C>--connector</C>.
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
        Import <C>createConnectorCli</C> from the <C>agent-connector/cli</C>{" "}
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
        <Link className="underline hover:text-foreground" to="/docs/operating-model">
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

      <H3 id="connector-config">ConnectorConfig</H3>
      <FieldTable rows={connectorConfigFields} />

      <H3 id="validation-rules">Top-level validation rules</H3>
      <List>
        <LI>
          <C>config</C> must be an object; <C>id</C> must match the kebab-case
          regex <C>^[a-z0-9][a-z0-9-]*$</C>.
        </LI>
        <LI>
          A connector must declare <strong>at least one</strong> of <C>server</C>
          , <C>hooks</C>, <C>commands</C>, <C>skills</C>, <C>subagents</C> — else
          it throws.
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
        is fully defaulted. <C>commands</C> / <C>skills</C> / <C>subagents</C> are
        normalized to <C>[]</C> when none.
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
        For the example server, <C>agent-connector install</C> writes each host&apos;s
        native shape (hooks land in a sibling settings file, all pointing back to
        the one stable home binary):
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
        <Link className="underline hover:text-foreground" to="/docs/hooks-guide">
          Hooks: cross-platform guide
        </Link>
        .
      </Callout>

      <CodeBlock code={S.hooksConfigSnippet} language="ts" filename="HooksConfig" />
      <P>
        <C>matcher</C> is a regex matched against the tool name (tool events
        only); empty or omitted matches all. It is rendered into each host&apos;s
        native matcher syntax where supported, else evaluated by the universal
        entrypoint at runtime.
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
                <Badge variant="muted">{r.count}</Badge>
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
    </DocSection>
  );
}

export function SurfacesSection() {
  return (
    <DocSection
      id="surfaces"
      eyebrow="Core API"
      title="Commands, Skills & Subagents"
    >
      <Lead>
        Content surfaces are <strong>content-only</strong> (markdown / TOML
        files): no runtime dispatch, no telemetry wrapping, no home-bin pointer —
        pure file writers. Each supporting adapter writes the native file(s);
        unsupporting adapters skip + warn.
      </Lead>
      <P>
        <C>SurfaceToolPolicy</C> is shared:{" "}
        <C>&#123; allow?: string[]; deny?: string[] &#125;</C> — rendered to each
        host&apos;s allowed-tools / tools[] / readonly.
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
      </List>

      <H3 id="surface-support">Per-platform surface support</H3>
      <P>
        Adapters that don&apos;t support a surface skip with a warning.{" "}
        <C>&lt;n&gt;</C> is the surface name; skills are uniformly
        folder-per-skill <C>SKILL.md</C> (only the parent dir differs per
        platform).
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
/* Telemetry                                                           */
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
        &quot;cost of merely defining my tools&quot; per-turn overhead.
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
        Windows/single-binary safe): <C>o200k_base</C> for OpenAI/Codex-family,{" "}
        <C>cl100k_base</C> for older, and <C>o200k_base</C> as a documented
        approximation for Anthropic-family (no offline Claude tokenizer ships).
        Family is auto-selected from <C>initialize.clientInfo</C> or{" "}
        <C>modelFamilyHint</C>. Fallback is a <C>chars/4</C> heuristic (with
        content-type multipliers; never tokenizing base64) — explicitly labeled
        so it&apos;s never mistaken for exact.
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
          <strong>Opt-out.</strong> <C>AGENT_CONNECTOR_TELEMETRY=0</C> (or{" "}
          <C>telemetry: &#123; enabled: false &#125;</C>) is a global kill switch
          honored by both the serve-proxy and the hook runtime.
        </LI>
      </List>

      <H3 id="confidence">Confidence sources</H3>
      <P>
        Every row (and every static footprint) carries one confidence source so
        an estimate is never read as exact — see{" "}
        <Link
          className="underline hover:text-foreground"
          to="/docs/telemetry-overview#confidence-sources"
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
        agent-connector prints <strong>three origin-labeled leaderboards that
        measure different things and are NEVER summed.</strong>
      </Lead>
      <DocsTable>
        <thead>
          <tr>
            <Th>Board</Th>
            <Th>Origin</Th>
            <Th>Measures</Th>
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
              costs the most tokens.&quot;
            </Td>
          </tr>
          <tr>
            <Td className="whitespace-nowrap">🖥️ Host / User</Td>
            <Td>
              <Code>host-scan-logs</Code>
            </Td>
            <Td className="text-muted-foreground">
              Host usage from scanning CLI logs. &quot;Which CLI/host spent the
              most.&quot;
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
        <Link className="underline hover:text-foreground" to="/docs/embed-cli">
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
        <Link className="underline hover:text-foreground" to="/docs/telemetry-surfaces">
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
        These are different things — totals are never added across origins.
      </Callout>
    </DocSection>
  );
}

export function Privacy() {
  return (
    <DocSection id="privacy" eyebrow="Telemetry" title="Privacy & opt-out">
      <Lead>
        Local-first, <strong>zero network egress by default</strong>. Reported
        numbers are estimates from the server&apos;s own I/O, not host-billed
        usage.
      </Lead>
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
        platform — <strong>29</strong> hosts, grouped by hook paradigm (the
        deepest cross-platform divergence).
      </Lead>
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
          <C>detect</C>, the MCP <C>installServer</C>/<C>uninstallServer</C>, hook
          install per paradigm (or inherit the <C>mcp-only</C> skip), optional
          content-surface writers, and <C>doctor</C> health checks.
        </LI>
      </List>
      <CodeBlock code={S.addPlatformSnippet} language="ts" filename="adapter" />
      <P>
        The escape hatch keeps the core thin: every adapter accepts{" "}
        <C>platforms.&lt;id&gt;.extra</C> passthrough for platform-exclusive
        features the core doesn&apos;t model — a thin universal core with a fat
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
        The <strong>9 mcp-only hosts</strong> (Warp, Kilo, Roo Code, Trae,
        Zed, Amp, Codebuff, Mux, Pi) have no hook layer — only the MCP
        server is installed. Detection and <C>doctor</C> surface{" "}
        <strong>&quot;hooks unavailable here&quot;</strong> for them; this is
        expected, not an error. Declared hooks are simply skipped (with a
        warning) on those targets. See{" "}
        <Link className="underline hover:text-foreground" to="/docs/hooks#paradigms">
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
 * single matching node, so /docs/:section is its own page (not the whole doc).
 * HooksGuideSection / PackagingGuideSection are already standalone components —
 * registered here by their own section id (hooks-guide / packaging).
 */
export const sectionRegistry: Record<string, () => React.JSX.Element> = {
  introduction: Introduction,
  installation: Installation,
  "quick-start": QuickStart,
  "embed-cli": EmbedCli,
  "define-connector": DefineConnector,
  server: ServerSection,
  hooks: HooksSection,
  "hooks-guide": HooksGuideSection,
  surfaces: SurfacesSection,
  packaging: PackagingGuideSection,
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
