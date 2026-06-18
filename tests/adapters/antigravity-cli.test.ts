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

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { PreToolUseEvent, ResolvedConnector } from "../../src/core/types.js";

import antigravityAdapter, {
  AntigravityAdapter,
} from "../../src/adapters/antigravity/index.js";
import antigravityCliAdapter, {
  AntigravityCliAdapter,
} from "../../src/adapters/antigravity-cli/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { readJson } from "../support/fs.js";
import { createAdapterSuite } from "../support/adapter-suite.js";

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
  it("parseEvent stamps hostPlatform = antigravity-cli (dispatched events route to THIS adapter)", () => {
    const ev = antigravityCliAdapter.parseEvent("PreToolUse", {
      connector: CONNECTOR_ID,
      toolName: "t",
      toolInput: {},
    }) as PreToolUseEvent;
    expect(ev.hostPlatform).toBe("antigravity-cli");
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
  it("INHERITS the IDE adapter's capability surface (all four E1 flags falsy)", () => {
    // The class field initializer gives each instance its own object — assert
    // structural identity (the CLI adapter declares no capabilities of its own).
    expect(antigravityCliAdapter.capabilities).toStrictEqual(antigravityAdapter.capabilities);
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
