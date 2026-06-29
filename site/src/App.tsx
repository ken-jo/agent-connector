import * as React from "react";
import { Navigate, Routes, Route } from "react-router-dom";
import { Landing } from "@/components/Landing";
import { NotFound } from "@/components/NotFound";

// Route-level code split: the docs bundle (DocsContent + cmdk command palette +
// docs-data) is fetched only when /docs* is visited, so it never weighs down
// the landing's initial chunk. DocsChooser and LegacyDocsRedirect must stay
// lazy too — importing them (or docs-data) statically here would pull the docs
// data into the landing chunk. shiki is split a second level deeper (loaded on
// first highlight) inside CodeBlock.
const DocsPage = React.lazy(() =>
  import("@/components/docs/DocsPage").then((m) => ({ default: m.DocsPage })),
);
const DocsChooser = React.lazy(() =>
  import("@/components/docs/DocsChooser").then((m) => ({
    default: m.DocsChooser,
  })),
);
const LegacyDocsRedirect = React.lazy(() =>
  import("@/components/docs/LegacyDocsRedirect").then((m) => ({
    default: m.LegacyDocsRedirect,
  })),
);
// /coverage is code-split for the same reason as the docs routes: the full
// interactive CoverageWall (+ its star snapshot) must never land in the
// landing's initial chunk.
const CoveragePage = React.lazy(() =>
  import("@/components/coverage-wall/CoveragePage").then((m) => ({
    default: m.CoveragePage,
  })),
);
// /telemetry — the standalone token telemetry page. Code-split so the landing
// keeps using the lightweight section while the indexable page loads on demand.
const TelemetryPage = React.lazy(() =>
  import("@/components/telemetry/TelemetryPage").then((m) => ({
    default: m.TelemetryPage,
  })),
);
// /wizard — the standalone connector scaffold generator. Code-split for the
// same reason as /coverage: its form + live-preview logic must never land in
// the landing's initial chunk.
const WizardPage = React.lazy(() =>
  import("@/components/wizard/WizardPage").then((m) => ({
    default: m.WizardPage,
  })),
);
const BlogPage = React.lazy(() =>
  import("@/components/blog/BlogPage").then((m) => ({
    default: m.BlogPage,
  })),
);
const BlogPostPage = React.lazy(() =>
  import("@/components/blog/BlogPostPage").then((m) => ({
    default: m.BlogPostPage,
  })),
);

function lazyDocs(node: React.ReactNode) {
  return <React.Suspense fallback={null}>{node}</React.Suspense>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      {/* /coverage — the dedicated, indexable full interactive coverage matrix. */}
      <Route path="/coverage" element={lazyDocs(<CoveragePage />)} />
      {/* /telemetry — the dedicated, indexable token telemetry page. */}
      <Route path="/telemetry" element={lazyDocs(<TelemetryPage />)} />
      {/* /wizard — the standalone connector scaffold generator. */}
      <Route path="/wizard" element={lazyDocs(<WizardPage />)} />
      <Route path="/blog" element={lazyDocs(<BlogPage />)} />
      <Route path="/blog/:slug" element={lazyDocs(<BlogPostPage />)} />
      {/* /docs is the chooser — the fork between guides, dev, and user tracks. */}
      <Route path="/docs" element={lazyDocs(<DocsChooser />)} />
      {/* Static /docs/guides, /docs/user, and /docs/dev segments outrank /docs/:legacySection
          under react-router v6 route ranking, so order here is not load-bearing. */}
      <Route
        path="/docs/guides"
        element={lazyDocs(<DocsPage track="guides" />)}
      />
      <Route
        path="/docs/guides/:section"
        element={lazyDocs(<DocsPage track="guides" />)}
      />
      <Route path="/docs/user" element={lazyDocs(<DocsPage track="user" />)} />
      <Route
        path="/docs/user/:section"
        element={lazyDocs(<DocsPage track="user" />)}
      />
      <Route path="/docs/dev" element={lazyDocs(<DocsPage track="dev" />)} />
      <Route
        path="/docs/dev/mcp-101"
        element={<Navigate to="/docs/guides/mcp-beginner" replace />}
      />
      <Route
        path="/docs/dev/:section"
        element={lazyDocs(<DocsPage track="dev" />)}
      />
      {/* Every pre-track /docs/<section> URL is public — redirect into its track. */}
      <Route
        path="/docs/:legacySection"
        element={lazyDocs(<LegacyDocsRedirect />)}
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
