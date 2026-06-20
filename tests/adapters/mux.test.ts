/**
 * adapters/mux.test.ts — the SINGLE per-host Mux (Coder) file.
 *
 * Mux is an **mcp-only** host: it exposes MCP servers as its extensibility
 * mechanism but has no lifecycle hook system we can register against. It also
 * reads Agent Skills (SKILL.md). MCP server registration + skills are the only
 * things we install; hooks are reported unavailable (a single skip).
 *
 * Covers:
 *   1. Baseline adapter contract (shared factory; paradigm "mcp-only").
 *   2. Skills surface (merged from the former mux-skills.test.ts):
 *        project scope → <projectDir>/.mux/skills/<name>/SKILL.md (workspace-local)
 *        user scope    → ~/.mux/skills/<name>/SKILL.md (global, Mux-specific)
 *      The skill dir name MUST match ^[a-z0-9]+(?:-[a-z0-9]+)*$ (1–64 chars) and
 *      the SKILL.md `name` field must equal it — a name that cannot be
 *      represented is skip-warned; a skills path that is a FILE is skip-warned
 *      (no ENOTDIR crash); install idempotent + reversible;
 *      platforms["mux"].skills === false opt-out honored; no skills → skip.
 *   3. MCP render / round-trip (absorbed from the former wave1-render.test.ts):
 *        installServer → servers.<id> as a single shell-command STRING
 *        (space-joined home-bin serve wrapper) into .mux/mcp.jsonc; root key is
 *        "servers" (NOT mcpServers); ${env:VAR} resolved to a LITERAL (Mux
 *        documents no native interpolation token; the string form drops env);
 *        installHooks → exactly ONE skip, NO hook file; idempotent; uninstall.
 *
 * (Memory surface lives in tests/core/memory-surface.test.ts.)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import muxAdapter from "../../src/adapters/mux/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared skills-surface fixtures ───────────────────────────────────────────

const CONNECTOR_ID = "acme-mux-skills";

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
    displayName: "Acme Mux Skills",
    version: "1.0.0",
    skills: [skill()],
    ...cfg,
  });
}

// Shared env isolation (HOME/USERPROFILE/data-root + the env-ref var the MCP
// render slice mutates) + the same-rules-for-every-host baseline contract.
isolateEnv(["ACME_DB_DSN"]);
createAdapterSuite({ adapter: muxAdapter, paradigm: "mcp-only" });

// ── skills surface ────────────────────────────────────────────────────────────

describe("mux adapter — skills surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("declares supportsSkills true", () => {
    expect(muxAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes .mux/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = muxAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("mux");

    const skillMd = join(projectDir, ".mux", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    // Mux requires the `name` field to equal the directory name.
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(frontmatter.model).toBe("haiku");
    expect(frontmatter["allowed-tools"]).toBe("Bash");
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(body).toContain("# PDF Tools");
  });

  it("installSkills (project scope) writes resource files beside SKILL.md", () => {
    muxAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".mux", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.mux/skills/<n>/SKILL.md", () => {
    const userCtx = buildCtx(projectDir, buildConnector(), "user");
    const changes = muxAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // HOME redirected to projectDir → ~/.mux === projectDir/.mux
    const skillMd = join(projectDir, ".mux", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
  });

  it("skip-warns a skill name that violates the Mux dir-name regex", () => {
    // A TRAILING dash passes the connector's broader kebab regex
    // (^[a-z0-9][a-z0-9-]*$) but FAILS Mux's stricter
    // ^[a-z0-9]+(?:-[a-z0-9]+)*$ — exactly the gap this guard covers.
    const bad = defineConnector({
      id: CONNECTOR_ID,
      skills: [{ ...skill(), name: "pdf-tools-" }],
    });
    const c2 = buildCtx(projectDir, bad);
    const changes = muxAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("cannot be represented");
    // Nothing was written for the unrepresentable name.
    expect(existsSync(join(projectDir, ".mux", "skills"))).toBe(false);
  });

  it("installSkills is idempotent — second call yields skip", () => {
    muxAdapter.installSkills!(ctx);
    const second = muxAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    muxAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".mux", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".mux", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);

    const changes = muxAdapter.uninstallSkills!(ctx);
    expect(changes.every((c) => c.platform === "mux")).toBe(true);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".mux", "skills", "pdf-tools"))).toBe(false);
  });

  it("skips-warns when the skills path is a FILE (no ENOTDIR crash)", () => {
    // Plant .mux/skills as a regular FILE where we need a directory.
    const skillsDir = join(projectDir, ".mux", "skills");
    mkdirSync(dirname(skillsDir), { recursive: true });
    writeFileSync(skillsDir, "not a dir", "utf8");

    const changes = muxAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("is a file, not a directory");
    expect(existsSync(join(skillsDir, "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("honors platforms['mux'].skills === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      skills: [skill()],
      platforms: { mux: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = muxAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".mux", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills);
    const changes = muxAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── MCP render / round-trip (absorbed from the former wave1-render.test.ts) ───
// root key "servers", value is a single shell-command STRING (space-joined
// home-bin serve wrapper); project → .mux/mcp.jsonc. Its own connector (id
// "acme-db", a stdio server with an env-ref + a PreToolUse hook) is kept verbatim
// so it does not collide with the skills-surface fixtures above.

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

describe("mux adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave1-mux-");
    // The env-ref var must be set so literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildMcpConnector(), { dataRoot: projectDir });
  });

  it("installServer writes servers.<id> as a STRING (space-joined home-bin serve wrapper) into .mux/mcp.jsonc", () => {
    const changes = muxAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".mux", "mcp.jsonc");
    expect(serverPath).toBe(muxAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // ROOT KEY is "servers", NOT "mcpServers".
    expect(cfg).toHaveProperty("servers");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.servers[MCP_CONNECTOR_ID];
    // QUIRK: the entry value is a single shell-command STRING, not an object.
    expect(typeof entry).toBe("string");

    // The command routes through the home-bin serve wrapper:
    //   "<homeBin> serve --connector <id> -- npx -y @x/y"
    expect(entry).toBe([HOME_BIN, ...wrappedArgs("mux", projectDir)].join(" "));
    expect(entry.startsWith(HOME_BIN)).toBe(true);
    expect(entry).toContain("serve --connector acme-db --scope project --");
  });

  it("installHooks returns a single skip ChangeRecord and writes NO hook file", () => {
    const changes = muxAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");

    const hooksPath = muxAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(muxAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    muxAdapter.installServer(ctx);
    const second = muxAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".mux", "mcp.jsonc"));
    expect(Object.keys(cfg.servers)).toEqual([MCP_CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    muxAdapter.installServer(ctx);
    muxAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".mux", "mcp.jsonc"));
    expect(cfg.servers?.[MCP_CONNECTOR_ID]).toBeUndefined();
  });
});
