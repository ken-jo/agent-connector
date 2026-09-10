/**
 * adapters/junie.test.ts — Junie (JetBrains' OWN coding agent) adapter tests.
 *
 * Junie is JetBrains' own LLM-agnostic coding agent (the `junie` CLI, npm
 * @jetbrains/junie, github.com/JetBrains/junie) — DISTINCT from the
 * jetbrains-copilot adapter (GitHub Copilot in JetBrains IDEs). It is mcp-only
 * and exposes:
 *   MCP → <projectDir>/.junie/mcp/mcp.json (project) and ~/.junie/mcp/mcp.json
 *         (user); root "mcpServers" (object map). stdio { command, args?, env? };
 *         remote { url, headers? } (`url`, not `serverUrl`; no type/disabled).
 *
 * MCP paths/root-key/entry shapes are BYTE-CONFIRMED from the first-party docs
 * (junie.jetbrains.com/docs/junie-cli-mcp-configuration.html: "Junie CLI uses
 * the same MCP JSON configuration as Junie in JetBrains IDEs").
 *
 * All tests are HOME-isolated via the shared harness and deterministic. Mirrors
 * tests/adapters/cline.test.ts / windsurf.test.ts (the mcp-only template).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, beforeEach } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import junieAdapter from "../../src/adapters/junie/index.js";
import { buildCtx, freshHomeProject, isolateEnv } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { splitFrontmatter } from "../support/fs.js";

const CONNECTOR_ID = "acme-junie";

const SERVER = {
  transport: "stdio",
  command: "acme-mcp",
  args: ["--port", "0"],
  // Disable the transparent telemetry serve-wrapper so the rendered entry holds
  // the literal command/args (the wrap behavior is covered by spawn/render tests).
  wrapForTelemetry: false,
} as const;

function buildConnector(cfg: Partial<ConnectorConfig> = {}): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Junie",
    version: "1.0.0",
    server: { ...SERVER, args: [...SERVER.args] },
    ...cfg,
  });
}

/** User-scope mcp.json path under HOME. */
function userMcpPath(home: string): string {
  return join(home, ".junie", "mcp", "mcp.json");
}

/** Project-scope mcp.json path. */
function projectMcpPath(projectDir: string): string {
  return join(projectDir, ".junie", "mcp", "mcp.json");
}

isolateEnv();
createAdapterSuite({ adapter: junieAdapter, paradigm: "mcp-only" });

// ── capability flags ────────────────────────────────────────────────────────

describe("junie adapter — identity + capabilities", () => {
  it("is an mcp-only host named Junie, DISTINCT from jetbrains-copilot", () => {
    expect(junieAdapter.id).toBe("junie");
    expect(junieAdapter.name).toBe("Junie");
    expect(junieAdapter.id).not.toBe("jetbrains-copilot");
    expect(junieAdapter.paradigm).toBe("mcp-only");
    // mcp-only: no hooks. MCP is stdio + http.
    expect(junieAdapter.capabilities.preToolUse).toBe(false);
    expect(junieAdapter.capabilities.canModifyArgs).toBe(false);
    expect(junieAdapter.capabilities.transports).toEqual(["stdio", "http"]);
    // memory via the AGENTS.md base default; Agent Skills wired; commands and
    // subagents stay unwired (on-disk layout not byte-confirmed).
    expect(junieAdapter.capabilities.supportsMemory).toBe(true);
    expect(junieAdapter.capabilities.supportsCommands ?? false).toBe(false);
    expect(junieAdapter.capabilities.supportsSkills).toBe(true);
    expect(junieAdapter.capabilities.supportsSubagents ?? false).toBe(false);
  });
});

// ── detection ─────────────────────────────────────────────────────────────

describe("junie adapter — detection", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
  });

  it("not installed on a bare box", () => {
    const d = junieAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(false);
    expect(d.confidence).toBe("low");
  });

  it("detects the ~/.junie user dir (user scope)", () => {
    mkdirSync(join(home, ".junie"), { recursive: true });
    const d = junieAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("user");
    expect(d.confidence).toBe("high");
    expect(d.configPath).toBe(userMcpPath(home));
  });

  it("detects a project .junie dir", () => {
    mkdirSync(join(projectDir, ".junie"), { recursive: true });
    const d = junieAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
  });
});

// ── MCP server install ──────────────────────────────────────────────────────

describe("junie adapter — MCP install (mcpServers object map)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
  });

  it("user scope writes mcpServers.<id> at ~/.junie/mcp/mcp.json, stamped platform=junie", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = junieAdapter.installServer(ctx);
    expect(changes.every((c) => c.platform === "junie")).toBe(true);
    expect(changes[0]?.action).toBe("create");

    const mcpPath = userMcpPath(home);
    expect(changes[0]?.path).toBe(mcpPath);
    expect(existsSync(mcpPath)).toBe(true);

    const cfg = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args?: string[]; env?: unknown }>;
    };
    expect(cfg.mcpServers[CONNECTOR_ID]).toBeTruthy();
    expect(cfg.mcpServers[CONNECTOR_ID]!.command).toBe("acme-mcp");
    expect(cfg.mcpServers[CONNECTOR_ID]!.args).toEqual(["--port", "0"]);
    // stdio entry carries NO type/disabled field (Junie infers transport).
    expect("type" in cfg.mcpServers[CONNECTOR_ID]!).toBe(false);
    expect("disabled" in cfg.mcpServers[CONNECTOR_ID]!).toBe(false);
  });

  it("project scope writes <projectDir>/.junie/mcp/mcp.json (NOT the user file)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = junieAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.path).toBe(projectMcpPath(projectDir));
    expect(existsSync(projectMcpPath(projectDir))).toBe(true);
    expect(existsSync(userMcpPath(home))).toBe(false);
  });

  it("remote (http) server writes { url, headers } (url, NOT serverUrl; no type)", () => {
    const connector = buildConnector({
      server: {
        transport: "http",
        url: "https://mcp.example.com/v1",
        headers: { Authorization: "Bearer token" },
      },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    junieAdapter.installServer(ctx);
    const cfg = JSON.parse(readFileSync(userMcpPath(home), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    const entry = cfg.mcpServers[CONNECTOR_ID]!;
    expect(entry.url).toBe("https://mcp.example.com/v1");
    expect(entry.headers).toEqual({ Authorization: "Bearer token" });
    // Junie's remote shape uses `url`, never `serverUrl`, and has no type/command.
    expect("serverUrl" in entry).toBe(false);
    expect("type" in entry).toBe(false);
    expect("command" in entry).toBe(false);
  });

  it("install is idempotent and uninstall reverses it", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    junieAdapter.installServer(ctx);
    const second = junieAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const removed = junieAdapter.uninstallServer(ctx);
    expect(removed[0]?.action).toBe("remove");
    const cfg = JSON.parse(readFileSync(userMcpPath(home), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(CONNECTOR_ID in cfg.mcpServers).toBe(false);
  });

  it("honors platforms['junie'].server === false", () => {
    const connector = buildConnector({ platforms: { junie: { server: false } } });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = junieAdapter.installServer(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(userMcpPath(home))).toBe(false);
  });

  it("never clobbers a PRESENT-but-non-object mcpServers (skip-warn)", () => {
    const mcpPath = userMcpPath(home);
    mkdirSync(join(home, ".junie", "mcp"), { recursive: true });
    // A hand-edited file where mcpServers is an ARRAY, not an object map.
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: [] }), "utf8");

    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = junieAdapter.installServer(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    // The user's malformed file is left untouched.
    expect(readFileSync(mcpPath, "utf8")).toBe(JSON.stringify({ mcpServers: [] }));
  });
});

// ── hooks (unavailable — mcp-only) ────────────────────────────────────────────

describe("junie adapter — hooks unavailable (mcp-only)", () => {
  it("installHooks / uninstallHooks both skip", () => {
    const { projectDir } = freshHomeProject();
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    expect(junieAdapter.installHooks(ctx)[0]?.action).toBe("skip");
    expect(junieAdapter.uninstallHooks(ctx)[0]?.action).toBe("skip");
  });
});

// ── diagnostics ───────────────────────────────────────────────────────────────

describe("junie adapter — health checks", () => {
  it("FAILs before install, OK after install at the mcp.json path", () => {
    const { home, projectDir } = freshHomeProject();
    const ctx = buildCtx(projectDir, buildConnector(), "user");

    const before = junieAdapter.getHealthChecks(ctx);
    expect(before[0]!.check().status).toBe("FAIL");

    junieAdapter.installServer(ctx);
    const after = junieAdapter.getHealthChecks(ctx);
    expect(after[0]!.check().status).toBe("OK");
    expect(after[1]!.check().status).toBe("OK");
    expect(existsSync(userMcpPath(home))).toBe(true);
  });
});

// ── Agent Skills — <root>/.junie/skills/<name>/SKILL.md ───────────────────────
// Layout byte-confirmed from junie.jetbrains.com/docs/agent-skills.html
// (verified 2026-09-10): required SKILL.md with frontmatter `name` (required)
// + `description`, optional supporting files; project `.junie/skills/` and
// global `~/.junie/skills/`, project wins on a name clash.

describe("junie adapter — Agent Skills", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
  });

  const SKILL = {
    name: "acme-db-queries",
    description: "How to query the Acme DB through the acme-db MCP tools.",
    body: "## Guidelines\n- Prefer acme_query over raw SQL.\n",
    resources: { "checklists/review.md": "- [ ] indexes checked\n" },
  };

  it("advertises supportsSkills (commands/subagents stay unset)", () => {
    expect(junieAdapter.capabilities.supportsSkills).toBe(true);
    expect(junieAdapter.capabilities.supportsCommands).toBeUndefined();
    expect(junieAdapter.capabilities.supportsSubagents).toBeUndefined();
  });

  it("project scope writes <projectDir>/.junie/skills/<name>/SKILL.md (+ resources); uninstall removes them", () => {
    const connector = buildConnector({ skills: [SKILL] });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = junieAdapter.installSkills!(ctx);
    expect(changes.every((c) => c.action !== "warn")).toBe(true);

    const dir = join(projectDir, ".junie", "skills", "acme-db-queries");
    const skillFile = join(dir, "SKILL.md");
    const resFile = join(dir, "checklists", "review.md");
    expect(existsSync(skillFile)).toBe(true);
    expect(existsSync(resFile)).toBe(true);
    const { frontmatter, body } = splitFrontmatter(readFileSync(skillFile, "utf8"));
    expect(frontmatter.name).toBe("acme-db-queries");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(body).toContain("Prefer acme_query over raw SQL.");
    // Nothing leaked into the user tree.
    expect(existsSync(join(home, ".junie", "skills"))).toBe(false);

    junieAdapter.uninstallSkills!(ctx);
    expect(existsSync(skillFile)).toBe(false);
    expect(existsSync(resFile)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it("user scope writes ~/.junie/skills/<name>/SKILL.md", () => {
    const connector = buildConnector({ skills: [SKILL] });
    const ctx = buildCtx(projectDir, connector, "user");
    junieAdapter.installSkills!(ctx);
    const skillFile = join(home, ".junie", "skills", "acme-db-queries", "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);
    expect(existsSync(join(projectDir, ".junie", "skills"))).toBe(false);
    junieAdapter.uninstallSkills!(ctx);
    expect(existsSync(skillFile)).toBe(false);
  });

  it("is idempotent — a byte-identical re-install creates nothing", () => {
    const connector = buildConnector({ skills: [SKILL] });
    const ctx = buildCtx(projectDir, connector, "project");
    expect(junieAdapter.installSkills!(ctx).filter((c) => c.action === "create")).toHaveLength(2);
    const again = junieAdapter.installSkills!(ctx);
    expect(again.filter((c) => c.action === "create")).toHaveLength(0);
    expect(again.every((c) => c.action !== "warn")).toBe(true);
  });

  it("honors platforms['junie'].skills === false and skips with no skills declared", () => {
    const off = buildConnector({ skills: [SKILL], platforms: { junie: { skills: false } } });
    expect(junieAdapter.installSkills!(buildCtx(projectDir, off, "project")).every((c) => c.action === "skip")).toBe(true);
    expect(existsSync(join(projectDir, ".junie", "skills"))).toBe(false);
    const none = buildConnector();
    expect(junieAdapter.installSkills!(buildCtx(projectDir, none, "project"))).toEqual([
      { platform: "junie", action: "skip", detail: "connector declares no skills" },
    ]);
  });
});
