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
  isPackageFormat,
  packageConnector,
  packageConnectorAll,
  type PackageFormat,
  type PackageResult,
} from "../../core/package.js";
import { fail, print } from "../app.js";

const HELP = `agentconnect package — emit a plugin/extension/marketplace bundle.

usage: agentconnect package [flags]

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
  print("");
}

/** Per-format install commands (the accurate two-step add+install where applicable). */
function installInstructions(
  format: PackageFormat,
  id: string,
  outDir: string,
): string[] {
  switch (format) {
    case "claude-plugin":
      return [
        `/plugin marketplace add ${outDir}`,
        `/plugin install ${id}@agentconnect`,
        `(CLI: claude plugin marketplace add ${outDir} && claude plugin install ${id}@agentconnect)`,
      ];
    case "codex-plugin":
      return [
        `codex plugin marketplace add ${outDir}`,
        `codex plugin add ${id}@agentconnect`,
      ];
    case "factory-plugin":
      return [
        `droid plugin marketplace add ${outDir}`,
        `droid plugin install ${id}@agentconnect`,
      ];
    case "gemini-extension":
      return [`gemini extensions install ${join(outDir, id)}`];
    case "qwen-extension":
      return [`qwen extensions install ${join(outDir, id)}`];
    case "agy-plugin":
      return [
        `agy plugin install ${join(outDir, id)}`,
        `(validate: agy plugin validate ${join(outDir, id)})`,
      ];
    case "cursor-plugin":
      return [
        `link ${join(outDir, id)} into ~/.cursor/plugins/local/${id}/ then Developer: Reload Window`,
        `(or publish ${outDir} as a Cursor marketplace repo)`,
      ];
    case "kimi-plugin":
      return [`kimi plugin install ${join(outDir, id)}`];
    case "npm-plugin":
      return [
        `npm publish ${join(outDir, id)}  (then: opencode plugin install <pkg> | kilo plugin <pkg> | pi install npm:<pkg>)`,
      ];
    default:
      return [];
  }
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
        "agentconnect.config.{mjs,js,json} to your project.",
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
  const result = packageConnector(connector, { outDir, format, dryRun });

  print(`package "${connector.id}" → ${format}${mode}`);
  print(`  outDir: ${outDir}`);
  print("");
  printFormatResult(format, connector.id, outDir, result);
  return 0;
}
