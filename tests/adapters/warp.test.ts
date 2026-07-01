/**
 * adapters/warp.test.ts — the ONE per-host file for the Warp (Warp.dev) adapter.
 *
 * Warp is an mcp-only host (no lifecycle hook system; MCP is its extensibility
 * mechanism). Config surfaces:
 *   • MCP servers → ~/.warp/.mcp.json (user) / <projectDir>/.warp/.mcp.json
 *                   (project), ROOT KEY "mcpServers"; stdio entries key the
 *                   working dir as `working_directory` (NOT `cwd`); env-refs
 *                   resolve to LITERALS (no native ${env:VAR} token).
 *   • Hooks       → unavailable (single "skip"; the hook config path aliases the
 *                   server config path, but nothing is ever written there).
 *   • Skills      → <projectDir>/.agents/skills/<name>/SKILL.md (project scope
 *                   only; user-scope install warns — no documented user dir).
 *   • Actions     → ~/.warp/workflows/<id>.yaml (user) /
 *                   <projectDir>/.warp/workflows/<id>.yaml (project): one OWNED
 *                   YAML workflow per action ({ name, command, description }); the
 *                   palette PASTES the command (not headless exec).
 *
 * This file consolidates what used to be split across warp-skills.test.ts
 * (skills surface), actions-emit.test.ts (action emitter), and the warp slice of
 * phase2-render.test.ts (render/round-trip). It uses the shared harness
 * (tests/support/env + adapter-suite) per tests/README.md — ONE file per host.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { buildHomeBinActionCommand } from "../../src/core/spawn.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  ActionDef,
  ConnectorConfig,
  ResolvedConnector,
} from "../../src/core/types.js";

import warpAdapter from "../../src/adapters/warp/index.js";
import {
  buildCtx,
  freshHomeProject,
  freshProject,
  isolateEnv,
  HOME_BIN,
} from "../support/env.js";
import { readJson, splitFrontmatter } from "../support/fs.js";
import { createAdapterSuite } from "../support/adapter-suite.js";

// ── render/round-trip fixtures (the phase2-render slice) ──────────────────────
// A connector with a stdio server (env-ref + cwd) + PreToolUse and SessionStart
// hooks; the render slice asserts mcp-only hook degradation + working_directory.
const RENDER_CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";

function buildRenderConnector(): ResolvedConnector {
  return defineConnector({
    id: RENDER_CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
      env: { [ENV_VAR]: `\${env:${ENV_VAR}}` },
      cwd: SERVER_CWD,
      tools: { include: ["*"] },
    },
    hooks: {
      PreToolUse: {
        matcher: "acme_query|acme_write",
        handler() {
          return { decision: "allow" };
        },
      },
      SessionStart: {
        handler() {
          return { decision: "context", additionalContext: "hello" };
        },
      },
    },
  });
}

/**
 * The serve-wrapper args bake the install TARGET platform as `--host <id>`
 * (before the `--` separator) so the proxy stamps hostPlatform correctly under a
 * headless spawn. Warp installs at project scope here → `--scope project`.
 */
const wrappedArgs = (host: string): string[] => [
  "serve",
  "--connector",
  RENDER_CONNECTOR_ID,
  "--scope",
  "project",
  "--host",
  host,
  "--",
  "npx",
  "-y",
  "@x/y",
];

// ── skills fixtures (the warp-skills slice) ───────────────────────────────────
const SKILLS_CONNECTOR_ID = "acme-warp-skills";

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
    displayName: "Acme Warp Skills",
    version: "1.0.0",
    skills: [skill()],
    ...cfg,
  });
}

// ── actions fixtures (the actions-emit slice) ─────────────────────────────────
// The action emitter uses its own home-bin path + connector id, and a HOME that
// is distinct from the project dir so user-scope workflows resolve under
// ~/.warp/workflows (homedir()-based).
const ACTIONS_HOME_BIN = "/fake/home/.agent-connector/bin/agent-connector";
const ACTIONS_CONNECTOR_ID = "acme";

function actionsConnector(
  actions: ActionDef[],
  platforms: ResolvedConnector["platforms"] = {},
): ResolvedConnector {
  return defineConnector({ id: ACTIONS_CONNECTOR_ID, actions, platforms });
}

const DEPLOY: ActionDef = {
  id: "deploy",
  description: "Deploy the app.",
  run: () => ({ message: "deployed" }),
};
const ROLLBACK: ActionDef = { id: "rollback", run: () => undefined };

function verb(host: string, id: string): string {
  return buildHomeBinActionCommand(ACTIONS_HOME_BIN, host, id, ACTIONS_CONNECTOR_ID);
}

// Shared env isolation + the same-rules-for-every-host baseline contract.
// extraKeys: the render/round-trip slice mutates the ACME_DB_DSN env-ref var.
isolateEnv([ENV_VAR]);
createAdapterSuite({ adapter: warpAdapter, paradigm: "mcp-only" });

// ── render + round-trip (mcp-only; no hook file written) ──────────────────────

describe("warp adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-p2-render-warp-");
    // Set the env-ref var so literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildRenderConnector());
  });

  it("installServer writes mcpServers.<id> into .warp/.mcp.json with `working_directory` (NOT cwd), env LITERAL", () => {
    const changes = warpAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".warp", ".mcp.json");
    expect(serverPath).toBe(warpAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[RENDER_CONNECTOR_ID];
    expect(entry).toBeTruthy();

    // Telemetry serve-wrapper: command points at the home binary.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgs("warp"));

    // QUIRK: Warp keys the working directory as `working_directory`, never `cwd`.
    expect(entry.working_directory).toBe(SERVER_CWD);
    expect(entry).not.toHaveProperty("cwd");

    // No native interpolation token → env-ref resolves to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks returns a single skip ChangeRecord and writes NO hook file", () => {
    const changes = warpAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");

    // Warp's hook config path equals its server config path; with only installHooks
    // called, no file should exist at all (nothing is written for mcp-only hooks).
    const hooksPath = warpAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(warpAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("installHooks does not add a hooks section to an already-written .mcp.json", () => {
    warpAdapter.installServer(ctx);
    warpAdapter.installHooks(ctx);

    const cfg = readJson(join(projectDir, ".warp", ".mcp.json"));
    // The server file carries ONLY the MCP registration — no hooks key.
    expect(cfg).not.toHaveProperty("hooks");
    expect(cfg.mcpServers?.[RENDER_CONNECTOR_ID]).toBeTruthy();
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    warpAdapter.installServer(ctx);
    const second = warpAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".warp", ".mcp.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([RENDER_CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry; uninstallHooks is a clean skip", () => {
    warpAdapter.installServer(ctx);

    warpAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".warp", ".mcp.json"));
    expect(cfg.mcpServers?.[RENDER_CONNECTOR_ID]).toBeUndefined();

    const hookChanges = warpAdapter.uninstallHooks(ctx);
    expect(hookChanges).toHaveLength(1);
    expect(hookChanges[0]?.action).toBe("skip");
  });
});

// ── skills surface (.agents/skills, project scope only) ───────────────────────

describe("warp adapter — skills surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-warp-skills-");
    ctx = buildCtx(projectDir, buildSkillsConnector());
  });

  it("declares supportsSkills true", () => {
    expect(warpAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes .agents/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = warpAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
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
    warpAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".agents", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills is idempotent — second call yields skip", () => {
    warpAdapter.installSkills!(ctx);
    const second = warpAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    warpAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".agents", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    warpAdapter.uninstallSkills!(ctx);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools"))).toBe(false);
  });

  it("user-scope installSkills returns a warn (no documented user-scope skills dir)", () => {
    const userCtx = buildCtx(projectDir, buildSkillsConnector(), "user");
    const changes = warpAdapter.installSkills!(userCtx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    // No file written
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("honors platforms['warp'].skills === false", () => {
    const disabled = defineConnector({
      id: SKILLS_CONNECTOR_ID,
      skills: [skill()],
      platforms: { warp: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = warpAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: SKILLS_CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills);
    const changes = warpAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── actions emitter (one OWNED YAML workflow per action; palette PASTES) ──────
// HOME-distinct-from-project layout: user-scope workflows resolve under
// ~/.warp/workflows (homedir()-based), project-scope under <projectDir>/.warp.

describe("warp — actions emitter", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject("ac-actemit-warp-"));
  });

  /** Build an action-emitter ctx with the actions slice's home-bin + dataRoot. */
  function actionsCtx(
    connector: ResolvedConnector,
    scope: "project" | "user",
  ): InstallContext {
    return buildCtx(projectDir, connector, {
      scope,
      homeBinPath: ACTIONS_HOME_BIN,
      dataRoot: join(home, ".agent-connector"),
    });
  }

  const wfPath = (id: string) => join(projectDir, ".warp", "workflows", `${id}.yaml`);

  it("advertises supportsActions", () => {
    expect(warpAdapter.capabilities.supportsActions).toBe(true);
  });

  it("installActions writes one workflow YAML per action (name/command/description)", () => {
    const ctx = actionsCtx(actionsConnector([DEPLOY, ROLLBACK]), "project");
    const changes = warpAdapter.installActions!(ctx);
    expect(changes.every((c) => c.platform === "warp")).toBe(true);
    expect(changes.map((c) => c.action)).toEqual(["create", "create"]);
    // HONESTY: the detail spells out the paste-not-exec semantics.
    expect(changes[0]!.detail).toContain("pastes the action command for the user to run");

    const deploy = parseYaml(readFileSync(wfPath("deploy"), "utf8"));
    expect(deploy).toEqual({
      name: "Deploy the app.",
      command: verb("warp", "deploy"),
      description: "Deploy the app.",
    });
    // rollback has no description → label/description fall back to the id.
    const rollback = parseYaml(readFileSync(wfPath("rollback"), "utf8"));
    expect(rollback).toEqual({
      name: "rollback",
      command: verb("warp", "rollback"),
      description: "rollback",
    });
  });

  it("uses action label and host-specific metadata when rendering workflow text", () => {
    const ctx = actionsCtx(
      actionsConnector([
        {
          id: "deploy",
          label: "Deploy production",
          description: "Deploy the app.",
          hosts: {
            warp: { label: "Paste deploy", description: "Paste deploy command." },
          },
          run: () => ({ message: "deployed" }),
        },
      ]),
      "project",
    );
    warpAdapter.installActions!(ctx);
    const deploy = parseYaml(readFileSync(wfPath("deploy"), "utf8"));
    expect(deploy).toEqual({
      name: "Paste deploy",
      command: verb("warp", "deploy"),
      description: "Paste deploy command.",
    });
  });

  it("user scope writes under ~/.warp/workflows/<id>.yaml", () => {
    const ctx = actionsCtx(actionsConnector([DEPLOY]), "user");
    warpAdapter.installActions!(ctx);
    expect(existsSync(join(home, ".warp", "workflows", "deploy.yaml"))).toBe(true);
  });

  it("is idempotent (second install → skip, bytes unchanged)", () => {
    const ctx = actionsCtx(actionsConnector([DEPLOY]), "project");
    warpAdapter.installActions!(ctx);
    const before = readFileSync(wfPath("deploy"), "utf8");
    const changes = warpAdapter.installActions!(ctx);
    expect(changes[0]!.action).toBe("skip");
    expect(readFileSync(wfPath("deploy"), "utf8")).toBe(before);
  });

  it("uninstallActions removes the owned file", () => {
    const ctx = actionsCtx(actionsConnector([DEPLOY]), "project");
    warpAdapter.installActions!(ctx);
    expect(existsSync(wfPath("deploy"))).toBe(true);
    const changes = warpAdapter.uninstallActions!(ctx);
    expect(changes[0]!.action).toBe("remove");
    expect(existsSync(wfPath("deploy"))).toBe(false);
  });

  it("honors platforms.warp.actions === false (opt-out)", () => {
    const ctx = actionsCtx(actionsConnector([DEPLOY], { warp: { actions: false } }), "project");
    const changes = warpAdapter.installActions!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("disabled for warp");
    expect(existsSync(wfPath("deploy"))).toBe(false);
  });

  it("skips silently when no actions are declared", () => {
    const ctx = actionsCtx(
      defineConnector({ id: ACTIONS_CONNECTOR_ID, skills: [{ name: "s", description: "d", body: "b" }] }),
      "project",
    );
    const changes = warpAdapter.installActions!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("declares no actions");
  });
});
