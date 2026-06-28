import { ArrowRight, Terminal } from "lucide-react";
import { Link } from "react-router-dom";
import { CopyButton } from "@/components/ui/copy-button";
import { Section, SectionHeading } from "@/components/sections/Section";
import { platformCount } from "@/data";

const USAGE_CMD = "npx @ken-jo/agent-connector usage report";

/**
 * Two-card persona router directly under the hero. Card A routes
 * agent-connector beginners into the root-level guide track; card B routes
 * agent-CLI end users straight to the connector-free `usage` command —
 * whole-conversation totals per CLI/model, never per-tool.
 */
export function Audiences() {
  return (
    <Section id="audiences" className="py-16 sm:py-20">
      <SectionHeading
        eyebrow="Who it's for"
        title={
          <>
            Learn first, <span className="text-gradient">then pick a track</span>
          </>
        }
        description="New to agent-connector starts in Guides: MCP concepts, connector concepts, and what each surface does inside host CLIs."
      />

      <div className="mt-12 grid gap-6 md:grid-cols-2">
        {/* Track A — MCP developer */}
        <div className="flex min-w-0 flex-col rounded-xl border border-border bg-card/40 p-6 shadow-sm">
          <div className="mb-2 flex items-center gap-2">
            <span aria-hidden="true" className="text-lg">
              🔌
            </span>
            <span className="text-base font-semibold text-foreground">
              I build an MCP integration
            </span>
          </div>
          <p className="text-sm leading-relaxed text-foreground/90">
            Start with a neutral MCP server: one read-only tool, one clear
            schema, one host config, and one verified call. After that,
            agent-connector can distribute it across {platformCount} agent
            platforms and report per-tool telemetry for the server it wraps.
          </p>
          <div className="mt-auto pt-5">
            <Link
              to="/docs/guides/mcp-beginner"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline"
            >
              Read the agent-connector beginner guide
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>

        {/* Track B — agent-CLI end user */}
        <div className="flex min-w-0 flex-col rounded-xl border border-border bg-card/40 p-6 shadow-sm">
          <div className="mb-2 flex items-center gap-2">
            <span aria-hidden="true" className="text-lg">
              🖥️
            </span>
            <span className="text-base font-semibold text-foreground">
              I just use agent CLIs
            </span>
          </div>
          <p className="text-sm leading-relaxed text-foreground/90">
            The connector-free <code className="font-mono text-foreground">usage</code>{" "}
            path reports whole-conversation{" "}
            <strong>totals per agent CLI / model / project / session / day</strong>,
            read locally from each CLI&apos;s own session logs. It can&apos;t
            itemize by individual MCP server or tool (agent CLIs don&apos;t log
            per-tool attribution) — <em>see host totals, not per-MCP</em>. No
            connector, no config, nothing installed.
          </p>
          <div className="mt-4 flex h-10 min-w-0 items-center gap-2 rounded-lg border border-border bg-background/60 pl-3 pr-1 font-mono text-xs shadow-sm">
            <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 select-all truncate text-foreground">
              {USAGE_CMD}
            </span>
            <CopyButton
              value={USAGE_CMD}
              label="Copy usage command"
              className="ml-auto size-7"
            />
          </div>
          <div className="mt-auto pt-5">
            <Link
              to="/docs/user"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline"
            >
              See your agent-CLI usage
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </div>
    </Section>
  );
}
