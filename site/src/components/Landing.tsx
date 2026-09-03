import * as React from "react";
import { useLocation } from "react-router-dom";
import {
  DEFAULT_DESCRIPTION,
  setMetaDescription,
} from "@/components/docs/meta";
import { SkipLink } from "@/components/ui/skip-link";
import { Nav } from "@/components/sections/Nav";
import { Hero } from "@/components/sections/Hero";
import { Audiences } from "@/components/sections/Audiences";
import { Pillars } from "@/components/sections/Pillars";
import { Surfaces } from "@/components/sections/Surfaces";
import { CoverageMarquee } from "@/components/sections/CoverageMarquee";
import { InstallMethods } from "@/components/sections/InstallMethods";
import { Efficiency } from "@/components/sections/Efficiency";
import { WriteOnceTabs } from "@/components/sections/WriteOnceTabs";
import { Telemetry } from "@/components/sections/Telemetry";
import { Cli } from "@/components/sections/Cli";
import { HowItWorks } from "@/components/sections/HowItWorks";
import { Footer } from "@/components/sections/Footer";

const LANDING_TITLE = "agent-connector — Deploy one MCP to every agent host";

export function Landing() {
  const { hash } = useLocation();

  React.useEffect(() => {
    document.title = LANDING_TITLE;
    setMetaDescription(DEFAULT_DESCRIPTION);

    const id = hash.replace(/^#/, "");
    if (!id) {
      window.scrollTo({ top: 0 });
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(id);
      if (target) {
        target.scrollIntoView({ block: "start" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [hash]);

  return (
    <div className="relative min-h-dvh bg-background">
      <SkipLink />
      <Nav />
      <main id="main-content" tabIndex={-1} className="outline-none">
        <Hero />
        <Efficiency />
        {/* Lightweight auto-scrolling coverage marquee in the old Platforms
            slot — the detailed rank-tier wall + filter now lives at
            /docs/dev/platforms (linked from here). */}
        <CoverageMarquee />
        <Pillars />
        <Surfaces />
        <WriteOnceTabs />
        <Telemetry />
        <Cli />
        {/* "Who it's for" sits directly above "Two ways in": pick your track,
            then see how each track gets in. */}
        <Audiences />
        <InstallMethods />
        <HowItWorks />
      </main>
      <Footer />
    </div>
  );
}
