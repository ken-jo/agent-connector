/**
 * integration/install-roundtrip — end-to-end install → assert → uninstall.
 *
 * Drives the real {@link installConnector} / {@link uninstallConnector}
 * orchestration into a throwaway HOME so the real user home and the repo tree
 * are never touched. After install we assert each platform's native config file
 * exists and carries the connector id; after uninstall we assert those entries
 * are gone.
 *
 * Two layers of coverage:
 *   1. A detailed 3-host suite (claude-code, codex, cursor) asserting the EXACT
 *      native dialect each writes (the original Phase-1 template) plus the
 *      idempotency / dryRun / registry-record invariants.
 *   2. A REGISTRY-DRIVEN roundtrip across EVERY adapter in ADAPTER_REGISTRY
 *      (describe.each) — install → placement → uninstall → no-residue, asserted
 *      generically off the ORCHESTRATOR-RETURNED written paths + each adapter's
 *      OWN path getters (no hand-maintained per-host path map). Adding a 36th
 *      adapter auto-covers it.
 *
 * Isolation contract (mirrors tests/core/paths.test.ts):
 *   • HOME / USERPROFILE → a fresh os.tmpdir mkdtemp dir (adapters resolve native
 *     config paths off homedir()).
 *   • XDG_CONFIG_HOME / APPDATA → under the same throwaway HOME so XDG/Windows
 *     config-root resolution is fully sandboxed.
 *   • CODEX_HOME / XDG_DATA_HOME are CLEARED so a dev box where they point at a
 *     real dir cannot leak a write outside the sandbox (codex falls back to
 *     ~/.codex inside tmpHome; XDG_DATA_HOME is defense-in-depth, same class).
 *   • AGENT_CONNECTOR_DATA_DIR → a separate fresh temp dir (framework state:
 *     home-bin, connector registry).
 *   • AGENT_CONNECTOR_TELEMETRY is cleared so default wrapping behavior is used.
 *   • Every env var is restored verbatim in afterEach; both temp trees removed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import { defineConnector } from "../../src/core/define-connector.js";
import {
  installConnector,
  uninstallConnector,
} from "../../src/core/installer.js";
import { dataRoot, homeBinPath } from "../../src/core/paths.js";
import type { ChangeRecord, ResolvedConnector } from "../../src/core/types.js";

// Absolute path to the BUILT public entry so the fixture .mjs can import
// defineConnector at runtime (the SRC index.ts is not importable from a plain
// .mjs). The dist build is a committed prerequisite for these tests.
const DIST_INDEX = join(__dirname, "..", "..", "dist", "index.js");

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
};

const CONNECTOR_ID = "acme-db";

let tmpHome: string;
let tmpData: string;
let projectDir: string;
let fixtureModulePath: string;

/**
 * The Windows-safe temp-dir primitive (mirrors tests/support/env.ts): expand the
 * 8.3 short name so the `~` never survives into pathToFileURL as `%7E` and breaks
 * a dynamic import() of a generated ts-plugin module.
 */
function tempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

/** Build the in-test live connector (server + hooks → all native files written). */
function makeConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/db-mcp"],
    },
    hooks: {
      PreToolUse: {
        matcher: "acme_query|acme_write",
        handler(evt) {
          return evt.toolName === "acme_write"
            ? { decision: "ask", reason: "confirm write" }
            : { decision: "allow" };
        },
      },
      SessionStart: {
        handler() {
          return { decision: "context", additionalContext: "acme online" };
        },
      },
    },
  });
}

/**
 * Write a tiny fixture connector module. registerConnector (invoked inside
 * installConnector) persists this path so the runtime can re-import live
 * handlers; it imports defineConnector from the BUILT dist entry via an absolute
 * file URL so the .mjs resolves at runtime.
 */
function writeFixtureModule(dir: string): string {
  const modPath = join(dir, "acme-db.config.mjs");
  const distUrl = pathToFileURL(DIST_INDEX).href;
  const source = `
import { defineConnector } from ${JSON.stringify(distUrl)};

export default defineConnector({
  id: ${JSON.stringify(CONNECTOR_ID)},
  displayName: "Acme DB Tools",
  version: "1.2.3",
  server: { transport: "stdio", command: "npx", args: ["-y", "@acme/db-mcp"] },
  hooks: {
    PreToolUse: {
      matcher: "acme_query|acme_write",
      handler(evt) {
        return evt.toolName === "acme_write"
          ? { decision: "ask", reason: "confirm write" }
          : { decision: "allow" };
      },
    },
    SessionStart: {
      handler() {
        return { decision: "context", additionalContext: "acme online" };
      },
    },
  },
});
`;
  writeFileSync(modPath, source, "utf8");
  return modPath;
}

/**
 * A fixture module declaring a SKILL (no hooks), for the content-only pi
 * spot-check. Uninstall re-loads the registered module to learn which surfaces a
 * connector declared, so the install/uninstall pair must share a module whose
 * declared surfaces match (here: a skill) — exactly as a real connector module
 * is reused across install and uninstall.
 */
function writeSkillsFixtureModule(dir: string): string {
  const modPath = join(dir, "acme-db-skills.config.mjs");
  const distUrl = pathToFileURL(DIST_INDEX).href;
  const source = `
import { defineConnector } from ${JSON.stringify(distUrl)};

export default defineConnector({
  id: ${JSON.stringify(CONNECTOR_ID)},
  displayName: "Acme DB Tools",
  version: "1.2.3",
  server: { transport: "stdio", command: "npx", args: ["-y", "@acme/db-mcp"] },
  skills: [
    { name: "acme-skill", description: "Query and write to the Acme DB.", body: "Use the acme db." },
  ],
});
`;
  writeFileSync(modPath, source, "utf8");
  return modPath;
}

beforeEach(() => {
  tmpHome = tempDir("ac-it-home-");
  tmpData = tempDir("ac-it-data-");
  projectDir = join(tmpHome, "project");
  mkdirSync(projectDir, { recursive: true });

  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.APPDATA = join(tmpHome, "AppData", "Roaming");
  process.env.XDG_CONFIG_HOME = join(tmpHome, ".config");
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  delete process.env.AGENT_CONNECTOR_TELEMETRY;
  // Clear so a dev box's real CODEX_HOME / XDG_DATA_HOME cannot leak a write
  // outside the sandbox: codex then falls back to ~/.codex inside tmpHome.
  delete process.env.CODEX_HOME;
  delete process.env.XDG_DATA_HOME;

  fixtureModulePath = writeFixtureModule(tmpData);
});

afterEach(() => {
  for (const [key, envKey] of [
    ["HOME", "HOME"],
    ["USERPROFILE", "USERPROFILE"],
    ["APPDATA", "APPDATA"],
    ["XDG_CONFIG_HOME", "XDG_CONFIG_HOME"],
    ["XDG_DATA_HOME", "XDG_DATA_HOME"],
    ["CODEX_HOME", "CODEX_HOME"],
    ["DATA_DIR", "AGENT_CONNECTOR_DATA_DIR"],
    ["TELEMETRY", "AGENT_CONNECTOR_TELEMETRY"],
  ] as const) {
    const value = SAVED[key];
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
  for (const d of [tmpHome, tmpData]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Layer 1 — detailed 3-host suite (the original Phase-1 template, preserved
// verbatim: claude-code / codex / cursor exact native dialects + idempotency,
// dryRun, and registry-record invariants). These spot-checks lock the precise
// per-dialect bytes that the generic registry-driven suite below intentionally
// does not (it asserts "file exists + contains id" shape-agnostically).
// ─────────────────────────────────────────────────────────────────────────

/** The native config files claude-code, codex, cursor write at user scope. */
function nativePaths() {
  return {
    claudeServers: join(tmpHome, ".claude.json"),
    claudeHooks: join(tmpHome, ".claude", "settings.json"),
    codexConfig: join(tmpHome, ".codex", "config.toml"),
    codexHooks: join(tmpHome, ".codex", "hooks.json"),
    cursorMcp: join(tmpHome, ".cursor", "mcp.json"),
    cursorHooks: join(tmpHome, ".cursor", "hooks.json"),
  };
}

describe("install → uninstall roundtrip across claude-code, codex, cursor", () => {
  it("install writes all three platforms' native files containing the connector id", async () => {
    const connector = makeConnector();

    const result = await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["claude-code", "codex", "cursor"],
      dryRun: false,
    });

    expect(result.connectorId).toBe(CONNECTOR_ID);
    expect(result.dryRun).toBe(false);
    // No adapter should have warned (all three are registered + drivable).
    expect(result.warnings).toEqual([]);

    const p = nativePaths();

    // ── Claude Code ──────────────────────────────────────────────────────
    expect(existsSync(p.claudeServers)).toBe(true);
    const claudeServers = JSON.parse(readFileSync(p.claudeServers, "utf8"));
    expect(claudeServers.mcpServers).toHaveProperty(CONNECTOR_ID);
    expect(existsSync(p.claudeHooks)).toBe(true);
    const claudeHooksRaw = readFileSync(p.claudeHooks, "utf8");
    expect(claudeHooksRaw).toContain(`--connector ${CONNECTOR_ID}`);

    // ── Codex ────────────────────────────────────────────────────────────
    expect(existsSync(p.codexConfig)).toBe(true);
    const codexConfig = readFileSync(p.codexConfig, "utf8");
    // TOML table header for the connector's MCP server.
    expect(codexConfig).toContain(`[mcp_servers.${CONNECTOR_ID}]`);
    expect(existsSync(p.codexHooks)).toBe(true);
    expect(readFileSync(p.codexHooks, "utf8")).toContain(
      `--connector ${CONNECTOR_ID}`,
    );

    // ── Cursor ───────────────────────────────────────────────────────────
    expect(existsSync(p.cursorMcp)).toBe(true);
    const cursorMcp = JSON.parse(readFileSync(p.cursorMcp, "utf8"));
    expect(cursorMcp.mcpServers).toHaveProperty(CONNECTOR_ID);
    expect(existsSync(p.cursorHooks)).toBe(true);
    expect(readFileSync(p.cursorHooks, "utf8")).toContain(
      `--connector ${CONNECTOR_ID}`,
    );
  });

  it("registers the connector record under the data-root on install", async () => {
    const connector = makeConnector();
    await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["claude-code", "codex", "cursor"],
      dryRun: false,
    });

    const recordPath = join(
      tmpData,
      "connectors",
      CONNECTOR_ID,
      "connector.json",
    );
    expect(existsSync(recordPath)).toBe(true);
    const meta = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(meta.id).toBe(CONNECTOR_ID);
    expect(meta.modulePath).toBe(fixtureModulePath);
    // SessionStart + PreToolUse handlers were declared → recorded as hookEvents.
    expect(meta.hookEvents).toEqual(
      expect.arrayContaining(["SessionStart", "PreToolUse"]),
    );
  });

  it("uninstall removes every connector entry from the native files", async () => {
    const connector = makeConnector();
    await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["claude-code", "codex", "cursor"],
      dryRun: false,
    });

    const uninstall = await uninstallConnector({
      connectorId: CONNECTOR_ID,
      scope: "user",
      projectDir,
      targets: ["claude-code", "codex", "cursor"],
      dryRun: false,
    });
    expect(uninstall.connectorId).toBe(CONNECTOR_ID);

    const p = nativePaths();

    // Server entries gone from the JSON roots.
    const claudeServers = JSON.parse(readFileSync(p.claudeServers, "utf8"));
    expect(claudeServers.mcpServers ?? {}).not.toHaveProperty(CONNECTOR_ID);

    const cursorMcp = JSON.parse(readFileSync(p.cursorMcp, "utf8"));
    expect(cursorMcp.mcpServers ?? {}).not.toHaveProperty(CONNECTOR_ID);

    // Codex TOML table header for this connector is gone.
    expect(readFileSync(p.codexConfig, "utf8")).not.toContain(
      `[mcp_servers.${CONNECTOR_ID}]`,
    );

    // Hook commands for this connector are gone from every hook file.
    for (const hookFile of [p.claudeHooks, p.codexHooks, p.cursorHooks]) {
      if (existsSync(hookFile)) {
        expect(readFileSync(hookFile, "utf8")).not.toContain(
          `--connector ${CONNECTOR_ID}`,
        );
      }
    }
  });

  it("is idempotent: a second install reports skips and keeps a single entry", async () => {
    const connector = makeConnector();
    const opts = {
      connector,
      modulePath: fixtureModulePath,
      scope: "user" as const,
      projectDir,
      targets: ["claude-code", "codex", "cursor"] as const,
      dryRun: false,
    };

    await installConnector({ ...opts, targets: [...opts.targets] });
    const second = await installConnector({ ...opts, targets: [...opts.targets] });

    // The second pass must not create duplicate native registrations.
    expect(second.warnings).toEqual([]);
    expect(second.changes.some((c) => c.action === "skip")).toBe(true);

    const p = nativePaths();
    const claudeServers = JSON.parse(readFileSync(p.claudeServers, "utf8"));
    expect(Object.keys(claudeServers.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("dryRun does not write any native file or registry record", async () => {
    const connector = makeConnector();
    const result = await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["claude-code", "codex", "cursor"],
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    const p = nativePaths();
    for (const f of Object.values(p)) {
      expect(existsSync(f)).toBe(false);
    }
    // dryRun skips registerConnector → no record on disk.
    const recordPath = join(
      tmpData,
      "connectors",
      CONNECTOR_ID,
      "connector.json",
    );
    expect(existsSync(recordPath)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Layer 2 — registry-driven roundtrip across EVERY adapter.
//
// For each adapter: drive the real installConnector at USER scope, then
// uninstallConnector, and assert:
//   (a) PLACEMENT — every file the install REPORTS writing (a create/update
//       ChangeRecord carrying a path) exists on disk and contains the connector
//       id; AND where the adapter declares a server / hook config path it is
//       written when the adapter actually installs that surface.
//   (b) NO_RESIDUE — after uninstall the connector id is GONE from every file
//       the install wrote (clean-empty containers may remain).
//
// Paths are NOT hand-maintained: PLACEMENT uses the ORCHESTRATOR-RETURNED paths
// (drift-proof) cross-checked against each adapter's OWN getServerConfigPath /
// getHookConfigPath (resolved with the same ctx the installer builds). Adding a
// 36th adapter auto-covers it.
// ─────────────────────────────────────────────────────────────────────────

/** A file the install reported creating/updating (drift-proof placement source). */
function writtenFiles(changes: ChangeRecord[]): string[] {
  const seen = new Set<string>();
  for (const c of changes) {
    if ((c.action === "create" || c.action === "update") && c.path) {
      seen.add(c.path);
    }
  }
  return [...seen];
}

/**
 * Build the InstallContext the installer would build for `adapter` at `scope`,
 * so the test resolves the SAME native paths (no resolution drift). dataRoot() /
 * homeBinPath() read the test env that beforeEach set.
 */
function ctxFor(
  connector: ResolvedConnector,
  scope: InstallContext["scope"],
): InstallContext {
  return {
    connector,
    scope,
    projectDir,
    homeBinPath: homeBinPath(),
    dataRoot: dataRoot(),
    dryRun: false,
  };
}

/**
 * Recursively collect every regular file UNDER `dir` whose utf8 contents include
 * `needle`. The whole-sandbox NO_RESIDUE backstop: the per-written-file check
 * only re-reads orchestrator-REPORTED paths, so an adapter that writes an
 * UNREPORTED file (and leaves the id behind on uninstall) would slip past it.
 * This walks the entire HOME tree (projectDir is under it) and reads every file,
 * swallowing read errors / binary files (a file we cannot read as text cannot
 * carry the literal id string we are scanning for).
 */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return; // unreadable dir — nothing to scan
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        try {
          if (readFileSync(full, "utf8").includes(needle)) hits.push(full);
        } catch {
          /* binary / unreadable — cannot carry the literal id string */
        }
      }
    }
  };
  walk(dir);
  return hits;
}

/**
 * Hosts that, for a plain server+hooks connector at USER scope, legitimately
 * write NOTHING — a documented shape difference, NOT a bug:
 *   • pi — mcp-only host with NO writable MCP config and NO hook layer; it only
 *     drives the Agent Skills surface (writes a SKILL.md only when the connector
 *     declares skills, which this one does not). Its skills-surface roundtrip is
 *     spot-checked separately below.
 * Any OTHER host writing nothing is a real bug and fails the placement assertion.
 */
const WRITES_NOTHING_USER_SCOPE = new Set<string>(["pi"]);

// Self-policing guard: a host only belongs in WRITES_NOTHING_USER_SCOPE if its
// adapter genuinely cannot register an MCP server (no writable transports) AND
// declares no hook events — i.e. it has nothing to write for a server+hooks
// connector. This stops a future maintainer from quietly adding a host to the
// set to silence a REAL "writes nothing" placement failure: adding one forces
// proving the capability justification here.
describe("WRITES_NOTHING_USER_SCOPE allowlist is capability-justified", () => {
  it.each([...WRITES_NOTHING_USER_SCOPE])(
    "%s declares no MCP transports and no hook capabilities",
    async (platformId) => {
      const adapter = await (ADAPTER_REGISTRY.find((f) => f.id === platformId)!).load();
      const c = adapter.capabilities;
      expect(c.transports, `${platformId} declares MCP transports — it can write a server config`).toEqual([]);
      // The eight always-present hook capability flags must all be false (a host
      // with any of them writes a hook config for our hooks connector).
      const hookFlags = [
        c.preToolUse,
        c.postToolUse,
        c.preCompact,
        c.sessionStart,
        c.sessionEnd,
        c.userPromptSubmit,
        c.stop,
        c.notification,
      ];
      expect(hookFlags, `${platformId} declares a hook capability — it can write a hook config`).toEqual([
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
    },
  );
});

describe.each(ADAPTER_REGISTRY.map((f) => f.id))(
  "registry roundtrip — %s",
  (platformId) => {
    it("install places the connector id, uninstall leaves no residue", async () => {
      const adapter = await (ADAPTER_REGISTRY.find((f) => f.id === platformId)!).load();
      const connector = makeConnector();

      const install = await installConnector({
        connector,
        modulePath: fixtureModulePath,
        scope: "user",
        projectDir,
        targets: [platformId],
        dryRun: false,
      });

      // The orchestration must not have FAILED this adapter (a `runStep` catch
      // surfaces as a "<step> failed on <id>" warning — that is an adapter bug,
      // distinct from the legitimate skip/unsupported-surface warnings hosts emit).
      const failures = install.warnings.filter((w) => / failed on /.test(w));
      expect(failures, `orchestration step failures: ${failures.join("; ")}`).toEqual([]);

      const written = writtenFiles(install.changes);

      // ── (a) PLACEMENT ────────────────────────────────────────────────────
      if (WRITES_NOTHING_USER_SCOPE.has(platformId)) {
        // Documented content-only / no-writable-config shape: writes nothing for
        // a server+hooks connector. Its surface is spot-checked separately.
        expect(written).toEqual([]);
      } else {
        expect(
          written.length,
          `${platformId} wrote no native file for a server+hooks connector`,
        ).toBeGreaterThan(0);

        // Every file the install reported writing must exist and carry the id.
        for (const file of written) {
          expect(existsSync(file), `${platformId}: missing written file ${file}`).toBe(true);
          expect(
            readFileSync(file, "utf8"),
            `${platformId}: written file ${file} does not contain "${CONNECTOR_ID}"`,
          ).toContain(CONNECTOR_ID);
        }

        // Cross-check the adapter's OWN path getters (drift guard): when the
        // adapter actually installed its server surface (a create/update under
        // the server config path), that getter must resolve to a written file.
        const ctx = ctxFor(connector, "user");
        const serverPath = adapter.getServerConfigPath(ctx);
        const installedServer = install.changes.some(
          (c) =>
            c.path === serverPath &&
            (c.action === "create" || c.action === "update"),
        );
        if (installedServer) {
          expect(written, `${platformId}: server getter path not among written files`).toContain(
            serverPath,
          );
        }
      }

      // ── (b) NO_RESIDUE ───────────────────────────────────────────────────
      const uninstall = await uninstallConnector({
        connectorId: CONNECTOR_ID,
        scope: "user",
        projectDir,
        targets: [platformId],
        dryRun: false,
      });
      const unFailures = uninstall.warnings.filter((w) => / failed on /.test(w));
      expect(unFailures, `uninstall step failures: ${unFailures.join("; ")}`).toEqual([]);

      for (const file of written) {
        if (existsSync(file)) {
          expect(
            readFileSync(file, "utf8"),
            `${platformId}: residue — "${CONNECTOR_ID}" still present in ${file} after uninstall`,
          ).not.toContain(CONNECTOR_ID);
        }
      }

      // Whole-sandbox backstop (ALL hosts, incl. pi): walk the ENTIRE HOME tree
      // and assert NO file anywhere still contains the connector id. Catches an
      // adapter that wrote an UNREPORTED file and left residue there — invisible
      // to the per-written-file loop above, which only re-reads reported paths.
      const sandboxResidue = filesContaining(tmpHome, CONNECTOR_ID);
      expect(
        sandboxResidue,
        `${platformId}: sandbox residue — "${CONNECTOR_ID}" still present after uninstall in: ${sandboxResidue.join(", ")}`,
      ).toEqual([]);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────
// Layer 2b — content-only host spot-check: pi writes nothing for a server+hooks
// connector (asserted above), so its real surface — the Agent Skills SKILL.md —
// is exercised here. Anchored on the install-reported path (named by the SKILL,
// not the connector id) and on NO_RESIDUE after uninstall.
// ─────────────────────────────────────────────────────────────────────────

describe("registry roundtrip — pi skills surface", () => {
  it("install writes a SKILL.md under pi, uninstall removes it", async () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme DB Tools",
      version: "1.2.3",
      server: { transport: "stdio", command: "npx", args: ["-y", "@acme/db-mcp"] },
      skills: [
        {
          name: "acme-skill",
          description: "Query and write to the Acme DB.",
          body: "Use the acme db.",
        },
      ],
    });

    // Register a fixture module that DECLARES the skill, so uninstall re-loads a
    // connector whose surfaces match the install (the orchestrator removes a
    // content surface only when the loaded connector still declares it — exactly
    // how a real install/uninstall pair shares one connector module). The shared
    // server+hooks fixtureModulePath declares no skills, so reusing it would make
    // uninstall skip skill removal (a test artefact, not a pi adapter bug).
    const skillsModule = writeSkillsFixtureModule(tmpData);

    const install = await installConnector({
      connector,
      modulePath: skillsModule,
      scope: "user",
      projectDir,
      targets: ["pi"],
      dryRun: false,
    });

    const skillFile = install.changes.find(
      (c) =>
        (c.action === "create" || c.action === "update") &&
        c.path?.endsWith("SKILL.md"),
    )?.path;
    expect(skillFile, "pi did not write a SKILL.md for a declared skill").toBeTruthy();
    expect(existsSync(skillFile!)).toBe(true);
    // The skill dir is named by the SKILL (acme-skill), so the connector id is
    // NOT expected inside SKILL.md — the meaningful placement anchor is the file
    // existing under pi's skills surface (the orchestrator-reported path).
    expect(skillFile!).toContain(join(".pi", "agent", "skills", "acme-skill"));

    await uninstallConnector({
      connectorId: CONNECTOR_ID,
      scope: "user",
      projectDir,
      targets: ["pi"],
      dryRun: false,
    });
    expect(existsSync(skillFile!), "pi SKILL.md residue after uninstall").toBe(false);
  });
});
