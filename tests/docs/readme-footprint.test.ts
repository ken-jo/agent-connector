/**
 * README footprint facts — the efficiency numbers the README quotes are
 * MEASURED here, not typed in.
 *
 * What this measures: the runnable example connector (`examples/acme-db`,
 * one `defineConnector()` config) installed through its own branded bin into
 * an isolated HOME, once per registered host, at user scope and then at
 * project scope. The count is the set of files that appeared or changed on
 * that disk — exactly what a user's machine receives — with framework state
 * kept out of the count by pointing AGENT_CONNECTOR_DATA_DIR elsewhere.
 *
 * Why spawn the real bin instead of calling installConnector() in-process:
 * the example config imports `@ken-jo/agent-connector/sdk` from the BUILT
 * package, and the package metadata that derives the connector id is held in
 * module state — an in-process call from vitest's transformed `src/` would
 * hold a different instance of that state and fail to load the example. The
 * bin is also the reproducible path: `npm run measure:footprint` prints the
 * same JSON this test asserts on.
 *
 * Every number the README quotes from this measurement is pinned below, so a
 * new adapter, a new surface, or a changed example config breaks this test
 * rather than leaving the README stale.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";

const EXAMPLE_BIN = join(process.cwd(), "examples", "acme-db", "bin.mjs");
const EXAMPLE_CONFIG = join(process.cwd(), "examples", "acme-db", "agent-connector.config.mjs");

type Snapshot = Map<string, string>;

function walk(root: string, out: Snapshot): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else out.set(full, `${st.size}:${st.mtimeMs}`);
  }
}

function snapshot(roots: string[]): Snapshot {
  const out: Snapshot = new Map();
  for (const r of roots) walk(r, out);
  return out;
}

/** Paths that appeared or changed between two snapshots. */
function touched(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  for (const [path, sig] of after) {
    if (before.get(path) !== sig) out.push(path);
  }
  return out.sort();
}

export interface FootprintScope {
  /** Hosts that received at least one file at this scope. */
  hosts: number;
  /** Distinct files that appeared or changed, across all hosts. */
  files: number;
  /** Distinct file extensions among those files — the formats a hand-maintained port has to speak. */
  formats: string[];
  perHost: Record<string, number>;
}

export interface Footprint {
  registryHosts: number;
  configLines: number;
  user: FootprintScope;
  project: FootprintScope;
}

function measureScope(
  scope: "user" | "project",
  home: string,
  data: string,
  projectDir: string,
): FootprintScope {
  const roots = [home];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    AGENT_CONNECTOR_DATA_DIR: data,
  };
  delete env.CODEX_HOME;
  delete env.XDG_DATA_HOME;
  delete env.AGENT_CONNECTOR_TELEMETRY;

  const all = new Set<string>();
  const perHost: Record<string, number> = {};
  for (const factory of ADAPTER_REGISTRY) {
    const before = snapshot(roots);
    const run = spawnSync(
      process.execPath,
      [EXAMPLE_BIN, "install", "--scope", scope, "--targets", factory.id, "--project", projectDir, "--quiet"],
      { env, encoding: "utf8", cwd: projectDir },
    );
    // A host that cannot take a surface reports it as a warning and exits
    // non-zero; that is expected here. A crash is not.
    expect(run.error, `${factory.id}: spawn failed`).toBeUndefined();
    expect(run.status, `${factory.id}: install crashed:\n${run.stderr}`).not.toBeNull();
    const files = touched(before, snapshot(roots));
    perHost[factory.id] = files.length;
    for (const f of files) all.add(f);
  }
  // Extensionless files (an action script named after the action) carry no
  // format signal, so they do not count toward the format tally.
  const formats = [...new Set([...all].map((f) => extname(f)).filter((e) => e !== ""))].sort();
  return {
    hosts: Object.values(perHost).filter((n) => n > 0).length,
    files: all.size,
    formats,
    perHost,
  };
}

export function measureFootprint(): Footprint {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ac-footprint-home-")));
  const data = realpathSync.native(mkdtempSync(join(tmpdir(), "ac-footprint-data-")));
  const projectDir = join(home, "project");
  mkdirSync(projectDir, { recursive: true });
  try {
    const user = measureScope("user", home, data, projectDir);
    // projectDir sits inside HOME, so the same walk sees project-scope files.
    const project = measureScope("project", home, data, projectDir);
    // `wc -l` semantics, so a reader can check the number with one command.
    const configLines = (readFileSync(EXAMPLE_CONFIG, "utf8").match(/\n/g) ?? []).length;
    return { registryHosts: ADAPTER_REGISTRY.length, configLines, user, project };
  } finally {
    for (const d of [home, data]) rmSync(d, { recursive: true, force: true });
  }
}

/** The README quotes these; keep the literal shape in sync with the README. */
function readmeClaims(readme: string):
  | { hosts: number; configLines: number; userFiles: number; userHosts: number; formats: number; projectFiles: number }
  | undefined {
  const m = readme.match(
    /one (\d+)-line `defineConnector\(\)` → \*\*(\d+) host-native files\*\* in (\d+) file extensions across (\d+) of (\d+) hosts at user scope \((\d+) at project scope\)/,
  );
  if (!m) return undefined;
  return {
    configLines: Number(m[1]),
    userFiles: Number(m[2]),
    formats: Number(m[3]),
    userHosts: Number(m[4]),
    hosts: Number(m[5]),
    projectFiles: Number(m[6]),
  };
}

const posix = process.platform !== "win32";

describe.skipIf(!posix)("README footprint facts are measured, not typed", () => {
  let fp: Footprint;
  beforeAll(() => {
    fp = measureFootprint();
    // Printed so `npm run measure:footprint` doubles as the reproduction step.
    console.log(`[footprint] ${JSON.stringify({ ...fp, user: { ...fp.user, perHost: undefined }, project: { ...fp.project, perHost: undefined } })}`);
    console.log(`[footprint] per-host user-scope: ${JSON.stringify(fp.user.perHost)}`);
    console.log(`[footprint] per-host project-scope: ${JSON.stringify(fp.project.perHost)}`);
  }, 180_000);

  it("every registered host takes the example at one scope or the other", () => {
    for (const factory of ADAPTER_REGISTRY) {
      const n = (fp.user.perHost[factory.id] ?? 0) + (fp.project.perHost[factory.id] ?? 0);
      expect(n, `${factory.id} received no file at either scope`).toBeGreaterThan(0);
    }
  });

  it("README quotes exactly the measured numbers", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    const claims = readmeClaims(readme);
    expect(claims, "README footprint sentence not found — keep its literal shape in sync with readmeClaims()").toBeDefined();
    expect(claims).toEqual({
      configLines: fp.configLines,
      userFiles: fp.user.files,
      formats: fp.user.formats.length,
      userHosts: fp.user.hosts,
      hosts: fp.registryHosts,
      projectFiles: fp.project.files,
    });
  });
});
