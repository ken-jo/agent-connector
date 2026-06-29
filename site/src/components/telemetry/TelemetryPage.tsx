import * as React from "react";

import { setMetaDescription } from "@/components/docs/meta";
import { Footer } from "@/components/sections/Footer";
import { Nav } from "@/components/sections/Nav";
import { Telemetry } from "@/components/sections/Telemetry";
import { SkipLink } from "@/components/ui/skip-link";

const CONTENT_ID = "telemetry-content";

const TELEMETRY_DESCRIPTION =
  "agent-connector token telemetry shows local-first, platform-independent per-tool cost leaderboards for MCP servers, hooks, actions, and host usage.";

/**
 * /telemetry — an indexable page for the same token telemetry surface that the
 * landing previews. Kept separate from /coverage so telemetry can be linked,
 * shared, and expanded without overloading the homepage section.
 */
export function TelemetryPage() {
  React.useEffect(() => {
    document.title = "Telemetry — agent-connector";
    setMetaDescription(TELEMETRY_DESCRIPTION);
    window.scrollTo({ top: 0 });
  }, []);

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <SkipLink targetId={CONTENT_ID} />
      <Nav />
      <main id={CONTENT_ID} tabIndex={-1} className="flex-1 outline-none">
        <Telemetry />
      </main>
      <Footer />
    </div>
  );
}
