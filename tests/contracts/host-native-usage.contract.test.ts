/**
 * contracts/host-native-usage — fleet-wide privacy + reversibility contract for
 * the OPT-IN host-native turn-usage hook (enricher 4a), derived from the registry.
 *
 * A small minority of hosts expose a model-turn hook whose payload carries real
 * token usage (the Gemini family's `AfterModel`, shared by gemini-cli +
 * antigravity + the antigravity-cli fork). When host-native capture is opted in,
 * those adapters ALSO write that hook, routing to the hidden `usage-event`
 * entrypoint (NOT the universal `hook` dispatcher). There is no single capability
 * FLAG that gates this, so the qualifying set is derived by MECHANISM: an adapter
 * qualifies iff `installHooks`, with the opt-in ON, emits a ChangeRecord whose
 * detail names the "host-native usage" hook. Any future host-native-usage adapter
 * is therefore picked up automatically — no hand-maintained host list.
 *
 * This replaces the old hand-listed adapters/host-native-hooks.test.ts
 * (gemini-cli only, after antigravity's slice was split to its per-host file) with
 * a registry-driven describe.each that asserts the same privacy/reversibility
 * invariant on every qualifying host:
 *   • the usage hook is NOT installed when the opt-in is OFF (default);
 *   • it IS installed when telemetry.hostNativeUsage is ON, or
 *     AGENT_CONNECTOR_HOST_NATIVE=1 forces it on at install;
 *   • the command routes to ` usage-event ` (never the ` hook ` dispatcher);
 *   • idempotent (a second install skips, no duplicate);
 *   • uninstall removes it AND preserves a foreign hook in the same bucket.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";
import { defineConnector } from "../../src/core/define-connector.js";
import type { Adapter } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import { HOME_BIN, buildCtx, freshProject, isolateEnv } from "../support/env.js";

const CONNECTOR_ID = "acme-db";

/** A connector that declares NO normalized hook events; opt-in toggled by arg. */
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

/** A connector that also declares a normalized PreToolUse hook. */
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

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The native event-bucket key (in `hooks`) that carries the usage-event command. */
function usageBucketKey(file: any): string | undefined {
  const hooks = file?.hooks;
  if (!hooks || typeof hooks !== "object") return undefined;
  return Object.keys(hooks).find((k) => commandsUnder(file, k).some((c) => c.includes(" usage-event ")));
}

/** All hook command strings under the given native event bucket. */
function commandsUnder(file: any, eventKey: string): string[] {
  const bucket = file?.hooks?.[eventKey];
  if (!Array.isArray(bucket)) return [];
  return bucket.flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command));
}

/** Count the usage-event commands across every bucket in the file. */
function usageCommandCount(file: any): number {
  const hooks = file?.hooks;
  if (!hooks || typeof hooks !== "object") return 0;
  return Object.keys(hooks).reduce(
    (n, k) => n + commandsUnder(file, k).filter((c) => c.includes(" usage-event ")).length,
    0,
  );
}

/**
 * Derive the host-native-usage adapters by MECHANISM (no capability flag exists):
 * an adapter qualifies iff installHooks with the opt-in ON emits a "host-native
 * usage" ChangeRecord. Probed once at load against a throwaway temp project so the
 * describe.each matrix is registry-driven, not hand-listed.
 */
async function qualifyingHosts(): Promise<Array<{ id: string; adapter: Adapter }>> {
  const all = await Promise.all(
    ADAPTER_REGISTRY.map(async (f) => ({ id: f.id, adapter: await f.load() })),
  );
  const out: Array<{ id: string; adapter: Adapter }> = [];
  for (const entry of all) {
    const ctx = buildCtx(freshProject(`ac-hn-probe-${entry.id}-`), noHooksConnector(true), {
      dryRun: true,
    });
    const changes = entry.adapter.installHooks!(ctx);
    if (changes.some((c) => c.detail?.includes("host-native usage"))) out.push(entry);
  }
  return out;
}

const hostNativeHosts = await qualifyingHosts();

isolateEnv(["AGENT_CONNECTOR_HOST_NATIVE"]);

describe("host-native usage hook — opt-in privacy + reversibility (every qualifying host)", () => {
  it("at least one adapter exposes the host-native usage hook (gemini family)", () => {
    expect(hostNativeHosts.length).toBeGreaterThan(0);
  });

  describe.each(hostNativeHosts)("$id", ({ adapter }) => {
    it("does NOT install the usage hook when the opt-in is OFF (default)", () => {
      delete process.env.AGENT_CONNECTOR_HOST_NATIVE;
      const ctx = buildCtx(freshProject(), noHooksConnector(false));
      const changes = adapter.installHooks!(ctx);

      // A no-hooks connector with the opt-in off has nothing to install → skip.
      expect(changes.every((c) => c.action === "skip")).toBe(true);
      const hooksPath = adapter.getHookConfigPath(ctx);
      if (existsSync(hooksPath)) {
        expect(usageCommandCount(readJson(hooksPath))).toBe(0);
      }
    });

    it("installs the usage-event hook when telemetry.hostNativeUsage is ON", () => {
      delete process.env.AGENT_CONNECTOR_HOST_NATIVE;
      const ctx = buildCtx(freshProject(), noHooksConnector(true));
      const changes = adapter.installHooks!(ctx);

      const created = changes.find(
        (c) => c.action === "create" && c.detail.includes("host-native usage"),
      );
      expect(created).toBeTruthy();

      const file = readJson(adapter.getHookConfigPath(ctx));
      const key = usageBucketKey(file);
      expect(key, "expected a usage-event bucket").toBeTruthy();
      const cmds = commandsUnder(file, key!).filter((c) => c.includes(" usage-event "));
      expect(cmds).toHaveLength(1);
      // Routes to the hidden `usage-event` entrypoint (NOT the `hook` dispatcher).
      expect(cmds[0]).toContain(HOME_BIN);
      expect(cmds[0]).toContain(`--connector ${CONNECTOR_ID}`);
      expect(cmds[0]).not.toContain(" hook ");
      // The usage hook is not a tool event → empty matcher.
      const entry = file.hooks[key!].find((e: any) =>
        (e.hooks ?? []).some((h: any) => h.command.includes(" usage-event ")),
      );
      expect(entry.matcher).toBe("");
    });

    it("installs the usage hook when AGENT_CONNECTOR_HOST_NATIVE=1 forces it on", () => {
      process.env.AGENT_CONNECTOR_HOST_NATIVE = "1";
      const ctx = buildCtx(freshProject(), noHooksConnector(false)); // config opt-in OFF
      adapter.installHooks!(ctx);
      expect(usageCommandCount(readJson(adapter.getHookConfigPath(ctx)))).toBe(1);
    });

    it("is idempotent: a second install skips the already-registered usage hook", () => {
      delete process.env.AGENT_CONNECTOR_HOST_NATIVE;
      const ctx = buildCtx(freshProject(), noHooksConnector(true));
      adapter.installHooks!(ctx);
      const second = adapter.installHooks!(ctx);
      const usageChange = second.find((c) => c.detail.includes("host-native usage"));
      expect(usageChange?.action).toBe("skip");
      expect(usageCommandCount(readJson(adapter.getHookConfigPath(ctx)))).toBe(1);
    });

    it("uninstall removes the usage hook and leaves no orphan in the bucket", () => {
      delete process.env.AGENT_CONNECTOR_HOST_NATIVE;
      const ctx = buildCtx(freshProject(), noHooksConnector(true));
      adapter.installHooks!(ctx);
      expect(usageCommandCount(readJson(adapter.getHookConfigPath(ctx)))).toBe(1);

      adapter.uninstallHooks!(ctx);
      const after = existsSync(adapter.getHookConfigPath(ctx))
        ? readJson(adapter.getHookConfigPath(ctx))
        : { hooks: {} };
      expect(usageCommandCount(after)).toBe(0);
    });

    it("uninstall PRESERVES a foreign hook command in the same bucket", () => {
      delete process.env.AGENT_CONNECTOR_HOST_NATIVE;
      const ctx = buildCtx(freshProject(), noHooksConnector(true));
      adapter.installHooks!(ctx);

      const hooksPath = adapter.getHookConfigPath(ctx);
      const file = readJson(hooksPath);
      const key = usageBucketKey(file)!;
      // Inject a foreign hook command into the SAME bucket.
      file.hooks[key].push({
        matcher: "",
        hooks: [{ type: "command", command: "/usr/local/bin/someone-elses-tool" }],
      });
      writeFileSync(hooksPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");

      adapter.uninstallHooks!(ctx);
      const after = readJson(hooksPath);
      const cmds = commandsUnder(after, key);
      // Ours is gone; the foreign one survives.
      expect(cmds).toContain("/usr/local/bin/someone-elses-tool");
      expect(cmds.some((c) => c.includes(" usage-event "))).toBe(false);
    });

    it("uninstall removes the usage hook WITHOUT touching a sibling normalized hook", () => {
      delete process.env.AGENT_CONNECTOR_HOST_NATIVE;
      const ctx = buildCtx(freshProject(), withPreToolUse(true));
      adapter.installHooks!(ctx);

      const hooksPath = adapter.getHookConfigPath(ctx);
      let file = readJson(hooksPath);
      expect(usageCommandCount(file)).toBe(1);

      // Locate the normalized-dispatcher bucket (the ` hook ` command).
      const dispatchKey = Object.keys(file.hooks).find((k) =>
        commandsUnder(file, k).some((c) => c.includes(" hook ")),
      );
      expect(dispatchKey).toBeTruthy();

      adapter.uninstallHooks!(ctx);
      file = existsSync(hooksPath) ? readJson(hooksPath) : { hooks: {} };
      // Both of OUR hooks are gone after a full uninstall (anchored on our id).
      expect(usageCommandCount(file)).toBe(0);
      expect(commandsUnder(file, dispatchKey!).filter((c) => c.includes(" hook "))).toHaveLength(0);
    });
  });
});
