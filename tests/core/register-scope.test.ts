/**
 * core/register-scope — registerConnector persists the optional install scope
 * and readRegisteredMeta round-trips it.
 *
 * Scope is an install-time property; persisting it on the registered metadata is
 * what lets the runtime entrypoints recover it (sync) and stamp it onto the
 * HostCtx/event. We assert the three states: a scope passed round-trips; no
 * scope passed leaves the field absent (undefined); a re-register without a
 * scope clears a previously-stored one (the record is rewritten whole).
 *
 * Filesystem is isolated to a fresh temp data dir, restored in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadConnectorFromPath,
  readRegisteredMeta,
  registerConnector,
} from "../../src/core/load-connector.js";

const DIST_INDEX = join(__dirname, "..", "..", "dist", "index.js");
const CONN_ID = "reg-scope";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
};

let tmpHome: string;
let tmpData: string;
let modPath: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-rs-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-rs-data-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;

  modPath = join(tmpData, `${CONN_ID}.config.mjs`);
  const distUrl = pathToFileURL(DIST_INDEX).href;
  writeFileSync(
    modPath,
    `
import { defineConnector } from ${JSON.stringify(distUrl)};
export default defineConnector({
  id: ${JSON.stringify(CONN_ID)},
  actions: [{ id: "noop", run: () => {} }],
});
`,
    "utf8",
  );
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of [tmpHome, tmpData]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("registerConnector scope persistence", () => {
  it("round-trips a passed scope through readRegisteredMeta", async () => {
    const { connector } = await loadConnectorFromPath(modPath);
    registerConnector(connector, modPath, "project");
    expect(readRegisteredMeta(CONN_ID)?.scope).toBe("project");
  });

  it("leaves scope absent (undefined) when none is passed", async () => {
    const { connector } = await loadConnectorFromPath(modPath);
    registerConnector(connector, modPath);
    expect(readRegisteredMeta(CONN_ID)?.scope).toBeUndefined();
  });

  it("a re-register without a scope clears a previously-stored one", async () => {
    const { connector } = await loadConnectorFromPath(modPath);
    registerConnector(connector, modPath, "user");
    expect(readRegisteredMeta(CONN_ID)?.scope).toBe("user");
    // The record is rewritten whole on re-register → the old scope is gone.
    registerConnector(connector, modPath);
    expect(readRegisteredMeta(CONN_ID)?.scope).toBeUndefined();
  });
});
