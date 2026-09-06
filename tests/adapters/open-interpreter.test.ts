/**
 * adapters/open-interpreter.test.ts — the ONE per-host file for the Open
 * Interpreter adapter.
 *
 * Open Interpreter is the new Rust `interpreter`/`i` CLI and is a FORK of OpenAI's
 * Codex (README: "Open Interpreter is a fork of OpenAI's Codex"). It is json-stdio
 * from agent-connector's perspective (the Codex hook subsystem is present in the
 * fork, but the `interpreter` product's live hook wire contract is not first-party
 * verified, so AC does not claim hooks). Config surfaces:
 *   • MCP servers → <home>/config.toml, TABLE [mcp_servers.<id>] (TOML, NO native
 *                   interpolation → env-refs resolve to LITERALS at install time);
 *                   stdio as { command, args, env }, streamable-HTTP as
 *                   { url, bearer_token_env_var?, http_headers? } (transport
 *                   inferred from `url`, no explicit transport key). Identical to
 *                   codex (codex-rs/config/src/mcp_{edit,types}.rs).
 *   • config dir  → user scope ONLY: $INTERPRETER_HOME || ~/.openinterpreter.
 *                   The binary DELIBERATELY ignores $CODEX_HOME to keep the two
 *                   products isolated (codex-rs/utils/home-dir/src/lib.rs).
 *   • Hooks       → unavailable (mcp-only): installHooks/uninstallHooks return a
 *                   single "skip".
 *
 * Uses the shared harness (tests/support/env + adapter-suite + fs) per
 * tests/README.md — ONE file per host. config.toml is parsed with @iarna/toml
 * (the source's choice).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import TOML from "@iarna/toml";
import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector, ServerDef } from "../../src/core/types.js";

import openInterpreterAdapter from "../../src/adapters/open-interpreter/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { symlinkOrSkipTest } from "../support/symlink.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

const CONNECTOR_ID = "acme-db";
// render's env-ref → TOML literal resolution.
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
// remote-HTTP slice uses its own id + bearer-token env var.
const HTTP_CONNECTOR_ID = "acme-remote";
const BEARER_ENV = "ACME_TOKEN";

/** render: a stdio server with an env-ref (resolves to a TOML literal). */
function buildRenderConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
      env: { [ENV_VAR]: `\${env:${ENV_VAR}}` },
      tools: { include: ["*"] },
    },
  });
}

/** A server-only connector with telemetry off (no serve-wrap), used for HTTP. */
function connectorWith(server: ServerDef): ResolvedConnector {
  return defineConnector({
    id: HTTP_CONNECTOR_ID,
    displayName: "Acme OI HTTP",
    version: "1.0.0",
    server,
    telemetry: { enabled: false },
  });
}

// extraKeys: INTERPRETER_HOME (config-dir resolution — left unset so it defaults
// to ~/.openinterpreter under the sandboxed HOME), ENV_VAR (render's ${env:VAR} →
// TOML literal), ACME_TOKEN (remote-HTTP bearer resolution).
isolateEnv(["INTERPRETER_HOME", "CODEX_HOME", ENV_VAR, BEARER_ENV]);
createAdapterSuite({ adapter: openInterpreterAdapter, paradigm: "json-stdio" });

// ── render + round-trip (config.toml TOML table) ─────────────────────────────

describe("open-interpreter adapter render/round-trip", () => {
  let home: string;
  let ctx: InstallContext;

  beforeEach(() => {
    // freshProject sets HOME → temp dir, so ~/.openinterpreter resolves under it.
    home = freshProject("ac-render-oi-");
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(home, buildRenderConnector(), "user");
  });

  it("config dir defaults to ~/.openinterpreter (NOT ~/.codex) and the server file is config.toml", () => {
    expect(openInterpreterAdapter.getConfigDir(ctx)).toBe(
      join(home, ".openinterpreter"),
    );
    expect(openInterpreterAdapter.getServerConfigPath(ctx)).toBe(
      join(home, ".openinterpreter", "config.toml"),
    );
  });

  it("honors $INTERPRETER_HOME and IGNORES $CODEX_HOME (products stay isolated)", () => {
    const oiHome = join(home, "custom-oi-home");
    process.env.INTERPRETER_HOME = oiHome;
    process.env.CODEX_HOME = join(home, "should-be-ignored");
    expect(openInterpreterAdapter.getConfigDir(ctx)).toBe(oiHome);
    delete process.env.CODEX_HOME;
  });

  it("installServer writes [mcp_servers.<id>] TOML table, wrapped for telemetry, env as a LITERAL (no native interpolation)", () => {
    const changes = openInterpreterAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const tomlPath = join(home, ".openinterpreter", "config.toml");
    expect(tomlPath).toBe(openInterpreterAdapter.getServerConfigPath(ctx));
    expect(existsSync(tomlPath)).toBe(true);

    const cfg = TOML.parse(readFileSync(tomlPath, "utf8")) as any;
    expect(cfg.mcp_servers).toBeTruthy();
    const entry = cfg.mcp_servers[CONNECTOR_ID];
    expect(entry).toBeTruthy();

    // Serve-wrapper points at the home binary, tagged for the open-interpreter host.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual([
      "serve",
      "--connector",
      CONNECTOR_ID,
      "--scope",
      "user",
      "--host",
      "open-interpreter",
      "--",
      "npx",
      "-y",
      "@x/y",
    ]);

    // TOML cannot interpolate → the env-ref is resolved to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installServer is idempotent — second call yields skip, no duplicate table", () => {
    openInterpreterAdapter.installServer(ctx);
    const second = openInterpreterAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = TOML.parse(
      readFileSync(join(home, ".openinterpreter", "config.toml"), "utf8"),
    ) as any;
    expect(Object.keys(cfg.mcp_servers)).toEqual([CONNECTOR_ID]);
  });

  it("installServer warn-skips a symlinked config.toml without touching the target", () => {
    const tomlPath = join(home, ".openinterpreter", "config.toml");
    const outside = join(home, "outside-config.toml");
    const before = "[outside]\nkeep = true\n";
    mkdirSync(join(home, ".openinterpreter"), { recursive: true });
    writeFileSync(outside, before, "utf8");
    if (!symlinkOrSkipTest(outside, tomlPath)) return;

    const changes = openInterpreterAdapter.installServer(ctx);

    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.path).toBe(tomlPath);
    expect(changes[0]?.detail).toMatch(/symbolic link/i);
    expect(readFileSync(outside, "utf8")).toBe(before);
  });

  it("uninstallServer removes our table and leaves a sibling server untouched (zero-residue)", () => {
    openInterpreterAdapter.installServer(ctx);
    // Seed a foreign sibling server by hand.
    const tomlPath = join(home, ".openinterpreter", "config.toml");
    const cfg = TOML.parse(readFileSync(tomlPath, "utf8")) as any;
    cfg.mcp_servers.foreign = { command: "other", args: ["--x"] };
    writeFileSync(tomlPath, TOML.stringify(cfg), "utf8");

    const changes = openInterpreterAdapter.uninstallServer(ctx);
    expect(changes[0]?.action).toBe("remove");

    const after = TOML.parse(readFileSync(tomlPath, "utf8")) as any;
    expect(after.mcp_servers[CONNECTOR_ID]).toBeUndefined();
    // Sibling preserved.
    expect(after.mcp_servers.foreign).toEqual({ command: "other", args: ["--x"] });
  });

  it("uninstallServer on an absent / no-match config is a clean skip", () => {
    const changes = openInterpreterAdapter.uninstallServer(ctx);
    expect(changes[0]?.action).toBe("skip");
  });

  it("installHooks with NO hooks declared → single skip `no hooks declared`", () => {
    const installed = openInterpreterAdapter.installHooks(ctx);
    expect(installed).toHaveLength(1);
    expect(installed[0]?.action).toBe("skip");
    expect(installed[0]?.detail).toBe("no hooks declared");
  });

  it("commands and subagents are NOT wired (host-native, path unconfirmed): install/uninstall skip", () => {
    expect(openInterpreterAdapter.capabilities.supportsCommands).toBe(false);
    expect(openInterpreterAdapter.capabilities.supportsSubagents).toBe(false);
    expect(openInterpreterAdapter.capabilities.supportsSkills).toBe(true);
    expect(openInterpreterAdapter.installCommands(ctx)[0]?.action).toBe("skip");
    expect(openInterpreterAdapter.uninstallCommands(ctx)[0]?.action).toBe("skip");
    expect(openInterpreterAdapter.installSubagents(ctx)[0]?.action).toBe("skip");
    expect(openInterpreterAdapter.uninstallSubagents(ctx)[0]?.action).toBe("skip");
  });
});

// ── hooks (json-stdio; Claude-shaped hooks.json under the OI home / .openinterpreter) ──

function buildHookConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    hooks: {
      PreToolUse: { handler: () => ({ decision: "allow" }) },
      SessionStart: { handler: () => ({ decision: "allow" }) },
      SessionEnd: { handler: () => ({ decision: "allow" }) },
      Notification: { handler: () => ({ decision: "allow" }) },
    },
    telemetry: { enabled: false },
  });
}

describe("open-interpreter adapter hooks (json-stdio, Codex-compatible hooks.json)", () => {
  let home: string;

  beforeEach(() => {
    home = freshProject("ac-hooks-oi-");
  });

  it("user scope writes ~/.openinterpreter/hooks.json (NOT ~/.codex) with the open-interpreter platform token", () => {
    const ctx = buildCtx(home, buildHookConnector(), "user");
    const changes = openInterpreterAdapter.installHooks(ctx);
    expect(changes.length).toBeGreaterThan(0);

    const hooksPath = join(home, ".openinterpreter", "hooks.json");
    expect(openInterpreterAdapter.getHookConfigPath(ctx)).toBe(hooksPath);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);

    const cfg = JSON.parse(readFileSync(hooksPath, "utf8"));
    const pre = cfg.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    const cmd = pre[0].hooks[0].command;
    expect(cmd).toContain(HOME_BIN);
    expect(cmd).toContain("hook open-interpreter PreToolUse");
    expect(cmd).toContain(`--connector ${CONNECTOR_ID}`);
    expect(pre[0].matcher).toContain("exec_command");
    expect(cfg.hooks.SessionStart[0].hooks[0].command).toContain("hook open-interpreter SessionStart");
  });

  it("SessionEnd IS registered (live-verified on the interpreter product); Notification is a visible skip", () => {
    const ctx = buildCtx(home, buildHookConnector(), "user");
    const changes = openInterpreterAdapter.installHooks(ctx);
    const cfg = JSON.parse(readFileSync(join(home, ".openinterpreter", "hooks.json"), "utf8"));
    expect(cfg.hooks.SessionEnd[0].hooks[0].command).toContain("hook open-interpreter SessionEnd");
    expect(cfg.hooks.Notification).toBeUndefined();
    const notification = changes.find((c) => (c.detail ?? "").includes("Notification"));
    expect(notification?.action).toBe("skip");
    expect(notification?.detail).toBe("Notification has no Open Interpreter hook equivalent — skipped");
  });

  it("project scope writes <project>/.openinterpreter/hooks.json; install is idempotent; uninstall leaves zero residue", () => {
    const ctx = buildCtx(home, buildHookConnector(), "project");
    openInterpreterAdapter.installHooks(ctx);
    const hooksPath = join(home, ".openinterpreter", "hooks.json");
    expect(openInterpreterAdapter.getHookConfigPath(ctx)).toBe(hooksPath);
    expect(existsSync(hooksPath)).toBe(true);

    const second = openInterpreterAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    openInterpreterAdapter.uninstallHooks(ctx);
    const after = JSON.parse(readFileSync(hooksPath, "utf8"));
    for (const bucket of Object.values(after.hooks ?? {}) as unknown[][]) {
      expect(bucket).toHaveLength(0);
    }
  });

  it("$INTERPRETER_HOME relocates hooks.json too, and $CODEX_HOME never does", () => {
    const oiHome = join(home, "oi-home");
    mkdirSync(oiHome, { recursive: true });
    process.env.INTERPRETER_HOME = oiHome;
    process.env.CODEX_HOME = join(home, "codex-home");
    const ctx = buildCtx(home, buildHookConnector(), "user");
    expect(openInterpreterAdapter.getHookConfigPath(ctx)).toBe(join(oiHome, "hooks.json"));
    delete process.env.INTERPRETER_HOME;
    delete process.env.CODEX_HOME;
  });

  it("skills go to the tool-neutral .agents/skills (project) and ~/.agents/skills (user); memory targets AGENTS.md under the OI home", () => {
    const projectCtx = buildCtx(home, buildRenderConnector(), "project");
    const userCtx = buildCtx(home, buildRenderConnector(), "user");
    const adapterAny = openInterpreterAdapter as unknown as {
      skillDir(ctx: InstallContext, name: string): string;
      memoryTargets(ctx: InstallContext): { path: string }[];
    };
    expect(adapterAny.skillDir(projectCtx, "acme")).toBe(join(home, ".agents", "skills", "acme"));
    expect(adapterAny.skillDir(userCtx, "acme")).toBe(join(home, ".agents", "skills", "acme"));
    expect(adapterAny.memoryTargets(userCtx)[0]?.path).toBe(join(home, ".openinterpreter", "AGENTS.md"));
    expect(adapterAny.memoryTargets(projectCtx)[0]?.path).toBe(join(home, "AGENTS.md"));
  });
});

// ── streamable-HTTP MCP (url, bearer_token_env_var, http_headers) ────────────

describe("open-interpreter adapter remote streamable-HTTP MCP", () => {
  let home: string;

  beforeEach(() => {
    home = freshProject("ac-oi-http-");
    process.env[BEARER_ENV] = "secret-token";
  });

  it("a bare http server renders just { url } (no empty headers/bearer keys)", () => {
    const c = connectorWith({
      transport: "http",
      url: "https://mcp.acme.test/sse",
      tools: { include: ["*"] },
    });
    const ctx = buildCtx(home, c, "user");
    const changes = openInterpreterAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const cfg = TOML.parse(
      readFileSync(join(home, ".openinterpreter", "config.toml"), "utf8"),
    ) as any;
    const entry = cfg.mcp_servers[HTTP_CONNECTOR_ID];
    expect(entry).toEqual({ url: "https://mcp.acme.test/sse" });
  });

  it("http server with bearerEnv auth renders { url, bearer_token_env_var }", () => {
    const c = connectorWith({
      transport: "http",
      url: "https://mcp.acme.test/sse",
      auth: { type: "bearerEnv", bearerEnvVar: BEARER_ENV },
      tools: { include: ["*"] },
    });
    const ctx = buildCtx(home, c, "user");
    openInterpreterAdapter.installServer(ctx);

    const cfg = TOML.parse(
      readFileSync(join(home, ".openinterpreter", "config.toml"), "utf8"),
    ) as any;
    const entry = cfg.mcp_servers[HTTP_CONNECTOR_ID];
    // The env-var NAME is emitted, never the token value (TOML carries no secret).
    expect(entry.url).toBe("https://mcp.acme.test/sse");
    expect(entry.bearer_token_env_var).toBe(BEARER_ENV);
    expect(JSON.stringify(entry)).not.toContain("secret-token");
  });

  it("an unregistrable transport (sse) is skipped (config.toml is stdio + streamable-http only)", () => {
    const c = connectorWith({
      transport: "sse",
      url: "https://mcp.acme.test/sse",
      tools: { include: ["*"] },
    });
    const ctx = buildCtx(home, c, "user");
    const changes = openInterpreterAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toMatch(/not registrable/i);
  });
});
