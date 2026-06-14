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
import { makeAgyDriver } from "./agy.js";
import type { MarketplaceDriver } from "./types.js";

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

/** The driver that can DRIVE `platform`'s marketplace flow, or null when none. */
export function getMarketplaceDriver(platform: PlatformId): MarketplaceDriver | null {
  switch (platform) {
    case "claude-code":
      return claudeDriver;
    case "codex":
      return codexDriver;
    case "antigravity":
    case "antigravity-cli":
      return agyDriver(platform);
    default:
      return null;
  }
}
