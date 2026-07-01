/**
 * adapters/antigravity-cli.test.ts — the ONE per-host file for the Antigravity
 * CLI (`agy`, id "antigravity-cli") adapter.
 *
 * antigravity-cli is a thin FORK of the Antigravity IDE adapter (it extends
 * AntigravityAdapter, overriding only id / name / detectInstalled and the
 * userConfigCandidates that resolve the MCP user-config root). It is a
 * `json-stdio` host and REUSES every render / hook / parse / surface path from
 * the IDE adapter unchanged — so this file pins ONLY what is distinct to the CLI:
 *
 *   • identity   → id "antigravity-cli", a fork of AntigravityAdapter.
 *   • MCP user-config → LIVE-PROVEN (agy v1.0.5): resolves to ~/.gemini/config/
 *                  (its candidate[0]), NOT the IDE's ~/.gemini/antigravity/;
 *                  prefer-existing still honors a legacy IDE antigravity/ file.
 *   • runtime    → parseEvent stamps hostPlatform = antigravity-cli (so a
 *                  CLI-installed hook dispatches back to THIS adapter).
 *   • surfaces   → project scope is IDENTICAL to the IDE (inherited): writes the
 *                  same Workflows/.md + SKILL.md; the global skills dir is the
 *                  SHARED IDE resolution (the CLI has no separate dir).
 *   • E1 degrade → INHERITS the IDE capability surface (all four E1 flags falsy)
 *                  and warn-skips the four E1 events under its OWN platform id.
 *
 * The IDE adapter's own assertions (and the genuinely-both fresh-default compare)
 * live in adapters/antigravity.test.ts. Migrated to the shared harness
 * (tests/support/env + adapter-suite + fs) per tests/README.md — ONE file per host.
 * The E1 inherit/warn-skip slice was absorbed from extended-events-degrade.test.ts.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { buildHomeBinStatuslineCommand } from "../../src/core/spawn.js";
import { loadConfigPatchLedger } from "../../src/core/config-patch-ledger.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  PreToolUseEvent,
  ResolvedConnector,
  StatuslineDef,
} from "../../src/core/types.js";

import antigravityAdapter, {
  AntigravityAdapter,
} from "../../src/adapters/antigravity/index.js";
import antigravityCliAdapter, {
  AntigravityCliAdapter,
} from "../../src/adapters/antigravity-cli/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson } from "../support/fs.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";

/** A connector with a stdio server + all four supported hooks + an unsupported one. */
function stdioConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/db-mcp"],
      env: { [ENV_VAR]: `\${env:${ENV_VAR}}` },
      tools: { include: ["*"] },
    },
    hooks: {
      PreToolUse: { matcher: "acme_query", handler: () => ({ decision: "allow" }) },
      PostToolUse: { handler: () => ({ decision: "allow" }) },
      SessionStart: { handler: () => ({ decision: "context", additionalContext: "hi" }) },
      Stop: { handler: () => ({ decision: "allow" }) },
      // UserPromptSubmit has no Antigravity equivalent → must warn-skip.
      UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
    },
  });
}

/** A connector declaring a command (Workflow) + a skill (with a resource) + a subagent. */
function surfaceConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Surfaces",
    version: "1.0.0",
    commands: [
      { name: "acme-report", description: "Generate a report", prompt: "Do the report." },
    ],
    skills: [
      {
        name: "acme-skill",
        description: "Acme helper skill for testing.",
        body: "# Acme\nUse the tools.",
        resources: { "scripts/run.sh": "echo hi\n" },
      },
    ],
    subagents: [
      { name: "acme-agent", description: "Acme agent.", prompt: "You are Acme." },
    ],
  });
}

/** statusline: a connector whose only payload is a status line. */
function statuslineConnector(id: string, def: StatuslineDef): ResolvedConnector {
  return defineConnector({ id, statusline: def });
}

// ── E1 extension-event fixtures (absorbed from extended-events-degrade) ──────────

const E1_EVENTS = [
  "PermissionRequest",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
] as const;

/** PreToolUse (universally wired here) + ALL FOUR E1 extension events. */
function e1Connector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    hooks: {
      PreToolUse: {
        matcher: "acme_query",
        handler() {
          return { decision: "allow" };
        },
      },
      PermissionRequest: {
        matcher: "acme_query",
        handler() {
          return { decision: "ask" };
        },
      },
      PostToolUseFailure: {
        handler() {
          return { decision: "context", additionalContext: "retry hint" };
        },
      },
      SubagentStart: {
        matcher: "code-reviewer",
        handler() {
          return { decision: "context", additionalContext: "subagent ctx" };
        },
      },
      SubagentStop: {
        matcher: "code-reviewer",
        handler() {
          return { decision: "deny", reason: "keep going" };
        },
      },
    },
  });
}

// Shared env isolation (default keys + the env-ref var the install slice mutates) +
// the same-rules-for-every-host baseline contract.
isolateEnv([ENV_VAR]);
createAdapterSuite({ adapter: antigravityCliAdapter, paradigm: "json-stdio" });

// ─────────────────────────────────────────────────────────────────────────
// 1. MCP user-config — config/ (live-proven) NOT the IDE's antigravity/
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity-cli MCP user-config resolution", () => {
  it("USER-scope MCP resolves to ~/.gemini/config/ (agy v1.0.5 live-proven), NOT the IDE's antigravity/", () => {
    const home = freshProject("ac-antigcli-userorder-");
    process.env[ENV_VAR] = ENV_LITERAL;
    const ctx = buildCtx(home, stdioConnector(), "user");

    // LIVE-PROVEN (2026-06-04): the standalone `agy` CLI reads user MCP from
    // ~/.gemini/config/mcp_config.json, NOT the IDE's ~/.gemini/antigravity/.
    // A fresh CLI install therefore resolves to config/ (its candidate[0]).
    const cliCanonical = join(home, ".gemini", "config", "mcp_config.json");
    const ideDefault = join(home, ".gemini", "antigravity", "mcp_config.json");
    expect(antigravityCliAdapter.getServerConfigPath(ctx)).toBe(cliCanonical);

    // Installing the CLI connector writes to the config/ path agy actually reads.
    antigravityCliAdapter.installServer(ctx);
    expect(existsSync(cliCanonical)).toBe(true);
    expect(existsSync(ideDefault)).toBe(false);
  });

  it("prefer-existing: an existing IDE antigravity/ file is still honored", () => {
    const home = freshProject("ac-antigcli-prefer-ide-");
    const ctx = buildCtx(home, stdioConnector(), "user");
    const idePath = join(home, ".gemini", "antigravity", "mcp_config.json");
    mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true });
    writeFileSync(idePath, "{}\n");
    // config/ absent but antigravity/ present → prefer-existing honors the legacy file.
    expect(antigravityCliAdapter.getServerConfigPath(ctx)).toBe(idePath);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Runtime parse — stamps hostPlatform = antigravity-cli
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity-cli runtime parse", () => {
  it("parseEvent stamps hostPlatform = antigravity-cli AND inherits the nested IDE shape (toolCall.*, conversationId, workspacePaths)", () => {
    // The CLI adapter inherits the IDE's parseEvent unchanged, so it reads the
    // same SOURCE-VERIFIED nested Antigravity stdin shape; only hostPlatform
    // differs (so a CLI-dispatched event routes back to THIS adapter).
    const ev = antigravityCliAdapter.parseEvent("PreToolUse", {
      connector: CONNECTOR_ID,
      conversationId: "c1",
      workspacePaths: ["/p"],
      toolCall: { name: "run_command", args: { CommandLine: "ls" } },
    }) as PreToolUseEvent;
    expect(ev.hostPlatform).toBe("antigravity-cli");
    expect(ev.sessionId).toBe("c1");
    expect(ev.projectDir).toBe("/p");
    expect(ev.toolName).toBe("run_command");
    expect(ev.toolInput).toEqual({ CommandLine: "ls" });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Content surfaces — project scope IDENTICAL to the IDE (inherited)
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity-cli content surfaces (inherited from the IDE)", () => {
  it("writes the same Workflows .md + SKILL.md (project scope identical to IDE)", () => {
    const home = freshProject("ac-antigcli-surf-");
    const ctx = buildCtx(home, surfaceConnector(), "project");
    antigravityCliAdapter.installCommands(ctx);
    antigravityCliAdapter.installSkills(ctx);
    expect(existsSync(join(home, ".agent", "workflows", "acme-report.md"))).toBe(true);
    expect(existsSync(join(home, ".agents", "skills", "acme-skill", "SKILL.md"))).toBe(true);
  });

  it("global skills dir is the SHARED IDE resolution (CLI has no separate dir)", () => {
    // CONFIRMED: `agy` shares the IDE tree, so the CLI inherits the IDE skills
    // resolution (prefer existing antigravity-cli/skills, else ~/.gemini/skills).
    const home = freshProject("ac-antigcli-probe-skills-");
    const ctx = buildCtx(home, surfaceConnector(), "user");

    // Fresh → default canonical CLI skills dir (same as the IDE adapter).
    antigravityCliAdapter.installSkills(ctx);
    expect(
      existsSync(join(home, ".gemini", "antigravity-cli", "skills", "acme-skill", "SKILL.md")),
    ).toBe(true);

    // With ~/.gemini/skills pre-existing (and no CLI dir), it is preferred —
    // identical to the IDE adapter's behavior.
    const home2 = freshProject("ac-antigcli-probe-skills2-");
    mkdirSync(join(home2, ".gemini", "skills"), { recursive: true });
    const ctx2 = buildCtx(home2, surfaceConnector(), "user");
    antigravityCliAdapter.installSkills(ctx2);
    expect(existsSync(join(home2, ".gemini", "skills", "acme-skill", "SKILL.md"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. E1 extension-event DEGRADATION — INHERITS the IDE surface, own platform id
// (Absorbed from the former extended-events-degrade.test.ts.)
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity-cli E1 extension-event degradation", () => {
  it("INHERITS the IDE adapter's capability surface except the TWO CLI divergences", () => {
    // The CLI fork diverges from the IDE adapter in the CLI-only statusline
    // capability plus one hook capability:
    //   • supportsStatusline (the `agy` custom status line, CLI-only ADD), and
    //     its command-stdin mode marker, and
    //   • sessionStart: false (the `agy` CLI does NOT recognize a SessionStart
    //     hook — live-verified; the IDE app keeps sessionStart: true).
    // Assert the surfaces are otherwise structurally identical by overlaying just
    // those two flags.
    expect(antigravityCliAdapter.capabilities).toStrictEqual({
      ...antigravityAdapter.capabilities,
      supportsStatusline: true,
      statuslineMode: "command-stdin",
      sessionStart: false,
    });
    // statusline is a CLI-only ADD; sessionStart is a CLI-only DROP.
    expect(antigravityCliAdapter.capabilities.supportsStatusline).toBe(true);
    expect(antigravityCliAdapter.capabilities.statuslineMode).toBe("command-stdin");
    expect(antigravityAdapter.capabilities.supportsStatusline ?? false).toBe(false);
    expect(antigravityCliAdapter.capabilities.sessionStart ?? false).toBe(false);
    expect(antigravityAdapter.capabilities.sessionStart).toBe(true);
    expect(antigravityCliAdapter.capabilities.permissionRequest ?? false).toBe(false);
    expect(antigravityCliAdapter.capabilities.postToolUseFailure ?? false).toBe(false);
    expect(antigravityCliAdapter.capabilities.subagentStart ?? false).toBe(false);
    expect(antigravityCliAdapter.capabilities.subagentStop ?? false).toBe(false);
  });

  it("inherits the same E1 warn-skips under its OWN platform id", () => {
    const projectDir = freshProject("ac-e1-agy-");
    const ctx = buildCtx(projectDir, e1Connector());

    const changes = antigravityCliAdapter.installHooks!(ctx);
    const warns = changes.filter((c) => c.action === "warn");
    for (const event of E1_EVENTS) {
      const warn = warns.find((c) => c.detail?.startsWith(`${event} `));
      expect(warn, `expected a warn-skip record for ${event}`).toBeTruthy();
      expect(warn!.platform).toBe("antigravity-cli");
      expect(warn!.detail).toBe(`${event} has no Antigravity hook equivalent — skipped`);
    }
    expect(warns).toHaveLength(E1_EVENTS.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4b. SessionStart is DROPPED on the CLI (agy does NOT recognize it) while the
//     other agy-supported events (PreToolUse/PostToolUse/Stop) still install.
//     LIVE-VERIFIED: agy's hook events are exactly PreToolUse/PostToolUse/
//     PreInvocation/PostInvocation/Stop — a SessionStart hook would otherwise be
//     written inert (never loads / never fires / never shows in `/hooks`).
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity-cli SessionStart drop (agy CLI does not recognize SessionStart)", () => {
  it("warn-skips SessionStart but still installs PreToolUse/PostToolUse/Stop", () => {
    const projectDir = freshProject("ac-agy-nosess-");
    // stdioConnector declares PreToolUse + PostToolUse + SessionStart + Stop
    // (+ an unsupported UserPromptSubmit). On the agy CLI, SessionStart must
    // warn-skip and NEVER be written into hooks.json.
    const ctx = buildCtx(projectDir, stdioConnector(), "project");

    const changes = antigravityCliAdapter.installHooks!(ctx);

    // SessionStart is surfaced as a visible warn-skip under the CLI's id —
    // never a silent inert write.
    const sessionWarn = changes.find((c) => c.detail?.startsWith("SessionStart "));
    expect(sessionWarn, "expected a warn-skip record for SessionStart").toBeTruthy();
    expect(sessionWarn!.action).toBe("warn");
    expect(sessionWarn!.platform).toBe("antigravity-cli");
    // It is NEVER wired as a create/update.
    const sessionWired = changes.filter(
      (c) =>
        (c.action === "create" || c.action === "update") &&
        c.detail?.includes("SessionStart"),
    );
    expect(sessionWired).toHaveLength(0);

    // The agy-supported events ARE wired (create), in canonical order.
    for (const event of ["PreToolUse", "PostToolUse", "Stop"] as const) {
      const wired = changes.find((c) => c.action === "create" && c.detail === `hooks.${event}`);
      expect(wired, `expected ${event} to be wired`).toBeTruthy();
      expect(wired!.platform).toBe("antigravity-cli");
    }

    // And the written hooks.json carries the three supported events but NOT
    // SessionStart (the inert-entry bug class).
    const hooksFile = readJson(join(projectDir, ".agents", "hooks.json"));
    expect(Object.keys(hooksFile.hooks).sort()).toEqual(
      ["PostToolUse", "PreToolUse", "Stop"].sort(),
    );
    expect(hooksFile.hooks.SessionStart).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Identity / wiring sanity
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity-cli adapter identity + paradigm", () => {
  let ctx: InstallContext;

  beforeEach(() => {
    const home = freshProject("ac-antigcli-ident-");
    ctx = buildCtx(home, stdioConnector(), "user");
  });

  it("has the antigravity-cli identity but is a fork of the IDE adapter", () => {
    expect(antigravityCliAdapter).toBeInstanceOf(AntigravityCliAdapter);
    // The CLI is a fork of the IDE adapter.
    expect(antigravityCliAdapter).toBeInstanceOf(AntigravityAdapter);
    expect(antigravityCliAdapter.id).toBe("antigravity-cli");
    expect(antigravityCliAdapter.paradigm).toBe("json-stdio");
    // Same paradigm as the IDE adapter it forks.
    expect(antigravityCliAdapter.paradigm).toBe(antigravityAdapter.paradigm);
    // Sanity: the CLI resolves a user config path (exercises the ctx fixture).
    expect(antigravityCliAdapter.getServerConfigPath(ctx)).toContain("mcp_config.json");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Statusline surface — the `agy` custom status line (CLI-only, live-verified)
//    settings.json top-level `statusLine` { enabled, command } via the ownership
//    ledger; the IDE adapter has NO statusline (its payload is unverified).
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity-cli adapter — statusline", () => {
  let home: string;
  let dataRoot: string;

  beforeEach(() => {
    home = freshProject("ac-agysl-");
    dataRoot = join(home, ".agent-connector-sl");
  });

  /** statusline ctx with an isolated data root for the ledger. */
  function slCtx(connector: ResolvedConnector): InstallContext {
    return buildCtx(home, connector, { scope: "user", dataRoot });
  }

  /** agy's GLOBAL statusLine settings.json (HOME-based, scope-independent). */
  function settingsPath(): string {
    return join(home, ".gemini", "antigravity-cli", "settings.json");
  }

  function readSettings(): Record<string, any> {
    return readJson(settingsPath());
  }

  function writeSettings(data: unknown): void {
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(settingsPath(), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  it("advertises supportsStatusline === true (CLI-only — the IDE app does not)", () => {
    expect(antigravityCliAdapter.capabilities.supportsStatusline).toBe(true);
    expect(antigravityCliAdapter.capabilities.statuslineMode).toBe("command-stdin");
    expect(antigravityAdapter.capabilities.supportsStatusline ?? false).toBe(false);
  });

  it("installs the ownership-tracked statusLine { enabled, command } (ledger row, prior absent)", () => {
    const connector = statuslineConnector("sl-install", { render: () => "x" });
    const changes = antigravityCliAdapter.installStatusline!(slCtx(connector));
    expect(changes.some((c) => c.action === "create")).toBe(true);

    // Top-level `statusLine` with agy's { enabled, command } shape + OUR home-bin command.
    const settings = readSettings();
    expect(settings.statusLine).toEqual({
      enabled: true,
      command: buildHomeBinStatuslineCommand(HOME_BIN, "antigravity-cli", "sl-install"),
    });

    // The ledger has a refcounted ownership row keyed on the top-level leaf.
    const ledger = loadConfigPatchLedger(dataRoot);
    const entry = ledger.entries.find(
      (e) => e.platform === "antigravity-cli" && e.key === "statusLine",
    );
    expect(entry).toBeTruthy();
    expect(entry!.prior).toEqual({ present: false });
    expect(entry!.owners.map((o) => o.connectorId)).toContain("sl-install");
  });

  it("creates the settings.json when absent (set-if-absent)", () => {
    const connector = statuslineConnector("sl-mkdir", { render: () => "x" });
    antigravityCliAdapter.installStatusline!(slCtx(connector));
    const settings = readSettings();
    expect(settings.statusLine.enabled).toBe(true);
    expect(typeof settings.statusLine.command).toBe("string");
  });

  it("preserves sibling user keys at top level", () => {
    writeSettings({ colorScheme: "dark", notifications: true });
    const connector = statuslineConnector("sl-merge", { render: () => "x" });
    antigravityCliAdapter.installStatusline!(slCtx(connector));
    const settings = readSettings();
    expect(settings.colorScheme).toBe("dark");
    expect(settings.notifications).toBe(true);
    expect(settings.statusLine.enabled).toBe(true);
  });

  it("is idempotent on re-install (skip, no duplicate)", () => {
    const connector = statuslineConnector("sl-idem", { render: () => "x" });
    antigravityCliAdapter.installStatusline!(slCtx(connector));
    const second = antigravityCliAdapter.installStatusline!(slCtx(connector));
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall reverses (removes the key + drops the ledger row)", () => {
    const connector = statuslineConnector("sl-uninstall", { render: () => "x" });
    antigravityCliAdapter.installStatusline!(slCtx(connector));
    expect(readSettings().statusLine).toBeTruthy();

    const changes = antigravityCliAdapter.uninstallStatusline!(slCtx(connector));
    expect(changes.some((c) => c.action === "remove")).toBe(true);
    expect(readSettings().statusLine).toBeUndefined();

    const ledger = loadConfigPatchLedger(dataRoot);
    expect(ledger.entries.find((e) => e.key === "statusLine")).toBeUndefined();
  });

  it("NEVER clobbers a pre-existing non-AC statusLine (skip-warn)", () => {
    writeSettings({ statusLine: { enabled: true, command: "my-own.sh" } });
    const connector = statuslineConnector("sl-conflict", { render: () => "x" });
    const changes = antigravityCliAdapter.installStatusline!(slCtx(connector));

    expect(changes.some((c) => c.action === "warn")).toBe(true);
    // The user's statusLine is untouched.
    expect(readSettings().statusLine).toEqual({ enabled: true, command: "my-own.sh" });
    // No ownership was taken on a key we did not create.
    const ledger = loadConfigPatchLedger(dataRoot);
    expect(ledger.entries.find((e) => e.key === "statusLine")).toBeUndefined();
  });

  it("uninstall never deletes a non-AC statusLine (no ownership recorded → skip)", () => {
    writeSettings({ statusLine: { enabled: true, command: "my-own.sh" } });
    const connector = statuslineConnector("sl-conflict2", { render: () => "x" });
    antigravityCliAdapter.installStatusline!(slCtx(connector)); // skip-warn (not ours)
    const changes = antigravityCliAdapter.uninstallStatusline!(slCtx(connector));
    expect(changes.every((c) => c.action === "skip")).toBe(true);
    expect(readSettings().statusLine).toEqual({ enabled: true, command: "my-own.sh" });
  });

  it("per-platform statusline:false skips the install entirely", () => {
    const connector = defineConnector({
      id: "sl-disabled",
      statusline: { render: () => "x" },
      platforms: { "antigravity-cli": { statusline: false } },
    });
    const changes = antigravityCliAdapter.installStatusline!(slCtx(connector));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("skips silently when no statusline is declared", () => {
    const connector = defineConnector({
      id: "sl-none",
      commands: [{ name: "noop", prompt: "p" }],
    });
    const changes = antigravityCliAdapter.installStatusline!(slCtx(connector));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("no statusline");
  });
});

describe("antigravity-cli adapter — statusline parse/format", () => {
  it("parseStatusInput maps agy's LIVE-CAPTURED statusLine stdin JSON (agy v1.0.10)", () => {
    // The exact payload captured from a real headless `agy -p` turn (2026-06-21).
    const raw = {
      cwd: "/home/dev/acme",
      session_id: "a850e668-0e08-408c-8195-c8c44c0944f1",
      conversation_id: "a850e668-0e08-408c-8195-c8c44c0944f1",
      transcript_path: "/home/dev/.gemini/antigravity/brain/x/transcript.jsonl",
      model: { id: "Gemini 3.5 Flash (High)", display_name: "Gemini 3.5 Flash (High)" },
      workspace: { current_dir: "/home/dev/acme", project_dir: "/home/dev/acme" },
      version: "1.0.10",
      context_window: {
        total_input_tokens: 150,
        total_output_tokens: 42,
        context_window_size: 1048576,
        used_percentage: 0.0143,
        remaining_percentage: 99.98,
        current_usage: { input_tokens: 18592, output_tokens: 38 },
      },
      agent_state: "working",
      vcs: { type: "git" },
      plan_tier: "Google AI Pro",
      terminal_width: 80,
    };
    const ctx = antigravityCliAdapter.parseStatusInput!(raw);
    expect(ctx.host).toBe("antigravity-cli");
    // conversation_id wins as the stable session id.
    expect(ctx.sessionId).toBe("a850e668-0e08-408c-8195-c8c44c0944f1");
    expect(ctx.cwd).toBe("/home/dev/acme");
    expect(ctx.transcriptPath).toBe(raw.transcript_path);
    expect(ctx.model).toEqual({
      id: "Gemini 3.5 Flash (High)",
      displayName: "Gemini 3.5 Flash (High)",
    });
    // maxTokens = context_window_size; usedTokens = total_input + total_output
    // (NOT current_usage, which is an OBJECT on agy); percent = used_percentage.
    expect(ctx.context).toEqual({ maxTokens: 1048576, usedTokens: 192, percent: 0.0143 });
    // agy has no cost analog.
    expect(ctx.cost).toBeUndefined();
    // The verbatim payload survives on `raw` (agent_state/vcs/plan_tier/version/…).
    expect(ctx.raw).toBe(raw);
  });

  it("falls back to session_id when conversation_id is absent; tolerates empties", () => {
    const ctx = antigravityCliAdapter.parseStatusInput!({ session_id: "s-only" });
    expect(ctx.sessionId).toBe("s-only");
    // Empty payload → only host/capabilities/raw, no fabricated fields.
    const empty = antigravityCliAdapter.parseStatusInput!({});
    expect(empty.host).toBe("antigravity-cli");
    expect(empty.sessionId).toBeUndefined();
    expect(empty.context).toBeUndefined();
    expect(empty.model).toBeUndefined();
  });

  it("formatStatusOutput emits the rendered line on stdout with exit 0", () => {
    expect(antigravityCliAdapter.formatStatusOutput!("hello")).toEqual({
      exitCode: 0,
      stdout: "hello",
    });
  });
});
