/**
 * contracts/hook-detail — fleet-wide invariant for EVERY ts-plugin host.
 *
 * A connector may declare more canonical hook events than a given ts-plugin host
 * can map. The generated-plugin install record's `detail` must therefore list
 * ONLY the events the host actually wires and call out any declared-but-
 * unsupported event separately, e.g.:
 *   "<id> plugin module (SessionStart,PreToolUse,PostToolUse; unsupported here: UserPromptSubmit,PreCompact)"
 * It must NEVER list an unsupported event as if it were wired.
 *
 * This replaces the old hand-listed adapters/hook-detail-mapped.test.ts (4 hosts)
 * with a `describe.each(ts-plugin hosts)` derived from the registry — so amp /
 * mimo-code / nemoclaw are now covered too, and any future ts-plugin host is
 * covered automatically. The expected mapped/unsupported split is derived from
 * each adapter's own capability flags, not a per-host literal — the prefix
 * (which can differ from the id, e.g. kilo-cli → "kilo", nemoclaw → "openclaw")
 * is deliberately NOT asserted.
 */
import { describe, expect, it } from "vitest";

import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";
import { defineConnector } from "../../src/core/define-connector.js";
import type { ConnectorConfig } from "../../src/core/types.js";
import type { ChangeRecord, HookEventName, ResolvedConnector } from "../../src/core/types.js";

import { buildCtx, freshProject, isolateEnv } from "../support/env.js";
import { supportsEvent } from "../support/events.js";

// A connector declaring MORE events than any single ts-plugin host maps, in
// canonical order: every host maps a strict subset, so each exercises both the
// wired list and the "unsupported here" suffix.
const DECLARED: HookEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
];

function connectorDeclaring(events: HookEventName[]): ResolvedConnector {
  const hooks = Object.fromEntries(
    events.map((e) => [e, { handler: () => ({ decision: "allow" as const }) }]),
  ) as ConnectorConfig["hooks"];
  return defineConnector({
    id: "acme-db",
    displayName: "Acme DB Tools",
    version: "1.2.3",
    hooks,
  });
}

/** The change whose detail names the plugin module (skip the manifest record). */
function moduleDetail(changes: ChangeRecord[]): string {
  const mod = changes.find(
    (c) => c.detail?.includes("plugin module") && !c.path?.endsWith("package.json"),
  );
  expect(mod, "expected a plugin-module change record").toBeTruthy();
  return mod!.detail!;
}

// Load the ts-plugin hosts from the registry (top-level await — ESM test file).
const tsPluginHosts = (
  await Promise.all(
    ADAPTER_REGISTRY.map(async (f) => ({ id: f.id, adapter: await f.load() })),
  )
).filter(({ adapter }) => adapter.paradigm === "ts-plugin");

isolateEnv();

describe("ts-plugin installHooks detail reports MAPPED events only (every ts-plugin host)", () => {
  it("covers every registered ts-plugin host (≥ the original 4)", () => {
    expect(tsPluginHosts.length).toBeGreaterThanOrEqual(4);
  });

  describe.each(tsPluginHosts)("$id", ({ adapter }) => {
    it("lists exactly the capability-supported events as wired, flags the rest unsupported", () => {
      const ctx = buildCtx(freshProject(), connectorDeclaring(DECLARED), { dryRun: true });
      const detail = moduleDetail(adapter.installHooks!(ctx));

      const mapped = DECLARED.filter((e) => supportsEvent(adapter.capabilities, e));
      const unsupported = DECLARED.filter((e) => !supportsEvent(adapter.capabilities, e));

      const wired = detail.split("; unsupported here:")[0]!;
      // The wired list carries every supported event, in canonical order…
      expect(wired).toContain(mapped.join(","));
      // …and NONE of the unsupported events.
      for (const e of unsupported) expect(wired).not.toContain(e);

      if (unsupported.length > 0) {
        expect(detail).toContain("unsupported here:");
        for (const e of unsupported) expect(detail).toContain(e);
      } else {
        expect(detail).not.toContain("unsupported here");
      }
    });

    it("emits no 'unsupported here' suffix for a fully-mapped connector", () => {
      // SessionStart + PreToolUse + PostToolUse are mapped by every ts-plugin host.
      const fully: HookEventName[] = ["SessionStart", "PreToolUse", "PostToolUse"];
      const ctx = buildCtx(freshProject(), connectorDeclaring(fully), { dryRun: true });
      const detail = moduleDetail(adapter.installHooks!(ctx));
      expect(detail).not.toContain("unsupported here");
      for (const e of fully) expect(detail).toContain(e);
    });

    it("warn-skips a symlinked generated plugin module without touching the target", () => {
      const projectDir = freshProject();
      const ctx = buildCtx(projectDir, connectorDeclaring(["SessionStart", "PreToolUse", "PostToolUse"]));
      const pluginPath = adapter.getHookConfigPath(ctx);
      mkdirSync(dirname(pluginPath), { recursive: true });
      const outside = join(projectDir, `${adapter.id}-outside-plugin.js`);
      const before = "outside plugin target\n";
      writeFileSync(outside, before, "utf8");
      symlinkSync(outside, pluginPath);

      const changes = adapter.installHooks!(ctx);

      expect(
        changes.some(
          (c) =>
            c.action === "warn" &&
            c.path === pluginPath &&
            /symbolic link/i.test(c.detail ?? ""),
        ),
      ).toBe(true);
      expect(readFileSync(outside, "utf8")).toBe(before);
    });
  });
});
