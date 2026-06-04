/**
 * Skip-to-content link. Visually hidden until focused, then it appears top-left
 * so keyboard users can jump past the nav straight to the main landmark.
 * Target the element whose id matches `targetId` (give that element tabIndex={-1}).
 */
export function SkipLink({ targetId = "main-content" }: { targetId?: string }) {
  return (
    <a
      href={`#${targetId}`}
      className="sr-only z-[100] rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground shadow-md focus-visible:not-sr-only focus-visible:absolute focus-visible:left-4 focus-visible:top-4"
    >
      Skip to content
    </a>
  );
}
