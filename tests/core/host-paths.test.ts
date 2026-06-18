/**
 * core/host-paths.test.ts — the canonical `codexConfigHome()` resolver.
 *
 * Regression proof for the CODEX_HOME divergence bug: the codex config WRITER
 * (adapter `userConfigDir` → `getConfigDir`/`getServerConfigPath`) and the
 * marketplace DETECTION probe (npmPluginInstalled codex cache) used to resolve
 * $CODEX_HOME with THREE different rules, so a tilde/relative value made the
 * writer and the probe target different dirs. They now both route through this
 * one resolver. The unit cases pin the contract; the AGREEMENT case below
 * (relative CODEX_HOME) is the one that FAILS on pre-fix code — the writer used
 * to return the bare relative string while the probe `resolve()`d it.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { codexConfigHome } from "../../src/core/host-paths.js";
import codexAdapter from "../../src/adapters/codex/index.js";
import { defineConnector } from "../../src/core/define-connector.js";
import type { ResolvedConnector } from "../../src/core/types.js";
import { buildCtx, freshProject, isolateEnv } from "../support/env.js";

/** Minimal stdio connector — enough to build a user-scope InstallContext. */
function minimalConnector(): ResolvedConnector {
  return defineConnector({
    id: "acme-codex-home",
    displayName: "Acme Codex Home",
    version: "0.0.1",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
    },
  });
}

describe("codexConfigHome()", () => {
  // Snapshot/restore CODEX_HOME (+ the env keys isolateEnv guards by default)
  // around every case so neither these tests nor the ambient shell leak.
  isolateEnv(["CODEX_HOME"]);

  it("falls back to ~/.codex when CODEX_HOME is unset", () => {
    delete process.env.CODEX_HOME;
    expect(codexConfigHome()).toBe(join(homedir(), ".codex"));
  });

  it("treats an empty CODEX_HOME as unset (→ ~/.codex)", () => {
    process.env.CODEX_HOME = "";
    expect(codexConfigHome()).toBe(join(homedir(), ".codex"));
  });

  it("expands a leading tilde against the home dir", () => {
    process.env.CODEX_HOME = "~/cx";
    expect(codexConfigHome()).toBe(join(homedir(), "cx"));
  });

  it("passes an absolute path through unchanged", () => {
    // Must be an already-absolute, already-normalized path FOR THIS OS so that
    // resolve() is a no-op (on Windows "/abs/cx" is NOT absolute → resolve would
    // rewrite it to "C:\\abs\\cx"). A platform-correct literal keeps the
    // "absolute passes through unchanged" contract true cross-OS.
    const abs = process.platform === "win32" ? "C:\\abs\\cx" : "/abs/cx";
    process.env.CODEX_HOME = abs;
    expect(codexConfigHome()).toBe(abs);
  });

  it("resolves a relative path against cwd", () => {
    process.env.CODEX_HOME = "rel-cx";
    expect(codexConfigHome()).toBe(resolve("rel-cx"));
  });
});

describe("codex writer ↔ marketplace probe agreement", () => {
  isolateEnv(["CODEX_HOME"]);

  // The bug's proof. With a RELATIVE CODEX_HOME the adapter's user-scope config
  // path must live under the SAME base the detection probe computes via
  // codexConfigHome(). Pre-fix the writer returned the bare relative string
  // (e.g. "rel-codex/config.toml") while codexConfigHome() resolved it to an
  // absolute cwd-joined path — so this startsWith assertion FAILED.
  it("user-scope config path lives under codexConfigHome() for a relative CODEX_HOME", () => {
    process.env.CODEX_HOME = "rel-codex-home";
    const projectDir = freshProject();
    const userCtx = buildCtx(projectDir, minimalConnector(), "user");

    const writerPath = codexAdapter.getServerConfigPath(userCtx);
    const probeBase = codexConfigHome();

    expect(probeBase).toBe(resolve("rel-codex-home"));
    expect(writerPath.startsWith(probeBase)).toBe(true);
    expect(writerPath).toBe(join(probeBase, "config.toml"));
  });

  it("user-scope config path lives under codexConfigHome() for a tilde CODEX_HOME", () => {
    process.env.CODEX_HOME = "~/cx-home";
    const projectDir = freshProject();
    const userCtx = buildCtx(projectDir, minimalConnector(), "user");

    const writerPath = codexAdapter.getServerConfigPath(userCtx);
    const probeBase = codexConfigHome();

    expect(probeBase).toBe(join(homedir(), "cx-home"));
    expect(writerPath).toBe(join(probeBase, "config.toml"));
  });
});
