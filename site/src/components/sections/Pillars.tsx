import { Check, Layers, LineChart } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Section, SectionHeading } from "@/components/sections/Section";
import { pillars } from "@/data";

const pillarIcons = [Layers, LineChart];

export function Pillars() {
  return (
    <Section id="pillars">
      <SectionHeading
        eyebrow="Two pillars"
        title="One integration layer. One honest metric."
        description="Every agent host re-invents MCP registration and lifecycle hooks with incompatible dialects. agent-connector unifies the deploy — and finally answers what your tools cost."
      />

      <div className="mt-14 grid gap-6 lg:grid-cols-2">
        {pillars.map((pillar, i) => {
          const Icon = pillarIcons[i] ?? Layers;
          return (
            <Card
              key={pillar.title}
              className="relative overflow-hidden p-8 transition-colors hover:border-foreground/20"
            >
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-24 -top-24 size-56 rounded-full opacity-70 blur-2xl"
                style={{
                  background:
                    "radial-gradient(circle, color-mix(in oklch, var(--brand) 16%, transparent), transparent 70%)",
                }}
              />
              <div className="flex items-center gap-3">
                <span className="flex size-11 items-center justify-center rounded-xl border border-border bg-muted/60">
                  <Icon className="size-5" />
                </span>
                <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  {pillar.eyebrow}
                </span>
              </div>

              <h3 className="mt-5 text-2xl font-bold tracking-tight">
                {pillar.title}
              </h3>
              <p className="mt-3 text-pretty leading-relaxed text-muted-foreground">
                {pillar.summary}
              </p>

              <ul className="mt-7 space-y-4 border-t border-border pt-7">
                {pillar.points.map((point) => (
                  <li key={point.label} className="flex gap-3">
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
                      <Check className="size-3.5" />
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        {point.label}
                      </p>
                      <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                        {point.detail}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>
    </Section>
  );
}
