import { Package, Boxes } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CodeBlock } from "@/components/ui/code-block";
import { DocSection, H3, Lead, P, C, List, LI, Callout } from "./prose";
import { packageFormatRows, type PackageFormatRow } from "./docs-data";
import * as S from "./snippets";

/* ------------------------------------------------------------------ */
/* The "two ways to ship" cards                                         */
/* ------------------------------------------------------------------ */

function TwoWaysToShip() {
  return (
    <div className="not-prose my-6 grid gap-4 md:grid-cols-2">
      <div className="rounded-xl border border-border bg-card/40 p-5 shadow-sm">
        <div className="mb-2 flex items-center gap-2">
          <Boxes className="size-4 text-emerald-600 dark:text-emerald-400" />
          <span className="text-base font-semibold text-foreground">
            Direct install
          </span>
          <Badge variant="muted">agent-connector install</Badge>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The CLI detects every installed host and writes each one&apos;s native
          MCP registration, hook config, and content files in place. The
          connector lives where you ran it — ideal for your own machine / CI.
        </p>
      </div>
      <div className="rounded-xl border border-border bg-card/40 p-5 shadow-sm">
        <div className="mb-2 flex items-center gap-2">
          <Package className="size-4 text-violet-600 dark:text-violet-400" />
          <span className="text-base font-semibold text-foreground">
            Packaged bundle
          </span>
          <Badge variant="muted">agent-connector package</Badge>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Emit a self-contained marketplace / extension bundle others install
          through their host&apos;s plugin flow. The bundle re-renders the SAME
          content + hooks + serve-wrapped MCP entry, so a marketplace-installed
          connector behaves exactly like a direct install — telemetry included.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The 9-format table                                                  */
/* ------------------------------------------------------------------ */

function FormatRow({ r, index }: { r: PackageFormatRow; index: number }) {
  return (
    <tr>
      <td className="border-b border-border/60 px-3 py-3 align-top">
        <code className="whitespace-nowrap font-mono text-[0.78rem] font-semibold text-foreground">
          {r.format}
        </code>
        {r.format === "claude-plugin" ? (
          <span className="mt-1 block">
            <Badge variant="muted" className="px-1.5 py-0 text-[0.6rem]">
              default
            </Badge>
          </span>
        ) : null}
        <span className="mt-1 block font-mono text-[0.6rem] text-muted-foreground/70">
          #{index + 1}
        </span>
      </td>
      <td className="border-b border-border/60 px-3 py-3 align-top text-sm text-foreground/90">
        {r.targets}
      </td>
      <td className="border-b border-border/60 px-3 py-3 align-top">
        <span className="font-mono text-[0.72rem] leading-relaxed text-muted-foreground">
          {r.manifest}
        </span>
      </td>
      <td className="border-b border-border/60 px-3 py-3 align-top">
        <code className="block whitespace-pre-wrap font-mono text-[0.72rem] leading-relaxed text-foreground/90">
          {r.install}
        </code>
        {r.note ? (
          <span className="mt-1.5 block text-[0.72rem] leading-relaxed text-muted-foreground">
            {r.note}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

function FormatsTable() {
  return (
    <div className="not-prose my-6 overflow-x-auto rounded-xl border border-border bg-card/40 shadow-sm">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr>
            <th className="border-b border-r border-border bg-muted/50 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              --format
            </th>
            <th className="border-b border-border bg-muted/50 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Target platform(s)
            </th>
            <th className="border-b border-border bg-muted/50 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Manifest emitted
            </th>
            <th className="border-b border-border bg-muted/50 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Install command
            </th>
          </tr>
        </thead>
        <tbody>
          {packageFormatRows.map((r, i) => (
            <FormatRow key={r.format} r={r} index={i} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The composed Packaging section                                      */
/* ------------------------------------------------------------------ */

export function PackagingGuideSection() {
  return (
    <DocSection
      id="packaging"
      eyebrow="Packaging"
      title="Packaging & marketplaces"
    >
      <Lead>
        There are <strong>two ways to ship</strong> a connector: install it
        directly with the CLI, or emit a marketplace / extension{" "}
        <strong>bundle</strong> others install through their host&apos;s own
        plugin flow. The <C>agent-connector package</C> command renders the
        bundle for any of <strong>nine</strong> host ecosystem formats — plus two
        official <strong>MCP standard artifacts</strong> (a registry{" "}
        <C>server.json</C> and an <C>mcpb</C> bundle) that plug your real upstream
        server into the cross-vendor distribution graph.
      </Lead>

      <TwoWaysToShip />

      <H3 id="package-command">The package command</H3>
      <P>
        <C>
          agent-connector package [--connector &lt;path&gt;] [--format &lt;fmt&gt;]
          [--out &lt;dir&gt;] [--dry-run]
        </C>
        . The connector is resolved from <C>--connector</C>, else auto-discovered
        by walking up from the project dir (exactly like <C>install</C>). The
        bundle is written under <C>--out</C> (default <C>&lt;cwd&gt;/dist-plugin</C>
        ); <C>--dry-run</C> computes the file tree without writing.
      </P>
      <List>
        <LI>
          <strong>Default <C>--format claude-plugin</C>.</strong> Omitting{" "}
          <C>--format</C> emits a Claude-family plugin bundle.
        </LI>
        <LI>
          <strong><C>--format all</C></strong> emits EVERY feasible format, each
          into its own <C>&lt;out&gt;/&lt;format&gt;/</C> subdir (no collisions),
          printing per-format install instructions.
        </LI>
        <LI>
          <strong>An invalid <C>--format</C> exits <C>2</C></strong> with{" "}
          <C>
            invalid --format &quot;…&quot; (expected one of: …, or
            &quot;all&quot;)
          </C>
          .
        </LI>
      </List>
      <CodeBlock code={S.packageSnippet} language="bash" filename="terminal" />

      <H3 id="package-formats">Host formats + standard artifacts</H3>
      <P>
        For each format: the <C>--format</C> value, the target platform(s) it
        serves, the manifest file(s) it emits, and the user install command. The
        command / skill / subagent markdown is rendered through the{" "}
        <strong>same shared claude-code renderers the live adapters write with</strong>
        , so an installed plugin and an <C>agent-connector install</C> produce
        byte-identical content files.
      </P>
      <FormatsTable />

      <H3 id="package-telemetry">Telemetry carries through every bundle</H3>
      <P>
        Hooks use the universal home-bin <C>hook</C> command and the MCP entry is{" "}
        <strong>serve-wrapped with <C>--host &lt;platform&gt;</C></strong> in
        every bundle — exactly as an <C>agent-connector install</C> would. So a{" "}
        <strong>marketplace-installed connector still reports per-tool tokens</strong>
        : the wrapped MCP entry routes through the one stable home binary, and the
        hooks shell back to the same entrypoint, keeping the telemetry
        serve-wrapper intact end to end.
      </P>
      <CodeBlock
        code={S.packageInstallSnippet}
        language="bash"
        filename="host plugin flow"
      />
      <Callout title="Lossy formats are never silent" tone="warn">
        Some hosts can&apos;t carry every surface. <C>kimi-plugin</C> keeps{" "}
        <strong>skills + MCP only</strong> — commands, subagents, and hooks are
        dropped. <C>npm-plugin</C> bundles only the hook bridge (+ skills for Pi);
        commands/subagents are native host dirs and MCP is a config key, so they
        aren&apos;t bundled. In both cases the emitter returns explicit{" "}
        <strong>drop notes</strong> the CLI prints, so a lossy bundle is never
        silent.
      </Callout>
    </DocSection>
  );
}
