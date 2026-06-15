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
const HOSTS_ID = "sl-render-hosts";
const FALLBACK_ID = "sl-render-fallback";
const CAPS_ID = "sl-render-caps";
const SCOPE_ID = "sl-render-scope";
const PERHOST_THROW_ID = "sl-render-perhost-throw";

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
  return writeStatuslineFixture(dir, id, `{ render: ${body} }`);
}

/**
 * Like {@link writeFixtureModule} but takes the WHOLE statusline object literal
 * (so a fixture can declare a `hosts:` per-host override map or read
 * ctx.capabilities). `statuslineLiteral` is inlined verbatim into the module.
 */
function writeStatuslineFixture(
  dir: string,
  id: string,
  statuslineLiteral: string,
): string {
  const modPath = join(dir, `${id}.config.mjs`);
  const distUrl = pathToFileURL(DIST_INDEX).href;
  const source = `
import { defineConnector } from ${JSON.stringify(distUrl)};

export default defineConnector({
  id: ${JSON.stringify(id)},
  statusline: ${statuslineLiteral},
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

  // A connector with a per-host render override on claude-code and a DIFFERENT
  // top-level render: claude-code renders the per-host line; any other host
  // falls back to the top-level line.
  const hostsPath = writeStatuslineFixture(
    tmpData,
    HOSTS_ID,
    `{
      render: () => "TOP-LEVEL",
      hosts: { "claude-code": { render: () => "HOST-SPECIFIC" } },
    }`,
  );
  const hostsConn = (await loadConnectorFromPath(hostsPath)).connector;
  registerConnector(hostsConn, hostsPath);

  // A connector whose hosts: map targets codex (a registered, valid id) but NOT
  // claude-code; rendering on claude-code must FALL BACK to the top-level render.
  const fallbackPath = writeStatuslineFixture(
    tmpData,
    FALLBACK_ID,
    `{
      render: () => "TOP-LEVEL-FALLBACK",
      hosts: { "codex": { render: () => "CODEX-ONLY" } },
    }`,
  );
  const fallbackConn = (await loadConnectorFromPath(fallbackPath)).connector;
  registerConnector(fallbackConn, fallbackPath);

  // A render that reads ctx.capabilities.supportsStatusline — proves the
  // adapter populated capabilities on the runtime statusline path.
  const capsPath = writeFixtureModule(
    tmpData,
    CAPS_ID,
    "(ctx) => `caps=${ctx.capabilities?.supportsStatusline === true}`",
  );
  const capsConn = (await loadConnectorFromPath(capsPath)).connector;
  registerConnector(capsConn, capsPath);

  // A render that echoes ctx.scope — registered at scope "project" so the
  // runtime stamps it from the metadata onto the ctx.
  const scopePath = writeFixtureModule(
    tmpData,
    SCOPE_ID,
    "(ctx) => `scope=${ctx.scope}`",
  );
  const scopeConn = (await loadConnectorFromPath(scopePath)).connector;
  registerConnector(scopeConn, scopePath, "project");

  // A connector whose TOP-LEVEL render is fine but whose PER-HOST claude-code
  // render THROWS — the per-host selection sits inside the try, so a per-host
  // throw must degrade fail-safe (exit 0, empty), exactly like a top-level throw.
  const perHostThrowPath = writeStatuslineFixture(
    tmpData,
    PERHOST_THROW_ID,
    `{
      render: () => "TOP-OK",
      hosts: { "claude-code": { render: () => { throw new Error("per-host boom"); } } },
    }`,
  );
  const perHostThrowConn = (await loadConnectorFromPath(perHostThrowPath)).connector;
  registerConnector(perHostThrowConn, perHostThrowPath);
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

  it("per-host render WINS over the top-level render on the named host", async () => {
    // claude-code IS in the hosts: map → renders the host-specific line, not the
    // top-level one.
    const res = await runStatusline({
      platformId: "claude-code",
      connectorId: HOSTS_ID,
      stdin: JSON.stringify({ cwd: "/x" }),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("HOST-SPECIFIC");
  });

  it("falls back to the top-level render on a host NOT in the hosts: map", async () => {
    // The map targets codex only; rendering on claude-code falls back to the
    // top-level render (claude-code is the only statusline-capable host today,
    // so it stands in for "an unlisted host" against a codex-keyed map).
    const res = await runStatusline({
      platformId: "claude-code",
      connectorId: FALLBACK_ID,
      stdin: JSON.stringify({ cwd: "/x" }),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("TOP-LEVEL-FALLBACK");
  });

  it("populates ctx.capabilities so render can read supportsStatusline", async () => {
    const res = await runStatusline({
      platformId: "claude-code",
      connectorId: CAPS_ID,
      stdin: JSON.stringify({ cwd: "/x" }),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("caps=true");
  });

  it("populates ctx.scope from the registered metadata (install at scope 'project')", async () => {
    const res = await runStatusline({
      platformId: "claude-code",
      connectorId: SCOPE_ID,
      stdin: JSON.stringify({ cwd: "/x" }),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("scope=project");
  });

  it("FAIL-SAFE: a throwing PER-HOST render degrades to exit 0, no stdout", async () => {
    // The per-host render (claude-code) throws; per-host selection is inside the
    // try, so it must fail-safe exactly like a top-level throw — never partial,
    // never the top-level "TOP-OK".
    const res = await runStatusline({
      platformId: "claude-code",
      connectorId: PERHOST_THROW_ID,
      stdin: JSON.stringify({ cwd: "/x" }),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBeUndefined();
  });
});
