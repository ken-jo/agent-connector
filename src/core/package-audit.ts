import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { loadConnectorFromPath } from "./load-connector.js";
import {
  deriveHostAliasFromMcpName,
  deriveHostAliasFromPackageName,
  readConnectorPackageMetadataFromPackageJson,
} from "./package-metadata.js";
import type { ResolvedConnector } from "./types.js";

export type PackageAuditSeverity = "error" | "warn" | "info";

export interface PackageAuditFinding {
  severity: PackageAuditSeverity;
  code: string;
  message: string;
}

export interface PackageAuditResult {
  ok: boolean;
  packageJsonPath: string;
  connectorPath: string;
  packageName?: string;
  packageVersion?: string;
  connectorId?: string;
  connectorVersion?: string;
  binName?: string;
  findings: PackageAuditFinding[];
}

interface RawPackageJson {
  name?: unknown;
  version?: unknown;
  mcpName?: unknown;
  mcp?: unknown;
  bin?: unknown;
  files?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  peerDependencies?: unknown;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRawPackageJson(path: string): RawPackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as RawPackageJson;
}

function dependencyVersion(pkg: RawPackageJson, name: string): string | undefined {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const deps = pkg[field];
    if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
    const value = (deps as Record<string, unknown>)[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function dependencyField(pkg: RawPackageJson, name: string): string | undefined {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const deps = pkg[field];
    if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
    if (typeof (deps as Record<string, unknown>)[name] === "string") return field;
  }
  return undefined;
}

function normalizePackagePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function binEntries(bin: unknown, packageName: string | undefined): [string, string][] {
  if (typeof bin === "string") {
    const derived = packageName?.startsWith("@")
      ? packageName.split("/")[1]
      : packageName;
    const name = cleanString(derived);
    return name ? [[name, bin]] : [];
  }
  if (!bin || typeof bin !== "object" || Array.isArray(bin)) return [];
  return Object.entries(bin)
    .filter((entry): entry is [string, string] => cleanString(entry[0]) != null && typeof entry[1] === "string")
    .map(([name, target]) => [name, target]);
}

function filesList(files: unknown): string[] | undefined {
  if (files == null) return undefined;
  if (!Array.isArray(files)) return [];
  return files.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function filesIncludes(files: string[], relPath: string): boolean {
  const normalized = normalizePackagePath(relPath);
  return files.some((entry) => {
    const item = normalizePackagePath(entry);
    return item === normalized || normalized.startsWith(`${item.replace(/\/$/, "")}/`);
  });
}

function add(
  findings: PackageAuditFinding[],
  severity: PackageAuditSeverity,
  code: string,
  message: string,
): void {
  findings.push({ severity, code, message });
}

function expectedAliases(pkg: RawPackageJson, packageName: string | undefined): string[] {
  const out = new Set<string>();
  const mcpName =
    cleanString(pkg.mcpName) ??
    (pkg.mcp && typeof pkg.mcp === "object" && !Array.isArray(pkg.mcp)
      ? cleanString((pkg.mcp as { name?: unknown; mcpName?: unknown }).mcpName) ??
        cleanString((pkg.mcp as { name?: unknown; mcpName?: unknown }).name)
      : undefined);
  if (mcpName) {
    const alias = deriveHostAliasFromMcpName(mcpName);
    if (alias) out.add(alias);
  }
  if (packageName) {
    const alias = deriveHostAliasFromPackageName(packageName);
    if (alias) out.add(alias);
  }
  return [...out];
}

function auditLoadedConnector(input: {
  pkg: RawPackageJson;
  packageJsonPath: string;
  connectorPath: string;
  connector: ResolvedConnector;
}): PackageAuditResult {
  const { pkg, packageJsonPath, connectorPath, connector } = input;
  const packageDir = dirname(packageJsonPath);
  const findings: PackageAuditFinding[] = [];
  const packageName = cleanString(pkg.name);
  const packageVersion = cleanString(pkg.version);
  const entries = binEntries(pkg.bin, packageName);
  const metadata = readConnectorPackageMetadataFromPackageJson(packageJsonPath);
  const metadataMcp = metadata.mcp;
  const aliasCandidates = expectedAliases(pkg, packageName);
  const selectedBin = metadataMcp?.bin;

  if (!packageName) {
    add(findings, "error", "missing-package-name", "package.json must declare a non-empty `name`.");
  } else {
    add(findings, "info", "package-name", `package name: ${packageName}`);
  }

  if (!packageVersion) {
    add(findings, "error", "missing-version", "package.json must declare a non-empty `version`.");
  } else {
    add(findings, "info", "package-version", `package version: ${packageVersion}`);
  }

  if (entries.length === 0) {
    add(findings, "error", "missing-bin", "branded MCP packages must expose a `bin` command.");
  } else if (!selectedBin) {
    add(
      findings,
      "error",
      "ambiguous-bin",
      "package.json `bin` could not be mapped to one branded command; use one bin or a bin matching the package basename.",
    );
  } else {
    add(findings, "info", "bin", `branded bin: ${selectedBin}`);
  }

  for (const [binName, target] of entries) {
    const targetPath = resolve(packageDir, target);
    if (!existsSync(targetPath)) {
      add(findings, "error", "missing-bin-target", `bin "${binName}" points at a missing file: ${target}`);
    }
  }

  const dep = dependencyVersion(pkg, "@ken-jo/agent-connector");
  const depField = dependencyField(pkg, "@ken-jo/agent-connector");
  if (!dep) {
    add(
      findings,
      "error",
      "missing-agent-connector-dependency",
      "package.json must depend on `@ken-jo/agent-connector` so the branded bin works after install.",
    );
  } else if (depField !== "dependencies") {
    add(
      findings,
      "warn",
      "agent-connector-not-runtime-dependency",
      `@ken-jo/agent-connector is in ${depField}; published MCP packages usually need it in dependencies.`,
    );
  } else {
    add(findings, "info", "agent-connector-dependency", `@ken-jo/agent-connector dependency: ${dep}`);
  }

  if (metadataMcp?.packageName && connector.mcp?.packageName && connector.mcp.packageName !== metadataMcp.packageName) {
    add(
      findings,
      "error",
      "package-name-drift",
      `connector mcp.packageName (${connector.mcp.packageName}) differs from package.json name (${metadataMcp.packageName}).`,
    );
  }

  if (packageVersion && connector.version !== packageVersion) {
    add(
      findings,
      "warn",
      "version-drift",
      `connector version (${connector.version}) differs from package.json version (${packageVersion}); keep package.json as the source of truth unless this is intentional.`,
    );
  }

  if (aliasCandidates.length > 0 && !aliasCandidates.includes(connector.id)) {
    add(
      findings,
      "warn",
      "connector-id-drift",
      `connector id (${connector.id}) does not match package-derived alias candidates (${aliasCandidates.join(", ")}).`,
    );
  }

  if (selectedBin && selectedBin !== connector.id) {
    add(
      findings,
      "warn",
      "bin-id-drift",
      `branded bin (${selectedBin}) differs from connector id (${connector.id}); users may see two names for one MCP package.`,
    );
  }

  const files = filesList(pkg.files);
  if (files && files.length === 0) {
    add(findings, "error", "invalid-files", "`files` must be an array of package paths when present.");
  } else if (files) {
    const connectorRel = normalizePackagePath(relative(packageDir, connectorPath));
    if (!connectorRel.startsWith("../") && !isAbsolute(connectorRel) && !filesIncludes(files, connectorRel)) {
      add(
        findings,
        "warn",
        "files-missing-connector",
        `package.json files does not include the connector config (${connectorRel}).`,
      );
    }
    for (const [binName, target] of entries) {
      const rel = normalizePackagePath(target);
      if (!filesIncludes(files, rel)) {
        add(findings, "warn", "files-missing-bin", `package.json files does not include bin "${binName}" target (${rel}).`);
      }
    }
  }

  const hasError = findings.some((finding) => finding.severity === "error");
  return {
    ok: !hasError,
    packageJsonPath,
    connectorPath,
    ...(packageName ? { packageName } : {}),
    ...(packageVersion ? { packageVersion } : {}),
    connectorId: connector.id,
    connectorVersion: connector.version,
    ...(selectedBin ? { binName: selectedBin } : {}),
    findings,
  };
}

export async function auditConnectorPackage(input: {
  connectorPath: string;
  packageJsonPath: string;
}): Promise<PackageAuditResult> {
  const packageJsonPath = resolve(input.packageJsonPath);
  const connectorPath = resolve(input.connectorPath);
  const findings: PackageAuditFinding[] = [];

  if (!existsSync(packageJsonPath)) {
    add(findings, "error", "package-json-not-found", `package.json not found: ${packageJsonPath}`);
    return { ok: false, packageJsonPath, connectorPath, findings };
  }

  if (!existsSync(connectorPath)) {
    add(findings, "error", "connector-not-found", `connector config not found: ${connectorPath}`);
    return { ok: false, packageJsonPath, connectorPath, findings };
  }

  let pkg: RawPackageJson;
  try {
    pkg = readRawPackageJson(packageJsonPath);
  } catch (err) {
    add(
      findings,
      "error",
      "package-json-invalid",
      `package.json could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, packageJsonPath, connectorPath, findings };
  }

  try {
    const { connector } = await loadConnectorFromPath(connectorPath);
    return auditLoadedConnector({ pkg, packageJsonPath, connectorPath, connector });
  } catch (err) {
    add(
      findings,
      "error",
      "connector-load-failed",
      `connector config could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, packageJsonPath, connectorPath, findings };
  }
}
