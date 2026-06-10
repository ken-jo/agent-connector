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
} from "../../core/load-connector.js";
import { dataRoot, homeBinPath } from "../../core/paths.js";
import { probeStdioServer } from "../../runtime/probe.js";
import { fail, parseScope, parseTargets, print } from "../app.js";

const STATUS_GLYPH: Record<DiagnosticResult["status"], string> = {
  pass: "[pass]",
  warn: "[warn]",
  fail: "[FAIL]",
};

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
): Promise<ResolvedConnector[]> {
  const configPath = connectorPath ?? findConnectorConfig(projectDir);
  if (configPath) {
    try {
      const { connector } = await loadConnectorFromPath(configPath);
      return [connector];
    } catch {
      /* fall through */
    }
  }

  const registered = listRegisteredConnectors();
  if (registered.length > 0) return registered;

  return [
    {
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
      platforms: {},
      targets: "auto",
    },
  ];
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
    },
    allowPositionals: false,
  });

  const projectDir = values.project ?? process.cwd();

  const scope = parseScope(values.scope);
  if (scope == null) return fail(`invalid --scope "${values.scope}" (use user|project)`);

  const connectors = await resolveDoctorConnectors(values.connector, projectDir);
  const multi = connectors.length > 1;

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

  const byPlatform: { platform: PlatformId; results: DiagnosticResult[] }[] = [];
  let anyFail = false;

  for (const id of ids) {
    const adapter = await loadAdapter(id);
    if (!adapter) {
      byPlatform.push({
        platform: id,
        results: [
          {
            check: `${id}: adapter`,
            status: "fail",
            message: `no adapter registered for ${id}`,
          },
        ],
      });
      anyFail = true;
      continue;
    }
    const results: DiagnosticResult[] = [];
    for (const connector of connectors) {
      // A connector with an explicit target list is only checked on those hosts.
      if (connector.targets !== "auto" && !connector.targets.includes(id)) continue;
      const ctx = buildContext(connector, id, scope, projectDir);
      let r: DiagnosticResult[];
      try {
        r = adapter.doctor(ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        r = [{ check: `${adapter.name}: doctor`, status: "fail", message }];
      }
      // When checking multiple connectors, tag each check with the connector id.
      results.push(
        ...(multi
          ? r.map((d) => ({ ...d, check: `(${connector.id}) ${d.check}` }))
          : r),
      );
    }
    if (results.some((d) => d.status === "fail")) anyFail = true;
    byPlatform.push({ platform: id, results });
  }

  // ── Live MCP probe (--probe): connector-scoped, not platform-scoped ──────
  // Spawns each connector's REAL stdio server and runs initialize → ping →
  // tools/list. Probe FAILs fold into the doctor exit code.
  const probes: { connector: string; results: DiagnosticResult[] }[] = [];
  if (values.probe) {
    for (const connector of connectors) {
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
      if (results.some((d) => d.status === "fail")) anyFail = true;
      probes.push({ connector: connector.id, results });
    }
  }

  if (values.json) {
    print(JSON.stringify(values.probe ? { platforms: byPlatform, probes } : byPlatform, null, 2));
    return anyFail ? 1 : 0;
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
  print(anyFail ? "doctor: one or more checks FAILED." : "doctor: all checks passed.");
  return anyFail ? 1 : 0;
}
