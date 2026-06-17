/**
 * adapters/amp — the single per-host file for Amp (Sourcegraph / AmpCode).
 *
 * Amp is a `ts-plugin` host. This file consolidates EVERY amp surface (the
 * per-host convention in tests/README.md — one file per host):
 *   • MCP server  → .amp/settings.json under the FLAT dotted key
 *                   "amp.mcpServers".<id>; env-refs become Amp's native ${VAR}.
 *   • hooks       → a TypeScript plugin module .amp/plugins/<id>.ts that
 *                   default-exports (amp) => void and registers amp.on(...)
 *                   handlers bridged to the home-bin entrypoint.
 *   • skills      → SKILL.md (dir-per-skill) under .agents/skills (project) /
 *                   ~/.config/agents/skills (user) — NOT under ~/.config/amp.
 *   • regressions → JSONC-comment merge safety, malformed-file overwrite guard,
 *                   and ${env:VAR:-fallback} default preservation.
 *
 * Migrated to the shared harness (tests/support/env + adapter-suite); the
 * server/render block came from the old wave1-render.test.ts, the regression
 * blocks from review-fixes.test.ts, and the hook/skill blocks from the former
 * amp-hooks.test.ts / amp.test.ts.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { ensureDir } from "../../src/core/paths.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import ampAdapter from "../../src/adapters/amp/index.js";
import { buildCtx, freshProject, tempDir, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";

// ── identifiers ──────────────────────────────────────────────────────────────
const SKILLS_ID = "acme-amp-skills";
const HOOKS_ID = "acme-amp-hooks";
const DB_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";

// ── skill fixtures ───────────────────────────────────────────────────────────
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

function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  if (!m) throw new Error(`not a frontmatter doc:\n${text}`);
  return { frontmatter: parseYaml(m[1]!) as Record<string, unknown>, body: m[2]! };
}

// ── connector builders (one per surface; ids preserved from the source files) ─
function skillsConnector(cfg: Partial<ConnectorConfig> = {}): ResolvedConnector {
  return defineConnector({
    id: SKILLS_ID,
    displayName: "Acme Amp Skills",
    version: "1.0.0",
    skills: [skill()],
    ...cfg,
  });
}

/** A connector declaring all five mapped events + the unsupported SessionEnd. */
function hooksConnector(): ResolvedConnector {
  return defineConnector({
    id: HOOKS_ID,
    displayName: "Acme Amp",
    version: "1.0.0",
    hooks: {
      SessionStart: { handler: () => ({ decision: "allow" }) },
      UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
      PreToolUse: { handler: () => ({ decision: "allow" }) },
      PostToolUse: { handler: () => ({ decision: "allow" }) },
      Stop: { handler: () => ({ decision: "allow" }) },
      // No Amp analog → reported "unsupported here", never wired.
      SessionEnd: { handler: () => ({ decision: "allow" }) },
    },
  });
}

/** Path of the generated ts-plugin module (project scope). */
function entryPath(projectDir: string, id: string = HOOKS_ID): string {
  return join(projectDir, ".amp", "plugins", `${id}.ts`);
}

/** A connector with a stdio server (env-ref) + a PreToolUse hook (render block). */
function renderConnector(): ResolvedConnector {
  return defineConnector({
    id: DB_ID,
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

/** A bare stdio-server + PreToolUse/SessionStart connector (regression blocks). */
function regressionConnector(overrides: Partial<ConnectorConfig> = {}): ResolvedConnector {
  return defineConnector({
    id: DB_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: { transport: "stdio", command: "npx", args: ["-y", "@x/y"] },
    hooks: {
      PreToolUse: { handler: () => ({ decision: "allow" }) },
      SessionStart: { handler: () => ({ decision: "allow" }) },
    },
    ...overrides,
  });
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Seed a JSON settings file on disk with arbitrary contents (creating dirs). */
function seedJson(path: string, data: unknown): void {
  ensureDir(join(path, ".."));
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** The home-bin serve-wrapper args the rendered MCP entry routes through. */
const wrappedArgs = (host: string): string[] => [
  "serve",
  "--connector",
  DB_ID,
  "--scope",
  "project",
  "--host",
  host,
  "--",
  "npx",
  "-y",
  "@x/y",
];

// Shared env isolation (default keys + the env-ref vars the render/regression
// blocks mutate) + the same-rules-for-every-host baseline contract.
isolateEnv([ENV_VAR, "AC_RF_AMP_VAR"]);
createAdapterSuite({ adapter: ampAdapter, paradigm: "ts-plugin" });

// ── identity + capabilities ──────────────────────────────────────────────────

describe("amp adapter — identity + capabilities", () => {
  it("declares the ts-plugin paradigm and the verified capability flags", () => {
    expect(ampAdapter.paradigm).toBe("ts-plugin");
    const c = ampAdapter.capabilities;
    expect(c.sessionStart).toBe(true);
    expect(c.userPromptSubmit).toBe(true);
    expect(c.preToolUse).toBe(true);
    expect(c.postToolUse).toBe(true);
    expect(c.stop).toBe(true);
    // Amp documents no session.end.
    expect(c.sessionEnd).toBe(false);
    expect(c.preCompact).toBe(false);
    expect(c.notification).toBe(false);
    // tool.call decision surface is the { action } union (no documented arg
    // rewrite); tool.result's replacement object shape is undocumented, so
    // PostToolUse is observe-only (canModifyOutput:false); no session.start
    // context-injection surface.
    expect(c.canModifyArgs).toBe(false);
    expect(c.canModifyOutput).toBe(false);
    expect(c.canInjectSessionContext).toBe(false);
    expect(c.supportsNativeHooks).toBe(true);
    expect(c.supportsSkills).toBe(true);
  });
});

// ── MCP server render/round-trip (dotted FLAT key "amp.mcpServers") ──────────

describe("amp adapter — MCP server render/round-trip", () => {
  let projectDir: string;
  let ctx: ReturnType<typeof buildCtx>;

  beforeEach(() => {
    projectDir = freshProject("ac-amp-render-");
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, renderConnector());
  });

  it('installServer writes the FLAT dotted key "amp.mcpServers".<id> into .amp/settings.json, wrapped, env as native ${VAR}', () => {
    const changes = ampAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".amp", "settings.json");
    expect(serverPath).toBe(ampAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // QUIRK: a single FLAT dotted key, NOT a nested { amp: { mcpServers } }.
    expect(cfg).toHaveProperty(["amp.mcpServers"]);
    expect(cfg).not.toHaveProperty("mcpServers");
    expect(cfg.amp).toBeUndefined();

    const entry = cfg["amp.mcpServers"][DB_ID];
    expect(entry).toBeTruthy();

    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgs("amp"));

    // Amp expands ${VAR} natively → ref rewritten to Amp's token, NOT a literal.
    expect(entry.env[ENV_VAR]).toBe(`\${${ENV_VAR}}`);
    expect(entry.env[ENV_VAR]).not.toBe(ENV_LITERAL);
  });

  it("installHooks writes the ts-plugin module .amp/plugins/<id>.ts with the PreToolUse bridge", () => {
    const changes = ampAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("create");

    const hooksPath = ampAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(join(projectDir, ".amp", "plugins", `${DB_ID}.ts`));
    expect(existsSync(hooksPath)).toBe(true);

    const src = readFileSync(hooksPath, "utf8");
    expect(src).toContain('amp.on("tool.call"');
    expect(src).toContain('bridge("PreToolUse"');
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    ampAdapter.installServer(ctx);
    const second = ampAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".amp", "settings.json"));
    expect(Object.keys(cfg["amp.mcpServers"])).toEqual([DB_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    ampAdapter.installServer(ctx);
    ampAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".amp", "settings.json"));
    expect(cfg["amp.mcpServers"]?.[DB_ID]).toBeUndefined();
  });

  it("preserves pre-existing unrelated settings keys (shared settings.json merge)", () => {
    const serverPath = join(projectDir, ".amp", "settings.json");
    seedJson(serverPath, {
      "amp.notifications.enabled": true,
      "amp.url": "https://ampcode.com",
    });

    ampAdapter.installServer(ctx);

    const cfg = readJson(serverPath);
    // Unrelated dotted settings survive the merge.
    expect(cfg["amp.notifications.enabled"]).toBe(true);
    expect(cfg["amp.url"]).toBe("https://ampcode.com");
    // Our entry is added under the dotted MCP key.
    expect(cfg["amp.mcpServers"][DB_ID]).toBeTruthy();
  });
});

// ── ts-plugin hooks (.amp/plugins/<id>.ts) ───────────────────────────────────

describe("amp adapter — ts-plugin hooks", () => {
  it("installHooks (project) writes .amp/plugins/<id>.ts with each amp.on + bridge", () => {
    const projectDir = freshProject("ac-amp-hooks-");
    const changes = ampAdapter.installHooks(buildCtx(projectDir, hooksConnector()));
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("amp");
    expect(changes[0]?.path).toBe(entryPath(projectDir));
    expect(existsSync(entryPath(projectDir))).toBe(true);

    const src = readFileSync(entryPath(projectDir), "utf8");
    // verified amp.on event names, each wired to its canonical bridge call.
    expect(src).toContain('amp.on("session.start"');
    expect(src).toContain('bridge("SessionStart"');
    expect(src).toContain('amp.on("agent.start"');
    expect(src).toContain('bridge("UserPromptSubmit"');
    expect(src).toContain('amp.on("tool.call"');
    expect(src).toContain('bridge("PreToolUse"');
    expect(src).toContain('amp.on("tool.result"');
    expect(src).toContain('bridge("PostToolUse"');
    expect(src).toContain('amp.on("agent.end"');
    expect(src).toContain('bridge("Stop"');
    // function-export plugin shape + the home-bin host token.
    expect(src).toContain("export default function plugin(amp: PluginAPI)");
    expect(src).toContain('"hook", "amp", event, "--connector"');
    // SessionEnd has no Amp analog → no session.end handler is emitted.
    expect(src).not.toContain("session.end");
  });

  it("PreToolUse blocks via the { action: 'reject-and-continue' } union; PostToolUse is observe-only", () => {
    const projectDir = freshProject("ac-amp-hooks-");
    ampAdapter.installHooks(buildCtx(projectDir, hooksConnector()));
    const src = readFileSync(entryPath(projectDir), "utf8");
    // tool.call: deny/ask → return amp's documented decision union (NOT a throw).
    expect(src).toContain('res.decision === "deny" || res.decision === "ask"');
    expect(src).toContain('action: "reject-and-continue"');
    expect(src).toContain('return { action: "allow" }');
    expect(src).not.toContain("throw new Error(");
    // tool.call tool name comes from the verified event.tool field.
    expect(src).toContain("event.tool");
    // tool.result: observe-only — the replacement object shape is undocumented,
    // so the handler returns nothing (no guessed { output } mutation).
    expect(src).not.toContain("res.updatedOutput");
    expect(src).not.toContain("return { output:");
    // session.start id from the verified event.thread.id field.
    expect(src).toContain("event.thread && event.thread.id");
  });

  it("reports SessionEnd as 'unsupported here' in the change detail", () => {
    const projectDir = freshProject("ac-amp-hooks-");
    const changes = ampAdapter.installHooks(buildCtx(projectDir, hooksConnector()));
    expect(changes[0]?.detail).toContain("unsupported here: SessionEnd");
    // The five mapped events ARE claimed.
    expect(changes[0]?.detail).toContain("SessionStart");
    expect(changes[0]?.detail).toContain("PreToolUse");
  });

  it("nativeHooks passthrough registers + bridges the native event verbatim", () => {
    const projectDir = freshProject("ac-amp-hooks-");
    const connector = defineConnector({
      id: HOOKS_ID,
      displayName: "Acme Amp Native",
      version: "1.0.0",
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        amp: { nativeHooks: { "thread.update": { handler: () => ({}) } } },
      },
    });
    const changes = ampAdapter.installHooks(buildCtx(projectDir, connector));
    expect(changes.some((c) => c.action === "skip")).toBe(false);

    const src = readFileSync(entryPath(projectDir), "utf8");
    expect(src).toContain('amp.on("thread.update"');
    expect(src).toContain('bridge("thread.update"');
    // the canonical handler is still wired alongside (no regression).
    expect(src).toContain('amp.on("tool.call"');
    expect(changes[0]?.detail).toContain("native: thread.update");
  });

  it("native-only connector (no canonical hooks) STILL synthesizes the plugin", () => {
    const projectDir = freshProject("ac-amp-hooks-");
    const connector = defineConnector({
      id: HOOKS_ID,
      displayName: "Acme Amp Native Only",
      version: "1.0.0",
      platforms: { amp: { nativeHooks: { "thread.update": { handler: () => ({}) } } } },
    });
    const changes = ampAdapter.installHooks(buildCtx(projectDir, connector));
    expect(changes.some((c) => c.action === "skip")).toBe(false);

    const src = readFileSync(entryPath(projectDir), "utf8");
    expect(src).toContain('amp.on("thread.update"');
    expect(src).not.toContain('amp.on("tool.call"');
    expect(src).toContain("export default function plugin(amp: PluginAPI)");
  });

  it("hooks:false disables canonical handlers but a nativeHook STILL registers", () => {
    const projectDir = freshProject("ac-amp-hooks-");
    const connector = defineConnector({
      id: HOOKS_ID,
      displayName: "Acme Amp Hooks Off",
      version: "1.0.0",
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        amp: { hooks: false, nativeHooks: { "thread.update": { handler: () => ({}) } } },
      },
    });
    const changes = ampAdapter.installHooks(buildCtx(projectDir, connector));
    expect(changes.some((c) => c.action === "skip")).toBe(false);

    const src = readFileSync(entryPath(projectDir), "utf8");
    expect(src).toContain('amp.on("thread.update"'); // native installed (sibling)
    expect(src).not.toContain('amp.on("tool.call"'); // canonical disabled by hooks:false
  });

  it("hooks:false with NO native events → skip 'hooks disabled for amp'", () => {
    const projectDir = freshProject("ac-amp-hooks-");
    const connector = defineConnector({
      id: HOOKS_ID,
      displayName: "Acme Amp Off",
      version: "1.0.0",
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: { amp: { hooks: false } },
    });
    const changes = ampAdapter.installHooks(buildCtx(projectDir, connector));
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("hooks disabled for amp");
    expect(existsSync(entryPath(projectDir))).toBe(false);
  });

  it("no hooks declared → skip 'connector declares no hooks'", () => {
    const projectDir = freshProject("ac-amp-hooks-");
    const connector = defineConnector({
      id: HOOKS_ID,
      displayName: "Acme Amp Bare",
      version: "1.0.0",
      memory: [{ content: "placeholder" }],
    });
    const changes = ampAdapter.installHooks(buildCtx(projectDir, connector));
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("connector declares no hooks");
  });

  it("user scope warn-skips (no documented user-scope plugins dir)", () => {
    const projectDir = freshProject("ac-amp-hooks-");
    const changes = ampAdapter.installHooks(buildCtx(projectDir, hooksConnector(), "user"));
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("project-scoped");
    // Nothing is written under the project .amp/plugins tree either.
    expect(existsSync(entryPath(projectDir))).toBe(false);
  });

  it("idempotent second install → skip; uninstall removes the module", () => {
    const projectDir = freshProject("ac-amp-hooks-");
    const ctx = buildCtx(projectDir, hooksConnector());
    ampAdapter.installHooks(ctx);
    const second = ampAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const removed = ampAdapter.uninstallHooks(ctx);
    expect(removed[0]?.action).toBe("remove");
    expect(existsSync(entryPath(projectDir))).toBe(false);

    const again = ampAdapter.uninstallHooks(ctx);
    expect(again[0]?.action).toBe("skip");
  });

  it("formatReply emits the normalized HookResponse on stdout (exit 0)", () => {
    const reply = ampAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "nope",
    });
    expect(reply.exitCode).toBe(0);
    expect(JSON.parse(reply.stdout!)).toEqual({ decision: "deny", reason: "nope" });
  });

  it("parseEvent maps the bridge payload for each wired event", () => {
    const pre = ampAdapter.parseEvent!("PreToolUse", {
      toolName: "Bash",
      toolInput: { cmd: "ls" },
      sessionId: "s1",
      projectDir: "/p",
    });
    expect(pre).toMatchObject({
      hostPlatform: "amp",
      toolName: "Bash",
      toolInput: { cmd: "ls" },
      sessionId: "s1",
      projectDir: "/p",
    });

    const ups = ampAdapter.parseEvent!("UserPromptSubmit", { prompt: "hi" });
    expect(ups).toMatchObject({ hostPlatform: "amp", prompt: "hi" });

    const post = ampAdapter.parseEvent!("PostToolUse", {
      toolName: "Bash",
      toolOutput: "done",
      isError: false,
    });
    expect(post).toMatchObject({ toolName: "Bash", toolOutput: "done", isError: false });

    const stop = ampAdapter.parseEvent!("Stop", { sessionId: "s2" });
    expect(stop).toMatchObject({ hostPlatform: "amp", sessionId: "s2" });
  });
});

// ── skills surface (.agents/skills — NOT ~/.config/amp/skills) ───────────────

describe("amp adapter — skills surface", () => {
  let projectDir: string;
  let ctx: ReturnType<typeof buildCtx>;

  beforeEach(() => {
    projectDir = freshProject("ac-amp-skills-");
    ctx = buildCtx(projectDir, skillsConnector());
  });

  it("declares supportsSkills true", () => {
    expect(ampAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes .agents/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = ampAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("amp");

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
    ampAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".agents", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.config/agents/skills/<n>/SKILL.md (NOT ~/.config/amp/skills)", () => {
    const userCtx = buildCtx(projectDir, skillsConnector(), "user");
    const changes = ampAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("amp");

    // HOME redirected to projectDir → ~/.config/agents === projectDir/.config/agents
    const skillMd = join(projectDir, ".config", "agents", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    // The skill root must NOT be the (also-documented) ~/.config/amp/skills dir.
    expect(existsSync(join(projectDir, ".config", "amp", "skills", "pdf-tools", "SKILL.md"))).toBe(
      false,
    );

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
  });

  it("user-scope skill does NOT write into the project .agents tree", () => {
    // Write user-scope into one dir, leave a separate project dir untouched.
    const userDir = freshProject("ac-amp-skills-");
    const projDir = tempDir("ac-amp-skills-proj-");
    const userCtx = buildCtx(projDir, skillsConnector(), "user");
    ampAdapter.installSkills!(userCtx);

    // The project dir's .agents tree must be empty (user wrote to ~/.config/agents).
    expect(existsSync(join(projDir, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    // The user HOME/.config/agents tree got the file.
    expect(
      existsSync(join(userDir, ".config", "agents", "skills", "pdf-tools", "SKILL.md")),
    ).toBe(true);
  });

  it("installSkills is idempotent — second call yields skip", () => {
    ampAdapter.installSkills!(ctx);
    const second = ampAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    ampAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".agents", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const changes = ampAdapter.uninstallSkills!(ctx);
    expect(changes.every((c) => c.platform === "amp")).toBe(true);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools"))).toBe(false);
  });

  it("honors platforms['amp'].skills === false", () => {
    const disabled = skillsConnector({ platforms: { amp: { skills: false } } });
    const c2 = buildCtx(projectDir, disabled);
    const changes = ampAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: SKILLS_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills);
    const changes = ampAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── regression: JSONC-comment merge safety + malformed-file overwrite guard ──

describe("amp adapter — settings.json merge safety (regression)", () => {
  it("JSONC clobber: preserves a // comment + sibling key on install (no data loss)", () => {
    const projectDir = freshProject("ac-amp-rf-");
    const ctx = buildCtx(projectDir, regressionConnector());
    const settingsPath = ampAdapter.getServerConfigPath(ctx);

    ensureDir(join(projectDir, ".amp"));
    writeFileSync(
      settingsPath,
      `{
        // amp user preference — must survive
        "amp.notifications.enabled": true,
        "amp.mcpServers": {
          "user-owned": { "command": "/bin/echo" }
        },
      }`,
      "utf8",
    );

    const changes = ampAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const cfg = readJson(settingsPath);
    expect(cfg["amp.notifications.enabled"]).toBe(true);
    expect(cfg["amp.mcpServers"]["user-owned"]).toBeTruthy();
    expect(cfg["amp.mcpServers"][DB_ID]).toBeTruthy();
  });

  it("overwrite guard: uninstall warns + leaves a TRULY-malformed settings file untouched", () => {
    const projectDir = freshProject("ac-amp-rf-");
    const ctx = buildCtx(projectDir, regressionConnector());
    const settingsPath = ampAdapter.getServerConfigPath(ctx);

    const malformed = `{ "amp.mcpServers": broken, ,,, ]]]`;
    ensureDir(join(projectDir, ".amp"));
    writeFileSync(settingsPath, malformed, "utf8");

    const changes = ampAdapter.uninstallServer(ctx);
    expect(changes[0]?.action).toBe("warn");
    expect(readFileSync(settingsPath, "utf8")).toBe(malformed);
  });
});

// ── regression: ${env:VAR:-fallback} default preservation ────────────────────

describe("amp adapter — env-ref default is preserved (regression)", () => {
  const VAR = "AC_RF_AMP_VAR";

  it("resolves to the fallback literal when the var is UNSET", () => {
    const projectDir = freshProject("ac-amp-rf-");
    delete process.env[VAR];
    const connector = regressionConnector({
      server: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@x/y"],
        env: { ENDPOINT: `\${env:${VAR}:-https://fallback.example}` },
        wrapForTelemetry: false,
      },
      hooks: {},
    });
    const ctx = buildCtx(projectDir, connector);

    ampAdapter.installServer(ctx);
    const cfg = readJson(ampAdapter.getServerConfigPath(ctx));
    const entry = cfg["amp.mcpServers"][DB_ID];
    // The default is honored as a LITERAL — not silently dropped to a bare token.
    expect(entry.env.ENDPOINT).toBe("https://fallback.example");
    expect(entry.env.ENDPOINT).not.toContain("${");
  });

  it("resolves to the live value when the var IS set and non-empty", () => {
    const projectDir = freshProject("ac-amp-rf-");
    process.env[VAR] = "https://live.example";
    const connector = regressionConnector({
      server: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@x/y"],
        env: { ENDPOINT: `\${env:${VAR}:-https://fallback.example}` },
        wrapForTelemetry: false,
      },
      hooks: {},
    });
    const ctx = buildCtx(projectDir, connector);

    ampAdapter.installServer(ctx);
    const cfg = readJson(ampAdapter.getServerConfigPath(ctx));
    expect(cfg["amp.mcpServers"][DB_ID].env.ENDPOINT).toBe("https://live.example");
  });

  it("emits the bare native ${VAR} token when there is NO default", () => {
    const projectDir = freshProject("ac-amp-rf-");
    const connector = regressionConnector({
      server: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@x/y"],
        env: { TOKEN: `\${env:${VAR}}` },
        wrapForTelemetry: false,
      },
      hooks: {},
    });
    const ctx = buildCtx(projectDir, connector);

    ampAdapter.installServer(ctx);
    const cfg = readJson(ampAdapter.getServerConfigPath(ctx));
    // No default → keep Amp's native token so the secret stays out of the file.
    expect(cfg["amp.mcpServers"][DB_ID].env.TOKEN).toBe(`\${${VAR}}`);
  });
});
