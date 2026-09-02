import { useMemo, useState } from "react";
import { ExternalLink, Github } from "lucide-react";
import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";
import {
  agentPluginBadge,
  agentPluginStateOf,
  byParadigmFamilyName,
  formatStars,
  formFactorOf,
  formFactorShort,
  handlerChips,
  hostLifecycleOf,
  hostLinks,
  hostLinkUrl,
  paradigms,
  STAR_TIERS,
  surfaceChips,
  surfaceState,
  tierOf,
  type AgentPluginState,
  type CoverageTier,
  type FormFactorId,
  type HostLifecycle,
  type Platform,
  type PlatformSurfaces,
  type SurfaceState,
} from "@/data";
import {
  publicCoveragePlatforms,
  starsForPlatform,
} from "@/components/coverage-wall/public-coverage";

/**
 * The detailed rank-tier coverage wall, extracted out of the landing into a
 * shared component. It is the full interactive matrix (filter bar + tier-colored
 * cards + GitHub/Guide links + ✦ handler chips) and lives at the `/docs` root
 * (the wide persona-chooser page) — NOT in the narrow dev-docs prose column,
 * where the full-width grid + filter bar would overflow. The landing carries
 * only a lightweight name-chip marquee that links here.
 *
 * It imports only from `@/data` (the dependency-free platform-data layer) and
 * the build-fetched star snapshot, so the docs route chunk owns this weight —
 * the landing never pulls it in. `platform-data.ts` stays dependency-free;
 * this is a React component, not docs-data.
 */

/** Where a card's surface/handler links land in the dev docs. */
const PLATFORMS_DOC = "/docs/dev/platforms";
const HANDLER_DOC: Record<"statusline" | "actions", string> = {
  statusline: "/docs/dev/surfaces#statusline",
  actions: "/docs/dev/surfaces#actions",
};

/** The coverage tier for a host id, resolving its fetched star count. */
function coverageTierFor(id: string): CoverageTier {
  return tierOf(id, starsForPlatform(id));
}

/**
 * Per-tier card treatment — a graded rank palette, theme-aware.
 *
 * The card uses a background-IMAGE gradient in BOTH themes and NO
 * background-COLOR. This is deliberate: `cn()` runs twMerge, which treats
 * `bg-{color}` and `bg-gradient-*` as ONE conflict group and would drop one —
 * a light `bg-{tier}-100` then bleeds through the translucent dark gradient
 * (bright-pastel-in-dark bug). Light stops differ from dark stops only by the
 * `dark:` variant, so twMerge keeps both, and with no solid bg-color nothing
 * bleeds. Light = a readable `from-{tier}-100 to-{tier}-200` gradient; `dark:`
 * = the ORIGINAL subtle translucent gradient. `frontier` is the premium
 * closed/promoted tier; the eight OSS star tiers step down a cool→warm ramp,
 * distinguishable in BOTH themes. The chips stay solid translucent bg-color —
 * no competing gradient there, so they are left as-is.
 */
export const tierStyle: Record<CoverageTier, { card: string; chip: string; label: string }> = {
  frontier: {
    card: "bg-gradient-to-br from-amber-100 to-amber-200 border-amber-300 shadow-sm dark:border-amber-400/40 dark:from-amber-500/20 dark:to-yellow-600/10 dark:shadow-amber-500/10",
    chip: "border-amber-400 bg-amber-200 text-amber-900 dark:border-amber-400/50 dark:bg-amber-400/15 dark:text-amber-200",
    label: "★ Frontier",
  },
  Challenger: {
    card: "bg-gradient-to-br from-fuchsia-100 to-fuchsia-200 border-fuchsia-300 dark:border-fuchsia-400/40 dark:from-fuchsia-500/20 dark:to-violet-600/10",
    chip: "border-fuchsia-400 bg-fuchsia-200 text-fuchsia-900 dark:border-fuchsia-400/50 dark:bg-fuchsia-400/15 dark:text-fuchsia-200",
    label: "★80k+",
  },
  Grandmaster: {
    card: "bg-gradient-to-br from-rose-100 to-rose-200 border-rose-300 dark:border-rose-400/40 dark:from-rose-500/18 dark:to-red-600/10",
    chip: "border-rose-400 bg-rose-200 text-rose-900 dark:border-rose-400/50 dark:bg-rose-400/15 dark:text-rose-200",
    label: "★50k+",
  },
  Master: {
    card: "bg-gradient-to-br from-purple-100 to-purple-200 border-purple-300 dark:border-purple-400/35 dark:from-purple-500/16 dark:to-indigo-600/10",
    chip: "border-purple-400 bg-purple-200 text-purple-900 dark:border-purple-400/50 dark:bg-purple-400/15 dark:text-purple-200",
    label: "★25k+",
  },
  Diamond: {
    card: "bg-gradient-to-br from-sky-100 to-sky-200 border-sky-300 dark:border-sky-400/35 dark:from-sky-500/16 dark:to-blue-600/10",
    chip: "border-sky-400 bg-sky-200 text-sky-900 dark:border-sky-400/50 dark:bg-sky-400/15 dark:text-sky-200",
    label: "★15k+",
  },
  Platinum: {
    card: "bg-gradient-to-br from-teal-100 to-teal-200 border-teal-300 dark:border-teal-400/35 dark:from-teal-500/14 dark:to-cyan-600/8",
    chip: "border-teal-400 bg-teal-200 text-teal-900 dark:border-teal-400/50 dark:bg-teal-400/15 dark:text-teal-200",
    label: "★8k+",
  },
  Gold: {
    card: "bg-gradient-to-br from-yellow-100 to-yellow-200 border-yellow-400 dark:border-yellow-500/30 dark:from-yellow-600/14 dark:to-amber-700/8",
    chip: "border-yellow-500 bg-yellow-200 text-yellow-900 dark:border-yellow-500/50 dark:bg-yellow-500/15 dark:text-yellow-200",
    label: "★3k+",
  },
  Silver: {
    card: "bg-gradient-to-br from-slate-100 to-slate-200 border-slate-300 dark:border-slate-300/25 dark:from-slate-400/12 dark:to-slate-500/6",
    chip: "border-slate-400 bg-slate-200 text-slate-800 dark:border-slate-300/40 dark:bg-slate-300/12 dark:text-slate-200",
    label: "★1k+",
  },
  Bronze: {
    card: "bg-gradient-to-br from-orange-100 to-orange-200 border-orange-300 dark:border-orange-800/35 dark:from-orange-900/20 dark:to-amber-950/10",
    chip: "border-orange-400 bg-orange-200 text-orange-900 dark:border-orange-700/50 dark:bg-orange-800/20 dark:text-orange-200",
    label: "★0+",
  },
};

export function ParadigmLegend() {
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
    className: "font-semibold text-foreground",
    label: "supported",
  },
  "host-gap": {
    className:
      "text-foreground/70 underline decoration-dotted decoration-foreground/60 underline-offset-2",
    label: "host supports — agent-connector support coming",
  },
  "host-na": {
    // Legibly STRUCK, not vanished: was text-muted-foreground/30 (near-invisible,
    // esp. light mode) — bumped so a non-supported chip (e.g. a struck "Skills")
    // still reads in BOTH themes while staying clearly crossed out.
    className: "text-muted-foreground/70 line-through decoration-muted-foreground/70",
    label: "not offered by this agent",
  },
};

export function SurfaceLegend() {
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
          — runtime-dispatched surfaces, shown only where agent-connector wires
          them (a blank &ne; a missing host feature). Each links to its setup docs.
        </span>
      </p>
      <p className="mt-1.5 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-center font-sans text-[11px] text-muted-foreground">
        <span className={cn(markerChip, agentPluginChip.delivered)}>AP 1.0</span>
        <span>we package and install the Agent Plugins 1.0.0 bundle</span>
        <span aria-hidden="true" className="opacity-40">·</span>
        <span className={cn(markerChip, agentPluginChip.delegated)}>AP 1.0</span>
        <span>same bundle, installed by a sibling flow</span>
        <span aria-hidden="true" className="opacity-40">·</span>
        <span className={cn(markerChip, agentPluginChip.client)}>AP client</span>
        <span>reads the spec, but we ship its own format</span>
        <span aria-hidden="true" className="opacity-40">·</span>
        <span className={cn(markerChip, lifecycleChip.sunsetting)}>Sunsetting</span>
        <span>
          still shipping, but the vendor has started winding it down — hover for
          the evidence. Hosts whose upstream is fully archived are dropped from
          this page rather than badged.
        </span>
      </p>
    </div>
  );
}

/**
 * Shared shape for a card marker — also reused for the legend's inline samples,
 * so the legend swatch is byte-identical to what the card renders.
 */
const markerChip =
  "rounded border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase leading-none tracking-wide";

/**
 * Per-state treatment for the Agent Plugins marker. Emerald across all three so
 * the marker reads as ONE family against the tier palette, with the border
 * carrying the distinction: solid = we install it, dashed = a sibling flow
 * installs it, dotted = the host reads the spec but we ship its own format.
 */
const agentPluginChip: Record<AgentPluginState, string> = {
  delivered:
    "border-emerald-500 bg-emerald-200/70 text-emerald-900 dark:border-emerald-400/60 dark:bg-emerald-400/15 dark:text-emerald-200",
  delegated:
    "border-dashed border-emerald-500/70 bg-emerald-100/60 text-emerald-900 dark:border-emerald-400/45 dark:bg-emerald-400/10 dark:text-emerald-200",
  client:
    "border-dotted border-emerald-600/60 bg-transparent text-emerald-800 dark:border-emerald-400/40 dark:text-emerald-300/90",
};

/**
 * Per-state treatment for the upstream-lifecycle marker. In practice only
 * `sunsetting` reaches a card: `isPublicCoveragePlatform` drops archived hosts
 * from public coverage entirely, so the `archived` entry exists to keep the map
 * total over the status union (and would render if that policy ever softened).
 */
const lifecycleChip: Record<HostLifecycle["status"], string> = {
  archived:
    "border-red-500/70 bg-red-200/60 text-red-900 dark:border-red-400/50 dark:bg-red-500/15 dark:text-red-200",
  sunsetting:
    "border-orange-500/60 bg-orange-200/50 text-orange-900 dark:border-orange-400/45 dark:bg-orange-500/15 dark:text-orange-200",
};

/**
 * One agent on the wall: name + its exact surface profile as 3-state chips, a
 * compact form-factor chip (CLI / IDE / Ext), the rank-tier badge + star count,
 * any lit handler chips, and TWO sibling links — a top-right "go to source"
 * icon (GitHub repo or product homepage) and a bottom "Guide →" Link to our
 * Platforms reference.
 *
 * Accessibility: there is NO card-wrapping anchor anymore. The source icon and
 * the Guide link (and each ✦ handler link) are independent, focusable, sibling
 * <a>/<Link> elements with their own aria-labels — no nested anchors.
 *
 * `dimmed` (set by the surface filter) drops the tier color for a neutral,
 * grayscale, reduced-opacity treatment; the card is still fully interactive.
 */
function AgentEntry({ platform, dimmed }: { platform: Platform; dimmed?: boolean }) {
  const paradigm = paradigms.find((p) => p.id === platform.paradigm)!;
  const ffShort = formFactorShort(platform.id);
  const supported = surfaceChips
    .filter((c) => platform.surfaces[c.key])
    .map((c) => c.full)
    .join(", ");
  const litHandlers = handlerChips.filter((c) => platform.surfaces[c.key]);
  const tier = coverageTierFor(platform.id);
  const style = tierStyle[tier];
  const stars = starsForPlatform(platform.id);
  const tierTitle =
    tier === "frontier"
      ? stars !== undefined
        ? `★ Frontier — ${stars.toLocaleString()} GitHub stars`
        : "★ Frontier — closed-source flagship"
      : `${style.label} — ${stars?.toLocaleString() ?? "?"} GitHub stars`;
  const apState = agentPluginStateOf(platform.id);
  const lifecycle = hostLifecycleOf(platform.id);
  const link = hostLinks[platform.id];
  const linkUrl = hostLinkUrl(platform.id);
  const SourceIcon = link?.kind === "github" ? Github : ExternalLink;
  const sourceLabel =
    link?.kind === "github"
      ? `${platform.name} on GitHub`
      : `${platform.name} — official site`;

  return (
    <div
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-lg border px-3.5 py-2.5 transition-colors",
        dimmed
          ? "border-border bg-muted/20 opacity-60 grayscale hover:opacity-90"
          : cn("hover:border-foreground/40 focus-within:border-foreground/50", style.card),
      )}
      title={`${platform.name} (${paradigm.label}) · ${tierTitle} — supports: ${supported}`}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn("mt-1.5 size-2 shrink-0 rounded-full", paradigm.dot)}
          aria-hidden="true"
        />
        <span className="min-w-0 break-words text-sm font-semibold leading-snug text-foreground">
          {platform.name}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 self-start">
          {ffShort ? (
            <span
              className="rounded border border-border bg-background/80 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase leading-none tracking-wide text-muted-foreground"
              title={`Form factor: ${ffShort}`}
            >
              {ffShort}
            </span>
          ) : null}
          {linkUrl ? (
            <a
              href={linkUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={sourceLabel}
              title={sourceLabel}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground/40"
            >
              <SourceIcon aria-hidden="true" className="size-3.5" />
            </a>
          ) : null}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span
          className={cn(
            "rounded border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase leading-none tracking-wide",
            style.chip,
          )}
        >
          {style.label}
        </span>
        {stars !== undefined ? (
          <span
            className="font-mono text-[9px] leading-none text-muted-foreground"
            title={`${stars.toLocaleString()} GitHub stars`}
          >
            ★ {formatStars(stars)}
          </span>
        ) : tier === "frontier" ? (
          <span
            className="font-mono text-[9px] leading-none text-muted-foreground"
            title="Closed-source flagship host"
          >
            ★ flagship
          </span>
        ) : null}
        {apState ? (
          <span
            className={cn(markerChip, agentPluginChip[apState])}
            title={agentPluginBadge[apState].title}
          >
            {agentPluginBadge[apState].label}
            <span className="sr-only"> — {agentPluginBadge[apState].short}</span>
          </span>
        ) : null}
        {lifecycle ? (
          <span
            className={cn(markerChip, lifecycleChip[lifecycle.status])}
            title={lifecycle.note}
          >
            {lifecycle.label}
            <span className="sr-only"> — {lifecycle.note}</span>
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-y-1 font-mono text-[10px] leading-none tracking-tight">
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
        <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-border/50 pt-2">
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
      <Link
        to={PLATFORMS_DOC}
        aria-label={`${platform.name} — open the Platforms reference (setup guide)`}
        className="mt-2.5 inline-flex w-fit items-center gap-0.5 font-mono text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground/40"
      >
        Guide <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}

/**
 * All hosts in ONE wall, ordered by paradigm → fork-family → name (the shared
 * coverage comparator). Each card's BACKGROUND is colored by its rank tier
 * (closed → Frontier; OSS → GitHub-stars tier), computed at render from the
 * build-fetched star snapshot.
 */
const wallPlatforms: Platform[] = [...publicCoveragePlatforms].sort(byParadigmFamilyName);

/**
 * The eight surface filter tags — the 6 content surfaces + the 2
 * runtime-dispatched handler surfaces (statusline/actions), so the host special
 * surfaces are filterable too. `key` is a PlatformSurfaces flag.
 */
const SURFACE_TAGS: { key: keyof PlatformSurfaces; label: string }[] = [
  ...surfaceChips.map((c) => ({ key: c.key, label: c.abbr })),
  ...handlerChips.map((c) => ({ key: c.key, label: c.abbr })),
];
const SURFACE_KEYS = SURFACE_TAGS.map((t) => t.key);

const TYPE_TAGS: { key: FormFactorId; label: string; title: string }[] = [
  { key: "cli", label: "CLI", title: "Terminal-native agent CLIs" },
  { key: "app", label: "IDE", title: "Standalone GUI apps and editors" },
  { key: "extension", label: "Ext", title: "Editor extensions and plugins" },
];
const TYPE_KEYS = TYPE_TAGS.map((t) => t.key);

const SERVER_TYPE_TAGS = paradigms.map((p) => ({
  key: p.id,
  label: p.label,
  title: p.description,
}));
const SERVER_TYPE_KEYS = SERVER_TYPE_TAGS.map((t) => t.key);

/**
 * The Agent Plugins filter row. `key` is an `AgentPluginState`, plus a "none"
 * bucket for the hosts that do not speak the spec at all — so the four tags
 * partition the wall exactly once each.
 */
type SpecKey = AgentPluginState | "none";

const SPEC_TAGS: { key: SpecKey; label: string; title: string }[] = [
  {
    key: "delivered",
    label: "AP 1.0",
    title:
      "Agent Plugins 1.0.0 bundle — agent-connector packages it and the host's own plugin flow installs it",
  },
  {
    key: "delegated",
    label: "AP via sibling",
    title:
      "Agent Plugins 1.0.0 bundle, but the host has no headless install verb — it arrives through the editor's own command or the GitHub Copilot CLI plugin store",
  },
  {
    key: "client",
    label: "AP client",
    title:
      "A listed Agent Plugins client that agent-connector still serves with its client-specific format, because that is the format carrying hooks and commands there",
  },
  {
    key: "none",
    label: "Native",
    title:
      "Host does not speak Agent Plugins — agent-connector installs its native config format",
  },
];
const SPEC_KEYS = SPEC_TAGS.map((t) => t.key);

/** Spec match: the host's Agent Plugins state (or "none") is enabled. */
function matchesSpec(platform: Platform, enabled: Set<SpecKey>): boolean {
  return enabled.has(agentPluginStateOf(platform.id) ?? "none");
}

/** Tiers represented by public coverage hosts, in display order. */
const ALL_COVERAGE_TIERS: CoverageTier[] = ["frontier", ...STAR_TIERS.map((t) => t.tier)];
const ALL_TIERS: CoverageTier[] = ALL_COVERAGE_TIERS.filter(
  (tier) => wallPlatforms.some((p) => coverageTierFor(p.id) === tier),
);

function matchesType(platform: Platform, enabled: Set<FormFactorId>): boolean {
  const type = formFactorOf(platform.id);
  return type ? enabled.has(type) : false;
}

/** Server/adapter type match: json-stdio, mcp-only, or ts-plugin. */
function matchesServerType(platform: Platform, enabled: Set<Platform["paradigm"]>): boolean {
  return enabled.has(platform.paradigm);
}

/** Surface match: supports at least one enabled surface tag (OR-of-enabled). */
function matchesSurface(platform: Platform, enabled: Set<keyof PlatformSurfaces>): boolean {
  if (enabled.size === 0) return false;
  return SURFACE_KEYS.some((k) => enabled.has(k) && platform.surfaces[k]);
}

/** Tier match: the host's tier is in the enabled-tier set. */
function matchesTier(platform: Platform, enabled: Set<CoverageTier>): boolean {
  return enabled.has(coverageTierFor(platform.id));
}

/**
 * Four independent filter rows (Type ∩ Server ∩ Tier ∩ Surface) + tier-colored
 * wall. Each row starts ALL ON. A host matches only when it passes every row:
 * its form factor is enabled, its server/adapter type is enabled, its tier is
 * enabled, and it supports at least one enabled surface. Non-matches remain
 * visible but dimmed below the matching index.
 *
 * Semantics (unchanged): non-matching cards are NEVER hidden — they sort to the
 * BOTTOM and render dimmed (grayscale + reduced opacity, tier color dropped); a
 * STABLE partition preserves comparator order within each group.
 */
export function CoverageWall() {
  const [enabledTypes, setEnabledTypes] = useState<Set<FormFactorId>>(
    () => new Set(TYPE_KEYS),
  );
  const [enabledServerTypes, setEnabledServerTypes] = useState<Set<Platform["paradigm"]>>(
    () => new Set(SERVER_TYPE_KEYS),
  );
  const [enabledSurfaces, setEnabledSurfaces] = useState<Set<keyof PlatformSurfaces>>(
    () => new Set(SURFACE_KEYS),
  );
  const [enabledTiers, setEnabledTiers] = useState<Set<CoverageTier>>(
    () => new Set(ALL_TIERS),
  );
  const [enabledSpecs, setEnabledSpecs] = useState<Set<SpecKey>>(
    () => new Set(SPEC_KEYS),
  );

  const allTypesOn = enabledTypes.size === TYPE_KEYS.length;
  const allServerTypesOn = enabledServerTypes.size === SERVER_TYPE_KEYS.length;
  const allSurfacesOn = enabledSurfaces.size === SURFACE_KEYS.length;
  const allTiersOn = enabledTiers.size === ALL_TIERS.length;
  const allSpecsOn = enabledSpecs.size === SPEC_KEYS.length;

  const toggleType = (key: FormFactorId) =>
    setEnabledTypes((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const toggleServerType = (key: Platform["paradigm"]) =>
    setEnabledServerTypes((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const toggleSurface = (key: keyof PlatformSurfaces) =>
    setEnabledSurfaces((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const toggleTier = (tier: CoverageTier) =>
    setEnabledTiers((prev) => {
      const next = new Set(prev);
      next.has(tier) ? next.delete(tier) : next.add(tier);
      return next;
    });

  const toggleSpec = (key: SpecKey) =>
    setEnabledSpecs((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const reset = () => {
    setEnabledTypes(new Set(TYPE_KEYS));
    setEnabledServerTypes(new Set(SERVER_TYPE_KEYS));
    setEnabledSurfaces(new Set(SURFACE_KEYS));
    setEnabledTiers(new Set(ALL_TIERS));
    setEnabledSpecs(new Set(SPEC_KEYS));
  };

  const ordered = useMemo(() => {
    // wallPlatforms is already in comparator order; a STABLE partition keeps
    // that order within the matching group and within the dimmed group.
    const match: Platform[] = [];
    const dim: Platform[] = [];
    for (const p of wallPlatforms) {
      const isMatch =
        matchesType(p, enabledTypes) &&
        matchesServerType(p, enabledServerTypes) &&
        matchesTier(p, enabledTiers) &&
        matchesSpec(p, enabledSpecs) &&
        matchesSurface(p, enabledSurfaces);
      (isMatch ? match : dim).push(p);
    }
    return { match, dim };
  }, [enabledTypes, enabledServerTypes, enabledSurfaces, enabledTiers, enabledSpecs]);

  return (
    <div>
      <div className="mx-auto max-w-5xl rounded-lg border border-border bg-card/35 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 font-mono font-semibold uppercase tracking-wide text-foreground">
              <span className="size-2 rounded-full bg-emerald-500" />
              Index
            </span>
            <span>{ordered.match.length} matched</span>
            <span aria-hidden="true" className="text-muted-foreground/40">
              ·
            </span>
            <span>{ordered.dim.length} dimmed</span>
            <span aria-hidden="true" className="text-muted-foreground/40">
              ·
            </span>
            <span>Type ∩ Server ∩ Tier ∩ Spec ∩ Surface</span>
          </div>
          <button
            type="button"
            onClick={reset}
            className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground/40"
          >
            Reset
          </button>
        </div>

        <div className="mt-2 grid gap-2.5">
          <div className="grid gap-1.5 sm:grid-cols-[4.5rem_1fr] sm:items-start">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Type
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setEnabledTypes(new Set(TYPE_KEYS))}
                aria-pressed={allTypesOn}
                className={cn(
                  "rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground/40",
                  allTypesOn
                    ? "border-foreground/50 bg-foreground/15 text-foreground"
                    : "border-border bg-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                All
              </button>
              {TYPE_TAGS.map((t) => {
                const on = enabledTypes.has(t.key);
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => toggleType(t.key)}
                    aria-pressed={on}
                    title={t.title}
                    className={cn(
                      "rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground/40",
                      on
                        ? "border-foreground/40 bg-foreground/10 text-foreground"
                        : "border-border bg-transparent text-muted-foreground line-through decoration-muted-foreground/60",
                    )}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-1.5 sm:grid-cols-[4.5rem_1fr] sm:items-start">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Server
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setEnabledServerTypes(new Set(SERVER_TYPE_KEYS))}
                aria-pressed={allServerTypesOn}
                className={cn(
                  "rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground/40",
                  allServerTypesOn
                    ? "border-foreground/50 bg-foreground/15 text-foreground"
                    : "border-border bg-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                All
              </button>
              {SERVER_TYPE_TAGS.map((t) => {
                const on = enabledServerTypes.has(t.key);
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => toggleServerType(t.key)}
                    aria-pressed={on}
                    title={t.title}
                    className={cn(
                      "rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground/40",
                      on
                        ? "border-foreground/40 bg-foreground/10 text-foreground"
                        : "border-border bg-transparent text-muted-foreground line-through decoration-muted-foreground/60",
                    )}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-1.5 sm:grid-cols-[4.5rem_1fr] sm:items-start">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Tier
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setEnabledTiers(new Set(ALL_TIERS))}
                aria-pressed={allTiersOn}
                className={cn(
                  "rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground/40",
                  allTiersOn
                    ? "border-foreground/50 bg-foreground/15 text-foreground"
                    : "border-border bg-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                All
              </button>
              {ALL_TIERS.map((tier) => {
                const on = enabledTiers.has(tier);
                const style = tierStyle[tier];
                return (
                  <button
                    key={tier}
                    type="button"
                    onClick={() => toggleTier(tier)}
                    aria-pressed={on}
                    className={cn(
                      "rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground/40",
                      on
                        ? style.chip
                        : "border-border bg-transparent text-muted-foreground line-through decoration-muted-foreground/60",
                    )}
                  >
                    {style.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-1.5 sm:grid-cols-[4.5rem_1fr] sm:items-start">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Spec
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setEnabledSpecs(new Set(SPEC_KEYS))}
                aria-pressed={allSpecsOn}
                className={cn(
                  "rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground/40",
                  allSpecsOn
                    ? "border-foreground/50 bg-foreground/15 text-foreground"
                    : "border-border bg-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                All
              </button>
              {SPEC_TAGS.map((t) => {
                const on = enabledSpecs.has(t.key);
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => toggleSpec(t.key)}
                    aria-pressed={on}
                    title={t.title}
                    className={cn(
                      "rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground/40",
                      on
                        ? t.key === "none"
                          ? "border-foreground/40 bg-foreground/10 text-foreground"
                          : agentPluginChip[t.key]
                        : "border-border bg-transparent text-muted-foreground line-through decoration-muted-foreground/60",
                    )}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-1.5 sm:grid-cols-[4.5rem_1fr] sm:items-start">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Surface
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setEnabledSurfaces(new Set(SURFACE_KEYS))}
                aria-pressed={allSurfacesOn}
                className={cn(
                  "rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground/40",
                  allSurfacesOn
                    ? "border-foreground/50 bg-foreground/15 text-foreground"
                    : "border-border bg-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                All
              </button>
              {SURFACE_TAGS.map((t) => {
                const on = enabledSurfaces.has(t.key);
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => toggleSurface(t.key)}
                    aria-pressed={on}
                    className={cn(
                      "rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground/40",
                      on
                        ? "border-foreground/40 bg-foreground/10 text-foreground"
                        : "border-border bg-transparent text-muted-foreground line-through decoration-muted-foreground/60",
                    )}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto mt-8 grid max-w-5xl grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {ordered.match.map((pl) => (
          <AgentEntry key={pl.id} platform={pl} />
        ))}
        {ordered.dim.map((pl) => (
          <AgentEntry key={pl.id} platform={pl} dimmed />
        ))}
      </div>
    </div>
  );
}

/** Tier legend: Frontier (closed flagship) + the eight star-ranked tiers. */
export function TierLegend() {
  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-center text-xs text-muted-foreground">
        Card color = rank tier. <span className="text-foreground">★ Frontier</span>{" "}
        = closed or promoted flagship; OSS tiers show the minimum GitHub star
        threshold, while promoted OSS still shows its actual stars.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {ALL_TIERS.map((t) => (
          <span
            key={t}
            className={cn(
              "rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase leading-none tracking-wide",
              tierStyle[t].chip,
            )}
          >
            {tierStyle[t].label}
          </span>
        ))}
      </div>
    </div>
  );
}
