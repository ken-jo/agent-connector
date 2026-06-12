/**
 * cli/commands/package — emit a marketplace/extension-installable connector bundle.
 *
 * Resolves the connector config (--connector <path>, else findConnectorConfig
 * walking up from the project dir, exactly like install.ts), packages it for the
 * requested --format into --out (default <cwd>/dist-plugin), then prints the
 * emitted file tree plus per-format install instructions.
 *
 * `--format <x>` accepts the full union; `--format all` emits EVERY feasible
 * format, each into <out>/<format>/..., printing install instructions per format.
 * Default --format claude-plugin.
 */

import { parseArgs } from "node:util";
import { join, relative } from "node:path";

import { findConnectorConfig, loadConnectorFromPath } from "../../core/load-connector.js";
import {
  ALL_FORMATS,
  FEASIBLE_FORMATS,
  installInstructions,
  isPackageFormat,
  packageConnector,
  packageConnectorAll,
  type PackageFormat,
  type PackageResult,
} from "../../core/package.js";
import { fail, print } from "../app.js";

const HELP = `agent-connector package — emit a plugin/extension/marketplace bundle.

usage: agent-connector package [flags]

flags:
  --connector <path>   Connector config to package (else auto-discovered).
  --format <fmt>       Output format (default: claude-plugin). One of:
                         ${ALL_FORMATS.join(", ")}
                       or "all" to emit every feasible format into <out>/<fmt>/.
  --out <dir>          Output directory. Default: <cwd>/dist-plugin.
  --project <dir>      Project root for connector discovery (default: cwd).
  --dry-run            Compute the file tree without writing anything.
  --help               Show this help.`;

/** Print the file tree + the per-format install instructions for one bundle. */
function printFormatResult(
  format: PackageFormat,
  connectorId: string,
  outDir: string,
  result: PackageResult,
): void {
  print(`  pluginDir: ${result.pluginDir}`);
  if (result.marketplacePath) {
    print(`  marketplace: ${relative(outDir, result.marketplacePath)}`);
  }
  print("  emitted files:");
  for (const f of result.files) {
    print(`    + ${relative(outDir, f)}`);
  }
  if (result.notes && result.notes.length > 0) {
    print("  notes:");
    for (const n of result.notes) print(`    ! ${n}`);
  }
  print("  install:");
  for (const line of installInstructions(format, connectorId, outDir)) {
    print(`    ${line}`);
  }
  // `package` stays a pure emitter (no host CLIs spawned) — but for hosts whose
  // marketplace flow agent-connector can DRIVE, point at the lifecycle verb.
  if (format === "claude-plugin") {
    print(
      "    (or let agent-connector drive it: agent-connector install --method marketplace --targets claude-code)",
    );
  }
  print("");
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      connector: { type: "string" },
      format: { type: "string", default: "claude-plugin" },
      out: { type: "string" },
      project: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    print(HELP);
    return 0;
  }

  const formatArg = values.format ?? "claude-plugin";
  const isAll = formatArg === "all";
  if (!isAll && !isPackageFormat(formatArg)) {
    return fail(
      `invalid --format "${formatArg}" (expected one of: ${ALL_FORMATS.join(", ")}, or "all")`,
    );
  }

  const projectDir = values.project ?? process.cwd();
  const configPath = values.connector ?? findConnectorConfig(projectDir);
  if (!configPath) {
    return fail(
      "no connector config found. Pass --connector <path> or add an " +
        "agent-connector.config.{mjs,js,json} to your project.",
    );
  }

  const outDir = values.out ?? `${process.cwd()}/dist-plugin`;
  const dryRun = values["dry-run"];
  const mode = dryRun ? " (dry-run — nothing written)" : "";

  const { connector } = await loadConnectorFromPath(configPath);

  if (isAll) {
    print(`package "${connector.id}" → all formats${mode}`);
    print(`  outDir: ${outDir}`);
    print("");
    const results = packageConnectorAll(connector, { outDir, dryRun });
    for (const { format, result } of results) {
      const formatOut = join(outDir, format);
      print(`── ${format} ──`);
      printFormatResult(format, connector.id, formatOut, result);
    }
    print(`emitted ${results.length} formats: ${FEASIBLE_FORMATS.join(", ")}`);
    return 0;
  }

  const format: PackageFormat = formatArg;
  let result: PackageResult;
  try {
    result = packageConnector(connector, { outDir, format, dryRun });
  } catch (err) {
    // Emitter validation errors (e.g. mcp-server-json without
    // publish.registryNamespace) are actionable one-liners — print them as a
    // normal CLI error, never a stack trace.
    const message = err instanceof Error ? err.message : String(err);
    return fail(message);
  }

  print(`package "${connector.id}" → ${format}${mode}`);
  print(`  outDir: ${outDir}`);
  print("");
  printFormatResult(format, connector.id, outDir, result);
  return 0;
}
