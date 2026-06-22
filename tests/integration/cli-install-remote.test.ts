/**
 * integration/cli-install-remote — `install <remote-source>` over the BUILT bin.
 *
 * Drives the PROCESS boundary (`node dist/cli.js install …`) exactly as a user
 * would, against a LOCAL `file://` git repo fixture (real `git clone`, NO
 * network/github). It proves the remote-source path end-to-end:
 *
 *   1. install <file://-fixture> --dry-run → fetch + package-GATE + a real
 *      install plan for claude-code + codex, persisted under a STABLE source
 *      cache dir below the data-root (not a temp dir).
 *   2. install <file://-fixture-with-no-config> → the clear "not an
 *      agent-connector connector" gate error (exit non-zero).
 *   3. install <source> --connector <x> → the ambiguity refusal (EITHER…OR).
 *
 * Isolation mirrors cli-install-smoke: each child gets HOME / USERPROFILE /
 * AGENT_CONNECTOR_DATA_DIR / XDG roots pointed at fresh temp dirs (tempDir is
 * Windows 8.3 short-name safe). dist is a committed-or-built-once prerequisite.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

import { tempDir } from "../support/env.js";

const REPO_ROOT = join(__dirname, "..", "..");
const DIST_CLI = join(REPO_ROOT, "dist", "cli.js");

let tmpHome: string;
let tmpData: string;
let tmpCfg: string;
const cleanup: string[] = [];

beforeAll(() => {
  if (!existsSync(DIST_CLI)) {
    execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "ignore" });
  }
}, 180_000);

beforeEach(() => {
  tmpHome = tempDir("ac-remote-home-");
  tmpData = tempDir("ac-remote-data-");
  tmpCfg = tempDir("ac-remote-cfg-");
  cleanup.push(tmpHome, tmpData, tmpCfg);
});

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.HOME = tmpHome;
  env.USERPROFILE = tmpHome;
  env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  env.XDG_DATA_HOME = join(tmpHome, ".local", "share");
  env.XDG_CONFIG_HOME = join(tmpHome, ".config");
  env.CLAUDE_CONFIG_DIR = tmpCfg;
  delete env.AGENT_CONNECTOR_TELEMETRY;
  return env;
}

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [DIST_CLI, ...args], {
    encoding: "utf8",
    env: childEnv(),
  });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** git init a temp dir with `agent-connector.config.json` (npx server) + commit;
 *  return the file:// URL. JSON config keeps it dist-import-free and hermetic. */
function makeConnectorRepo(): string {
  const repoDir = tempDir("ac-remote-repo-");
  cleanup.push(repoDir);
  const git = (a: string[]) => execFileSync("git", a, { cwd: repoDir, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@e.com"]);
  git(["config", "user.name", "T"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(
    join(repoDir, "agent-connector.config.json"),
    JSON.stringify({
      id: "remote-smoke-connector",
      displayName: "Remote Smoke Connector",
      version: "9.9.9",
      server: { transport: "stdio", command: "npx", args: ["-y", "@remote/mcp"] },
    }),
    "utf8",
  );
  git(["add", "."]);
  git(["commit", "-q", "-m", "remote connector"]);
  return pathToFileURL(repoDir).href;
}

/** git init a temp dir with NO connector config + commit; return the file:// URL. */
function makeNoConfigRepo(): string {
  const repoDir = tempDir("ac-remote-norepo-");
  cleanup.push(repoDir);
  const git = (a: string[]) => execFileSync("git", a, { cwd: repoDir, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@e.com"]);
  git(["config", "user.name", "T"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoDir, "README.md"), "# no connector here\n", "utf8");
  git(["add", "."]);
  git(["commit", "-q", "-m", "no connector"]);
  return pathToFileURL(repoDir).href;
}

describe("cli install <remote-source> (built dist/cli.js, file:// git fixture)", () => {
  it("fetches + GATES + plans an install for claude-code,codex (dry-run)", () => {
    const projectDir = tempDir("ac-remote-proj-");
    cleanup.push(projectDir);
    const fileUrl = makeConnectorRepo();

    const { code, stdout } = runCli([
      "install",
      fileUrl,
      "--dry-run",
      "--targets",
      "claude-code,codex",
      "--project",
      projectDir,
    ]);

    expect(code).toBe(0);
    // The connector id was resolved from the fetched repo (gate passed).
    expect(stdout).toContain('install "remote-smoke-connector"');
    expect(stdout).toContain("(dry-run — nothing written)");
    // A real plan for BOTH targets.
    expect(stdout).toContain("[claude-code]");
    expect(stdout).toContain("[codex]");
    expect(stdout).toMatch(/mcp_?[sS]ervers\.remote-smoke-connector/);

    // Path stability: persisted under a STABLE source cache dir below the
    // data-root, NOT a temp dir.
    const sourcesRoot = join(tmpData, "sources");
    expect(existsSync(sourcesRoot)).toBe(true);
    const cached = readdirSync(sourcesRoot);
    expect(cached.length).toBe(1);
    expect(
      existsSync(join(sourcesRoot, cached[0]!, "agent-connector.config.json")),
    ).toBe(true);
  });

  it("a repo WITHOUT a connector config fails the package gate with a clear error", () => {
    const fileUrl = makeNoConfigRepo();
    const { code, stderr } = runCli([
      "install",
      fileUrl,
      "--dry-run",
      "--targets",
      "claude-code",
    ]);

    expect(code).not.toBe(0);
    expect(stderr).toContain("is not an agent-connector connector");
    expect(stderr).toContain("defineConnector");
  });

  it("a positional <source> AND --connector together is refused (EITHER…OR)", () => {
    const fileUrl = makeConnectorRepo();
    const { code, stderr } = runCli([
      "install",
      fileUrl,
      "--connector",
      "owner/other",
      "--dry-run",
      "--targets",
      "claude-code",
    ]);

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/EITHER .* OR/);
  });
});
