/**
 * cli/commands/package — emit a marketplace-installable Claude Code plugin bundle.
 *
 * Resolves the connector config (--connector <path>, else findConnectorConfig
 * walking up from the project dir, exactly like install.ts), packages it into a
 * plugin directory + marketplace.json under --out (default <cwd>/dist-plugin),
 * then prints the emitted file tree plus the two-step install instructions.
 *
 * Only --format claude-plugin is supported today (also the default).
 */

import { parseArgs } from "node:util";
import { relative } from "node:path";

import { findConnectorConfig, loadConnectorFromPath } from "../../core/load-connector.js";
import { packageConnector, type PackageFormat } from "../../core/package.js";
import { fail, print } from "../app.js";

const HELP = `agent-connector package — emit a Claude Code plugin bundle + marketplace.json.

usage: agent-connector package [flags]

flags:
  --connector <path>   Connector config to package (else auto-discovered).
  --format <fmt>       Output format. Only "claude-plugin" (default).
  --out <dir>          Output directory (the marketplace root). Default: <cwd>/dist-plugin.
  --project <dir>      Project root for connector discovery (default: cwd).
  --dry-run            Compute the file tree without writing anything.
  --help               Show this help.`;

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

  if (values.format !== "claude-plugin") {
    return fail(`invalid --format "${values.format}" (only "claude-plugin" is supported)`);
  }
  const format: PackageFormat = "claude-plugin";

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

  const { connector } = await loadConnectorFromPath(configPath);

  const result = packageConnector(connector, { outDir, format, dryRun });

  const mode = dryRun ? " (dry-run — nothing written)" : "";
  print(`package "${connector.id}" → claude-plugin${mode}`);
  print(`  outDir:    ${outDir}`);
  print(`  pluginDir: ${result.pluginDir}`);
  print("");
  print("emitted files:");
  for (const f of result.files) {
    print(`  + ${relative(outDir, f)}`);
  }
  print("");
  print("install (Claude Code):");
  print(`  1) /plugin marketplace add ${outDir}`);
  print(`  2) /plugin install ${connector.id}@agent-connector`);
  print("");
  print(`  CLI equivalent:`);
  print(`     claude plugin marketplace add ${outDir}`);
  print(`     claude plugin install ${connector.id}@agent-connector`);

  return 0;
}
