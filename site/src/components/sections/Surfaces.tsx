import { Card } from "@/components/ui/card";
import { Section, SectionHeading } from "@/components/sections/Section";
import { surfaces } from "@/data";

export function Surfaces() {
  return (
    <Section id="surfaces" className="py-16 sm:py-20">
      <SectionHeading
        eyebrow="Five surfaces"
        title="Write once, deploy native"
        description="agent-connector generalizes context-mode's adapter layer across the five integration surfaces every host exposes — each rendered into its native shape."
      />

      <div className="mt-12 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
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
