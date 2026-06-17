/**
 * adapters/codebuff — subagents surface tests for the Codebuff adapter.
 *
 * Codebuff subagents are executable TypeScript modules in the PROJECT .agents/
 * dir: <projectDir>/.agents/<id>.ts, each ending with
 *   const definition = { id: "...", ... };
 *   export default definition;
 * (codebuff docs: "Create a new TypeScript file in .agents/"). The module is
 * emitted WITHOUT the type-only `agent-definition` import (erased at runtime). No
 * user-scope agents dir is documented, so user scope warn-skips.
 *
 * Tests:
 *   - supportsSubagents capability is true
 *   - installSubagents (project scope) writes one .agents/<id>.ts per subagent
 *   - the emitted module is valid JS, default-exports the AgentDefinition, and
 *     maps id/displayName/spawnerPrompt/instructionsPrompt from name/description/
 *     prompt; model + toolNames ONLY when declared (omitted otherwise)
 *   - no `agent-definition` import line is emitted
 *   - `extra` is merged as the escape hatch
 *   - user scope warn-skips (no file written)
 *   - installSubagents is idempotent (second call → skip)
 *   - uninstallSubagents removes the files
 *   - platforms['codebuff'].subagents === false disables the surface
 *   - ChangeRecord.platform === "codebuff"
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector, SubagentDef } from "../../src/core/types.js";

import codebuffAdapter from "../../src/adapters/codebuff/index.js";

const CONNECTOR_ID = "acme-codebuff-agents";

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

function buildConnector(cfg: Partial<ConnectorConfig> = {}): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Codebuff Agents",
    version: "1.0.0",
    subagents: [fullAgent(), minimalAgent()],
    ...cfg,
  });
}

function buildCtx(
  projectDir: string,
  connector: ResolvedConnector,
  scope: "project" | "user" = "project",
): InstallContext {
  return {
    connector,
    scope,
    projectDir,
    homeBinPath: "/fake/bin/agent-connector",
    dataRoot: projectDir,
    dryRun: false,
  };
}

let savedHome: string | undefined;
let savedProfile: string | undefined;
let savedDataDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedProfile);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-codebuff-agents-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  return dir;
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
    ctx = buildCtx(projectDir, buildConnector());
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
      id: CONNECTOR_ID,
      subagents: [{ ...minimalAgent(), extra: { version: "1.2.0", outputMode: "last_message" } }],
    });
    const c2 = buildCtx(projectDir, withExtra);
    codebuffAdapter.installSubagents!(c2);
    const def = evalDefinition(readFileSync(agentPath(projectDir, "doc-writer"), "utf8"));
    expect(def.version).toBe("1.2.0");
    expect(def.outputMode).toBe("last_message");
  });

  it("warn-skips at user scope (codebuff agents are project-scoped only)", () => {
    const userCtx = buildCtx(projectDir, buildConnector(), "user");
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

  it("honors platforms['codebuff'].subagents === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      subagents: [fullAgent()],
      platforms: { codebuff: { subagents: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = codebuffAdapter.installSubagents!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(agentPath(projectDir, "code-reviewer"))).toBe(false);
  });

  it("installSubagents with no subagents declared returns skip", () => {
    const none = defineConnector({ id: CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, none);
    const changes = codebuffAdapter.installSubagents!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});
