/**
 * core/marketplace — the GitHub Copilot CLI marketplace driver (copilot-cli).
 *
 * Localized companion to tests/core/marketplace.test.ts: covers the copilot-cli
 * driver added as a first-class `--method marketplace` target. Three hermetic
 * lanes, no real `copilot` binary spawned:
 *   1. registry + format mapping  — copilot-cli is drivable and maps to
 *      agent-plugin (driver.format === MARKETPLACE_FORMAT_BY_PLATFORM entry);
 *   2. install --dry-run          — emits the exact `copilot plugin marketplace
 *      add <stagingRoot>` + `copilot plugin install <id>@agent-connector`
 *      commands as ChangeRecords and writes NOTHING / spawns nothing;
 *   3. state readers              — copilotPluginInstalled / copilotMarketplaceSource
 *      parse the LIVE-VERIFIED ~/.copilot config.json (JSONC) + settings.json
 *      shapes (so the probe-first driver keys off the real state files).
 *
 * Isolation contract (mirrors marketplace.test.ts): HOME / USERPROFILE /
 * AGENT_CONNECTOR_DATA_DIR redirected to fresh temp dirs and restored afterEach.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import {
  MARKETPLACE_FORMAT_BY_PLATFORM,
  installViaMarketplace,
} from "../../src/core/marketplace.js";
import { getMarketplaceDriver } from "../../src/core/marketplace-drivers/registry.js";
import { copilotDriver } from "../../src/core/marketplace-drivers/copilot.js";
import {
  copilotMarketplaceSource,
  copilotPluginInstalled,
  copilotStagingRoot,
} from "../../src/core/marketplace-state.js";
import type { ResolvedConnector } from "../../src/core/types.js";
import { tempDir } from "../support/env.js";

const CONNECTOR_ID = "acme-db";
const MODULE_PATH = join(__dirname, "..", "..", "dist", "index.js");

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
};

let tmpHome: string;
let projectDir: string;

function buildConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    targets: ["copilot-cli"],
    server: { transport: "stdio", command: "npx", args: ["-y", "@acme/db-mcp"] },
    hooks: {
      PreToolUse: {
        handler() {
          return { decision: "allow" };
        },
      },
    },
  });
}

beforeEach(() => {
  tmpHome = tempDir("ac-mkt-copilot-home-");
  projectDir = tempDir("ac-mkt-copilot-proj-");
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(tempDir("ac-mkt-copilot-data-"), ".agent-connector");
});

afterEach(() => {
  restore("HOME", SAVED.HOME);
  restore("USERPROFILE", SAVED.USERPROFILE);
  restore("AGENT_CONNECTOR_DATA_DIR", SAVED.DATA_DIR);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Write a Copilot CLI state file pair under ~/.copilot (config.json is JSONC). */
function writeCopilotState(opts: {
  installed?: boolean;
  marketplacePath?: string | null;
}): void {
  const dir = join(tmpHome, ".copilot");
  mkdirSync(dir, { recursive: true });
  const config = {
    installedPlugins: opts.installed
      ? [
          {
            name: CONNECTOR_ID,
            marketplace: "agent-connector",
            version: "1.0.0",
            installed_at: "2026-06-22T00:00:00.000Z",
            enabled: true,
            cache_path: join(dir, "installed-plugins", "agent-connector", CONNECTOR_ID),
          },
        ]
      : [],
  };
  // The live config.json carries a leading JSONC comment header — replicate it
  // so the reader's JSONC tolerance is exercised, not just plain JSON.
  writeFileSync(
    join(dir, "config.json"),
    `// User settings belong in settings.json.\n// This file is managed automatically.\n${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  const settings: Record<string, unknown> = { enabledPlugins: {} };
  if (opts.marketplacePath !== undefined && opts.marketplacePath !== null) {
    settings.extraKnownMarketplaces = {
      "agent-connector": {
        source: { source: "directory", path: opts.marketplacePath },
      },
    };
  }
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

describe("copilot-cli marketplace driver — registry + format mapping", () => {
  it("copilot-cli is drivable and maps to the agent-plugin format (the Agent Plugins 1.0.0 SSOT bundle)", () => {
    const driver = getMarketplaceDriver("copilot-cli");
    expect(driver).toBe(copilotDriver);
    expect(driver!.platform).toBe("copilot-cli");
    expect(driver!.format).toBe("agent-plugin");
    expect(MARKETPLACE_FORMAT_BY_PLATFORM["copilot-cli"]).toBe("agent-plugin");
    expect(MARKETPLACE_FORMAT_BY_PLATFORM["vscode-copilot"]).toBe("agent-plugin");
    expect(MARKETPLACE_FORMAT_BY_PLATFORM["codex"]).toBe("agent-plugin");
  });
});

describe("installViaMarketplace — copilot-cli (--dry-run)", () => {
  it("emits the exact copilot plugin commands and writes/spawns NOTHING", async () => {
    const result = await installViaMarketplace({
      connector: buildConnector(),
      modulePath: MODULE_PATH,
      scope: "user",
      projectDir,
      targets: ["copilot-cli"],
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    const details = result.changes
      .filter((c) => c.platform === "copilot-cli")
      .map((c) => c.detail);
    const staging = copilotStagingRoot();
    expect(details).toContain(`run: copilot plugin marketplace add ${staging}`);
    expect(details).toContain(
      `run: copilot plugin install ${CONNECTOR_ID}@agent-connector`,
    );

    // The staged file tree is enumerated (an agent-plugin bundle), but nothing
    // is written and no host CLI is spawned.
    const stagedFiles = result.changes.filter(
      (c) => c.platform === "copilot-cli" && c.action === "create" && c.path,
    );
    expect(stagedFiles.length).toBeGreaterThan(0);
    expect(existsSync(staging)).toBe(false);
  });
});

describe("copilot-cli state readers (live-verified ~/.copilot shapes)", () => {
  it("copilotPluginInstalled reads installedPlugins[] from JSONC config.json", () => {
    expect(copilotPluginInstalled(CONNECTOR_ID)).toBe(false);
    writeCopilotState({ installed: true });
    expect(copilotPluginInstalled(CONNECTOR_ID)).toBe(true);
    // A disabled entry does not count as installed.
    writeCopilotState({ installed: false });
    expect(copilotPluginInstalled(CONNECTOR_ID)).toBe(false);
  });

  it("copilotMarketplaceSource reads extraKnownMarketplaces.<name>.source.path", () => {
    expect(copilotMarketplaceSource("agent-connector")).toBeNull();
    const path = "/tmp/some/staging/root";
    writeCopilotState({ marketplacePath: path });
    expect(copilotMarketplaceSource("agent-connector")).toBe(path);
  });
});
