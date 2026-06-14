/**
 * runtime/statusline — the home-bin statusline (HUD) renderer.
 *
 * A statusline-supporting host execs `<homeBin> statusline <platform> --connector
 * <id>`, which the CLI hands to runStatusline. runStatusline loads the registered
 * connector (live render handler, re-imported from the source module — functions
 * can't survive the JSON registry record), parses the host's raw status payload
 * via the adapter, renders the line, and formats the host-native reply.
 *
 * FAIL-SAFE is the contract: a render that THROWS, an UNKNOWN connector, or a
 * missing render → exit 0 with NO stdout (an empty status line never wedges or
 * spews into the host status bar).
 *
 * Like the hook-telemetry test, the live handler comes from a fixture .mjs
 * importing defineConnector from the BUILT dist entry. Filesystem is isolated to
 * fresh temp HOME + data dirs, restored in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConnectorFromPath, registerConnector } from "../../src/core/load-connector.js";
import { runStatusline } from "../../src/runtime/statusline-entrypoint.js";

const DIST_INDEX = join(__dirname, "..", "..", "dist", "index.js");
const OK_ID = "sl-render-ok";
const THROW_ID = "sl-render-throw";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
};

let tmpHome: string;
let tmpData: string;

/**
 * Fixture: an OK connector whose render echoes `${model.displayName} ${cwd}`, and
 * a THROW connector whose render always throws (the fail-safe probe).
 */
function writeFixtureModule(dir: string, id: string, body: string): string {
  const modPath = join(dir, `${id}.config.mjs`);
  const distUrl = pathToFileURL(DIST_INDEX).href;
  const source = `
import { defineConnector } from ${JSON.stringify(distUrl)};

export default defineConnector({
  id: ${JSON.stringify(id)},
  statusline: { render: ${body} },
});
`;
  writeFileSync(modPath, source, "utf8");
  return modPath;
}

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-slrt-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-slrt-data-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;

  const okPath = writeFixtureModule(
    tmpData,
    OK_ID,
    "(ctx) => `${ctx.model?.displayName} ${ctx.cwd}`",
  );
  const okConn = (await loadConnectorFromPath(okPath)).connector;
  registerConnector(okConn, okPath);

  const throwPath = writeFixtureModule(
    tmpData,
    THROW_ID,
    '() => { throw new Error("boom"); }',
  );
  const throwConn = (await loadConnectorFromPath(throwPath)).connector;
  registerConnector(throwConn, throwPath);
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

describe("runStatusline", () => {
  it("renders the line from a parsed Claude status payload (exit 0, stdout = line)", async () => {
    const stdin = JSON.stringify({
      model: { id: "claude-opus", display_name: "Opus" },
      cwd: "/home/dev/acme",
      session_id: "sess-1",
    });
    const res = await runStatusline({
      platformId: "claude-code",
      connectorId: OK_ID,
      stdin,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("Opus /home/dev/acme");
  });

  it("FAIL-SAFE: a render that throws → exit 0, no stdout", async () => {
    const res = await runStatusline({
      platformId: "claude-code",
      connectorId: THROW_ID,
      stdin: JSON.stringify({ cwd: "/x" }),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBeUndefined();
  });

  it("FAIL-SAFE: an unknown connector → exit 0, no stdout", async () => {
    const res = await runStatusline({
      platformId: "claude-code",
      connectorId: "no-such-connector",
      stdin: JSON.stringify({ cwd: "/x" }),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBeUndefined();
  });

  it("FAIL-SAFE: malformed stdin still renders (parse tolerates → {})", async () => {
    const res = await runStatusline({
      platformId: "claude-code",
      connectorId: OK_ID,
      stdin: "{not json",
    });
    // ctx.model / ctx.cwd are undefined → the render echoes the template literally.
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("undefined undefined");
  });

  it("an adapter without statusline support → exit 0, no stdout", async () => {
    // codex has no parseStatusInput/formatStatusOutput → nothing to render.
    const res = await runStatusline({
      platformId: "codex",
      connectorId: OK_ID,
      stdin: JSON.stringify({ cwd: "/x" }),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBeUndefined();
  });
});
