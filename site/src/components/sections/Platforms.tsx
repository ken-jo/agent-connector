import { Section, SectionHeading } from "@/components/sections/Section";
import { cn } from "@/lib/utils";
import {
  paradigms,
  platformCount,
  platforms,
  surfaceChips,
  type Platform,
} from "@/data";

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

function SurfaceLegend() {
  return (
    <p className="text-center font-mono text-xs text-muted-foreground">
      {surfaceChips.map((chip, i) => (
        <span key={chip.key}>
          {i > 0 ? <span className="mx-1.5 opacity-50">·</span> : null}
          <span className="text-foreground">{chip.abbr}</span>
          {chip.abbr !== chip.full ? <span> {chip.full}</span> : null}
        </span>
      ))}
      <span className="ml-2 font-sans">— lit when the host supports it.</span>
    </p>
  );
}

/** One agent on the wall: name + its exact surface profile as compact chips. */
function AgentEntry({ platform }: { platform: Platform }) {
  const paradigm = paradigms.find((p) => p.id === platform.paradigm)!;
  const supported = surfaceChips
    .filter((c) => platform.surfaces[c.key])
    .map((c) => c.full)
    .join(", ");

  return (
    <div
      className="group rounded-lg border border-border bg-background/60 px-3.5 py-2.5 transition-colors hover:border-foreground/30 hover:bg-accent"
      title={`${platform.name} (${paradigm.label}) — supports: ${supported}`}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn("size-2 shrink-0 rounded-full", paradigm.dot)}
          aria-hidden="true"
        />
        <span className="text-sm font-medium text-muted-foreground transition-colors group-hover:text-foreground">
          {platform.name}
        </span>
      </div>
      <div className="mt-2 flex items-center font-mono text-[10px] leading-none tracking-tight">
        {surfaceChips.map((chip, i) => {
          const on = platform.surfaces[chip.key];
          return (
            <span key={chip.key} className="flex items-center">
              {i > 0 ? (
                <span aria-hidden="true" className="mx-1 text-muted-foreground/40">
                  ·
                </span>
              ) : null}
              <span
                title={`${chip.full}: ${on ? "supported" : "not supported"}`}
                className={
                  on
                    ? "text-foreground"
                    : "text-muted-foreground/30 line-through decoration-muted-foreground/30"
                }
              >
                {chip.abbr}
                <span className="sr-only">
                  {" "}
                  {chip.full} {on ? "supported" : "not supported"}
                </span>
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function Platforms() {
  return (
    <Section id="platforms">
      {/* TODO(owner): mascot slot — drop the character image at site/public/mascot.png
          and uncomment. Sits above the section heading, centered.
      <img
        src="/mascot.png"
        alt=""
        aria-hidden="true"
        className="mx-auto mb-6 h-24 w-auto"
      />
      */}
      <SectionHeading
        eyebrow="Coverage"
        title={
          <>
            Works with{" "}
            <span className="text-gradient">{platformCount} agents</span>
          </>
        }
        description="No vague compatibility wall: every agent below shows exactly which surfaces agent-connector installs on it, straight from its adapter. Adding a platform = one registry entry + one adapter."
      />

      <div className="mt-10 flex flex-col items-center gap-3">
        <ParadigmLegend />
        <SurfaceLegend />
      </div>

      <div className="mt-10 flex flex-wrap justify-center gap-2.5">
        {platforms.map((pl) => (
          <AgentEntry key={pl.id} platform={pl} />
        ))}
      </div>

      <p className="mt-8 text-center text-xs text-muted-foreground">
        Surface profiles are drift-tested against the adapter registry — the
        wall can't claim what an adapter doesn't ship.
      </p>
    </Section>
  );
}
