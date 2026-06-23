import { Link } from "react-router-dom";

import { Section, SectionHeading } from "@/components/sections/Section";
import { cn } from "@/lib/utils";
import {
  byParadigmFamilyName,
  formFactorShort,
  paradigms,
  platformCount,
  platforms,
  type Platform,
} from "@/data";

/**
 * Landing coverage teaser — a lightweight, dependency-free auto-scrolling
 * marquee that replaces the detailed rank-tier wall (which now lives at
 * /docs/dev/platforms). Name chips only (NO logos): each chip is the host name
 * + its paradigm color dot + a small form-factor tag (CLI / IDE / Ext).
 *
 * Two rows scroll horizontally in OPPOSITE directions in a continuous,
 * seamless loop. The loop is pure CSS (`@keyframes` translateX, see
 * `.marquee-track` / `marquee-left` / `marquee-right` in index.css): each row's
 * chip list is rendered TWICE back-to-back and the track translates by exactly
 * -50% (one full copy width), so the second copy is in frame the instant the
 * first scrolls off — no JS rAF loop, no seam.
 *
 * Accessibility / motion:
 *   - the marquee is DECORATIVE motion — the real affordance is the
 *     "See the full coverage matrix →" link below it;
 *   - hover pauses the animation (`hover:[animation-play-state:paused]`);
 *   - `prefers-reduced-motion: reduce` disables the animation entirely (the CSS
 *     media query sets `animation: none`), leaving the chips as a static,
 *     wrapped, horizontally-scrollable strip — no motion at all;
 *   - the duplicated second copy is `aria-hidden` so assistive tech reads each
 *     host name once.
 */

/** Comparator-ordered hosts, split into two interleaved rows of similar length. */
const ordered: Platform[] = [...platforms].sort(byParadigmFamilyName);
const rowA: Platform[] = ordered.filter((_, i) => i % 2 === 0);
const rowB: Platform[] = ordered.filter((_, i) => i % 2 === 1);

function HostChip({ platform }: { platform: Platform }) {
  const paradigm = paradigms.find((p) => p.id === platform.paradigm)!;
  const ffShort = formFactorShort(platform.id);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card/70 px-3 py-1.5 text-sm font-medium shadow-sm"
      title={`${platform.name} — ${paradigm.label}`}
    >
      <span
        className={cn("size-2 shrink-0 rounded-full", paradigm.dot)}
        aria-hidden="true"
      />
      <span className="text-foreground">{platform.name}</span>
      {ffShort ? (
        <span className="font-mono text-[9px] font-semibold uppercase leading-none tracking-wide text-muted-foreground">
          {ffShort}
        </span>
      ) : null}
    </span>
  );
}

/**
 * One marquee row. A SINGLE track holds two back-to-back copies of the chip
 * list and translates by exactly -50% (one copy width), so when the first copy
 * has scrolled fully off the left the second copy occupies the identical
 * position — a seamless wrap with no JS. The second copy is `aria-hidden`
 * (decorative duplicate, so SR reads each host name once). `direction` picks
 * the keyframe direction; hover pauses via the parent `group`.
 */
function MarqueeRow({
  hosts,
  direction,
}: {
  hosts: Platform[];
  direction: "left" | "right";
}) {
  return (
    <div className="group flex overflow-hidden">
      {/* No flex `gap` here: each <li> carries equal `pr-2.5` instead, so the
          two copies are EXACTLY equal width and the -50% translate lands on a
          chip boundary with no seam. */}
      <ul
        className={cn(
          "marquee-track flex w-max shrink-0 list-none items-center",
          direction === "right" ? "marquee-right" : null,
          "group-hover:[animation-play-state:paused]",
        )}
      >
        {hosts.map((p) => (
          <li key={p.id} className="pr-2.5">
            <HostChip platform={p} />
          </li>
        ))}
        {/* Second, aria-hidden copy: makes the -50% translate loop seamless. */}
        {hosts.map((p) => (
          <li key={`${p.id}-dup`} aria-hidden="true" className="pr-2.5">
            <HostChip platform={p} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CoverageMarquee() {
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
        description="One connector deploys across every detected agent CLI, IDE extension, and app — Claude Code to Codex to Cursor and beyond."
      />

      {/* Edge fade masks: a left/right gradient mask so chips dissolve at the
          edges instead of hard-clipping. Decorative — aria-hidden on rows. */}
      <div
        className="mt-12 flex flex-col gap-3 [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)] [-webkit-mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]"
      >
        <MarqueeRow hosts={rowA} direction="left" />
        <MarqueeRow hosts={rowB} direction="right" />
      </div>

      <div className="mt-10 text-center">
        <Link
          to="/docs/dev/platforms"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline"
        >
          See the full coverage matrix
          <span aria-hidden="true">→</span>
        </Link>
      </div>
    </Section>
  );
}
