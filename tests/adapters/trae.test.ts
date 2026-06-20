/**
 * adapters/trae.test.ts — the SINGLE per-host Trae (ByteDance) file.
 *
 * Trae is an **mcp-only** host: it exposes MCP servers as its extensibility
 * mechanism but has no lifecycle hook system we can register against. It also
 * reads Agent Skills (SKILL.md). MCP server registration + skills are the only
 * things we install; hooks are reported unavailable (a single skip).
 *
 * Covers:
 *   1. Baseline adapter contract (shared factory; paradigm "mcp-only").
 *   2. Skills surface:
 *        project scope → <projectDir>/.trae/skills/<name>/SKILL.md
 *        user scope    → ~/.trae/skills/<name>/SKILL.md
 *      BOTH scopes documented-writable; install idempotent + reversible;
 *      platforms["trae"].skills === false opt-out honored; no skills → skip.
 *   3. MCP render / round-trip (absorbed from the former wave1-render.test.ts):
 *        installServer → mcpServers.<id> into .trae/mcp.json, command/args routed
 *        through the home-bin serve wrapper, ${env:VAR} resolved to a LITERAL
 *        (Trae documents no native interpolation token);
 *        installHooks → exactly ONE skip, NO hook file; idempotent; uninstall.
 *
 * (Memory surface lives in tests/core/memory-surface.test.ts.)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import traeAdapter from "../../src/adapters/trae/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared skills-surface fixtures ───────────────────────────────────────────

const CONNECTOR_ID = "acme-trae-skills";

const SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files.",
  body: "# PDF Tools\n\nUse the bundled script to extract text.",
  model: "haiku",
  tools: { allow: ["Bash"] },
  disableModelInvocation: false,
  resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
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
    displayName: "Acme Trae Skills",
    version: "1.0.0",
    skills: [skill()],
    ...cfg,
  });
}

// Shared env isolation (HOME/USERPROFILE/data-root + the env-ref var the MCP
// render slice mutates) + the same-rules-for-every-host baseline contract.
isolateEnv(["ACME_DB_DSN"]);
createAdapterSuite({ adapter: traeAdapter, paradigm: "mcp-only" });

// ── skills surface ────────────────────────────────────────────────────────────

describe("trae adapter — skills surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("declares supportsSkills true", () => {
    expect(traeAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes .trae/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = traeAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("trae");

    const skillMd = join(projectDir, ".trae", "skills", "pdf-tools", "SKILL.md");
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

  it("installSkills (project scope) writes resource files beside SKILL.md", () => {
    traeAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".trae", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.trae/skills/<n>/SKILL.md", () => {
    const userCtx = buildCtx(projectDir, buildConnector(), "user");
    const changes = traeAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("trae");

    // HOME redirected to projectDir → ~/.trae === projectDir/.trae
    const skillMd = join(projectDir, ".trae", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
  });

  it("installSkills is idempotent — second call yields skip", () => {
    traeAdapter.installSkills!(ctx);
    const second = traeAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    traeAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".trae", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".trae", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const changes = traeAdapter.uninstallSkills!(ctx);
    expect(changes.every((c) => c.platform === "trae")).toBe(true);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".trae", "skills", "pdf-tools"))).toBe(false);
  });

  it("honors platforms['trae'].skills === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      skills: [skill()],
      platforms: { trae: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = traeAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".trae", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills);
    const changes = traeAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── MCP render / round-trip (absorbed from the former wave1-render.test.ts) ───
// root key "mcpServers"; project → .trae/mcp.json. Its own connector (id
// "acme-db", a stdio server with an env-ref + a PreToolUse hook) is kept
// verbatim so it does not collide with the skills-surface fixtures above.

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
 * headless spawn. When the ctx uses a NON-DEFAULT data-root (the render fixture
 * sets `dataRoot: projectDir`), the wrap also bakes `--data-dir <root>` so an
 * env-stripping host (codex) resolves the connector record from the right root.
 */
const wrappedArgs = (host: string, dataDir: string): string[] => [
  "serve",
  "--connector",
  MCP_CONNECTOR_ID,
  "--scope",
  "project",
  "--host",
  host,
  "--data-dir",
  dataDir,
  "--",
  "npx",
  "-y",
  "@x/y",
];

describe("trae adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave1-trae-");
    // The env-ref var must be set so literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildMcpConnector(), { dataRoot: projectDir });
  });

  it("installServer writes mcpServers.<id> into .trae/mcp.json, wrapped, env LITERAL", () => {
    const changes = traeAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".trae", "mcp.json");
    expect(serverPath).toBe(traeAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[MCP_CONNECTOR_ID];
    expect(entry).toBeTruthy();

    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgs("trae", projectDir));

    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks returns a single skip ChangeRecord and writes NO hook file", () => {
    const changes = traeAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");

    const hooksPath = traeAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(traeAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    traeAdapter.installServer(ctx);
    const second = traeAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".trae", "mcp.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([MCP_CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    traeAdapter.installServer(ctx);
    traeAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".trae", "mcp.json"));
    expect(cfg.mcpServers?.[MCP_CONNECTOR_ID]).toBeUndefined();
  });
});
