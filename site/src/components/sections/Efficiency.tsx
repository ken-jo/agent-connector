import { ArrowRight, Check, Minus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Section, SectionHeading } from "@/components/sections/Section";

/**
 * The efficiency / "the math" section — the impact pitch. Quantifies the work
 * agent-connector does for you: one ~60-line connector definition replaces the
 * ~19,600 lines of per-platform integration logic (29 adapters) you would
 * otherwise hand-author and maintain. Numbers are grounded in the repo itself
 * (src/adapters LOC vs an example connector).
 */

const stats = [
  { value: "29", label: "platforms" },
  { value: "4", label: "surfaces" },
  { value: "3", label: "hook paradigms" },
  { value: "+1", label: "line to add a host" },
];

const oldWay = [
  "Learn each host's config dialect — JSON, JSONC, TOML, YAML, exported JS modules",
  "Hand-write the right root key, transport, scope, and event names per platform",
  "Build and maintain a separate install / uninstall / doctor flow for every host",
  "Chase each platform's quirks, path moves, and renames — forever",
];

const newWay = [
  "Declare your server + hooks + commands + tools once with defineConnector({…})",
  "Pick which platforms to activate via targets — or let it auto-detect every installed host",
  "install · sync · uninstall · doctor deploy it straight into each host's native MCP + plugin/extension system — no per-marketplace packaging, submission, or review",
  "A new platform? Change one line. You maintain none of the adapter code",
];

export function Efficiency() {
  return (
    <Section id="efficiency">
      <SectionHeading
        eyebrow="The efficiency"
        title={
          <>
            Write it once. Skip <span className="whitespace-nowrap">~19,600 lines</span> of glue.
          </>
        }
        description="Supporting agent hosts the old way means hand-authoring and maintaining a different config dialect, install flow, and quirk-set for every one. agent-connector already did that work — across 29 platforms, 4 surfaces, and 3 hook paradigms — so your integration collapses to a single definition."
      />

      {/* Hero stat band */}
      <Card className="relative mt-14 overflow-hidden p-8 sm:p-12">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-32 -top-32 size-80 rounded-full opacity-70 blur-3xl"
          style={{
            background:
              "radial-gradient(circle, color-mix(in oklch, var(--brand) 20%, transparent), transparent 70%)",
          }}
        />
        <div className="grid items-center gap-10 lg:grid-cols-[auto_1fr]">
          <div className="text-center lg:text-left">
            <div className="bg-gradient-to-br from-foreground to-foreground/55 bg-clip-text text-7xl font-extrabold tracking-tighter text-transparent sm:text-8xl">
              ~99%
            </div>
            <p className="mt-2 max-w-xs text-pretty text-sm leading-relaxed text-muted-foreground">
              less integration code you write &amp; maintain — one{" "}
              <span className="font-semibold text-foreground">~60-line</span> connector
              definition vs the{" "}
              <span className="font-semibold text-foreground">~19,600 lines</span> of
              per-platform adapters that ship with the framework.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
            {stats.map((s) => (
              <div
                key={s.label}
                className="flex flex-col items-center justify-center bg-card px-4 py-7 text-center"
              >
                <span className="font-mono text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
                  {s.value}
                </span>
                <span className="mt-1.5 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  {s.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* Before / after */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="p-8">
          <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
            The old way · per platform
          </span>
          <h3 className="mt-4 text-xl font-bold tracking-tight">
            N dialects, hand-tuned and maintained
          </h3>
          <ul className="mt-6 space-y-4">
            {oldWay.map((line) => (
              <li key={line} className="flex gap-3 text-sm leading-relaxed text-muted-foreground">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Minus className="size-3.5" />
                </span>
                {line}
              </li>
            ))}
          </ul>
          <p className="mt-7 border-t border-border pt-5 font-mono text-sm text-muted-foreground">
            ≈ 19,600 lines × every host × forever
          </p>
        </Card>

        <Card className="relative overflow-hidden p-8 ring-1 ring-[color-mix(in_oklch,var(--brand)_35%,transparent)]">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-24 -top-24 size-56 rounded-full opacity-70 blur-2xl"
            style={{
              background:
                "radial-gradient(circle, color-mix(in oklch, var(--brand) 16%, transparent), transparent 70%)",
            }}
          />
          <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
            agent-connector · once
          </span>
          <h3 className="mt-4 flex items-center gap-2 text-xl font-bold tracking-tight">
            One definition <ArrowRight className="size-5 text-muted-foreground" /> every platform
          </h3>
          <ul className="mt-6 space-y-4">
            {newWay.map((line) => (
              <li key={line} className="flex gap-3 text-sm leading-relaxed text-foreground">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
                  <Check className="size-3.5" />
                </span>
                {line}
              </li>
            ))}
          </ul>
          <p className="mt-7 border-t border-border pt-5 font-mono text-sm text-foreground">
            ≈ 60 lines, written once
          </p>
        </Card>
      </div>
    </Section>
  );
}
