import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Section, SectionHeading } from "@/components/sections/Section";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { howItWorks } from "@/data";

export function HowItWorks() {
  return (
    <Section id="how-it-works">
      <SectionHeading
        eyebrow="How it works"
        title="Home-dir-centric, single binary"
        description="One runtime under ~/.agent-connector. Thin native pointers everywhere. Per-project data that survives git clean. Managed updates, Windows-safe."
      />

      <div className="relative mt-14">
        {/* connecting line on large screens, aligned to the step badge centers */}
        <div
          aria-hidden="true"
          className="absolute left-[10%] right-[10%] top-[2.375rem] hidden h-px bg-gradient-to-r from-transparent via-border to-transparent lg:block"
        />
        <ol className="grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
          {howItWorks.map((step, i) => (
            <li key={step.title} className="relative">
              <Card className="h-full p-5">
                <span className="flex size-9 items-center justify-center rounded-full border border-border bg-background font-mono text-sm font-semibold text-foreground">
                  {i + 1}
                </span>
                <h3 className="mt-4 text-sm font-semibold">{step.title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {step.detail}
                </p>
              </Card>
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-12 flex flex-col items-center gap-3">
        <p className="text-sm text-muted-foreground">
          Ready for the full API reference?
        </p>
        <Button asChild size="lg" className="gap-2">
          <Link to="/docs">
            Read the docs
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    </Section>
  );
}
