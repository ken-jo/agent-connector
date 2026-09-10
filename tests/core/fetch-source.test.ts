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
  parseArchiveSource,
  parseGitUrl,
  parseNpmSource,
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

describe("parseNpmSource / parseArchiveSource — registry and tarball specs", () => {
  it("parses npm:<package> and npm:<package>@version", () => {
    expect(parseNpmSource("npm:acme-db-mcp")).toMatchObject({
      sourceKind: "npm",
      packageName: "acme-db-mcp",
      packageSpec: "acme-db-mcp",
    });
    expect(parseNpmSource("npm:@acme/acme-db-mcp@1.2.3")).toMatchObject({
      sourceKind: "npm",
      packageName: "@acme/acme-db-mcp",
      packageSpec: "@acme/acme-db-mcp@1.2.3",
    });
  });

  it("rejects npm specs that could be npm flags or malformed names", () => {
    expect(parseNpmSource("npm:--registry=https://evil")).toBeNull();
    expect(parseNpmSource("npm:@scope")).toBeNull();
    expect(parseNpmSource("npm:bad name")).toBeNull();
  });

  it("classifies npm:<package> as a remote source", () => {
    const spec = classifySource("npm:@acme/acme-db-mcp@latest");
    expect(spec?.kind).toBe("remote");
    expect(spec?.kind === "remote" && spec.remote.sourceKind).toBe("npm");
  });

  it("parses explicit archive: sources and direct tarball paths/URLs", () => {
    expect(parseArchiveSource("archive:https://example.com/acme.tgz")).toMatchObject({
      sourceKind: "archive",
      archiveUrl: "https://example.com/acme.tgz",
      repo: "acme",
    });
    expect(parseArchiveSource("https://example.com/acme.tar.gz")).toMatchObject({
      sourceKind: "archive",
      archiveUrl: "https://example.com/acme.tar.gz",
      repo: "acme",
    });
    expect(parseArchiveSource("./acme.tgz")).toMatchObject({
      sourceKind: "archive",
      archiveUrl: "./acme.tgz",
      repo: "acme",
    });
  });

  it("parses a direct .zip path/URL as an archive (never a git clone URL)", () => {
    expect(parseArchiveSource("https://example.com/dl/acme.zip?token=1")).toMatchObject({
      sourceKind: "archive",
      archiveUrl: "https://example.com/dl/acme.zip?token=1",
      repo: "acme",
    });
    expect(parseArchiveSource("./acme.zip")).toMatchObject({ sourceKind: "archive", repo: "acme" });
    const spec = classifySource("https://example.com/dl/acme.zip");
    expect(spec?.kind).toBe("remote");
    expect(spec?.kind === "remote" && spec.remote.sourceKind).toBe("archive");
    expect(parseGitUrl("https://example.com/dl/acme.zip")).not.toBeNull(); // would misroute without the archive branch
  });

  it("keeps a non-tarball file:// URL as a raw git clone URL", () => {
    expect(parseArchiveSource("file:///tmp/repo")).toBeNull();
    expect(classifySource("file:///tmp/repo")?.kind).toBe("remote");
    expect(parseGitUrl("file:///tmp/repo")?.cloneUrl).toBe("file:///tmp/repo");
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

  it("keys npm and archive sources by kind + hash", () => {
    const npm = sourceCacheDir(parseNpmSource("npm:@acme/acme-db-mcp@1.0.0")!);
    expect(npm).toContain(join("sources", "npm__"));
    const archive = sourceCacheDir(parseArchiveSource("archive:https://example.com/acme.tgz")!);
    expect(archive).toContain(join("sources", "archive__acme__"));
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

  it("resolves an npm: source through the same package gate with an injected fetcher", async () => {
    const fetcher: Fetcher = (_remote, dest) => {
      mkdirSync(dest, { recursive: true });
      writeFileSync(
        join(dest, "agent-connector.config.json"),
        JSON.stringify({
          id: "npm-connector",
          version: "1.0.0",
          server: { transport: "stdio", command: "npx", args: ["-y", "@npm/mcp"] },
        }),
        "utf8",
      );
    };
    const remote = parseNpmSource("npm:@acme/npm-connector@1.0.0")!;
    const resolved = await resolveRemoteSource(remote, { fetcher });
    expect(resolved.connector.id).toBe("npm-connector");
    expect(describeRemote(remote)).toBe("npm:@acme/npm-connector@1.0.0");
  });

  it("resolves an archive source through the same package gate with an injected fetcher", async () => {
    const fetcher: Fetcher = (_remote, dest) => {
      mkdirSync(dest, { recursive: true });
      writeFileSync(
        join(dest, "agent-connector.config.json"),
        JSON.stringify({
          id: "archive-connector",
          version: "1.0.0",
          server: { transport: "stdio", command: "node", args: ["server.mjs"] },
        }),
        "utf8",
      );
    };
    const remote = parseArchiveSource("archive:https://example.com/archive-connector.tgz")!;
    const resolved = await resolveRemoteSource(remote, { fetcher });
    expect(resolved.connector.id).toBe("archive-connector");
    expect(describeRemote(remote)).toBe("archive:https://example.com/archive-connector.tgz");
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
// 4. Integration — extract a LOCAL zip archive with the default fetcher
//    (real unzip / bsdtar, no network). The zip is built in-process (stored
//    entries + CRC-32) so the fixture needs no zip CLI on the test box.
// ═══════════════════════════════════════════════════════════════════════════
describe("resolveRemoteSource — local .zip archive (no network)", () => {
  const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  /** Minimal stored (method 0) zip writer: local headers + central directory + EOCD. */
  function buildZip(files: Record<string, string>): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
      const nameBuf = Buffer.from(name, "utf8");
      const data = Buffer.from(text, "utf8");
      const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0, 6); // flags
      local.writeUInt16LE(0, 8); // method: stored
      local.writeUInt16LE(0, 10); // mtime
      local.writeUInt16LE(0x21, 12); // mdate (1980-01-01)
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4); // version made by
      central.writeUInt16LE(20, 6); // version needed
      central.writeUInt16LE(0, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt16LE(0, 12);
      central.writeUInt16LE(0x21, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt16LE(0, 30); // extra
      central.writeUInt16LE(0, 32); // comment
      central.writeUInt16LE(0, 34); // disk
      central.writeUInt16LE(0, 36); // internal attrs
      central.writeUInt32LE(0, 38); // external attrs
      central.writeUInt32LE(offset, 42);
      locals.push(local, nameBuf, data);
      centrals.push(central, nameBuf);
      offset += local.length + nameBuf.length + data.length;
    }
    const cdSize = centrals.reduce((n, b) => n + b.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(centrals.length / 2, 8);
    eocd.writeUInt16LE(centrals.length / 2, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...locals, ...centrals, eocd]);
  }
  const config = (id: string) =>
    JSON.stringify({
      id,
      version: "1.0.0",
      server: { transport: "stdio", command: "node", args: ["server.mjs"] },
    });

  it("extracts a zip nested under one top dir and loads the connector", async () => {
    const dir = tempDir("ac-fetch-zip-");
    cleanup.push(dir);
    const zipPath = join(dir, "zip-connector.zip");
    writeFileSync(
      zipPath,
      buildZip({
        "zip-connector-1.0.0/agent-connector.config.json": config("zip-connector"),
        "zip-connector-1.0.0/README.md": "# zip\n",
      }),
    );
    const remote = parseArchiveSource(zipPath)!;
    expect(remote.sourceKind).toBe("archive");
    const resolved = await resolveRemoteSource(remote);
    expect(resolved.connector.id).toBe("zip-connector");
    // Flattened: the config sits at the cache root, not under the top dir.
    expect(existsSync(join(sourceCacheDir(remote), "agent-connector.config.json"))).toBe(true);
  });

  it("extracts a flat zip (config at the archive root) via the archive: prefix", async () => {
    const dir = tempDir("ac-fetch-zip-flat-");
    cleanup.push(dir);
    const zipPath = join(dir, "flat.zip");
    writeFileSync(
      zipPath,
      buildZip({ "agent-connector.config.json": config("flat-zip"), "server.mjs": "// stub\n" }),
    );
    const resolved = await resolveRemoteSource(parseArchiveSource(`archive:${zipPath}`)!);
    expect(resolved.connector.id).toBe("flat-zip");
  });

  it("a zip that is not a connector fails the shared package gate", async () => {
    const dir = tempDir("ac-fetch-zip-bad-");
    cleanup.push(dir);
    const zipPath = join(dir, "not-a-connector.zip");
    writeFileSync(zipPath, buildZip({ "not-a-connector/README.md": "# nope\n" }));
    await expect(resolveRemoteSource(parseArchiveSource(zipPath)!)).rejects.toThrow(
      /is not an agent-connector connector/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Dependencies — a fetched package never ships node_modules, so a config
//    that imports its own dependencies must have them installed BEFORE the
//    package gate loads it (issue #250 known limitation).
// ═══════════════════════════════════════════════════════════════════════════
describe("resolveRemoteSource — installs the fetched package's dependencies", () => {
  const jsonConfig = (id: string) =>
    JSON.stringify({ id, version: "1.0.0", server: { transport: "stdio", command: "node", args: ["s.mjs"] } });
  const fetcherWith = (files: Record<string, string>): Fetcher => (_remote, dest) => {
    mkdirSync(dest, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(dest, name, ".."), { recursive: true });
      writeFileSync(join(dest, name), body, "utf8");
    }
  };
  const remote: RemoteSource = { owner: "acme", repo: "dep-connector" };

  it("runs the installer in the connector dir when package.json declares dependencies", async () => {
    const calls: string[] = [];
    const fetcher = fetcherWith({
      "package.json": JSON.stringify({ name: "x", dependencies: { "acme-dep": "^1.0.0" } }),
      "agent-connector.config.json": jsonConfig("dep-connector"),
    });
    const resolved = await resolveRemoteSource(remote, { fetcher, dependencyInstaller: (d) => void calls.push(d) });
    expect(calls).toEqual([resolved.connectorDir]);
  });

  it("skips the installer when there are no dependencies or node_modules already has them", async () => {
    const calls: string[] = [];
    const installer = (d: string) => void calls.push(d);
    await resolveRemoteSource(remote, {
      fetcher: fetcherWith({ "package.json": JSON.stringify({ name: "x" }), "agent-connector.config.json": jsonConfig("a") }),
      dependencyInstaller: installer,
    });
    await resolveRemoteSource(remote, {
      fetcher: fetcherWith({
        "package.json": JSON.stringify({ name: "x", dependencies: { "@acme/dep": "1.0.0" } }),
        "node_modules/@acme/dep/package.json": JSON.stringify({ name: "@acme/dep", version: "1.0.0" }),
        "agent-connector.config.json": jsonConfig("a"),
      }),
      dependencyInstaller: installer,
    });
    expect(calls).toEqual([]);
  });

  it("uses the SUBPATH package's manifest, not the repo root's", async () => {
    const calls: string[] = [];
    const fetcher = fetcherWith({
      "package.json": JSON.stringify({ name: "root", dependencies: { "root-only": "1.0.0" } }),
      "examples/db/package.json": JSON.stringify({ name: "db", dependencies: { "acme-dep": "1.0.0" } }),
      "examples/db/agent-connector.config.json": jsonConfig("db"),
    });
    const sub: RemoteSource = { ...remote, subpath: "examples/db" };
    const resolved = await resolveRemoteSource(sub, { fetcher, dependencyInstaller: (d) => void calls.push(d) });
    expect(calls).toEqual([resolved.connectorDir]);
    expect(resolved.connectorDir.endsWith(join("examples", "db"))).toBe(true);
  });

  it("wraps an installer failure in a labeled, actionable error", async () => {
    const fetcher = fetcherWith({
      "package.json": JSON.stringify({ name: "x", dependencies: { "acme-dep": "^1.0.0" } }),
      "agent-connector.config.json": jsonConfig("dep-connector"),
    });
    await expect(
      resolveRemoteSource(remote, {
        fetcher,
        dependencyInstaller: () => {
          throw new Error("registry unreachable");
        },
      }),
    ).rejects.toThrow(/acme\/dep-connector: the connector declares dependencies \(acme-dep\).*registry unreachable.*npm install/);
  });

  it("REAL npm: a config importing a file: dependency loads after the default installer runs", async () => {
    // A local dummy package stands in for the framework dependency — no network.
    const depDir = tempDir("ac-fetch-dep-pkg-");
    cleanup.push(depDir);
    writeFileSync(join(depDir, "package.json"), JSON.stringify({ name: "acme-dep", version: "1.0.0", type: "module", main: "index.js" }));
    writeFileSync(join(depDir, "index.js"), 'export const id = "dep-loaded";\n');
    const fetcher = fetcherWith({
      "package.json": JSON.stringify({ name: "dep-connector", type: "module", dependencies: { "acme-dep": `file:${depDir}` } }),
      "agent-connector.config.mjs":
        'import { id } from "acme-dep";\n' +
        'export default { id, version: "1.0.0", server: { transport: "stdio", command: "node", args: ["s.mjs"] } };\n',
    });
    // Without dependencies the config cannot even load — the pre-fix failure.
    // (Separate cache dir: Node's ESM loader remembers a failed import of the
    // same file URL for the life of the process.)
    await expect(
      resolveRemoteSource({ ...remote, ref: "no-deps" }, { fetcher, dependencyInstaller: () => {} }),
    ).rejects.toThrow(/failed to load as an agent-connector connector/);
    const resolved = await resolveRemoteSource(remote, { fetcher });
    expect(resolved.connector.id).toBe("dep-loaded");
    expect(existsSync(join(resolved.connectorDir, "node_modules", "acme-dep", "package.json"))).toBe(true);
  }, 120_000);
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
