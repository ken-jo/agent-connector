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

import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import {
  ALL_FORMATS,
  FEASIBLE_FORMATS,
  isPackageFormat,
  packageConnector,
  packageConnectorAll,
} from "../../src/core/package.js";
import { readTomlString } from "../../src/core/toml.js";
import type { ResolvedConnector } from "../../src/core/types.js";

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
// codex-plugin — claude-plugin variant (.codex-plugin/ manifest dir)
// ─────────────────────────────────────────────────────────────────────────

describe("packageConnector — codex-plugin", () => {
  it("emits .codex-plugin/plugin.json (only file in the manifest dir) + root components", () => {
    const res = packageConnector(connector, { outDir, format: "codex-plugin", homeBinPath: HOME_BIN });
    const manifestDir = join(res.pluginDir, ".codex-plugin");
    expect(readdirSync(manifestDir)).toEqual(["plugin.json"]);
    const m = readJson(join(manifestDir, "plugin.json"));
    expect(m.name).toBe(CONNECTOR_ID);
    expect(m.version).toBeUndefined(); // unpinned → omitted (no requireVersion)
    // Components at the plugin ROOT.
    expect(existsSync(join(res.pluginDir, "commands", "deploy.md"))).toBe(true);
    expect(existsSync(join(res.pluginDir, "agents", "reviewer.md"))).toBe(true);
    expect(existsSync(join(res.pluginDir, "skills", "pdf-tools", "SKILL.md"))).toBe(true);
  });

  it("emits an .agents/plugins/marketplace.json catalog, hooks (--host codex), and serve-wrapped .mcp.json", () => {
    const res = packageConnector(connector, { outDir, format: "codex-plugin", homeBinPath: HOME_BIN });
    // codex's documented catalog location — `codex plugin marketplace add`
    // REJECTS a .codex-plugin/ catalog ("marketplace root does not contain a
    // supported manifest"; live-verified against codex-cli 0.139.0).
    expect(res.marketplacePath).toBe(join(outDir, ".agents", "plugins", "marketplace.json"));
    const mkt = readJson(res.marketplacePath!);
    expect(mkt.owner).toEqual({ name: "Acme Inc" }); // publish.author attributes the catalog to the dev

    const hooks = readJson(join(res.pluginDir, "hooks", "hooks.json")).hooks as Record<
      string,
      Array<{ matcher?: string; hooks: Array<{ command: string }> }>
    >;
    expect(Object.keys(hooks).sort()).toEqual(["PreToolUse", "SessionStart"]);
    expect(hooks.PreToolUse![0]!.hooks[0]!.command).toBe(hookCommand("codex", "PreToolUse"));

    const mcp = readJson(join(res.pluginDir, ".mcp.json")).mcpServers as Record<string, never>;
    expectServeWrapper(mcp[CONNECTOR_ID] as never, "codex");
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

    const hooks = readJson(join(res.pluginDir, "hooks", "hooks.json")).hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string }> }>
    >;
    expect(hooks.PreToolUse![0]!.hooks[0]!.command).toBe(hookCommand("cursor", "PreToolUse"));

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

    const index = readFileSync(join(res.pluginDir, "index.js"), "utf8");
    expect(index).toContain("export default async function");
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
