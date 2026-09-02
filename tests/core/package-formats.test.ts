/**
 * core/package-formats — the multi-format `packageConnector` emitters.
 *
 * Drives the real dispatch against a connector declaring EVERY surface (server +
 * hooks + commands + skills + subagents) into an isolated os.tmpdir outDir, then
 * for each new format asserts:
 *   • the manifest path + shape (manifest dir/filename, required fields),
 *   • the component files (commands/agents-or-droids/skills/+resources),
 *   • hooks — the single-string home-bin command for the format's --host, mapped
 *     events only (where the format uses Claude-style hooks),
 *   • the MCP serve-wrapper (--host <platform>) in the format's MCP location,
 *   • --format all emits every format under <out>/<format>/,
 *   • dry-run writes NOTHING,
 *   • a format that OMITS a surface (kimi: no commands/hooks/subagents) SKIPS it,
 *     not errors, and returns a drop note.
 *
 * Isolation mirrors tests/core/package.test.ts: a fresh mkdtemp outDir per test;
 * HOME + AGENT_CONNECTOR_DATA_DIR redirected to temp and restored in afterEach.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import {
  ALL_FORMATS,
  DEFAULT_PACKAGE_FORMAT,
  FEASIBLE_FORMATS,
  LEGACY_FORMAT_ALIASES,
  isPackageFormat,
  packageConnector,
  packageConnectorAll,
  resolvePackageFormat,
} from "../../src/core/package.js";
import { readTomlString } from "../../src/core/toml.js";
import type { ResolvedConnector } from "../../src/core/types.js";
import cursorAdapter from "../../src/adapters/cursor/index.js";
import { buildCtx } from "../support/env.js";
import { symlinkOrSkipTest } from "../support/symlink.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-connector";

/** A connector declaring every surface: server + hooks + command + skill + subagent. */
function buildConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Connector",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/db-mcp", "--flag"],
      env: { API_TOKEN: "${env:ACME_TOKEN}" },
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
          return { decision: "context", additionalContext: "acme online" };
        },
      },
    },
    commands: [
      {
        name: "deploy",
        description: "Deploy the app to an environment.",
        prompt: "Deploy to $ARGUMENTS and report the result.",
        argumentHint: "[environment]",
        tools: { allow: ["Bash", "Read"] },
        model: "sonnet",
      },
    ],
    skills: [
      {
        name: "pdf-tools",
        description: "Extract and summarize text from PDF files when the user asks.",
        body: "# PDF Tools\n\nUse the bundled script to extract text.",
        model: "haiku",
        tools: { allow: ["Bash"] },
        resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
      },
    ],
    subagents: [
      {
        name: "reviewer",
        description: "Reviews code diffs for correctness bugs.",
        prompt: "You are a meticulous code reviewer. Find correctness bugs.",
        tools: { allow: ["Read", "Grep"] },
        model: "opus",
      },
    ],
    // Distribution metadata so the opt-in mcp-server-json format can emit in the
    // ALL_FORMATS coverage loops (describes the REAL @acme/db-mcp package).
    publish: {
      registryNamespace: "io.github.acme",
      packageName: "@acme/db-mcp",
      author: { name: "Acme Inc" },
    },
  });
}

let savedHome: string | undefined;
let savedDataDir: string | undefined;
let outDir: string;
let connector: ResolvedConnector;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  outDir = mkdtempSync(join(tmpdir(), "ac-fmt-"));
  process.env.HOME = outDir;
  process.env.USERPROFILE = outDir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(outDir, ".agent-connector");
  connector = buildConnector();
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** The canonical serve-wrapper args for a given --host, after the leading flags. */
function expectServeWrapper(
  entry: { command: string; args: string[]; env?: Record<string, string> },
  host: PlatformIdLike,
): void {
  expect(entry.command).toBe(HOME_BIN);
  expect(entry.args.slice(0, 6)).toEqual([
    "serve",
    "--connector",
    CONNECTOR_ID,
    "--host",
    host,
    "--",
  ]);
  expect(entry.args.slice(6)).toEqual(["npx", "-y", "@acme/db-mcp", "--flag"]);
  expect(entry.env).toEqual({ API_TOKEN: "${env:ACME_TOKEN}" });
}
type PlatformIdLike = string;

/** The canonical Claude-shaped hook command for a given --host. */
function hookCommand(host: string, event: string): string {
  return `"${HOME_BIN}" hook ${host} ${event} --connector ${CONNECTOR_ID}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Retired formats — codex-plugin / copilot-plugin resolve to agent-plugin
// ─────────────────────────────────────────────────────────────────────────

describe("retired formats — codex-plugin / copilot-plugin", () => {
  it("are no longer live formats but resolve to agent-plugin with a deprecation", () => {
    for (const legacy of ["codex-plugin", "copilot-plugin"]) {
      expect(isPackageFormat(legacy)).toBe(false);
      expect(ALL_FORMATS).not.toContain(legacy);
      expect(LEGACY_FORMAT_ALIASES[legacy]).toBe("agent-plugin");
      const resolved = resolvePackageFormat(legacy);
      expect(resolved?.format).toBe("agent-plugin");
      expect(resolved?.deprecation).toContain(legacy);
      expect(resolved?.deprecation).toContain("agent-plugin");
    }
    // Live formats resolve to themselves without a deprecation; junk is null.
    expect(resolvePackageFormat("agent-plugin")).toEqual({ format: "agent-plugin" });
    expect(resolvePackageFormat("claude-plugin")).toEqual({ format: "claude-plugin" });
    expect(resolvePackageFormat("vsix")).toBeNull();
    expect(resolvePackageFormat("all")).toBeNull();
  });

  it("agent-plugin is the default format packageConnector emits", () => {
    expect(DEFAULT_PACKAGE_FORMAT).toBe("agent-plugin");
    expect(ALL_FORMATS[0]).toBe("agent-plugin");
    expect(FEASIBLE_FORMATS[0]).toBe("agent-plugin");
    const res = packageConnector(connector, { outDir, homeBinPath: HOME_BIN });
    expect(existsSync(join(res.pluginDir, "plugin.json"))).toBe(true);
    expect(existsSync(join(res.pluginDir, ".claude-plugin"))).toBe(false);
    expect(existsSync(join(res.pluginDir, ".codex-plugin"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// factory-plugin — droid variant (.factory-plugin/, droids/, mcp.json)
// ─────────────────────────────────────────────────────────────────────────

describe("packageConnector — factory-plugin", () => {
  it("emits .factory-plugin/plugin.json with version + author and subagents under droids/", () => {
    const res = packageConnector(connector, { outDir, format: "factory-plugin", homeBinPath: HOME_BIN });
    expect(readdirSync(join(res.pluginDir, ".factory-plugin"))).toEqual(["plugin.json"]);
    const m = readJson(join(res.pluginDir, ".factory-plugin", "plugin.json"));
    expect(m.name).toBe(CONNECTOR_ID);
    expect(m.version).toBe("0.0.1"); // factory requires a version → default supplied
    expect(m.author).toEqual({ name: "Acme Inc" }); // publish.author, not the framework

    // Subagents go under droids/, NOT agents/.
    expect(existsSync(join(res.pluginDir, "droids", "reviewer.md"))).toBe(true);
    expect(existsSync(join(res.pluginDir, "agents", "reviewer.md"))).toBe(false);
  });

  it("uses mcp.json (no leading dot), serve-wrapped --host droid, + a root marketplace.json", () => {
    const res = packageConnector(connector, { outDir, format: "factory-plugin", homeBinPath: HOME_BIN });
    expect(existsSync(join(res.pluginDir, ".mcp.json"))).toBe(false);
    const mcp = readJson(join(res.pluginDir, "mcp.json")).mcpServers as Record<string, never>;
    expectServeWrapper(mcp[CONNECTOR_ID] as never, "droid");

    // Git-repo catalog sits at the repo ROOT (no manifest dir).
    expect(res.marketplacePath).toBe(join(outDir, "marketplace.json"));
    expect(existsSync(res.marketplacePath!)).toBe(true);

    const hooks = readJson(join(res.pluginDir, "hooks", "hooks.json")).hooks as Record<string, never>;
    expect((hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).PreToolUse![0]!.hooks[0]!.command)
      .toBe(hookCommand("droid", "PreToolUse"));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// gemini-extension — gemini-extension.json + TOML commands + inline mcpServers
// ─────────────────────────────────────────────────────────────────────────

describe("packageConnector — gemini-extension", () => {
  it("emits gemini-extension.json with name/version + inline serve-wrapped mcpServers + contextFileName", () => {
    const res = packageConnector(connector, { outDir, format: "gemini-extension", homeBinPath: HOME_BIN });
    const m = readJson(join(res.pluginDir, "gemini-extension.json"));
    expect(m.name).toBe(CONNECTOR_ID);
    expect(m.version).toBe("0.0.1"); // gemini requires version
    expect(m.contextFileName).toBe("GEMINI.md");
    const mcp = m.mcpServers as Record<string, never>;
    expectServeWrapper(mcp[CONNECTOR_ID] as never, "gemini-cli");
    // GEMINI.md context file present.
    expect(existsSync(join(res.pluginDir, "GEMINI.md"))).toBe(true);
  });

  it("renders commands as TOML { description, prompt }, skills + agents as markdown", () => {
    const res = packageConnector(connector, { outDir, format: "gemini-extension", homeBinPath: HOME_BIN });
    const tomlPath = join(res.pluginDir, "commands", "deploy.toml");
    expect(existsSync(tomlPath)).toBe(true);
    const cmd = readTomlString<{ description: string; prompt: string }>(readFileSync(tomlPath, "utf8"));
    expect(cmd.description).toBe("Deploy the app to an environment.");
    expect(cmd.prompt).toBe("Deploy to $ARGUMENTS and report the result.");
    // No .md command for gemini.
    expect(existsSync(join(res.pluginDir, "commands", "deploy.md"))).toBe(false);

    expect(existsSync(join(res.pluginDir, "skills", "pdf-tools", "SKILL.md"))).toBe(true);
    expect(existsSync(join(res.pluginDir, "skills", "pdf-tools", "scripts", "extract.sh"))).toBe(true);
    expect(existsSync(join(res.pluginDir, "agents", "reviewer.md"))).toBe(true);
  });

  it("emits hooks.json keyed --host gemini-cli, no marketplace catalog", () => {
    const res = packageConnector(connector, { outDir, format: "gemini-extension", homeBinPath: HOME_BIN });
    const hooks = readJson(join(res.pluginDir, "hooks", "hooks.json")).hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string }> }>
    >;
    expect(hooks.PreToolUse![0]!.hooks[0]!.command).toBe(hookCommand("gemini-cli", "PreToolUse"));
    expect(res.marketplacePath).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// qwen-extension — qwen-extension.json + Markdown commands + QWEN.md
// ─────────────────────────────────────────────────────────────────────────

describe("packageConnector — qwen-extension", () => {
  it("emits qwen-extension.json + QWEN.md and renders commands as MARKDOWN (not TOML)", () => {
    const res = packageConnector(connector, { outDir, format: "qwen-extension", homeBinPath: HOME_BIN });
    const m = readJson(join(res.pluginDir, "qwen-extension.json"));
    expect(m.name).toBe(CONNECTOR_ID);
    expect(m.contextFileName).toBe("QWEN.md");
    expect(existsSync(join(res.pluginDir, "QWEN.md"))).toBe(true);
    const mcp = m.mcpServers as Record<string, never>;
    expectServeWrapper(mcp[CONNECTOR_ID] as never, "qwen-code");

    // Commands are Markdown for qwen.
    expect(existsSync(join(res.pluginDir, "commands", "deploy.md"))).toBe(true);
    expect(existsSync(join(res.pluginDir, "commands", "deploy.toml"))).toBe(false);
    const cmd = readFileSync(join(res.pluginDir, "commands", "deploy.md"), "utf8");
    expect(cmd).toContain("Deploy to $ARGUMENTS and report the result.");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// agy-plugin — root plugin.json marker + SEPARATE mcp_config.json + hooks
// ─────────────────────────────────────────────────────────────────────────

describe("packageConnector — agy-plugin", () => {
  it("emits a REQUIRED root plugin.json marker (not under a manifest dir)", () => {
    const res = packageConnector(connector, { outDir, format: "agy-plugin", homeBinPath: HOME_BIN });
    const m = readJson(join(res.pluginDir, "plugin.json"));
    expect(m.name).toBe(CONNECTOR_ID);
    expect(m.version).toBe("0.0.1");
    expect(typeof m.description).toBe("string");
    // No .claude-plugin/.codex-plugin manifest dir.
    expect(existsSync(join(res.pluginDir, ".claude-plugin"))).toBe(false);
  });

  it("puts MCP in a SEPARATE mcp_config.json (serve-wrapped --host antigravity-cli), NOT inline/.mcp.json", () => {
    const res = packageConnector(connector, { outDir, format: "agy-plugin", homeBinPath: HOME_BIN });
    expect(existsSync(join(res.pluginDir, ".mcp.json"))).toBe(false);
    const cfgPath = join(res.pluginDir, "mcp_config.json");
    expect(existsSync(cfgPath)).toBe(true);
    const mcp = readJson(cfgPath).mcpServers as Record<string, never>;
    expectServeWrapper(mcp[CONNECTOR_ID] as never, "antigravity-cli");
    // The marker plugin.json must NOT carry mcpServers (agy ignores inline).
    expect(readJson(join(res.pluginDir, "plugin.json")).mcpServers).toBeUndefined();
  });

  it("emits skills/agents/commands markdown + hooks keyed --host antigravity-cli", () => {
    const res = packageConnector(connector, { outDir, format: "agy-plugin", homeBinPath: HOME_BIN });
    expect(existsSync(join(res.pluginDir, "skills", "pdf-tools", "SKILL.md"))).toBe(true);
    expect(existsSync(join(res.pluginDir, "agents", "reviewer.md"))).toBe(true);
    expect(existsSync(join(res.pluginDir, "commands", "deploy.md"))).toBe(true);
    // hooks.json MUST sit at the bundle ROOT: agy 1.0.7 silently ignores
    // hooks/hooks.json ("hooks: skipped (not found)") — root was fix-proven live.
    expect(existsSync(join(res.pluginDir, "hooks", "hooks.json"))).toBe(false);
    const hooks = readJson(join(res.pluginDir, "hooks.json")).hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string }> }>
    >;
    expect(hooks.SessionStart![0]!.hooks[0]!.command).toBe(hookCommand("antigravity-cli", "SessionStart"));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// cursor-plugin — .cursor-plugin/ + pointer fields + mcp.json + marketplace
// ─────────────────────────────────────────────────────────────────────────

describe("packageConnector — cursor-plugin", () => {
  it("emits .cursor-plugin/plugin.json with POINTER surface fields", () => {
    const res = packageConnector(connector, { outDir, format: "cursor-plugin", homeBinPath: HOME_BIN });
    expect(readdirSync(join(res.pluginDir, ".cursor-plugin"))).toEqual(["plugin.json"]);
    const m = readJson(join(res.pluginDir, ".cursor-plugin", "plugin.json"));
    expect(m.name).toBe(CONNECTOR_ID);
    expect(m.commands).toBe("./commands/");
    expect(m.agents).toBe("./agents/");
    expect(m.skills).toBe("./skills/");
    expect(m.hooks).toBe("./hooks/hooks.json");
    expect(m.mcpServers).toBe("./mcp.json");
  });

  it("emits components, mcp.json (serve-wrapped --host cursor), hooks, + .cursor-plugin/marketplace.json", () => {
    const res = packageConnector(connector, { outDir, format: "cursor-plugin", homeBinPath: HOME_BIN });
    expect(existsSync(join(res.pluginDir, "commands", "deploy.md"))).toBe(true);
    expect(existsSync(join(res.pluginDir, "agents", "reviewer.md"))).toBe(true);
    expect(existsSync(join(res.pluginDir, "skills", "pdf-tools", "SKILL.md"))).toBe(true);

    const mcp = readJson(join(res.pluginDir, "mcp.json")).mcpServers as Record<string, never>;
    expectServeWrapper(mcp[CONNECTOR_ID] as never, "cursor");

    // Cursor's hooks.json is its OWN flat shape — lower-camel native keys,
    // FLAT { command, matcher? } entries, top-level version — NOT the Claude
    // shape (PascalCase keys + nested { hooks:[{type,command}] }, no version).
    const hooksFile = readJson(join(res.pluginDir, "hooks", "hooks.json"));
    expect(hooksFile.version).toBe(1);
    const hooks = hooksFile.hooks as Record<
      string,
      Array<{ command: string; matcher?: string }>
    >;
    // PreToolUse → preToolUse (lower-camel), flat entry, matcher preserved.
    expect(hooks.PreToolUse).toBeUndefined(); // no Claude-shape PascalCase key
    expect(hooks.preToolUse![0]!.command).toBe(hookCommand("cursor", "PreToolUse"));
    expect(hooks.preToolUse![0]!.matcher).toBe("acme_query|acme_write");
    // The nested Claude `hooks:[{type,command}]` wrapper must NOT be present.
    expect(
      (hooks.preToolUse![0] as unknown as { hooks?: unknown }).hooks,
    ).toBeUndefined();
    // SessionStart → sessionStart; no matcher declared → flat { command } only.
    expect(hooks.sessionStart![0]!.command).toBe(hookCommand("cursor", "SessionStart"));
    expect(hooks.sessionStart![0]!.matcher).toBeUndefined();

    expect(res.marketplacePath).toBe(join(outDir, ".cursor-plugin", "marketplace.json"));
    const mkt = readJson(res.marketplacePath!);
    expect(mkt.owner).toEqual({ name: "Acme Inc" }); // publish.author attributes the catalog to the dev
    const plugins = mkt.plugins as Array<Record<string, unknown>>;
    expect(plugins[0]?.source).toBe(`./${CONNECTOR_ID}`);
  });

  it("omits pointer fields for surfaces a content-only connector lacks", () => {
    const contentOnly = defineConnector({
      id: "content-only",
      commands: [{ name: "hello", prompt: "Say hi." }],
    });
    const res = packageConnector(contentOnly, { outDir, format: "cursor-plugin", homeBinPath: HOME_BIN });
    const m = readJson(join(res.pluginDir, ".cursor-plugin", "plugin.json"));
    expect(m.commands).toBe("./commands/");
    expect(m.agents).toBeUndefined();
    expect(m.skills).toBeUndefined();
    expect(m.hooks).toBeUndefined();
    expect(m.mcpServers).toBeUndefined();
  });

  // REGRESSION (issue #172): the package emitter once wrote hooks.json in the
  // Claude shape (PascalCase keys + nested { hooks:[{type,command}] }, no
  // version), so a packaged Cursor plugin's hooks never loaded. Assert the
  // bundle's hooks.json is SHAPE-CONSISTENT with the live cursor install
  // adapter's output for the same connector — same keys, flat { command,
  // matcher? } entries, same top-level version — so the two can never silently
  // diverge again.
  it("hooks.json matches the cursor INSTALL adapter's flat shape (anti-drift)", () => {
    const res = packageConnector(connector, { outDir, format: "cursor-plugin", homeBinPath: HOME_BIN });
    const packaged = readJson(join(res.pluginDir, "hooks", "hooks.json"));

    // Drive the live install adapter against the SAME connector into a temp
    // project; its hooks.json is the byte-oracle for Cursor's real schema.
    const projectDir = mkdtempSync(join(tmpdir(), "ac-cursor-install-"));
    const ctx = buildCtx(projectDir, connector, { scope: "project", homeBinPath: HOME_BIN });
    cursorAdapter.installHooks(ctx);
    const installed = readJson(join(projectDir, ".cursor", "hooks.json"));

    // Same top-level version stamp (the bug had NONE).
    expect(packaged.version).toBe(1);
    expect(packaged.version).toBe(installed.version);

    // Same lower-camel native event keys (the bug used PascalCase Claude keys).
    const packagedHooks = packaged.hooks as Record<string, unknown[]>;
    const installedHooks = installed.hooks as Record<string, unknown[]>;
    expect(Object.keys(packagedHooks).sort()).toEqual(
      Object.keys(installedHooks).sort(),
    );
    expect(Object.keys(packagedHooks).sort()).toEqual(["preToolUse", "sessionStart"]);

    // Same FLAT entry structure: { command, matcher? } with NO nested Claude
    // `hooks:[{type,command}]` wrapper (the bug emitted the nested wrapper).
    for (const key of Object.keys(packagedHooks)) {
      const pEntry = packagedHooks[key]![0] as Record<string, unknown>;
      const iEntry = installedHooks[key]![0] as Record<string, unknown>;
      expect(typeof pEntry.command).toBe("string");
      expect(pEntry.hooks).toBeUndefined(); // no Claude nesting
      expect(Object.keys(pEntry).sort()).toEqual(Object.keys(iEntry).sort());
      expect(pEntry.command).toBe(iEntry.command);
      expect(pEntry.matcher).toBe(iEntry.matcher);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// kimi-plugin — skills + MCP ONLY; hooks/commands/subagents DROPPED (skip+note)
// ─────────────────────────────────────────────────────────────────────────

describe("packageConnector — kimi-plugin", () => {
  it("emits kimi.plugin.json carrying skills pointer + inline serve-wrapped mcpServers", () => {
    const res = packageConnector(connector, { outDir, format: "kimi-plugin", homeBinPath: HOME_BIN });
    const m = readJson(join(res.pluginDir, "kimi.plugin.json"));
    expect(m.name).toBe(CONNECTOR_ID);
    expect(m.skills).toBe("./skills/");
    const mcp = m.mcpServers as Record<string, never>;
    expectServeWrapper(mcp[CONNECTOR_ID] as never, "kimi");
    expect(existsSync(join(res.pluginDir, "skills", "pdf-tools", "SKILL.md"))).toBe(true);
  });

  it("SKIPS (does not error) commands/agents/hooks and returns a drop note for each", () => {
    const res = packageConnector(connector, { outDir, format: "kimi-plugin", homeBinPath: HOME_BIN });
    // Dropped surfaces produce NO files...
    expect(existsSync(join(res.pluginDir, "commands"))).toBe(false);
    expect(existsSync(join(res.pluginDir, "agents"))).toBe(false);
    expect(existsSync(join(res.pluginDir, "hooks"))).toBe(false);
    // ...and ARE surfaced as notes (lossy bundle is never silent).
    const notes = (res.notes ?? []).join("\n");
    expect(notes).toContain("command");
    expect(notes).toContain("subagent");
    expect(notes).toContain("hook");
    // No marketplace catalog for kimi.
    expect(res.marketplacePath).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// npm-plugin — publishable package + ESM bridge (hooks ride inside; rest noted)
// ─────────────────────────────────────────────────────────────────────────

describe("packageConnector — npm-plugin", () => {
  it("emits a publishable package.json (type:module, exports, keywords) + index.js bridge", () => {
    const res = packageConnector(connector, { outDir, format: "npm-plugin", homeBinPath: HOME_BIN });
    const pkg = readJson(join(res.pluginDir, "package.json"));
    expect(pkg.name).toBe(`opencode-${CONNECTOR_ID}`);
    expect(pkg.type).toBe("module");
    expect(pkg.exports).toEqual({ ".": "./index.js" });
    expect(pkg.keywords).toContain("opencode-plugin");
    expect(pkg.keywords).toContain("pi-package");
    const dependencies = pkg.dependencies as Record<string, string>;
    expect(dependencies["@ken-jo/agent-connector"]).toMatch(/^\^?\d+\.\d+\.\d+|\*$/);

    const index = readFileSync(join(res.pluginDir, "index.js"), "utf8");
    expect(index).toContain("export default async function");
    expect(index).toContain('FRAMEWORK_PACKAGE_NAME = "@ken-jo/agent-connector"');
    expect(index).toContain('"dist", "cli.js"');
    // The bridge wires the declared hook events to the universal entrypoint.
    expect(index).toContain('"tool.execute.before"'); // PreToolUse
    expect(index).toContain('"experimental.chat.system.transform"'); // SessionStart
    expect(index).toContain('"hook", "opencode"');
  });

  it("bundles skills, and NOTES the surfaces that cannot ride inside the package", () => {
    const res = packageConnector(connector, { outDir, format: "npm-plugin", homeBinPath: HOME_BIN });
    expect(existsSync(join(res.pluginDir, "skills", "pdf-tools", "SKILL.md"))).toBe(true);
    const notes = (res.notes ?? []).join("\n");
    expect(notes).toContain("command");
    expect(notes).toContain("subagent");
    expect(notes).toContain("MCP");
    expect(res.marketplacePath).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// agent-plugin — Agent Plugins 1.0.0: the SSOT bundle for every spec-speaking
// host (Codex, Copilot CLI / VS Code, Kiro, Hermes, …). Portable: the MCP entry
// + Copilot hooks run through a bundled launcher, never an absolute path.
// ─────────────────────────────────────────────────────────────────────────

describe("packageConnector — agent-plugin", () => {
  const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
  const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
  const COPILOT_NS = "com.github.copilot";
  const CODEX_NS = "com.openai";
  const LAUNCHER = "bin/agent-connector.mjs";
  const LAUNCHER_AT_ROOT = "${PLUGIN_ROOT}/bin/agent-connector.mjs";

  type HooksFile = {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
  };

  it("emits a ROOT plugin.json carrying the const $schema, a slug name, version-less when unpinned, author from publish, + the Codex extension", () => {
    const res = packageConnector(connector, { outDir, format: "agent-plugin", homeBinPath: HOME_BIN });
    const pluginDir = join(outDir, CONNECTOR_ID);
    expect(res.pluginDir).toBe(pluginDir);

    const m = readJson(join(pluginDir, "plugin.json"));
    expect(m.$schema).toBe(PLUGIN_SCHEMA);
    expect(m.name).toBe(CONNECTOR_ID);
    expect(m.name).toMatch(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
    expect(m.version).toBeUndefined();
    expect(m.description).toContain("Acme Connector");
    expect(m.author).toEqual({ name: "Acme Inc" });
    // Codex parses extensions["com.openai"] as its manifest overlay — the hooks
    // pointer is how it finds the namespaced hooks file.
    expect(m.extensions).toEqual({ [CODEX_NS]: { hooks: `./${CODEX_NS}/hooks/hooks.json` } });
    // Closed schema: nothing beyond the permitted top-level fields.
    for (const key of Object.keys(m)) {
      expect(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]).toContain(key);
    }
    expect(existsSync(join(pluginDir, "README.md"))).toBe(true);
  });

  it("emits local marketplace catalogs at BOTH documented locations (copilot/claude + codex), outside the plugin dir", () => {
    const res = packageConnector(connector, { outDir, format: "agent-plugin", homeBinPath: HOME_BIN });
    expect(res.marketplacePath).toBe(join(outDir, ".claude-plugin", "marketplace.json"));
    const copilotCatalog = readJson(res.marketplacePath!);
    const codexCatalog = readJson(join(outDir, ".agents", "plugins", "marketplace.json"));
    expect(codexCatalog).toEqual(copilotCatalog);
    expect(copilotCatalog.name).toBe("agent-connector");
    expect(copilotCatalog.owner).toEqual({ name: "Acme Inc" });
    expect((copilotCatalog.plugins as Array<Record<string, unknown>>)[0]?.source).toBe(`./${CONNECTOR_ID}`);
    // The plugin dir itself carries no host-specific manifest dirs.
    expect(existsSync(join(res.pluginDir, ".claude-plugin"))).toBe(false);
    expect(existsSync(join(res.pluginDir, ".codex-plugin"))).toBe(false);
  });

  it("emits mcp.json ($schema + mcpServers) whose stdio entry runs the serve-wrapper through the bundled LAUNCHER — no absolute home-bin path, no --host", () => {
    packageConnector(connector, { outDir, format: "agent-plugin", homeBinPath: HOME_BIN });
    const pluginDir = join(outDir, CONNECTOR_ID);
    const mcp = readJson(join(pluginDir, "mcp.json"));
    expect(mcp.$schema).toBe(MCP_SCHEMA);
    const servers = mcp.mcpServers as Record<string, { type: string; command: string; args: string[]; env?: Record<string, string> }>;
    const entry = servers[CONNECTOR_ID]!;
    expect(entry.type).toBe("stdio");
    expect(entry.command).toBe("node"); // ONE bare token (spec §7.2.1)
    expect(entry.args).toEqual([
      LAUNCHER_AT_ROOT, // ${PLUGIN_ROOT} expansion in args is spec-mandated (§7.2.3)
      "serve", "--connector", CONNECTOR_ID, "--", "npx", "-y", "@acme/db-mcp", "--flag",
    ]);
    expect(entry.args).not.toContain("--host");
    expect(entry.env).toEqual({ API_TOKEN: "${env:ACME_TOKEN}" });

    // The launcher is a self-contained ESM script resolving home-bin → PATH → npx.
    const launcher = readFileSync(join(pluginDir, LAUNCHER), "utf8");
    expect(launcher.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(launcher).toContain('join(dataRoot, "bin"');
    expect(launcher).toContain('onPath("agent-connector")');
    expect(launcher).toMatch(/"@ken-jo\/agent-connector(@\^\d+\.\d+\.\d+)?"/);
    expect(launcher).not.toContain(HOME_BIN);

    // Nothing in the PORTABLE surfaces embeds the machine-local home-bin path
    // (only the Codex namespace does, by design — see the com.openai test).
    for (const f of walk(pluginDir)) {
      if (f.includes(`${CODEX_NS}/`)) continue;
      expect(readFileSync(f, "utf8"), `${f} embeds the home-bin path`).not.toContain(HOME_BIN);
    }
  });

  it("keeps skills at the portable root and relocates hooks/commands/agents into the com.github.copilot/ namespace (launcher-routed hooks, .agent.md agents)", () => {
    const res = packageConnector(connector, { outDir, format: "agent-plugin", homeBinPath: HOME_BIN });
    const pluginDir = join(outDir, CONNECTOR_ID);

    // Portable core: skills/<n>/SKILL.md (+ resources) exactly as the claude-code adapter renders it.
    expect(existsSync(join(pluginDir, "skills", "pdf-tools", "SKILL.md"))).toBe(true);
    expect(existsSync(join(pluginDir, "skills", "pdf-tools", "scripts", "extract.sh"))).toBe(true);
    // NOT at the root (they are not portable v1 components).
    expect(existsSync(join(pluginDir, "hooks"))).toBe(false);
    expect(existsSync(join(pluginDir, "commands"))).toBe(false);
    expect(existsSync(join(pluginDir, "agents"))).toBe(false);

    // VS Code documents com.github.copilot/hooks/hooks.json + agents/<n>.agent.md;
    // ${PLUGIN_ROOT} is expanded in hook commands, so hooks route via the launcher.
    const hooks = readJson(join(pluginDir, COPILOT_NS, "hooks", "hooks.json")) as unknown as HooksFile;
    expect(Object.keys(hooks.hooks).sort()).toEqual(["PreToolUse", "SessionStart"]);
    expect(hooks.hooks.PreToolUse![0]!.matcher).toBe("acme_query|acme_write");
    expect(hooks.hooks.PreToolUse![0]!.hooks[0]!.command).toBe(
      `node "${LAUNCHER_AT_ROOT}" hook copilot-cli PreToolUse --connector ${CONNECTOR_ID}`,
    );
    expect(existsSync(join(pluginDir, COPILOT_NS, "commands", "deploy.md"))).toBe(true);
    expect(existsSync(join(pluginDir, COPILOT_NS, "agents", "reviewer.agent.md"))).toBe(true);
    expect(existsSync(join(pluginDir, COPILOT_NS, "agents", "reviewer.md"))).toBe(false);

    const notes = res.notes ?? [];
    expect(notes.some((n) => n.includes(`${COPILOT_NS}/`) && n.includes(`${CODEX_NS}/`))).toBe(true);
    expect(notes.some((n) => n.includes(LAUNCHER))).toBe(true);
  });

  it("gives Codex its com.openai/ namespace: hooks only, in the SAME home-bin command form the native codex bundle carried", () => {
    const res = packageConnector(connector, { outDir, format: "agent-plugin", homeBinPath: HOME_BIN });
    const pluginDir = join(outDir, CONNECTOR_ID);
    const hooks = readJson(join(pluginDir, CODEX_NS, "hooks", "hooks.json")) as unknown as HooksFile;
    expect(Object.keys(hooks.hooks).sort()).toEqual(["PreToolUse", "SessionStart"]);
    expect(hooks.hooks.PreToolUse![0]!.hooks[0]!.command).toBe(hookCommand("codex", "PreToolUse"));
    // Codex reads no agents/commands from plugins → nothing else in its namespace.
    expect(existsSync(join(pluginDir, CODEX_NS, "commands"))).toBe(false);
    expect(existsSync(join(pluginDir, CODEX_NS, "agents"))).toBe(false);
    // The machine-local path is called out, never silent.
    expect((res.notes ?? []).some((n) => n.includes(`${CODEX_NS}/`) && n.includes(HOME_BIN))).toBe(true);
  });

  it("hostHint stamps --host on the MCP entry and restamps only the namespace that host reads", () => {
    // Codex staging: MCP carries --host codex; both namespaces keep their own host.
    const codexOut = join(outDir, "codex-staging");
    packageConnector(connector, { outDir: codexOut, format: "agent-plugin", homeBinPath: HOME_BIN, hostHint: "codex" });
    const codexMcp = readJson(join(codexOut, CONNECTOR_ID, "mcp.json")).mcpServers as Record<string, { args: string[] }>;
    expect(codexMcp[CONNECTOR_ID]!.args.slice(0, 7)).toEqual([
      LAUNCHER_AT_ROOT, "serve", "--connector", CONNECTOR_ID, "--host", "codex", "--",
    ]);
    const codexCopilotHooks = readJson(join(codexOut, CONNECTOR_ID, COPILOT_NS, "hooks", "hooks.json")) as unknown as HooksFile;
    expect(codexCopilotHooks.hooks.PreToolUse![0]!.hooks[0]!.command).toContain("hook copilot-cli PreToolUse");

    // VS Code Copilot staging: the copilot namespace restamps to that exact host;
    // Codex's namespace is untouched.
    const vscodeOut = join(outDir, "vscode-staging");
    packageConnector(connector, { outDir: vscodeOut, format: "agent-plugin", homeBinPath: HOME_BIN, hostHint: "vscode-copilot" });
    const vscodeMcp = readJson(join(vscodeOut, CONNECTOR_ID, "mcp.json")).mcpServers as Record<string, { args: string[] }>;
    expect(vscodeMcp[CONNECTOR_ID]!.args).toContain("vscode-copilot");
    const vscodeCopilotHooks = readJson(join(vscodeOut, CONNECTOR_ID, COPILOT_NS, "hooks", "hooks.json")) as unknown as HooksFile;
    expect(vscodeCopilotHooks.hooks.PreToolUse![0]!.hooks[0]!.command).toBe(
      `node "${LAUNCHER_AT_ROOT}" hook vscode-copilot PreToolUse --connector ${CONNECTOR_ID}`,
    );
    const vscodeCodexHooks = readJson(join(vscodeOut, CONNECTOR_ID, CODEX_NS, "hooks", "hooks.json")) as unknown as HooksFile;
    expect(vscodeCodexHooks.hooks.PreToolUse![0]!.hooks[0]!.command).toBe(hookCommand("codex", "PreToolUse"));
  });

  it("carries a REMOTE http server as streamable-http (url + headers), sse as sse, and drops ws with a note", () => {
    const http = defineConnector({
      id: "acme-remote",
      displayName: "Acme Remote",
      server: {
        transport: "http",
        url: "https://mcp.example.com/mcp",
        headers: { "X-Tenant": "public" },
      },
    });
    const res = packageConnector(http, { outDir, format: "agent-plugin", homeBinPath: HOME_BIN });
    const mcp = readJson(join(outDir, "acme-remote", "mcp.json"));
    const servers = mcp.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers["acme-remote"]).toEqual({
      type: "streamable-http",
      url: "https://mcp.example.com/mcp",
      headers: { "X-Tenant": "public" },
    });
    expect(res.notes ?? []).toEqual([]); // https + no auth → fully conformant, nothing to flag
    expect(existsSync(join(outDir, "acme-remote", LAUNCHER))).toBe(false); // nothing to launch

    const sse = defineConnector({
      id: "acme-sse",
      displayName: "Acme SSE",
      server: { transport: "sse", url: "http://localhost:8080/sse" },
    });
    packageConnector(sse, { outDir, format: "agent-plugin", homeBinPath: HOME_BIN });
    const sseMcp = readJson(join(outDir, "acme-sse", "mcp.json"));
    expect((sseMcp.mcpServers as Record<string, Record<string, unknown>>)["acme-sse"]).toEqual({
      type: "sse",
      url: "http://localhost:8080/sse",
    });

    const ws = defineConnector({
      id: "acme-ws",
      displayName: "Acme WS",
      server: { transport: "ws", url: "wss://mcp.example.com/ws" },
    });
    const wsRes = packageConnector(ws, { outDir, format: "agent-plugin", homeBinPath: HOME_BIN });
    expect(existsSync(join(outDir, "acme-ws", "mcp.json"))).toBe(false);
    expect((wsRes.notes ?? []).some((n) => n.includes('"ws"'))).toBe(true);
  });

  it("passes an UNWRAPPED stdio command straight through, keeps a ./-relative cwd, and drops a non-conformant cwd + reserved env keys with notes", () => {
    const direct = defineConnector({
      id: "acme-direct",
      displayName: "Acme Direct",
      server: {
        transport: "stdio",
        command: "node",
        args: ["./server.mjs"],
        cwd: "/abs/elsewhere",
        env: { PLUGIN_ROOT: "nope", KEEP: "yes" },
        wrapForTelemetry: false,
      },
    });
    const res = packageConnector(direct, { outDir, format: "agent-plugin", homeBinPath: HOME_BIN });
    const mcp = readJson(join(outDir, "acme-direct", "mcp.json"));
    const entry = (mcp.mcpServers as Record<string, Record<string, unknown>>)["acme-direct"];
    expect(entry).toEqual({ type: "stdio", command: "node", args: ["./server.mjs"], env: { KEEP: "yes" } });
    const notes = res.notes ?? [];
    expect(notes.some((n) => n.includes('dropped cwd "/abs/elsewhere"'))).toBe(true);
    expect(notes.some((n) => n.includes('dropped env "PLUGIN_ROOT"'))).toBe(true);
    // No wrap + no hooks → no launcher shipped, no launcher note.
    expect(existsSync(join(outDir, "acme-direct", LAUNCHER))).toBe(false);
    expect(notes.some((n) => n.includes(LAUNCHER))).toBe(false);

    const relative = defineConnector({
      id: "acme-rel",
      displayName: "Acme Rel",
      server: { transport: "stdio", command: "./bin/server", cwd: "${PLUGIN_ROOT}/work", wrapForTelemetry: false },
    });
    packageConnector(relative, { outDir, format: "agent-plugin", homeBinPath: HOME_BIN });
    const relEntry = (readJson(join(outDir, "acme-rel", "mcp.json")).mcpServers as Record<string, Record<string, unknown>>)["acme-rel"];
    expect(relEntry).toEqual({ type: "stdio", command: "./bin/server", cwd: "${PLUGIN_ROOT}/work" });
  });

  it("emits neither mcp.json, the launcher, nor any extension namespace for a content-only connector", () => {
    const contentOnly = defineConnector({
      id: "acme-skills",
      displayName: "Acme Skills",
      skills: [{ name: "only", description: "Only a skill.", body: "# Only" }],
    });
    const res = packageConnector(contentOnly, { outDir, format: "agent-plugin", homeBinPath: HOME_BIN });
    const pluginDir = join(outDir, "acme-skills");
    expect(existsSync(join(pluginDir, "plugin.json"))).toBe(true);
    expect(readJson(join(pluginDir, "plugin.json")).extensions).toBeUndefined();
    expect(existsSync(join(pluginDir, "skills", "only", "SKILL.md"))).toBe(true);
    expect(existsSync(join(pluginDir, "mcp.json"))).toBe(false);
    expect(existsSync(join(pluginDir, LAUNCHER))).toBe(false);
    expect(existsSync(join(pluginDir, COPILOT_NS))).toBe(false);
    expect(existsSync(join(pluginDir, CODEX_NS))).toBe(false);
    expect(res.notes ?? []).toEqual([]);
  });

  it("toAgentPluginName coerces ids into the spec slug (lowercase, no --/.., alphanumeric ends, <= 64)", async () => {
    const { toAgentPluginName } = await import("../../src/core/package-formats/agent-plugin.js");
    expect(toAgentPluginName("acme-connector")).toBe("acme-connector");
    expect(toAgentPluginName("Acme_DB Tools")).toBe("acme-db-tools");
    expect(toAgentPluginName("--weird..name--")).toBe("weird.name");
    expect(toAgentPluginName("!!!")).toBe("connector");
    expect(toAgentPluginName("a".repeat(70) + "-b")).toHaveLength(64);
    for (const s of ["acme-connector", "Acme_DB Tools", "--weird..name--", "a-.b", "x.-y"]) {
      expect(toAgentPluginName(s)).toMatch(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
    }
  });

  it("readAgentPluginManifest recognizes ONLY a root plugin.json carrying the AP $schema (the drivers' staged-bundle marker)", async () => {
    const { readAgentPluginManifest } = await import("../../src/core/package-formats/agent-plugin.js");
    packageConnector(connector, { outDir, format: "agent-plugin", homeBinPath: HOME_BIN });
    const parsed = readAgentPluginManifest(readFileSync(join(outDir, CONNECTOR_ID, "plugin.json"), "utf8"));
    expect(parsed?.name).toBe(CONNECTOR_ID);
    expect(parsed?.description).toContain("Acme Connector");
    // An agy-plugin root plugin.json (no AP $schema) is NOT an Agent Plugins manifest.
    expect(readAgentPluginManifest(JSON.stringify({ name: "x", version: "0.0.1" }))).toBeNull();
    expect(readAgentPluginManifest("not json")).toBeNull();
  });
});

/** Every regular file under `dir`, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// --format all + dispatch invariants
// ─────────────────────────────────────────────────────────────────────────

describe("packageConnectorAll — every feasible format", () => {
  it("emits each FEASIBLE format into <out>/<format>/ (the standard artifacts are opt-in, not in --format all)", () => {
    const results = packageConnectorAll(connector, { outDir, homeBinPath: HOME_BIN });
    const emitted = results.map((r) => r.format).sort();
    expect(emitted).toEqual([...FEASIBLE_FORMATS].sort());
    // FEASIBLE (--format all) is the host-bundle subset of ALL_FORMATS; the
    // official standard artifacts (mcp-server-json) require publish metadata and
    // are excluded, so ALL_FORMATS is strictly larger.
    expect(FEASIBLE_FORMATS.length).toBeLessThan(ALL_FORMATS.length);
    expect(emitted).not.toContain("mcp-server-json");
    expect(ALL_FORMATS).toContain("mcp-server-json");

    for (const { format, result } of results) {
      // Every bundle lands under its own <out>/<format>/ subdir.
      expect(result.pluginDir.startsWith(join(outDir, format))).toBe(true);
      expect(result.files.length).toBeGreaterThan(0);
      for (const f of result.files) expect(existsSync(f)).toBe(true);
    }
  });

  it("isPackageFormat accepts every supported format and rejects junk + 'all'", () => {
    for (const f of ALL_FORMATS) expect(isPackageFormat(f)).toBe(true);
    expect(isPackageFormat("all")).toBe(false);
    expect(isPackageFormat("vsix")).toBe(false);
  });
});

describe("dry-run — every format writes NOTHING", () => {
  it("plans the file list without touching disk, across all formats", () => {
    for (const format of ALL_FORMATS) {
      const sub = join(outDir, `dry-${format}`);
      const res = packageConnector(connector, { outDir: sub, format, homeBinPath: HOME_BIN, dryRun: true });
      expect(res.files.length).toBeGreaterThan(0);
      for (const f of res.files) expect(existsSync(f)).toBe(false);
      expect(existsSync(sub)).toBe(false);
    }
  });

  it("packageConnectorAll dry-run writes nothing either", () => {
    const results = packageConnectorAll(connector, { outDir, homeBinPath: HOME_BIN, dryRun: true });
    for (const { result } of results) {
      for (const f of result.files) expect(existsSync(f)).toBe(false);
    }
  });
});
