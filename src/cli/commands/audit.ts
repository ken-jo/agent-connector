/**
 * cli/commands/audit — pre-install package identity lint for branded MCP packages.
 *
 * This command catches the mistakes that make a connector feel unbranded after
 * publish: missing bin, missing runtime dependency, package/connector version
 * drift, and mismatched package-derived aliases.
 */

import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { findConnectorConfig } from "../../core/load-connector.js";
import {
  auditConnectorPackage,
  type PackageAuditFinding,
  type PackageAuditResult,
} from "../../core/package-audit.js";
import { findNearestPackageJson } from "../../core/package-metadata.js";
import { fail, print } from "../app.js";

function glyph(severity: PackageAuditFinding["severity"]): string {
  return severity === "error" ? "x" : severity === "warn" ? "!" : "✓";
}

function renderAudit(result: PackageAuditResult): string {
  const lines = [
    `audit ${result.connectorId ? `"${result.connectorId}"` : "package"}`,
    `  package: ${result.packageJsonPath}`,
    `  connector: ${result.connectorPath}`,
  ];
  if (result.binName) lines.push(`  bin: ${result.binName}`);
  lines.push("");

  for (const finding of result.findings) {
    lines.push(`  ${glyph(finding.severity)} ${finding.message}`);
  }

  const errors = result.findings.filter((finding) => finding.severity === "error").length;
  const warnings = result.findings.filter((finding) => finding.severity === "warn").length;
  lines.push("");
  lines.push(
    errors === 0
      ? `✓ package audit passed${warnings > 0 ? ` with ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}.`
      : `x package audit failed with ${errors} error${errors === 1 ? "" : "s"}${warnings > 0 ? ` and ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}.`,
  );
  return lines.join("\n");
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      connector: { type: "string" },
      "package-json": { type: "string" },
      project: { type: "string" },
      json: { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const projectDir = values.project ?? process.cwd();
  const connectorPath = values.connector ?? findConnectorConfig(projectDir);
  if (!connectorPath) {
    return fail(
      "no connector config found. Pass --connector <path> or add an " +
        "agent-connector.config.{mjs,js,json} to your project.",
    );
  }

  const packageJsonPath =
    values["package-json"] ?? findNearestPackageJson(dirname(connectorPath));
  if (!packageJsonPath) {
    return fail("no package.json found. Pass --package-json <path>.");
  }

  const result = await auditConnectorPackage({ connectorPath, packageJsonPath });
  if (values.json) {
    print(JSON.stringify(result, null, 2));
  } else {
    print(renderAudit(result));
  }

  const hasError = result.findings.some((finding) => finding.severity === "error");
  const hasWarning = result.findings.some((finding) => finding.severity === "warn");
  return hasError || (values.strict && hasWarning) ? 1 : 0;
}
