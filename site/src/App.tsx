import * as React from "react";
import { Routes, Route } from "react-router-dom";
import { Landing } from "@/components/Landing";
import { NotFound } from "@/components/NotFound";

// Route-level code split: the docs bundle (DocsContent + cmdk command palette)
// is fetched only when /docs is visited, so it never weighs down the landing's
// initial chunk. shiki is split a second level deeper (loaded on first
// highlight) inside CodeBlock.
const DocsPage = React.lazy(() =>
  import("@/components/docs/DocsPage").then((m) => ({ default: m.DocsPage })),
);

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route
        path="/docs"
        element={
          <React.Suspense fallback={null}>
            <DocsPage />
          </React.Suspense>
        }
      />
      <Route
        path="/docs/:section"
        element={
          <React.Suspense fallback={null}>
            <DocsPage />
          </React.Suspense>
        }
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
