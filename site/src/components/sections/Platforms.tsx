import { Link } from "react-router-dom";

import { Section, SectionHeading } from "@/components/sections/Section";
import { cn } from "@/lib/utils";
import coverageStars from "@/coverage-stars.generated.json";
import {
  byParadigmFamilyName,
  formFactorShort,
  handlerChips,
  hostSource,
  installMethods,
  paradigms,
  platformCount,
  platforms,
  STAR_TIERS,
  surfaceChips,
  surfaceState,
  tierOf,
  type CoverageTier,
  type Platform,
  type SurfaceState,
} from "@/data";

/** Where a card's surface/handler links land in the dev docs. */
const PLATFORMS_DOC = "/docs/dev/platforms";
const HANDLER_DOC: Record<"statusline" | "actions", string> = {
  statusline: "/docs/dev/surfaces#statusline",
  actions: "/docs/dev/surfaces#actions",
};

/** Build-fetched stargazers counts ({ "owner/name": stars }). */
const STARS: Record<string, number> = coverageStars;

/** The stargazers count for a host id (undefined if closed / no repo). */
function starsFor(id: string): number | undefined {
  const src = hostSource[id];
  return src && "repo" in src ? STARS[src.repo] : undefined;
}

/** The coverage tier for a host id, resolving its fetched star count. */
function coverageTierFor(id: string): CoverageTier {
  return tierOf(id, starsFor(id));
}

/**
 * Per-tier card treatment — a graded, dark-theme-friendly rank palette.
 * `frontier` is the premium closed-source tier (gold/amber gradient); the eight
 * OSS tiers step down a cool→warm metallic ramp so adjacent tiers stay
 * distinguishable without shouting. `chip` colors the small tier badge.
 */
const tierStyle: Record<CoverageTier, { card: string; chip: string; label: string }> = {
  frontier: {
    card: "border-amber-400/40 bg-gradient-to-br from-amber-500/20 to-yellow-600/10 shadow-sm shadow-amber-500/10",
    chip: "border-amber-400/50 bg-amber-400/15 text-amber-200",
    label: "Frontier",
  },
  Challenger: {
    card: "border-fuchsia-400/40 bg-gradient-to-br from-fuchsia-500/20 to-violet-600/10",
    chip: "border-fuchsia-400/50 bg-fuchsia-400/15 text-fuchsia-200",
    label: "Challenger",
  },
  Grandmaster: {
    card: "border-rose-400/40 bg-gradient-to-br from-rose-500/18 to-red-600/10",
    chip: "border-rose-400/50 bg-rose-400/15 text-rose-200",
    label: "Grandmaster",
  },
  Master: {
    card: "border-purple-400/35 bg-gradient-to-br from-purple-500/16 to-indigo-600/10",
    chip: "border-purple-400/50 bg-purple-400/15 text-purple-200",
    label: "Master",
  },
  Diamond: {
    card: "border-sky-400/35 bg-gradient-to-br from-sky-500/16 to-blue-600/10",
    chip: "border-sky-400/50 bg-sky-400/15 text-sky-200",
    label: "Diamond",
  },
  Platinum: {
    card: "border-teal-400/35 bg-gradient-to-br from-teal-500/14 to-cyan-600/8",
    chip: "border-teal-400/50 bg-teal-400/15 text-teal-200",
    label: "Platinum",
  },
  Gold: {
    card: "border-yellow-500/30 bg-gradient-to-br from-yellow-600/14 to-amber-700/8",
    chip: "border-yellow-500/50 bg-yellow-500/15 text-yellow-200",
    label: "Gold",
  },
  Silver: {
    card: "border-slate-300/25 bg-gradient-to-br from-slate-400/12 to-slate-500/6",
    chip: "border-slate-300/40 bg-slate-300/12 text-slate-200",
    label: "Silver",
  },
  Bronze: {
    card: "border-orange-800/35 bg-gradient-to-br from-orange-900/20 to-amber-950/10",
    chip: "border-orange-700/50 bg-orange-800/20 text-orange-200",
    label: "Bronze",
  },
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
function AgentEntry({ platform }: { platform: Platform }) {
  const paradigm = paradigms.find((p) => p.id === platform.paradigm)!;
  const ffShort = formFactorShort(platform.id);
  const supported = surfaceChips
    .filter((c) => platform.surfaces[c.key])
    .map((c) => c.full)
    .join(", ");
  const litHandlers = handlerChips.filter((c) => platform.surfaces[c.key]);
  const tier = coverageTierFor(platform.id);
  const style = tierStyle[tier];
  const stars = starsFor(platform.id);
  const tierTitle =
    tier === "frontier"
      ? "Frontier — closed-source flagship"
      : `${tier} tier — ${stars?.toLocaleString() ?? "?"} GitHub stars`;

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg border px-3.5 py-2.5 transition-colors hover:border-foreground/40 focus-within:border-foreground/50",
        style.card,
      )}
      title={`${platform.name} (${paradigm.label}) · ${tierTitle} — supports: ${supported}`}
    >
      {/* Full-card link to the Platforms reference, behind the chips. */}
      <Link
        to={PLATFORMS_DOC}
        aria-label={`${platform.name} — open the Platforms reference`}
        className="absolute inset-0 z-0 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40"
      />
      <div className="pointer-events-none relative z-10 flex items-start gap-2">
        <span
          className={cn("mt-1.5 size-2 shrink-0 rounded-full", paradigm.dot)}
          aria-hidden="true"
        />
        <span className="min-w-0 break-words text-sm font-semibold leading-snug text-foreground">
          {platform.name}
        </span>
        {ffShort ? (
          <span
            className="ml-auto shrink-0 self-start rounded border border-border bg-background/80 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase leading-none tracking-wide text-muted-foreground"
            title={`Form factor: ${ffShort}`}
          >
            {ffShort}
          </span>
        ) : null}
      </div>
      <div className="pointer-events-none relative z-10 mt-1.5 flex items-center gap-1.5">
        <span
          className={cn(
            "rounded border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase leading-none tracking-wide",
            style.chip,
          )}
        >
          {style.label}
        </span>
        {stars !== undefined ? (
          <span className="font-mono text-[9px] leading-none text-muted-foreground">
            ★ {stars.toLocaleString()}
          </span>
        ) : null}
      </div>
      <div className="pointer-events-none relative z-10 mt-2 flex flex-wrap items-center gap-y-1 font-mono text-[10px] leading-none tracking-tight">
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

/**
 * All hosts in ONE wall, ordered by paradigm → fork-family → name (the shared
 * coverage comparator). Each card's BACKGROUND is colored by its rank tier
 * (closed → Frontier; OSS → GitHub-stars tier), computed at render from the
 * build-fetched star snapshot.
 */
const wallPlatforms: Platform[] = [...platforms].sort(byParadigmFamilyName);

/** Tier legend: Frontier (closed flagship) + the eight star-ranked tiers. */
function TierLegend() {
  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-center text-xs text-muted-foreground">
        Card color = rank tier.{" "}
        <span className="text-foreground">Frontier</span> = closed-source
        flagship; <span className="text-foreground">Challenger → Bronze</span> =
        open-source hosts ranked by GitHub stars.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {(["frontier", ...STAR_TIERS.map((t) => t.tier)] as CoverageTier[]).map(
          (t) => (
            <span
              key={t}
              className={cn(
                "rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase leading-none tracking-wide",
                tierStyle[t].chip,
              )}
            >
              {tierStyle[t].label}
            </span>
          ),
        )}
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
        <TierLegend />
      </div>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        Each card links to the{" "}
        <span className="text-foreground">Platforms reference</span>; the colored
        dot is its <span className="text-foreground">hook paradigm</span>, the
        corner tag its form factor (CLI / IDE / Ext), and the card color its{" "}
        <span className="text-foreground">rank tier</span>.
      </p>

      <div className="mx-auto mt-8 grid max-w-5xl grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {wallPlatforms.map((pl) => (
          <AgentEntry key={pl.id} platform={pl} />
        ))}
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
