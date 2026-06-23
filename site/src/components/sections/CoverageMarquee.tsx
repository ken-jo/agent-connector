import { Link } from "react-router-dom";

import { Section, SectionHeading } from "@/components/sections/Section";
import { cn } from "@/lib/utils";
import {
  byParadigmFamilyName,
  formFactorShort,
  hostSource,
  paradigms,
  platformCount,
  platforms,
  type Platform,
} from "@/data";

/**
 * Landing coverage teaser — a lightweight, dependency-free auto-scrolling
 * marquee that replaces the detailed rank-tier wall (which now lives at
 * /coverage). Host NAMES only (no logos, no paradigm dot, no pill outline) —
 * a clean flowing line separated by `·`, with a small form-factor tag
 * (CLI / IDE / Ext). Frontier (closed-source) hosts render a notch larger.
 *
 * Two rows scroll horizontally in OPPOSITE directions in a continuous,
 * seamless loop. The loop is pure CSS (`@keyframes` translateX, see
 * `.marquee-track` / `.marquee-right` in index.css): each row's
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
  // Frontier (closed-source) hosts get a notch-larger, bolder name.
  const isFrontier = "closed" in hostSource[platform.id];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-baseline gap-1.5",
        isFrontier ? "text-lg font-semibold" : "text-base font-medium",
      )}
      title={`${platform.name} — ${paradigm.label}`}
    >
      <span className="text-foreground">{platform.name}</span>
      {ffShort ? (
        <span className="font-mono text-[10px] font-semibold uppercase leading-none tracking-wide text-muted-foreground">
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
      {/* Each <li> carries a trailing `·` separator (equal on every item, so
          the two copies stay EXACTLY equal width and the -50% translate lands
          on a boundary with no seam — the wrap reads `… · A · B · …`). */}
      <ul
        className={cn(
          "marquee-track flex w-max shrink-0 list-none items-center",
          direction === "right" ? "marquee-right" : null,
          "group-hover:[animation-play-state:paused]",
        )}
      >
        {hosts.map((p) => (
          <li key={p.id} className="flex items-center">
            <HostChip platform={p} />
            <span aria-hidden="true" className="mx-4 text-muted-foreground/40">
              ·
            </span>
          </li>
        ))}
        {/* Second, aria-hidden copy: makes the -50% translate loop seamless. */}
        {hosts.map((p) => (
          <li key={`${p.id}-dup`} aria-hidden="true" className="flex items-center">
            <HostChip platform={p} />
            <span aria-hidden="true" className="mx-4 text-muted-foreground/40">
              ·
            </span>
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
          to="/coverage"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline"
        >
          See the full coverage matrix
          <span aria-hidden="true">→</span>
        </Link>
      </div>
    </Section>
  );
}
