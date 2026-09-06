import * as React from "react";
import {
  ArrowRight,
  Boxes,
  ExternalLink,
  GitBranch,
  Network,
  Terminal,
} from "lucide-react";
import { Link } from "react-router-dom";

import { setMetaDescription } from "@/components/docs/meta";
import { Footer } from "@/components/sections/Footer";
import { Nav } from "@/components/sections/Nav";
import { SkipLink } from "@/components/ui/skip-link";
import {
  gapRows,
  hostFeatureInventory,
  hostSourceReviewNote,
  marketplaceDriverIds,
  wiredRows,
  type HostFeatureInventoryRow,
} from "@/components/agents/host-architecture-model";
import { cn } from "@/lib/utils";
import {
  formFactorsOf,
  formFactorShortLabels,
  handlerChips,
  hostLinkUrl,
  paradigms,
  platforms,
  surfaceChips,
  surfaceState,
  type ParadigmId,
  type Platform,
  type PlatformSurfaces,
  type SurfaceState,
} from "@/data";

const CONTENT_ID = "study-content";

const STUDY_DESCRIPTION =
  "A source-checked host architecture archive of every CLI, desktop, and extension surface supported by agent-connector, combining external docs/source review with adapter-code analysis.";

type SurfaceRow = {
  key: keyof PlatformSurfaces;
  label: string;
  group: "content" | "runtime";
};

const surfaceRows: SurfaceRow[] = [
  ...surfaceChips.map((chip) => ({
    key: chip.key,
    label: chip.full,
    group: "content" as const,
  })),
  ...handlerChips.map((chip) => ({
    key: chip.key,
    label: chip.full,
    group: "runtime" as const,
  })),
];

const studyPlatforms = platforms;
const sourceReviewDates = Array.from(
  new Set(
    studyPlatforms
      .map((platform) => hostSourceReviewNote(platform)?.checkedAt)
      .filter((date): date is string => Boolean(date)),
  ),
).sort();
const sourceReviewDateLabel =
  sourceReviewDates.length > 1
    ? `${sourceReviewDates[0]} to ${sourceReviewDates[sourceReviewDates.length - 1]}`
    : sourceReviewDates[0] ?? "unverified";
const formFactorCounts = {
  cli: studyPlatforms.filter((platform) => formFactorsOf(platform.id).includes("cli"))
    .length,
  desktop: studyPlatforms.filter((platform) =>
    formFactorsOf(platform.id).includes("desktop"),
  ).length,
  extension: studyPlatforms.filter((platform) =>
    formFactorsOf(platform.id).includes("extension"),
  ).length,
};

const deepStudySources = [
  {
    label: "Claude Code hooks and MCP",
    url: "https://code.claude.com/docs/en/hooks",
  },
  {
    label: "Claude Code plugin MCP",
    url: "https://code.claude.com/docs/en/mcp",
  },
  {
    label: "OpenAI Codex docs and hooks",
    url: "https://developers.openai.com/codex/hooks",
  },
  {
    label: "openai/codex source",
    url: "https://github.com/openai/codex",
  },
  {
    label: "google-gemini/gemini-cli",
    url: "https://github.com/google-gemini/gemini-cli",
  },
  {
    label: "anomalyco/opencode",
    url: "https://github.com/anomalyco/opencode",
  },
  {
    label: "Amazon Q Developer CLI",
    url: "https://github.com/aws/amazon-q-developer-cli",
  },
  {
    label: "Warp MCP docs",
    url: "https://docs.warp.dev/agent-platform/capabilities/mcp/",
  },
  {
    label: "NousResearch/hermes-agent",
    url: "https://github.com/NousResearch/hermes-agent",
  },
  {
    label: "QwenLM/qwen-code",
    url: "https://github.com/QwenLM/qwen-code",
  },
  {
    label: "mistralai/mistral-vibe",
    url: "https://github.com/mistralai/mistral-vibe",
  },
  {
    label: "OpenInterpreter/openinterpreter",
    url: "https://github.com/OpenInterpreter/open-interpreter",
  },
  {
    label: "Cursor public tracker",
    url: "https://github.com/cursor/cursor",
  },
  {
    label: "Zed source",
    url: "https://github.com/zed-industries/zed",
  },
  {
    label: "Cline source",
    url: "https://github.com/cline/cline",
  },
  {
    label: "GitHub Copilot platform",
    url: "https://github.com/features/copilot",
  },
  {
    label: "Devin Desktop / Windsurf",
    url: "https://devin.ai/desktop",
  },
];

const readerGuide = [
  {
    title: "Hooks",
    detail:
      "Runtime interception is not one feature. JSON-stdio hosts spawn a command with event JSON; ts-plugin hosts load a generated module; mcp-only hosts expose no installable lifecycle boundary.",
  },
  {
    title: "MCP",
    detail:
      "MCP is portable at the protocol level but not at the file level. Each adapter renders the host's root key, transport fields, scope, and enablement dialect.",
  },
  {
    title: "Memory",
    detail:
      "Memory means writing managed blocks into the rules file the host actually reads. These files are user-authored, so ownership markers and non-clobber behavior matter.",
  },
  {
    title: "Marketplace",
    detail:
      "Marketplace/plugin delivery is a distribution path, separate from runtime surfaces. A host can have hooks without a drivable marketplace, or marketplace install without extra runtime power.",
  },
  {
    title: "Host-only affordances",
    detail:
      "Status lines, actions, subagents, skills, and cloud-managed prompts are host-specific. The archive calls out when they are wired, host-native gaps, or intentionally left unwired.",
  },
];

const codeEvidence = [
  {
    label: "Adapter SPI",
    path: "src/adapters/spi.ts",
    detail: "defines install-time rendering, runtime dispatch, content surfaces, statusline, actions, and diagnostics.",
  },
  {
    label: "Adapter registry",
    path: "src/adapters/registry.ts",
    detail: "lazy-loads every adapter and keeps fork/parent detection order explicit.",
  },
  {
    label: "Platform data",
    path: "site/src/platform-data.ts",
    detail: "pins form factor, host-native surfaces, public source links, and rank metadata.",
  },
  {
    label: "Drift guards",
    path: "tests/docs/platform-drift.test.ts",
    detail: "asserts site surface data against loaded adapter capabilities.",
  },
];

type ParadigmStudy = {
  id: ParadigmId;
  diagramTitle: string;
  summary: string;
  steps: string[];
  codeFiles: string[];
  risk: string;
};

type ArchiveAxisId = "hooks" | "mcp" | "memory" | "marketplace" | "affordances";

type ArchiveAxisStudy = {
  id: ArchiveAxisId;
  title: string;
  summary: string;
  steps: string[];
  codeFiles: string[];
  risk: string;
};

const archiveAxisStudies: ArchiveAxisStudy[] = [
  {
    id: "hooks",
    title: "Lifecycle hooks",
    summary:
      "Where the host lets outside code observe or change the agent loop. JSON-stdio hosts launch commands; ts-plugin hosts load generated modules; mcp-only hosts have no confirmed hook boundary.",
    steps: [
      "Connector declares events",
      "Adapter renders registration",
      "Host fires lifecycle event",
      "Home-bin runtime normalizes JSON",
      "Adapter returns native reply",
    ],
    codeFiles: [
      "src/adapters/spi.ts",
      "src/runtime/hook-entrypoint.ts",
      "src/core/ts-plugin-bridge.ts",
    ],
    risk:
      "Hook support is event-shape support, not just file placement. The archive therefore separates host-native hooks from currently wired adapter hooks.",
  },
  {
    id: "mcp",
    title: "MCP registration",
    summary:
      "Tool access is protocol-level MCP, but every host persists server definitions in a different file shape, scope, root key, and transport dialect.",
    steps: [
      "Connector declares ServerDef",
      "Adapter chooses native config path",
      "Server entry is rendered",
      "Host MCP client starts server",
      "Tool calls flow through host",
    ],
    codeFiles: [
      "src/adapters/spi.ts",
      "src/adapters/base.ts",
      "tests/contracts/root-key-malformed.contract.test.ts",
    ],
    risk:
      "A valid MCP server can still be misinstalled if the host expects a table, array, object map, YAML document, or nested key that differs from another host.",
  },
  {
    id: "memory",
    title: "Memory and rules",
    summary:
      "Host memory is usually a user-authored rules file. agent-connector must write only its managed block, preserve user text, and uninstall cleanly.",
    steps: [
      "Connector supplies guidance",
      "Adapter resolves memory target",
      "Managed block is inserted",
      "Host loads rules into context",
      "Uninstall removes only owned bytes",
    ],
    codeFiles: [
      "src/adapters/spi.ts",
      "src/adapters/base.ts",
      "src/core/managed-block.ts",
    ],
    risk:
      "Memory files are shared authoring surfaces, so forced overwrites, hash drift, and project-vs-user precedence matter more than on generated files.",
  },
  {
    id: "marketplace",
    title: "Marketplace and plugin delivery",
    summary:
      "Marketplace install is a distribution path, not a runtime capability. It stages a package, drives the host's installer where available, and probes host state.",
    steps: [
      "Package format is emitted",
      "Bundle is staged",
      "Host install command is driven",
      "Host state is probed",
      "Catalog or staged files are cleaned",
    ],
    codeFiles: [
      "src/core/marketplace-drivers/registry.ts",
      "src/core/marketplace-drivers/types.ts",
      "src/core/package.ts",
    ],
    risk:
      "A host can have hooks without a drivable marketplace, and a bundle format can exist before the host exposes a reliable install/update/uninstall CLI.",
  },
  {
    id: "affordances",
    title: "Host-specific affordances",
    summary:
      "Commands, skills, subagents, statuslines, and actions are user-facing host features. They are intentionally tracked separately from hooks and MCP.",
    steps: [
      "Connector declares content/action",
      "Adapter maps to native file or command",
      "Host UI exposes the affordance",
      "Capability chip records support",
      "Gap chip stays visible if unwired",
    ],
    codeFiles: [
      "src/adapters/spi.ts",
      "site/src/platform-data.ts",
      "tests/docs/platform-drift.test.ts",
    ],
    risk:
      "Some hosts expose affordances only through cloud UI, inline config, built-ins, or experimental APIs. Those stay marked as gaps until there is a writable contract.",
  },
];

const paradigmStudies: Record<ParadigmId, ParadigmStudy> = {
  "json-stdio": {
    id: "json-stdio",
    diagramTitle: "JSON stdio hook bridge",
    summary:
      "The host owns the agent loop and launches a command for lifecycle events. agent-connector receives host JSON on stdin, normalizes the event, runs the connector handler, and writes the host-native reply envelope.",
    steps: [
      "Host CLI reads native config",
      "Host launches home-bin hook",
      "Adapter parses JSON stdin",
      "Connector handler runs",
      "Adapter formats reply",
    ],
    codeFiles: [
      "src/adapters/claude-code/index.ts",
      "src/adapters/codex/index.ts",
      "src/runtime/hook-entrypoint.ts",
    ],
    risk:
      "Each host has different event names and response envelopes, so adapter tests must prove parse/format behavior rather than only checking that files exist.",
  },
  "ts-plugin": {
    id: "ts-plugin",
    diagramTitle: "Generated TypeScript plugin bridge",
    summary:
      "The host loads a generated plugin module. That bridge stays tiny and shells out to the same stable home binary instead of importing arbitrary connector code into the host process.",
    steps: [
      "Host scans plugin directory",
      "Generated plugin is loaded",
      "Plugin maps native event",
      "Home-bin hook is invoked",
      "Native object is mutated or returned",
    ],
    codeFiles: [
      "src/adapters/opencode/index.ts",
      "src/core/ts-plugin-bridge.ts",
      "src/adapters/openclaw/index.ts",
    ],
    risk:
      "Plugin hosts can mutate objects in-process; the bridge must avoid version skew, cwd leaks, and dependency coupling by keeping connector code outside the host runtime.",
  },
  "mcp-only": {
    id: "mcp-only",
    diagramTitle: "MCP-only host integration",
    summary:
      "The host exposes server registration and selected content surfaces, but no lifecycle hook bridge. agent-connector installs what the host can read and reports hook gaps honestly.",
    steps: [
      "Connector declares MCP server",
      "Adapter renders native config",
      "Host discovers MCP server",
      "Model calls tools through host",
      "Hooks stay unavailable",
    ],
    codeFiles: [
      "src/adapters/warp/index.ts",
      "src/adapters/open-interpreter/index.ts",
      "src/adapters/junie/index.ts",
    ],
    risk:
      "A host can be powerful without hooks. The page keeps MCP/content support separate from runtime interception so gaps are visible instead of implied away.",
  },
};

function countByParadigm(id: ParadigmId) {
  return studyPlatforms.filter((platform) => platform.paradigm === id).length;
}

function stateClass(state: SurfaceState) {
  if (state === "supported") {
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (state === "host-gap") {
    return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "border-border bg-muted/35 text-muted-foreground";
}

function countSupported(key: keyof PlatformSurfaces) {
  return studyPlatforms.filter((platform) => platform.surfaces[key]).length;
}

function countNative(key: keyof PlatformSurfaces) {
  return studyPlatforms.filter((platform) => platform.hostNative[key]).length;
}

function countGaps(key: keyof PlatformSurfaces) {
  return studyPlatforms.filter((platform) => surfaceState(platform, key) === "host-gap")
    .length;
}

const allHostSourceReviews = studyPlatforms
  .map((platform) => {
    const note = hostSourceReviewNote(platform);
    const url = hostLinkUrl(platform.id);
    return note && url
      ? {
          checkedAt: note.checkedAt,
          findings: note.findings.length,
          id: platform.id,
          label: platform.name,
          source: note.source,
          url,
        }
      : null;
  })
  .filter(
    (
      source,
    ): source is {
      checkedAt: string;
      findings: number;
      id: string;
      label: string;
      source: string;
      url: string;
    } => Boolean(source),
  );

function axisStats(id: ArchiveAxisId) {
  if (id === "marketplace") {
    const drivable = studyPlatforms.filter((platform) =>
      marketplaceDriverIds.has(platform.id),
    ).length;
    return {
      primary: `${drivable}/${studyPlatforms.length}`,
      label: "drivable",
      secondary: `${studyPlatforms.length - drivable} direct/manual`,
    };
  }

  if (id === "affordances") {
    const statusline = countSupported("statusline");
    const actions = countSupported("actions");
    const content = new Set(
      studyPlatforms
        .filter(
          (platform) =>
            platform.surfaces.commands ||
            platform.surfaces.skills ||
            platform.surfaces.subagents,
        )
        .map((platform) => platform.id),
    ).size;
    return {
      primary: `${content}/${studyPlatforms.length}`,
      label: "content hosts",
      secondary: `${statusline} statusline · ${actions} actions`,
    };
  }

  const key = id;
  return {
    primary: `${countSupported(key)}/${countNative(key)}`,
    label: "wired/native",
    secondary:
      countGaps(key) > 0 ? `${countGaps(key)} visible gaps` : "no visible gaps",
  };
}

export function AgentHostArchitectureStudyPage() {
  React.useEffect(() => {
    document.title = "Agents — host architecture archive";
    setMetaDescription(STUDY_DESCRIPTION);
    window.scrollTo({ top: 0 });
  }, []);

  const totalWired = studyPlatforms.reduce(
    (sum, platform) => sum + wiredRows(platform).length,
    0,
  );
  const totalGaps = studyPlatforms.reduce(
    (sum, platform) => sum + gapRows(platform).length,
    0,
  );
  const marketplaceCount = studyPlatforms.filter((platform) =>
    marketplaceDriverIds.has(platform.id),
  ).length;
  const memoryCount = studyPlatforms.filter((platform) => platform.surfaces.memory).length;
  const surfaceEntryCount = studyPlatforms.reduce(
    (sum, platform) => sum + formFactorsOf(platform.id).length,
    0,
  );

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <SkipLink targetId={CONTENT_ID} />
      <Nav />
      <main id={CONTENT_ID} tabIndex={-1} className="flex-1 scroll-mt-24 outline-none">
        <section className="border-b border-border">
          <div className="mx-auto max-w-6xl px-6 py-14 sm:py-18">
            <div className="max-w-3xl">
              <p className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Host archive
              </p>
              <h1 className="mt-3 text-balance text-4xl font-semibold tracking-normal sm:text-5xl">
                Agent host architecture archive
              </h1>
              <p className="mt-4 text-pretty text-base leading-7 text-muted-foreground">
                Full host-surface analysis across CLI, desktop, and extension
                form factors. The host is the primary architecture boundary;
                current external docs and source links checked {sourceReviewDateLabel}{" "}
                are reconciled with the local adapter registry, SPI contract,
                and drift-tested capability matrix.
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                <StudyBadge>{studyPlatforms.length} host adapters</StudyBadge>
                <StudyBadge>{surfaceEntryCount} host-surface entries</StudyBadge>
                <StudyBadge>{formFactorCounts.cli} CLI</StudyBadge>
                <StudyBadge>{formFactorCounts.desktop} Desktop</StudyBadge>
                <StudyBadge>{formFactorCounts.extension} Extension</StudyBadge>
                {paradigms.map((paradigm) => (
                  <StudyBadge key={paradigm.id}>
                    {countByParadigm(paradigm.id)} {paradigm.label}
                  </StudyBadge>
                ))}
                <StudyBadge>{totalWired} wired surfaces</StudyBadge>
                <StudyBadge>{totalGaps} visible gaps</StudyBadge>
                <StudyBadge>{marketplaceCount} marketplace-drivable</StudyBadge>
                <StudyBadge>{memoryCount} memory-wired</StudyBadge>
              </div>
            </div>
          </div>
        </section>

        <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-10">
          <section>
            <SectionTitle
              eyebrow="System map"
              title="What agent-connector owns vs what the host owns"
              description="The installer writes native files; the host still owns the agent loop, approval UI, model context, and MCP client. Runtime hooks only exist on json-stdio and ts-plugin hosts."
            />
            <ArchitectureOverviewDiagram />
          </section>

          <section>
            <SectionTitle
              eyebrow="Archive map"
              title="Five architecture axes to study per host"
              description="This map is the archive's reading order. It keeps runtime interception, tool registration, persisted memory, plugin delivery, and UI affordances separate so implementation work can target the right layer."
            />
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              {archiveAxisStudies.map((study) => (
                <ArchiveAxisPanel key={study.id} study={study} />
              ))}
            </div>
          </section>

          <section>
            <SectionTitle
              eyebrow="Reader guide"
              title="How to read this archive"
              description="The page is meant for people studying host architecture, not just checking support. It separates runtime hooks, MCP configuration, memory files, marketplace delivery, and host-only affordances."
            />
            <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              {readerGuide.map((item) => (
                <ArchiveGuideCard key={item.title} title={item.title}>
                  {item.detail}
                </ArchiveGuideCard>
              ))}
            </div>
          </section>

          <section>
            <SectionTitle
              eyebrow="Archive assurance"
              title="What this archive covers now"
              description="These checks summarize the current archive shape before you drill into host cards or individual pages."
            />
            <ArchiveAssurancePanel />
          </section>

          <section>
            <SectionTitle
              eyebrow="Paradigms"
              title="The three host runtime shapes"
              description="These diagrams are derived from the local adapter SPI and representative implementations across CLI, desktop, and extension hosts, then cross-checked against current host docs or source where the host publishes them."
            />
            <div className="mt-5 grid gap-4 lg:grid-cols-3">
              {paradigms.map((paradigm) => {
                const study = paradigmStudies[paradigm.id];
                const hosts = studyPlatforms.filter((p) => p.paradigm === paradigm.id);
                return (
                  <ParadigmPanel
                    key={paradigm.id}
                    dot={paradigm.dot}
                    study={study}
                    hostCount={hosts.length}
                    hostNames={hosts.map((host) => host.name)}
                  />
                );
              })}
            </div>
          </section>

          <section>
            <SectionTitle
              eyebrow="Code evidence"
              title="Local code paths that define the architecture"
              description="This page intentionally treats code as primary evidence for what agent-connector actually installs today."
            />
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {codeEvidence.map((item) => (
                <div key={item.path} className="rounded-lg border border-border p-4">
                  <div className="flex items-start gap-3">
                    <GitBranch className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">{item.label}</h3>
                      <p className="mt-1 font-mono text-xs text-foreground">{item.path}</p>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        {item.detail}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <SectionTitle
              eyebrow="Host matrix"
              title="All agent host architecture cards"
              description="Each card now includes a per-host architecture diagram plus archive notes for hooks, MCP, memory, marketplace delivery, and host-specific affordances."
            />
            <HostArchitectureLedger />
            <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {studyPlatforms.map((platform) => (
                <HostCard key={platform.id} platform={platform} />
              ))}
            </div>
          </section>

          <section>
            <SectionTitle
              eyebrow="External evidence"
              title="Source refresh used for this study"
              description="Deep references are the architecture-specific docs reviewed for the page. The ledger records every host source, source-review date, and finding count used by the matrix."
            />
            <div className="mt-5 flex flex-wrap gap-2">
              {deepStudySources.map((source) => (
                <a
                  key={source.url}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 font-mono text-xs font-medium text-foreground transition-colors hover:border-foreground/40 hover:bg-foreground/[0.04]"
                >
                  {source.label}
                  <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              ))}
            </div>
            <div
              className="mt-5 rounded-lg border border-border bg-card/35 p-4"
              data-host-source-review-ledger={allHostSourceReviews.length}
            >
              <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Source review ledger
              </p>
              <div className="mt-3 divide-y divide-border/70 overflow-hidden rounded-md border border-border/70">
                {allHostSourceReviews.map((source) => (
                  <div
                    key={source.id}
                    className="grid gap-2 bg-background/70 p-3 text-xs md:grid-cols-[minmax(8rem,1fr)_minmax(9rem,1.2fr)_auto_auto]"
                    data-host-source-review-row={source.id}
                    data-host-source-review-checked-at={source.checkedAt}
                    data-host-source-review-findings={source.findings}
                  >
                    <Link
                      to={`/agents/${source.id}`}
                      className="min-w-0 break-words font-semibold text-foreground underline-offset-4 hover:underline"
                    >
                      {source.label}
                    </Link>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-w-0 items-center gap-1.5 text-foreground underline-offset-4 hover:underline"
                    >
                      <span className="truncate">{source.source}</span>
                      <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                    </a>
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {source.checkedAt}
                    </span>
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {source.findings} findings
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function ArchiveGuideCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <article className="min-w-0 rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{children}</p>
    </article>
  );
}

function ArchiveAxisPanel({ study }: { study: ArchiveAxisStudy }) {
  const stats = axisStats(study.id);

  return (
    <article className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold tracking-normal text-foreground">
            {study.title}
          </h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{study.summary}</p>
        </div>
        <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-right">
          <div className="font-mono text-sm font-semibold text-foreground">
            {stats.primary}
          </div>
          <div className="mt-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            {stats.label}
          </div>
          <div className="mt-1 text-[10px] leading-4 text-muted-foreground">
            {stats.secondary}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-border/70 bg-muted/20 p-3">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Flow diagram
        </p>
        <ol className="mt-3 grid gap-2 sm:grid-cols-5">
          {study.steps.map((step, index) => (
            <li key={step} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="min-h-16 rounded-md border border-border bg-background/70 p-2">
                <div className="flex items-center gap-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[10px] text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="text-xs font-medium leading-5 text-foreground">
                    {step}
                  </span>
                </div>
              </div>
              {index < study.steps.length - 1 ? (
                <ArrowRight
                  className="hidden size-4 text-muted-foreground sm:block"
                  aria-hidden="true"
                />
              ) : null}
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-[1fr_1.2fr]">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Code evidence
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {study.codeFiles.map((file) => (
              <span
                key={file}
                className="rounded border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {file}
              </span>
            ))}
          </div>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{study.risk}</p>
      </div>
    </article>
  );
}

function SectionTitle({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="max-w-3xl">
      <p className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {eyebrow}
      </p>
      <h2 className="mt-2 text-2xl font-semibold tracking-normal sm:text-3xl">
        {title}
      </h2>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  );
}

function StudyBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-border bg-card/60 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

function ArchiveAssurancePanel() {
  const sourceChecked = studyPlatforms.filter((platform) =>
    hostSourceReviewNote(platform),
  ).length;
  const featureInventoried = studyPlatforms.filter(
    (platform) => hostFeatureInventory(platform).length === 5,
  ).length;
  const multiSurfaceHosts = studyPlatforms.filter(
    (platform) => formFactorsOf(platform.id).length > 1,
  ).length;

  const rows = [
    {
      label: "Host scope",
      value: `${studyPlatforms.length} hosts`,
      detail:
        "Every platform entry feeds the study cards, ledger rows, detail routes, and per-host diagrams.",
    },
    {
      label: "Run type split",
      value: `${formFactorCounts.cli} CLI / ${formFactorCounts.desktop} Desktop / ${formFactorCounts.extension} Ext`,
      detail:
        multiSurfaceHosts > 0
          ? `${multiSurfaceHosts} host keeps multiple run surfaces visible instead of collapsing to one label.`
          : "Each host has one visible run surface label.",
    },
    {
      label: "Source review",
      value: `${sourceChecked}/${studyPlatforms.length} checked`,
      detail:
        "Each checked host links to an external source or product page and renders source review notes on its detail page.",
    },
    {
      label: "Feature inventory",
      value: `${featureInventoried}/${studyPlatforms.length} complete`,
      detail:
        "Each host inventory separates hooks, MCP, memory, marketplace delivery, and host-only affordances.",
    },
  ];

  return (
    <div
      className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4"
      data-archive-assurance={studyPlatforms.length}
      data-archive-source-checks={sourceChecked}
      data-archive-feature-inventories={featureInventoried}
    >
      {rows.map((row) => (
        <article key={row.label} className="rounded-lg border border-border p-4">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {row.label}
          </p>
          <p className="mt-2 text-xl font-semibold tracking-normal text-foreground">
            {row.value}
          </p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {row.detail}
          </p>
        </article>
      ))}
    </div>
  );
}

function ArchitectureOverviewDiagram() {
  const steps = [
    { icon: Boxes, title: "Connector package", detail: "defineConnector declares server, hooks, commands, skills, subagents, memory, statusline, and actions." },
    { icon: GitBranch, title: "Adapter registry", detail: "The installer resolves the target host and loads exactly one adapter implementation." },
    { icon: Network, title: "Native host files", detail: "The adapter renders MCP config, hook/plugin registration, and content files in host-native dialects." },
    { icon: Terminal, title: "Host runtime", detail: "The CLI owns model context, approvals, MCP calls, and any lifecycle event that can trigger a hook." },
  ];

  return (
    <div className="mt-5 rounded-lg border border-border bg-card/35 p-4">
      <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] lg:items-stretch">
        {steps.map((step, index) => (
          <React.Fragment key={step.title}>
            <DiagramStep {...step} />
            {index < steps.length - 1 ? <DiagramArrow /> : null}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function DiagramStep({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof Boxes;
  title: string;
  detail: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-background/70 p-4">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}

function DiagramArrow() {
  return (
    <div className="flex items-center justify-center text-muted-foreground">
      <ArrowRight className="hidden size-5 lg:block" aria-hidden="true" />
      <div className="h-5 border-l border-border lg:hidden" aria-hidden="true" />
    </div>
  );
}

function ParadigmPanel({
  dot,
  study,
  hostCount,
  hostNames,
}: {
  dot: string;
  study: ParadigmStudy;
  hostCount: number;
  hostNames: string[];
}) {
  return (
    <article className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={cn("size-2.5 rounded-full", dot)} aria-hidden="true" />
          <h3 className="text-base font-semibold tracking-normal">{study.id}</h3>
        </div>
        <span className="rounded border border-border bg-muted/30 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {hostCount} CLI
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{study.summary}</p>
      <div className="mt-4 rounded-lg border border-border/70 bg-muted/20 p-3">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {study.diagramTitle}
        </p>
        <ol className="mt-3 grid gap-2">
          {study.steps.map((step, index) => (
            <li key={step} className="grid grid-cols-[auto_1fr] gap-2 text-xs leading-5">
              <span className="flex size-5 items-center justify-center rounded-full border border-border bg-background font-mono text-[10px] text-muted-foreground">
                {index + 1}
              </span>
              <span className="text-foreground">{step}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="mt-4">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Code path examples
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {study.codeFiles.map((file) => (
            <span
              key={file}
              className="rounded border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {file}
            </span>
          ))}
        </div>
      </div>
      <p className="mt-4 text-xs leading-5 text-muted-foreground">{study.risk}</p>
      <div className="mt-4 border-t border-border pt-3">
        <p className="text-xs leading-5 text-muted-foreground">
          Hosts: {hostNames.join(", ")}
        </p>
      </div>
    </article>
  );
}

function HostArchitectureLedger() {
  return (
    <div
      className="mt-5 grid gap-2"
      data-host-architecture-ledger={studyPlatforms.length}
    >
      {studyPlatforms.map((platform) => (
        <HostArchitectureLedgerRow key={platform.id} platform={platform} />
      ))}
    </div>
  );
}

function HostArchitectureLedgerRow({ platform }: { platform: Platform }) {
  const inventory = hostFeatureInventory(platform);
  return (
    <article
      className="rounded-lg border border-border bg-card/25 p-3 transition-colors hover:border-foreground/30 hover:bg-foreground/[0.02]"
      data-host-architecture-ledger-row={platform.id}
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(9rem,1.25fr)_minmax(7rem,0.85fr)_repeat(5,minmax(0,1fr))_auto] lg:items-start">
        <div className="min-w-0">
          <Link
            to={`/agents/${platform.id}`}
            className="break-words text-sm font-semibold text-foreground underline-offset-4 hover:underline"
          >
            {platform.name}
          </Link>
          <p className="mt-1 break-all font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {platform.id}
          </p>
        </div>
        <div className="min-w-0">
          <LedgerLabel>Run type</LedgerLabel>
          <div className="mt-1 flex flex-wrap gap-1">
            {formFactorShortLabels(platform.id).map((label) => (
              <span
                key={label}
                className="rounded border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>
        </div>
        {inventory.map((row) => (
          <LedgerFeature key={row.id} row={row} />
        ))}
        <Link
          to={`/agents/${platform.id}`}
          className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-foreground transition-colors hover:border-foreground/40 hover:bg-foreground/[0.04] lg:justify-self-end"
          aria-label={`Open ${platform.name} architecture detail`}
          data-host-architecture-detail-link={platform.id}
        >
          Detail
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}

function LedgerFeature({ row }: { row: HostFeatureInventoryRow }) {
  return (
    <div className="min-w-0">
      <LedgerLabel>{row.label}</LedgerLabel>
      <span
        className={cn(
          "mt-1 inline-flex max-w-full rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide",
          featureInventoryToneClass(row.tone),
        )}
      >
        <span className="truncate">{row.status}</span>
      </span>
    </div>
  );
}

function LedgerLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

function featureInventoryToneClass(tone: HostFeatureInventoryRow["tone"]) {
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

function HostCard({ platform }: { platform: Platform }) {
  const paradigm = paradigms.find((item) => item.id === platform.paradigm)!;

  return (
    <article className="min-w-0 rounded-lg border border-border p-4 transition-colors hover:border-foreground/30 hover:bg-foreground/[0.02]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold text-foreground">
            {platform.name}
          </h3>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <span className="rounded border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              {platform.id}
            </span>
            <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", paradigm.dot)} aria-hidden="true" />
              {platform.paradigm}
            </span>
            {formFactorShortLabels(platform.id).map((label) => (
              <span
                key={label}
                className="rounded border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>
        </div>
        <Link
          to={`/agents/${platform.id}`}
          className="shrink-0 rounded-md border border-border px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-foreground transition-colors hover:border-foreground/40 hover:bg-foreground/[0.04]"
        >
          Detail
        </Link>
      </div>

      <p className="mt-4 text-sm leading-6 text-muted-foreground">
        Open the detail page for adapter path, source review, wired/native
        surface counts, visible gaps, and the full host architecture diagram.
      </p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {surfaceRows.map((row) => {
          const state = surfaceState(platform, row.key);
          return (
            <span
              key={row.key}
              title={`${row.label}: ${state}`}
              className={cn(
                "rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide",
                stateClass(state),
              )}
            >
              {row.label}
            </span>
          );
        })}
      </div>

      <Link
        to={`/agents/${platform.id}`}
        className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-muted/20 px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-foreground transition-colors hover:border-foreground/40 hover:bg-foreground/[0.04]"
        aria-label={`Open ${platform.name} architecture detail`}
        data-host-card-detail-link={platform.id}
      >
        Open detail
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </Link>
    </article>
  );
}
