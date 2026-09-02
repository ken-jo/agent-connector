import coverageStars from "@/coverage-stars.generated.json";
import {
  adapterCapabilityProfiles,
  generatedSurfaceKeys,
  generatedSurfaceLabels,
  type GeneratedSurfaceKey,
} from "@/adapter-capabilities.generated";
import {
  hostVerificationResults,
  verificationLevelDescriptions,
  verificationLevelForResult,
  verificationLevelLabels,
  verificationLevelOrder,
  type VerificationLevelId,
} from "@/host-verification.generated";
import {
  hostSource,
  isPublicCoverageHost,
  platforms,
  type Platform,
} from "@/data";

const STARS: Record<string, number> = coverageStars;

export { PUBLIC_OSS_STAR_FLOOR, PUBLIC_INDEPENDENT_STAR_FLOOR } from "@/data";

export function starsForPlatform(id: string): number | undefined {
  const src = hostSource[id];
  return src && "repo" in src ? STARS[src.repo] : undefined;
}

/** The curation policy, with stars resolved from the generated snapshot. */
export function isPublicCoveragePlatform(platform: Platform): boolean {
  return isPublicCoverageHost(platform, starsForPlatform(platform.id));
}

export const publicCoveragePlatforms: Platform[] = platforms.filter(
  isPublicCoveragePlatform,
);

export const publicCoverageCount = publicCoveragePlatforms.length;

const publicCoverageIds = new Set(publicCoveragePlatforms.map((p) => p.id));

export const publicCapabilityProfiles = adapterCapabilityProfiles.filter((p) =>
  publicCoverageIds.has(p.id),
);

export const publicCoverageSurfaceCounts: {
  key: GeneratedSurfaceKey;
  label: string;
  count: number;
}[] = generatedSurfaceKeys.map((key) => ({
  key,
  label: generatedSurfaceLabels[key],
  count: publicCapabilityProfiles.filter((p) => p.surfaces[key]).length,
}));

export const publicVerificationRows = hostVerificationResults.filter((row) =>
  publicCoverageIds.has(row.host),
);

export const publicVerificationCounts: {
  key: VerificationLevelId;
  label: string;
  description: string;
  count: number;
}[] = verificationLevelOrder.map((key) => ({
  key,
  label: verificationLevelLabels[key],
  description: verificationLevelDescriptions[key],
  count: publicVerificationRows.filter(
    (row) => verificationLevelForResult(row.result) === key,
  ).length,
}));
