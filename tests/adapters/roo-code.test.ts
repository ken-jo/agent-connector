/**
 * adapters/roo-code.test.ts — the SINGLE per-host Roo Code file.
 *
 * Roo Code (rooveterinaryinc.roo-cline) is a Cline-fork VS Code extension and an
 * **mcp-only** host: it exposes no lifecycle hook system, so MCP server
 * registration is the only thing we install and hooks are reported unavailable.
 *
 * Covers:
 *   1. Baseline adapter contract (shared factory; paradigm "mcp-only").
 *   2. Content surfaces — commands + skills:
 *        command → <rooDir>/commands/<name>.md  (md + OPTIONAL frontmatter
 *                  {description?, argument-hint?, mode?}; mode only via cmd.extra)
 *        skill   → <rooDir>/skills/<name>/SKILL.md (+ resources), AgentSkills.
 *      The `.roo` content root is ~/.roo (user) or <projectDir>/.roo (project) —
 *      both scopes supported; install idempotent + reversible; per-surface
 *      platforms["roo-code"].<surface> === false opt-outs honored.
 *   3. MCP render / round-trip (absorbed from the former wave1-render.test.ts):
 *        installServer → mcpServers.<id> into .roo/mcp.json, command/args routed
 *        through the home-bin serve wrapper, ${env:VAR} resolved to a LITERAL;
 *        installHooks → exactly ONE skip, NO hook file; idempotent; uninstall.
 *   4. `disabled` reflects server.enabled (absorbed from review-fixes.test.ts).
 *
 * (Memory surface lives in tests/core/memory-surface.test.ts.)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import rooCodeAdapter from "../../src/adapters/roo-code/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared content-surface fixtures ──────────────────────────────────────────

const CONNECTOR_ID = "acme-roo-code";

const SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files when the user asks.",
  body: "# PDF Tools\n\nUse the bundled script to extract text.",
  model: "haiku",
  tools: { allow: ["Bash"] },
  disableModelInvocation: false,
  resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
} as const;

const COMMAND = {
  name: "deploy",
  description: "Deploy the current branch to staging.",
  prompt: "# Deploy\n\nRun the staging deploy.",
  argumentHint: "[environment]",
} as const;

function skill() {
  return {
    ...SKILL,
    tools: { allow: [...SKILL.tools.allow] },
    resources: { ...SKILL.resources },
  };
}

function buildConnector(cfg: Partial<ConnectorConfig> = {}): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Roo Code",
    version: "1.0.0",
    commands: [{ ...COMMAND }],
    skills: [skill()],
    ...cfg,
  });
}

// Shared env isolation (HOME/USERPROFILE/data-root + the env-ref var the MCP
// render slice mutates) + the same-rules-for-every-host baseline contract.
isolateEnv(["ACME_DB_DSN"]);
createAdapterSuite({ adapter: rooCodeAdapter, paradigm: "mcp-only" });

// ── capability flags ────────────────────────────────────────────────────────

describe("roo-code adapter — content-surface capabilities", () => {
  it("declares supportsCommands and supportsSkills true", () => {
    expect(rooCodeAdapter.capabilities.supportsCommands).toBe(true);
    expect(rooCodeAdapter.capabilities.supportsSkills).toBe(true);
  });
});

// ── commands surface ────────────────────────────────────────────────────────

describe("roo-code adapter — commands surface", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = freshProject();
  });

  it("installCommands (project scope) writes .roo/commands/<name>.md with frontmatter", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = rooCodeAdapter.installCommands(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes.every((c) => c.platform === "roo-code")).toBe(true);

    const cmdMd = join(projectDir, ".roo", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(cmdMd);
    expect(existsSync(cmdMd)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdMd, "utf8"));
    expect(frontmatter.description).toBe(COMMAND.description);
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    expect(frontmatter.mode).toBeUndefined();
    expect(body).toContain("# Deploy");
  });

  it("installCommands (user scope) writes ~/.roo/commands/<name>.md", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = rooCodeAdapter.installCommands(ctx);
    expect(changes[0]?.action).toBe("create");

    // HOME is the isolated tmp dir, so ~/.roo === <projectDir>/.roo here.
    const cmdMd = join(projectDir, ".roo", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(cmdMd);
    expect(existsSync(cmdMd)).toBe(true);
  });

  it("passes `mode` through only when cmd.extra carries it", () => {
    const connector = buildConnector({
      commands: [{ ...COMMAND, extra: { mode: "architect" } }],
    });
    const ctx = buildCtx(projectDir, connector, "project");
    rooCodeAdapter.installCommands(ctx);

    const cmdMd = join(projectDir, ".roo", "commands", "deploy.md");
    const { frontmatter } = splitFrontmatter(readFileSync(cmdMd, "utf8"));
    expect(frontmatter.mode).toBe("architect");
    expect(frontmatter.description).toBe(COMMAND.description);
  });

  it("installCommands is idempotent — second call yields skip", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    rooCodeAdapter.installCommands(ctx);
    const second = rooCodeAdapter.installCommands(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallCommands removes the .md file", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    rooCodeAdapter.installCommands(ctx);
    const cmdMd = join(projectDir, ".roo", "commands", "deploy.md");
    expect(existsSync(cmdMd)).toBe(true);

    const changes = rooCodeAdapter.uninstallCommands(ctx);
    expect(changes.every((c) => c.platform === "roo-code")).toBe(true);
    expect(existsSync(cmdMd)).toBe(false);
  });

  it("honors platforms['roo-code'].commands === false", () => {
    const connector = buildConnector({ platforms: { "roo-code": { commands: false } } });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = rooCodeAdapter.installCommands(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".roo", "commands", "deploy.md"))).toBe(false);
  });

  it("no commands declared → skip", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme Roo Code",
      version: "1.0.0",
      skills: [skill()],
    });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = rooCodeAdapter.installCommands(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── skills surface ──────────────────────────────────────────────────────────

describe("roo-code adapter — skills surface", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = freshProject();
  });

  it("installSkills (project scope) writes .roo/skills/<name>/SKILL.md with frontmatter", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = rooCodeAdapter.installSkills(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes.every((c) => c.platform === "roo-code")).toBe(true);

    const skillMd = join(projectDir, ".roo", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(frontmatter.model).toBe("haiku");
    expect(frontmatter["allowed-tools"]).toBe("Bash");
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(body).toContain("# PDF Tools");
  });

  it("installSkills writes resource files beside SKILL.md", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    rooCodeAdapter.installSkills(ctx);
    const resource = join(projectDir, ".roo", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.roo/skills/<name>/SKILL.md", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = rooCodeAdapter.installSkills(ctx);
    expect(changes[0]?.action).toBe("create");

    // HOME is the isolated tmp dir, so ~/.roo === <projectDir>/.roo here.
    const skillMd = join(projectDir, ".roo", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
  });

  it("installSkills is idempotent — second call yields skip", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    rooCodeAdapter.installSkills(ctx);
    const second = rooCodeAdapter.installSkills(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    rooCodeAdapter.installSkills(ctx);
    const skillMd = join(projectDir, ".roo", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".roo", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const changes = rooCodeAdapter.uninstallSkills(ctx);
    expect(changes.every((c) => c.platform === "roo-code")).toBe(true);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".roo", "skills", "pdf-tools"))).toBe(false);
  });

  it("honors platforms['roo-code'].skills === false", () => {
    const connector = buildConnector({ platforms: { "roo-code": { skills: false } } });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = rooCodeAdapter.installSkills(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".roo", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("no skills declared → skip", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme Roo Code",
      version: "1.0.0",
      commands: [{ ...COMMAND }],
    });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = rooCodeAdapter.installSkills(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── MCP render / round-trip (absorbed from the former wave1-render.test.ts) ───
// root key "mcpServers"; project → .roo/mcp.json. Its own connector (id
// "acme-db", a stdio server with an env-ref + a PreToolUse hook) is kept
// verbatim so it does not collide with the content-surface fixtures above.

const MCP_CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";

/** A connector with a stdio server (env-ref) + a PreToolUse hook. */
function buildMcpConnector(): ResolvedConnector {
  return defineConnector({
    id: MCP_CONNECTOR_ID,
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

/**
 * The serve-wrapper args bake the install TARGET platform as `--host <id>`
 * (before the `--` separator) so the proxy stamps hostPlatform correctly under a
 * headless spawn.
 */
const wrappedArgs = (host: string): string[] => [
  "serve",
  "--connector",
  MCP_CONNECTOR_ID,
  "--scope",
  "project",
  "--host",
  host,
  "--",
  "npx",
  "-y",
  "@x/y",
];

describe("roo-code adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave1-roo-");
    // The env-ref var must be set so literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildMcpConnector(), { dataRoot: projectDir });
  });

  it("installServer writes mcpServers.<id> into .roo/mcp.json, wrapped, env LITERAL", () => {
    const changes = rooCodeAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".roo", "mcp.json");
    expect(serverPath).toBe(rooCodeAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[MCP_CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.disabled).toBe(false);

    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgs("roo-code"));

    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks returns a single skip ChangeRecord and writes NO hook file", () => {
    const changes = rooCodeAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");

    const hooksPath = rooCodeAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(rooCodeAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    rooCodeAdapter.installServer(ctx);
    const second = rooCodeAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".roo", "mcp.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([MCP_CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    rooCodeAdapter.installServer(ctx);
    rooCodeAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".roo", "mcp.json"));
    expect(cfg.mcpServers?.[MCP_CONNECTOR_ID]).toBeUndefined();
  });
});

// ── remote (sse / streamable-http) servers ALWAYS carry a discriminating type ─
// Roo Code's config schema (RooCodeInc/Roo-Code McpHub.ts, verified v3.54.0)
// REJECTS a url config that omits `type`, and uses the HYPHENATED
// "streamable-http" value (NOT Cline's camelCase "streamableHttp"). A
// Streamable-HTTP connector must therefore register with type "streamable-http",
// and an sse connector with type "sse".

describe("roo-code adapter — remote transport writes a discriminating type", () => {
  let projectDir: string;

  function buildRemoteCtx(transport: "http" | "sse"): InstallContext {
    projectDir = freshProject("ac-roo-remote-");
    const connector = defineConnector({
      id: MCP_CONNECTOR_ID,
      displayName: "Acme DB Tools",
      version: "1.2.3",
      server: { transport, url: "https://mcp.example.com/sse" },
    });
    return buildCtx(projectDir, connector, { dataRoot: projectDir });
  }

  it("http (streamable) server writes type:streamable-http explicitly", () => {
    const ctx = buildRemoteCtx("http");
    rooCodeAdapter.installServer(ctx);
    const cfg = readJson(rooCodeAdapter.getServerConfigPath(ctx));
    const entry = cfg.mcpServers[MCP_CONNECTOR_ID];
    expect(entry.type).toBe("streamable-http");
    expect(entry.url).toBe("https://mcp.example.com/sse");
    // No stdio fields leak into a remote entry.
    expect(entry.command).toBeUndefined();
  });

  it("sse server writes type:sse explicitly", () => {
    const ctx = buildRemoteCtx("sse");
    rooCodeAdapter.installServer(ctx);
    const cfg = readJson(rooCodeAdapter.getServerConfigPath(ctx));
    const entry = cfg.mcpServers[MCP_CONNECTOR_ID];
    expect(entry.type).toBe("sse");
    expect(entry.url).toBe("https://mcp.example.com/sse");
  });
});

// ── `disabled` reflects server.enabled (absorbed from review-fixes.test.ts) ───

describe("roo-code disabled reflects server.enabled", () => {
  function buildEnabledConnector(
    overrides: Partial<Parameters<typeof defineConnector>[0]> = {},
  ): ResolvedConnector {
    return defineConnector({
      id: MCP_CONNECTOR_ID,
      displayName: "Acme DB Tools",
      version: "1.2.3",
      server: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@x/y"],
      },
      hooks: {
        PreToolUse: { handler: () => ({ decision: "allow" }) },
        SessionStart: { handler: () => ({ decision: "allow" }) },
      },
      ...overrides,
    });
  }

  it("disabled:false when the server is enabled (default)", () => {
    const projectDir = freshProject("ac-rf-roo-");
    const ctx = buildCtx(projectDir, buildEnabledConnector(), { dataRoot: projectDir });
    rooCodeAdapter.installServer(ctx);
    const cfg = readJson(rooCodeAdapter.getServerConfigPath(ctx));
    expect(cfg.mcpServers[MCP_CONNECTOR_ID].disabled).toBe(false);
  });

  it("disabled:true when the server is explicitly enabled:false", () => {
    const projectDir = freshProject("ac-rf-roo2-");
    const connector = buildEnabledConnector({
      server: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@x/y"],
        enabled: false,
      },
      hooks: {},
    });
    const ctx = buildCtx(projectDir, connector, { dataRoot: projectDir });
    rooCodeAdapter.installServer(ctx);
    const cfg = readJson(rooCodeAdapter.getServerConfigPath(ctx));
    expect(cfg.mcpServers[MCP_CONNECTOR_ID].disabled).toBe(true);
  });
});
