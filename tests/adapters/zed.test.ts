/**
 * adapters/zed.test.ts — the SINGLE per-host Zed file.
 *
 * Zed is an **mcp-only** host: it is an IDE, not a CLI with a hook pipeline, so
 * there is NO lifecycle hook system. MCP ("context servers") is the only
 * integration path; it also reads Agent Skills (SKILL.md). MCP server
 * registration + skills are the only things we install; hooks are reported
 * unavailable (a single skip).
 *
 * Covers:
 *   1. Baseline adapter contract (shared factory; paradigm "mcp-only").
 *   2. Skills surface (merged from the former zed-skills.test.ts):
 *        project scope → <projectDir>/.agents/skills/<name>/SKILL.md
 *        user scope    → ~/.agents/skills/<name>/SKILL.md
 *      BOTH scopes documented-writable; install idempotent + reversible;
 *      platforms["zed"].skills === false opt-out honored; no skills → skip.
 *   3. MCP render / round-trip (absorbed from the former wave1-render.test.ts):
 *        installServer → context_servers.<id> (NOT mcpServers) into
 *        .zed/settings.json with a FLAT command STRING, command/args routed
 *        through the home-bin serve wrapper, ${env:VAR} resolved to a LITERAL
 *        (Zed documents no native interpolation token); pre-existing unrelated
 *        settings keys SURVIVE the merge (shared user-owned settings.json);
 *        installHooks → exactly ONE skip, NO hook file; idempotent; uninstall.
 *   4. Root-cause regression fixes (absorbed from review-fixes.test.ts):
 *        JSONC clobber — sibling keys survive a settings file with a // comment;
 *        overwrite guard — a TRULY-malformed file is left untouched (a "warn"),
 *        never blanked to {}.
 *
 * (Memory surface lives in tests/core/memory-surface.test.ts.)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { ensureDir } from "../../src/core/paths.js";
import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import zedAdapter from "../../src/adapters/zed/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared skills-surface fixtures ───────────────────────────────────────────

const CONNECTOR_ID = "acme-zed-skills";

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
    displayName: "Acme Zed Skills",
    version: "1.0.0",
    skills: [skill()],
    ...cfg,
  });
}

// Shared env isolation (HOME/USERPROFILE/data-root + the env-ref var the MCP
// render slice mutates) + the same-rules-for-every-host baseline contract.
isolateEnv(["ACME_DB_DSN"]);
createAdapterSuite({ adapter: zedAdapter, paradigm: "mcp-only" });

// ── skills surface ────────────────────────────────────────────────────────────

describe("zed adapter — skills surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("declares supportsSkills true", () => {
    expect(zedAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes .agents/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = zedAdapter.installSkills!(ctx);
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

  it("installSkills (project scope) writes resource files beside SKILL.md", () => {
    zedAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".agents", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.agents/skills/<n>/SKILL.md", () => {
    const userCtx = buildCtx(projectDir, buildConnector(), "user");
    const changes = zedAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // HOME redirected to projectDir → ~/.agents === projectDir/.agents
    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
  });

  it("user-scope skill does NOT write into the project .agents tree", () => {
    // Write user-scope into one dir, project-scope into another — no overlap.
    const userDir = freshProject();
    const projDir = freshProject("ac-zed-skills-proj-");
    const userCtx = buildCtx(projDir, buildConnector(), "user");
    // freshProject pointed HOME at projDir; restore it to userDir so the
    // user-scope write resolves ~/.agents under userDir, not projDir.
    process.env.HOME = userDir;
    process.env.USERPROFILE = userDir;
    zedAdapter.installSkills!(userCtx);

    // The project dir's .agents tree must be empty (user wrote to HOME/.agents).
    expect(existsSync(join(projDir, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    // The user HOME/.agents tree got the file.
    expect(existsSync(join(userDir, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(true);
  });

  it("installSkills is idempotent — second call yields skip", () => {
    zedAdapter.installSkills!(ctx);
    const second = zedAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    zedAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".agents", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    zedAdapter.uninstallSkills!(ctx);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools"))).toBe(false);
  });

  it("honors platforms['zed'].skills === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      skills: [skill()],
      platforms: { zed: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = zedAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills);
    const changes = zedAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── MCP render / round-trip (absorbed from the former wave1-render.test.ts) ───
// root key "context_servers" (NOT mcpServers); FLAT stdio shape (command is a
// STRING); merge-preserving into .zed/settings.json. Its own connector (id
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

/** Seed a JSON settings file on disk with arbitrary contents (creating dirs). */
function seedJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

describe("zed adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave1-zed-");
    // The env-ref var must be set so literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildMcpConnector(), { dataRoot: projectDir });
  });

  it("installServer writes context_servers.<id> (NOT mcpServers) into .zed/settings.json, FLAT command, env LITERAL", () => {
    const changes = zedAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".zed", "settings.json");
    expect(serverPath).toBe(zedAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // ROOT KEY is "context_servers", never "mcpServers".
    expect(cfg).toHaveProperty("context_servers");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.context_servers[MCP_CONNECTOR_ID];
    expect(entry).toBeTruthy();

    // FLAT shape — `command` is a STRING (the home bin), not a nested object.
    expect(typeof entry.command).toBe("string");
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgs("zed", projectDir));

    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks returns a single skip ChangeRecord and writes NO hook file", () => {
    const changes = zedAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");

    const hooksPath = zedAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(zedAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    zedAdapter.installServer(ctx);
    const second = zedAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".zed", "settings.json"));
    expect(Object.keys(cfg.context_servers)).toEqual([MCP_CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    zedAdapter.installServer(ctx);
    zedAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".zed", "settings.json"));
    expect(cfg.context_servers?.[MCP_CONNECTOR_ID]).toBeUndefined();
  });

  it("preserves pre-existing unrelated settings keys (shared settings.json merge)", () => {
    const serverPath = join(projectDir, ".zed", "settings.json");
    seedJson(serverPath, {
      theme: "One Dark",
      buffer_font_size: 14,
      context_servers: { "other-server": { command: "other" } },
    });

    zedAdapter.installServer(ctx);

    const cfg = readJson(serverPath);
    // Unrelated top-level keys survive.
    expect(cfg.theme).toBe("One Dark");
    expect(cfg.buffer_font_size).toBe(14);
    // A sibling context server survives, and ours is added alongside it.
    expect(cfg.context_servers["other-server"]).toEqual({ command: "other" });
    expect(cfg.context_servers[MCP_CONNECTOR_ID]).toBeTruthy();
  });
});

// ── Root-cause regression fixes (absorbed from review-fixes.test.ts) ──────────
// These write RAW JSONC strings to disk (ensureDir + writeFileSync) to exercise
// the parseJsonc-tolerance + overwrite-guard paths, so they keep that shape.

const RF_CONNECTOR_ID = "acme-db";

function buildRfConnector(
  overrides: Partial<Parameters<typeof defineConnector>[0]> = {},
): ResolvedConnector {
  return defineConnector({
    id: RF_CONNECTOR_ID,
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

// JSONC clobber — sibling keys must SURVIVE when the file has comments.
describe("JSONC clobber: zed settings.json with a // comment + sibling key", () => {
  it("preserves the sibling key and adds our entry (no data loss)", () => {
    const projectDir = freshProject("ac-rf-zed-");
    const ctx = buildCtx(projectDir, buildRfConnector(), { dataRoot: projectDir });
    const settingsPath = zedAdapter.getServerConfigPath(ctx);

    // Pre-write a JSONC file: a // comment + an UNRELATED sibling key.
    ensureDir(join(projectDir, ".zed"));
    writeFileSync(
      settingsPath,
      `{
        // user's editor theme — must survive our merge
        "theme": "Ayu Dark",
        "context_servers": {
          "user-owned": { "command": "/bin/echo" }
        },
      }`,
      "utf8",
    );

    const changes = zedAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const cfg = readJson(settingsPath);
    // The unrelated sibling key SURVIVES (before the fix it was clobbered to {}).
    expect(cfg.theme).toBe("Ayu Dark");
    // The user's own context server SURVIVES.
    expect(cfg.context_servers["user-owned"]).toBeTruthy();
    // Our entry was added.
    expect(cfg.context_servers[RF_CONNECTOR_ID]).toBeTruthy();
  });
});

// Overwrite guard — a TRULY-malformed file is NOT blanked.
describe("overwrite guard: present, non-empty, TRULY-malformed settings file", () => {
  it("installServer returns a 'warn' and does NOT blank the file", () => {
    const projectDir = freshProject("ac-rf-guard-");
    const ctx = buildCtx(projectDir, buildRfConnector(), { dataRoot: projectDir });
    const settingsPath = zedAdapter.getServerConfigPath(ctx);

    // Not just JSONC — genuinely broken JSON that even stripping cannot rescue.
    const malformed = `{ "theme": "dark", this is broken <<<< not json`;
    ensureDir(join(projectDir, ".zed"));
    writeFileSync(settingsPath, malformed, "utf8");

    const changes = zedAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("not parseable");

    // The original bytes are UNTOUCHED — never replaced with {}-based output.
    expect(readFileSync(settingsPath, "utf8")).toBe(malformed);
  });
});

// ── Actions surface (tasks.json exec tasks) ──────────────────────────────────
// Zed reads tasks.json (a JSON ARRAY of { label, command, args? }) spawned in
// its integrated terminal (zed.dev/docs/tasks). Each AC action → one owned task
// whose `command` execs the home-bin action verb. ARRAY-MERGE with ownership:
// set-if-absent, idempotent, uninstall removes ONLY ours (foreign tasks survive).

const ACT_CONNECTOR_ID = "acme-actions";

/** Connector declaring two actions (descriptions → task labels). */
function buildActionsConnector(
  overrides: Partial<Parameters<typeof defineConnector>[0]> = {},
): ResolvedConnector {
  return defineConnector({
    id: ACT_CONNECTOR_ID,
    displayName: "Acme Actions",
    version: "1.0.0",
    actions: [
      { id: "sync-db", description: "Sync the local DB", run: () => ({ message: "synced" }) },
      { id: "clear-cache", run: () => undefined },
    ],
    ...overrides,
  });
}

/** The home-bin action command for an action id (mirrors buildHomeBinActionCommand). */
const actionCmd = (id: string, connectorId = ACT_CONNECTOR_ID): string =>
  `"${HOME_BIN}" action zed ${id} --connector ${connectorId}`;

describe("zed adapter — actions surface (tasks.json)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-zed-actions-");
    ctx = buildCtx(projectDir, buildActionsConnector());
  });

  it("declares supportsActions true", () => {
    expect(zedAdapter.capabilities.supportsActions).toBe(true);
  });

  it("installActions writes one owned task per action into .zed/tasks.json", () => {
    const changes = zedAdapter.installActions!(ctx);
    expect(changes.every((c) => c.action === "create")).toBe(true);

    const tasksPath = join(projectDir, ".zed", "tasks.json");
    expect(existsSync(tasksPath)).toBe(true);

    const tasks = readJson(tasksPath) as Array<{ label: string; command: string }>;
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks).toHaveLength(2);

    const syncTask = tasks.find((t) => t.command === actionCmd("sync-db"));
    expect(syncTask).toBeTruthy();
    // label falls back to action.description, then action.id.
    expect(syncTask!.label).toBe("Sync the local DB");
    expect(syncTask!.command).toBe(actionCmd("sync-db"));

    const clearTask = tasks.find((t) => t.command === actionCmd("clear-cache"));
    expect(clearTask).toBeTruthy();
    expect(clearTask!.label).toBe("clear-cache"); // no description → id
  });

  it("installActions array-merges into a tasks.json with FOREIGN tasks (no clobber)", () => {
    const tasksPath = join(projectDir, ".zed", "tasks.json");
    ensureDir(join(projectDir, ".zed"));
    // A user's hand-written task that must SURVIVE untouched.
    const foreign = { label: "Run tests", command: "cargo test", env: { CI: "1" } };
    writeFileSync(tasksPath, `${JSON.stringify([foreign], null, 2)}\n`, "utf8");

    zedAdapter.installActions!(ctx);

    const tasks = readJson(tasksPath) as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(3); // 1 foreign + 2 ours
    // The foreign task is byte-identical (every key, including env, preserved).
    expect(tasks.find((t) => t.command === "cargo test")).toEqual(foreign);
    // Ours were appended.
    expect(tasks.some((t) => t.command === actionCmd("sync-db"))).toBe(true);
    expect(tasks.some((t) => t.command === actionCmd("clear-cache"))).toBe(true);
  });

  it("installActions is idempotent — second call yields skip, no duplicates", () => {
    zedAdapter.installActions!(ctx);
    const second = zedAdapter.installActions!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const tasks = readJson(join(projectDir, ".zed", "tasks.json")) as unknown[];
    expect(tasks).toHaveLength(2); // not 4
  });

  it("uninstallActions removes ONLY our tasks, leaving foreign tasks intact", () => {
    const tasksPath = join(projectDir, ".zed", "tasks.json");
    ensureDir(join(projectDir, ".zed"));
    const foreign = { label: "Run tests", command: "cargo test" };
    writeFileSync(tasksPath, `${JSON.stringify([foreign], null, 2)}\n`, "utf8");

    zedAdapter.installActions!(ctx);
    const removed = zedAdapter.uninstallActions!(ctx);
    expect(removed[0]?.action).toBe("remove");

    const tasks = readJson(tasksPath) as Array<{ command: string }>;
    // Only the foreign task remains; both of ours are gone.
    expect(tasks).toEqual([foreign]);
  });

  it("uninstallActions on a tasks.json with no owned tasks is a skip", () => {
    const tasksPath = join(projectDir, ".zed", "tasks.json");
    ensureDir(join(projectDir, ".zed"));
    const foreign = { label: "Run tests", command: "cargo test" };
    writeFileSync(tasksPath, `${JSON.stringify([foreign], null, 2)}\n`, "utf8");

    const changes = zedAdapter.uninstallActions!(ctx);
    expect(changes[0]?.action).toBe("skip");
    // The foreign task is untouched.
    expect(readJson(tasksPath)).toEqual([foreign]);
  });

  it("does NOT remove another connector's owned tasks (anchored ownership)", () => {
    const tasksPath = join(projectDir, ".zed", "tasks.json");
    ensureDir(join(projectDir, ".zed"));
    // A SIBLING connector's task — same verb shape, DIFFERENT connector id.
    const sibling = { label: "Other", command: actionCmd("sync-db", "other-connector") };
    writeFileSync(tasksPath, `${JSON.stringify([sibling], null, 2)}\n`, "utf8");

    zedAdapter.installActions!(ctx);
    zedAdapter.uninstallActions!(ctx);

    const tasks = readJson(tasksPath) as Array<{ command: string }>;
    // The sibling connector's task survives our uninstall.
    expect(tasks).toEqual([sibling]);
  });

  it("honors platforms['zed'].actions === false", () => {
    const disabled = buildActionsConnector({ platforms: { zed: { actions: false } } });
    const c2 = buildCtx(projectDir, disabled);
    const changes = zedAdapter.installActions!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".zed", "tasks.json"))).toBe(false);
  });

  it("no actions declared → skip", () => {
    const none = defineConnector({ id: ACT_CONNECTOR_ID, memory: [{ content: "x" }] });
    const c2 = buildCtx(projectDir, none);
    expect(zedAdapter.installActions!(c2)[0]?.action).toBe("skip");
  });

  it("present-but-unparseable tasks.json is left untouched (overwrite guard)", () => {
    const tasksPath = join(projectDir, ".zed", "tasks.json");
    ensureDir(join(projectDir, ".zed"));
    const malformed = `[ { "label": "x" broken <<<< not json`;
    writeFileSync(tasksPath, malformed, "utf8");

    const changes = zedAdapter.installActions!(ctx);
    expect(changes[0]?.action).toBe("warn");
    expect(readFileSync(tasksPath, "utf8")).toBe(malformed);
  });

  it("a non-array tasks.json (wrong shape) warns rather than clobbering", () => {
    const tasksPath = join(projectDir, ".zed", "tasks.json");
    ensureDir(join(projectDir, ".zed"));
    const wrongShape = `{ "label": "not an array" }`;
    writeFileSync(tasksPath, wrongShape, "utf8");

    const changes = zedAdapter.installActions!(ctx);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("not a JSON array");
    expect(readFileSync(tasksPath, "utf8")).toBe(wrongShape);
  });
});
