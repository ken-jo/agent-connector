/**
 * tests/cli/doctor-heal — `doctor --heal` and `doctor --heal --dry-run`.
 *
 * Hermetic: each test gets its own tmpdir; HOME + AGENT_CONNECTOR_DATA_DIR are
 * redirected so nothing in the real user home is ever read or written.
 *
 * Scenarios:
 *   1. Memory block missing  → --heal re-creates the block (finding disappears).
 *   2. configPatch missing   → --heal re-asserts the key in settings.json.
 *   3. configPatch DRIFTED   → --heal does NOT touch the value (drift → deferred).
 *   4. --heal --dry-run      → writes NOTHING (file unchanged), prints "would heal", exits 0.
 *   5. Exit code             → pure-deferred scenario exits 0 (deferred warns don't fail).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { installConnector } from "../../src/core/installer.js";
import { main } from "../../src/cli/app.js";

// ─── env isolation ───────────────────────────────────────────────────────────

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  APPDATA: process.env.APPDATA,
};

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ac-heal-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(tmp, ".agent-connector");
  process.env.APPDATA = join(tmp, "AppData", "Roaming");
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Capture process.stdout.write output while running fn. */
function captureStdout(): { restore: () => void; text: () => string } {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    // Also call original so vitest diagnostics still work
    return (orig as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as unknown as typeof process.stdout.write;
  return {
    restore: () => {
      process.stdout.write = orig;
    },
    text: () => out,
  };
}

/** Project-scope settings.json path (inside tmp acting as the project dir). */
function projectSettingsPath(): string {
  return join(tmp, ".claude", "settings.json");
}

/** Write the claude-code project settings file. */
function writeSettings(data: unknown): void {
  mkdirSync(join(tmp, ".claude"), { recursive: true });
  writeFileSync(projectSettingsPath(), JSON.stringify(data, null, 2), "utf8");
}

/** Read the claude-code project settings file. */
function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(projectSettingsPath(), "utf8")) as Record<string, unknown>;
}

// A fake module path: installConnector needs one, but for a JSON-based connector
// we pass the connector as a written JSON file. We write a minimal JSON file and
// use its path as the modulePath.
function writeConnectorJson(connector: ReturnType<typeof defineConnector>): string {
  const p = join(tmp, `${connector.id}.config.json`);
  writeFileSync(p, JSON.stringify({ id: connector.id, version: connector.version }), "utf8");
  return p;
}

// ─── Test 1: memory block missing → heal re-creates it ───────────────────────

describe("doctor --heal: memory block missing", () => {
  it("re-creates the missing block so the finding becomes pass", async () => {
    // Build a connector with memory content targeting claude-code.
    const connector = defineConnector({
      id: "heal-mem",
      memory: [{ content: "Always use heal-mem MCP tools." }],
      targets: ["claude-code"],
    });
    const modPath = writeConnectorJson(connector);

    // Set up the claude-code detection markers.
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "settings.json"), "{}", "utf8");

    // Install — this writes the memory block and ledger entry.
    await installConnector({
      connector,
      modulePath: modPath,
      scope: "user",
      projectDir: tmp,
      targets: ["claude-code"],
      dryRun: false,
    });

    // Find the written memory file (user-scope claude-code → CLAUDE.md in HOME).
    const claudeMd = join(tmp, ".claude", "CLAUDE.md");
    expect(existsSync(claudeMd)).toBe(true);

    // Simulate the finding: delete the memory file.
    rmSync(claudeMd);
    expect(existsSync(claudeMd)).toBe(false);

    // Run doctor to confirm the finding appears.
    const preCap = captureStdout();
    await main(["doctor", "--connector", modPath, "--project", tmp, "--scope", "user"]);
    preCap.restore();
    expect(preCap.text()).toContain("memory file missing");

    // Run doctor --heal.
    const cap = captureStdout();
    const code = await main([
      "doctor",
      "--heal",
      "--connector",
      modPath,
      "--project",
      tmp,
      "--scope",
      "user",
    ]);
    cap.restore();

    // The file should be re-created.
    expect(existsSync(claudeMd)).toBe(true);
    // The block content should be present.
    const content = readFileSync(claudeMd, "utf8");
    expect(content).toContain("heal-mem MCP tools");
    // The output should report the fix.
    expect(cap.text()).toContain("healed");
    // Exit 0 — all post-heal findings should pass.
    expect(code).toBe(0);
  });
});

// ─── Test 2: configPatch missing → heal re-asserts the key ───────────────────

describe("doctor --heal: configPatch missing", () => {
  it("re-writes a deleted configPatch key into settings.json", async () => {
    const connector = defineConnector({
      id: "heal-cpatch",
      targets: ["claude-code"],
      platforms: {
        "claude-code": {
          configPatch: [
            {
              key: "preferredNotifChannel",
              value: "desktop",
              reason: "use desktop notifications",
            },
          ],
        },
      },
    });
    const modPath = writeConnectorJson(connector);

    // Detect claude-code.
    writeSettings({});

    // Install — writes the key into settings and adds ledger entry.
    await installConnector({
      connector,
      modulePath: modPath,
      scope: "project",
      projectDir: tmp,
      targets: ["claude-code"],
      dryRun: false,
    });

    // Verify the key was written.
    expect(readSettings()).toMatchObject({ preferredNotifChannel: "desktop" });

    // Simulate "missing": remove the key.
    writeSettings({});
    expect(readSettings().preferredNotifChannel).toBeUndefined();

    // Confirm pre-heal finding.
    const preCap = captureStdout();
    await main(["doctor", "--connector", modPath, "--project", tmp, "--scope", "project"]);
    preCap.restore();
    expect(preCap.text()).toContain("missing");

    // Run --heal.
    const cap = captureStdout();
    const code = await main([
      "doctor",
      "--heal",
      "--connector",
      modPath,
      "--project",
      tmp,
      "--scope",
      "project",
    ]);
    cap.restore();

    // Key must be restored.
    expect(readSettings().preferredNotifChannel).toBe("desktop");
    expect(cap.text()).toContain("healed");
    expect(code).toBe(0);
  });
});

// ─── Test 3: configPatch DRIFTED → heal must NOT clobber the value ───────────

describe("doctor --heal: configPatch drifted — safety test", () => {
  it("leaves user-edited (drifted) configPatch values untouched and defers them", async () => {
    const connector = defineConnector({
      id: "heal-drift",
      targets: ["claude-code"],
      platforms: {
        "claude-code": {
          configPatch: [
            {
              key: "preferredNotifChannel",
              value: "desktop",
              reason: "use desktop notifications",
            },
          ],
        },
      },
    });
    const modPath = writeConnectorJson(connector);

    writeSettings({});

    // Install — writes "desktop".
    await installConnector({
      connector,
      modulePath: modPath,
      scope: "project",
      projectDir: tmp,
      targets: ["claude-code"],
      dryRun: false,
    });
    expect(readSettings().preferredNotifChannel).toBe("desktop");

    // User edits the value → drift.
    writeSettings({ preferredNotifChannel: "slack" });

    // Confirm doctor sees "drifted".
    const preCap = captureStdout();
    await main(["doctor", "--connector", modPath, "--project", tmp, "--scope", "project"]);
    preCap.restore();
    expect(preCap.text()).toContain("drifted");

    // Run --heal.
    const cap = captureStdout();
    const code = await main([
      "doctor",
      "--heal",
      "--connector",
      modPath,
      "--project",
      tmp,
      "--scope",
      "project",
    ]);
    cap.restore();

    // CRITICAL: value must remain "slack" — heal must NOT overwrite drift.
    expect(readSettings().preferredNotifChannel).toBe("slack");

    // The drifted finding must appear in deferred output, not healed.
    const out = cap.text();
    expect(out).toContain("deferred");
    expect(out).not.toContain("healed (");

    // Exit 0 — deferred warns do not fail the command.
    expect(code).toBe(0);
  });
});

// ─── Test 4: --heal --dry-run → writes nothing ───────────────────────────────

describe("doctor --heal --dry-run", () => {
  it("prints 'would heal' but writes nothing and exits 0", async () => {
    const connector = defineConnector({
      id: "heal-dryrun",
      memory: [{ content: "Dry-run heal test." }],
      targets: ["claude-code"],
    });
    const modPath = writeConnectorJson(connector);

    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "settings.json"), "{}", "utf8");

    // Install to create the memory block.
    await installConnector({
      connector,
      modulePath: modPath,
      scope: "user",
      projectDir: tmp,
      targets: ["claude-code"],
      dryRun: false,
    });

    const claudeMd = join(tmp, ".claude", "CLAUDE.md");
    expect(existsSync(claudeMd)).toBe(true);

    // Delete the block to create the fixable finding.
    rmSync(claudeMd);

    // Snapshot the settings file (it shouldn't change).
    const settingsBefore = readFileSync(join(tmp, ".claude", "settings.json"), "utf8");

    // Run --heal --dry-run.
    const cap = captureStdout();
    const code = await main([
      "doctor",
      "--heal",
      "--dry-run",
      "--connector",
      modPath,
      "--project",
      tmp,
      "--scope",
      "user",
    ]);
    cap.restore();

    // File must NOT be re-created.
    expect(existsSync(claudeMd)).toBe(false);

    // Settings unchanged.
    const settingsAfter = readFileSync(join(tmp, ".claude", "settings.json"), "utf8");
    expect(settingsAfter).toBe(settingsBefore);

    // Output must contain "would heal".
    expect(cap.text()).toContain("would heal");

    // Exit 0.
    expect(code).toBe(0);
  });
});

// ─── Test 5: exit-code — pure-deferred scenario exits 0 ──────────────────────

describe("doctor --heal: exit code", () => {
  it("exits 0 when all non-pass findings are deferred warns (no fail)", async () => {
    const connector = defineConnector({
      id: "heal-exitcode",
      targets: ["claude-code"],
      platforms: {
        "claude-code": {
          configPatch: [
            {
              key: "preferredNotifChannel",
              value: "desktop",
              reason: "use desktop notifications",
            },
          ],
        },
      },
    });
    const modPath = writeConnectorJson(connector);

    writeSettings({});

    // Install.
    await installConnector({
      connector,
      modulePath: modPath,
      scope: "project",
      projectDir: tmp,
      targets: ["claude-code"],
      dryRun: false,
    });

    // Drift the value → non-fixable finding (deferred).
    writeSettings({ preferredNotifChannel: "slack" });

    // Run --heal.
    const cap = captureStdout();
    const code = await main([
      "doctor",
      "--heal",
      "--connector",
      modPath,
      "--project",
      tmp,
      "--scope",
      "project",
    ]);
    cap.restore();

    // Deferred warns → exit 0.
    expect(code).toBe(0);
    expect(cap.text()).toContain("deferred");
  });
});

// ─── Test 6: placeholder/no-install → heal must NOT fabricate a registry record ─

describe("doctor --heal: no installed connector (placeholder)", () => {
  it("never syncs the id-only placeholder — fabricates no connector record", async () => {
    // No connector installed and no local config → resolveDoctorConnectors
    // falls back to the synthetic id-only "agent-connector" placeholder, whose
    // modulePath is "". Force a target so the heal path runs even with nothing
    // detected. A pre-fix bug synced this placeholder, which wrote a corrupt
    // registry record via registerConnector(connector, "") (resolve("")=cwd).
    const recordPath = join(
      process.env.AGENT_CONNECTOR_DATA_DIR!,
      "connectors",
      "agent-connector",
      "connector.json",
    );
    expect(existsSync(recordPath)).toBe(false);

    const cap = captureStdout();
    const code = await main([
      "doctor",
      "--heal",
      "--targets",
      "claude-code",
      "--project",
      tmp,
      "--scope",
      "user",
    ]);
    cap.restore();

    // CRITICAL: no registry record may be fabricated for a connector the user
    // never installed.
    expect(existsSync(recordPath)).toBe(false);
    // The placeholder's serverless "config present" finding is non-fixable, so
    // it is deferred (or simply not healed) — never synced. Exit 0 (warn only).
    expect(code).toBe(0);
    expect(cap.text()).not.toContain("healed (");
  });
});
