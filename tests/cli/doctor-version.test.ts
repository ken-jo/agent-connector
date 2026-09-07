/**
 * doctor — version checks (framework bucket).
 *
 * doctor is the one command a user runs to learn whether an install is CURRENT,
 * so it must report:
 *   - the home-bin launcher exists, execs an existing CLI, and that CLI is the
 *     same agent-connector version as the CLI running doctor;
 *   - each registered connector was rendered by this framework version and its
 *     registered version matches the source connector's version.
 * Every drift finding is `fixable`, so `doctor --heal` (a sync) clears it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/app.js";
import { defineConnector } from "../../src/core/define-connector.js";
import { installConnector } from "../../src/core/installer.js";
import { readRegisteredMeta } from "../../src/core/load-connector.js";
import { homeBinPath } from "../../src/core/paths.js";
import { cliEntryOfLauncher, resolveOwnVersion, versionOfCliEntry } from "../../src/core/version.js";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  APPDATA: process.env.APPDATA,
};
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ac-doctor-version-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(tmp, ".agent-connector");
  process.env.APPDATA = join(tmp, "AppData", "Roaming");
  // claude-code detection marker so doctor has a host to report on.
  mkdirSync(join(tmp, ".claude"), { recursive: true });
  writeFileSync(join(tmp, ".claude", "settings.json"), "{}", "utf8");
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

interface Bucket {
  platform: string;
  results: { check: string; status: string; message: string; fixable?: boolean }[];
}

function captureStdout(): { restore: () => void; text: () => string } {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as unknown as typeof process.stdout.write;
  return {
    restore: () => {
      process.stdout.write = orig;
    },
    text: () => out,
  };
}

async function doctorJson(args: string[]): Promise<{ code: number; buckets: Bucket[] }> {
  const cap = captureStdout();
  let code: number;
  try {
    code = await main(["doctor", "--json", ...args]);
  } finally {
    cap.restore();
  }
  return { code, buckets: JSON.parse(cap.text()) as Bucket[] };
}

function frameworkBucket(buckets: Bucket[]): Bucket {
  const b = buckets.find((x) => x.platform === "agent-connector");
  if (!b) throw new Error("no agent-connector bucket in doctor output");
  return b;
}

function check(buckets: Bucket[], name: string) {
  const r = frameworkBucket(buckets).results.find((x) => x.check === name);
  if (!r) throw new Error(`missing check ${name}`);
  return r;
}

function writeConnectorJson(id: string, version: string): string {
  const p = join(tmp, `${id}.config.json`);
  writeFileSync(
    p,
    JSON.stringify({ id, version, memory: [{ content: `Use the ${id} tools.` }], targets: ["claude-code"] }),
    "utf8",
  );
  return p;
}

async function installFixture(id = "ver-fix", version = "1.0.0") {
  const connector = defineConnector({
    id,
    version,
    memory: [{ content: `Use the ${id} tools.` }],
    targets: ["claude-code"],
  });
  const modPath = writeConnectorJson(id, version);
  await installConnector({
    connector,
    modulePath: modPath,
    scope: "user",
    projectDir: tmp,
    targets: ["claude-code"],
    dryRun: false,
  });
  return { connector, modPath };
}

describe("doctor version checks — a fresh install is current", () => {
  it("passes home-bin, home-bin version, framework version and connector version", async () => {
    const { modPath } = await installFixture();
    const { code, buckets } = await doctorJson(["--connector", modPath]);
    expect(code).toBe(0);
    // The framework bucket is printed first.
    expect(buckets[0]?.platform).toBe("agent-connector");
    expect(check(buckets, "agent-connector: home-bin").status).toBe("pass");
    expect(check(buckets, "agent-connector: home-bin version").status).toBe("pass");
    expect(check(buckets, "agent-connector: home-bin version").message).toBe(resolveOwnVersion());
    expect(check(buckets, "ver-fix: framework version").status).toBe("pass");
    expect(check(buckets, "ver-fix: connector version").status).toBe("pass");
  });

  it("stamps the framework version onto the connector record at install", async () => {
    await installFixture();
    expect(readRegisteredMeta("ver-fix")?.frameworkVersion).toBe(resolveOwnVersion());
  });

  it("without any install, the missing launcher is informational (pass)", async () => {
    const { code, buckets } = await doctorJson(["--targets", "claude-code"]);
    expect(code).toBe(0);
    expect(check(buckets, "agent-connector: home-bin").status).toBe("pass");
    expect(check(buckets, "agent-connector: home-bin").message).toContain("nothing installed");
  });
});

describe("doctor version checks — drift is reported and healed", () => {
  it("an install rendered by an older framework warns (fixable) and heals via --heal", async () => {
    const { modPath } = await installFixture();
    // Simulate a record written by an older release.
    const recordPath = join(
      process.env.AGENT_CONNECTOR_DATA_DIR!,
      "connectors",
      "ver-fix",
      "connector.json",
    );
    const meta = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    meta.frameworkVersion = "0.1.0";
    writeFileSync(recordPath, JSON.stringify(meta), "utf8");

    const before = await doctorJson(["--connector", modPath]);
    expect(before.code).toBe(0); // warn only — warns never fail doctor
    const finding = check(before.buckets, "ver-fix: framework version");
    expect(finding.status).toBe("warn");
    expect(finding.message).toContain("0.1.0");
    expect(finding.fixable).toBe(true);

    const cap = captureStdout();
    try {
      expect(await main(["doctor", "--heal", "--connector", modPath])).toBe(0);
    } finally {
      cap.restore();
    }
    expect(cap.text()).toContain("ver-fix: framework version");
    expect(readRegisteredMeta("ver-fix")?.frameworkVersion).toBe(resolveOwnVersion());
    const after = await doctorJson(["--connector", modPath]);
    expect(check(after.buckets, "ver-fix: framework version").status).toBe("pass");
  });

  it("a record missing frameworkVersion (pre-0.6.5 install) warns and names the running version", async () => {
    const { modPath } = await installFixture();
    const recordPath = join(process.env.AGENT_CONNECTOR_DATA_DIR!, "connectors", "ver-fix", "connector.json");
    const meta = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    delete meta.frameworkVersion;
    writeFileSync(recordPath, JSON.stringify(meta), "utf8");
    const { buckets } = await doctorJson(["--connector", modPath]);
    const finding = check(buckets, "ver-fix: framework version");
    expect(finding.status).toBe("warn");
    expect(finding.message).toContain("older than 0.6.5");
    expect(finding.message).toContain(resolveOwnVersion());
  });

  it("a source connector whose version moved past the registered one warns until upgraded", async () => {
    await installFixture("ver-fix", "1.0.0");
    // The developer bumps the connector version in the source file.
    const modPath = writeConnectorJson("ver-fix", "1.1.0");
    const before = await doctorJson(["--connector", modPath]);
    const finding = check(before.buckets, "ver-fix: connector version");
    expect(finding.status).toBe("warn");
    expect(finding.message).toContain("registered 1.0.0");
    expect(finding.message).toContain("1.1.0");

    const cap = captureStdout();
    try {
      await main(["doctor", "--heal", "--connector", modPath]);
    } finally {
      cap.restore();
    }
    expect(readRegisteredMeta("ver-fix")?.version).toBe("1.1.0");
    const after = await doctorJson(["--connector", modPath]);
    expect(check(after.buckets, "ver-fix: connector version").status).toBe("pass");
  });

  it("a launcher pointing at a CLI that no longer exists FAILs and heal re-points it", async () => {
    const { modPath } = await installFixture();
    const bin = homeBinPath();
    const original = readFileSync(bin, "utf8");
    const cli = cliEntryOfLauncher(original);
    expect(cli && existsSync(cli)).toBe(true);
    // Simulate an uninstalled/moved agent-connector.
    writeFileSync(
      bin,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${join(tmp, "gone", "cli.js")}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${join(tmp, "gone", "cli.js")}" "$@"\n`,
      "utf8",
    );

    const before = await doctorJson(["--connector", modPath]);
    expect(before.code).toBe(1);
    const finding = check(before.buckets, "agent-connector: home-bin");
    expect(finding.status).toBe("fail");
    expect(finding.message).toContain("no longer exists");
    expect(finding.fixable).toBe(true);

    const cap = captureStdout();
    try {
      await main(["doctor", "--heal", "--connector", modPath]);
    } finally {
      cap.restore();
    }
    expect(cliEntryOfLauncher(readFileSync(bin, "utf8"))).toBe(cli);
    const after = await doctorJson(["--connector", modPath]);
    expect(after.code).toBe(0);
    expect(check(after.buckets, "agent-connector: home-bin").status).toBe("pass");
  });

  it("a launcher whose target is a different agent-connector version warns (fixable)", async () => {
    const { modPath } = await installFixture();
    // Build a fake OLDER agent-connector install and point the launcher at it.
    const oldRoot = join(tmp, "old-ac");
    mkdirSync(join(oldRoot, "dist"), { recursive: true });
    writeFileSync(
      join(oldRoot, "package.json"),
      JSON.stringify({ name: "@ken-jo/agent-connector", version: "0.0.1" }),
      "utf8",
    );
    writeFileSync(join(oldRoot, "dist", "cli.js"), "// stub\n", "utf8");
    expect(versionOfCliEntry(join(oldRoot, "dist", "cli.js"))).toBe("0.0.1");
    const bin = homeBinPath();
    writeFileSync(
      bin,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${join(oldRoot, "dist", "cli.js")}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${join(oldRoot, "dist", "cli.js")}" "$@"\n`,
      "utf8",
    );
    const { code, buckets } = await doctorJson(["--connector", modPath]);
    expect(code).toBe(0);
    const finding = check(buckets, "agent-connector: home-bin version");
    expect(finding.status).toBe("warn");
    expect(finding.message).toContain("0.0.1");
    expect(finding.message).toContain(resolveOwnVersion());
    expect(finding.fixable).toBe(true);
  });
});
