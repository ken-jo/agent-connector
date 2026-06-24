import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type {
  McpPackageIdentity,
  ResolvedMcpPackageIdentity,
  ServerDef,
} from "./types.js";

const GENERIC_PACKAGE_BASENAMES = new Set([
  "mcp",
  "server",
  "mcp-server",
  "connector",
  "tool",
  "tools",
  "cli",
]);

export interface ConnectorPackageMetadata {
  /** Package-derived MCP identity used to derive host aliases and install ids. */
  mcp?: McpPackageIdentity;
  /** package.json version used as the connector version default. */
  version?: string;
}

const PACKAGE_METADATA_CONTEXT = new AsyncLocalStorage<ConnectorPackageMetadata>();

function kebab(raw: string): string {
  return raw
    .trim()
    .replace(/^@/, "")
    .replace(/[\\/_.\s]+/g, "-")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function scopedPackageParts(packageName: string): {
  scope?: string;
  basename: string;
} {
  const raw = packageName.trim();
  if (raw.startsWith("@")) {
    const [scope, basename] = raw.slice(1).split("/");
    return { scope: scope ? kebab(scope) : undefined, basename: basename ?? "" };
  }
  return { basename: raw };
}

function cleanMcpBasename(raw: string): string {
  let name = kebab(raw);
  name = name.replace(/^mcp-server-/, "");
  name = name.replace(/^server-/, "");
  name = name.replace(/-mcp-server$/, "");
  name = name.replace(/-mcp$/, "");
  name = name.replace(/-server$/, "");
  return kebab(name);
}

function isGeneric(name: string | undefined): boolean {
  return !name || GENERIC_PACKAGE_BASENAMES.has(name);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => key.trim());
}

function packageBinName(bin: unknown, packageName: string | undefined): string | undefined {
  if (typeof bin === "string") {
    return packageName ? deriveHostAliasFromPackageName(packageName) : undefined;
  }

  const keys = objectKeys(bin);
  if (keys.length === 0) return undefined;
  if (keys.length === 1) return keys[0];

  const packageAlias = packageName ? deriveHostAliasFromPackageName(packageName) : undefined;
  if (packageAlias && keys.includes(packageAlias)) return packageAlias;

  const unscoped = packageName?.startsWith("@") ? packageName.split("/")[1] : packageName;
  const cleanUnscoped = unscoped ? cleanMcpBasename(unscoped) : undefined;
  if (cleanUnscoped && keys.includes(cleanUnscoped)) return cleanUnscoped;

  return undefined;
}

export function currentMcpPackageIdentity(): McpPackageIdentity | undefined {
  return currentConnectorPackageMetadata()?.mcp;
}

export function currentConnectorPackageMetadata():
  | ConnectorPackageMetadata
  | undefined {
  return PACKAGE_METADATA_CONTEXT.getStore();
}

export async function withConnectorPackageMetadata<T>(
  metadata: ConnectorPackageMetadata | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!metadata || Object.keys(metadata).length === 0) return run();
  return PACKAGE_METADATA_CONTEXT.run(metadata, run);
}

export async function withMcpPackageIdentity<T>(
  identity: McpPackageIdentity | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!identity || Object.keys(identity).length === 0) return run();
  return withConnectorPackageMetadata({ mcp: identity }, run);
}

export function findNearestPackageJson(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function readMcpPackageIdentityFromPackageJson(
  packageJsonPath: string,
): McpPackageIdentity {
  return readConnectorPackageMetadataFromPackageJson(packageJsonPath).mcp ?? {};
}

export function readConnectorPackageMetadataFromPackageJson(
  packageJsonPath: string,
): ConnectorPackageMetadata {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
    mcpName?: unknown;
    mcp?: unknown;
    bin?: unknown;
  };
  const packageName = cleanString(parsed.name);
  const version = cleanString(parsed.version);
  const mcp =
    parsed.mcp && typeof parsed.mcp === "object" && !Array.isArray(parsed.mcp)
      ? (parsed.mcp as { name?: unknown; mcpName?: unknown })
      : undefined;
  const mcpName =
    cleanString(parsed.mcpName) ??
    cleanString(mcp?.mcpName) ??
    cleanString(mcp?.name);
  const bin = packageBinName(parsed.bin, packageName);

  const identity: McpPackageIdentity = {
    ...(packageName ? { packageName } : {}),
    ...(mcpName ? { mcpName } : {}),
    ...(bin ? { bin } : {}),
  };

  return {
    ...(Object.keys(identity).length > 0 ? { mcp: identity } : {}),
    ...(version ? { version } : {}),
  };
}

export function readMcpPackageIdentityNearFile(
  filePath: string,
): McpPackageIdentity | undefined {
  return readConnectorPackageMetadataNearFile(filePath)?.mcp;
}

export function readConnectorPackageMetadataNearFile(
  filePath: string,
): ConnectorPackageMetadata | undefined {
  const packageJsonPath = findNearestPackageJson(dirname(filePath));
  if (!packageJsonPath) return undefined;
  try {
    const metadata = readConnectorPackageMetadataFromPackageJson(packageJsonPath);
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  } catch {
    return undefined;
  }
}

/** Derive the host-facing MCP server key from a package name. */
export function deriveHostAliasFromPackageName(
  packageName: string,
): string | undefined {
  const { scope, basename } = scopedPackageParts(packageName);
  const fromBasename = cleanMcpBasename(basename);
  if (!isGeneric(fromBasename)) return fromBasename;
  const fromScope = scope ? cleanMcpBasename(scope) : undefined;
  return isGeneric(fromScope) ? undefined : fromScope;
}

/** Derive the host-facing MCP server key from an MCP registry name. */
export function deriveHostAliasFromMcpName(
  mcpName: string,
): string | undefined {
  const [namespace, name] = mcpName.trim().split("/");
  const fromName = cleanMcpBasename(name ?? namespace ?? "");
  if (!isGeneric(fromName)) return fromName;

  const namespaceParts = (namespace ?? "").split(".").filter(Boolean);
  const fromNamespace = cleanMcpBasename(namespaceParts.at(-1) ?? "");
  return isGeneric(fromNamespace) ? undefined : fromNamespace;
}

/** Infer an npm package from common npx-style stdio server definitions. */
export function inferNpmPackageFromServer(
  server: ServerDef | undefined,
): string | undefined {
  if (!server || server.transport !== "stdio") return undefined;
  if (typeof server.command !== "string" || server.command.trim() === "") {
    return undefined;
  }
  const runner = kebab(server.command.split(/[\\/]/).pop() ?? server.command);
  if (!["npx", "npm", "pnpm", "yarn", "bun"].includes(runner)) return undefined;

  const args = server.args ?? [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") continue;
    if (arg === "exec" || arg === "dlx" || arg === "x") continue;
    if (arg === "-y" || arg === "--yes" || arg === "--no-install") continue;
    if (arg === "--package" || arg === "-p") {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

export function resolveMcpPackageIdentity(input: {
  id?: string;
  mcp?: McpPackageIdentity;
  server?: ServerDef;
}): ResolvedMcpPackageIdentity {
  const packageName =
    input.mcp?.packageName ?? inferNpmPackageFromServer(input.server);
  const hostAlias =
    input.mcp?.hostAlias ??
    (input.mcp?.mcpName
      ? deriveHostAliasFromMcpName(input.mcp.mcpName)
      : undefined) ??
    (packageName ? deriveHostAliasFromPackageName(packageName) : undefined) ??
    (input.mcp?.bin ? cleanMcpBasename(input.mcp.bin) : undefined);

  return {
    ...(packageName ? { packageName } : {}),
    ...(input.mcp?.mcpName ? { mcpName: input.mcp.mcpName } : {}),
    ...(input.mcp?.bin ? { bin: input.mcp.bin } : {}),
    ...(hostAlias ? { hostAlias } : {}),
  };
}
