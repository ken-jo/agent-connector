import { cn } from "@/lib/utils";

/**
 * Small set of typographic primitives for docs sections. They give us anchored,
 * scroll-spy-friendly headings and consistent spacing without depending on the
 * @tailwindcss/typography reset for structural elements (we still wrap free-form
 * copy in <Prose> where useful).
 */

/** A top-level docs section wrapper with a scroll anchor + heading. */
export function DocSection({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-b border-border/60 pb-14">
      {eyebrow ? (
        <p className="mb-2 font-mono text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {eyebrow}
        </p>
      ) : null}
      <h2 className="group flex scroll-mt-24 items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
        <a href={`#${id}`} className="hover:underline">
          {title}
        </a>
      </h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** A second-level heading inside a section (also a scroll/TOC anchor). */
export function H3({
  id,
  children,
}: {
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <h3
      id={id}
      className="mt-10 scroll-mt-24 text-lg font-semibold tracking-tight text-foreground"
    >
      {id ? (
        <a href={`#${id}`} className="hover:underline">
          {children}
        </a>
      ) : (
        children
      )}
    </h3>
  );
}

export function H4({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mt-6 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h4>
  );
}

export function Lead({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-base leading-relaxed text-muted-foreground sm:text-lg">
      {children}
    </p>
  );
}

export function P({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("mt-4 leading-relaxed text-foreground/90", className)}>
      {children}
    </p>
  );
}

/** Inline mono token for use inside prose copy. */
export function C({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded border border-border bg-muted/50 px-1 py-0.5 font-mono text-[0.82em] text-foreground">
      {children}
    </code>
  );
}

/** A simple bulleted list. */
export function List({ children }: { children: React.ReactNode }) {
  return (
    <ul className="mt-4 space-y-2 text-foreground/90 marker:text-muted-foreground">
      {children}
    </ul>
  );
}

export function LI({ children }: { children: React.ReactNode }) {
  return <li className="ml-5 list-disc leading-relaxed">{children}</li>;
}

/** Callout box for notes / warnings. */
export function Callout({
  tone = "note",
  title,
  children,
}: {
  tone?: "note" | "warn";
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "my-6 rounded-xl border px-4 py-3 text-sm leading-relaxed",
        tone === "warn"
          ? "border-amber-500/30 bg-amber-500/5 text-foreground/90"
          : "border-border bg-muted/40 text-foreground/90",
      )}
    >
      {title ? (
        <p className="mb-1 font-semibold text-foreground">{title}</p>
      ) : null}
      {children}
    </div>
  );
}
