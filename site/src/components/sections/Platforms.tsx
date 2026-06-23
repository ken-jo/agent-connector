import { useState } from "react";
import { Link } from "react-router-dom";

import { Section, SectionHeading } from "@/components/sections/Section";
import { cn } from "@/lib/utils";
import {
  byParadigmFamilyName,
  formFactorShort,
  frontierIds,
  handlerChips,
  installMethods,
  isFrontier,
  paradigms,
  platformCount,
  platforms,
  surfaceChips,
  surfaceState,
  type Platform,
  type SurfaceState,
} from "@/data";

/** Where a card's surface/handler links land in the dev docs. */
const PLATFORMS_DOC = "/docs/dev/platforms";
const HANDLER_DOC: Record<"statusline" | "actions", string> = {
  statusline: "/docs/dev/surfaces#statusline",
  actions: "/docs/dev/surfaces#actions",
};

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
      <p className="mt-1 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-center font-sans text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 rounded-full border border-foreground/25 bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-foreground">
          <span aria-hidden="true" className="text-[7px] leading-none opacity-70">✦</span>
          Statusline
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-foreground/25 bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-foreground">
          <span aria-hidden="true" className="text-[7px] leading-none opacity-70">✦</span>
          Actions
        </span>
        <span>
          — special runtime-dispatched surfaces, set off on their own row and shown
          only where agent-connector wires them (absence isn&apos;t a claim the host
          lacks them). Each links to its setup docs.
        </span>
      </p>
    </div>
  );
}

/**
 * One agent on the wall: name + its exact surface profile as 3-state chips, a
 * compact form-factor chip (CLI / IDE / Ext), and any lit handler chips.
 *
 * Linking, kept valid + accessible (no nested <a>): the card is a <div> with a
 * full-bleed Link to the Platforms reference behind everything (absolute inset-0,
 * z-0). The handler (✦) chips sit ABOVE it (relative z-10) as their OWN Links to
 * the specific surface-setup anchors, so a click on a chip jumps to that anchor
 * while a click anywhere else on the card opens the Platforms reference. Both the
 * card link and the chip links are focusable real <a> elements.
 */
function AgentEntry({ platform, frontier }: { platform: Platform; frontier?: boolean }) {
  const paradigm = paradigms.find((p) => p.id === platform.paradigm)!;
  const ffShort = formFactorShort(platform.id);
  const supported = surfaceChips
    .filter((c) => platform.surfaces[c.key])
    .map((c) => c.full)
    .join(", ");
  const litHandlers = handlerChips.filter((c) => platform.surfaces[c.key]);

  return (
    <div
      className={cn(
        "group relative rounded-lg border px-3.5 py-2.5 transition-colors hover:border-foreground/30 hover:bg-accent focus-within:border-foreground/40",
        frontier
          ? "border-foreground/20 bg-foreground/[0.04] shadow-sm"
          : "border-border bg-background/60",
      )}
      title={`${platform.name} (${paradigm.label}) — supports: ${supported}`}
    >
      {/* Full-card link to the Platforms reference, behind the chips. */}
      <Link
        to={PLATFORMS_DOC}
        aria-label={`${platform.name} — open the Platforms reference`}
        className="absolute inset-0 z-0 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40"
      />
      <div className="pointer-events-none relative z-10 flex items-center gap-2">
        <span
          className={cn("size-2 shrink-0 rounded-full", paradigm.dot)}
          aria-hidden="true"
        />
        <span className="text-sm font-medium text-muted-foreground transition-colors group-hover:text-foreground">
          {platform.name}
        </span>
        {ffShort ? (
          <span
            className="ml-auto rounded border border-border bg-background/80 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase leading-none tracking-wide text-muted-foreground"
            title={`Form factor: ${ffShort}`}
          >
            {ffShort}
          </span>
        ) : null}
      </div>
      <div className="pointer-events-none relative z-10 mt-2 flex items-center font-mono text-[10px] leading-none tracking-tight">
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
      {litHandlers.length > 0 && (
        <div className="relative z-10 mt-2 flex flex-wrap items-center gap-1 border-t border-border/50 pt-2">
          {litHandlers.map((c) => (
            <Link
              key={c.key}
              to={HANDLER_DOC[c.key]}
              title={`${c.full}: special runtime handler surface, wired by agent-connector — open its setup docs`}
              className="inline-flex items-center gap-1 rounded-full border border-foreground/25 bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-foreground transition-colors hover:border-foreground/50 hover:bg-foreground/[0.12] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground/40"
            >
              <span aria-hidden="true" className="text-[7px] leading-none opacity-70">
                ✦
              </span>
              {c.abbr}
              <span className="sr-only"> — open setup docs</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** Curated frontier hosts, rendered in the pinned promo order (NOT the comparator). */
const frontierPlatforms: Platform[] = frontierIds
  .map((id) => platforms.find((p) => p.id === id))
  .filter((p): p is Platform => Boolean(p));

/** Everything else, sorted by paradigm → family → name. */
const generalPlatforms: Platform[] = platforms
  .filter((p) => !isFrontier(p.id))
  .sort(byParadigmFamilyName);

/**
 * The long tail: collapsed by default to ~2 rows behind a bottom fade, with a
 * "Show all N more" toggle that mounts the full set.
 *
 * Roughly two rows' worth of general cards stay mounted while collapsed. With a
 * responsive flex-wrap a CSS max-height clamp would clip cards BELOW the fold
 * while leaving their links in the tab order (a keyboard / screen-reader user
 * tabs into off-screen links). Instead the collapsed wall renders only this
 * slice — so the focusable set ALWAYS equals the visible set at every width,
 * with no clipped-but-focusable links — and the bottom gradient fades the last
 * mounted row into the page. (~2 rows at desktop; "roughly" by design, since
 * wrap count varies with width.)
 */
const COLLAPSED_GENERAL_COUNT = 12;

function GeneralWall() {
  const [open, setOpen] = useState(false);
  const regionId = "general-coverage-wall";
  const shown = open
    ? generalPlatforms
    : generalPlatforms.slice(0, COLLAPSED_GENERAL_COUNT);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-center gap-x-2 gap-y-0.5">
        <h3 className="font-mono text-sm font-semibold uppercase tracking-wide text-foreground">
          General support
        </h3>
        <span className="text-xs text-muted-foreground">
          · {generalPlatforms.length} more · same drift-tested profiles
        </span>
      </div>

      <div className="relative">
        <div
          id={regionId}
          className="flex flex-wrap justify-center gap-2.5"
        >
          {shown.map((pl) => (
            <AgentEntry key={pl.id} platform={pl} />
          ))}
        </div>
        {!open && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-background via-background/85 to-transparent"
          />
        )}
      </div>

      <div className="mt-4 flex justify-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={regionId}
          className="rounded-full border border-border bg-background/60 px-4 py-1.5 font-mono text-xs font-medium text-foreground transition-colors hover:border-foreground/30 hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40"
        >
          {open ? "Show fewer" : `Show all ${generalPlatforms.length} more`}
        </button>
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

      <p className="mt-6 text-center text-xs text-muted-foreground">
        Each card links to the{" "}
        <span className="text-foreground">Platforms reference</span>; the colored
        dot is its <span className="text-foreground">hook paradigm</span> and the
        corner tag its form factor (CLI / IDE / Ext).
      </p>

      <div className="mt-8 flex flex-col gap-10">
        <div>
          <div className="mb-3 flex flex-wrap items-baseline justify-center gap-x-2 gap-y-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Frontier
            </span>
            <h3 className="font-mono text-sm font-semibold uppercase tracking-wide text-foreground">
              · {frontierPlatforms.length} flagship hosts
            </h3>
          </div>
          <div className="mx-auto grid max-w-4xl grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            {frontierPlatforms.map((pl) => (
              <AgentEntry key={pl.id} platform={pl} frontier />
            ))}
          </div>
        </div>

        <GeneralWall />
      </div>

      <p className="mt-8 text-center text-xs text-muted-foreground">
        Surface profiles are drift-tested against the adapter registry — the
        wall can't claim what an adapter doesn't ship, and a lit chip always
        implies the host natively offers that surface.
      </p>

      <InstallMethods />
    </Section>
  );
}

/**
 * "Two ways in" — direct config-write vs the marketplace/plugin flow. Marketplace
 * is now an officially supported, end-to-end-DRIVEN path for Claude Code, Codex
 * and Antigravity (live-verified on Linux + native Windows), not just a hand-
 * installable bundle.
 */
function InstallMethods() {
  return (
    <div className="mx-auto mt-16 max-w-4xl">
      <div className="text-center">
        <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          Two ways in
        </span>
        <h3 className="mt-3 text-balance text-xl font-bold tracking-tight sm:text-2xl">
          Direct config-write —{" "}
          <span className="text-gradient">or drive the host's own marketplace</span>
        </h3>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {installMethods.map((m) => (
          <div
            key={m.id}
            className="rounded-xl border border-border bg-card/60 p-6 backdrop-blur transition-colors hover:border-foreground/20"
          >
            <code
              className="font-mono text-xs"
              style={{ color: "var(--brand)" }}
            >
              {m.flag}
            </code>
            <h4 className="mt-2 text-lg font-semibold tracking-tight">
              {m.title}
            </h4>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {m.summary}
            </p>
            <p className="mt-4 border-t border-border pt-3 text-xs font-medium text-foreground">
              {m.scope}
            </p>
          </div>
        ))}
      </div>

      <p className="mx-auto mt-6 max-w-2xl text-center text-xs text-muted-foreground">
        Same connector, same telemetry — `uninstall --method auto` reverses
        whichever method is installed, and a guard refuses installing the same
        connector by both at once.
      </p>
    </div>
  );
}
