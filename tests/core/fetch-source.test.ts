/**
 * core/fetch-source — remote GitHub connector source resolution.
 *
 * Three concerns, all hermetic (no network / no real github.com):
 *   1. SPEC PARSING — classifySource / parseRemoteSource over every supported
 *      GitHub form, and the guarantee that local paths are NOT misclassified.
 *   2. PACKAGE GATE — resolveRemoteSource with an injected Fetcher that writes a
 *      dest dir with NO agent-connector.config → the clear "not an
 *      agent-connector connector" error.
 *   3. INTEGRATION — resolveRemoteSource cloning from a LOCAL `file://` git repo
 *      fixture (real `git clone`, no network) → resolves the config + connector.
 *
 * Env isolation: AGENT_CONNECTOR_DATA_DIR is repointed at a fresh temp dir per
 * test (the source cache lives under it) and restored after; every temp dir is
 * removed in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  classifySource,
  describeRemote,
  isSafeRef,
  looksLocal,
  makeGitFetcher,
  parseGitUrl,
  parseRemoteSource,
  resolveRemoteSource,
  sourceCacheDir,
  type Fetcher,
  type RemoteSource,
} from "../../src/core/fetch-source.js";
import { tempDir } from "../support/env.js";

// ── Env isolation (the source cache lives under AGENT_CONNECTOR_DATA_DIR). ───
let savedDataDir: string | undefined;
const cleanup: string[] = [];

beforeEach(() => {
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  const data = tempDir("ac-fetch-data-");
  cleanup.push(data);
  process.env.AGENT_CONNECTOR_DATA_DIR = data;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.AGENT_CONNECTOR_DATA_DIR;
  else process.env.AGENT_CONNECTOR_DATA_DIR = savedDataDir;
  for (const d of cleanup.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Spec parsing.
// ═══════════════════════════════════════════════════════════════════════════
describe("parseRemoteSource — GitHub spec forms", () => {
  it("owner/repo", () => {
    expect(parseRemoteSource("ken-jo/agent-connector")).toEqual({
      owner: "ken-jo",
      repo: "agent-connector",
    });
  });

  it("owner/repo#ref (branch/tag/sha)", () => {
    expect(parseRemoteSource("ken-jo/agent-connector#v1.2.3")).toEqual({
      owner: "ken-jo",
      repo: "agent-connector",
      ref: "v1.2.3",
    });
  });

  it("owner/repo/subpath", () => {
    expect(parseRemoteSource("ken-jo/agent-connector/packages/db")).toEqual({
      owner: "ken-jo",
      repo: "agent-connector",
      subpath: "packages/db",
    });
  });

  it("owner/repo/subpath#ref", () => {
    expect(parseRemoteSource("ken-jo/agent-connector/packages/db#main")).toEqual({
      owner: "ken-jo",
      repo: "agent-connector",
      ref: "main",
      subpath: "packages/db",
    });
  });

  it("github:owner/repo shorthand", () => {
    expect(parseRemoteSource("github:ken-jo/agent-connector")).toEqual({
      owner: "ken-jo",
      repo: "agent-connector",
    });
  });

  it("https://github.com/owner/repo (and .git suffix)", () => {
    expect(parseRemoteSource("https://github.com/ken-jo/agent-connector")).toEqual({
      owner: "ken-jo",
      repo: "agent-connector",
    });
    expect(parseRemoteSource("https://github.com/ken-jo/agent-connector.git")).toEqual({
      owner: "ken-jo",
      repo: "agent-connector",
    });
  });

  it("https://github.com/owner/repo/tree/<ref>/<subpath>", () => {
    expect(
      parseRemoteSource("https://github.com/ken-jo/agent-connector/tree/dev/packages/db"),
    ).toEqual({
      owner: "ken-jo",
      repo: "agent-connector",
      ref: "dev",
      subpath: "packages/db",
    });
  });

  it("https github URL with a #ref fragment", () => {
    expect(
      parseRemoteSource("https://github.com/ken-jo/agent-connector#release"),
    ).toEqual({ owner: "ken-jo", repo: "agent-connector", ref: "release" });
  });

  it("git@github.com:owner/repo.git", () => {
    expect(parseRemoteSource("git@github.com:ken-jo/agent-connector.git")).toEqual({
      owner: "ken-jo",
      repo: "agent-connector",
    });
  });

  it("git@github.com:owner/repo#ref", () => {
    expect(parseRemoteSource("git@github.com:ken-jo/agent-connector#tag1")).toEqual({
      owner: "ken-jo",
      repo: "agent-connector",
      ref: "tag1",
    });
  });

  it("rejects a non-github https host", () => {
    expect(parseRemoteSource("https://gitlab.com/ken-jo/agent-connector")).toBeNull();
  });

  it("rejects a single-segment value (no repo)", () => {
    expect(parseRemoteSource("just-a-word")).toBeNull();
  });

  it("rejects dot-segment owner/repo and subpath traversal", () => {
    expect(parseRemoteSource("../repo/name")).toBeNull();
    expect(parseRemoteSource("owner/../x")).toBeNull();
    expect(parseRemoteSource("owner/repo/../../x")).toBeNull();
    expect(parseRemoteSource("github:owner/repo/../../x")).toBeNull();
    expect(parseRemoteSource("git@github.com:../repo.git")).toBeNull();
  });
});

describe("looksLocal / classifySource — local paths are NOT remote", () => {
  it.each([
    "./connector",
    "../sibling/connector",
    ".",
    "/abs/path/agent-connector.config.mjs",
    "~/dev/connector",
  ])("classifies %s as local", (p) => {
    expect(looksLocal(p)).toBe(true);
    const spec = classifySource(p);
    expect(spec?.kind).toBe("local");
  });

  it("an EXISTING directory (no path sigil) is local, not remote", () => {
    const dir = tempDir("ac-fetch-localdir-");
    cleanup.push(dir);
    // `tmp/x` style: bare name that happens to exist → must be LOCAL.
    expect(looksLocal(dir)).toBe(true);
    expect(classifySource(dir)?.kind).toBe("local");
  });

  it("a Windows-style drive path is local", () => {
    expect(looksLocal("C:\\Users\\me\\connector")).toBe(true);
    expect(looksLocal("C:/Users/me/connector")).toBe(true);
  });

  it("a bare owner/repo (non-existent on disk) is remote", () => {
    const spec = classifySource("ken-jo/agent-connector");
    expect(spec?.kind).toBe("remote");
    expect(spec?.kind === "remote" && spec.remote.owner).toBe("ken-jo");
  });

  it("an unrecognized non-local value is null (neither local nor remote)", () => {
    expect(classifySource("not a source at all !!!")).toBeNull();
  });
});

describe("parseGitUrl — raw clone URLs (file://, ssh, scp)", () => {
  it("file:// URL is a clone URL (and classifies as remote)", () => {
    const r = parseGitUrl("file:///tmp/some/repo");
    expect(r?.cloneUrl).toBe("file:///tmp/some/repo");
    expect(classifySource("file:///tmp/some/repo")?.kind).toBe("remote");
  });

  it("file:// URL carries a #ref", () => {
    expect(parseGitUrl("file:///tmp/repo#dev")).toMatchObject({
      cloneUrl: "file:///tmp/repo",
      ref: "dev",
    });
  });

  it("ssh:// URL is a clone URL", () => {
    expect(parseGitUrl("ssh://git@example.com/me/repo.git")?.cloneUrl).toBe(
      "ssh://git@example.com/me/repo.git",
    );
  });

  it("a non-github scp URL (git@host:owner/repo) is a clone URL", () => {
    expect(parseGitUrl("git@gitlab.com:me/repo.git")?.cloneUrl).toBe(
      "git@gitlab.com:me/repo.git",
    );
  });

  it("a bare owner/repo is NOT a raw clone URL", () => {
    expect(parseGitUrl("ken-jo/agent-connector")).toBeNull();
  });
});

describe("sourceCacheDir — stable, collision-free", () => {
  it("keys github sources by owner__repo[__ref] under sources/", () => {
    const noRef = sourceCacheDir({ owner: "ken-jo", repo: "agent-connector" });
    expect(noRef.endsWith(join("sources", "ken-jo__agent-connector"))).toBe(true);
    const withRef = sourceCacheDir({ owner: "ken-jo", repo: "agent-connector", ref: "v1" });
    expect(withRef.endsWith(join("sources", "ken-jo__agent-connector__v1"))).toBe(true);
  });

  it("disambiguates two raw file:// repos with the same basename", () => {
    const a = sourceCacheDir({ owner: "x", repo: "repo", cloneUrl: "file:///a/repo" });
    const b = sourceCacheDir({ owner: "x", repo: "repo", cloneUrl: "file:///b/repo" });
    expect(a).not.toBe(b);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Package gate — injected fetcher, NO agent-connector.config in the dest.
// ═══════════════════════════════════════════════════════════════════════════
describe("resolveRemoteSource — package gate", () => {
  it("throws a clear error when the fetched repo has NO agent-connector.config", async () => {
    // A fetcher that 'fetches' a repo with only a README (no connector config).
    const fetcher: Fetcher = (_remote, dest) => {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "README.md"), "# not a connector\n", "utf8");
      writeFileSync(join(dest, "package.json"), JSON.stringify({ name: "x" }), "utf8");
    };
    const remote: RemoteSource = { owner: "someone", repo: "not-a-connector" };

    await expect(resolveRemoteSource(remote, { fetcher })).rejects.toThrow(
      /is not an agent-connector connector/,
    );
    await expect(resolveRemoteSource(remote, { fetcher })).rejects.toThrow(
      /defineConnector/,
    );
  });

  it("error label reflects the remote spec (owner/repo#ref)", async () => {
    const fetcher: Fetcher = (_remote, dest) => {
      mkdirSync(dest, { recursive: true });
    };
    const remote: RemoteSource = { owner: "a", repo: "b", ref: "main" };
    await expect(resolveRemoteSource(remote, { fetcher })).rejects.toThrow(/a\/b#main/);
  });

  it("subpath that does not exist gives a clear error", async () => {
    const fetcher: Fetcher = (_remote, dest) => {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "README.md"), "x", "utf8");
    };
    const remote: RemoteSource = { owner: "a", repo: "b", subpath: "does/not/exist" };
    await expect(resolveRemoteSource(remote, { fetcher })).rejects.toThrow(
      /subpath "does\/not\/exist" does not exist/,
    );
  });

  it("resolves a JSON config the injected fetcher writes (server-only connector)", async () => {
    const fetcher: Fetcher = (_remote, dest) => {
      mkdirSync(dest, { recursive: true });
      writeFileSync(
        join(dest, "agent-connector.config.json"),
        JSON.stringify({
          id: "stub-connector",
          version: "1.0.0",
          server: { transport: "stdio", command: "npx", args: ["-y", "@stub/mcp"] },
        }),
        "utf8",
      );
    };
    const remote: RemoteSource = { owner: "stub", repo: "stub-connector" };
    const resolved = await resolveRemoteSource(remote, { fetcher });
    expect(resolved.connector.id).toBe("stub-connector");
    expect(resolved.configPath.endsWith("agent-connector.config.json")).toBe(true);
    expect(existsSync(resolved.sourceDir)).toBe(true);
  });

  it("honors a subpath when locating the config", async () => {
    const fetcher: Fetcher = (_remote, dest) => {
      const sub = join(dest, "packages", "db");
      mkdirSync(sub, { recursive: true });
      writeFileSync(
        join(sub, "agent-connector.config.json"),
        JSON.stringify({
          id: "db-connector",
          version: "2.0.0",
          server: { transport: "stdio", command: "npx", args: ["-y", "@db/mcp"] },
        }),
        "utf8",
      );
    };
    const remote: RemoteSource = { owner: "x", repo: "y", subpath: "packages/db" };
    const resolved = await resolveRemoteSource(remote, { fetcher });
    expect(resolved.connector.id).toBe("db-connector");
    expect(resolved.connectorDir.endsWith(join("packages", "db"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Integration — clone from a LOCAL file:// git repo (real git, no network).
// ═══════════════════════════════════════════════════════════════════════════
describe("resolveRemoteSource — local file:// git clone (no network)", () => {
  /** git init a temp dir with an agent-connector config + commit; return its
   *  file:// URL and the on-disk path. */
  function makeGitRepoFixture(configBasename: string, configBody: string): {
    repoDir: string;
    fileUrl: string;
  } {
    const repoDir = tempDir("ac-fetch-repo-");
    cleanup.push(repoDir);
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repoDir, configBasename), configBody, "utf8");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init connector"]);
    return { repoDir, fileUrl: pathToFileURL(repoDir).href };
  }

  it("clones a file:// repo and gates+loads its JSON connector", async () => {
    const { fileUrl } = makeGitRepoFixture(
      "agent-connector.config.json",
      JSON.stringify({
        id: "local-git-connector",
        version: "3.1.0",
        server: { transport: "stdio", command: "npx", args: ["-y", "@local/mcp"] },
      }),
    );

    const spec = classifySource(fileUrl);
    expect(spec?.kind).toBe("remote");
    const remote = (spec as { kind: "remote"; remote: RemoteSource }).remote;
    expect(remote.cloneUrl).toBe(fileUrl);

    // The real git fetcher clones the file:// URL verbatim (no network).
    const resolved = await resolveRemoteSource(remote, {
      fetcher: makeGitFetcher(),
    });
    expect(resolved.connector.id).toBe("local-git-connector");
    expect(resolved.connector.version).toBe("3.1.0");
    expect(resolved.connector.server).toBeDefined();
    // Persisted under the data-root source cache (stable, not a temp dir).
    expect(resolved.sourceDir).toBe(sourceCacheDir(remote));
    expect(existsSync(join(resolved.sourceDir, "agent-connector.config.json"))).toBe(true);
    // The config the install flow will load lives inside the persisted clone.
    expect(resolved.configPath.startsWith(resolved.sourceDir)).toBe(true);
  }, 15_000);

  it("a file:// repo WITHOUT a config fires the package gate", async () => {
    const repoDir = tempDir("ac-fetch-norepo-");
    cleanup.push(repoDir);
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
    git(["init", "-q"]);
    git(["config", "user.email", "t@e.com"]);
    git(["config", "user.name", "T"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repoDir, "README.md"), "# nope\n", "utf8");
    git(["add", "."]);
    git(["commit", "-q", "-m", "no connector"]);

    const remote = parseGitUrl(pathToFileURL(repoDir).href)!;
    await expect(
      resolveRemoteSource(remote, { fetcher: makeGitFetcher() }),
    ).rejects.toThrow(/is not an agent-connector connector/);
  }, 15_000);

  it("describeRemote labels a github spec and a raw clone URL", () => {
    expect(describeRemote({ owner: "a", repo: "b", ref: "x", subpath: "s" })).toBe(
      "a/b/s#x",
    );
    expect(describeRemote({ owner: "g", repo: "r", cloneUrl: "file:///tmp/r" })).toBe(
      "file:///tmp/r",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M1 regression — subpath containment must use path.relative, not a string
// prefix. A `..`-escaping subpath that resolves to a SIBLING dir sharing the
// cache-key prefix must THROW, never load a config outside the fetched dir.
// ═══════════════════════════════════════════════════════════════════════════
describe("resolveRemoteSource — subpath containment (M1)", () => {
  it("rejects a `../sibling` subpath even when the sibling shares the cache prefix", async () => {
    // The fetcher writes BOTH the fetched repo dir AND a sibling dir whose
    // absolute path STARTS WITH the fetched dir's path, then plants a valid
    // config in the sibling. A bare `startsWith()` containment check would treat
    // the sibling as 'inside' and load it; path.relative correctly rejects it.
    const fetcher: Fetcher = (_remote, dest) => {
      mkdirSync(dest, { recursive: true });
      const sibling = `${dest}-sibling`; // e.g. /…/x__y-sibling — prefix of dest
      mkdirSync(sibling, { recursive: true });
      writeFileSync(
        join(sibling, "agent-connector.config.json"),
        JSON.stringify({
          id: "evil-connector",
          version: "1.0.0",
          server: { transport: "stdio", command: "npx", args: ["-y", "@evil/mcp"] },
        }),
        "utf8",
      );
    };
    // The fetched dir is sourceCacheDir({owner:x,repo:y}); the sibling is that
    // path + "-sibling". Relative to the fetched dir that is `../<base>-sibling`.
    const remote: RemoteSource = { owner: "x", repo: "y" };
    const base = sourceCacheDir(remote).split(/[\\/]/).pop()!;
    const escaping: RemoteSource = { owner: "x", repo: "y", subpath: `../${base}-sibling` };
    await expect(resolveRemoteSource(escaping, { fetcher })).rejects.toThrow(
      /subpath escapes the fetched source/,
    );
  });

  it("rejects a plain `..` traversal subpath", async () => {
    const fetcher: Fetcher = (_remote, dest) => {
      mkdirSync(dest, { recursive: true });
    };
    const remote: RemoteSource = { owner: "a", repo: "b", subpath: "../../etc" };
    await expect(resolveRemoteSource(remote, { fetcher })).rejects.toThrow(
      /subpath escapes the fetched source/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L1 — ref validation: an attacker-shaped ref (leading dash / git-flag) must be
// rejected at PARSE time, never reaching `git clone --branch`.
// ═══════════════════════════════════════════════════════════════════════════
describe("ref validation (L1)", () => {
  it("isSafeRef accepts ordinary branch/tag/sha names", () => {
    for (const ok of ["main", "v1.2.3", "feature/x", "release-1", "abc123def"]) {
      expect(isSafeRef(ok)).toBe(true);
    }
  });

  it("isSafeRef rejects a leading-dash (git-flag-shaped) ref and empties", () => {
    for (const bad of ["--upload-pack=x", "-x", "", "a b", "a;rm -rf", "a$(x)"]) {
      expect(isSafeRef(bad)).toBe(false);
    }
  });

  it("parseRemoteSource rejects owner/repo#<unsafe-ref> (returns null, not passed to git)", () => {
    expect(parseRemoteSource("ken-jo/agent-connector#--upload-pack=evil")).toBeNull();
    expect(parseRemoteSource("ken-jo/agent-connector#-x")).toBeNull();
  });

  it("a github URL with an unsafe #ref fragment is rejected", () => {
    expect(
      parseRemoteSource("https://github.com/ken-jo/agent-connector#--evil"),
    ).toBeNull();
  });

  it("parseGitUrl rejects a file:// URL with an unsafe #ref", () => {
    expect(parseGitUrl("file:///tmp/repo#--upload-pack=evil")).toBeNull();
  });

  it("classifySource returns null for an unsafe-ref owner/repo (neither local nor remote)", () => {
    expect(classifySource("ken-jo/agent-connector#--evil")).toBeNull();
  });
});
