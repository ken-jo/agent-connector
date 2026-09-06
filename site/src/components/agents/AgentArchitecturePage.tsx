import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { NotFound } from "@/components/NotFound";
import { Nav } from "@/components/sections/Nav";
import { Footer } from "@/components/sections/Footer";
import { SkipLink } from "@/components/ui/skip-link";
import { starsForPlatform } from "@/components/coverage-wall/public-coverage";
import { cn } from "@/lib/utils";
import {
  architectureNoteForPlatform,
  type AgentArchitectureNote,
} from "./architecture-notes";
import {
  hostArchitectureAxes,
  hostArchitectureEvidence,
  hostComponentDiagramNodes,
  hostDiagramNodes,
  hostEntryPoint,
  hostFeatureInventory,
  hostSequenceFlowSteps,
  hostSurfaceProfiles,
  hostSourceReviewNote,
  hostSpecificBrief,
  type HostArchitectureAxis,
  type HostArchitectureEvidence,
  type HostArchitectureNode,
  type HostComponentDiagramNode,
  type HostFeatureInventoryRow,
  type HostSequenceFlowStep,
  type HostSourceReviewNote,
  type HostSurfaceProfile,
} from "./host-architecture-model";
import {
  formatStars,
  formFactorLabel,
  formFactorsOf,
  handlerChips,
  hostLinkUrl,
  hostSource,
  paradigms,
  platforms,
  surfaceChips,
  surfaceState,
  type FormFactorId,
  type Platform,
  type PlatformSurfaces,
  type SurfaceState,
} from "@/data";

const CONTENT_ID = "agent-architecture-content";

type SurfaceRow = {
  key: keyof PlatformSurfaces;
  label: string;
  group: "Static content" | "Runtime handler";
};

const surfaceRows: SurfaceRow[] = [
  ...surfaceChips.map((chip) => ({
    key: chip.key,
    label: chip.full,
    group: "Static content" as const,
  })),
  ...handlerChips.map((chip) => ({
    key: chip.key,
    label: chip.full,
    group: "Runtime handler" as const,
  })),
];

const stateMeta: Record<SurfaceState, { label: string; detail: string; className: string }> = {
  supported: {
    label: "Wired",
    detail: "agent-connector installs this surface today.",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  "host-gap": {
    label: "Host native",
    detail: "The host appears to offer this, but this adapter has not wired it yet.",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  "host-na": {
    label: "N/A",
    detail: "No confirmed host-native surface.",
    className: "border-border bg-muted/35 text-muted-foreground",
  },
};

const paradigmNotes: Record<Platform["paradigm"], string> = {
  "json-stdio":
    "Hooks are dispatched through a host-launched command. The adapter parses host JSON, calls the connector handler, and formats the reply back to the host contract.",
  "mcp-only":
    "The host accepts MCP registration, but has no confirmed hook bridge for agent-connector to call.",
  "ts-plugin":
    "The host loads a generated TypeScript plugin module that bridges in-process host events to the connector runtime.",
};

function surfaceSummary(platform: Platform, group: SurfaceRow["group"]) {
  return surfaceRows
    .filter((row) => row.group === group && platform.surfaces[row.key])
    .map((row) => row.label)
    .join(", ");
}

export function AgentArchitecturePage() {
  const { platformId } = useParams();
  const platform = platforms.find((p) => p.id === platformId);

  if (!platform) return <NotFound />;

  const paradigm = paradigms.find((p) => p.id === platform.paradigm)!;
  const factors = formFactorsOf(platform.id);
  const source = hostSource[platform.id];
  const sourceUrl = hostLinkUrl(platform.id);
  const stars = starsForPlatform(platform.id);
  const staticSummary = surfaceSummary(platform, "Static content") || "No static content surfaces wired";
  const handlerSummary = surfaceSummary(platform, "Runtime handler") || "No runtime handler surfaces wired";
  const note = architectureNoteForPlatform(platform);
  const researched = note?.status === "researched";
  const summary = note?.summary ?? hostSpecificBrief(platform);
  const reviewLabel = note?.status === "researched" ? `Source reviewed #${note.sequence}` : "Generated profile";
  const reviewDetail = note ? `Checked ${note.checkedAt}` : "Adapter + platform research data";
  const architectureAxes = hostArchitectureAxes(platform);
  const architectureEvidence = hostArchitectureEvidence(platform);
  const featureInventory = hostFeatureInventory(platform);
  const surfaceProfiles = hostSurfaceProfiles(platform);
  const factorCounts = factors.map((factor) => ({
    count: platforms.filter((candidate) => formFactorsOf(candidate.id).includes(factor))
      .length,
    factor,
    label: formFactorLabel[factor],
  }));
  const sourceReviewNote = hostSourceReviewNote(platform);

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <SkipLink targetId={CONTENT_ID} />
      <Nav />
      <main
        id={CONTENT_ID}
        tabIndex={-1}
        className="w-full flex-1 scroll-mt-24 outline-none"
        data-agent-architecture-page={platform.id}
        data-agent-form-factors={factors.join(" ")}
        data-agent-feature-inventory-count={featureInventory.length}
        data-agent-evidence-count={architectureEvidence.length}
        data-agent-source-reviewed={sourceReviewNote ? "true" : "false"}
        data-agent-source-reviewed-profile={researched ? "true" : "false"}
        data-agent-architecture-section-count={note?.sections.length ?? 0}
        data-agent-surface-profile-count={surfaceProfiles.length}
      >
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <nav className="flex flex-wrap gap-2" aria-label="Architecture navigation">
          <Link
            to="/agents"
            className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2.5 py-1 font-mono text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40"
          >
            <ArrowLeft aria-hidden="true" className="size-3.5" />
            Host archive
          </Link>
          <Link
            to="/coverage"
            className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2.5 py-1 font-mono text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40"
          >
            Coverage
          </Link>
        </nav>

        <header className="grid gap-5 border-b border-border pb-6 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Agent Architecture
            </p>
            <h1 className="mt-2 text-4xl font-semibold tracking-normal text-foreground sm:text-5xl">
              {platform.name}
            </h1>
            <p className="mt-3 max-w-3xl text-base leading-7 text-muted-foreground">
              {summary}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span
                className={cn(
                  "rounded border px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide",
                  researched
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                )}
              >
                {reviewLabel}
              </span>
              <span className="rounded border border-border bg-muted/30 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {reviewDetail}
              </span>
            </div>
          </div>
          {sourceUrl ? (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 font-mono text-xs font-semibold text-foreground transition-colors hover:border-foreground/40 hover:bg-foreground/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40"
            >
              Source
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          ) : null}
        </header>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <ArchitectureFact label="Run type">
            {factors.length > 0 ? factors.map((ff) => formFactorLabel[ff]).join(" + ") : "Unclassified"}
          </ArchitectureFact>
          <ArchitectureFact label="Adapter">
            <span className="inline-flex items-center gap-1.5">
              <span className={cn("size-2 rounded-full", paradigm.dot)} />
              {paradigm.label}
            </span>
          </ArchitectureFact>
          <ArchitectureFact label="Source">
            {source && "repo" in source ? `OSS · ${source.repo}` : "Closed / product homepage"}
          </ArchitectureFact>
          <ArchitectureFact label="Stars">
            {stars !== undefined ? `★ ${formatStars(stars)}` : "Frontier"}
          </ArchitectureFact>
        </section>

        <ArchiveContext platform={platform} factors={factors} factorCounts={factorCounts} />

        <HostSurfacePerspectives platform={platform} profiles={surfaceProfiles} />

        <ArchitectureEvidence note={note} platform={platform} />

        <HostArchitectureDiagram platform={platform} />

        <HostComponentDiagram platform={platform} />

        <HostSequenceFlowDiagram platform={platform} />

        <ArchitectureArchive axes={architectureAxes} />

        <SpecialFeatureInventory rows={featureInventory} />

        <SourceReviewNotes note={sourceReviewNote} sourceUrl={sourceUrl} />

        <ArchitectureEvidenceMap evidence={architectureEvidence} />

        <section className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <div className="rounded-lg border border-border p-5">
            <h2 className="text-lg font-semibold tracking-normal">Runtime Shape</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{paradigmNotes[platform.paradigm]}</p>
            <dl className="mt-4 grid gap-3 text-sm">
              <div>
                <dt className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  MCP registration
                </dt>
                <dd className="mt-1 text-foreground">
                  {platform.surfaces.mcp ? "Wired through this adapter" : "Not wired"}
                </dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Hook bridge
                </dt>
                <dd className="mt-1 text-foreground">
                  {platform.surfaces.hooks ? "Wired" : platform.hostNative.hooks ? "Native gap" : "No confirmed hook surface"}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-lg border border-border p-5">
            <h2 className="text-lg font-semibold tracking-normal">Connector Surfaces</h2>
            <div className="mt-3 grid gap-3 text-sm">
              <div>
                <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Static content
                </p>
                <p className="mt-1 leading-6 text-foreground">{staticSummary}</p>
              </div>
              <div>
                <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Runtime handlers
                </p>
                <p className="mt-1 leading-6 text-foreground">{handlerSummary}</p>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold tracking-normal">Surface Matrix</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Wired means agent-connector installs it now. Host native marks
                support we know about but have not wired yet.
              </p>
            </div>
          </div>
          <div className="mt-4 overflow-hidden rounded-lg border border-border">
            <div className="grid grid-cols-[1fr_auto] border-b border-border bg-muted/30 px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Surface</span>
              <span>Status</span>
            </div>
            {surfaceRows.map((row) => {
              const state = surfaceState(platform, row.key);
              const meta = stateMeta[state];
              return (
                <div
                  key={row.key}
                  className="grid grid-cols-[1fr_auto] gap-3 border-b border-border/60 px-3 py-3 last:border-b-0"
                >
                  <div>
                    <div className="text-sm font-medium text-foreground">{row.label}</div>
                    <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                      {row.group}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{meta.detail}</div>
                  </div>
                  <span
                    className={cn(
                      "h-fit rounded border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide",
                      meta.className,
                    )}
                  >
                    {meta.label}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      </div>
      </main>
      <Footer />
    </div>
  );
}

function ArchitectureFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 text-sm font-medium text-foreground">{children}</div>
    </div>
  );
}

function ArchiveContext({
  factorCounts,
  factors,
  platform,
}: {
  factorCounts: Array<{ count: number; factor: FormFactorId; label: string }>;
  factors: readonly FormFactorId[];
  platform: Platform;
}) {
  const factorSummary =
    factorCounts.length > 0
      ? factorCounts.map((item) => `${item.label}: ${item.count}`).join(" + ")
      : "Unclassified";

  return (
    <section
      className="rounded-lg border border-border p-5"
      data-agent-archive-context={platform.id}
      data-agent-archive-context-form-factors={factors.join(" ")}
      data-agent-archive-context-peer-counts={factorCounts
        .map((item) => `${item.factor}:${item.count}`)
        .join(" ")}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-normal">Archive Context</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            This page is one host entry inside the full architecture archive and
            keeps multi-surface products visible instead of collapsing them into
            a single run type.
          </p>
        </div>
        <Link
          to="/agents"
          className="inline-flex items-center gap-1.5 rounded border border-border bg-muted/20 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-foreground transition-colors hover:border-foreground/40 hover:bg-foreground/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40"
        >
          {platforms.length} host archive
        </Link>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <ArchitectureFact label="Host page">{platform.id}</ArchitectureFact>
        <ArchitectureFact label="Run cohort">{factorSummary}</ArchitectureFact>
        <ArchitectureFact label="Archive route">/agents</ArchitectureFact>
      </div>
    </section>
  );
}

function HostSurfacePerspectives({
  platform,
  profiles,
}: {
  platform: Platform;
  profiles: HostSurfaceProfile[];
}) {
  return (
    <section
      className="rounded-lg border border-border p-5"
      data-agent-surface-perspectives={profiles.length}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-normal">Host Surface Perspectives</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            The host is the primary architecture boundary. Each runnable surface
            below separates what the host owns from what agent-connector can
            safely install for {platform.name}.
          </p>
        </div>
        <span className="rounded border border-border bg-muted/30 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {profiles.length} surface {profiles.length === 1 ? "entry" : "entries"}
        </span>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {profiles.map((profile) => (
          <article
            key={`${platform.id}-${profile.factor}`}
            className="rounded-lg border border-border/80 bg-card/30 p-4"
            data-agent-surface-profile={platform.id}
            data-agent-surface-factor={profile.factor}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold tracking-normal text-foreground">
                {profile.label}
              </h3>
              <span className="rounded border border-border bg-muted/30 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {profile.factor}
              </span>
            </div>
            <dl className="mt-3 grid gap-3 text-sm leading-6">
              <div>
                <dt className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Host entry
                </dt>
                <dd className="mt-1 text-muted-foreground">{profile.entry}</dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Host owns
                </dt>
                <dd className="mt-1 text-muted-foreground">{profile.hostOwns}</dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Connector role
                </dt>
                <dd className="mt-1 text-muted-foreground">{profile.connectorRole}</dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Implementation consequence
                </dt>
                <dd className="mt-1 text-muted-foreground">
                  {profile.implementationConsequence}
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

function ArchitectureEvidence({
  note,
  platform,
}: {
  note: AgentArchitectureNote | undefined;
  platform: Platform;
}) {
  if (!note || note.status !== "researched") {
    return (
      <section className="rounded-lg border border-border p-5">
        <h2 className="text-lg font-semibold tracking-normal">Generated Architecture Profile</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {hostSpecificBrief(platform)}
        </p>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          This profile is derived from the adapter capability flags, form-factor
          metadata, hostNative coverage research, and the linked product source
          or homepage, and is rendered as the active architecture profile.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-normal">Verified Architecture</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Source-checked on {note.checkedAt}. These notes are intentionally
            separate from the generated surface matrix below.
          </p>
        </div>
        <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
          Sequence #{note.sequence}
        </span>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {note.sections.map((section) => (
          <article key={section.title} className="rounded-lg border border-border/70 bg-card/35 p-4">
            <h3 className="text-sm font-semibold tracking-normal text-foreground">
              {section.title}
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {section.body}
            </p>
            {section.bullets ? (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
                {section.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            ) : null}
          </article>
        ))}
      </div>

      {note.limits ? (
        <div className="mt-5 rounded-lg border border-border/70 bg-muted/25 p-4">
          <h3 className="text-sm font-semibold tracking-normal text-foreground">
            Known Limits
          </h3>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
            {note.limits.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5">
        <h3 className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Evidence checked
        </h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {note.sources.map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 font-mono text-xs font-medium text-foreground transition-colors hover:border-foreground/40 hover:bg-foreground/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40"
            >
              {source.label}
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

function HostArchitectureDiagram({ platform }: { platform: Platform }) {
  const nodes = hostDiagramNodes(platform);

  return (
    <section
      className="rounded-lg border border-border p-5"
      data-agent-architecture-diagram={platform.id}
      data-agent-architecture-diagram-nodes={nodes.length}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-normal">Architecture Diagram</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Host-specific flow for the {hostEntryPoint(platform)} surface.
          </p>
        </div>
        <span className="rounded border border-border bg-muted/30 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {platform.paradigm}
        </span>
      </div>
      <HostArchitectureFlowSvg platform={platform} />
      <ol className="mt-5 grid gap-0">
        {nodes.map((node, index) => (
          <li
            key={`${platform.id}-${node.label}`}
            className="grid grid-cols-[1.75rem_1fr] gap-3"
            data-agent-architecture-node={index + 1}
            data-agent-architecture-node-label={node.label}
            data-agent-architecture-node-tone={node.tone}
          >
            <div className="flex flex-col items-center">
              <span className="flex size-6 items-center justify-center rounded-full border border-border bg-card font-mono text-[10px] font-semibold text-muted-foreground">
                {index + 1}
              </span>
              {index < nodes.length - 1 ? (
                <span
                  className="my-1 min-h-5 flex-1 border-l border-border"
                  aria-hidden="true"
                  data-agent-architecture-edge={`${index + 1}-${index + 2}`}
                />
              ) : null}
            </div>
            <div className="pb-3">
              <div
                className={cn(
                  "rounded-md border p-3",
                  diagramToneClass(node.tone),
                )}
              >
                <div className="text-sm font-semibold leading-5 text-foreground">
                  {node.label}
                </div>
                <p className="mt-1 break-words text-sm leading-6 text-muted-foreground">
                  {node.detail}
                </p>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function HostArchitectureFlowSvg({
  platform,
}: {
  platform: Platform;
}) {
  const factors = formFactorsOf(platform.id)
    .map((factor) => formFactorLabel[factor])
    .join(" + ");
  const nativeShort = [
    platform.surfaces.mcp ? "MCP" : null,
    platform.surfaces.hooks ? "hooks" : null,
    platform.surfaces.commands || platform.surfaces.skills || platform.surfaces.subagents
      ? "content"
      : null,
    platform.surfaces.memory ? "memory" : null,
    platform.surfaces.statusline || platform.surfaces.actions ? "handlers" : null,
  ]
    .filter(Boolean)
    .join(" + ");
  const boundaryShort =
    platform.paradigm === "json-stdio"
      ? "stdio events"
      : platform.paradigm === "ts-plugin"
        ? "plugin bridge"
        : platform.surfaces.mcp
          ? "MCP client"
          : "static files";
  const userShort = [
    platform.surfaces.commands ? "cmds" : null,
    platform.surfaces.skills ? "skills" : null,
    platform.surfaces.subagents ? "agents" : null,
    platform.surfaces.memory ? "memory" : null,
    platform.surfaces.actions ? "actions" : null,
  ]
    .filter(Boolean)
    .join(" + ");
  const boxes = [
    { title: "Host surface", value: factors || "Unclassified", tone: "entry" },
    { title: "Runtime", value: platform.paradigm, tone: "runtime" },
    { title: "Native artifacts", value: nativeShort || "no writes", tone: "artifact" },
    { title: "Connector boundary", value: boundaryShort, tone: "adapter" },
    { title: "User surface", value: userShort || "MCP tools", tone: "surface" },
  ] as const;

  return (
    <div
      className="mt-5 rounded-lg border border-border/70 bg-muted/15 p-3"
      data-agent-architecture-svg={platform.id}
    >
      <svg
        role="img"
        aria-label={`${platform.name} host architecture flow`}
        viewBox="0 0 960 250"
        className="h-auto w-full text-foreground"
      >
        <defs>
          <marker
            id={`arrow-${platform.id}`}
            markerHeight="8"
            markerWidth="8"
            orient="auto"
            refX="7"
            refY="4"
          >
            <path d="M0,0 L8,4 L0,8 Z" className="fill-muted-foreground" />
          </marker>
        </defs>
        <text x="24" y="30" className="fill-muted-foreground text-[13px] font-semibold">
          Host-owned architecture flow
        </text>
        {boxes.map((box, index) => {
          const x = 24 + index * 184;
          const color = diagramSvgToneClass(box.tone);
          return (
            <g key={box.title}>
              {index > 0 ? (
                <line
                  x1={x - 28}
                  y1="110"
                  x2={x - 8}
                  y2="110"
                  className="stroke-muted-foreground"
                  markerEnd={`url(#arrow-${platform.id})`}
                  strokeWidth="1.5"
                />
              ) : null}
              <rect
                x={x}
                y="58"
                width="148"
                height="104"
                rx="10"
                className={color}
                strokeWidth="1.5"
              />
              <text x={x + 14} y="84" className="fill-foreground text-[12px] font-semibold">
                {box.title}
              </text>
              <text x={x + 14} y="112" className="fill-muted-foreground text-[11px]">
                {box.value}
              </text>
            </g>
          );
        })}
        <path
          d="M98 178 C180 222, 780 222, 874 178"
          fill="none"
          className="stroke-border"
          strokeDasharray="5 7"
          strokeWidth="1.5"
        />
        <text x="315" y="224" className="fill-muted-foreground text-[12px]">
          agent-connector writes only documented host artifacts; the host owns the agent loop.
        </text>
      </svg>
    </div>
  );
}

function ArchitectureArchive({ axes }: { axes: HostArchitectureAxis[] }) {
  return (
    <section>
      <h2 className="text-xl font-semibold tracking-normal">Architecture Archive</h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">
        The same five study axes are rendered for every host: runtime shape,
        hooks, MCP, memory, and host-only affordances.
      </p>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {axes.map((axis) => (
          <article key={axis.title} className="rounded-lg border border-border p-4">
            <h3 className="text-sm font-semibold tracking-normal text-foreground">
              {axis.title}
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {axis.body}
            </p>
            {axis.bullets ? (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
                {axis.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function SpecialFeatureInventory({ rows }: { rows: HostFeatureInventoryRow[] }) {
  return (
    <section data-agent-special-feature-inventory={rows.length}>
      <h2 className="text-xl font-semibold tracking-normal">Special Feature Inventory</h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">
        Host-specific capabilities separated from the generic surface matrix:
        lifecycle hooks, MCP registration, memory/rules, marketplace delivery,
        and UI or content affordances owned by the host.
      </p>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {rows.map((row) => (
          <article
            key={row.id}
            className="rounded-lg border border-border p-4"
            data-agent-feature-row={row.id}
            data-agent-feature-status={row.status}
            data-agent-feature-tone={row.tone}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h3 className="text-sm font-semibold tracking-normal text-foreground">
                {row.label}
              </h3>
              <span
                className={cn(
                  "rounded border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide",
                  featureToneClass(row.tone),
                )}
              >
                {row.status}
              </span>
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {row.detail}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}

function SourceReviewNotes({
  note,
  sourceUrl,
}: {
  note: HostSourceReviewNote | undefined;
  sourceUrl: string | undefined;
}) {
  if (!note) return null;

  return (
    <section
      className="rounded-lg border border-border p-5"
      data-agent-source-review="true"
      data-agent-source-review-checked-at={note.checkedAt}
      data-agent-source-review-findings={note.findings.length}
      data-agent-source-review-source-url={sourceUrl ?? ""}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-normal">Source Review Notes</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Latest source pass for host-specific architecture details. This is
            separate from generated adapter coverage and local drift guards.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <span className="rounded border border-sky-500/35 bg-sky-500/10 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
            Checked {note.checkedAt}
          </span>
          {sourceUrl ? (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded border border-border bg-muted/20 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-foreground transition-colors hover:border-foreground/40 hover:bg-foreground/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40"
            >
              Open review source
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          ) : null}
        </div>
      </div>
      <div className="mt-4 rounded-lg border border-border/70 bg-muted/20 p-4">
        <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {note.source}
        </div>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
          {note.findings.map((finding) => (
            <li key={finding}>{finding}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function featureToneClass(tone: HostFeatureInventoryRow["tone"]) {
  if (tone === "supported") {
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (tone === "gap") {
    return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (tone === "native") {
    return "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }
  return "border-border bg-muted/35 text-muted-foreground";
}

function ArchitectureEvidenceMap({
  evidence,
}: {
  evidence: HostArchitectureEvidence[];
}) {
  return (
    <section data-agent-evidence-map={evidence.length}>
      <h2 className="text-xl font-semibold tracking-normal">Evidence Map</h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">
        Each host page ties public source evidence to the local adapter and
        drift guards that keep the rendered archive aligned with code.
      </p>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {evidence.map((item) => (
          <article
            key={`${item.kind}-${item.href ?? item.path ?? item.label}`}
            className="rounded-lg border border-border p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="break-words text-sm font-semibold tracking-normal text-foreground">
                  {item.label}
                </h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {item.detail}
                </p>
              </div>
              <span
                className={cn(
                  "rounded border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide",
                  item.kind === "external"
                    ? "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                    : "border-border bg-muted/30 text-muted-foreground",
                )}
              >
                {item.kind}
              </span>
            </div>
            {item.href ? (
              <a
                href={item.href}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 font-mono text-xs font-medium text-foreground transition-colors hover:border-foreground/40 hover:bg-foreground/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40"
              >
                Open source
                <ExternalLink aria-hidden="true" className="size-3" />
              </a>
            ) : null}
            {item.path ? (
              <div className="mt-3 break-words rounded border border-border bg-muted/25 px-2 py-1.5 font-mono text-xs text-muted-foreground">
                {item.path}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function diagramToneClass(tone: HostArchitectureNode["tone"]) {
  if (tone === "entry") return "border-sky-500/30 bg-sky-500/[0.07]";
  if (tone === "adapter") return "border-violet-500/25 bg-violet-500/[0.06]";
  if (tone === "artifact") return "border-amber-500/30 bg-amber-500/[0.07]";
  if (tone === "runtime") return "border-emerald-500/30 bg-emerald-500/[0.07]";
  if (tone === "surface") return "border-cyan-500/30 bg-cyan-500/[0.07]";
  return "border-rose-500/25 bg-rose-500/[0.06]";
}

function diagramSvgToneClass(tone: HostArchitectureNode["tone"]) {
  if (tone === "entry") return "fill-sky-500/10 stroke-sky-500/35";
  if (tone === "adapter") return "fill-violet-500/10 stroke-violet-500/35";
  if (tone === "artifact") return "fill-amber-500/10 stroke-amber-500/35";
  if (tone === "runtime") return "fill-emerald-500/10 stroke-emerald-500/35";
  if (tone === "surface") return "fill-cyan-500/10 stroke-cyan-500/35";
  return "fill-rose-500/10 stroke-rose-500/35";
}
