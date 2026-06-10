import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  dataRoot,
  homeBinPath,
  ensureHomeBin,
  projectIdentity,
  connectorsDir,
  connectorDir,
  backupsDir,
  logsDir,
  telemetryPath,
} from "../../src/core/paths.js";

const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_DATA_DIR = process.env.AGENTCONNECT_DATA_DIR;

let tmpHome: string;
let tmpData: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-data-"));
  process.env.HOME = tmpHome;
  // homedir() on some platforms reads USERPROFILE; keep both pointed at the temp.
  process.env.USERPROFILE = tmpHome;
  delete process.env.AGENTCONNECT_DATA_DIR;
});

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
  if (ORIG_DATA_DIR === undefined) delete process.env.AGENTCONNECT_DATA_DIR;
  else process.env.AGENTCONNECT_DATA_DIR = ORIG_DATA_DIR;

  for (const d of [tmpHome, tmpData]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("dataRoot", () => {
  it("honors AGENTCONNECT_DATA_DIR override (resolved to absolute)", () => {
    process.env.AGENTCONNECT_DATA_DIR = tmpData;
    expect(dataRoot()).toBe(resolve(tmpData));
  });

  it("ignores a blank/whitespace override and falls back under HOME", () => {
    process.env.AGENTCONNECT_DATA_DIR = "   ";
    expect(dataRoot()).toBe(join(tmpHome, ".agentconnect"));
  });

  it("falls back to <HOME>/.agentconnect when no override is set", () => {
    expect(dataRoot()).toBe(join(tmpHome, ".agentconnect"));
  });

  it("derived dirs all sit under the data-root", () => {
    process.env.AGENTCONNECT_DATA_DIR = tmpData;
    const root = resolve(tmpData);
    expect(connectorsDir()).toBe(join(root, "connectors"));
    expect(connectorDir("acme")).toBe(join(root, "connectors", "acme"));
    expect(backupsDir()).toBe(join(root, "backups"));
    expect(logsDir()).toBe(join(root, "logs"));
    expect(telemetryPath()).toBe(join(root, "telemetry.ndjson"));
    expect(telemetryPath("sqlite")).toBe(join(root, "telemetry.db"));
  });
});

describe("homeBinPath", () => {
  it("sits under dataRoot/bin", () => {
    process.env.AGENTCONNECT_DATA_DIR = tmpData;
    const root = resolve(tmpData);
    const bin = homeBinPath();
    expect(bin.startsWith(join(root, "bin") + sep)).toBe(true);
  });

  it("uses the platform-appropriate launcher name", () => {
    process.env.AGENTCONNECT_DATA_DIR = tmpData;
    const root = resolve(tmpData);
    const expectedName =
      process.platform === "win32" ? "agentconnect.cmd" : "agentconnect";
    expect(homeBinPath()).toBe(join(root, "bin", expectedName));
  });
});

describe("ensureHomeBin", () => {
  it("writes a launcher that references the cli entry, and returns its path", () => {
    process.env.AGENTCONNECT_DATA_DIR = tmpData;
    const cliEntry = "/opt/agentconnect/dist/cli.js";
    const written = ensureHomeBin(cliEntry, "/usr/bin/node");

    expect(written).toBe(homeBinPath());
    const contents = readFileSync(written, "utf8");
    // The launcher must reference the cli entry (forward-slashed) and node.
    expect(contents).toContain("dist/cli.js");
    expect(contents).toContain("/usr/bin/node");
  });

  it("marks the launcher executable on POSIX", () => {
    process.env.AGENTCONNECT_DATA_DIR = tmpData;
    const written = ensureHomeBin("/opt/cli.js", "/usr/bin/node");
    const mode = statSync(written).mode;
    if (process.platform !== "win32") {
      // owner-execute bit must be set
      expect(mode & 0o100).toBe(0o100);
    } else {
      expect(written.endsWith(".cmd")).toBe(true);
    }
  });

  it("is idempotent — a second call overwrites cleanly and returns the same path", () => {
    process.env.AGENTCONNECT_DATA_DIR = tmpData;
    const first = ensureHomeBin("/opt/cli.js", "/usr/bin/node");
    const second = ensureHomeBin("/opt/cli.js", "/usr/bin/node");
    expect(second).toBe(first);
    expect(readFileSync(second, "utf8").length).toBeGreaterThan(0);
  });

  it("forward-slashes a Windows-style cli path inside the launcher", () => {
    process.env.AGENTCONNECT_DATA_DIR = tmpData;
    const written = ensureHomeBin("C:\\Apps\\dist\\cli.js", "C:\\node\\node.exe");
    const contents = readFileSync(written, "utf8");
    expect(contents).toContain("C:/Apps/dist/cli.js");
    expect(contents).not.toContain("C:\\Apps");
  });
});

describe("projectIdentity", () => {
  function newProjectDir(): string {
    const d = mkdtempSync(join(tmpdir(), "ac-proj-"));
    return d;
  }

  it("returns a stable 16-char lowercase hex key", () => {
    const d = newProjectDir();
    try {
      const id = projectIdentity(d);
      expect(id.key).toMatch(/^[0-9a-f]{16}$/);
      expect(id.dir).toBe(resolve(d));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("is identical across two calls for the same dir", () => {
    const d = newProjectDir();
    try {
      expect(projectIdentity(d).key).toBe(projectIdentity(d).key);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("differs for a different dir", () => {
    const d1 = newProjectDir();
    const d2 = newProjectDir();
    try {
      expect(projectIdentity(d1).key).not.toBe(projectIdentity(d2).key);
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  });

  it("prefers the git origin url so two checkouts of the same repo share a key", () => {
    const d1 = newProjectDir();
    const d2 = newProjectDir();
    const remote = "https://github.com/acme/widget.git";
    const gitConfig = `[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
    try {
      for (const d of [d1, d2]) {
        mkdirSync(join(d, ".git"));
        writeFileSync(join(d, ".git", "config"), gitConfig, "utf8");
      }
      const id1 = projectIdentity(d1);
      const id2 = projectIdentity(d2);
      // Same git remote → same partition key, even though paths differ.
      expect(id1.key).toBe(id2.key);
      expect(id1.label).toBe(remote);
      expect(id2.label).toBe(remote);
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  });

  it("falls back to the directory basename as label when there is no git remote", () => {
    const d = newProjectDir();
    try {
      const id = projectIdentity(d);
      expect(id.label).toBe(d.split(sep).pop());
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
