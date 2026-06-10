/**
 * Static docs search index, built once at module load from the data-driven
 * track/nav structure. One palette spans BOTH audience tracks. Two tiers of
 * results:
 *  - "section" entries: the per-track docs sections (sidebar pages).
 *  - "heading" entries: the H3 sub-headings inside each section (anchor ids),
 *    so ⌘K can jump straight to e.g. "Confidence sources" or "ServerDef".
 *
 * Every entry resolves to a docs anchor id; selecting it navigates to
 * /docs/<track>/<sectionId> (+ #<id> for headings). Headings here mirror the
 * `id="..."` anchors authored in DocsContent.tsx — keep them in sync.
 *
 * INVARIANT: section ids AND heading anchor ids must stay GLOBALLY unique
 * across BOTH tracks — each entry's id is the cmdk item `value` and the
 * `searchHaystack` key, so a collision would shadow a result.
 */

import {
  sectionDescription,
  sectionLabel,
  trackIds,
  tracks,
  type TrackId,
} from "./docs-data";

export interface SearchEntry {
  /** Anchor id to navigate to (globally unique across both tracks). */
  id: string;
  /** Display title for the result row. */
  title: string;
  /** The owning docs section id (for grouping + parent label). */
  sectionId: string;
  /** Human label of the owning section. */
  sectionLabel: string;
  /** The audience track that owns the section (drives the result path). */
  track: TrackId;
  /** "section" = a sidebar page; "heading" = an H3 anchor within a page. */
  kind: "section" | "heading";
  /** Short blurb (sections only) to enrich the result + improve matching. */
  description?: string;
  /** Extra keywords folded into the searchable haystack. */
  keywords?: string;
}

/**
 * H3 anchor ids per section, mirroring the `id="..."` headings in
 * DocsContent.tsx. Titles are the human heading text shown in the result row.
 */
const sectionHeadings: Record<string, { id: string; title: string }[]> = {
  introduction: [
    { id: "two-pillars", title: "Two pillars" },
  ],
  installation: [
    { id: "optional-global", title: "Optional: use the CLI directly" },
    { id: "from-source", title: "From source" },
  ],
  "quick-start": [],
  overview: [
    { id: "qs-user", title: "Run it — zero setup" },
  ],
  "embed-cli": [
    { id: "embed-package", title: "Depend on it + add a bin" },
    { id: "embed-bin", title: "createConnectorCli in your bin" },
    { id: "embed-usage", title: "Your users drive your brand" },
    { id: "embed-scoping", title: "Auto-scoping & the shared home binary" },
  ],
  usage: [
    { id: "usage-run", title: "Run it" },
  ],
  "coverage-confidence": [],
  "define-connector": [
    { id: "connector-config", title: "ConnectorConfig" },
    { id: "validation-rules", title: "Top-level validation rules" },
    { id: "resolved-connector", title: "ResolvedConnector" },
    { id: "platform-override", title: "PlatformOverride (escape hatch)" },
  ],
  server: [
    { id: "transports", title: "Transports & dialects" },
    { id: "per-dialect-output", title: "Per-dialect output" },
  ],
  hooks: [
    { id: "hook-events", title: "Normalized events" },
    { id: "hook-response", title: "HookResponse" },
    { id: "paradigms", title: "Three paradigms" },
  ],
  "hooks-guide": [
    { id: "single-wrapper", title: "The single-wrapper hook API" },
    { id: "mapping-matrix", title: "The mapping matrix" },
    { id: "platform-detail", title: "Per-platform detail" },
    { id: "claude-vs-kilo", title: "Claude Code ↔ Kilo CLI: same position?" },
  ],
  surfaces: [
    { id: "command-def", title: "CommandDef" },
    { id: "skill-def", title: "SkillDef" },
    { id: "subagent-def", title: "SubagentDef" },
    { id: "surface-validation", title: "Validation rules" },
    { id: "surface-support", title: "Per-platform surface support" },
  ],
  packaging: [
    { id: "package-command", title: "The package command" },
    { id: "package-formats", title: "Host formats + standard artifacts" },
    { id: "package-telemetry", title: "Telemetry carries through every bundle" },
  ],
  "telemetry-overview": [
    { id: "telemetry-config", title: "TelemetryConfig" },
    { id: "tokenizer", title: "Tokenizer" },
    { id: "confidence-sources", title: "Confidence sources" },
    { id: "store", title: "Store" },
    { id: "host-usage-layer", title: "Host usage layer" },
  ],
  "telemetry-surfaces": [
    { id: "two-axes", title: "The two axes" },
    { id: "five-surfaces", title: "The five developer surfaces" },
    { id: "event-scope", title: "EventScope & SurfaceKind" },
    { id: "guarantees", title: "Local-first, zero-egress, opt-out" },
    { id: "confidence", title: "Confidence sources" },
    { id: "per-surface-leaderboard", title: "The per-surface leaderboard" },
  ],
  leaderboards: [
    { id: "connector-scoped", title: "Scoped to your connector" },
  ],
  cli: [
    { id: "shared-flags", title: "Shared flags" },
    { id: "commands", title: "Commands" },
    { id: "since-syntax", title: "--since syntax" },
    { id: "internal-entrypoints", title: "Internal entrypoints" },
  ],
  platforms: [
    { id: "paradigm-json-stdio", title: "json-stdio" },
    { id: "paradigm-mcp-only", title: "mcp-only" },
    { id: "paradigm-ts-plugin", title: "ts-plugin" },
  ],
  "add-a-platform": [],
  "operating-model": [],
  troubleshooting: [
    { id: "reading-doctor", title: "Reading doctor output" },
    { id: "hooks-unavailable", title: '"hooks unavailable here"' },
    { id: "warn-exit-1", title: "The warn action → exit 1" },
    { id: "requires-sync", title: '"requires sync, skipped" usage rows' },
    { id: "config-errors", title: "Common ConnectorConfigError messages" },
    { id: "telemetry-empty", title: "Telemetry shows nothing" },
  ],
};

/**
 * Flat, ordered search index: dev track first, then user (matching the
 * chooser card order); each section followed by its headings.
 */
export const searchIndex: SearchEntry[] = trackIds.flatMap((t) =>
  tracks[t].groups.flatMap((group) =>
    group.items.flatMap((item) => {
      const label = sectionLabel[item.id] ?? item.label;
      const section: SearchEntry = {
        id: item.id,
        title: item.label,
        sectionId: item.id,
        sectionLabel: label,
        track: t,
        kind: "section",
        description: sectionDescription[item.id],
        keywords: `${tracks[t].label} ${group.title}`,
      };
      const headings = (sectionHeadings[item.id] ?? []).map<SearchEntry>(
        (h) => ({
          id: h.id,
          title: h.title,
          sectionId: item.id,
          sectionLabel: label,
          track: t,
          kind: "heading",
        }),
      );
      return [section, ...headings];
    }),
  ),
);

/** Precomputed lowercase haystack per entry id (title + section + blurb). */
export const searchHaystack: Record<string, string> = Object.fromEntries(
  searchIndex.map((e) => [
    e.id,
    [e.title, e.sectionLabel, e.description ?? "", e.keywords ?? ""]
      .join(" ")
      .toLowerCase(),
  ]),
);
