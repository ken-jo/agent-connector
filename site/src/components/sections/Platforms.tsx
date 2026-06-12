import { Section, SectionHeading } from "@/components/sections/Section";
import { cn } from "@/lib/utils";
import {
  paradigms,
  platformCount,
  platforms,
  surfaceChips,
  surfaceState,
  type Platform,
  type SurfaceState,
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

/**
 * Per-chip styling and copy for the three fact-based states:
 *   supported — agent-connector installs it (lit);
 *   host-gap  — the host natively offers it, our adapter hasn't wired it yet
 *               (hollow/dotted: our honest gap, visible by design);
 *   host-na   — the platform itself does not offer the surface (struck/faded).
 */
const chipStates: Record<SurfaceState, { className: string; label: string }> = {
  supported: {
    className: "text-foreground",
    label: "supported",
  },
  "host-gap": {
    className:
      "text-muted-foreground underline decoration-dotted decoration-muted-foreground/70 underline-offset-2",
    label: "host supports — agent-connector support coming",
  },
  "host-na": {
    className: "text-muted-foreground/30 line-through decoration-muted-foreground/30",
    label: "not offered by this agent",
  },
};

function SurfaceLegend() {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <p className="text-center font-mono text-xs text-muted-foreground">
        {surfaceChips.map((chip, i) => (
          <span key={chip.key}>
            {i > 0 ? <span className="mx-1.5 opacity-50">·</span> : null}
            <span className="text-foreground">{chip.abbr}</span>
            {chip.abbr !== chip.full ? <span> {chip.full}</span> : null}
          </span>
        ))}
      </p>
      <p className="text-center font-mono text-[11px] leading-relaxed text-muted-foreground">
        <span className={chipStates.supported.className}>Abc</span>
        <span className="ml-1.5 font-sans">supported</span>
        <span className="mx-2.5 opacity-50">·</span>
        <span className={chipStates["host-gap"].className}>Abc</span>
        <span className="ml-1.5 font-sans">host supports — support coming</span>
        <span className="mx-2.5 opacity-50">·</span>
        <span className={chipStates["host-na"].className}>Abc</span>
        <span className="ml-1.5 font-sans">not offered by this agent</span>
      </p>
    </div>
  );
}

/** One agent on the wall: name + its exact surface profile as 3-state chips. */
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
          const state = surfaceState(platform, chip.key);
          const { className, label } = chipStates[state];
          return (
            <span key={chip.key} className="flex items-center">
              {i > 0 ? (
                <span aria-hidden="true" className="mx-1 text-muted-foreground/40">
                  ·
                </span>
              ) : null}
              <span title={`${chip.full}: ${label}`} className={className}>
                {chip.abbr}
                <span className="sr-only">
                  {" "}
                  {chip.full} {label}
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
      <SectionHeading
        eyebrow="Coverage"
        title={
          <>
            Works with{" "}
            <span className="text-gradient">{platformCount} agents</span>
          </>
        }
        description="No vague compatibility wall: every agent below shows exactly which surfaces agent-connector installs on it, straight from its adapter — and, just as honestly, which surfaces the host offers that we haven't wired yet."
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
        wall can't claim what an adapter doesn't ship, and a lit chip always
        implies the host natively offers that surface.
      </p>
    </Section>
  );
}
