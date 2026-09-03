/**
 * tests/cli/render-install-result — the friendly install/uninstall/upgrade
 * output (the DEFAULT, no --verbose flag exists).
 *
 * renderInstallResult collapses the raw per-(host,surface) ChangeRecord diff
 * into a grouped, human report: a connector header (id/version/server/hooks/
 * telemetry + one line per shipped content surface), ONE line per host (a net
 * glyph + a derived surface summary + deduped ~/… paths + any inline warning),
 * and a friendly closing line with restart + doctor/uninstall next steps.
 *
 * These are pure-render assertions over constructed InstallResults (the renderer
 * has no side effects), plus a buildConnectorSummary check that the header digest
 * is derived correctly from a real resolved connector. The structured
 * ChangeRecord[] contract is unchanged and is covered by the adapter suites; the
 * machine (--json) contract does not flow through this renderer.
 */

import { homedir } from "node:os";

import { describe, expect, it } from "vitest";

import { defineConnector } from "../../src/index.js";
import { buildConnectorSummary, renderInstallResult } from "../../src/cli/app.js";
import type {
  ChangeRecord,
  ConnectorSummary,
  InstallResult,
} from "../../src/core/types.js";

/** A full server+hooks connector summary fixture. */
function fullSummary(over: Partial<ConnectorSummary> = {}): ConnectorSummary {
  return {
    id: "acme-db",
    version: "1.0.0",
    displayName: "Acme DB Tools",
    server: { transport: "stdio", command: "node acme-db-mcp-server.mjs" },
    hookEvents: ["SessionStart", "PreToolUse"],
    telemetryEnabled: true,
    commands: 0,
    skills: 0,
    subagents: 0,
    memory: 0,
    hasStatusline: false,
    actions: 0,
    ...over,
  };
}

function result(over: Partial<InstallResult> = {}): InstallResult {
  return {
    connectorId: "acme-db",
    dryRun: false,
    changes: [],
    warnings: [],
    connector: fullSummary(),
    ...over,
  };
}

/** Two created surfaces on one host (MCP + 2 hooks), like a real claude install. */
function fullHostChanges(platform: ChangeRecord["platform"]): ChangeRecord[] {
  return [
    { platform, action: "create", detail: "mcpServers.acme-db", path: "/home/u/.claude.json" },
    { platform, action: "create", detail: "hooks.SessionStart", path: "/home/u/.claude/settings.json" },
    { platform, action: "create", detail: "hooks.PreToolUse", path: "/home/u/.claude/settings.json" },
  ];
}

describe("renderInstallResult — connector header", () => {
  it("reflects server transport+command, hook events, and telemetry on", () => {
    const out = renderInstallResult(result(), "install");
    expect(out).toContain("acme-db  v1.0.0  ·  Acme DB Tools");
    expect(out).toContain("server      stdio · node acme-db-mcp-server.mjs");
    expect(out).toContain("hooks       SessionStart, PreToolUse");
    expect(out).toContain("telemetry   on");
  });

  it("renders (hooks-only) when the connector ships no server", () => {
    const out = renderInstallResult(
      result({ connector: fullSummary({ server: undefined }) }),
      "install",
    );
    expect(out).toContain("server      (hooks-only)");
  });

  it("renders telemetry off and omits a hooks line when there are no events", () => {
    const out = renderInstallResult(
      result({ connector: fullSummary({ telemetryEnabled: false, hookEvents: [] }) }),
      "install",
    );
    expect(out).toContain("telemetry   off");
    expect(out).not.toContain("hooks       ");
  });

  it("emits a surface line ONLY for surfaces the connector actually ships", () => {
    const out = renderInstallResult(
      result({
        connector: fullSummary({
          commands: 2,
          skills: 1,
          memory: 3,
          hasStatusline: true,
          // subagents/actions left at 0 → omitted
        }),
      }),
      "install",
    );
    expect(out).toContain("commands    2");
    expect(out).toContain("skills      1");
    expect(out).toContain("memory      3");
    expect(out).toContain("statusline  1");
    expect(out).not.toContain("subagents");
    expect(out).not.toContain("actions");
  });
});

describe("renderInstallResult — per-host grouping", () => {
  it("collapses one host's records to a single line with the surface summary + ✓", () => {
    const out = renderInstallResult(
      result({ changes: fullHostChanges("claude-code") }),
      "install",
    );
    const hostLine = out.split("\n").find((l) => l.includes("claude-code"));
    expect(hostLine).toBeDefined();
    expect(hostLine).toContain("✓");
    expect(hostLine).toContain("MCP server + 2 hooks");
    // Exactly one host line for claude-code (collapsed, not 3).
    expect(out.split("\n").filter((l) => l.trimStart().startsWith("✓ claude-code"))).toHaveLength(1);
  });

  it("dedupes + HOME-relativizes the touched paths", () => {
    // settings.json appears on two hook records → must show once, ~/-relative.
    // Use os.homedir() (NOT process.env.HOME, unset on Windows) so the fixture
    // matches the home dir tildify() resolves on every platform.
    const home = homedir();
    const changes: ChangeRecord[] = [
      { platform: "claude-code", action: "create", detail: "mcpServers.acme-db", path: `${home}/.claude.json` },
      { platform: "claude-code", action: "create", detail: "hooks.SessionStart", path: `${home}/.claude/settings.json` },
      { platform: "claude-code", action: "create", detail: "hooks.PreToolUse", path: `${home}/.claude/settings.json` },
    ];
    const out = renderInstallResult(result({ changes }), "install");
    const hostLine = out.split("\n").find((l) => l.includes("claude-code"))!;
    expect(hostLine).toContain("~/.claude.json");
    expect(hostLine).toContain("~/.claude/settings.json");
    // settings.json relativized + deduped → exactly one occurrence on the line.
    expect(hostLine.match(/settings\.json/g)).toHaveLength(1);
  });

  it("tildifies a BACKSLASH-separated path to forward-slash ~/… (cross-platform)", () => {
    // A Windows-style absolute path (home + `\.codex\config.toml`) must still
    // relativize to a forward-slash `~/.codex/config.toml`, regardless of the
    // host's native separator — pins the cross-platform tildify behavior.
    const home = homedir();
    const winPath = home.replace(/\//g, "\\") + "\\.codex\\config.toml";
    const changes: ChangeRecord[] = [
      { platform: "codex", action: "create", detail: "mcp_servers.acme-db", path: winPath },
    ];
    const out = renderInstallResult(result({ changes }), "install");
    const hostLine = out.split("\n").find((l) => l.includes("codex"))!;
    expect(hostLine).toContain("~/.codex/config.toml");
    expect(hostLine).not.toContain("\\.codex");
    expect(hostLine).not.toContain("~\\");
  });

  it("derives a `+ 1 command` summary from a content-file path", () => {
    const changes: ChangeRecord[] = [
      { platform: "claude-code", action: "create", detail: "mcpServers.acme-db", path: "/home/u/.claude.json" },
      { platform: "claude-code", action: "create", detail: "acme-schema.md", path: "/home/u/.claude/commands/acme-schema.md" },
    ];
    const out = renderInstallResult(result({ changes }), "install");
    const hostLine = out.split("\n").find((l) => l.includes("claude-code"))!;
    expect(hostLine).toContain("MCP server + 1 command");
  });

  it("shows = (skip glyph) with the reason when every record skipped", () => {
    const changes: ChangeRecord[] = [
      { platform: "codex", action: "skip", detail: "mcp_servers.acme-db", path: "/home/u/.codex/config.toml" },
    ];
    const out = renderInstallResult(result({ changes }), "install");
    const hostLine = out.split("\n").find((l) => l.includes("codex"))!;
    expect(hostLine).toContain("=");
    expect(hostLine).toContain("unchanged");
  });

  it("shows ! (warn glyph) with the warning inline under the host + multiple hosts grouped", () => {
    const changes: ChangeRecord[] = [
      ...fullHostChanges("claude-code"),
      { platform: "codex", action: "create", detail: "mcp_servers.acme-db", path: "/home/u/.codex/config.toml" },
      { platform: "codex", action: "warn", detail: "SOME_SECRET is unset — baking an empty value" },
    ];
    const out = renderInstallResult(result({ changes }), "install");
    const lines = out.split("\n");
    // Two distinct host lines.
    expect(lines.some((l) => l.includes("✓ claude-code"))).toBe(true);
    const codexLine = lines.find((l) => l.trimStart().startsWith("! codex"));
    expect(codexLine).toBeDefined();
    // The warning text is on its own inline line beneath the host.
    expect(out).toContain("! SOME_SECRET is unset — baking an empty value");
  });
});

describe("renderInstallResult — closing summary + next steps", () => {
  it("install: friendly written line + restart hint + doctor/uninstall hints", () => {
    const out = renderInstallResult(
      result({ changes: fullHostChanges("claude-code") }),
      "install",
    );
    expect(out).toContain("✓ Installed acme-db to 1 host · 3 files. Restart each host to load it.");
    expect(out).toContain("Verify: agent-connector doctor");
    expect(out).toContain("Remove: agent-connector uninstall");
  });

  it("install dry-run: 'would install' + 'nothing written', no restart hint", () => {
    const out = renderInstallResult(
      result({ dryRun: true, changes: fullHostChanges("claude-code") }),
      "install",
    );
    expect(out).toContain("Would install acme-db to 1 host · 3 files (dry-run — nothing written).");
    expect(out).not.toContain("Restart each host");
  });

  it("upgrade: its own verb wording ('Synced'/'synced to')", () => {
    const out = renderInstallResult(
      result({ changes: fullHostChanges("claude-code") }),
      "upgrade",
    );
    expect(out).toContain("synced to");
    expect(out).toContain("✓ Synced acme-db to 1 host");
  });

  it("uninstall: removal wording + 'zero residue' when clean + a doctor hint", () => {
    const changes: ChangeRecord[] = [
      { platform: "claude-code", action: "remove", detail: "mcpServers.acme-db", path: "/home/u/.claude.json" },
      { platform: "claude-code", action: "remove", detail: "hooks.PreToolUse", path: "/home/u/.claude/settings.json" },
    ];
    const out = renderInstallResult(
      result({ changes }),
      "uninstall",
    );
    expect(out).toContain("✓ Removed acme-db from 1 host · 2 files cleaned (zero residue).");
    expect(out).toContain("Verify it's gone: agent-connector doctor");
  });

  it("uninstall: 'nothing to remove' + zero residue when nothing was installed", () => {
    const changes: ChangeRecord[] = [
      { platform: "codex", action: "skip", detail: "config.toml absent", path: "/home/u/.codex/config.toml" },
    ];
    const out = renderInstallResult(result({ changes }), "uninstall");
    expect(out).toContain("✓ Nothing to remove — acme-db was not installed (zero residue).");
  });

  it("renders (no changes) cleanly when there are zero change records", () => {
    const out = renderInstallResult(result({ changes: [] }), "install");
    expect(out).toContain("(no changes)");
    // The header still renders.
    expect(out).toContain("acme-db  v1.0.0");
  });
});

describe("renderInstallResult — warnings still surfaced (exit-code intent)", () => {
  it("keeps a top-level warnings block listing every warning", () => {
    const out = renderInstallResult(
      result({
        changes: fullHostChanges("claude-code"),
        warnings: ["one bad thing", "another bad thing"],
      }),
      "install",
    );
    expect(out).toContain("warnings:");
    expect(out).toContain("! one bad thing");
    expect(out).toContain("! another bad thing");
  });

  it("de-dups a warning shown inline on a host and in result.warnings (shown ONCE)", () => {
    // A remote-transport connector pushes the SAME string to both a warn
    // ChangeRecord (inline on the host) and result.warnings (bottom block).
    const dup = "acme-remote: http transport is stdio-only on claude-code";
    const changes: ChangeRecord[] = [
      { platform: "claude-code", action: "create", detail: "mcpServers.acme-remote", path: "/home/u/.claude.json" },
      { platform: "claude-code", action: "warn", detail: dup },
    ];
    const out = renderInstallResult(
      result({ changes, warnings: [dup] }),
      "install",
    );
    // Exactly one occurrence of the warning string across the whole output.
    expect(out.split(dup).length - 1).toBe(1);
    // It survives inline on the host (the warn ChangeRecord is still rendered).
    const inlineLine = out.split("\n").find((l) => l.trimStart() === `! ${dup}`);
    expect(inlineLine).toBeDefined();
    // The bottom "warnings:" block is suppressed for this already-inline entry.
    expect(out).not.toContain("warnings:");
  });

  it("still shows a result.warnings entry that is NOT also inline on a host", () => {
    const inlineW = "inline only warning";
    const blockOnly = "fleet-wide block-only warning";
    const changes: ChangeRecord[] = [
      { platform: "codex", action: "create", detail: "mcp_servers.acme-db", path: "/home/u/.codex/config.toml" },
      { platform: "codex", action: "warn", detail: inlineW },
    ];
    const out = renderInstallResult(
      result({ changes, warnings: [inlineW, blockOnly] }),
      "install",
    );
    // inlineW shown once (inline), blockOnly shown once (bottom block).
    expect(out.split(inlineW).length - 1).toBe(1);
    expect(out).toContain("warnings:");
    expect(out).toContain(`! ${blockOnly}`);
  });
});

describe("renderInstallResult — backup is incidental, not an installed surface", () => {
  // A safety backup record the installer writes before a destructive change.
  const backup = (platform: ChangeRecord["platform"]): ChangeRecord => ({
    platform,
    action: "create",
    detail: "backed up settings before install",
    path: "/home/u/.agent-connector/backups/codex-2026-config.toml",
  });

  it("an idempotent re-install whose ONLY write is a backup reads 'already current' (0 files)", () => {
    // Real surfaces all SKIP (already present); the only written record is the
    // incidental backup → the host must NOT flip to ✓ and the closing line must
    // be the 'already current — nothing to write' branch.
    const changes: ChangeRecord[] = [
      { platform: "codex", action: "skip", detail: "mcp_servers.acme-db", path: "/home/u/.codex/config.toml" },
      { platform: "codex", action: "skip", detail: "hooks.PreToolUse", path: "/home/u/.codex/hooks.json" },
      backup("codex"),
    ];
    const out = renderInstallResult(result({ changes }), "install");
    const hostLine = out.split("\n").find((l) => l.includes("codex"))!;
    // Host is NOT flipped to a changed (✓) state by the backup alone.
    expect(hostLine).toContain("=");
    expect(hostLine).not.toContain("✓");
    expect(hostLine).not.toContain("1 backup");
    // Closing line: already current, not "Installed … N files".
    expect(out).toContain("already current");
    expect(out).not.toContain("✓ Installed acme-db");
  });

  it("does NOT count a backup toward the headline file tally", () => {
    // One real MCP write + one backup → tally must be 1 file, not 2.
    const changes: ChangeRecord[] = [
      { platform: "codex", action: "create", detail: "mcp_servers.acme-db", path: "/home/u/.codex/config.toml" },
      backup("codex"),
    ];
    const out = renderInstallResult(result({ changes }), "install");
    expect(out).toContain("✓ Installed acme-db to 1 host · 1 file. Restart each host to load it.");
    expect(out).not.toContain("· 2 files");
  });

  it("shows the backup alongside a real change (de-emphasized, only when real change exists)", () => {
    const changes: ChangeRecord[] = [
      { platform: "codex", action: "create", detail: "mcp_servers.acme-db", path: "/home/u/.codex/config.toml" },
      backup("codex"),
    ];
    const out = renderInstallResult(result({ changes }), "install");
    const hostLine = out.split("\n").find((l) => l.includes("codex"))!;
    expect(hostLine).toContain("✓");
    expect(hostLine).toContain("MCP server + 1 backup");
  });
});

describe("buildConnectorSummary", () => {
  it("derives id/version/server/hooks/telemetry/surface-counts from a resolved connector", () => {
    const connector = defineConnector({
      id: "acme-db",
      displayName: "Acme DB Tools",
      version: "2.3.4",
      server: { transport: "stdio", command: "node", args: ["server.mjs"] },
      hooks: {
        PreToolUse: { handler: () => ({ decision: "allow" }) },
        SessionStart: { handler: () => ({ decision: "context", additionalContext: "x" }) },
      },
      commands: [{ name: "demo", description: "d", prompt: "p" }],
    });
    const s = buildConnectorSummary(connector);
    expect(s.id).toBe("acme-db");
    expect(s.version).toBe("2.3.4");
    expect(s.displayName).toBe("Acme DB Tools");
    expect(s.server).toEqual({ transport: "stdio", command: "node server.mjs" });
    expect(s.hookEvents).toEqual(expect.arrayContaining(["SessionStart", "PreToolUse"]));
    expect(s.telemetryEnabled).toBe(true);
    expect(s.commands).toBe(1);
    expect(s.skills).toBe(0);
    expect(s.hasStatusline).toBe(false);
  });

  it("omits server for a hooks-only connector", () => {
    const connector = defineConnector({
      id: "guard-only",
      version: "1.0.0",
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    });
    const s = buildConnectorSummary(connector);
    expect(s.server).toBeUndefined();
  });
});
