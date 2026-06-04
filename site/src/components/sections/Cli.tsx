import { ChevronRight } from "lucide-react";
import { Section, SectionHeading } from "@/components/sections/Section";
import { cliCommands } from "@/data";

export function Cli() {
  return (
    <Section id="cli" className="py-16 sm:py-20">
      <SectionHeading
        eyebrow="One CLI"
        title="Detect, deploy, measure"
        description="Everything idempotent, reversible, and --dry-run-able. One binary drives every host."
      />

      <div className="mt-10 flex flex-wrap justify-center gap-2.5">
        {cliCommands.map((c) => (
          <div
            key={c.cmd}
            title={c.purpose}
            className="group inline-flex items-center gap-1.5 rounded-lg border border-border bg-card/60 px-3 py-2 font-mono text-sm shadow-sm backdrop-blur transition-colors hover:border-foreground/30 hover:bg-accent"
          >
            <ChevronRight className="size-3.5 text-muted-foreground transition-colors group-hover:text-foreground" />
            <span className="text-foreground">{c.cmd}</span>
          </div>
        ))}
      </div>

      <p className="mx-auto mt-8 max-w-md text-center text-xs text-muted-foreground">
        Hover any command for what it does. Internal entrypoints{" "}
        <code className="font-mono text-foreground">hook</code> and{" "}
        <code className="font-mono text-foreground">serve</code> wire the
        universal dispatch &amp; telemetry proxy.
      </p>
    </Section>
  );
}
