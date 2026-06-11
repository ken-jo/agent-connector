import { Card } from "@/components/ui/card";
import { Section, SectionHeading } from "@/components/sections/Section";
import { cn } from "@/lib/utils";
import { paradigms, platforms, type ParadigmId } from "@/data";

function ParadigmLegend() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
      {paradigms.map((p) => (
        <div key={p.id} className="flex items-center gap-2">
          <span className={cn("size-2.5 rounded-full", p.dot)} />
          <span className="font-mono text-xs text-foreground">{p.label}</span>
          <span className="text-xs text-muted-foreground">— {p.short}</span>
        </div>
      ))}
    </div>
  );
}

function PlatformGroup({ paradigmId }: { paradigmId: ParadigmId }) {
  const paradigm = paradigms.find((p) => p.id === paradigmId)!;
  const items = platforms.filter((pl) => pl.paradigm === paradigmId);

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className={cn("size-2.5 rounded-full", paradigm.dot)} />
          <h3 className="font-mono text-sm font-semibold">{paradigm.label}</h3>
        </div>
        <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">
          {items.length}
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {paradigm.description}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {items.map((pl) => (
          <span
            key={pl.name}
            className="inline-flex items-center rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-foreground/30 hover:bg-accent"
          >
            {pl.name}
          </span>
        ))}
      </div>
    </Card>
  );
}

export function Platforms() {
  return (
    <Section id="platforms">
      <SectionHeading
        eyebrow="Coverage"
        title={
          <>
            29 platforms, grouped by{" "}
            <span className="text-gradient">hook paradigm</span>
          </>
        }
        description="Adding a platform = one registry entry + one adapter. Detection surfaces each host's scope, capabilities and paradigm at install time."
      />

      <div className="mt-10 flex justify-center">
        <ParadigmLegend />
      </div>

      <div className="mt-10 grid gap-5 lg:grid-cols-2">
        <div className="grid gap-5">
          <PlatformGroup paradigmId="json-stdio" />
        </div>
        <div className="grid gap-5">
          <PlatformGroup paradigmId="mcp-only" />
          <PlatformGroup paradigmId="ts-plugin" />
        </div>
      </div>
    </Section>
  );
}
