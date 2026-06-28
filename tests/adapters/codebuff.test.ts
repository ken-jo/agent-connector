/**
 * adapters/codebuff.test.ts — the SINGLE per-host Codebuff file.
 *
 * Codebuff is an **mcp-only** host (src/adapters/codebuff/index.ts): it exposes
 * no lifecycle hook system, so MCP server registration is the only server-side
 * thing we install and hooks are reported unavailable (a single skip). It also
 * reads two content surfaces — AgentSkills (SKILL.md) and executable TypeScript
 * subagents in .agents/.
 *
 * Covers:
 *   1. Baseline adapter contract (shared factory; paradigm "mcp-only").
 *   2. Skills surface:
 *        project scope → <projectDir>/.agents/skills/<name>/SKILL.md
 *        user scope    → ~/.agents/skills/<name>/SKILL.md
 *      (getConfigDir resolves .agents per scope.) Verified against codebuff
 *      source sdk/src/skills/load-skills.ts — the frontmatter `name` MUST equal
 *      the dir name. Install idempotent + reversible; platforms["codebuff"].skills
 *      === false opt-out honored; no skills → skip.
 *   3. Subagents surface:
 *        project scope → <projectDir>/.agents/<id>.ts, each ending with
 *          const definition = { id: "...", ... };
 *          export default definition;
 *        (codebuff docs: "Create a new TypeScript file in .agents/"). The module
 *        is emitted WITHOUT the type-only `agent-definition` import (erased at
 *        runtime). No user-scope agents dir is documented, so user scope
 *        warn-skips. Install idempotent + reversible; platforms["codebuff"]
 *        .subagents === false opt-out honored; no subagents → skip.
 *   4. MCP render / round-trip (absorbed from the former wave1-render.test.ts):
 *        installServer → mcpServers.<id> with type 'stdio' into .agents/mcp.json,
 *        command/args routed through the home-bin serve wrapper, env-ref rewritten
 *        to a native $VAR token (Codebuff expands $VAR natively, NOT a literal);
 *        installHooks → exactly ONE skip, NO hook file; idempotent; uninstall.
 *   5. env-ref default is preserved, not dropped (absorbed from review-fixes.test.ts):
 *        ${env:VAR:-fallback} → fallback literal when unset; ${env:VAR} → native
 *        $VAR token.
 *
 * (Memory surface lives in tests/core/memory-surface.test.ts.)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector, SubagentDef } from "../../src/core/types.js";

import codebuffAdapter from "../../src/adapters/codebuff/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";
import { symlinkOrSkipTest } from "../support/symlink.js";

// Shared env isolation (HOME/USERPROFILE/data-root + the env-ref vars the MCP
// render + env-ref slices mutate) + the same-rules-for-every-host baseline
// contract. ACME_DB_DSN is set by the render slice; AC_RF_CB_VAR by the
// env-ref-default slice.
isolateEnv(["ACME_DB_DSN", "AC_RF_CB_VAR"]);
createAdapterSuite({ adapter: codebuffAdapter, paradigm: "mcp-only" });

// ── skills surface ────────────────────────────────────────────────────────────

const SKILLS_CONNECTOR_ID = "acme-codebuff-skills";

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

function buildSkillsConnector(cfg: Partial<ConnectorConfig> = {}): ResolvedConnector {
  return defineConnector({
    id: SKILLS_CONNECTOR_ID,
    displayName: "Acme Codebuff Skills",
    version: "1.0.0",
    skills: [skill()],
    ...cfg,
  });
}

describe("codebuff adapter — skills surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildSkillsConnector());
  });

  it("declares supportsSkills true", () => {
    expect(codebuffAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes .agents/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = codebuffAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("codebuff");

    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    // name MUST equal the dir name (load-skills.ts) — dir is "pdf-tools".
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(frontmatter.model).toBe("haiku");
    expect(frontmatter["allowed-tools"]).toBe("Bash");
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(body).toContain("# PDF Tools");
  });

  it("installSkills (project scope) writes resource files beside SKILL.md", () => {
    codebuffAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".agents", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills refuses to write a resource through a symlinked parent directory", () => {
    const skillDir = join(projectDir, ".agents", "skills", "pdf-tools");
    const outside = join(projectDir, "outside-scripts");
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    if (!symlinkOrSkipTest(outside, join(skillDir, "scripts"), "dir")) return;

    const changes = codebuffAdapter.installSkills!(ctx);
    const resource = join(skillDir, "scripts", "extract.sh");
    const resourceChange = changes.find((c) => c.path === resource);
    expect(resourceChange?.action).toBe("warn");
    expect(resourceChange?.detail).toMatch(/symbolic link/i);
    expect(existsSync(join(outside, "extract.sh"))).toBe(false);
  });

  it("installSkills (user scope) writes ~/.agents/skills/<n>/SKILL.md", () => {
    const userCtx = buildCtx(projectDir, buildSkillsConnector(), "user");
    const changes = codebuffAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("codebuff");

    // HOME redirected to projectDir → ~/.agents === projectDir/.agents
    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
  });

  it("installSkills is idempotent — second call yields skip", () => {
    codebuffAdapter.installSkills!(ctx);
    const second = codebuffAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
    expect(second.every((c) => c.platform === "codebuff")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    codebuffAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".agents", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const changes = codebuffAdapter.uninstallSkills!(ctx);
    expect(changes.some((c) => c.action === "remove")).toBe(true);
    expect(changes.every((c) => c.platform === "codebuff")).toBe(true);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools"))).toBe(false);
  });

  it("honors platforms['codebuff'].skills === false", () => {
    const disabled = defineConnector({
      id: SKILLS_CONNECTOR_ID,
      skills: [skill()],
      platforms: { codebuff: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = codebuffAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: SKILLS_CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills);
    const changes = codebuffAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── subagents surface ─────────────────────────────────────────────────────────

const SUBAGENTS_CONNECTOR_ID = "acme-codebuff-agents";

/** Fully-populated subagent (model + tools.allow). */
const FULL: SubagentDef = {
  name: "code-reviewer",
  description: "Reviews diffs for correctness.",
  prompt: "You are a meticulous reviewer.\nCheck for bugs.",
  model: "anthropic/claude-sonnet-4.5",
  tools: { allow: ["read_files", "end_turn"] },
};

/** Minimal subagent (no model, no tools) — model/toolNames must be omitted. */
const MINIMAL: SubagentDef = {
  name: "doc-writer",
  description: "Writes documentation.",
  prompt: "Write clear docs.",
};

function fullAgent(): SubagentDef {
  return { ...FULL, tools: { allow: [...(FULL.tools?.allow ?? [])] } };
}
function minimalAgent(): SubagentDef {
  return { ...MINIMAL };
}

function buildSubagentsConnector(cfg: Partial<ConnectorConfig> = {}): ResolvedConnector {
  return defineConnector({
    id: SUBAGENTS_CONNECTOR_ID,
    displayName: "Acme Codebuff Agents",
    version: "1.0.0",
    subagents: [fullAgent(), minimalAgent()],
    ...cfg,
  });
}

function agentPath(projectDir: string, name: string): string {
  return join(projectDir, ".agents", `${name}.ts`);
}

/**
 * Evaluate the emitted AgentDefinition module by turning its ESM default export
 * into a `return`, proving the generated source is valid JS AND yields the
 * expected object. Keeps the raw module bytes out of brittle string matching.
 */
function evalDefinition(src: string): Record<string, unknown> {
  const body = src.replace(/export default definition;\s*$/, "return definition;");
  return new Function(body)() as Record<string, unknown>;
}

describe("codebuff adapter — subagents surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildSubagentsConnector());
  });

  it("declares supportsSubagents true", () => {
    expect(codebuffAdapter.capabilities.supportsSubagents).toBe(true);
  });

  it("installSubagents (project) writes one .agents/<id>.ts per declared subagent", () => {
    const changes = codebuffAdapter.installSubagents!(ctx);
    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.action === "create")).toBe(true);
    expect(changes.every((c) => c.platform === "codebuff")).toBe(true);

    const full = agentPath(projectDir, "code-reviewer");
    const minimal = agentPath(projectDir, "doc-writer");
    expect(changes.map((c) => c.path)).toEqual([full, minimal]);
    expect(existsSync(full)).toBe(true);
    expect(existsSync(minimal)).toBe(true);
  });

  it("emits a valid default-exported AgentDefinition mapping name/description/prompt", () => {
    codebuffAdapter.installSubagents!(ctx);
    const src = readFileSync(agentPath(projectDir, "code-reviewer"), "utf8");

    expect(src).toContain("const definition = {");
    expect(src).toContain("export default definition;");

    const def = evalDefinition(src);
    // id ← name (already kebab-case → a valid codebuff id); displayName ← name.
    expect(def.id).toBe("code-reviewer");
    expect(def.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(def.displayName).toBe("code-reviewer");
    expect(def.spawnerPrompt).toBe(FULL.description);
    expect(def.instructionsPrompt).toBe(FULL.prompt);
  });

  it("includes model + toolNames ONLY when the connector declares them", () => {
    codebuffAdapter.installSubagents!(ctx);

    const full = evalDefinition(readFileSync(agentPath(projectDir, "code-reviewer"), "utf8"));
    expect(full.model).toBe("anthropic/claude-sonnet-4.5");
    expect(full.toolNames).toEqual(["read_files", "end_turn"]);

    const minimalSrc = readFileSync(agentPath(projectDir, "doc-writer"), "utf8");
    const minimal = evalDefinition(minimalSrc);
    // model + toolNames are OMITTED (never fabricated) when not declared.
    expect(minimal.model).toBeUndefined();
    expect(minimal.toolNames).toBeUndefined();
    expect(minimalSrc).not.toContain("model:");
    expect(minimalSrc).not.toContain("toolNames:");
  });

  it("emits NO `agent-definition` type import line", () => {
    codebuffAdapter.installSubagents!(ctx);
    for (const name of ["code-reviewer", "doc-writer"]) {
      const src = readFileSync(agentPath(projectDir, name), "utf8");
      expect(src).not.toContain("agent-definition");
      expect(src).not.toContain("import");
    }
  });

  it("merges `extra` as the escape hatch for codebuff-native AgentDefinition fields", () => {
    const withExtra = defineConnector({
      id: SUBAGENTS_CONNECTOR_ID,
      subagents: [{ ...minimalAgent(), extra: { version: "1.2.0", outputMode: "last_message" } }],
    });
    const c2 = buildCtx(projectDir, withExtra);
    codebuffAdapter.installSubagents!(c2);
    const def = evalDefinition(readFileSync(agentPath(projectDir, "doc-writer"), "utf8"));
    expect(def.version).toBe("1.2.0");
    expect(def.outputMode).toBe("last_message");
  });

  it("warn-skips at user scope (codebuff agents are project-scoped only)", () => {
    const userCtx = buildCtx(projectDir, buildSubagentsConnector(), "user");
    const changes = codebuffAdapter.installSubagents!(userCtx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.platform).toBe("codebuff");
    // HOME redirected to projectDir → ~/.agents === projectDir/.agents; nothing written.
    expect(existsSync(agentPath(projectDir, "code-reviewer"))).toBe(false);
  });

  it("installSubagents is idempotent — second call yields skip", () => {
    codebuffAdapter.installSubagents!(ctx);
    const second = codebuffAdapter.installSubagents!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
    expect(second.every((c) => c.platform === "codebuff")).toBe(true);
  });

  it("uninstallSubagents removes the .agents/<id>.ts files", () => {
    codebuffAdapter.installSubagents!(ctx);
    const full = agentPath(projectDir, "code-reviewer");
    const minimal = agentPath(projectDir, "doc-writer");
    expect(existsSync(full)).toBe(true);

    const changes = codebuffAdapter.uninstallSubagents!(ctx);
    expect(changes.every((c) => c.action === "remove")).toBe(true);
    expect(changes.every((c) => c.platform === "codebuff")).toBe(true);
    expect(existsSync(full)).toBe(false);
    expect(existsSync(minimal)).toBe(false);
  });

  it("installSubagents refuses to overwrite a symlinked module path", () => {
    const victim = join(projectDir, "victim.ts");
    const link = agentPath(projectDir, "doc-writer");
    mkdirSync(join(projectDir, ".agents"), { recursive: true });
    writeFileSync(victim, "original", "utf8");
    if (!symlinkOrSkipTest(victim, link)) return;

    const changes = codebuffAdapter.installSubagents!(ctx);
    const linkChange = changes.find((c) => c.path === link);
    expect(linkChange?.action).toBe("warn");
    expect(linkChange?.detail).toMatch(/symbolic link/i);
    expect(readFileSync(victim, "utf8")).toBe("original");
  });

  it("uninstallSubagents refuses to remove a symlinked module path", () => {
    const victim = join(projectDir, "victim.ts");
    const link = agentPath(projectDir, "doc-writer");
    mkdirSync(join(projectDir, ".agents"), { recursive: true });
    writeFileSync(victim, "original", "utf8");
    if (!symlinkOrSkipTest(victim, link)) return;

    const changes = codebuffAdapter.uninstallSubagents!(ctx);
    const linkChange = changes.find((c) => c.path === link);
    expect(linkChange?.action).toBe("warn");
    expect(linkChange?.detail).toMatch(/symbolic link/i);
    expect(existsSync(link)).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("original");
  });

  it("honors platforms['codebuff'].subagents === false", () => {
    const disabled = defineConnector({
      id: SUBAGENTS_CONNECTOR_ID,
      subagents: [fullAgent()],
      platforms: { codebuff: { subagents: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = codebuffAdapter.installSubagents!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(agentPath(projectDir, "code-reviewer"))).toBe(false);
  });

  it("installSubagents with no subagents declared returns skip", () => {
    const none = defineConnector({ id: SUBAGENTS_CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, none);
    const changes = codebuffAdapter.installSubagents!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── MCP render / round-trip (absorbed from the former wave1-render.test.ts) ───
// root key "mcpServers"; project → .agents/mcp.json; native $VAR env-ref. Its
// own connector (id "acme-db", a stdio server with an env-ref + a PreToolUse
// hook) is kept verbatim so it does not collide with the content-surface
// fixtures above.

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

describe("codebuff adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave1-codebuff-");
    // The env-ref var must be set so literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildMcpConnector(), { dataRoot: projectDir });
  });

  it("installServer writes mcpServers.<id> with type 'stdio' into .agents/mcp.json, wrapped, env as native $VAR", () => {
    const changes = codebuffAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".agents", "mcp.json");
    expect(serverPath).toBe(codebuffAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[MCP_CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("stdio");

    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgs("codebuff", projectDir));

    // Codebuff expands $VAR natively → ref rewritten to $VAR, NOT a literal.
    expect(entry.env[ENV_VAR]).toBe(`$${ENV_VAR}`);
    expect(entry.env[ENV_VAR]).not.toBe(ENV_LITERAL);
  });

  it("installHooks returns a single skip ChangeRecord and writes NO hook file", () => {
    const changes = codebuffAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");

    const hooksPath = codebuffAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(codebuffAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    codebuffAdapter.installServer(ctx);
    const second = codebuffAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".agents", "mcp.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([MCP_CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    codebuffAdapter.installServer(ctx);
    codebuffAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".agents", "mcp.json"));
    expect(cfg.mcpServers?.[MCP_CONNECTOR_ID]).toBeUndefined();
  });
});

// ── env-ref default is preserved (absorbed from review-fixes.test.ts) ─────────
// ${env:VAR:-fallback} must NOT be dropped: it resolves to the fallback literal
// when the var is unset, while a bare ${env:VAR} becomes the native $VAR token.

describe("codebuff env-ref default is preserved (not dropped)", () => {
  const VAR = "AC_RF_CB_VAR";

  function buildRfConnector(
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

  it("resolves to the fallback literal when unset; native $VAR token when no default", () => {
    const projectDir = freshProject("ac-rf-cbdef-");
    delete process.env[VAR];
    const connector = buildRfConnector({
      server: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@x/y"],
        env: {
          ENDPOINT: `\${env:${VAR}:-https://fallback.example}`,
          TOKEN: `\${env:${VAR}}`,
        },
        wrapForTelemetry: false,
      },
      hooks: {},
    });
    const ctx = buildCtx(projectDir, connector, { scope: "user", dataRoot: projectDir });

    codebuffAdapter.installServer(ctx);
    const cfg = readJson(codebuffAdapter.getServerConfigPath(ctx));
    const entry = cfg.mcpServers[MCP_CONNECTOR_ID];
    expect(entry.env.ENDPOINT).toBe("https://fallback.example");
    expect(entry.env.TOKEN).toBe(`$${VAR}`);
  });
});
