/**
 * core/memory-surface — the normalized `memory` content surface end-to-end:
 *
 *   • defineConnector validation/normalization (default name "memory",
 *     kebab-case, duplicates, non-empty content, 16 KiB hard cap, marker-token
 *     rejection, memory-only connectors valid);
 *   • per-host targets: claude-code → CLAUDE.md (block mode default, auto
 *     agents-import when the user wired the import, opt-in agents-import with
 *     the shared bridge block), codex → AGENTS.md (base AGENTS.md-first
 *     default, $CODEX_HOME user scope), gemini-cli → GEMINI.md default /
 *     AGENTS.md under the context.fileName opt-in (settings never edited);
 *   • multi-connector coexistence in one AGENTS.md, edit detection
 *     (warn-don't-clobber, --force overwrite), uninstall (prefix reclaim,
 *     created-file deletion, ledger-only synthetic uninstall, bridge
 *     refcount), and the skip-warn paths (unsupported scope, no user-scope
 *     file, memory disabled, mode on a non-claude host).
 *
 * Filesystem isolation: fresh mkdtemp project dir per test; HOME +
 * AGENT_CONNECTOR_DATA_DIR + CODEX_HOME redirected and restored.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConnectorConfigError, defineConnector } from "../../src/core/define-connector.js";
import { listManagedBlocks } from "../../src/core/managed-block.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { InstallScope, ResolvedConnector } from "../../src/core/types.js";

import claudeAdapter from "../../src/adapters/claude-code/index.js";
import codexAdapter from "../../src/adapters/codex/index.js";
import copilotCliAdapter from "../../src/adapters/copilot-cli/index.js";
import geminiAdapter from "../../src/adapters/gemini-cli/index.js";
import gooseAdapter from "../../src/adapters/goose/index.js";
import hermesAdapter from "../../src/adapters/hermes/index.js";
import kiloAdapter from "../../src/adapters/kilo/index.js";
import kiloCliAdapter from "../../src/adapters/kilo-cli/index.js";
import kiroAdapter from "../../src/adapters/kiro/index.js";
import openclawAdapter from "../../src/adapters/openclaw/index.js";
import opencodeAdapter from "../../src/adapters/opencode/index.js";
import qwenCodeAdapter from "../../src/adapters/qwen-code/index.js";
import rooCodeAdapter from "../../src/adapters/roo-code/index.js";
import warpAdapter from "../../src/adapters/warp/index.js";
import zedAdapter from "../../src/adapters/zed/index.js";
import type { Adapter } from "../../src/adapters/spi.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";

function buildConnector(
  id = "acme-db",
  content = "Always use the acme-db MCP tools for database work.",
  extra: Record<string, unknown> = {},
): ResolvedConnector {
  return defineConnector({ id, memory: [{ content }], ...extra });
}

function buildCtx(
  projectDir: string,
  connector: ResolvedConnector,
  scope: InstallScope = "project",
  overrides: Partial<InstallContext> = {},
): InstallContext {
  return {
    connector,
    scope,
    projectDir,
    homeBinPath: HOME_BIN,
    dataRoot: process.env.AGENT_CONNECTOR_DATA_DIR ?? projectDir,
    dryRun: false,
    ...overrides,
  };
}

let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedDataDir: string | undefined;
let savedCodexHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  savedCodexHome = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedUserProfile);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
  restore("CODEX_HOME", savedCodexHome);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-memory-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  return dir;
}

// ───────────────────────────────────────────────────────────────────────────
// defineConnector validation / normalization
// ───────────────────────────────────────────────────────────────────────────

describe("memory surface: defineConnector", () => {
  it("accepts a memory-only connector and defaults name to \"memory\"", () => {
    const c = defineConnector({ id: "mem-only", memory: [{ content: "Guidance." }] });
    expect(c.memory).toHaveLength(1);
    expect(c.memory[0]?.name).toBe("memory");
  });

  it("normalizes to [] when memory is omitted", () => {
    const c = defineConnector({ id: "no-mem", server: { transport: "stdio", command: "node" } });
    expect(c.memory).toEqual([]);
  });

  it("rejects a non-kebab name", () => {
    expect(() =>
      defineConnector({ id: "x", memory: [{ name: "Bad Name", content: "c" }] }),
    ).toThrow(ConnectorConfigError);
  });

  it("rejects duplicate names (incl. two defaulted entries)", () => {
    expect(() =>
      defineConnector({ id: "x", memory: [{ content: "a" }, { content: "b" }] }),
    ).toThrow(/duplicate name "memory"/);
  });

  it("rejects empty content", () => {
    expect(() => defineConnector({ id: "x", memory: [{ content: "" }] })).toThrow(
      /content must be a non-empty string/,
    );
  });

  it("rejects content above the 16 KiB hard cap", () => {
    expect(() =>
      defineConnector({ id: "x", memory: [{ content: "y".repeat(16 * 1024 + 1) }] }),
    ).toThrow(/hard cap/);
  });

  it("rejects content containing the literal marker tokens", () => {
    for (const token of ["agent-connector:begin", "agent-connector:end"]) {
      expect(() =>
        defineConnector({ id: "x", memory: [{ content: `mentions ${token} here` }] }),
      ).toThrow(/marker token/);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// codex — the base AGENTS.md-first default
// ───────────────────────────────────────────────────────────────────────────

describe("memory surface: codex (base AGENTS.md default)", () => {
  it("project scope writes the managed block into <projectDir>/AGENTS.md", () => {
    const dir = freshProject();
    const connector = buildConnector();
    const changes = codexAdapter.installMemory!(buildCtx(dir, connector));
    const agentsMd = join(dir, "AGENTS.md");
    expect(changes.some((c) => c.action === "create" && c.path === agentsMd)).toBe(true);
    const raw = readFileSync(agentsMd, "utf8");
    expect(raw).toContain("agent-connector:begin acme-db/memory");
    expect(raw).toContain("Always use the acme-db MCP tools");
  });

  it("user scope targets $CODEX_HOME/AGENTS.md", () => {
    const dir = freshProject();
    process.env.CODEX_HOME = join(dir, "codex-home");
    const connector = buildConnector();
    const changes = codexAdapter.installMemory!(buildCtx(dir, connector, "user"));
    const agentsMd = join(dir, "codex-home", "AGENTS.md");
    expect(changes.some((c) => c.path === agentsMd && c.action === "create")).toBe(true);
    expect(existsSync(agentsMd)).toBe(true);
  });

  it("second install is a pure skip (no mtime churn)", () => {
    const dir = freshProject();
    const connector = buildConnector();
    codexAdapter.installMemory!(buildCtx(dir, connector));
    const before = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const changes = codexAdapter.installMemory!(buildCtx(dir, connector));
    expect(changes.filter((c) => c.path === join(dir, "AGENTS.md"))[0]?.action).toBe("skip");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(before);
  });

  it("memory.mode on a non-claude host is ignored with a warn", () => {
    const dir = freshProject();
    const connector = buildConnector("acme-db", "Guidance.", {
      platforms: { codex: { memory: { mode: "agents-import" } } },
    });
    const changes = codexAdapter.installMemory!(buildCtx(dir, connector));
    expect(changes.some((c) => c.action === "warn" && c.detail.includes("claude-code-only"))).toBe(
      true,
    );
    // The block still lands in AGENTS.md (mode is ignored, not fatal).
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
  });

  it("platforms.<id>.memory === false disables the surface with a skip", () => {
    const dir = freshProject();
    const connector = buildConnector("acme-db", "Guidance.", {
      platforms: { codex: { memory: false } },
    });
    const changes = codexAdapter.installMemory!(buildCtx(dir, connector));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("memory disabled");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("unsupported scope (system) reports the skip-warn, writes nothing", () => {
    const dir = freshProject();
    const changes = codexAdapter.installMemory!(buildCtx(dir, buildConnector(), "system"));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("system scope");
  });

  it("memory.path override redirects the write target", () => {
    const dir = freshProject();
    const connector = buildConnector("acme-db", "Guidance.", {
      platforms: { codex: { memory: { path: join("docs", "AGENTS.md") } } },
    });
    codexAdapter.installMemory!(buildCtx(dir, connector));
    expect(existsSync(join(dir, "docs", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("oversized (soft-budget) content installs WITH a warn", () => {
    const dir = freshProject();
    const connector = buildConnector("acme-db", `# Big\n${"x".repeat(5000)}`);
    const changes = codexAdapter.installMemory!(buildCtx(dir, connector));
    expect(changes.some((c) => c.action === "create")).toBe(true);
    expect(changes.some((c) => c.action === "warn" && c.detail.includes("soft budget"))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// warp — user scope has no documented user-scope file → skip-warn
// ───────────────────────────────────────────────────────────────────────────

describe("memory surface: hosts without a user-scope memory file", () => {
  it("warp user scope reports the standard skip-warn", () => {
    const dir = freshProject();
    const changes = warpAdapter.installMemory!(buildCtx(dir, buildConnector(), "user"));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("no user-scope memory file on warp");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// claude-code — CLAUDE.md block mode + AGENTS.md interop
// ───────────────────────────────────────────────────────────────────────────

describe("memory surface: claude-code", () => {
  it("default block mode targets <projectDir>/CLAUDE.md and leaves AGENTS.md alone", () => {
    const dir = freshProject();
    const changes = claudeAdapter.installMemory!(buildCtx(dir, buildConnector()));
    const claudeMd = join(dir, "CLAUDE.md");
    expect(changes.some((c) => c.action === "create" && c.path === claudeMd)).toBe(true);
    expect(readFileSync(claudeMd, "utf8")).toContain("agent-connector:begin acme-db/memory");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("user scope targets ~/.claude/CLAUDE.md", () => {
    const dir = freshProject();
    const changes = claudeAdapter.installMemory!(buildCtx(dir, buildConnector(), "user"));
    const claudeMd = join(dir, ".claude", "CLAUDE.md");
    expect(changes.some((c) => c.path === claudeMd && c.action === "create")).toBe(true);
    expect(existsSync(claudeMd)).toBe(true);
  });

  it("AUTO interop: a user-authored @AGENTS.md import routes the block to AGENTS.md and never touches CLAUDE.md", () => {
    const dir = freshProject();
    const claudeMd = join(dir, "CLAUDE.md");
    const userBytes = "# Mine\n\n@AGENTS.md\n\nClaude-specific line.\n";
    writeFileSync(claudeMd, userBytes, "utf8");
    const changes = claudeAdapter.installMemory!(buildCtx(dir, buildConnector()));
    expect(readFileSync(claudeMd, "utf8")).toBe(userBytes); // byte-identical
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain(
      "agent-connector:begin acme-db/memory",
    );
    expect(
      changes.some(
        (c) => c.action === "skip" && c.detail.includes("already imports AGENTS.md"),
      ),
    ).toBe(true);
  });

  it("an @AGENTS.md mention inside a code fence does NOT trigger auto interop", () => {
    const dir = freshProject();
    const claudeMd = join(dir, "CLAUDE.md");
    writeFileSync(claudeMd, "# Mine\n\n```\n@AGENTS.md\n```\n", "utf8");
    claudeAdapter.installMemory!(buildCtx(dir, buildConnector()));
    expect(readFileSync(claudeMd, "utf8")).toContain("agent-connector:begin acme-db/memory");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("agents-import mode writes the canonical block to AGENTS.md + the shared bridge to CLAUDE.md", () => {
    const dir = freshProject();
    const connector = buildConnector("acme-db", "Guidance.", {
      platforms: { "claude-code": { memory: { mode: "agents-import" } } },
    });
    claudeAdapter.installMemory!(buildCtx(dir, connector));
    const agentsRaw = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const claudeRaw = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(agentsRaw).toContain("agent-connector:begin acme-db/memory");
    expect(claudeRaw).toContain("agent-connector:begin _shared/claude-agents-import");
    expect(claudeRaw).toContain("@AGENTS.md");
    // Idempotent: a second run only skips.
    const again = claudeAdapter.installMemory!(buildCtx(dir, connector));
    expect(again.every((c) => c.action === "skip")).toBe(true);
  });

  it("bridge refcount: uninstalling B keeps the bridge while A remains, last uninstall removes it", () => {
    const dir = freshProject();
    const mk = (id: string) =>
      buildConnector(id, `${id} guidance.`, {
        platforms: { "claude-code": { memory: { mode: "agents-import" } } },
      });
    const a = mk("conn-a"); // installs FIRST → creates both files (deletion rights)
    const b = mk("conn-b");
    claudeAdapter.installMemory!(buildCtx(dir, a));
    claudeAdapter.installMemory!(buildCtx(dir, b));
    const claudeMd = join(dir, "CLAUDE.md");
    const agentsMd = join(dir, "AGENTS.md");
    expect(listManagedBlocks(readFileSync(agentsMd, "utf8"))).toHaveLength(2);

    const unB = claudeAdapter.uninstallMemory!(buildCtx(dir, b));
    expect(readFileSync(claudeMd, "utf8")).toContain("_shared/claude-agents-import");
    expect(
      unB.some((c) => c.action === "skip" && c.detail.includes("bridge retained")),
    ).toBe(true);
    const agentsAfterB = readFileSync(agentsMd, "utf8");
    expect(agentsAfterB).not.toContain("conn-b/");
    expect(agentsAfterB).toContain("conn-a/");

    claudeAdapter.uninstallMemory!(buildCtx(dir, a));
    // conn-a created both files; whitespace-only leftovers are deleted.
    expect(existsSync(agentsMd)).toBe(false);
    expect(existsSync(claudeMd)).toBe(false);
  });

  it("safe-side failure: when the creator uninstalls first, later uninstalls leave trimmed files in place", () => {
    const dir = freshProject();
    const mk = (id: string) =>
      buildConnector(id, `${id} guidance.`, {
        platforms: { "claude-code": { memory: { mode: "agents-import" } } },
      });
    const a = mk("conn-a");
    const b = mk("conn-b");
    claudeAdapter.installMemory!(buildCtx(dir, a));
    claudeAdapter.installMemory!(buildCtx(dir, b));
    claudeAdapter.uninstallMemory!(buildCtx(dir, a)); // creator leaves; rights leave with it
    claudeAdapter.uninstallMemory!(buildCtx(dir, b));
    // No connector that CREATED the files remains → whitespace-only files are
    // trimmed but never deleted (design risk #9: safe-side failure).
    const agentsMd = join(dir, "AGENTS.md");
    const claudeMd = join(dir, "CLAUDE.md");
    expect(existsSync(agentsMd)).toBe(true);
    expect(readFileSync(agentsMd, "utf8").trim()).toBe("");
    expect(readFileSync(claudeMd, "utf8")).not.toContain("agent-connector:begin");
  });

  it("never claims a pre-existing user import: uninstall leaves it untouched", () => {
    const dir = freshProject();
    const claudeMd = join(dir, "CLAUDE.md");
    const userBytes = "# Mine\n\n@AGENTS.md\n";
    writeFileSync(claudeMd, userBytes, "utf8");
    const connector = buildConnector();
    claudeAdapter.installMemory!(buildCtx(dir, connector));
    claudeAdapter.uninstallMemory!(buildCtx(dir, connector));
    expect(readFileSync(claudeMd, "utf8")).toBe(userBytes);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// gemini-cli — GEMINI.md default / AGENTS.md opt-in probe
// ───────────────────────────────────────────────────────────────────────────

describe("memory surface: gemini-cli", () => {
  it("defaults to <projectDir>/GEMINI.md", () => {
    const dir = freshProject();
    const changes = geminiAdapter.installMemory!(buildCtx(dir, buildConnector()));
    expect(changes.some((c) => c.path === join(dir, "GEMINI.md") && c.action === "create")).toBe(
      true,
    );
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("user scope defaults to ~/.gemini/GEMINI.md", () => {
    const dir = freshProject();
    const changes = geminiAdapter.installMemory!(buildCtx(dir, buildConnector(), "user"));
    expect(
      changes.some((c) => c.path === join(dir, ".gemini", "GEMINI.md") && c.action === "create"),
    ).toBe(true);
  });

  it("targets AGENTS.md when context.fileName opts in — and never edits settings.json", () => {
    const dir = freshProject();
    const settingsDir = join(dir, ".gemini");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    const settingsBytes = JSON.stringify(
      { context: { fileName: ["AGENTS.md", "GEMINI.md"] } },
      null,
      2,
    );
    writeFileSync(settingsPath, settingsBytes, "utf8");
    geminiAdapter.installMemory!(buildCtx(dir, buildConnector()));
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(dir, "GEMINI.md"))).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toBe(settingsBytes); // probe-and-respect
  });

  it("string-form context.fileName works too", () => {
    const dir = freshProject();
    mkdirSync(join(dir, ".gemini"), { recursive: true });
    writeFileSync(
      join(dir, ".gemini", "settings.json"),
      JSON.stringify({ context: { fileName: "AGENTS.md" } }),
      "utf8",
    );
    geminiAdapter.installMemory!(buildCtx(dir, buildConnector()));
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Coexistence, drift, uninstall
// ───────────────────────────────────────────────────────────────────────────

describe("memory surface: coexistence + drift + uninstall", () => {
  it("two connectors coexist in one AGENTS.md; uninstalling A leaves B and user bytes intact", () => {
    const dir = freshProject();
    const agentsMd = join(dir, "AGENTS.md");
    writeFileSync(agentsMd, "# Team rules\nKeep functions small.\n", "utf8");
    const a = buildConnector("conn-a", "A guidance.");
    const b = buildConnector("conn-b", "B guidance.");
    codexAdapter.installMemory!(buildCtx(dir, a));
    codexAdapter.installMemory!(buildCtx(dir, b));
    const withBoth = readFileSync(agentsMd, "utf8");
    expect(listManagedBlocks(withBoth).map((x) => x.blockId).sort()).toEqual([
      "conn-a/memory",
      "conn-b/memory",
    ]);

    codexAdapter.uninstallMemory!(buildCtx(dir, a));
    const afterA = readFileSync(agentsMd, "utf8");
    expect(afterA.startsWith("# Team rules\nKeep functions small.\n")).toBe(true);
    expect(afterA).toContain("conn-b/memory");
    expect(afterA).not.toContain("conn-a/");
  });

  it("drift: user edit inside the block → warn on sync, content preserved; --force overwrites with backup", () => {
    const dir = freshProject();
    const agentsMd = join(dir, "AGENTS.md");
    const connector = buildConnector();
    codexAdapter.installMemory!(buildCtx(dir, connector));
    const edited = readFileSync(agentsMd, "utf8").replace(
      "Always use the acme-db MCP tools",
      "MY OWN EDIT",
    );
    writeFileSync(agentsMd, edited, "utf8");

    const warned = codexAdapter.installMemory!(buildCtx(dir, connector));
    expect(warned.some((c) => c.action === "warn" && c.detail.includes("edited inside"))).toBe(
      true,
    );
    expect(readFileSync(agentsMd, "utf8")).toContain("MY OWN EDIT");

    const forced = codexAdapter.installMemory!(buildCtx(dir, connector, "project", { force: true }));
    expect(forced.some((c) => c.action === "update")).toBe(true);
    expect(forced.some((c) => c.detail.includes("backed up memory file"))).toBe(true);
    expect(readFileSync(agentsMd, "utf8")).not.toContain("MY OWN EDIT");
  });

  it("uninstall deletes the file only when agent-connector created it", () => {
    const dir = freshProject();
    const connector = buildConnector();
    codexAdapter.installMemory!(buildCtx(dir, connector)); // creates AGENTS.md
    codexAdapter.uninstallMemory!(buildCtx(dir, connector));
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    // Re-running the uninstall is pure skips (idempotent).
    const again = codexAdapter.uninstallMemory!(buildCtx(dir, connector));
    expect(again.every((c) => c.action === "skip")).toBe(true);
  });

  it("ledger-only uninstall: a synthetic (memory-less) connector still reclaims blocks", () => {
    const dir = freshProject();
    const connector = buildConnector();
    codexAdapter.installMemory!(buildCtx(dir, connector));
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    // Simulate `loadConnectorForUninstall` falling back to the id-only shape.
    const synthetic: ResolvedConnector = { ...connector, memory: [] };
    const changes = codexAdapter.uninstallMemory!(buildCtx(dir, synthetic));
    expect(changes.some((c) => c.action === "remove")).toBe(true);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("teammate machine (no ledger): the marker scan alone still uninstalls", () => {
    const dir = freshProject();
    const connector = buildConnector();
    const agentsMd = join(dir, "AGENTS.md");
    writeFileSync(agentsMd, "# theirs\n", "utf8");
    codexAdapter.installMemory!(buildCtx(dir, connector));
    // Blow away the framework state — only the committed file remains.
    process.env.AGENT_CONNECTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "ac-empty-data-"));
    codexAdapter.uninstallMemory!(buildCtx(dir, connector));
    expect(readFileSync(agentsMd, "utf8")).toBe("# theirs\n");
  });

  it("dry-run computes the plan but writes nothing", () => {
    const dir = freshProject();
    const connector = buildConnector();
    const changes = codexAdapter.installMemory!(
      buildCtx(dir, connector, "project", { dryRun: true }),
    );
    expect(changes.some((c) => c.action === "create")).toBe(true);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("doctor reports intact / drifted / missing memory blocks", () => {
    const dir = freshProject();
    const connector = buildConnector();
    const ctx = buildCtx(dir, connector);
    codexAdapter.installMemory!(ctx);
    const pass = codexAdapter
      .doctor(ctx)
      .filter((d) => d.check.includes("memory block acme-db/memory"));
    expect(pass[0]?.status).toBe("pass");

    const agentsMd = join(dir, "AGENTS.md");
    writeFileSync(
      agentsMd,
      readFileSync(agentsMd, "utf8").replace("acme-db MCP tools", "EDITED"),
      "utf8",
    );
    const drift = codexAdapter
      .doctor(ctx)
      .filter((d) => d.check.includes("memory block acme-db/memory"));
    expect(drift[0]?.status).toBe("warn");
    expect(drift[0]?.message).toContain("user-edited");

    writeFileSync(agentsMd, "# wiped\n", "utf8");
    const missing = codexAdapter
      .doctor(ctx)
      .filter((d) => d.check.includes("memory block acme-db/memory"));
    expect(missing[0]?.status).toBe("warn");
    expect(missing[0]?.message).toContain("not found");
  });

  it("doctor flags a shadow flip: WARP.md appearing after the AGENTS.md install", () => {
    const dir = freshProject();
    const connector = buildConnector();
    const ctx = buildCtx(dir, connector);
    warpAdapter.installMemory!(ctx); // lands in AGENTS.md (no WARP.md yet)
    writeFileSync(join(dir, "WARP.md"), "# warp takes over\n", "utf8");
    const flagged = warpAdapter
      .doctor(ctx)
      .filter((d) => d.check.includes("memory block acme-db/memory"));
    expect(flagged.some((d) => d.status === "warn" && d.message.includes("WARP.md"))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Multiple entries per connector
// ───────────────────────────────────────────────────────────────────────────

describe("memory surface: multiple entries", () => {
  it("each entry becomes an independently-managed block; prefix uninstall reclaims all", () => {
    const dir = freshProject();
    const connector = defineConnector({
      id: "multi",
      memory: [
        { name: "usage", content: "How to use the tools." },
        { name: "style", content: "How to write queries." },
      ],
    });
    codexAdapter.installMemory!(buildCtx(dir, connector));
    const raw = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(listManagedBlocks(raw).map((b) => b.blockId).sort()).toEqual([
      "multi/style",
      "multi/usage",
    ]);
    codexAdapter.uninstallMemory!(buildCtx(dir, connector));
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Exclusive / first-match readers — the shadow probes (AGENTS.md-first policy
// rule 2: target the file the host will ACTUALLY read; create AGENTS.md only
// when nothing shadows it)
// ───────────────────────────────────────────────────────────────────────────

describe("memory surface: shadow probes", () => {
  it("codex: AGENTS.override.md shadows AGENTS.md at project scope", () => {
    const dir = freshProject();
    const overrideMd = join(dir, "AGENTS.override.md");
    writeFileSync(overrideMd, "# my override\n", "utf8");
    const changes = codexAdapter.installMemory!(buildCtx(dir, buildConnector()));
    expect(changes.some((c) => c.path === overrideMd && c.action === "create")).toBe(true);
    expect(readFileSync(overrideMd, "utf8")).toContain("agent-connector:begin acme-db/memory");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("codex: $CODEX_HOME/AGENTS.override.md shadows the user-scope AGENTS.md", () => {
    const dir = freshProject();
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    process.env.CODEX_HOME = codexHome;
    const overrideMd = join(codexHome, "AGENTS.override.md");
    writeFileSync(overrideMd, "# global override\n", "utf8");
    const changes = codexAdapter.installMemory!(buildCtx(dir, buildConnector(), "user"));
    expect(changes.some((c) => c.path === overrideMd)).toBe(true);
    expect(readFileSync(overrideMd, "utf8")).toContain("agent-connector:begin acme-db/memory");
    expect(existsSync(join(codexHome, "AGENTS.md"))).toBe(false);
  });

  it("warp: an existing WARP.md wins over AGENTS.md; absent → AGENTS.md created", async () => {
    const dir = freshProject();
    const warpMd = join(dir, "WARP.md");
    writeFileSync(warpMd, "# warp rules\n", "utf8");
    warpAdapter.installMemory!(buildCtx(dir, buildConnector()));
    expect(readFileSync(warpMd, "utf8")).toContain("agent-connector:begin acme-db/memory");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);

    const dir2 = freshProject();
    warpAdapter.installMemory!(buildCtx(dir2, buildConnector()));
    expect(existsSync(join(dir2, "AGENTS.md"))).toBe(true);
  });

  it("opencode: existing CLAUDE.md fallback is honored (creating AGENTS.md would shadow it)", () => {
    const dir = freshProject();
    const claudeMd = join(dir, "CLAUDE.md");
    writeFileSync(claudeMd, "# user rules\n", "utf8");
    opencodeAdapter.installMemory!(buildCtx(dir, buildConnector()));
    expect(readFileSync(claudeMd, "utf8")).toContain("agent-connector:begin acme-db/memory");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);

    // AGENTS.md beats the CLAUDE.md fallback when both exist…
    const dir2 = freshProject();
    writeFileSync(join(dir2, "CLAUDE.md"), "# user rules\n", "utf8");
    writeFileSync(join(dir2, "AGENTS.md"), "# agents\n", "utf8");
    opencodeAdapter.installMemory!(buildCtx(dir2, buildConnector()));
    expect(readFileSync(join(dir2, "AGENTS.md"), "utf8")).toContain("agent-connector:begin");
    expect(readFileSync(join(dir2, "CLAUDE.md"), "utf8")).not.toContain("agent-connector:begin");

    // …and is created when neither file exists.
    const dir3 = freshProject();
    opencodeAdapter.installMemory!(buildCtx(dir3, buildConnector()));
    expect(existsSync(join(dir3, "AGENTS.md"))).toBe(true);
  });

  it("zed: first-match rules file (.cursorrules) shadows AGENTS.md; none → AGENTS.md created", () => {
    const dir = freshProject();
    const cursorrules = join(dir, ".cursorrules");
    writeFileSync(cursorrules, "# cursor rules\n", "utf8");
    const changes = zedAdapter.installMemory!(buildCtx(dir, buildConnector()));
    expect(changes.some((c) => c.path === cursorrules)).toBe(true);
    expect(readFileSync(cursorrules, "utf8")).toContain("agent-connector:begin acme-db/memory");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);

    const dir2 = freshProject();
    zedAdapter.installMemory!(buildCtx(dir2, buildConnector()));
    expect(existsSync(join(dir2, "AGENTS.md"))).toBe(true);
  });

  it("hermes: .hermes.md shadows AGENTS.md (first context category wins)", () => {
    const dir = freshProject();
    const hermesMd = join(dir, ".hermes.md");
    writeFileSync(hermesMd, "# hermes context\n", "utf8");
    hermesAdapter.installMemory!(buildCtx(dir, buildConnector()));
    expect(readFileSync(hermesMd, "utf8")).toContain("agent-connector:begin acme-db/memory");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("openclaw: BOTH scopes map to the agent-workspace AGENTS.md, never the repo", () => {
    const dir = freshProject();
    const workspaceAgents = join(dir, ".openclaw", "workspace", "AGENTS.md");
    for (const scope of ["project", "user"] as const) {
      const changes = openclawAdapter.installMemory!(buildCtx(dir, buildConnector(), scope));
      expect(changes.some((c) => c.path === workspaceAgents)).toBe(true);
    }
    expect(existsSync(workspaceAgents)).toBe(true);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Documented non-AGENTS.md user-scope targets (per-host research matrix)
// ───────────────────────────────────────────────────────────────────────────

describe("memory surface: user-scope host-file targets", () => {
  const rows: Array<[string, Adapter, string[]]> = [
    ["kilo", kiloAdapter, [".kilocode", "rules", "agent-connector.md"]],
    ["kilo-cli", kiloCliAdapter, [".kilocode", "rules", "agent-connector.md"]],
    ["roo-code", rooCodeAdapter, [".roo", "rules", "agent-connector.md"]],
    ["kiro", kiroAdapter, [".kiro", "steering", "agent-connector.md"]],
    ["copilot-cli", copilotCliAdapter, [".copilot", "copilot-instructions.md"]],
    ["qwen-code", qwenCodeAdapter, [".qwen", "QWEN.md"]],
    ["goose", gooseAdapter, [".config", "goose", ".goosehints"]],
  ];
  for (const [id, adapter, segments] of rows) {
    it(`${id} user scope targets ~/${segments.join("/")}`, () => {
      const dir = freshProject();
      const target = join(dir, ...segments);
      const changes = adapter.installMemory!(buildCtx(dir, buildConnector(), "user"));
      expect(changes.some((c) => c.path === target)).toBe(true);
      expect(readFileSync(target, "utf8")).toContain("agent-connector:begin acme-db/memory");
    });
  }
});
