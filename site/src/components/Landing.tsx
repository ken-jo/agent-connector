import { SkipLink } from "@/components/ui/skip-link";
import { Nav } from "@/components/sections/Nav";
import { Hero } from "@/components/sections/Hero";
import { Pillars } from "@/components/sections/Pillars";
import { Surfaces } from "@/components/sections/Surfaces";
import { Platforms } from "@/components/sections/Platforms";
import { WriteOnceTabs } from "@/components/sections/WriteOnceTabs";
import { Telemetry } from "@/components/sections/Telemetry";
import { Cli } from "@/components/sections/Cli";
import { HowItWorks } from "@/components/sections/HowItWorks";
import { Footer } from "@/components/sections/Footer";

export function Landing() {
  return (
    <div className="relative min-h-dvh bg-background">
      <SkipLink />
      <Nav />
      <main id="main-content" tabIndex={-1} className="outline-none">
        <Hero />
        <Pillars />
        <Surfaces />
        <Platforms />
        <WriteOnceTabs />
        <Telemetry />
        <Cli />
        <HowItWorks />
      </main>
      <Footer />
    </div>
  );
}
