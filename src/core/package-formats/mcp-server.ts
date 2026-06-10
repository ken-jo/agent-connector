/**
 * core/package-formats/mcp-server — emit an official MCP Registry `server.json`.
 *
 * Unlike the host plugin/marketplace bundles, server.json is a DISCOVERY +
 * PUBLISH artifact: it describes the developer's REAL upstream MCP server (what
 * a registry installer runs DIRECTLY), so it must NOT carry agentconnect's
 * `serve` telemetry wrapper. It is emitted from the connector's `publish`
 * metadata (the namespace the dev proved ownership of + their published package)
 * and conforms to the pinned 2025-12-11 schema:
 *   • name = `${publish.registryNamespace}/${connector.id}` (one '/', regex-checked)
 *   • version = concrete SemVer (ranges are rejected by the registry)
 *   • stdio  → packages[] { registryType:"npm", identifier:<dev pkg>, transport:{type:"stdio"} }
 *   • remote → remotes[]  { type:"streamable-http"|"sse", url, headers }
 *   • token env vars are marked isSecret.
 *
 * agentconnect EMITS a conformant server.json; the dev runs the publish-time
 * ownership proof + upload themselves with the official `mcp-publisher` CLI.
 */

import { resolve } from "node:path";

import type { ResolvedConnector, ServerDef } from "../types.js";
import {
  MCP_SERVER_SCHEMA_URL,
  NPM_REGISTRY_BASE_URL,
  REGISTRY_NAME_RE,
  isConcreteSemver,
  isPlaceholderVersion,
  registryTransportType,
} from "../mcp-standard.js";
import type { EmitContext, FormatEmitter, PackageResult } from "./shared.js";
import { createEmitter, json } from "./shared.js";

/** A server.json KeyValueInput (environmentVariables[] / headers[] entry). */
interface KeyValueInput {
  name: string;
  isSecret?: boolean;
  isRequired?: boolean;
}

/** Build environmentVariables[] from a stdio ServerDef, marking the bearer token secret. */
function buildEnvVars(server: ServerDef): KeyValueInput[] {
  const vars: KeyValueInput[] = [];
  const byName = new Map<string, KeyValueInput>();
  for (const key of Object.keys(server.env ?? {})) {
    const v: KeyValueInput = { name: key };
    vars.push(v);
    byName.set(key, v);
  }
  if (server.auth?.type === "bearerEnv" && server.auth.bearerEnvVar) {
    const name = server.auth.bearerEnvVar;
    const existing = byName.get(name);
    if (existing) {
      existing.isSecret = true;
      existing.isRequired = true;
    } else {
      vars.push({ name, isSecret: true, isRequired: true });
    }
  }
  return vars;
}

/** Build the conformant server.json object (throws a clear error on missing inputs). */
function buildServerJson(
  connector: ResolvedConnector,
  notes: string[],
): Record<string, unknown> {
  const publish = connector.publish ?? {};

  if (!publish.registryNamespace) {
    throw new Error(
      'package --format mcp-server-json needs publish.registryNamespace — a reverse-DNS ' +
        'namespace you OWN (e.g. "io.github.<your-handle>" or "com.<your-domain>"). ' +
        "agentconnect never publishes under a namespace it owns; set it in your connector config.",
    );
  }
  const name = `${publish.registryNamespace}/${connector.id}`;
  if (!REGISTRY_NAME_RE.test(name)) {
    throw new Error(
      `server.json name "${name}" must match ${REGISTRY_NAME_RE} (exactly one "/").`,
    );
  }
  if (!isConcreteSemver(connector.version)) {
    throw new Error(
      `server.json version must be a concrete SemVer (the registry rejects ranges); got "${connector.version}".`,
    );
  }
  if (isPlaceholderVersion(connector.version)) {
    notes.push(
      'version is the unset placeholder "0.0.0" — set a real version before publishing to the registry.',
    );
  }

  const out: Record<string, unknown> = {
    $schema: MCP_SERVER_SCHEMA_URL,
    name,
    description: connector.displayName,
    version: connector.version,
  };

  const server = connector.server;
  if (!server) {
    notes.push(
      "connector declares no server — emitted server.json carries neither packages nor remotes " +
        "(a hooks/commands-only connector is not a registry server).",
    );
    return out;
  }

  const tt = registryTransportType(server.transport);
  if (tt === null) {
    notes.push(
      `transport "${server.transport}" is not an MCP spec transport and cannot be represented in ` +
        "server.json; emitted server metadata without a package/remote entry.",
    );
    return out;
  }

  if (server.transport === "stdio") {
    if (!publish.packageName) {
      throw new Error(
        "package --format mcp-server-json needs publish.packageName — your REAL published npm " +
          'package that runs the MCP server (e.g. "@acme/acme-db-mcp"). The registry runs that ' +
          "package directly, not agentconnect's serve wrapper.",
      );
    }
    const pkg: Record<string, unknown> = {
      registryType: "npm",
      registryBaseUrl: publish.registryBaseUrl ?? NPM_REGISTRY_BASE_URL,
      identifier: publish.packageName,
      version: connector.version,
      transport: { type: "stdio" },
    };
    const envVars = buildEnvVars(server);
    if (envVars.length > 0) pkg.environmentVariables = envVars;
    out.packages = [pkg];
  } else {
    // streamable-http | sse → remotes[]
    const remote: Record<string, unknown> = { type: tt, url: server.url };
    const headers = Object.keys(server.headers ?? {}).map((k): KeyValueInput => ({ name: k }));
    if (headers.length > 0) remote.headers = headers;
    if (server.auth && server.auth.type !== "none") {
      notes.push(
        `remote server uses auth "${server.auth.type}" — add the credential header (isSecret) to ` +
          "the emitted remotes[].headers before publishing.",
      );
    }
    out.remotes = [remote];
  }

  return out;
}

/** Emit a registry-conformant server.json for `connector` into ctx.outDir. */
export const emitMcpServerJson: FormatEmitter = (
  connector: ResolvedConnector,
  ctx: EmitContext,
): PackageResult => {
  const emitter = createEmitter(ctx.dryRun);
  const notes: string[] = [];
  const serverJson = buildServerJson(connector, notes);
  const path = resolve(ctx.outDir, "server.json");
  emitter.emit(path, json(serverJson));
  return {
    files: emitter.files,
    pluginDir: ctx.outDir,
    ...(notes.length > 0 ? { notes } : {}),
  };
};
