/**
 * tests/adapters/mistral-vibe — the ONE per-host file for the Mistral Vibe
 * adapter. Byte-oracle for an mcp-only host whose MCP config is TOML with a
 * `mcp_servers` ARRAY-OF-TABLES ([[mcp_servers]], each entry keyed by a `name`
 * short alias — distinct from codex's table-keyed [mcp_servers.<name>]):
 *   • MCP servers → <configDir>/config.toml, root key "mcp_servers" (TOML array;
 *                   stdio { name, transport:"stdio", command, args?, env? },
 *                   remote { name, transport:"http"|"streamable-http", url,
 *                   headers? }; ${env:VAR} resolved to LITERALS — TOML has no
 *                   interpolation token).
 *   • hooks       → UNAVAILABLE (mcp-only HONEST CEILING — Vibe's hook surface is
 *                   experimental + not byte-confirmed). installHooks/uninstallHooks
 *                   report "skip".
 * configDir = ~/.vibe (user) / <projectDir>/.vibe (project, precedence).
 *
 * HONEST CEILING: Mistral Vibe is not authed/installable locally, so this file
 * is a placement + byte-oracle guard (config bytes, array-by-name ownership,
 * idempotency, sibling preservation, zero-residue, detection). MCP shape is
 * byte-confirmed from the official repo README (github.com/mistralai/mistral-vibe)
 * + docs (docs.mistral.ai/vibe/code/cli/configuration + /mcp-servers). Uses the
 * shared harness (tests/support/env + adapter-suite + fs).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import TOML from "@iarna/toml";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import vibeAdapter from "../../src/adapters/mistral-vibe/index.js";
import { buildCtx, freshHomeProject, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";

const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";

interface VibeEntry {
  name?: string;
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** Parse a Vibe config.toml and return its mcp_servers array (or []). */
function readServers(path: string): VibeEntry[] {
  const cfg = TOML.parse(readFileSync(path, "utf8")) as { mcp_servers?: VibeEntry[] };
  return cfg.mcp_servers ?? [];
}

// The serve-wrapper args bake the install TARGET platform as `--host mistral-vibe`
// (before `--`). The harness's dataRoot equals the default root, so NO --data-dir.
const wrappedArgs = (scope: "project" | "user"): string[] => [
  "serve",
  "--connector",
  CONNECTOR_ID,
  "--scope",
  scope,
  "--host",
  "mistral-vibe",
  "--",
  "npx",
  "-y",
  "@x/y",
];

/** A connector with a stdio server carrying an env-ref (must be baked to a literal). */
function buildStdioConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
      env: { [ENV_VAR]: `\${env:${ENV_VAR}}` },
      tools: { include: ["*"] },
    },
  });
}

/** A connector with a remote (http) server. */
function buildHttpConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "http",
      url: `\${env:ACME_URL}`,
      headers: { Authorization: `Bearer \${env:ACME_TOKEN}` },
      tools: { include: ["*"] },
    },
  });
}

// ── baseline contract ─────────────────────────────────────────────────────────

createAdapterSuite({ adapter: vibeAdapter, paradigm: "mcp-only" });

// ── detection ───────────────────────────────────────────────────────────────

describe("mistral-vibe adapter — detection", () => {
  isolateEnv();

  it("reports not-installed on a clean home", () => {
    const projectDir = freshProject();
    const d = vibeAdapter.detectInstalled(projectDir);
    expect(d.id).toBe("mistral-vibe");
    expect(d.paradigm).toBe("mcp-only");
    expect(d.installed).toBe(false);
    expect(d.confidence).toBe("low");
  });

  it("detects a project-only .vibe/config.toml as project scope (precedence)", () => {
    // Use a SEPARATE HOME + project dir so the project .vibe is distinct from the
    // user ~/.vibe — project scope is reported only when the user dir is absent.
    const { projectDir } = freshHomeProject();
    const cfg = join(projectDir, ".vibe", "config.toml");
    vibeAdapter.installServer(buildCtx(projectDir, buildStdioConnector(), "project"));
    expect(existsSync(cfg)).toBe(true);
    const d = vibeAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("project");
    expect(d.confidence).toBe("high");
  });
});

// ── MCP server render (stdio + http) — config.toml, [[mcp_servers]] ───────────

describe("mistral-vibe adapter — MCP server render", () => {
  isolateEnv([ENV_VAR, "ACME_URL", "ACME_TOKEN"]);
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildStdioConnector(), "project");
  });
  afterEach(() => {});

  it("installServer writes a [[mcp_servers]] array entry keyed by name, serve-wrapped, ${env:VAR} BAKED to a literal", () => {
    process.env[ENV_VAR] = "postgres://secret@db/acme";
    const changes = vibeAdapter.installServer(ctx);
    expect(changes.every((c) => c.action !== "warn")).toBe(true);
    expect(changes[0]!.action).toBe("create");

    const path = join(projectDir, ".vibe", "config.toml");
    const servers = readServers(path);
    expect(servers).toHaveLength(1);
    // stdio entry shape: { name, transport, command, args, env } — name = id.
    expect(servers[0]).toEqual({
      name: CONNECTOR_ID,
      transport: "stdio",
      command: HOME_BIN,
      args: wrappedArgs("project"),
      env: { [ENV_VAR]: "postgres://secret@db/acme" },
    });
    // The on-disk file is TOML array-of-tables (NOT codex's table-keyed form).
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("[[mcp_servers]]");
    expect(raw).not.toContain("[mcp_servers.acme-db]");
    // TOML has no native ${env:VAR} token → the ref must be resolved, not stored.
    expect(raw).not.toContain(`\${env:${ENV_VAR}}`);
  });

  it("installServer (user scope) targets ~/.vibe/config.toml and bakes --host/--scope user", () => {
    const userCtx = buildCtx(projectDir, buildStdioConnector(), "user");
    vibeAdapter.installServer(userCtx);
    const path = vibeAdapter.getServerConfigPath(userCtx);
    expect(path).toBe(join(vibeAdapter.getConfigDir(userCtx), "config.toml"));
    expect(existsSync(path)).toBe(true);
    expect(readServers(path)[0]!.args).toEqual(wrappedArgs("user"));
  });

  it("renders a remote http server as { name, transport:'http', url, headers } with ${env:VAR} BAKED", () => {
    process.env.ACME_URL = "https://mcp.acme.test";
    process.env.ACME_TOKEN = "tok-123";
    const httpCtx = buildCtx(projectDir, buildHttpConnector(), "project");
    vibeAdapter.installServer(httpCtx);
    const path = join(projectDir, ".vibe", "config.toml");
    const entry = readServers(path)[0]!;
    expect(entry.name).toBe(CONNECTOR_ID);
    expect(entry.transport).toBe("http");
    expect(entry.url).toBe("https://mcp.acme.test");
    expect(entry.headers).toEqual({ Authorization: "Bearer tok-123" });
    // remote is not telemetry-wrapped.
    expect(entry.command).toBeUndefined();
    delete process.env.ACME_URL;
    delete process.env.ACME_TOKEN;
  });

  it("is idempotent — a second install of the same connector is a skip (no duplicate entry)", () => {
    vibeAdapter.installServer(ctx);
    const second = vibeAdapter.installServer(ctx);
    expect(second[0]!.action).toBe("skip");
    const path = join(projectDir, ".vibe", "config.toml");
    expect(readServers(path)).toHaveLength(1);
  });

  it("preserves a pre-seeded sibling [[mcp_servers]] entry when appending ours", () => {
    const path = join(projectDir, ".vibe", "config.toml");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      TOML.stringify({
        mcp_servers: [{ name: "other-tool", transport: "stdio", command: "other" }],
      } as never),
      "utf8",
    );
    vibeAdapter.installServer(ctx);
    const names = readServers(path).map((e) => e.name).sort();
    expect(names).toEqual([CONNECTOR_ID, "other-tool"].sort());
  });

  it("skip-and-warn on a malformed (non-array) mcp_servers — never clobbers it", () => {
    const path = join(projectDir, ".vibe", "config.toml");
    mkdirSync(dirname(path), { recursive: true });
    // A hand-written TABLE-keyed mcp_servers (codex's shape) — install must NOT
    // overwrite it; it skips and leaves the bytes intact.
    const original = TOML.stringify({
      mcp_servers: { "other-tool": { command: "x" } },
    } as never);
    writeFileSync(path, original, "utf8");
    const changes = vibeAdapter.installServer(ctx);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("not a TOML array");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("uninstallServer removes ONLY our entry and preserves siblings + zero-residue", () => {
    const path = join(projectDir, ".vibe", "config.toml");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      TOML.stringify({
        mcp_servers: [{ name: "other-tool", transport: "stdio", command: "other" }],
      } as never),
      "utf8",
    );
    vibeAdapter.installServer(ctx);
    expect(readServers(path)).toHaveLength(2);

    const removed = vibeAdapter.uninstallServer(ctx);
    expect(removed[0]!.action).toBe("remove");
    const servers = readServers(path);
    // sibling survives, ours is gone (no orphan bytes).
    expect(servers.map((e) => e.name)).toEqual(["other-tool"]);
    expect(readFileSync(path, "utf8")).not.toContain(HOME_BIN);
    expect(readFileSync(path, "utf8")).not.toContain(CONNECTOR_ID);
  });

  it("uninstallServer on an absent config is a clean skip", () => {
    const skipped = vibeAdapter.uninstallServer(ctx);
    expect(skipped[0]!.action).toBe("skip");
  });
});

// ── hooks — UNAVAILABLE (mcp-only honest ceiling) ─────────────────────────────

describe("mistral-vibe adapter — hooks unavailable", () => {
  isolateEnv();

  it("installHooks / uninstallHooks report 'skip' and write nothing", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, buildStdioConnector(), "project");
    const ins = vibeAdapter.installHooks(ctx);
    const uni = vibeAdapter.uninstallHooks(ctx);
    expect(ins[0]!.action).toBe("skip");
    expect(uni[0]!.action).toBe("skip");
    expect(ins[0]!.detail).toContain("mcp-only");
  });
});
