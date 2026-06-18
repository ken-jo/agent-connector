/**
 * integration/cli-install-smoke — HEADLESS install lifecycle over the BUILT bin.
 *
 * Spawns `node dist/cli.js …` (NOT in-process core functions) against a fresh
 * isolated HOME / data-root / project per test, exactly the way a user would
 * invoke the published binary. It proves the four end-to-end surfaces the CLI
 * is supposed to drive, on the representative host claude-code:
 *
 *   1. MCP-ONLY  — a server-only connector writes the MCP entry and NO hook.
 *   2. HOOK-ONLY — a hooks-only connector writes the hook and NO MCP entry.
 *   3. FULL + lifecycle — a server+hooks connector, then:
 *        a) `serve`     boots the telemetry proxy and forwards a real MCP
 *                       initialize + tools/list handshake to a stub server.
 *        b) `hook`      dispatches a PreToolUse event headlessly → exit 0 +
 *                       a normalized host-native control payload.
 *        c) `uninstall` removes the MCP + hook entries.
 *   4. PLUGIN    — `install --method marketplace --scope user` stages the plugin
 *                  bundle + shared catalog + framework record on disk.
 *
 * Isolation mirrors install-roundtrip.test.ts but at the PROCESS boundary: each
 * spawned child gets HOME / USERPROFILE / AGENT_CONNECTOR_DATA_DIR / XDG roots /
 * CLAUDE_CONFIG_DIR pointed at fresh temp dirs (via tempDir from ../support/env,
 * which is Windows 8.3 short-name safe — NOT raw mkdtempSync). Every child is
 * awaited / closed; the long-lived `serve` process is explicitly terminated
 * after the handshake so no daemon leaks (no name-based pkill).
 *
 * The dist build is a committed prerequisite (dist/cli.js to spawn, dist/index.js
 * for the fixture .mjs imports); beforeAll builds it ONCE only if missing.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

import { tempDir } from "../support/env.js";

// ── Built artifacts (committed prerequisites). ───────────────────────────────
const REPO_ROOT = join(__dirname, "..", "..");
const DIST_CLI = join(REPO_ROOT, "dist", "cli.js");
const DIST_INDEX = join(REPO_ROOT, "dist", "index.js");
// A real, committed stub stdio MCP server (newline-delimited JSON-RPC; answers
// initialize / tools/list / tools/call; exits 0 when stdin ends) so the full
// connector's `serve` proxy has something real to forward to.
const FAKE_MCP_SERVER = join(__dirname, "fixtures", "fake-mcp-server.mjs");

const CONNECTOR_ID = "acme-db";

let tmpHome: string;
let tmpData: string;
let tmpCfg: string;
let tmpBin: string;
let claudeLog: string;
let projectDir: string;

beforeAll(() => {
  // Rely on a prebuilt dist if present; build ONCE only when missing so the
  // suite is self-sufficient on a clean checkout without re-building every run.
  if (!existsSync(DIST_CLI) || !existsSync(DIST_INDEX)) {
    execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "ignore" });
  }
}, 180_000);

beforeEach(() => {
  tmpHome = tempDir("ac-smoke-home-");
  tmpData = tempDir("ac-smoke-data-");
  tmpCfg = tempDir("ac-smoke-cfg-");
  tmpBin = tempDir("ac-smoke-bin-");
  claudeLog = join(tmpBin, "claude-invocations.log");
  projectDir = tempDir("ac-smoke-proj-");
  writeFakeCli(tmpBin, "claude", FAKE_CLAUDE_MJS);
});

afterEach(() => {
  for (const d of [tmpHome, tmpData, tmpCfg, tmpBin, projectDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** The isolated child env every spawned CLI invocation runs under. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.HOME = tmpHome;
  env.USERPROFILE = tmpHome;
  env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  // Empty XDG / claude config roots so no host reader resolves outside the temp
  // HOME, and the marketplace path stages host state under the temp config dir.
  env.XDG_DATA_HOME = join(tmpHome, ".local", "share");
  env.XDG_CONFIG_HOME = join(tmpHome, ".config");
  env.CLAUDE_CONFIG_DIR = tmpCfg;
  // Don't inherit a telemetry kill-switch from the runner; default wrapping.
  delete env.AGENT_CONNECTOR_TELEMETRY;
  // Prepend the controlled bin dir so the fake `claude` always wins over any
  // real binary on the host PATH. This makes the PLUGIN scenario hermetic on CI.
  env.PATH = `${tmpBin}${delimiter}${process.env.PATH ?? ""}`;
  env.FAKE_CLAUDE_LOG = claudeLog;
  return env;
}

/**
 * Run the built CLI to completion in the isolated HOME. spawnSync never throws
 * on a non-zero exit (so fail-path / exit-code assertions are clean) and lets us
 * feed a stdin payload (hook events) while reading stdout + stderr together.
 */
function runCli(
  args: string[],
  opts: { input?: string } = {},
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [DIST_CLI, ...args], {
    encoding: "utf8",
    env: childEnv(),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/**
 * Write a fixture connector module that imports defineConnector from the BUILT
 * dist entry via an absolute file URL (the SRC index is not importable from a
 * plain .mjs). `body` is the object literal passed to defineConnector.
 */
function writeConnectorModule(body: string): string {
  const modPath = join(projectDir, "agent-connector.config.mjs");
  const distUrl = pathToFileURL(DIST_INDEX).href;
  writeFileSync(
    modPath,
    `import { defineConnector } from ${JSON.stringify(distUrl)};\n` +
      `export default defineConnector(${body});\n`,
    "utf8",
  );
  return modPath;
}

// ── Fake claude CLI source (mirrors live-verified plugin-verb contract). ──────
/**
 * Tiny node script that emulates `claude plugin marketplace add/remove` +
 * `claude plugin install/uninstall` so the marketplace driver's outcome.ok is
 * true deterministically, without any real claude binary.
 */
const FAKE_CLAUDE_MJS = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + "\\n");
}
const cfg = process.env.CLAUDE_CONFIG_DIR;
const kmPath = join(cfg, "plugins", "known_marketplaces.json");
const ipPath = join(cfg, "plugins", "installed_plugins.json");
const readJson = (p, dflt) => {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; }
};
const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2));
};

if (args[0] !== "plugin") process.exit(2);
switch (args[1]) {
  case "validate":
    process.exit(0);
  case "marketplace": {
    const km = readJson(kmPath, {});
    if (args[2] === "add") {
      km["agent-connector"] = {
        source: { source: "directory", path: args[3] },
        installLocation: args[3],
        lastUpdated: new Date().toISOString(),
      };
      writeJson(kmPath, km);
      process.exit(0);
    }
    if (args[2] === "remove") {
      if (!km[args[3]]) process.exit(1);
      delete km[args[3]];
      writeJson(kmPath, km);
      process.exit(0);
    }
    process.exit(2);
  }
  case "install": {
    const ip = readJson(ipPath, { version: 2, plugins: {} });
    ip.plugins[args[2]] = [
      { scope: "user", installPath: "/fake/cache", version: "1.2.3", installedAt: new Date().toISOString() },
    ];
    writeJson(ipPath, ip);
    process.exit(0);
  }
  case "uninstall": {
    const ip = readJson(ipPath, { version: 2, plugins: {} });
    if (!ip.plugins[args[2]]) process.exit(1);
    delete ip.plugins[args[2]];
    writeJson(ipPath, ip);
    process.exit(0);
  }
  default:
    process.exit(2);
}
`;

/** Write a fake CLI `name` (node script + sh/.cmd wrapper) into `dir`. */
function writeFakeCli(dir: string, name: string, mjs: string): void {
  const script = join(dir, `fake-${name}.mjs`);
  writeFileSync(script, mjs, "utf8");
  const node = process.execPath;
  if (process.platform === "win32") {
    writeFileSync(
      join(dir, `${name}.cmd`),
      `@echo off\r\n"${node}" "${script}" %*\r\n`,
      "utf8",
    );
  } else {
    const sh = join(dir, name);
    writeFileSync(sh, `#!/bin/sh\nexec "${node}" "${script}" "$@"\n`, "utf8");
    chmodSync(sh, 0o755);
  }
}

const claudeServersPath = () => join(tmpHome, ".claude.json");
const claudeHooksPath = () => join(tmpHome, ".claude", "settings.json");

/** Read ~/.claude.json (server entries); {} when the file was never written. */
function readClaudeServers(): { mcpServers?: Record<string, unknown> } {
  const p = claudeServersPath();
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

/** Make claude-code "detected" by seeding its user-scope config dir. */
function seedClaudeHost(): void {
  mkdirSync(join(tmpHome, ".claude"), { recursive: true });
  writeFileSync(join(tmpHome, ".claude", "settings.json"), "{}", "utf8");
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 1 — MCP-ONLY install.
// ═══════════════════════════════════════════════════════════════════════════
describe("cli install smoke (built dist/cli.js, claude-code)", () => {
  it("MCP-ONLY install writes the MCP server entry and NO hook entry", () => {
    seedClaudeHost();
    const cfg = writeConnectorModule(`{
      id: ${JSON.stringify(CONNECTOR_ID)},
      displayName: "Acme DB Tools",
      version: "1.2.3",
      server: { transport: "stdio", command: "npx", args: ["-y", "@acme/db-mcp"] },
    }`);

    const { code } = runCli([
      "install",
      "--connector",
      cfg,
      "--scope",
      "user",
      "--targets",
      "claude-code",
      "--project",
      projectDir,
    ]);
    expect(code).toBe(0);

    // MCP entry present in ~/.claude.json.
    expect(readClaudeServers().mcpServers).toHaveProperty(CONNECTOR_ID);

    // NO hook for this connector: settings.json either has no hooks or the
    // home-bin hook command for this connector was never written.
    if (existsSync(claudeHooksPath())) {
      const hooksRaw = readFileSync(claudeHooksPath(), "utf8");
      expect(hooksRaw).not.toContain(`--connector ${CONNECTOR_ID}`);
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // Scenario 2 — HOOK-ONLY install.
  // ════════════════════════════════════════════════════════════════════════
  it("HOOK-ONLY install writes the hook entry and NO MCP server entry", () => {
    seedClaudeHost();
    const cfg = writeConnectorModule(`{
      id: ${JSON.stringify(CONNECTOR_ID)},
      displayName: "Acme DB Tools",
      version: "1.2.3",
      hooks: {
        PreToolUse: {
          matcher: "acme_query|acme_write",
          handler(evt) {
            return evt.toolName === "acme_write"
              ? { decision: "ask", reason: "confirm write" }
              : { decision: "allow" };
          },
        },
      },
    }`);

    const { code } = runCli([
      "install",
      "--connector",
      cfg,
      "--scope",
      "user",
      "--targets",
      "claude-code",
      "--project",
      projectDir,
    ]);
    expect(code).toBe(0);

    // Hook entry present, keyed by the home-bin --connector token.
    expect(existsSync(claudeHooksPath())).toBe(true);
    expect(readFileSync(claudeHooksPath(), "utf8")).toContain(
      `--connector ${CONNECTOR_ID}`,
    );

    // NO MCP server entry for this connector.
    expect(readClaudeServers().mcpServers ?? {}).not.toHaveProperty(
      CONNECTOR_ID,
    );
  });

  // ════════════════════════════════════════════════════════════════════════
  // Scenario 3 — FULL install + lifecycle (serve / hook / uninstall).
  // ════════════════════════════════════════════════════════════════════════
  it("FULL install writes both MCP + hook entries and registers the connector", () => {
    seedClaudeHost();
    const cfg = writeFullConnector();

    const { code } = runCli([
      "install",
      "--connector",
      cfg,
      "--scope",
      "user",
      "--targets",
      "claude-code",
      "--project",
      projectDir,
    ]);
    expect(code).toBe(0);

    // Both surfaces written.
    expect(readClaudeServers().mcpServers).toHaveProperty(CONNECTOR_ID);
    expect(readFileSync(claudeHooksPath(), "utf8")).toContain(
      `--connector ${CONNECTOR_ID}`,
    );

    // The connector record is registered under the data-root (required for the
    // serve/hook runtime to re-import live handlers in later steps).
    const record = join(tmpData, "connectors", CONNECTOR_ID, "connector.json");
    expect(existsSync(record)).toBe(true);
    const meta = JSON.parse(readFileSync(record, "utf8"));
    expect(meta.id).toBe(CONNECTOR_ID);
    expect(meta.hookEvents).toEqual(
      expect.arrayContaining(["SessionStart", "PreToolUse"]),
    );
  });

  it("FULL lifecycle (a) serve boots and forwards an MCP initialize + tools/list handshake", async () => {
    seedClaudeHost();
    const cfg = writeFullConnector();
    // Register the connector so `serve` can resolve it (telemetry stamping).
    expect(installFull(cfg)).toBe(0);

    // Spawn the telemetry proxy headlessly, wrapping the real stub MCP server.
    // The proxy is transparent: we drive the stub server through it over the
    // child's stdin/stdout with newline-delimited JSON-RPC 2.0.
    const child = spawn(
      process.execPath,
      [
        DIST_CLI,
        "serve",
        "--connector",
        CONNECTOR_ID,
        "--host",
        "claude-code",
        "--",
        process.execPath,
        FAKE_MCP_SERVER,
      ],
      { env: childEnv(), stdio: ["pipe", "pipe", "pipe"] },
    );

    const responses: Record<string, unknown>[] = [];
    let outBuf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outBuf += chunk;
      let nl = outBuf.indexOf("\n");
      while (nl !== -1) {
        const line = outBuf.slice(0, nl).replace(/\r$/, "");
        outBuf = outBuf.slice(nl + 1);
        if (line.trim() !== "") {
          try {
            responses.push(JSON.parse(line));
          } catch {
            /* ignore non-JSON framing noise */
          }
        }
        nl = outBuf.indexOf("\n");
      }
    });

    const exitPromise = new Promise<number>((resolve) => {
      child.on("close", (codeNum) => resolve(codeNum ?? 1));
    });

    try {
      // initialize → tools/list. The stub answers synchronously on receipt.
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "claude-ai" } },
        }) + "\n",
      );
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }) + "\n",
      );
      // End stdin → proxy ends the child server's stdin → stub exits 0 → the
      // proxy resolves with that exit code. No daemon leaks.
      child.stdin.end();

      const exitCode = await Promise.race([
        exitPromise,
        new Promise<number>((_resolve, reject) =>
          setTimeout(() => reject(new Error("serve handshake timed out")), 20_000),
        ),
      ]);
      expect(exitCode).toBe(0);
    } finally {
      // Defensive: never leave a daemon behind even if an assertion threw.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }

    // A valid JSON-RPC initialize result flowed back through the proxy.
    const initResp = responses.find((r) => r.id === 1) as
      | { jsonrpc?: string; result?: { serverInfo?: { name?: string } } }
      | undefined;
    expect(initResp).toBeDefined();
    expect(initResp!.jsonrpc).toBe("2.0");
    expect(initResp!.result?.serverInfo?.name).toBe("fake-mcp");

    // tools/list forwarded back a non-empty tool set.
    const toolsResp = responses.find((r) => r.id === 2) as
      | { result?: { tools?: Array<{ name: string }> } }
      | undefined;
    expect(toolsResp).toBeDefined();
    expect(Array.isArray(toolsResp!.result?.tools)).toBe(true);
    expect(toolsResp!.result!.tools!.length).toBeGreaterThan(0);
  }, 30_000);

  it("FULL lifecycle (b) hook dispatches a PreToolUse event → exit 0 + normalized reply", () => {
    seedClaudeHost();
    const cfg = writeFullConnector();
    expect(installFull(cfg)).toBe(0);

    // Feed a claude-code-native PreToolUse payload for a matched tool that the
    // handler asks-to-confirm; the dispatch normalizes it to a host control
    // payload on stdout (proves the registered handler fired end-to-end).
    const payload = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "acme_write",
      tool_input: { sql: "DELETE FROM users" },
      session_id: "sess-smoke-1",
      cwd: projectDir,
    });

    const { code, stdout } = runCli(
      ["hook", "claude-code", "PreToolUse", "--connector", CONNECTOR_ID],
      { input: payload },
    );

    expect(code).toBe(0);
    expect(stdout.trim()).not.toBe("");
    const reply = JSON.parse(stdout);
    expect(reply.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    // acme_write → handler returns { decision: "ask" } → normalized permission.
    expect(reply.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(reply.hookSpecificOutput.permissionDecisionReason).toContain(
      "confirm write",
    );
  });

  it("FULL lifecycle (c) uninstall removes the MCP + hook entries", () => {
    seedClaudeHost();
    const cfg = writeFullConnector();
    expect(installFull(cfg)).toBe(0);

    // Sanity: both surfaces are present before uninstall.
    expect(readClaudeServers().mcpServers).toHaveProperty(CONNECTOR_ID);
    expect(readFileSync(claudeHooksPath(), "utf8")).toContain(
      `--connector ${CONNECTOR_ID}`,
    );

    const { code } = runCli([
      "uninstall",
      "--connector-id",
      CONNECTOR_ID,
      "--scope",
      "user",
      "--targets",
      "claude-code",
      "--project",
      projectDir,
    ]);
    expect(code).toBe(0);

    // MCP server entry gone.
    expect(readClaudeServers().mcpServers ?? {}).not.toHaveProperty(
      CONNECTOR_ID,
    );
    // Hook command for this connector gone.
    if (existsSync(claudeHooksPath())) {
      expect(readFileSync(claudeHooksPath(), "utf8")).not.toContain(
        `--connector ${CONNECTOR_ID}`,
      );
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // Scenario 4 — PLUGIN install (marketplace, user scope).
  // ════════════════════════════════════════════════════════════════════════
  it("PLUGIN install (--method marketplace --scope user) stages the bundle + catalog + record", () => {
    seedClaudeHost();
    const cfg = writeFullConnector();

    // The fake `claude` binary (on PATH via tmpBin) satisfies the plugin-install
    // drive so outcome.ok === true and marketplace-installs.json is written.
    const { code } = runCli([
      "install",
      "--method",
      "marketplace",
      "--scope",
      "user",
      "--connector",
      cfg,
      "--targets",
      "claude-code",
      "--project",
      projectDir,
    ]);
    expect(code).toBe(0);

    // Staged plugin bundle on disk under <dataRoot>/marketplace/claude/<id>/.
    const stagingRoot = join(tmpData, "marketplace", "claude");
    const bundleDir = join(stagingRoot, CONNECTOR_ID);
    const manifest = join(bundleDir, ".claude-plugin", "plugin.json");
    expect(existsSync(manifest)).toBe(true);
    expect(JSON.parse(readFileSync(manifest, "utf8")).name).toBe(CONNECTOR_ID);
    // Connector has a server → the bundle carries an .mcp.json.
    expect(existsSync(join(bundleDir, ".mcp.json"))).toBe(true);

    // The ONE shared catalog lists the connector.
    const catalogPath = join(
      stagingRoot,
      ".claude-plugin",
      "marketplace.json",
    );
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    expect(catalog.name).toBe("agent-connector");
    expect(catalog.plugins.map((p: { name: string }) => p.name)).toContain(
      CONNECTOR_ID,
    );

    // The framework's per-connector marketplace-installs.json record on disk.
    const recordPath = join(
      tmpData,
      "connectors",
      CONNECTOR_ID,
      "marketplace-installs.json",
    );
    expect(existsSync(recordPath)).toBe(true);
    const record = JSON.parse(readFileSync(recordPath, "utf8"))["claude-code"];
    expect(record).toBeDefined();
    expect(record.format).toBe("claude-plugin");
    expect(record.bundleDir).toBe(bundleDir);
  });
});

// ── Shared full-connector fixture (server + PreToolUse + SessionStart). ──────
/** Write the full connector module; its server is the stub stdio MCP server. */
function writeFullConnector(): string {
  return writeConnectorModule(`{
    id: ${JSON.stringify(CONNECTOR_ID)},
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: { transport: "stdio", command: "node", args: [${JSON.stringify(FAKE_MCP_SERVER)}] },
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
  }`);
}

/** Direct-install the full connector via the built CLI; returns the exit code. */
function installFull(cfg: string): number {
  return runCli([
    "install",
    "--connector",
    cfg,
    "--scope",
    "user",
    "--targets",
    "claude-code",
    "--project",
    projectDir,
  ]).code;
}
