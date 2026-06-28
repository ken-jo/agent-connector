/**
 * core/base-adapter-surfaces — BaseAdapter default content-surface handling.
 *
 * An adapter that does NOT support content surfaces (e.g. warp, which leaves the
 * supports* capability flags undefined and never overrides the install* methods)
 * inherits BaseAdapter's defaults: a single "warn" ChangeRecord when the
 * connector declares that surface, or a single "skip" when it declares none.
 * This mirrors the mcp-only hook handling and must NEVER throw or write files.
 *
 * This exercises the BASE CLASS (BaseAdapter), not warp-specific behaviour — warp
 * is only the stand-in that leaves the supports* flags undefined — so it lives in
 * tests/core (it is not a per-host adapter suite and does NOT use
 * createAdapterSuite). Adopts the shared harness (tests/support/env).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { BaseAdapter } from "../../src/adapters/base.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  ChangeRecord,
  DetectedPlatform,
  PlatformCapabilities,
  PlatformId,
} from "../../src/core/types.js";

import warpAdapter from "../../src/adapters/warp/index.js";

import { buildCtx, freshProject, isolateEnv, tempDir } from "../support/env.js";
import { symlinkOrSkipTest } from "../support/symlink.js";

isolateEnv();

describe("BaseAdapter — unsupported content surfaces (warp)", () => {
  it("declares skills (Agent Skills) but NOT commands or subagents", () => {
    // Warp ships Agent Skills (.agents/skills); commands + subagents remain
    // unsupported, so they exercise BaseAdapter's warn/skip fallback below.
    expect(warpAdapter.capabilities.supportsSkills ?? false).toBe(true);
    expect(warpAdapter.capabilities.supportsCommands ?? false).toBe(false);
    expect(warpAdapter.capabilities.supportsSubagents ?? false).toBe(false);
  });

  it("warns (and skips) when a connector declares commands it cannot honor", () => {
    const connector = defineConnector({
      id: "acme-cmd",
      commands: [
        { name: "deploy", prompt: "Deploy it." },
        { name: "rollback", prompt: "Roll it back." },
      ],
    });
    const ctx = buildCtx(freshProject(), connector);

    const changes = warpAdapter.installCommands!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("commands not supported on warp");
    expect(changes[0]?.detail).toContain("2 skipped");

    // No command file was written.
    expect(existsSync(join(ctx.projectDir, ".warp", "commands"))).toBe(false);
    expect(existsSync(join(ctx.projectDir, ".claude", "commands"))).toBe(false);
  });

  it("skips (no warn) when the connector declares NO commands", () => {
    const connector = defineConnector({
      id: "acme-nocmd",
      server: { transport: "stdio", command: "node" },
    });
    const ctx = buildCtx(freshProject(), connector);

    const changes = warpAdapter.installCommands!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("declares no commands");
  });

  it("warns for subagents the same way (install and uninstall)", () => {
    // skills are now supported on warp; subagents remain the unsupported
    // content surface that exercises BaseAdapter's warn path.
    const connector = defineConnector({
      id: "acme-rich",
      subagents: [
        {
          name: "a",
          description: "d",
          prompt: "p",
          extra: { "x-native-only": true },
        },
      ],
    });
    const ctx = buildCtx(freshProject(), connector);

    for (const fn of [
      warpAdapter.installSubagents!,
      warpAdapter.uninstallSubagents!,
    ]) {
      const changes = fn.call(warpAdapter, ctx);
      expect(changes[0]?.action).toBe("warn");
      expect(changes[0]?.detail).toContain("subagents not supported on warp");
    }

    // Unsupported hosts must not invent a subagent surface just because the
    // connector supplied host-specific escape-hatch fields.
    expect(existsSync(join(ctx.projectDir, ".warp", "agents"))).toBe(false);
    expect(existsSync(join(ctx.projectDir, ".codex", "agents"))).toBe(false);
  });
});

/**
 * BaseAdapter — malformed JSON ROOT-KEY guard (upsertServerInJson /
 * removeServerFromJson). The two shared JSON helpers every object-map server
 * host routes through must NEVER corrupt a config whose root key the user
 * hand-edited to the wrong type:
 *   • Array root  (`"mcpServers": []`): assigning a named property onto an Array
 *     is dropped by JSON.stringify — silent data loss reported as a false
 *     "create".
 *   • String root (`"mcpServers": "foo"`): under strict mode a property write
 *     (upsert) and the `in` operator (remove) BOTH THROW against a primitive.
 * The guard turns all four cases into a visible warn-skip that leaves the file
 * byte-for-byte intact. This is the focused proof of BOTH root types and BOTH
 * methods; the registry contract (tests/contracts/root-key-malformed) is the
 * auto-coverage half for the array case across every real host.
 *
 * Exercises the BASE CLASS via a minimal stand-in subclass (the
 * base-adapter-surfaces pattern), so it lives in tests/core and uses no
 * per-host install path.
 */
class RootKeyProbe extends BaseAdapter {
  readonly id = "root-key-probe" as PlatformId;
  readonly name = "Root Key Probe";
  readonly paradigm = "json-stdio" as const;
  readonly capabilities: PlatformCapabilities = {};
  detectInstalled(): DetectedPlatform {
    return {
      id: this.id,
      name: this.name,
      installed: false,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath: "",
      scope: "user",
      reason: "stub",
      confidence: "low",
    };
  }
  getConfigDir(ctx: InstallContext): string {
    return ctx.projectDir;
  }
  getServerConfigPath(ctx: InstallContext): string {
    return join(ctx.projectDir, "mcp.json");
  }
  getHookConfigPath(ctx: InstallContext): string {
    return this.getServerConfigPath(ctx);
  }
  installServer(): ChangeRecord[] {
    return [];
  }
  uninstallServer(): ChangeRecord[] {
    return [];
  }
  installHooks(): ChangeRecord[] {
    return [];
  }
  uninstallHooks(): ChangeRecord[] {
    return [];
  }
  // Expose the protected JSON helpers for the focused assertions below.
  upsert(path: string, rootKey: string, id: string, entry: unknown): ChangeRecord {
    return this.upsertServerInJson(path, rootKey, id, entry);
  }
  remove(path: string, rootKey: string, id: string): ChangeRecord {
    return this.removeServerFromJson(path, rootKey, id);
  }
  hookSkip(path: string, hooksRoot: unknown): ChangeRecord | null {
    return this.malformedHookRootSkip(path, hooksRoot);
  }
}

describe("BaseAdapter — malformed JSON root-key guard (warn-skip, file preserved, no throw)", () => {
  const probe = new RootKeyProbe();
  const ROOT_KEY = "mcpServers";

  function seed(value: unknown): { path: string; before: string } {
    const dir = tempDir("ac-rootkey-");
    const path = join(dir, "mcp.json");
    const before = `${JSON.stringify({ [ROOT_KEY]: value }, null, 2)}\n`;
    writeFileSync(path, before, "utf8");
    return { path, before };
  }

  // Both helpers, against both malformed root shapes (array drops silently;
  // primitive throws), table-driven so each cell is its own assertion.
  for (const rootValue of [[] as unknown, "foo" as unknown]) {
    const label = Array.isArray(rootValue) ? "array root" : "string root";

    it(`upsertServerInJson warns + preserves the file (${label})`, () => {
      const { path, before } = seed(rootValue);

      let change!: ChangeRecord;
      expect(() => {
        change = probe.upsert(path, ROOT_KEY, "acme-db", { command: "node" });
      }).not.toThrow();

      expect(change.action).toBe("warn");
      expect(change.path).toBe(path);
      expect(change.detail).toContain(ROOT_KEY);
      expect(change.detail).toContain("not an object map");
      // File untouched byte-for-byte — the user's malformed value preserved.
      expect(readFileSync(path, "utf8")).toBe(before);
    });

    it(`removeServerFromJson warns + preserves the file (${label})`, () => {
      const { path, before } = seed(rootValue);

      let change!: ChangeRecord;
      expect(() => {
        change = probe.remove(path, ROOT_KEY, "acme-db");
      }).not.toThrow();

      expect(change.action).toBe("warn");
      expect(change.path).toBe(path);
      expect(change.detail).toContain(ROOT_KEY);
      expect(change.detail).toContain("not an object map");
      expect(readFileSync(path, "utf8")).toBe(before);
    });
  }

  it("a well-formed object-map root still upserts (guard does not over-trigger)", () => {
    const { path } = seed({});
    const change = probe.upsert(path, ROOT_KEY, "acme-db", { command: "node" });
    expect(change.action).toBe("create");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    expect(parsed[ROOT_KEY]["acme-db"]).toEqual({ command: "node" });
  });

  it("upsertServerInJson warns and preserves a symlink target", () => {
    const dir = tempDir("ac-rootkey-link-");
    const outside = join(dir, "outside.json");
    const link = join(dir, "mcp.json");
    const before = `${JSON.stringify({ outside: true }, null, 2)}\n`;
    writeFileSync(outside, before, "utf8");
    if (!symlinkOrSkipTest(outside, link)) return;

    const change = probe.upsert(link, ROOT_KEY, "acme-db", { command: "node" });

    expect(change.action).toBe("warn");
    expect(change.path).toBe(link);
    expect(change.detail).toMatch(/symbolic link/i);
    expect(readFileSync(outside, "utf8")).toBe(before);
  });
});

/**
 * BaseAdapter — malformed JSON `hooks` ROOT guard (malformedHookRootSkip). The
 * shared warn-skip every JSON object-map HOOK host routes through must surface a
 * `warn` (and NOT proceed) for a present-but-malformed hooks config, while
 * returning null for the well-formed and absent cases so installs proceed
 * normally. `??=` only substitutes on null/undefined, so a present array/primitive
 * root or a non-array event bucket would otherwise silently drop the entry (array
 * → JSON.stringify drops a named property) or throw (`.push` against a non-array).
 * This is the focused proof; the registry contract (tests/contracts/
 * hook-root-malformed) is the auto-coverage half across every real host.
 */
describe("BaseAdapter — malformed JSON hooks-root guard (warn-skip predicate)", () => {
  const probe = new RootKeyProbe();
  const PATH = "/tmp/ac-probe/hooks.json";

  it("returns null for the absent case (null / undefined → installer creates fresh)", () => {
    expect(probe.hookSkip(PATH, null)).toBeNull();
    expect(probe.hookSkip(PATH, undefined)).toBeNull();
  });

  it("returns null for a well-formed object map (guard does not over-trigger)", () => {
    expect(probe.hookSkip(PATH, {})).toBeNull();
    expect(probe.hookSkip(PATH, { PreToolUse: [], PostToolUse: [{ matcher: "" }] })).toBeNull();
  });

  it("warns for an ARRAY root (named-property write dropped by JSON.stringify)", () => {
    const change = probe.hookSkip(PATH, []);
    expect(change?.action).toBe("warn");
    expect(change?.path).toBe(PATH);
    expect(change?.detail).toContain("not an object map");
  });

  it("warns for a PRIMITIVE root (property write throws under strict mode)", () => {
    for (const primitive of ["x" as unknown, 7 as unknown, true as unknown]) {
      const change = probe.hookSkip(PATH, primitive);
      expect(change?.action).toBe("warn");
      expect(change?.detail).toContain("not an object map");
    }
  });

  it("warns for a NON-ARRAY event bucket inside an otherwise-valid root", () => {
    const change = probe.hookSkip(PATH, { PreToolUse: "oops" });
    expect(change?.action).toBe("warn");
    expect(change?.detail).toContain("non-array event bucket");
  });
});
