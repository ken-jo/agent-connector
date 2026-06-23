import { Section } from "@/components/sections/Section";
import { installMethods } from "@/data";

/**
 * "Two ways in" — direct config-write vs the marketplace/plugin flow. Marketplace
 * is now an officially supported, end-to-end-DRIVEN path for Claude Code, Codex
 * and Antigravity (live-verified on Linux + native Windows), not just a hand-
 * installable bundle.
 *
 * Extracted out of the old Platforms section into its own landing section so it
 * can sit directly below the "Who it's for" audience router (the two persona
 * cards) — the IA flow is: pick your track → here is how each track gets in.
 */
export function InstallMethods() {
  return (
    <Section id="install-methods">
      <div className="mx-auto max-w-4xl">
        <div className="text-center">
          <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
            Two ways in
          </span>
          <h3 className="mt-3 text-balance text-xl font-bold tracking-tight sm:text-2xl">
            Direct config-write —{" "}
            <span className="text-gradient">or drive the host&apos;s own marketplace</span>
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
    </Section>
  );
}
