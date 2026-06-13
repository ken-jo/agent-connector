/**
 * adapters/goose.test.ts — skills surface confirmation for the goose adapter.
 *
 * The skills gap batch task required verification of a confirmed SKILL.md dir
 * for goose before flipping supportsSkills. The ground-truth document
 * (kilo-pi-ground-truth.md § "Already-known skills gaps") states:
 *
 *   goose (dirs need confirmation)
 *
 * No confirmed goose SKILL.md dir exists in official docs as of 2026-06-13.
 * Therefore supportsSkills stays false (unset) and installSkills routes through
 * the BaseAdapter warn/skip default. This test locks that behavior so a future
 * flip requires an explicit, documented confirmation.
 *
 * MCP/hooks/parse/formatReply are covered by wave3.test.ts.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import gooseAdapter from "../../src/adapters/goose/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-skills";

const SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files.",
  body: "# PDF Tools\n\nExtract text from PDFs.",
  tools: { allow: ["Bash"] },
} as const;

function buildConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Skills",
    version: "1.0.0",
    skills: [{ ...SKILL, tools: { allow: [...SKILL.tools.allow] } }],
  });
}

function buildCtx(projectDir: string, connector: ResolvedConnector): InstallContext {
  return {
    connector,
    scope: "project",
    projectDir,
    homeBinPath: HOME_BIN,
    dataRoot: projectDir,
    dryRun: false,
  };
}

let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-goose-skills-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return dir;
}

// ── goose skills surface ──────────────────────────────────────────────────

describe("goose adapter — skills surface (unconfirmed dir → false)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = freshProject();
  });

  it("does NOT declare supportsSkills (dirs unconfirmed; stays false/unset)", () => {
    // Ground truth says "goose dirs need confirmation" — flip only when confirmed.
    expect(gooseAdapter.capabilities.supportsSkills).toBeFalsy();
  });

  it("installSkills routes through BaseAdapter warn (unsupported) and writes nothing", () => {
    const ctx = buildCtx(projectDir, buildConnector());
    const changes = gooseAdapter.installSkills!(ctx);
    // BaseAdapter.unsupportedSurface returns a single warn entry.
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
  });
});
