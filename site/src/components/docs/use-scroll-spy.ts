import * as React from "react";

/**
 * Scroll-spy: tracks which section id is currently the "active" one in the
 * viewport. Uses IntersectionObserver, biasing toward the top of the viewport so
 * the highlighted item matches what the reader is looking at.
 */
export function useScrollSpy(ids: string[], offsetTop = 96): string {
  const [activeId, setActiveId] = React.useState<string>(ids[0] ?? "");

  React.useEffect(() => {
    if (ids.length === 0) return;

    const visible = new Map<string, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id;
          if (entry.isIntersecting) {
            visible.set(id, entry.intersectionRatio);
          } else {
            visible.delete(id);
          }
        }

        // Pick the visible section closest to the top of the viewport.
        let best: string | null = null;
        let bestTop = Infinity;
        for (const id of visible.keys()) {
          const el = document.getElementById(id);
          if (!el) continue;
          const top = Math.abs(el.getBoundingClientRect().top - offsetTop);
          if (top < bestTop) {
            bestTop = top;
            best = id;
          }
        }
        if (best) setActiveId(best);
      },
      {
        rootMargin: `-${offsetTop}px 0px -65% 0px`,
        threshold: [0, 0.25, 0.5, 1],
      },
    );

    const els = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    els.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [ids, offsetTop]);

  return activeId;
}
