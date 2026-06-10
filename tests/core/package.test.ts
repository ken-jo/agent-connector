/**
 * core/package — `packageConnector` emits a marketplace-installable Claude Code
 * plugin bundle.
 *
 * Drives the real emitter against a connector declaring ALL FOUR surfaces
 * (server + hooks + commands + skills + subagents) into an isolated os.tmpdir
 * outDir, then asserts the spec-exact layout + manifest shapes:
 *   • <id>/.claude-plugin/plugin.json — required `name`, object `author` omitted
 *     intentionally, version omitted for an actively-developed connector.
 *   • .claude-plugin/marketplace.json — object `owner`, plugins[] with source ./<id>.
 *   • commands/<name>.md, agents/<name>.md, skills/<name>/SKILL.md (+ resource).
 *   • hooks/hooks.json — single-string home-bin command for MAPPED events only.
 *   • .mcp.json — serve-wrapper command with --host claude-code.
 *   • markdown matches the claude-code adapter byte-for-byte (command + skill).
 *   • dry-run writes NOTHING.
 *
 * Isolation: a fresh mkdtemp outDir per test; HOME + AGENT_CONNECTOR_DATA_DIR
 * redirected to temp and restored in afterEach.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { packageConnector } from "../../src/core/package.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import claudeAdapter from "../../src/adapters/claude-code/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-connector";

/** A connector declaring every surface: server + hooks + command + skill + subagent. */
function buildConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Connector",
    // version omitted → defaults "0.0.0" → treated as unset (git SHA drives updates).
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
  });
}

let savedHome: string | undefined;
let savedDataDir: string | undefined;
let outDir: string;
let connector: ResolvedConnector;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  outDir = mkdtempSync(join(tmpdir(), "ac-pkg-"));
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

describe("packageConnector — claude-plugin bundle", () => {
  it("emits a plugin.json with the required name + description, version omitted", () => {
    const res = packageConnector(connector, { outDir, homeBinPath: HOME_BIN });
    const manifestPath = join(res.pluginDir, ".claude-plugin", "plugin.json");
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = readJson(manifestPath);
    expect(manifest.name).toBe(CONNECTOR_ID); // required field
    expect(typeof manifest.description).toBe("string");
    // version OMITTED for an actively-developed connector (defaults to "0.0.0").
    expect(manifest.version).toBeUndefined();
  });

  it("plugin.json lives in .claude-plugin/ but component dirs are at the plugin ROOT", () => {
    const res = packageConnector(connector, { outDir, homeBinPath: HOME_BIN });
    // STRICT rule: only plugin.json under .claude-plugin/.
    const pluginClaudeDir = join(res.pluginDir, ".claude-plugin");
    expect(readdirSync(pluginClaudeDir)).toEqual(["plugin.json"]);
    // Components at plugin root, NOT under .claude-plugin/.
    expect(existsSync(join(res.pluginDir, "commands", "deploy.md"))).toBe(true);
    expect(existsSync(join(res.pluginDir, "agents", "reviewer.md"))).toBe(true);
    expect(existsSync(join(res.pluginDir, "skills", "pdf-tools", "SKILL.md"))).toBe(true);
    expect(existsSync(join(pluginClaudeDir, "commands"))).toBe(false);
  });

  it("emits a marketplace.json listing the plugin with source ./<id> and object owner", () => {
    const res = packageConnector(connector, { outDir, homeBinPath: HOME_BIN });
    expect(res.marketplacePath).toBe(join(outDir, ".claude-plugin", "marketplace.json"));
    expect(existsSync(res.marketplacePath)).toBe(true);

    const mkt = readJson(res.marketplacePath);
    expect(mkt.name).toBe("agent-connector");
    // owner is an OBJECT, not a string.
    expect(mkt.owner).toEqual({ name: "agent-connector" });
    const plugins = mkt.plugins as Array<Record<string, unknown>>;
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins[0]?.name).toBe(CONNECTOR_ID);
    expect(plugins[0]?.source).toBe(`./${CONNECTOR_ID}`);
  });

  it("emits command/agent/skill files with correct frontmatter + body", () => {
    const res = packageConnector(connector, { outDir, homeBinPath: HOME_BIN });

    const cmd = readFileSync(join(res.pluginDir, "commands", "deploy.md"), "utf8");
    expect(cmd).toContain("description: Deploy the app to an environment.");
    expect(cmd).toContain("argument-hint: \"[environment]\"");
    expect(cmd).toContain("allowed-tools: Bash, Read");
    expect(cmd).toContain("model: sonnet");
    expect(cmd).toContain("Deploy to $ARGUMENTS and report the result.");

    const skill = readFileSync(
      join(res.pluginDir, "skills", "pdf-tools", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("name: pdf-tools");
    expect(skill).toContain("model: haiku");
    expect(skill).toContain("# PDF Tools");
    // Bundled resource written verbatim, inside the skill dir.
    const resource = join(res.pluginDir, "skills", "pdf-tools", "scripts", "extract.sh");
    expect(readFileSync(resource, "utf8")).toBe("#!/bin/sh\necho extracting\n");

    const agent = readFileSync(join(res.pluginDir, "agents", "reviewer.md"), "utf8");
    expect(agent).toContain("name: reviewer");
    expect(agent).toContain("tools: Read, Grep");
    expect(agent).toContain("model: opus");
    expect(agent).toContain("You are a meticulous code reviewer.");
  });

  it("emitted command + skill markdown is BYTE-IDENTICAL to the claude-code adapter", () => {
    const res = packageConnector(connector, { outDir, homeBinPath: HOME_BIN });

    // Render via the adapter into a fresh isolated project dir and compare bytes.
    const adapterDir = mkdtempSync(join(tmpdir(), "ac-pkg-adapter-"));
    const ctx: InstallContext = {
      connector,
      scope: "project",
      projectDir: adapterDir,
      homeBinPath: HOME_BIN,
      dataRoot: adapterDir,
      dryRun: false,
    };
    claudeAdapter.installCommands!(ctx);
    claudeAdapter.installSkills!(ctx);

    const adapterCmd = readFileSync(
      join(adapterDir, ".claude", "commands", "deploy.md"),
      "utf8",
    );
    const pkgCmd = readFileSync(join(res.pluginDir, "commands", "deploy.md"), "utf8");
    expect(pkgCmd).toBe(adapterCmd);

    const adapterSkill = readFileSync(
      join(adapterDir, ".claude", "skills", "pdf-tools", "SKILL.md"),
      "utf8",
    );
    const pkgSkill = readFileSync(
      join(res.pluginDir, "skills", "pdf-tools", "SKILL.md"),
      "utf8",
    );
    expect(pkgSkill).toBe(adapterSkill);
  });

  it("emits hooks.json referencing the home-bin hook entrypoint for MAPPED events only", () => {
    const res = packageConnector(connector, { outDir, homeBinPath: HOME_BIN });
    const hooksPath = join(res.pluginDir, "hooks", "hooks.json");
    expect(existsSync(hooksPath)).toBe(true);

    const parsed = readJson(hooksPath) as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks: Array<{ command: string; args?: string[] }> }>
      >;
    };
    const events = Object.keys(parsed.hooks).sort();
    // Only the two declared (mapped) events — no extras.
    expect(events).toEqual(["PreToolUse", "SessionStart"]);

    const pre = parsed.hooks.PreToolUse![0]!;
    expect(pre.matcher).toBe("acme_query|acme_write");
    const entry = pre.hooks[0]!;
    // Claude Code hooks use a SINGLE command STRING (no separate args array) —
    // identical to what the claude-code adapter writes via buildHomeBinHookCommand.
    // The home-bin path is shell-quoted by buildHomeBinHookCommand.
    expect(entry.command).toBe(
      `"${HOME_BIN}" hook claude-code PreToolUse --connector ${CONNECTOR_ID}`,
    );
    expect(entry.args).toBeUndefined();

    // SessionStart has no matcher → omitted (not an empty string in the entry).
    const start = parsed.hooks.SessionStart![0]!;
    expect(start.matcher).toBeUndefined();
    expect(start.hooks[0]!.command).toBe(
      `"${HOME_BIN}" hook claude-code SessionStart --connector ${CONNECTOR_ID}`,
    );
  });

  it("emits .mcp.json with the serve-wrapper command (--host claude-code)", () => {
    const res = packageConnector(connector, { outDir, homeBinPath: HOME_BIN });
    const mcpPath = join(res.pluginDir, ".mcp.json");
    expect(existsSync(mcpPath)).toBe(true);

    const parsed = readJson(mcpPath) as {
      mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
    };
    const entry = parsed.mcpServers[CONNECTOR_ID]!;
    expect(entry.command).toBe(HOME_BIN);
    // serve-wrapper flags before `--`, then the real command/args after.
    expect(entry.args.slice(0, 6)).toEqual([
      "serve",
      "--connector",
      CONNECTOR_ID,
      "--host",
      "claude-code",
      "--",
    ]);
    expect(entry.args.slice(6)).toEqual(["npx", "-y", "@acme/db-mcp", "--flag"]);
    // env passed through.
    expect(entry.env).toEqual({ API_TOKEN: "${env:ACME_TOKEN}" });
  });

  it("dry-run writes NOTHING but still reports the planned file list", () => {
    const res = packageConnector(connector, { outDir, homeBinPath: HOME_BIN, dryRun: true });
    expect(res.files.length).toBeGreaterThan(0);
    for (const f of res.files) {
      expect(existsSync(f)).toBe(false);
    }
    // The outDir holds no plugin tree at all.
    expect(existsSync(join(outDir, CONNECTOR_ID))).toBe(false);
    expect(existsSync(res.marketplacePath)).toBe(false);
  });

  it("skips hooks.json + .mcp.json for a content-only connector", () => {
    const contentOnly = defineConnector({
      id: "content-only",
      commands: [{ name: "hello", prompt: "Say hi." }],
    });
    const res = packageConnector(contentOnly, { outDir, homeBinPath: HOME_BIN });
    expect(existsSync(join(res.pluginDir, "hooks", "hooks.json"))).toBe(false);
    expect(existsSync(join(res.pluginDir, ".mcp.json"))).toBe(false);
    // Still emits the manifest, the command, and the marketplace.
    expect(existsSync(join(res.pluginDir, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(res.pluginDir, "commands", "hello.md"))).toBe(true);
    expect(existsSync(res.marketplacePath)).toBe(true);
  });

  it("carries an explicit semver version into plugin.json when pinned", () => {
    const pinned = defineConnector({
      id: "pinned",
      version: "2.3.4",
      commands: [{ name: "hello", prompt: "Say hi." }],
    });
    const res = packageConnector(pinned, { outDir, homeBinPath: HOME_BIN });
    const manifest = readJson(join(res.pluginDir, ".claude-plugin", "plugin.json"));
    expect(manifest.version).toBe("2.3.4");
  });
});
