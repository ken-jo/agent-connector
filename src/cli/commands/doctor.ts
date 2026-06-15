/**
 * cli/commands/doctor — health-check every detected platform.
 *
 * For each detected host (or the explicit --targets list) we load its adapter,
 * build a uniform InstallContext, and run adapter.doctor(ctx). Results are
 * printed as pass/warn/fail with any suggested fix. Exit code is non-zero when
 * any check fails (warns alone do not fail the command).
 *
 * The connector context comes from the local config when present; otherwise a
 * minimal id-only connector is used so path-only checks still run.
 */

import { parseArgs } from "node:util";

import type {
  DiagnosticResult,
  InstallScope,
  PlatformId,
  ResolvedConnector,
} from "../../core/types.js";
import type { InstallContext } from "../../adapters/spi.js";
import { detectInstalledPlatforms } from "../../adapters/detect.js";
import { loadAdapter, REGISTERED_PLATFORM_IDS } from "../../adapters/registry.js";
import {
  findConnectorConfig,
  listRegisteredConnectors,
  loadConnectorFromPath,
  readRegisteredMeta,
} from "../../core/load-connector.js";
import { syncConnector } from "../../core/installer.js";
import { marketplaceDoctorChecks } from "../../core/marketplace.js";
import { readMarketplaceInstalls } from "../../core/marketplace-state.js";
import { dataRoot, homeBinPath } from "../../core/paths.js";
import { probeStdioServer } from "../../runtime/probe.js";
import { fail, parseScope, parseTargets, print } from "../app.js";

const STATUS_GLYPH: Record<DiagnosticResult["status"], string> = {
  pass: "[pass]",
  warn: "[warn]",
  fail: "[FAIL]",
};

/** A resolved connector together with the path to its source module. */
interface ConnectorEntry {
  connector: ResolvedConnector;
  /** Absolute path to the connector source (JSON or JS/TS). Used by syncConnector. */
  modulePath: string;
}

/**
 * Resolve which connector(s) doctor should health-check, in precedence order:
 *   1. An explicit --connector path, or a local agent-connector.config.* file.
 *   2. Every connector registered under the data-root (what is actually
 *      installed). This is the common case — `doctor` from anywhere reports on
 *      the real installs, not a guess from the working directory.
 *   3. A minimal id-only placeholder so path-only checks still run.
 */
async function resolveDoctorConnectors(
  connectorPath: string | undefined,
  projectDir: string,
): Promise<ConnectorEntry[]> {
  const configPath = connectorPath ?? findConnectorConfig(projectDir);
  if (configPath) {
    try {
      const { connector, modulePath } = await loadConnectorFromPath(configPath);
      return [{ connector, modulePath }];
    } catch {
      /* fall through */
    }
  }

  const registered = listRegisteredConnectors();
  if (registered.length > 0) {
    return registered.map((connector) => {
      const meta = readRegisteredMeta(connector.id);
      return { connector, modulePath: meta?.modulePath ?? "" };
    });
  }

  const fallback: ResolvedConnector = {
    id: "agent-connector",
    displayName: "agent-connector",
    version: "0.0.0",
    hooks: {},
    hookEvents: [],
    telemetry: {
      enabled: true,
      modelFamilyHint: "auto",
      measureToolDefs: true,
      hostNativeUsage: false,
      store: "ndjson",
      calibration: { anthropicCountTokens: false },
    },
    commands: [],
    skills: [],
    subagents: [],
    memory: [],
    actions: [],
    platforms: {},
    targets: "auto",
  };
  return [{ connector: fallback, modulePath: "" }];
}

function buildContext(
  connector: ResolvedConnector,
  id: PlatformId,
  scope: InstallScope,
  projectDir: string,
): InstallContext {
  return {
    connector,
    scope: connector.platforms[id]?.scope ?? scope,
    projectDir,
    homeBinPath: homeBinPath(),
    dataRoot: dataRoot(),
    dryRun: true,
  };
}

/** Collected diagnostics tagged with the connector entry they came from. */
interface TaggedResult {
  result: DiagnosticResult;
  /** Index into the entries array — used to group by connector for heal. */
  entryIndex: number;
}

/**
 * Run all diagnostic checks for the given entries/ids and return tagged results
 * plus the flat byPlatform buckets for display.
 */
async function collectDiagnostics(
  entries: ConnectorEntry[],
  ids: PlatformId[],
  scope: InstallScope,
  projectDir: string,
): Promise<{
  byPlatform: { platform: PlatformId; results: DiagnosticResult[] }[];
  tagged: TaggedResult[];
  anyFail: boolean;
}> {
  const multi = entries.length > 1;
  const byPlatform: { platform: PlatformId; results: DiagnosticResult[] }[] = [];
  const tagged: TaggedResult[] = [];
  let anyFail = false;

  for (const id of ids) {
    const adapter = await loadAdapter(id);
    if (!adapter) {
      const r: DiagnosticResult = {
        check: `${id}: adapter`,
        status: "fail",
        message: `no adapter registered for ${id}`,
      };
      byPlatform.push({ platform: id, results: [r] });
      anyFail = true;
      continue;
    }
    const results: DiagnosticResult[] = [];
    for (let i = 0; i < entries.length; i++) {
      const { connector } = entries[i]!;
      // A connector with an explicit target list is only checked on those hosts.
      if (connector.targets !== "auto" && !connector.targets.includes(id)) continue;

      // MARKETPLACE-installed on this host: its surfaces are delivered via the
      // host's plugin (in the plugin cache), NOT the direct-config locations the
      // adapter's doctor() inspects — so the direct checks would falsely FAIL
      // (mcp_servers/command/skill "not found"). Skip them; the marketplace-method
      // checks below cover this install's real health.
      if (readMarketplaceInstalls(connector.id)[id]) {
        const note: DiagnosticResult = {
          check: `${connector.id}: ${id} delivery`,
          status: "pass",
          message: "surfaces delivered via the marketplace plugin — see marketplace checks",
        };
        const tagged_note = multi ? { ...note, check: `(${connector.id}) ${note.check}` } : note;
        results.push(tagged_note);
        tagged.push({ result: tagged_note, entryIndex: i });
        continue;
      }

      const ctx = buildContext(connector, id, scope, projectDir);
      let r: DiagnosticResult[];
      try {
        r = adapter.doctor(ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        r = [{ check: `${adapter.name}: doctor`, status: "fail", message }];
      }
      // When checking multiple connectors, tag each check with the connector id.
      const tagged_r = multi ? r.map((d) => ({ ...d, check: `(${connector.id}) ${d.check}` })) : r;
      results.push(...tagged_r);
      for (const tr of tagged_r) tagged.push({ result: tr, entryIndex: i });
    }
    if (results.some((d) => d.status === "fail")) anyFail = true;
    byPlatform.push({ platform: id, results });
  }

  // ── Marketplace-method checks ─────────────────────────────────────────────
  for (let i = 0; i < entries.length; i++) {
    const { connector } = entries[i]!;
    const groups = await marketplaceDoctorChecks(connector, scope, projectDir);
    for (const group of groups) {
      const tagged_g = multi
        ? group.results.map((d) => ({ ...d, check: `(${connector.id}) ${d.check}` }))
        : group.results;
      if (tagged_g.some((d) => d.status === "fail")) anyFail = true;
      for (const tg of tagged_g) tagged.push({ result: tg, entryIndex: i });
      const bucket = byPlatform.find((b) => b.platform === group.platform);
      if (bucket) bucket.results.push(...tagged_g);
      else byPlatform.push({ platform: group.platform, results: tagged_g });
    }
  }

  return { byPlatform, tagged, anyFail };
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      scope: { type: "string", default: "user" },
      targets: { type: "string" },
      connector: { type: "string" },
      project: { type: "string" },
      json: { type: "boolean", default: false },
      probe: { type: "boolean", default: false },
      heal: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const projectDir = values.project ?? process.cwd();

  const scope = parseScope(values.scope);
  if (scope == null) return fail(`invalid --scope "${values.scope}" (use user|project)`);

  const entries = await resolveDoctorConnectors(values.connector, projectDir);
  const connectors = entries.map((e) => e.connector);

  // Target set: explicit --targets (intersected with the registry), else the
  // same chain install uses — connector-declared targets ∩ detected platforms
  // ("auto" = everything detected). Without this, doctor red-flags every
  // detected host the connector never targeted (found dogfooding context-mode:
  // targets:[5 ids] installed clean, doctor FAILed the other 9 detected hosts).
  const explicit = parseTargets(values.targets);
  let ids: PlatformId[];
  if (explicit && explicit.length > 0) {
    ids = explicit.filter((id) => REGISTERED_PLATFORM_IDS.has(id));
  } else {
    const detected = await detectInstalledPlatforms(projectDir);
    ids = detected.map((p) => p.id);
    const anyAuto = connectors.some((c) => c.targets === "auto");
    if (!anyAuto) {
      const targeted = new Set(connectors.flatMap((c) => c.targets as PlatformId[]));
      ids = ids.filter((id) => targeted.has(id));
    }
  }

  if (ids.length === 0 && !values.probe) {
    print("doctor: no target platforms (none detected; pass --targets to force).");
    return 0;
  }

  // ── Heal path ─────────────────────────────────────────────────────────────
  if (values.heal) {
    const { tagged, anyFail: preFail } = await collectDiagnostics(
      entries,
      ids,
      scope,
      projectDir,
    );

    // Partition: fixable vs deferred (non-pass, not fixable)
    const fixableByEntry = new Map<number, DiagnosticResult[]>();
    const deferredByEntry = new Map<number, DiagnosticResult[]>();
    for (const { result, entryIndex } of tagged) {
      if (result.status === "pass") continue;
      // A finding is only HEALABLE if it is fixable AND its connector has a
      // module path we can re-sync from. A placeholder/unregistered connector
      // (empty modulePath) must NEVER be synced — doing so would fabricate a
      // bogus registry record via registerConnector(connector, ""). Route its
      // fixable findings to deferred instead.
      const canSync = !!entries[entryIndex]!.modulePath;
      if (result.fixable && canSync) {
        if (!fixableByEntry.has(entryIndex)) fixableByEntry.set(entryIndex, []);
        fixableByEntry.get(entryIndex)!.push(result);
      } else {
        if (!deferredByEntry.has(entryIndex)) deferredByEntry.set(entryIndex, []);
        deferredByEntry.get(entryIndex)!.push(result);
      }
    }

    if (values["dry-run"]) {
      // Dry-run: print what would happen, write nothing.
      for (const [idx, fixable] of fixableByEntry) {
        const { connector } = entries[idx]!;
        print(
          `would heal via sync (${connector.id}): ${fixable.map((r) => r.check).join(", ")}`,
        );
      }
      for (const [idx, deferred] of deferredByEntry) {
        const { connector } = entries[idx]!;
        for (const r of deferred) {
          print(
            `would defer (${connector.id}): ${r.check} — ${r.fix ?? "no auto-fix available"}`,
          );
        }
      }
      if (fixableByEntry.size === 0 && deferredByEntry.size === 0) {
        print("doctor --heal --dry-run: nothing to heal.");
      }
      return 0;
    }

    // Real heal: sync each connector that has fixable findings.
    for (const [idx] of fixableByEntry) {
      const { connector, modulePath } = entries[idx]!;
      await syncConnector({
        connector,
        modulePath,
        scope,
        projectDir,
        targets: ids,
        dryRun: false,
      });
    }

    // Re-run diagnostics to compute what changed.
    const { tagged: postTagged, anyFail: postFail } = await collectDiagnostics(
      entries,
      ids,
      scope,
      projectDir,
    );

    // Classify post-heal results.
    const preNonPass = new Set(
      tagged
        .filter((t) => t.result.status !== "pass")
        .map((t) => t.result.check),
    );
    const postNonPass = new Set(
      postTagged
        .filter((t) => t.result.status !== "pass")
        .map((t) => t.result.check),
    );

    const healed: string[] = [];
    const stillFailing: DiagnosticResult[] = [];
    const deferred: DiagnosticResult[] = [];

    // Healed = was non-pass before, now pass
    for (const check of preNonPass) {
      if (!postNonPass.has(check)) healed.push(check);
    }
    // Post-heal non-pass findings. Classify consistently with the pre-heal
    // partition: a fixable finding we could not sync (no modulePath) is deferred,
    // not "still failing after sync" — we never attempted a sync for it.
    for (const { result, entryIndex } of postTagged) {
      if (result.status === "pass") continue;
      const canSync = !!entries[entryIndex]!.modulePath;
      if (result.fixable && canSync) {
        stillFailing.push(result);
      } else {
        deferred.push(result);
      }
    }

    if (values.json) {
      print(JSON.stringify({ healed, deferred, stillFailing }, null, 2));
      return postFail ? 1 : 0;
    }

    if (healed.length > 0) {
      print(`healed (${healed.length}):`);
      for (const c of healed) print(`  [pass] ${c}`);
      print("");
    }
    if (stillFailing.length > 0) {
      print(`still failing after sync (${stillFailing.length}):`);
      for (const r of stillFailing) {
        print(`  ${STATUS_GLYPH[r.status]} ${r.check} — ${r.message}`);
        if (r.fix) print(`         fix: ${r.fix}`);
      }
      print("");
    }
    if (deferred.length > 0) {
      print(`deferred — requires manual action (${deferred.length}):`);
      for (const r of deferred) {
        print(`  ${STATUS_GLYPH[r.status]} ${r.check} — ${r.message}`);
        if (r.fix) print(`         fix: ${r.fix}`);
      }
      print("");
    }
    if (healed.length === 0 && stillFailing.length === 0 && deferred.length === 0 && !preFail) {
      print("doctor --heal: nothing to heal, all checks passed.");
    } else if (stillFailing.length === 0 && deferred.length === 0) {
      print("doctor --heal: all fixable findings resolved.");
    }
    return postFail ? 1 : 0;
  }

  // ── Normal diagnose path (no --heal) ─────────────────────────────────────
  const { byPlatform, anyFail } = await collectDiagnostics(entries, ids, scope, projectDir);

  // ── Live MCP probe (--probe): connector-scoped, not platform-scoped ──────
  // Spawns each connector's REAL stdio server and runs initialize → ping →
  // tools/list. Probe FAILs fold into the doctor exit code.
  const probes: { connector: string; results: DiagnosticResult[] }[] = [];
  if (values.probe) {
    for (const { connector } of entries) {
      const s = connector.server;
      if (!s || s.transport !== "stdio" || !s.command) {
        probes.push({
          connector: connector.id,
          results: [
            {
              check: `${connector.id}: MCP probe`,
              status: "warn",
              message: s
                ? `transport "${s.transport}" is not stdio — live probe skipped`
                : "no server to probe",
            },
          ],
        });
        continue;
      }
      const results = await probeStdioServer(s.command, s.args ?? [], {
        label: connector.id,
        ...(s.env ? { env: s.env } : {}),
      });
      probes.push({ connector: connector.id, results });
    }
  }

  const probesFail = probes.some((p) => p.results.some((r) => r.status === "fail"));

  if (values.json) {
    print(JSON.stringify(values.probe ? { platforms: byPlatform, probes } : byPlatform, null, 2));
    return anyFail || probesFail ? 1 : 0;
  }

  for (const { platform, results } of byPlatform) {
    print(`${platform}:`);
    for (const r of results) {
      print(`  ${STATUS_GLYPH[r.status]} ${r.check} — ${r.message}`);
      if (r.fix) print(`         fix: ${r.fix}`);
    }
    print("");
  }
  for (const { connector, results } of probes) {
    print(`probe ${connector}:`);
    for (const r of results) {
      print(`  ${STATUS_GLYPH[r.status]} ${r.check} — ${r.message}`);
      if (r.fix) print(`         fix: ${r.fix}`);
    }
    print("");
  }
  print(anyFail || probesFail ? "doctor: one or more checks FAILED." : "doctor: all checks passed.");
  return anyFail || probesFail ? 1 : 0;
}
