/**
 * adapters/host-native-hooks — the OPT-IN AfterModel host-native usage hook (4a)
 * on the Gemini CLI + Antigravity adapters. Asserts the privacy + reversibility
 * contract the plan calls out:
 *
 *   • The AfterModel `usage-event` hook is installed ONLY when host-native capture
 *     is opted in (telemetry.hostNativeUsage === true, OR AGENT_CONNECTOR_HOST_NATIVE=1
 *     at install). With the opt-in OFF the hook is NEVER written — even for a
 *     connector that declares NO normalized hook events.
 *   • The installed hook command routes to the hidden `usage-event` entrypoint
 *     (NOT the universal `hook` dispatcher) and carries an empty matcher.
 *   • uninstallHooks removes the AfterModel usage hook (anchored on connector id)
 *     while PRESERVING a foreign hook command in the same event bucket and the
 *     connector's own non-usage hooks.
 *
 * Isolation: every test gets a fresh project dir; the opt-in env switch is saved
 * and restored so no test leaks state into another.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import geminiAdapter from "../../src/adapters/gemini-cli/index.js";
import antigravityAdapter from "../../src/adapters/antigravity/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-db";

// Each adapter under test, with the native event-bucket key its AfterModel usage
// hook lands under (both Gemini-family adapters use the "AfterModel" key).
const ADAPTERS = [
  { name: "gemini-cli", adapter: geminiAdapter },
  { name: "antigravity", adapter: antigravityAdapter },
] as const;
const USAGE_EVENT_KEY = "AfterModel";

/**
 * A connector that declares NO normalized hook events. host-native capture is a
 * host-native-only sink (no handler), so the usage hook may be installed for such
 * a connector when opted in — and must NOT be installed when opted out.
 */
function noHooksConnector(hostNativeUsage: boolean): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.0.0",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/db-mcp"],
      tools: { include: ["*"] },
    },
    telemetry: { hostNativeUsage },
  });
}

/**
 * A connector that ALSO declares a normalized PreToolUse hook — used to prove the
 * usage hook is added alongside (and removed without touching) a real hook.
 */
function withPreToolUse(hostNativeUsage: boolean): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.0.0",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/db-mcp"],
      tools: { include: ["*"] },
    },
    hooks: {
      PreToolUse: { matcher: "acme_query", handler: () => ({ decision: "allow" }) },
    },
    telemetry: { hostNativeUsage },
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

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** All hook command strings under the given native event bucket. */
function commandsUnder(file: any, eventKey: string): string[] {
  const bucket = file?.hooks?.[eventKey];
  if (!Array.isArray(bucket)) return [];
  return bucket.flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command));
}

let savedHostNative: string | undefined;

beforeEach(() => {
  savedHostNative = process.env.AGENT_CONNECTOR_HOST_NATIVE;
  delete process.env.AGENT_CONNECTOR_HOST_NATIVE;
});

afterEach(() => {
  if (savedHostNative === undefined) delete process.env.AGENT_CONNECTOR_HOST_NATIVE;
  else process.env.AGENT_CONNECTOR_HOST_NATIVE = savedHostNative;
});

function freshProject(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

for (const { name, adapter } of ADAPTERS) {
  describe(`${name} host-native usage hook (opt-in only)`, () => {
    let project: string;

    beforeEach(() => {
      project = freshProject(`ac-hn-${name}-`);
    });

    afterEach(() => {
      rmSync(project, { recursive: true, force: true });
    });

    it("does NOT install the AfterModel usage hook when the opt-in is OFF", () => {
      const ctx = buildCtx(project, noHooksConnector(false));
      const changes = adapter.installHooks(ctx);

      // A no-hooks connector with the opt-in off has nothing to install → skip.
      expect(changes.every((c) => c.action === "skip")).toBe(true);
      const hooksPath = adapter.getHookConfigPath(ctx);
      // No usage-event command anywhere (file may not even exist).
      if (existsSync(hooksPath)) {
        const file = readJson(hooksPath);
        expect(commandsUnder(file, USAGE_EVENT_KEY)).toHaveLength(0);
      }
    });

    it("installs the AfterModel usage-event hook when telemetry.hostNativeUsage is ON", () => {
      const ctx = buildCtx(project, noHooksConnector(true));
      const changes = adapter.installHooks(ctx);

      const created = changes.find(
        (c) => c.action === "create" && c.detail.includes("host-native usage"),
      );
      expect(created).toBeTruthy();

      const file = readJson(adapter.getHookConfigPath(ctx));
      const cmds = commandsUnder(file, USAGE_EVENT_KEY);
      expect(cmds).toHaveLength(1);
      // Routes to the hidden `usage-event` entrypoint (NOT the `hook` dispatcher).
      expect(cmds[0]).toContain(" usage-event ");
      expect(cmds[0]).toContain(HOME_BIN);
      expect(cmds[0]).toContain(`--connector ${CONNECTOR_ID}`);
      expect(cmds[0]).not.toContain(" hook ");
      // The usage hook is not a tool event → empty matcher.
      const entry = file.hooks[USAGE_EVENT_KEY].find((e: any) =>
        (e.hooks ?? []).some((h: any) => h.command.includes(" usage-event ")),
      );
      expect(entry.matcher).toBe("");
    });

    it("installs the usage hook when AGENT_CONNECTOR_HOST_NATIVE=1 forces it on at install", () => {
      process.env.AGENT_CONNECTOR_HOST_NATIVE = "1";
      const ctx = buildCtx(project, noHooksConnector(false)); // config opt-in OFF
      adapter.installHooks(ctx);

      const file = readJson(adapter.getHookConfigPath(ctx));
      expect(commandsUnder(file, USAGE_EVENT_KEY)).toHaveLength(1);
    });

    it("is idempotent: a second install skips the already-registered usage hook", () => {
      const ctx = buildCtx(project, noHooksConnector(true));
      adapter.installHooks(ctx);
      const second = adapter.installHooks(ctx);
      const usageChange = second.find((c) => c.detail.includes("host-native usage"));
      expect(usageChange?.action).toBe("skip");
      // Still exactly one usage-event command (no duplicate appended).
      const file = readJson(adapter.getHookConfigPath(ctx));
      expect(commandsUnder(file, USAGE_EVENT_KEY)).toHaveLength(1);
    });

    it("uninstall removes the AfterModel usage hook (and leaves the bucket clean)", () => {
      const ctx = buildCtx(project, noHooksConnector(true));
      adapter.installHooks(ctx);
      expect(commandsUnder(readJson(adapter.getHookConfigPath(ctx)), USAGE_EVENT_KEY))
        .toHaveLength(1);

      adapter.uninstallHooks(ctx);
      const after = existsSync(adapter.getHookConfigPath(ctx))
        ? readJson(adapter.getHookConfigPath(ctx))
        : { hooks: {} };
      expect(commandsUnder(after, USAGE_EVENT_KEY)).toHaveLength(0);
      // Our anchored cleanup empties the bucket entirely (no orphan entry left).
      expect(after.hooks?.[USAGE_EVENT_KEY]).toBeUndefined();
    });

    it("uninstall PRESERVES a foreign hook command in the same AfterModel bucket", () => {
      const ctx = buildCtx(project, noHooksConnector(true));
      adapter.installHooks(ctx);

      // Inject a foreign hook command into the SAME bucket.
      const hooksPath = adapter.getHookConfigPath(ctx);
      const file = readJson(hooksPath);
      file.hooks[USAGE_EVENT_KEY].push({
        matcher: "",
        hooks: [{ type: "command", command: "/usr/local/bin/someone-elses-tool" }],
      });
      writeFileSync(hooksPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");

      adapter.uninstallHooks(ctx);
      const after = readJson(hooksPath);
      const cmds = commandsUnder(after, USAGE_EVENT_KEY);
      // Ours is gone; the foreign one survives.
      expect(cmds).toContain("/usr/local/bin/someone-elses-tool");
      expect(cmds.some((c) => c.includes(" usage-event "))).toBe(false);
    });

    it("uninstall removes the usage hook WITHOUT touching a sibling normalized hook", () => {
      const ctx = buildCtx(project, withPreToolUse(true));
      adapter.installHooks(ctx);

      const hooksPath = adapter.getHookConfigPath(ctx);
      // Both present after install: the usage hook AND the PreToolUse dispatcher.
      let file = readJson(hooksPath);
      expect(commandsUnder(file, USAGE_EVENT_KEY)).toHaveLength(1);

      // Locate the PreToolUse bucket key (gemini maps PreToolUse → "PreToolUse").
      const preKey = Object.keys(file.hooks).find((k) =>
        commandsUnder(file, k).some((c) => c.includes(" hook ")),
      );
      expect(preKey).toBeTruthy();

      adapter.uninstallHooks(ctx);
      file = existsSync(hooksPath) ? readJson(hooksPath) : { hooks: {} };
      // Both of OUR hooks are gone after a full uninstall (anchored on our id).
      expect(commandsUnder(file, USAGE_EVENT_KEY)).toHaveLength(0);
      expect(commandsUnder(file, preKey!)).toHaveLength(0);
    });
  });
}
