/**
 * core/marketplace-drivers/registry — platform → MarketplaceDriver resolution.
 *
 * The single place the orchestrator (marketplace.ts) asks "can I DRIVE this
 * host's marketplace flow, and how?". Returns the host-specific driver, or null
 * for a platform that has a bundle FORMAT but no live driver yet (those keep the
 * manual-hint skip/warn path). The agy driver serves BOTH `antigravity` and
 * `antigravity-cli`, bound per-id so its ChangeRecords carry the user's target.
 */

import type { PlatformId } from "../types.js";
import { claudeDriver } from "./claude.js";
import { codexDriver } from "./codex.js";
import { droidDriver } from "./droid.js";
import { makeAgyDriver } from "./agy.js";
import { geminiDriver } from "./gemini.js";
import { makeNpmLocalDriver } from "./npm-local.js";
import { qwenDriver } from "./qwen.js";
import type { MarketplaceDriver } from "./types.js";

type DriverResolver = {
  platforms: readonly PlatformId[];
  resolve(platform: PlatformId): MarketplaceDriver;
};

// Memoize the per-id agy drivers (stable identity; one instance per platform).
const agyDrivers = new Map<PlatformId, MarketplaceDriver>();
function agyDriver(platform: PlatformId): MarketplaceDriver {
  let driver = agyDrivers.get(platform);
  if (!driver) {
    driver = makeAgyDriver(platform);
    agyDrivers.set(platform, driver);
  }
  return driver;
}

// Memoize the per-id npm-local drivers (one instance per platform). The CLI
// binary is `opencode` for opencode and `kilo` for both kilo and kilo-cli (the
// kilo-cli alias shares the kilo binary; live-verified).
const NPM_LOCAL_BINARIES: Partial<Record<PlatformId, string>> = {
  opencode: "opencode",
  kilo: "kilo",
  "kilo-cli": "kilo",
};
const npmLocalDrivers = new Map<PlatformId, MarketplaceDriver>();
function npmLocalDriver(platform: PlatformId): MarketplaceDriver {
  let driver = npmLocalDrivers.get(platform);
  if (!driver) {
    driver = makeNpmLocalDriver(platform, {
      binaryName: NPM_LOCAL_BINARIES[platform] ?? platform,
    });
    npmLocalDrivers.set(platform, driver);
  }
  return driver;
}

const DRIVER_RESOLVERS: readonly DriverResolver[] = [
  { platforms: ["claude-code"], resolve: () => claudeDriver },
  { platforms: ["codex"], resolve: () => codexDriver },
  {
    platforms: ["antigravity", "antigravity-cli"],
    resolve: (platform) => agyDriver(platform),
  },
  { platforms: ["gemini-cli"], resolve: () => geminiDriver },
  { platforms: ["qwen-code"], resolve: () => qwenDriver },
  { platforms: ["droid"], resolve: () => droidDriver },
  {
    platforms: ["opencode", "kilo", "kilo-cli"],
    resolve: (platform) => npmLocalDriver(platform),
  },
];

/** The platforms with an end-to-end marketplace driver, in stable UX order. */
export const DRIVABLE_MARKETPLACE_PLATFORMS: readonly PlatformId[] =
  DRIVER_RESOLVERS.flatMap((entry) => [...entry.platforms]);

/** True when `platform` has an end-to-end marketplace driver. */
export function hasMarketplaceDriver(platform: PlatformId): boolean {
  return DRIVABLE_MARKETPLACE_PLATFORMS.includes(platform);
}

/** The driver that can DRIVE `platform`'s marketplace flow, or null when none. */
export function getMarketplaceDriver(platform: PlatformId): MarketplaceDriver | null {
  const entry = DRIVER_RESOLVERS.find((resolver) =>
    resolver.platforms.includes(platform),
  );
  return entry?.resolve(platform) ?? null;
}
