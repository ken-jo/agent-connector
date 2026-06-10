import { ArrowRight, Terminal } from "lucide-react";
import { Link } from "react-router-dom";
import { CopyButton } from "@/components/ui/copy-button";
import { Section, SectionHeading } from "@/components/sections/Section";
import { platformCount } from "@/data";

const USAGE_CMD = "npx @ken-jo/agent-connector usage report";

/**
 * Two-card persona router directly under the hero. Card A routes MCP
 * developers into the quick start; card B routes agent-CLI end users straight
 * to the connector-free `usage` command — whole-conversation totals per
 * CLI/model, never per-tool (the accuracy boundary the docs repeat).
 */
export function Audiences() {
  return (
    <Section id="audiences" className="py-16 sm:py-20">
      <SectionHeading
        eyebrow="Who it's for"
        title={
          <>
            Two audiences, <span className="text-gradient">two tracks</span>
          </>
        }
        description="Pick yours — they don't overlap. Building an MCP integration is one track; just watching what your agent CLIs burn is the other."
      />

      <div className="mt-12 grid gap-6 md:grid-cols-2">
        {/* Track A — MCP developer */}
        <div className="flex flex-col rounded-xl border border-border bg-card/40 p-6 shadow-sm">
          <div className="mb-2 flex items-center gap-2">
            <span aria-hidden="true" className="text-lg">
              🔌
            </span>
            <span className="text-base font-semibold text-foreground">
              I build an MCP integration
            </span>
          </div>
          <p className="text-sm leading-relaxed text-foreground/90">
            Write your MCP server + hooks <strong>once</strong> with{" "}
            <code className="font-mono text-foreground">defineConnector</code>,
            deploy across {platformCount} agent platforms, and get per-tool
            token telemetry for <strong>your own wrapped server</strong>.
          </p>
          <div className="mt-auto pt-5">
            <Link
              to="/docs/quick-start"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline"
            >
              Start the developer track
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>

        {/* Track B — agent-CLI end user */}
        <div className="flex flex-col rounded-xl border border-border bg-card/40 p-6 shadow-sm">
          <div className="mb-2 flex items-center gap-2">
            <span aria-hidden="true" className="text-lg">
              🖥️
            </span>
            <span className="text-base font-semibold text-foreground">
              I just use agent CLIs
            </span>
          </div>
          <p className="text-sm leading-relaxed text-foreground/90">
            See whole-conversation token{" "}
            <strong>totals per agent CLI / model / project / session</strong> —
            not per-tool — read locally from each CLI&apos;s own session logs.
            No connector, no config, nothing installed.
          </p>
          <div className="mt-4 flex h-10 items-center gap-2 rounded-lg border border-border bg-background/60 pl-3 pr-1 font-mono text-xs shadow-sm">
            <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="select-all truncate text-foreground">
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
              to="/docs/usage"
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
