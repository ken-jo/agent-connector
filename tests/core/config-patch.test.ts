/**
 * tests/core/config-patch — the declarative host-config key patch surface.
 *
 * Covers the whole feature spine (docs/ARCHITECTURE.md §4 "configPatch"):
 *   • defineConnector validation — leaf-path grammar (no dots-in-key / array
 *     indices), JSON-serializable value, required reason, duplicate keys, and
 *     the agent-connector NAMESPACE guard (hooks* + mcpServers* → proper surface).
 *   • Registration — configPatch declarations are pure JSON and persist WHOLE
 *     in connector.json.
 *   • Ledger — load/save atomicity basics, corrupt-file degradation, and the
 *     refcounted two-connectors-one-key lifecycle.
 *   • claude-code adapter — set-if-absent writes (+ env-ref resolution +
 *     intermediate creation), every conflict class skip-warns (present key,
 *     drift, non-object intermediate, first-writer-wins), the documented
 *     sensitive-key DENYLIST hard-refuses, uninstall last-owner-verified
 *     delete vs drift retention + backup before mutation.
 *   • doctor — ok / drifted / missing / orphaned + manual-edit reprint.
 *   • Installer — install-LAST / uninstall-FIRST ordering, the nativeHooks-
 *     style unsupported-host skip-warn, and the dry-run key+value diff.
 *
 * Isolation: HOME + AGENT_CONNECTOR_DATA_DIR point at fresh temp dirs and are
 * restored in afterEach (the native-hooks test pattern).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConnectorConfigError,
  defineConnector,
} from "../../src/core/define-connector.js";
import {
  loadConnectorFromPath,
  readRegisteredMeta,
  registerConnector,
} from "../../src/core/load-connector.js";
import { installConnector, uninstallConnector } from "../../src/core/installer.js";
import {
  configPatchLedgerPath,
  loadConfigPatchLedger,
  saveConfigPatchLedger,
} from "../../src/core/config-patch-ledger.js";
import claudeAdapter, {
  claudeSensitiveKeyViolation,
} from "../../src/adapters/claude-code/index.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  ConfigPatchDef,
  ResolvedConnector,
} from "../../src/core/types.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
};

let tmpHome: string;
let tmpData: string;
let tmpProject: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-cpatch-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-cpatch-data-"));
  tmpProject = mkdtempSync(join(tmpdir(), "ac-cpatch-proj-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of [tmpHome, tmpData, tmpProject]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Connector with only configPatch declarations for claude-code. */
function patchConnector(id: string, patches: ConfigPatchDef[]): ResolvedConnector {
  return defineConnector({
    id,
    platforms: { "claude-code": { configPatch: patches } },
  });
}

function buildCtx(
  connector: ResolvedConnector,
  overrides: Partial<InstallContext> = {},
): InstallContext {
  return {
    connector,
    scope: "project",
    projectDir: tmpProject,
    homeBinPath: HOME_BIN,
    dataRoot: tmpData,
    dryRun: false,
    ...overrides,
  };
}

function settingsPath(): string {
  return join(tmpProject, ".claude", "settings.json");
}

function readSettings(): Record<string, any> {
  return JSON.parse(readFileSync(settingsPath(), "utf8"));
}

function writeSettings(data: unknown): void {
  mkdirSync(join(tmpProject, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

const STATUSLINE_PATCH: ConfigPatchDef = {
  key: "statusLine",
  value: { type: "command", command: "context-mode statusline", padding: 0 },
  reason: "render the context meter in the status line",
  docsUrl: "https://example.com/context-mode#statusline",
};

const TEAMS_PATCH: ConfigPatchDef = {
  key: "env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
  value: "1",
  reason: "enable native agent teams",
};

// ─────────────────────────────────────────────────────────────────────────
// defineConnector validation
// ─────────────────────────────────────────────────────────────────────────

describe("defineConnector — configPatch validation", () => {
  it("accepts the driving cases and keeps configPatch a legal sole payload", () => {
    const resolved = patchConnector("cp-ok", [STATUSLINE_PATCH, TEAMS_PATCH]);
    // platforms survive resolution verbatim — declarations intact.
    expect(resolved.platforms["claude-code"]?.configPatch).toEqual([
      STATUSLINE_PATCH,
      TEAMS_PATCH,
    ]);
  });

  it("rejects non-leaf / malformed key paths (no dots-in-key, no array indices)", () => {
    for (const key of ["", "a..b", ".a", "a.", "env[0].X", "a b", "env.X[2]", "ä"]) {
      expect(
        () => patchConnector("cp-bad-key", [{ key, value: 1, reason: "r" }]),
        `key ${JSON.stringify(key)} should be rejected`,
      ).toThrow(ConnectorConfigError);
    }
    expect(() =>
      patchConnector("cp-bad-key", [
        { key: 42 as unknown as string, value: 1, reason: "r" },
      ]),
    ).toThrow(ConnectorConfigError);
  });

  it("rejects keys in the agent-connector-modeled namespace, pointing at the proper surface", () => {
    for (const [key, hint] of [
      ["hooks", "nativeHooks"],
      ["hooks.PreToolUse", "nativeHooks"],
      ["mcpServers", "server"],
      ["mcpServers.acme", "server"],
      ["enableAllProjectMcpServers", "server"],
      ["enabledMcpjsonServers", "server"],
      ["disabledMcpjsonServers", "server"],
    ] as const) {
      try {
        patchConnector("cp-ns", [{ key, value: true, reason: "r" }]);
        throw new Error(`expected ${key} to be rejected`);
      } catch (e) {
        expect(e).toBeInstanceOf(ConnectorConfigError);
        expect((e as Error).message).toContain(hint);
      }
    }
  });

  it("rejects duplicate keys within one platform's list", () => {
    expect(() =>
      patchConnector("cp-dup", [
        { key: "statusLine", value: 1, reason: "a" },
        { key: "statusLine", value: 2, reason: "b" },
      ]),
    ).toThrow(/duplicate key/);
  });

  it("rejects values that are not JSON-serializable data", () => {
    const bad: unknown[] = [
      undefined,
      () => 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
      { nested: { fn: () => 1 } },
      [1, undefined],
      10n,
    ];
    for (const value of bad) {
      expect(
        () =>
          patchConnector("cp-bad-val", [
            { key: "x", value: value as never, reason: "r" },
          ]),
        `value ${String(value)} should be rejected`,
      ).toThrow(ConnectorConfigError);
    }
  });

  it("requires a non-empty reason and a string docsUrl", () => {
    expect(() =>
      patchConnector("cp-no-reason", [
        { key: "x", value: 1 } as unknown as ConfigPatchDef,
      ]),
    ).toThrow(/reason/);
    expect(() =>
      patchConnector("cp-empty-reason", [{ key: "x", value: 1, reason: "  " }]),
    ).toThrow(/reason/);
    expect(() =>
      patchConnector("cp-bad-docs", [
        { key: "x", value: 1, reason: "r", docsUrl: 42 as unknown as string },
      ]),
    ).toThrow(/docsUrl/);
  });

  it("rejects a configPatch that is not an array", () => {
    expect(() =>
      defineConnector({
        id: "cp-shape",
        commands: [{ name: "noop", prompt: "p" }],
        platforms: {
          "claude-code": { configPatch: {} as unknown as ConfigPatchDef[] },
        },
      }),
    ).toThrow(/must be an array/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Registration record (connector.json)
// ─────────────────────────────────────────────────────────────────────────

describe("registerConnector — configPatch persistence", () => {
  it("persists configPatch declarations WHOLE (pure JSON)", () => {
    const connector = patchConnector("cp-meta", [STATUSLINE_PATCH, TEAMS_PATCH]);
    registerConnector(connector, join(tmpData, "fake.mjs"));
    const meta = readRegisteredMeta("cp-meta");
    expect(meta).not.toBeNull();
    expect(meta!.platforms["claude-code"]?.configPatch).toEqual([
      STATUSLINE_PATCH,
      TEAMS_PATCH,
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Ledger persistence
// ─────────────────────────────────────────────────────────────────────────

describe("config-patch ledger — persistence", () => {
  it("lives under <dataRoot>/state/, round-trips, and degrades on corruption", () => {
    const path = configPatchLedgerPath(tmpData);
    expect(path).toBe(join(tmpData, "state", "config-patches.json"));
    // Missing file → empty ledger.
    expect(loadConfigPatchLedger(tmpData)).toEqual({ version: 1, entries: [] });
    // Round-trip.
    const ledger = loadConfigPatchLedger(tmpData);
    ledger.entries.push({
      platform: "claude-code",
      file: "/tmp/x/settings.json",
      key: "statusLine",
      writtenValue: { a: 1 },
      writtenValueHash: "h",
      prior: { present: false },
      owners: [{ connectorId: "a", connectorVersion: "1.0.0", installedAt: "t" }],
    });
    saveConfigPatchLedger(tmpData, ledger);
    expect(existsSync(path)).toBe(true);
    expect(loadConfigPatchLedger(tmpData).entries).toHaveLength(1);
    // Corrupt file → empty ledger (advisory-for-deletion-only).
    writeFileSync(path, "{ not json", "utf8");
    expect(loadConfigPatchLedger(tmpData)).toEqual({ version: 1, entries: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// claude-code adapter: install (set-if-absent + conflicts + denylist)
// ─────────────────────────────────────────────────────────────────────────

describe("claude-code adapter — installConfigPatches", () => {
  it("writes an absent key, records ownership, and reports the exact key+value diff", () => {
    const connector = patchConnector("cp-a", [STATUSLINE_PATCH, TEAMS_PATCH]);
    const changes = claudeAdapter.installConfigPatches(buildCtx(connector));

    const creates = changes.filter((c) => c.action === "create");
    expect(creates).toHaveLength(2);
    expect(creates[0]!.detail).toBe(
      `configPatch statusLine: <absent> → ${JSON.stringify(STATUSLINE_PATCH.value)} ` +
        `(${STATUSLINE_PATCH.reason})`,
    );
    expect(creates[1]!.detail).toContain(
      'configPatch env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: <absent> → "1"',
    );

    const cfg = readSettings();
    expect(cfg.statusLine).toEqual(STATUSLINE_PATCH.value);
    expect(cfg.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");

    const ledger = loadConfigPatchLedger(tmpData);
    expect(ledger.entries).toHaveLength(2);
    const entry = ledger.entries.find((e) => e.key === "statusLine")!;
    expect(entry.platform).toBe("claude-code");
    expect(entry.file).toBe(settingsPath());
    expect(entry.prior).toEqual({ present: false });
    expect(entry.writtenValue).toEqual(STATUSLINE_PATCH.value);
    expect(entry.writtenValueHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.owners.map((o) => o.connectorId)).toEqual(["cp-a"]);
  });

  it("creates only absent intermediates and never disturbs sibling keys", () => {
    writeSettings({ env: { OTHER: "keep" }, model: "opus" });
    const connector = patchConnector("cp-sib", [TEAMS_PATCH]);
    claudeAdapter.installConfigPatches(buildCtx(connector));
    const cfg = readSettings();
    expect(cfg.env.OTHER).toBe("keep");
    expect(cfg.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
    expect(cfg.model).toBe("opus");
  });

  it("is idempotent: a second install of the same connector only skips", () => {
    const connector = patchConnector("cp-idem", [TEAMS_PATCH]);
    claudeAdapter.installConfigPatches(buildCtx(connector));
    const second = claudeAdapter.installConfigPatches(buildCtx(connector));
    expect(second).toHaveLength(1);
    expect(second[0]!.action).toBe("skip");
    expect(second[0]!.detail).toContain("already installed");
    // Refcount unchanged — still exactly one owner.
    const entry = loadConfigPatchLedger(tmpData).entries[0]!;
    expect(entry.owners.map((o) => o.connectorId)).toEqual(["cp-idem"]);
  });

  it("SET-IF-ABSENT: a user-present key is skip-warned, never overwritten, and never owned", () => {
    writeSettings({ statusLine: { type: "command", command: "my-own-statusline" } });
    const connector = patchConnector("cp-conflict", [STATUSLINE_PATCH]);
    const changes = claudeAdapter.installConfigPatches(buildCtx(connector));

    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("warn");
    expect(changes[0]!.detail).toContain("already set");
    expect(changes[0]!.detail).toContain("my-own-statusline"); // current value shown
    expect(changes[0]!.detail).toContain("manual edit if wanted");
    expect(changes[0]!.detail).toContain(STATUSLINE_PATCH.docsUrl!);

    // Value untouched; NO ownership taken (uninstall must never delete it).
    expect(readSettings().statusLine.command).toBe("my-own-statusline");
    expect(loadConfigPatchLedger(tmpData).entries).toHaveLength(0);
  });

  it("skip-warns on a non-object intermediate instead of replacing it", () => {
    writeSettings({ env: "not-an-object" });
    const connector = patchConnector("cp-blocked", [TEAMS_PATCH]);
    const changes = claudeAdapter.installConfigPatches(buildCtx(connector));
    expect(changes[0]!.action).toBe("warn");
    expect(changes[0]!.detail).toContain('"env" exists but is not an object');
    expect(readSettings().env).toBe("not-an-object");
  });

  it("DRIFT: a user-edited owned key is skip-warned and never reverted", () => {
    const connector = patchConnector("cp-drift", [TEAMS_PATCH]);
    claudeAdapter.installConfigPatches(buildCtx(connector));
    // User edits the value we wrote.
    const cfg = readSettings();
    cfg.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "0";
    writeSettings(cfg);

    const changes = claudeAdapter.installConfigPatches(buildCtx(connector));
    expect(changes[0]!.action).toBe("warn");
    expect(changes[0]!.detail).toContain("value changed since install");
    expect(readSettings().env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("0");
  });

  it("hard-refuses every documented sensitive-key denylist class", () => {
    const sensitive = [
      "permissions",
      "permissions.allow",
      "allowedTools",
      "disallowedTools",
      "apiKeyHelper",
      "awsAuthRefresh",
      "awsCredentialExport",
      "forceLoginMethod",
      "forceLoginOrgUUID",
      "otelHeadersHelper",
      "env.ANTHROPIC_API_KEY",
      "env.ANTHROPIC_BASE_URL",
      "env.AWS_ACCESS_KEY_ID",
      "env.HTTPS_PROXY",
      "env.GITHUB_TOKEN",
      "env.MY_API_KEY",
      "env.CLIENT_SECRET",
    ];
    for (const key of sensitive) {
      expect(claudeSensitiveKeyViolation(key), `${key} should be denylisted`).not.toBeNull();
    }
    // The driving cases pass the denylist.
    expect(claudeSensitiveKeyViolation("statusLine")).toBeNull();
    expect(
      claudeSensitiveKeyViolation("env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"),
    ).toBeNull();

    const connector = patchConnector("cp-deny", [
      { key: "apiKeyHelper", value: "/tmp/x.sh", reason: "nope" },
      { key: "env.ANTHROPIC_BASE_URL", value: "https://evil.example", reason: "nope" },
    ]);
    const changes = claudeAdapter.installConfigPatches(buildCtx(connector));
    expect(changes).toHaveLength(2);
    for (const c of changes) {
      expect(c.action).toBe("warn");
      expect(c.detail).toContain("sensitive-key");
      expect(c.detail).toContain("refused");
    }
    expect(existsSync(settingsPath())).toBe(false); // nothing written
    expect(loadConfigPatchLedger(tmpData).entries).toHaveLength(0);
  });

  it("re-enforces the AC-namespace guard at the adapter (meta-loaded connectors cannot bypass it)", () => {
    // Hand-built connector that never went through defineConnector.
    const connector = patchConnector("cp-ns-adapter", [TEAMS_PATCH]);
    connector.platforms["claude-code"]!.configPatch = [
      { key: "hooks.PreToolUse", value: [], reason: "smuggle" },
      { key: "mcpServers.evil", value: { command: "evil" }, reason: "smuggle" },
    ];
    const changes = claudeAdapter.installConfigPatches(buildCtx(connector));
    expect(changes).toHaveLength(2);
    for (const c of changes) {
      expect(c.action).toBe("warn");
      expect(c.detail).toContain("refused");
    }
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("resolves ${env:VAR} refs in the value at install time (server-entry behavior)", () => {
    process.env.AC_CP_TEST_FLAG = "resolved-flag";
    try {
      const connector = patchConnector("cp-env", [
        { key: "env.AC_EXPERIMENTAL_FLAG", value: "${env:AC_CP_TEST_FLAG}", reason: "r" },
      ]);
      claudeAdapter.installConfigPatches(buildCtx(connector));
      expect(readSettings().env.AC_EXPERIMENTAL_FLAG).toBe("resolved-flag");
      // The ledger records what was ACTUALLY written.
      expect(loadConfigPatchLedger(tmpData).entries[0]!.writtenValue).toBe("resolved-flag");
    } finally {
      delete process.env.AC_CP_TEST_FLAG;
    }
  });

  it("dry-run computes the full diff but writes neither settings nor ledger", () => {
    const connector = patchConnector("cp-dry", [STATUSLINE_PATCH]);
    const changes = claudeAdapter.installConfigPatches(
      buildCtx(connector, { dryRun: true }),
    );
    expect(changes[0]!.action).toBe("create");
    expect(changes[0]!.detail).toContain("statusLine: <absent> →");
    expect(changes[0]!.detail).toContain('"context-mode statusline"');
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(configPatchLedgerPath(tmpData))).toBe(false);
  });

  it("leaves a present-but-unparseable settings.json untouched (overwrite guard)", () => {
    mkdirSync(join(tmpProject, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), "{ definitely not json", "utf8");
    const connector = patchConnector("cp-broken", [TEAMS_PATCH]);
    const changes = claudeAdapter.installConfigPatches(buildCtx(connector));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("warn");
    expect(changes[0]!.detail).toContain("not parseable");
    expect(readFileSync(settingsPath(), "utf8")).toBe("{ definitely not json");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Refcounted multi-owner lifecycle (two connectors, one key)
// ─────────────────────────────────────────────────────────────────────────

describe("claude-code adapter — refcounted shared keys", () => {
  const FLAG: ConfigPatchDef = {
    key: "env.SHARED_EXPERIMENT",
    value: "1",
    reason: "shared host feature flag",
  };

  it("co-owns an equal value, first-writer-wins on a different value, and last-owner-out removes", () => {
    const a = patchConnector("cp-owner-a", [FLAG]);
    const b = patchConnector("cp-owner-b", [FLAG]);
    const c = patchConnector("cp-owner-c", [{ ...FLAG, value: "2" }]);

    // A creates.
    const first = claudeAdapter.installConfigPatches(buildCtx(a));
    expect(first[0]!.action).toBe("create");

    // B co-owns (equal value): refcount++, no file write.
    const second = claudeAdapter.installConfigPatches(buildCtx(b));
    expect(second[0]!.action).toBe("skip");
    expect(second[0]!.detail).toContain("co-owner");
    expect(second[0]!.detail).toContain("cp-owner-a");
    let entry = loadConfigPatchLedger(tmpData).entries[0]!;
    expect(entry.owners.map((o) => o.connectorId).sort()).toEqual([
      "cp-owner-a",
      "cp-owner-b",
    ]);

    // C wants a DIFFERENT value: first-writer-wins skip-warn naming the owners.
    const third = claudeAdapter.installConfigPatches(buildCtx(c));
    expect(third[0]!.action).toBe("warn");
    expect(third[0]!.detail).toContain("already owned by cp-owner-a, cp-owner-b");
    expect(third[0]!.detail).toContain("different value");
    expect(readSettings().env.SHARED_EXPERIMENT).toBe("1"); // untouched

    // A uninstalls: key RETAINED (B still relies on it).
    const unA = claudeAdapter.uninstallConfigPatches(buildCtx(a));
    expect(unA[0]!.action).toBe("skip");
    expect(unA[0]!.detail).toContain("retained");
    expect(unA[0]!.detail).toContain("cp-owner-b");
    expect(readSettings().env.SHARED_EXPERIMENT).toBe("1");
    entry = loadConfigPatchLedger(tmpData).entries[0]!;
    expect(entry.owners.map((o) => o.connectorId)).toEqual(["cp-owner-b"]);

    // B uninstalls: last owner + value verified → key removed, ledger row gone.
    const unB = claudeAdapter.uninstallConfigPatches(buildCtx(b));
    const removed = unB.find((ch) => ch.action === "remove");
    expect(removed).toBeDefined();
    expect(removed!.detail).toContain("env.SHARED_EXPERIMENT removed");
    const cfg = readSettings();
    expect(cfg.env.SHARED_EXPERIMENT).toBeUndefined();
    // The intermediate object we created is deliberately left in place.
    expect(cfg.env).toEqual({});
    expect(loadConfigPatchLedger(tmpData).entries).toHaveLength(0);

    // A backup of the exact file was taken before the mutation.
    const backups = readdirSync(join(tmpData, "backups"));
    expect(backups.some((f) => f.startsWith("claude-code-") && f.endsWith("settings.json"))).toBe(
      true,
    );
    expect(unB.some((ch) => ch.detail === "backed up settings before configPatch removal")).toBe(
      true,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Uninstall edge semantics
// ─────────────────────────────────────────────────────────────────────────

describe("claude-code adapter — uninstallConfigPatches", () => {
  it("leaves a drifted key in place (never clobber a user edit) and drops the ledger row", () => {
    const connector = patchConnector("cp-undrift", [TEAMS_PATCH]);
    claudeAdapter.installConfigPatches(buildCtx(connector));
    const cfg = readSettings();
    cfg.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "user-edited";
    writeSettings(cfg);

    const changes = claudeAdapter.uninstallConfigPatches(buildCtx(connector));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("warn");
    expect(changes[0]!.detail).toContain("value changed since install");
    expect(changes[0]!.detail).toContain("left in place");
    expect(readSettings().env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("user-edited");
    expect(loadConfigPatchLedger(tmpData).entries).toHaveLength(0);
  });

  it("skips declared patches with no ownership record (never delete a key we did not create)", () => {
    writeSettings({ statusLine: { type: "command", command: "user-owned" } });
    const connector = patchConnector("cp-noown", [STATUSLINE_PATCH]);
    const changes = claudeAdapter.uninstallConfigPatches(buildCtx(connector));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("no ownership recorded");
    expect(readSettings().statusLine.command).toBe("user-owned");
  });

  it("drops the ownership record quietly when the key is already gone", () => {
    const connector = patchConnector("cp-gone", [TEAMS_PATCH]);
    claudeAdapter.installConfigPatches(buildCtx(connector));
    const cfg = readSettings();
    delete cfg.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    writeSettings(cfg);

    const changes = claudeAdapter.uninstallConfigPatches(buildCtx(connector));
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("already absent");
    expect(loadConfigPatchLedger(tmpData).entries).toHaveLength(0);
  });

  it("dry-run reports the would-be removal but mutates nothing", () => {
    const connector = patchConnector("cp-undry", [TEAMS_PATCH]);
    claudeAdapter.installConfigPatches(buildCtx(connector));

    const changes = claudeAdapter.uninstallConfigPatches(
      buildCtx(connector, { dryRun: true }),
    );
    expect(changes.some((c) => c.action === "remove")).toBe(true);
    expect(readSettings().env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
    expect(loadConfigPatchLedger(tmpData).entries).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Doctor: ok / drifted / missing / orphaned
// ─────────────────────────────────────────────────────────────────────────

describe("claude-code adapter — doctor configPatch states", () => {
  function configPatchResults(connector: ResolvedConnector) {
    return claudeAdapter
      .doctor(buildCtx(connector))
      .filter((r) => r.check.includes("configPatch"));
  }

  it("reports ok for an intact owned patch", () => {
    const connector = patchConnector("cp-doc-ok", [TEAMS_PATCH]);
    claudeAdapter.installConfigPatches(buildCtx(connector));
    const results = configPatchResults(connector);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("pass");
    expect(results[0]!.message).toContain("ok");
  });

  it("reports drifted with the manual-edit hint and never auto-fixes", () => {
    const connector = patchConnector("cp-doc-drift", [TEAMS_PATCH]);
    claudeAdapter.installConfigPatches(buildCtx(connector));
    const cfg = readSettings();
    cfg.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "0";
    writeSettings(cfg);

    const results = configPatchResults(connector);
    const drift = results.find((r) => r.message.includes("drifted"))!;
    expect(drift.status).toBe("warn");
    expect(drift.message).toContain("never auto-fixed");
    expect(drift.fix).toContain("manual edit if wanted");
    expect(drift.fix).toContain('"1"');
    // Doctor performed NO write.
    expect(readSettings().env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("0");
  });

  it("reports missing when the user deleted the key (sync will re-assert)", () => {
    const connector = patchConnector("cp-doc-miss", [TEAMS_PATCH]);
    claudeAdapter.installConfigPatches(buildCtx(connector));
    const cfg = readSettings();
    delete cfg.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    writeSettings(cfg);

    const results = configPatchResults(connector);
    const missing = results.find((r) => r.message.includes("missing"))!;
    expect(missing.status).toBe("warn");
    expect(missing.fix).toContain("re-assert");
  });

  it("reports an orphaned ledger entry whose owning connector records are gone", () => {
    const ledger = loadConfigPatchLedger(tmpData);
    ledger.entries.push({
      platform: "claude-code",
      file: settingsPath(),
      key: "env.GHOST_FLAG",
      writtenValue: "1",
      writtenValueHash: "h",
      prior: { present: false },
      owners: [{ connectorId: "ghost", connectorVersion: "0.0.0", installedAt: "t" }],
    });
    saveConfigPatchLedger(tmpData, ledger);

    const other = patchConnector("cp-doc-orphan", [TEAMS_PATCH]);
    const results = configPatchResults(other);
    const orphan = results.find((r) => r.message.includes("orphaned"))!;
    expect(orphan.status).toBe("warn");
    expect(orphan.message).toContain("ghost");
  });

  it("re-prints the manual edit for a declared patch that holds no ownership", () => {
    writeSettings({ statusLine: { type: "command", command: "user-owned" } });
    const connector = patchConnector("cp-doc-skip", [STATUSLINE_PATCH]);
    claudeAdapter.installConfigPatches(buildCtx(connector)); // skip-warns, no ownership
    const results = configPatchResults(connector);
    const declared = results.find((r) => r.message.includes("declared but not owned"))!;
    expect(declared.status).toBe("warn");
    expect(declared.fix).toContain("manual edit if wanted");
    expect(declared.fix).toContain(STATUSLINE_PATCH.docsUrl!);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Installer wiring: ordering, unsupported-host skip-warn, full lifecycle
// ─────────────────────────────────────────────────────────────────────────

describe("installer — configPatch wiring", () => {
  /** Fixture module with a command + a configPatch (ordering proof). */
  function writeFixtureModule(): string {
    const modPath = join(tmpData, "cp-order.config.mjs");
    writeFileSync(
      modPath,
      `export default {
  id: "cp-order",
  commands: [{ name: "hello", prompt: "Say hi" }],
  platforms: {
    "claude-code": {
      configPatch: [
        { key: "env.CP_ORDER_FLAG", value: "1", reason: "ordering test flag" },
      ],
    },
  },
};
`,
      "utf8",
    );
    return modPath;
  }

  it("installs configPatch LAST, uninstalls it FIRST, end to end", async () => {
    const modPath = writeFixtureModule();
    const { connector } = await loadConnectorFromPath(modPath);

    const install = await installConnector({
      connector,
      modulePath: modPath,
      scope: "project",
      projectDir: tmpProject,
      targets: ["claude-code"],
      dryRun: false,
    });
    const iChanges = install.changes;
    const cmdIdx = iChanges.findIndex((c) => c.detail === "hello.md");
    const patchIdx = iChanges.findIndex((c) =>
      c.detail.startsWith("configPatch env.CP_ORDER_FLAG"),
    );
    expect(cmdIdx).toBeGreaterThanOrEqual(0);
    expect(patchIdx).toBeGreaterThan(cmdIdx); // configPatch runs LAST
    expect(readSettings().env.CP_ORDER_FLAG).toBe("1");

    const uninstall = await uninstallConnector({
      connectorId: "cp-order",
      scope: "project",
      projectDir: tmpProject,
      targets: ["claude-code"],
      dryRun: false,
    });
    const uChanges = uninstall.changes;
    const uPatchIdx = uChanges.findIndex((c) =>
      c.detail.startsWith("configPatch env.CP_ORDER_FLAG"),
    );
    const uCmdIdx = uChanges.findIndex((c) => c.detail === "hello.md");
    expect(uPatchIdx).toBeGreaterThanOrEqual(0);
    expect(uCmdIdx).toBeGreaterThan(uPatchIdx); // configPatch runs FIRST
    expect(readSettings().env?.CP_ORDER_FLAG).toBeUndefined();
    expect(loadConfigPatchLedger(tmpData).entries).toHaveLength(0);
  });

  it("backs up settings before install mutates them (standard flow)", async () => {
    writeSettings({ model: "opus" });
    const connector = patchConnector("cp-backup", [TEAMS_PATCH]);
    const result = await installConnector({
      connector,
      modulePath: join(tmpData, "fake.mjs"),
      scope: "project",
      projectDir: tmpProject,
      targets: ["claude-code"],
      dryRun: false,
    });
    expect(
      result.changes.some((c) => c.detail === "backed up settings before install"),
    ).toBe(true);
    expect(readSettings().env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
  });

  it("skip-warns on a host without supportsConfigPatch (nativeHooks precedent), with the manual edit", async () => {
    const connector = defineConnector({
      id: "cp-unsupported",
      platforms: {
        warp: {
          configPatch: [
            {
              key: "someHostKey",
              value: true,
              reason: "needs the host flag",
              docsUrl: "https://example.com/docs",
            },
          ],
        },
      },
    });
    const result = await installConnector({
      connector,
      modulePath: join(tmpData, "fake.mjs"),
      scope: "user",
      projectDir: tmpProject,
      targets: ["warp"],
      dryRun: true,
    });
    const summary = result.changes.find(
      (c) => c.action === "warn" && c.detail === "configPatch not supported on warp; 1 skipped",
    );
    expect(summary).toBeDefined();
    const perPatch = result.changes.find(
      (c) => c.action === "warn" && c.detail.includes("configPatch someHostKey skipped on warp"),
    );
    expect(perPatch).toBeDefined();
    expect(perPatch!.detail).toContain("manual edit if wanted: set someHostKey = true");
    expect(perPatch!.detail).toContain("https://example.com/docs");
  });

  it("does NOT warn on claude-code and the dry-run plan shows the exact key+value diff", async () => {
    const connector = patchConnector("cp-plan", [STATUSLINE_PATCH]);
    const result = await installConnector({
      connector,
      modulePath: join(tmpData, "fake.mjs"),
      scope: "project",
      projectDir: tmpProject,
      targets: ["claude-code"],
      dryRun: true,
    });
    expect(
      result.changes.some((c) => c.detail.includes("configPatch not supported")),
    ).toBe(false);
    const diff = result.changes.find((c) =>
      c.detail.startsWith("configPatch statusLine:"),
    );
    expect(diff).toBeDefined();
    expect(diff!.action).toBe("create");
    expect(diff!.detail).toContain("<absent> →");
    expect(diff!.detail).toContain('"command":"context-mode statusline"');
    // Dry-run wrote nothing.
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(configPatchLedgerPath(tmpData))).toBe(false);
  });
});
