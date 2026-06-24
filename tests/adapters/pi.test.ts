/**
 * tests/adapters/pi — Pi adapter unit tests (the SINGLE per-host pi file).
 *
 * Covers:
 *   1. Capability flags: supportsCommands=true, supportsSkills=true,
 *      supportsSubagents=false, mcp=false (transports=[]).
 *   2. Paradigm label: NOT "mcp-only" in a misleading sense — mcp=false is the
 *      truth; the adapter sets paradigm="mcp-only" only because HookParadigm has
 *      no "no-mcp" variant, and that's accepted; we verify transports=[].
 *   3. Commands (prompt templates):
 *        project scope → <projectDir>/.pi/prompts/<name>.md
 *        user scope    → ~/.pi/agent/prompts/<name>.md  (NOT ~/.pi/prompts/)
 *      Idempotent, reversible, disabled-opt-out honored.
 *   4. Skills USER-SCOPE PATH BUG (regression guard):
 *        user scope    → ~/.pi/agent/skills/<name>/SKILL.md  (NOT ~/.pi/skills/)
 *        project scope → <projectDir>/.pi/skills/<name>/SKILL.md  (unchanged)
 *   5. allowed-tools rendering: SPACE-delimited for pi (not ", ").
 *   6. Skill full round-trip: install/idempotent/uninstall (project + user scope).
 *   7. platforms["pi"].commands/skills === false opt-outs.
 *   8. installServer / installHooks always skip (no MCP config, no hook layer).
 *   9. Content-surface round-trip slice (absorbed from the former
 *      tests/adapters/surfaces-s2.test.ts — pi was its last remaining host).
 *  10. Action surface: a generated pi.registerCommand extension module
 *      (.pi/extensions/<id>/index.js project, ~/.pi/agent/extensions/ user) that
 *      shells out to `action pi <id>` — mirrors the OMP fork's action emitter.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";
import piAdapter from "../../src/adapters/pi/index.js";

import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { splitFrontmatter } from "../support/fs.js";

// ─────────────────────────────────────────────────────────────────────────
// node:child_process mock — hoisted above every import by vitest.
//
// The pi action surface emits a self-contained ESM extension module that
// imports execFileSync (POSIX) / execSync (Windows) at top-level; the
// registerCommand tests dynamically import the freshly-written module and fire
// its handlers, so the mock must be in place before that module resolves
// node:child_process. Each test reprograms what the mock returns via
// execFileSyncImpl. (Idiom carried verbatim from the omp suite — pi mirrors
// omp's emitter.)
// ─────────────────────────────────────────────────────────────────────────

let execFileSyncImpl: (...args: any[]) => string = () => "";
const execFileSyncMock = vi.fn((...args: any[]) => execFileSyncImpl(...args));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: execFileSyncMock,
}));

const CONNECTOR_ID = "acme-pi";

const COMMAND = {
  name: "deploy",
  description: "Deploy the app to an environment.",
  prompt: "Deploy to $ARGUMENTS and report the result.",
  argumentHint: "[environment]",
  model: "sonnet",
} as const;

const SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files when the user asks.",
  body: "# PDF Tools\n\nUse the bundled script to extract text.",
  model: "haiku",
  tools: { allow: ["Bash", "Read"] },
  disableModelInvocation: false,
  resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
} as const;

function buildConnector(surfaces: {
  commands?: boolean;
  skills?: boolean;
  platforms?: ConnectorConfig["platforms"];
}): ResolvedConnector {
  const cfg: ConnectorConfig = { id: CONNECTOR_ID, displayName: "Acme Pi", version: "1.0.0" };
  if (surfaces.commands)
    cfg.commands = [{ ...COMMAND }];
  if (surfaces.skills)
    cfg.skills = [{ ...SKILL, tools: { allow: [...SKILL.tools.allow] }, resources: { ...SKILL.resources } }];
  if (surfaces.platforms) cfg.platforms = surfaces.platforms;
  return defineConnector(cfg);
}

// Shared env isolation + the same-rules-for-every-host baseline contract.
isolateEnv();
createAdapterSuite({ adapter: piAdapter, paradigm: "mcp-only" });

// ── 1. Capability flags ───────────────────────────────────────────────────────

describe("pi adapter — capabilities", () => {
  it("declares commands + skills but NOT subagents", () => {
    expect(piAdapter.capabilities.supportsCommands).toBe(true);
    expect(piAdapter.capabilities.supportsSkills).toBe(true);
    expect(piAdapter.capabilities.supportsSubagents).toBe(false);
  });

  it("has no MCP transports (transports=[])", () => {
    expect(piAdapter.capabilities.transports).toEqual([]);
  });

  it("has no hook capabilities", () => {
    expect(piAdapter.capabilities.preToolUse).toBe(false);
    expect(piAdapter.capabilities.postToolUse).toBe(false);
    expect(piAdapter.capabilities.sessionStart).toBe(false);
  });
});

// ── 2. MCP server + hooks always skip ────────────────────────────────────────

describe("pi adapter — server + hooks skip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector({ skills: true }));
  });

  it("installServer returns skip (no writable MCP config)", () => {
    const changes = piAdapter.installServer(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("no writable MCP config");
  });

  it("uninstallServer returns skip", () => {
    const changes = piAdapter.uninstallServer(ctx);
    expect(changes[0]?.action).toBe("skip");
  });

  it("installHooks returns skip (no hook layer)", () => {
    const changes = piAdapter.installHooks(ctx);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("no hook layer");
  });

  it("uninstallHooks returns skip", () => {
    const changes = piAdapter.uninstallHooks(ctx);
    expect(changes[0]?.action).toBe("skip");
  });

  it("backupSettings ignores the ~/.pi config directory", () => {
    const userCtx = buildCtx(projectDir, buildConnector({ skills: true }), "user");
    mkdirSync(join(projectDir, ".pi"), { recursive: true });

    expect(piAdapter.backupSettings(userCtx)).toBeNull();
  });
});

// ── 3. Commands (prompt templates) — project scope ───────────────────────────

describe("pi adapter — commands (project scope)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector({ commands: true }));
  });

  it("installCommands writes <projectDir>/.pi/prompts/<name>.md", () => {
    const changes = piAdapter.installCommands!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("create");

    const cmdPath = join(projectDir, ".pi", "prompts", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);
  });

  it("rendered command file has correct frontmatter + body", () => {
    piAdapter.installCommands!(ctx);
    const cmdPath = join(projectDir, ".pi", "prompts", "deploy.md");
    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe(COMMAND.description);
    expect(frontmatter.model).toBe(COMMAND.model);
    expect(frontmatter["argument-hint"]).toBe(COMMAND.argumentHint);
    expect(body.trim()).toBe(COMMAND.prompt);
  });

  it("installCommands is idempotent — second call returns skip", () => {
    piAdapter.installCommands!(ctx);
    const second = piAdapter.installCommands!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallCommands removes the prompt file", () => {
    piAdapter.installCommands!(ctx);
    const cmdPath = join(projectDir, ".pi", "prompts", "deploy.md");
    expect(existsSync(cmdPath)).toBe(true);
    piAdapter.uninstallCommands!(ctx);
    expect(existsSync(cmdPath)).toBe(false);
  });

  it("returns skip when connector declares no commands", () => {
    // Use a connector that declares only skills (no commands) to get the "no commands" skip.
    const ctx2 = buildCtx(projectDir, buildConnector({ skills: true }));
    const changes = piAdapter.installCommands!(ctx2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".pi", "prompts"))).toBe(false);
  });

  it("honors platforms['pi'].commands === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      commands: [{ name: "deploy", prompt: "do it" }],
      platforms: { pi: { commands: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = piAdapter.installCommands!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".pi", "prompts", "deploy.md"))).toBe(false);
  });
});

// ── 4. Commands — user scope path (regression guard) ─────────────────────────

describe("pi adapter — commands USER scope path", () => {
  it("user-scope command lands under ~/.pi/agent/prompts/ (NOT ~/.pi/prompts/)", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, buildConnector({ commands: true }), "user");

    const changes = piAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");

    // HOME is redirected to projectDir, so ~/.pi === projectDir/.pi
    const expectedPath = join(projectDir, ".pi", "agent", "prompts", "deploy.md");
    expect(changes[0]?.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    // Must NOT write to ~/.pi/prompts/ (old wrong path)
    const wrongPath = join(projectDir, ".pi", "prompts", "deploy.md");
    expect(existsSync(wrongPath)).toBe(false);
  });
});

// ── 5. Skills — project scope ─────────────────────────────────────────────────

describe("pi adapter — skills (project scope)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector({ skills: true }));
  });

  it("installSkills writes <projectDir>/.pi/skills/<name>/SKILL.md", () => {
    const changes = piAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    const skillMd = join(projectDir, ".pi", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
  });

  it("rendered SKILL.md has correct frontmatter with SPACE-delimited allowed-tools", () => {
    piAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".pi", "skills", "pdf-tools", "SKILL.md");
    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(frontmatter.model).toBe("haiku");
    // Pi uses SPACE-delimited allowed-tools — NOT ", "
    expect(frontmatter["allowed-tools"]).toBe("Bash Read");
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(body).toContain("# PDF Tools");
  });

  it("resource file is written beside SKILL.md", () => {
    piAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".pi", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills is idempotent — second call returns skip", () => {
    piAdapter.installSkills!(ctx);
    const second = piAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and empty skill dir", () => {
    piAdapter.installSkills!(ctx);
    piAdapter.uninstallSkills!(ctx);
    expect(existsSync(join(projectDir, ".pi", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".pi", "skills", "pdf-tools"))).toBe(false);
  });

  it("honors platforms['pi'].skills === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      skills: [{ name: "pdf-tools", description: SKILL.description, body: "x" }],
      platforms: { pi: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(piAdapter.installSkills!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".pi", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });
});

// ── 6. Skills USER-SCOPE PATH BUG regression guard ───────────────────────────

describe("pi adapter — skills USER scope path (regression guard)", () => {
  it("user-scope skill lands under ~/.pi/agent/skills/ (NOT ~/.pi/skills/)", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, buildConnector({ skills: true }), "user");

    const changes = piAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    // HOME is redirected to projectDir, so ~/.pi === projectDir/.pi
    const expectedPath = join(projectDir, ".pi", "agent", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    // Must NOT write to ~/.pi/skills/ (old bug path)
    const bugPath = join(projectDir, ".pi", "skills", "pdf-tools", "SKILL.md");
    expect(existsSync(bugPath)).toBe(false);
  });

  it("user-scope skill uninstall cleans up from ~/.pi/agent/skills/", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, buildConnector({ skills: true }), "user");

    piAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".pi", "agent", "skills", "pdf-tools", "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);

    piAdapter.uninstallSkills!(ctx);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(join(projectDir, ".pi", "agent", "skills", "pdf-tools"))).toBe(false);
  });
});

// ── 7. allowed-tools: space-delimited ────────────────────────────────────────

describe("pi adapter — allowed-tools space-delimited", () => {
  it("multi-tool allowed-tools is space-joined (not comma-joined)", () => {
    const projectDir = freshProject();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      skills: [
        {
          name: "multi-tool",
          description: "Uses many tools.",
          body: "body",
          tools: { allow: ["Bash", "Read", "Grep"] },
        },
      ],
    });
    const ctx = buildCtx(projectDir, connector);
    piAdapter.installSkills!(ctx);

    const skillMd = join(projectDir, ".pi", "skills", "multi-tool", "SKILL.md");
    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    // Must be space-delimited
    expect(frontmatter["allowed-tools"]).toBe("Bash Read Grep");
    // Must NOT be comma-delimited
    expect(frontmatter["allowed-tools"]).not.toContain(",");
  });

  it("single-tool allowed-tools has no trailing separator", () => {
    const projectDir = freshProject();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      skills: [
        {
          name: "single-tool",
          description: "Uses one tool.",
          body: "body",
          tools: { allow: ["Bash"] },
        },
      ],
    });
    const ctx = buildCtx(projectDir, connector);
    piAdapter.installSkills!(ctx);

    const skillMd = join(projectDir, ".pi", "skills", "single-tool", "SKILL.md");
    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter["allowed-tools"]).toBe("Bash");
  });
});

// ── 8. Subagents unsupported ──────────────────────────────────────────────────

describe("pi adapter — subagents unsupported", () => {
  it("installSubagents with no subagents declared returns skip", () => {
    const projectDir = freshProject();
    // Use a skills-only connector so defineConnector doesn't reject it.
    const ctx = buildCtx(projectDir, buildConnector({ skills: true }));
    const changes = piAdapter.installSubagents!(ctx);
    expect(changes[0]?.action).toBe("skip");
  });

  it("installSubagents with a declared subagent returns warn (unsupported surface)", () => {
    const projectDir = freshProject();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      subagents: [{ name: "reviewer", description: "Reviews code.", prompt: "You are a reviewer." }],
    });
    const ctx = buildCtx(projectDir, connector);
    const changes = piAdapter.installSubagents!(ctx);
    // BaseAdapter default: declared-but-unsupported → warn
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
  });
});

// ── 9. Content-surface round-trip (absorbed from surfaces-s2.test.ts) ─────────
// pi was the LAST host in the former tests/adapters/surfaces-s2.test.ts; its
// content-surface slice is preserved verbatim here under its own fixtures
// (connector id "acme-surfaces", a single-tool skill) so it does not collide
// with the per-host fixtures above.

const SURFACES_CONNECTOR_ID = "acme-surfaces";

const SURFACES_COMMAND = {
  name: "deploy",
  description: "Deploy the app to an environment.",
  prompt: "Deploy to {{args}} / $ARGUMENTS and report the result.",
  argumentHint: "[environment]",
  tools: { allow: ["Bash", "Read"] },
  model: "sonnet",
} as const;

const SURFACES_SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files when the user asks.",
  body: "# PDF Tools\n\nUse the bundled script to extract text.",
  model: "haiku",
  tools: { allow: ["Bash"] },
  disableModelInvocation: false,
  resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
} as const;

const SURFACES_SUBAGENT = {
  name: "reviewer",
  description: "Reviews code diffs for correctness bugs.",
  prompt: "You are a meticulous code reviewer. Find correctness bugs.",
  tools: { allow: ["Read", "Grep"] },
  model: "opus",
  readonly: true,
} as const;

/** Deep-clone the shared command fixture (fresh arrays so adapters never alias). */
function surfacesCommand() {
  return { ...SURFACES_COMMAND, tools: { allow: [...SURFACES_COMMAND.tools.allow] } };
}
function surfacesSkill() {
  return {
    ...SURFACES_SKILL,
    tools: { allow: [...SURFACES_SKILL.tools.allow] },
    resources: { ...SURFACES_SKILL.resources },
  };
}
function surfacesSubagent() {
  return { ...SURFACES_SUBAGENT, tools: { allow: [...SURFACES_SUBAGENT.tools.allow] } };
}

/** Build a connector declaring ONLY the surfaces a platform supports. */
function buildSurfacesConnector(surfaces: {
  commands?: boolean;
  skills?: boolean;
  subagents?: boolean;
}): ResolvedConnector {
  const cfg: ConnectorConfig = {
    id: SURFACES_CONNECTOR_ID,
    displayName: "Acme Surfaces",
    version: "1.0.0",
  };
  if (surfaces.commands) cfg.commands = [surfacesCommand()];
  if (surfaces.skills) cfg.skills = [surfacesSkill()];
  if (surfaces.subagents) cfg.subagents = [surfacesSubagent()];
  return defineConnector(cfg);
}

describe("pi adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    // Declare ONLY the supported surface (skills). Commands/subagents are
    // unsupported on Pi; with none declared they resolve to a skip.
    ctx = buildCtx(projectDir, buildSurfacesConnector({ skills: true }));
  });

  it("declares commands + skills (prompt templates + Agent Skills), no subagents", () => {
    expect(piAdapter.capabilities.supportsSkills).toBe(true);
    expect(piAdapter.capabilities.supportsCommands).toBe(true);
    expect(piAdapter.capabilities.supportsSubagents).toBe(false);
  });

  it("installSkills writes uniform SKILL.md + resource at .pi/skills/<n>/SKILL.md", () => {
    const changes = piAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    const skillMd = join(projectDir, ".pi", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(join(projectDir, ".pi", "skills", "pdf-tools", "scripts", "extract.sh"))).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SURFACES_SKILL.description);
    expect(frontmatter.model).toBe("haiku");
    expect(frontmatter["allowed-tools"]).toBe("Bash");
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(body).toContain("# PDF Tools");
  });

  it("installCommands skips when none declared; installSubagents (unsupported) skips — no files", () => {
    // ctx declares only skills, so commands resolve to a skip ("none declared");
    // subagents are unsupported on pi and also skip. Neither writes a file.
    expect(piAdapter.installCommands!(ctx)[0]?.action).toBe("skip");
    expect(piAdapter.installSubagents!(ctx)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".pi", "prompts"))).toBe(false);
    expect(existsSync(join(projectDir, ".pi", "agents"))).toBe(false);
  });

  it("is idempotent — second install yields skip", () => {
    piAdapter.installSkills!(ctx);
    expect(piAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes the skill dir", () => {
    piAdapter.installSkills!(ctx);
    piAdapter.uninstallSkills!(ctx);
    expect(existsSync(join(projectDir, ".pi", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".pi", "skills", "pdf-tools"))).toBe(false);
  });

  it("honors platforms['pi'].skills === false", () => {
    const disabled = defineConnector({
      id: SURFACES_CONNECTOR_ID,
      skills: [{ name: "pdf-tools", description: SURFACES_SKILL.description, body: "x" }],
      platforms: { pi: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(piAdapter.installSkills!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".pi", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10. Action surface — slash commands in a generated extension module.
//
// Pi loads TS extension modules that call pi.registerCommand(name, { handler });
// AC binds each declared action to a handler that execs `action pi <id>`. The
// emitter is the OMP adapter's near-verbatim (omp wraps pi; its action support
// was inferred FROM pi). UNLIKE omp the module is actions-only (no hook handlers,
// Pi has no hook layer) and uninstallActions owns the teardown directly. These
// tests guard the load-bearing risks: the registerCommand block is present and
// the `action pi <id>` token is host-correct; a description containing a `"` is
// JSON-escaped so the module still PARSES; the handler shells out to the home bin
// (live, child_process mocked); install is idempotent; uninstall removes the
// module; opt-out and empty-actions skip honestly; the scope split is correct.
// ─────────────────────────────────────────────────────────────────────────

/** A connector with ONLY actions (no commands, no skills) — drives installActions. */
function actionsOnlyConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Pi",
    version: "1.0.0",
    actions: [
      { id: "reindex", description: "Rebuild the search index.", run: () => undefined },
      // A description with an embedded double-quote — must be JSON-escaped so the
      // generated module still parses (a raw " would take the whole plugin down).
      { id: "purge", description: 'Purge the "stale" cache.', run: () => undefined },
    ],
  });
}

describe("pi adapter — action surface (slash commands in a generated extension module)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  // Pin process.platform to a POSIX value for this block so the generated
  // command handler takes its execFileSync(HOME_BIN, [args]) path (on Windows it
  // would use execSync(one quoted string) — correct in production, mirrored from
  // omp/openclaw, but it would not match the execFileSync(bin, argv) call-shape
  // assertion below). node:path is bound at import and os.homedir() is native, so
  // neither the path nor the user-scope assertions are affected by this string
  // override. Restored in afterEach so the rest of the suite sees the real OS.
  const REAL_PLATFORM = process.platform;
  beforeEach(() => {
    projectDir = freshProject("ac-pi-act-");
    ctx = buildCtx(projectDir, actionsOnlyConnector());
    execFileSyncMock.mockClear();
    execFileSyncImpl = () => "";
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
  });

  it("advertises supportsActions", () => {
    expect(piAdapter.capabilities.supportsActions).toBe(true);
  });

  it("installActions writes the extension whose source embeds pi.registerCommand running `action pi <id>` and NO hook handlers", () => {
    const changes = piAdapter.installActions!(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);
    expect(changes.every((c) => c.platform === "pi")).toBe(true);

    const entryPath = join(projectDir, ".pi", "extensions", CONNECTOR_ID, "index.js");
    expect(changes.some((c) => c.path === entryPath)).toBe(true);
    expect(existsSync(entryPath)).toBe(true);
    const src = readFileSync(entryPath, "utf8");

    // The registerCommand block, host token literal "pi", both action ids.
    expect(src).toContain("pi.registerCommand(");
    expect(src).toContain('["action", "pi", "reindex", "--connector", CONNECTOR_ID]');
    expect(src).toContain('["action", "pi", "purge", "--connector", CONNECTOR_ID]');
    // Actions-only → NO hook handler is wired (Pi has no hook layer).
    expect(src).not.toContain("pi.on(");
    // The factory is still a valid module with the default export.
    expect(src).toContain("export default function");
    // Cross-platform spawn (parity with omp/openclaw, Windows-tested): the win32
    // branch routes through execSync(one quoted command line) because Node cannot
    // execFile a .cmd launcher (EINVAL); POSIX keeps execFileSync(bin, argv).
    expect(src).toContain('import { execFileSync, execSync } from "node:child_process"');
    expect(src).toContain('process.platform === "win32"');
    expect(src).toContain('execSync([HOME_BIN, ...args].map((a) => \'"\' + a + \'"\').join(" ")');
    expect(src).toContain("execFileSync(HOME_BIN, args, { stdio: \"inherit\" })");
  });

  it("JSON-escapes a description containing a double-quote (the module still parses)", async () => {
    piAdapter.installActions!(ctx);
    const entryPath = join(projectDir, ".pi", "extensions", CONNECTOR_ID, "index.js");
    const src = readFileSync(entryPath, "utf8");
    // The raw quote is escaped, never emitted bare.
    expect(src).toContain('description: "Purge the \\"stale\\" cache."');
    // The proof it parses: dynamically import the freshly-written module.
    const mod = await import(`${pathToFileURL(entryPath).href}?actesc=${Date.now()}`);
    expect(typeof mod.default).toBe("function");
  });

  it("the registerCommand handler shells out to the home bin (live, child_process mocked)", async () => {
    piAdapter.installActions!(ctx);
    const entryPath = join(projectDir, ".pi", "extensions", CONNECTOR_ID, "index.js");
    const mod = await import(`${pathToFileURL(entryPath).href}?actrun=${Date.now()}`);

    // Capture the registered commands by passing a fake `pi`.
    const registered: Record<string, any> = {};
    mod.default({ registerCommand: (name: string, def: any) => { registered[name] = def; } });
    expect(Object.keys(registered).sort()).toEqual(["purge", "reindex"]);

    execFileSyncImpl = () => "";
    await registered.reindex.handler({}, {});
    const call = execFileSyncMock.mock.calls.at(-1)!;
    expect(call[0]).toBe(HOME_BIN);
    expect(call[1]).toEqual(["action", "pi", "reindex", "--connector", CONNECTOR_ID]);
  });

  it("installActions is idempotent — a second call yields skip for every file", () => {
    piAdapter.installActions!(ctx);
    const second = piAdapter.installActions!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallActions removes the extension module (and the now-empty dir)", () => {
    piAdapter.installActions!(ctx);
    const entryPath = join(projectDir, ".pi", "extensions", CONNECTOR_ID, "index.js");
    expect(existsSync(entryPath)).toBe(true);

    const changes = piAdapter.uninstallActions!(ctx);
    expect(changes.some((c) => c.action === "remove")).toBe(true);
    expect(existsSync(entryPath)).toBe(false);
    // The per-connector dir is owned by us and now empty → removed.
    expect(existsSync(join(projectDir, ".pi", "extensions", CONNECTOR_ID))).toBe(false);
  });

  it("uninstallActions is an honest skip when nothing was installed", () => {
    const changes = piAdapter.uninstallActions!(ctx);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("no pi extension present");
  });

  it("honors platforms.pi.actions === false (opt-out, never writes)", () => {
    const ctxOff = buildCtx(
      projectDir,
      defineConnector({
        id: CONNECTOR_ID,
        actions: [{ id: "reindex", run: () => undefined }],
        platforms: { pi: { actions: false } },
      }),
    );
    const changes = piAdapter.installActions!(ctxOff);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("disabled for pi");
    expect(existsSync(join(projectDir, ".pi", "extensions", CONNECTOR_ID, "index.js"))).toBe(false);
  });

  it("skips honestly when the connector declares no actions", () => {
    const ctxNone = buildCtx(projectDir, buildConnector({ skills: true }));
    const changes = piAdapter.installActions!(ctxNone);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("no actions");
  });

  it("user-scope action extension lands under ~/.pi/agent/extensions/ (NOT ~/.pi/extensions/)", () => {
    const userCtx = buildCtx(projectDir, actionsOnlyConnector(), "user");
    const changes = piAdapter.installActions!(userCtx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    // HOME is redirected to projectDir, so ~/.pi === projectDir/.pi
    const expectedPath = join(projectDir, ".pi", "agent", "extensions", CONNECTOR_ID, "index.js");
    expect(existsSync(expectedPath)).toBe(true);
    // Must NOT write to the project-scope path.
    expect(existsSync(join(projectDir, ".pi", "extensions", CONNECTOR_ID, "index.js"))).toBe(false);
  });

  it("getHealthChecks for an actions connector asserts the extension module is present", () => {
    piAdapter.installActions!(ctx);
    const ext = piAdapter
      .getHealthChecks!(ctx)
      .find((c) => /action extension present/.test(c.name))!;
    expect(ext.check().status).toBe("OK");
  });
});
