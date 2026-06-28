/**
 * tests/adapters/devin — the ONE per-host file for the Devin CLI (Cognition)
 * adapter. Byte-oracle for a json-stdio host whose MCP + hooks share ONE
 * config.json per scope:
 *   • MCP servers → <configDir>/config.json (root key "mcpServers"; object map;
 *                   stdio { command, args?, env? } — NO type/disabled; remote
 *                   { url, transport?, headers? }; native ${env:VAR} pass-through).
 *   • Hooks       → the SAME config.json's "hooks" key (Claude NESTED-rule shape;
 *                   reply is the SIMPLE top-level {decision:"approve"|"block"|
 *                   "deny", reason}). Devin's on-wire PostCompaction maps to the
 *                   canonical PostCompact.
 *   • skills      → <configDir>/skills/<name>/SKILL.md (+ resources).
 *   • memory      → AGENTS.md (project root) + ~/.config/devin/AGENTS.md (user).
 * configDir = ~/.config/devin (user; %APPDATA%\devin on Windows) /
 * <projectDir>/.devin (project).
 *
 * HONEST CEILING: Devin requires Cognition auth, so it is NOT live-verifiable
 * locally — this file is a placement + byte-oracle guard (config bytes, hook
 * round-trip, parse/format, detection). All surface facts are byte-confirmed
 * from first-party docs (docs.devin.ai/cli/extensibility/{mcp,hooks,skills,rules}).
 * Uses the shared harness (tests/support/env + adapter-suite + fs).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  ConnectorConfig,
  PermissionRequestEvent,
  PostToolUseEvent,
  ResolvedConnector,
} from "../../src/core/types.js";

import devinAdapter from "../../src/adapters/devin/index.js";
import { buildCtx, freshHomeProject, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";

// The serve-wrapper args bake the install TARGET platform as `--host devin`
// (before `--`) so the proxy stamps hostPlatform under a headless spawn.
const wrappedArgs = (scope: "project" | "user"): string[] => [
  "serve",
  "--connector",
  CONNECTOR_ID,
  "--scope",
  scope,
  "--host",
  "devin",
  "--",
  "npx",
  "-y",
  "@x/y",
];

/** A connector with a stdio server (env-ref) + a PreToolUse hook. */
function buildRenderConnector(): ResolvedConnector {
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
    hooks: {
      PreToolUse: {
        matcher: "acme_query|acme_write",
        handler() {
          return { decision: "allow" };
        },
      },
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

const SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files.",
  body: "# PDF Tools\n\nUse the bundled script to extract text.",
  resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
} as const;

function skill() {
  return { ...SKILL, resources: { ...SKILL.resources } };
}

// ── baseline contract ─────────────────────────────────────────────────────────

createAdapterSuite({ adapter: devinAdapter, paradigm: "json-stdio" });

// ── detection ───────────────────────────────────────────────────────────────

describe("devin adapter — detection", () => {
  isolateEnv();

  it("reports not-installed on a clean home", () => {
    const { projectDir } = freshHomeProject("ac-devin-detect-");
    const d = devinAdapter.detectInstalled(projectDir);
    expect(d.id).toBe("devin");
    expect(d.paradigm).toBe("json-stdio");
    expect(d.installed).toBe(false);
    expect(d.confidence).toBe("low");
  });
});

// ── MCP server render (stdio + http) — config.json, mcpServers ────────────────

describe("devin adapter — MCP server render", () => {
  isolateEnv();
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildRenderConnector(), "project");
  });
  afterEach(() => {});

  it("installServer writes mcpServers.<id> into .devin/config.json, serve-wrapped, ${env:VAR} PASSED THROUGH", () => {
    const changes = devinAdapter.installServer(ctx);
    expect(changes.every((c) => c.action !== "warn")).toBe(true);

    const cfgPath = join(projectDir, ".devin", "config.json");
    const cfg = readJson(cfgPath);
    const entry = cfg.mcpServers[CONNECTOR_ID];
    // stdio entry shape: { command, args } — NO type, NO disabled.
    expect(entry).toEqual({
      command: HOME_BIN,
      args: wrappedArgs("project"),
      env: { [ENV_VAR]: `\${env:${ENV_VAR}}` },
    });
    expect(entry.type).toBeUndefined();
    expect(entry.disabled).toBeUndefined();
    // Devin interpolates ${env:VAR} natively — the secret must NOT be baked.
    expect(JSON.stringify(entry.env)).toContain(`\${env:${ENV_VAR}}`);
  });

  it("installServer (user scope) targets the adapter's user config.json (~/.config/devin on POSIX, %APPDATA%\\devin on Windows)", () => {
    const isolated = freshHomeProject("ac-devin-user-");
    const userCtx = buildCtx(isolated.projectDir, buildRenderConnector(), {
      scope: "user",
      dataRoot: process.env.AGENT_CONNECTOR_DATA_DIR ?? join(isolated.home, ".agent-connector"),
    });
    devinAdapter.installServer(userCtx);
    // Assert against the adapter's OWN per-platform resolution (path-agnostic,
    // mirrors windsurf/amazon-q user-scope tests) — hardcoding the POSIX
    // ~/.config/devin path would fail on the Windows runner, where the adapter
    // correctly writes to %APPDATA%\devin\config.json.
    const cfgPath = devinAdapter.getServerConfigPath(userCtx);
    expect(cfgPath).toBe(join(devinAdapter.getConfigDir(userCtx), "config.json"));
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = readJson(cfgPath);
    expect(cfg.mcpServers[CONNECTOR_ID].args).toEqual(wrappedArgs("user"));
  });

  it("renders a remote http server as { url, headers } with ${env:VAR} passthrough (no default transport key)", () => {
    const httpCtx = buildCtx(projectDir, buildHttpConnector(), "project");
    devinAdapter.installServer(httpCtx);
    const cfg = readJson(join(projectDir, ".devin", "config.json"));
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry.url).toBe(`\${env:ACME_URL}`);
    expect(entry.headers).toEqual({ Authorization: `Bearer \${env:ACME_TOKEN}` });
    // http is the URL default → no explicit transport key emitted.
    expect(entry.transport).toBeUndefined();
  });

  it("uninstallServer removes only this connector's entry", () => {
    devinAdapter.installServer(ctx);
    devinAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".devin", "config.json"));
    expect(cfg.mcpServers?.[CONNECTOR_ID]).toBeUndefined();
  });
});

// ── hook round-trip — config.json "hooks" key, nested-rule shape ──────────────

describe("devin adapter — hooks", () => {
  isolateEnv();
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildRenderConnector(), "project");
  });

  it("installHooks writes config.json hooks.<Event> nested entry pointing at the home bin", () => {
    const changes = devinAdapter.installHooks(ctx);
    expect(changes.every((c) => c.action !== "warn")).toBe(true);

    const cfg = readJson(join(projectDir, ".devin", "config.json")) as {
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
    };
    const rule = cfg.hooks.PreToolUse[0]!;
    expect(rule.matcher).toBe("acme_query|acme_write");
    expect(rule.hooks[0]!.type).toBe("command");
    expect(rule.hooks[0]!.command).toContain(HOME_BIN);
    expect(rule.hooks[0]!.command).toContain(CONNECTOR_ID);
    // The home binary dispatches on the CANONICAL event name.
    expect(rule.hooks[0]!.command).toContain("PreToolUse");
  });

  it("maps the canonical PostCompact to Devin's on-wire PostCompaction key", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: { PostCompact: { handler: () => ({ decision: "allow" }) } },
    });
    const changes = devinAdapter.installHooks(buildCtx(projectDir, connector, "project"));
    expect(changes.every((c) => c.action !== "warn")).toBe(true);
    const cfg = readJson(join(projectDir, ".devin", "config.json")) as { hooks: Record<string, unknown> };
    expect(Object.keys(cfg.hooks)).toContain("PostCompaction");
    expect(Object.keys(cfg.hooks)).not.toContain("PostCompact");
  });

  it("warn-skips an event Devin does not support (Notification) and never writes it", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: { Notification: { handler: () => ({ decision: "allow" }) } },
    });
    const changes = devinAdapter.installHooks(buildCtx(projectDir, connector, "project"));
    expect(changes.some((c) => c.action === "warn")).toBe(true);
    // Nothing written: either no file at all, or a file with no Notification bucket.
    const cfgPath = join(projectDir, ".devin", "config.json");
    if (existsSync(cfgPath)) {
      const cfg = readJson(cfgPath) as { hooks?: Record<string, unknown> };
      expect(cfg.hooks?.Notification).toBeUndefined();
    }
  });

  it("uninstallHooks strips the connector's hook back out", () => {
    devinAdapter.installHooks(ctx);
    devinAdapter.uninstallHooks(ctx);
    const cfg = readJson(join(projectDir, ".devin", "config.json")) as { hooks?: Record<string, unknown[]> };
    // bucket either deleted or emptied — no entry referencing our home bin remains.
    expect(cfg.hooks?.PreToolUse ?? []).toEqual([]);
  });
});

// ── skills — <configDir>/skills/<name>/SKILL.md ───────────────────────────────

describe("devin adapter — skills", () => {
  isolateEnv();
  let projectDir: string;

  beforeEach(() => {
    projectDir = freshProject();
  });

  it("installSkills writes .devin/skills/<name>/SKILL.md (+ resources); uninstall removes them", () => {
    const connector = defineConnector({ id: CONNECTOR_ID, skills: [skill()] });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = devinAdapter.installSkills!(ctx);
    expect(changes.every((c) => c.action !== "warn")).toBe(true);

    const skillFile = join(projectDir, ".devin", "skills", "pdf-tools", "SKILL.md");
    const resFile = join(projectDir, ".devin", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillFile)).toBe(true);
    expect(existsSync(resFile)).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillFile, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);

    devinAdapter.uninstallSkills!(ctx);
    expect(existsSync(skillFile)).toBe(false);
    expect(existsSync(resFile)).toBe(false);
  });

  it("honors platforms['devin'].skills === false", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      skills: [skill()],
      platforms: { devin: { skills: false } },
    });
    const changes = devinAdapter.installSkills!(buildCtx(projectDir, connector, "project"));
    expect(changes.every((c) => c.action === "skip")).toBe(true);
    expect(existsSync(join(projectDir, ".devin", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });
});

// ── memory — user-scope AGENTS.md (~/.config/devin on POSIX, %APPDATA%\devin on Windows) ──

describe("devin adapter — memory", () => {
  isolateEnv();

  it("user scope upserts a managed block into the user-config AGENTS.md", () => {
    const { projectDir } = freshHomeProject();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      memory: [{ content: "Always run the lint task before committing." }],
    });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = devinAdapter.installMemory!(ctx);
    expect(changes.every((c) => c.action !== "warn")).toBe(true);

    // The user-scope memory target lives beside the user config dir
    // (devinUserConfigDir()), which getConfigDir resolves per-platform — so
    // derive the expected path from the adapter rather than hardcoding the
    // POSIX ~/.config/devin path (it would miss %APPDATA%\devin on Windows).
    const agentsMd = join(devinAdapter.getConfigDir(ctx), "AGENTS.md");
    expect(existsSync(agentsMd)).toBe(true);
    const text = readFileSync(agentsMd, "utf8");
    expect(text).toContain("Always run the lint task before committing.");
    expect(text).toContain(`agent-connector:begin ${CONNECTOR_ID}`);
  });
});

// ── runtime: parseEvent ───────────────────────────────────────────────────────

describe("devin adapter — parseEvent", () => {
  it("PostToolUse stringifies the { success, output, error } tool_response object", () => {
    const ev = devinAdapter.parseEvent!("PostToolUse", {
      connector: CONNECTOR_ID,
      tool_name: "exec",
      tool_input: { command: "ls" },
      tool_response: { success: true, output: "a\nb", error: null },
    }) as PostToolUseEvent;
    expect(ev.toolName).toBe("exec");
    expect(ev.toolOutput).toBe(JSON.stringify({ success: true, output: "a\nb", error: null }));
    expect(ev.connectorId).toBe(CONNECTOR_ID);
  });

  it("PermissionRequest carries tool_name + tool_input", () => {
    const ev = devinAdapter.parseEvent!("PermissionRequest", {
      tool_name: "exec",
      tool_input: { command: "git status" },
    }) as PermissionRequestEvent;
    expect(ev.toolName).toBe("exec");
    expect(ev.toolInput).toEqual({ command: "git status" });
  });

  it("PostCompact (Devin PostCompaction) parses with no trigger field; summary rides on raw", () => {
    const ev = devinAdapter.parseEvent!("PostCompact", { summary: "did stuff" });
    expect(ev.hostPlatform).toBe("devin");
    expect((ev as { trigger?: unknown }).trigger).toBeUndefined();
  });

  it("throws on an event Devin never delivers (Notification)", () => {
    expect(() => devinAdapter.parseEvent!("Notification", {})).toThrow(/unsupported devin hook event/);
  });
});

// ── runtime: formatReply — the SIMPLE top-level {decision} form ───────────────

describe("devin adapter — formatReply", () => {
  it("PreToolUse deny → {decision:'block', reason} on stdout, exit 0", () => {
    const r = devinAdapter.formatReply!("PreToolUse", { decision: "deny", reason: "nope" });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout!)).toEqual({ decision: "block", reason: "nope" });
  });

  it("PermissionRequest allow → {decision:'approve'} (active grant)", () => {
    const r = devinAdapter.formatReply!("PermissionRequest", { decision: "allow" });
    expect(JSON.parse(r.stdout!)).toEqual({ decision: "approve" });
  });

  it("PermissionRequest deny → {decision:'deny', reason}", () => {
    const r = devinAdapter.formatReply!("PermissionRequest", { decision: "deny", reason: "blocked" });
    expect(JSON.parse(r.stdout!)).toEqual({ decision: "deny", reason: "blocked" });
  });

  it("does NOT use Claude's hookSpecificOutput envelope", () => {
    const r = devinAdapter.formatReply!("PreToolUse", { decision: "deny", reason: "x" });
    expect(r.stdout).not.toContain("hookSpecificOutput");
    expect(r.stdout).not.toContain("permissionDecision");
  });

  it("PostCompact / SessionEnd are observe-only passthroughs (exit 0, no stdout)", () => {
    for (const ev of ["PostCompact", "SessionEnd"] as const) {
      const r = devinAdapter.formatReply!(ev, { decision: "deny", reason: "ignored" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBeUndefined();
    }
  });

  it("allow / context / modify on a tool event pass through with exit 0 (no rewrite/inject channel)", () => {
    for (const decision of ["allow", "context", "modify"] as const) {
      const r = devinAdapter.formatReply!("PreToolUse", { decision, additionalContext: "hint" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBeUndefined();
    }
  });
});
