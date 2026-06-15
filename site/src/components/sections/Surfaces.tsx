import { Card } from "@/components/ui/card";
import { Section, SectionHeading } from "@/components/sections/Section";
import { surfaces } from "@/data";

export function Surfaces() {
  return (
    <Section id="surfaces" className="py-16 sm:py-20">
      <SectionHeading
        eyebrow="Six surfaces"
        title="Write once, deploy native"
        description="agent-connector generalizes context-mode's adapter layer across six integration surfaces — each rendered into the host's native shape, degrading gracefully where a host lacks one. Two runtime-dispatched handler surfaces (statusline, actions) ship beyond this per-host content wall."
      />

      <div className="mt-12 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {surfaces.map((surface) => {
          const Icon = surface.icon;
          return (
            <Card
              key={surface.name}
              className="group flex flex-col gap-3 p-5 transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md"
            >
              <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-muted/60 text-foreground transition-colors group-hover:bg-foreground group-hover:text-background">
                <Icon className="size-5" />
              </span>
              <div>
                <p className="text-sm font-semibold">{surface.name}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {surface.description}
                </p>
              </div>
            </Card>
          );
        })}
      </div>
    </Section>
  );
}
