/**
 * Static docs search index, built once at module load from the data-driven
 * track/nav structure. One palette spans all docs tracks. Two tiers of
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
 * across all tracks — each entry's id is the cmdk item `value` and the
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
  /** Anchor id to navigate to (globally unique across all docs tracks). */
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
  "mcp-beginner": [
    { id: "mcp-architecture-map", title: "Architecture map: who owns what?" },
    { id: "mcp-terms", title: "Learn the nouns before writing code" },
    { id: "mcp-first-surface", title: "Pick the first surface deliberately" },
    { id: "mcp-tool-contract", title: "Design one good tool contract" },
    { id: "mcp-server-first", title: "Build the smallest useful server" },
    { id: "mcp-server-runtime", title: "How an MCP server actually runs" },
    { id: "mcp-server-owns", title: "What your server owns" },
    { id: "mcp-host-owns", title: "What the host owns" },
    { id: "mcp-package-identity", title: "Add only the package metadata you need" },
    { id: "mcp-connect", title: "Connect it to one host" },
    { id: "mcp-verify", title: "Verify one call before adding features" },
    { id: "mcp-debug-loop", title: "Debug in this order" },
    { id: "mcp-safety", title: "Add safety before writes" },
    { id: "mcp-hooks", title: "Hooks: the layer around MCP" },
    { id: "mcp-hooks-when", title: "When hooks run" },
    { id: "mcp-hooks-vs-tools", title: "Hooks vs tools" },
    { id: "mcp-next", title: "Add agent-connector only after the server works" },
  ],
  "beginner-demo-lab": [
    { id: "demo-lab-map", title: "The whole path" },
    { id: "demo-lab-files", title: "Create the files" },
    { id: "demo-lab-server", title: "Paste the demo MCP server" },
    { id: "demo-lab-smoke-script", title: "Add the smoke-test script" },
    { id: "demo-lab-inspector", title: "Open Inspector and capture the first demo frame" },
    { id: "demo-lab-customize", title: "Customize one thing on purpose" },
    { id: "demo-lab-connector", title: "Add agent-connector surfaces" },
    { id: "demo-lab-recording", title: "Capture docs-ready demo screenshots" },
  ],
  "first-mcp-server": [
    { id: "first-server-reference", title: "Reference baseline" },
    { id: "first-server-create-project", title: "Create the project" },
    { id: "first-server-write-tool", title: "Write one read-only tool" },
    { id: "first-server-run-inspector", title: "Run with MCP Inspector" },
    { id: "first-server-success", title: "What success looks like" },
  ],
  "connect-first-host": [
    { id: "first-host-one-target", title: "Pick one host and one scope" },
    { id: "first-host-launch-shape", title: "Use the same launch shape everywhere" },
    { id: "first-host-verify", title: "Verify the host, not the package" },
    { id: "first-host-failures", title: "Isolate failures by boundary" },
    { id: "first-host-agent-connector", title: "Let agent-connector take over later" },
  ],
  "first-connector-surfaces": [
    { id: "connector-surfaces-order", title: "Use a staged expansion order" },
    { id: "connector-surfaces-server-only", title: "Start server-only" },
    { id: "connector-surfaces-runtime", title: "Add runtime surfaces deliberately" },
    { id: "connector-surfaces-choose", title: "Choose by user need" },
    { id: "connector-surfaces-verify", title: "Verify after each added surface" },
  ],
  "connector-concepts": [
    { id: "connector-boundary", title: "The boundary: MCP first, connector second" },
    { id: "connector-distribution-layer", title: "The distribution layer" },
    { id: "connector-install-pipeline", title: "What install actually does" },
    { id: "connector-when-not", title: "When not to add it yet" },
  ],
  "host-hooks": [
    { id: "hook-mental-model", title: "The hook mental model" },
    { id: "hook-official-hosts", title: "Official host surfaces to know first" },
    { id: "hook-cross-validation", title: "Cross-validation before a hook claim" },
    { id: "hook-paradigm-map", title: "CLI behavior by hook paradigm" },
    { id: "hook-connector-authoring", title: "Write the connector hook once" },
    { id: "hook-rendered-shapes", title: "What host config can look like" },
    { id: "hook-dispatch-flow", title: "What happens during dispatch" },
    { id: "hook-customization", title: "How to customize behavior safely" },
    { id: "hook-safety-rules", title: "Beginner safety rules" },
  ],
  "hud-statusline": [
    { id: "hud-not-mcp", title: "Why it is separate from MCP" },
    { id: "hud-official-hosts", title: "Official host model" },
    { id: "hud-render-context", title: "The render callback" },
    { id: "hud-connector-example", title: "Define a connector statusline" },
    { id: "hud-rendered-host-shape", title: "Rendered host config" },
    { id: "hud-cross-validation", title: "Cross-validation for supported hosts" },
    { id: "hud-supported-hosts", title: "Where it is wired today" },
    { id: "hud-customization", title: "Customization checklist" },
    { id: "hud-design-rules", title: "Design rules for beginners" },
  ],
  "actions-guide": [
    { id: "actions-not-tools", title: "Actions vs tools vs hooks" },
    { id: "actions-cli-fallback", title: "Always keep a CLI fallback" },
    { id: "actions-dispatch-flow", title: "The dispatch flow" },
    { id: "actions-connector-example", title: "Define an action in a connector" },
    { id: "actions-host-model", title: "How host affordances map" },
    { id: "actions-cross-validation", title: "Cross-validation for action hosts" },
    { id: "actions-supported-hosts", title: "Where host affordances are wired today" },
    { id: "actions-customization", title: "Customization checklist" },
    { id: "actions-design-rules", title: "Design rules for beginners" },
  ],
  "special-surfaces": [
    { id: "surfaces-map", title: "The surface map" },
    { id: "static-vs-runtime", title: "Static content vs runtime handlers" },
    { id: "memory-rules", title: "Memory is the easiest surface to overuse" },
    { id: "surface-expansion-path", title: "A sane expansion path" },
  ],
  installation: [
    { id: "optional-global", title: "Optional: use the CLI directly" },
    { id: "from-source", title: "From source" },
  ],
  sdk: [
    { id: "sdk-package-identity", title: "Package identity is the source of truth" },
    { id: "sdk-authoring-imports", title: "Authoring imports" },
    { id: "sdk-cli-boundary", title: "CLI boundary" },
    { id: "sdk-audit", title: "What the framework can audit" },
    { id: "sdk-agent-readiness", title: "Agent-ready references" },
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
    { id: "config-patch", title: "Host-config key patches (configPatch)" },
  ],
  server: [
    { id: "transports", title: "Transports & dialects" },
    { id: "per-dialect-output", title: "Per-dialect output" },
  ],
  hooks: [
    { id: "hook-events", title: "Normalized events" },
    { id: "hook-response", title: "HookResponse" },
    { id: "paradigms", title: "Three paradigms" },
    { id: "native-hooks", title: "Native hooks passthrough" },
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
    { id: "memory-def", title: "MemoryDef (memory surface)" },
    {
      id: "memory-managed-blocks",
      title: "Managed blocks: markers, hashes, reversibility",
    },
    { id: "memory-targets", title: "AGENTS.md-first: where the block goes" },
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
 * Flat, ordered search index: track order follows docs-data; each section is
 * followed by its headings.
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
