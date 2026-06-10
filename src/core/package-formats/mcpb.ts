/**
 * core/package-formats/mcpb — emit an MCPB (.mcpb, formerly DXT) bundle manifest.
 *
 * MCPB is the official cross-client one-click LOCAL-install bundle (Claude
 * Desktop + any MCPB host). A real .mcpb is a SELF-CONTAINED zip (manifest.json
 * + the server + vendored node_modules), which agent-connector cannot assemble
 * at emit time — we do not have the developer's built server tree. So, per the
 * conformance analysis, we emit a CONFORMANT manifest.json describing a
 * self-contained node bundle (NOT an out-of-spec `npx` command-reference, which
 * would assume network + node on PATH at launch and break offline/signing) plus
 * a packaging RECIPE, and leave the `mcpb pack`/`mcpb sign` to the developer —
 * mirroring how server.json defers the publish-time ownership proof.
 *
 * Secrets (the bearer token / sensitive env) are routed through `user_config`
 * (sensitive:true) and referenced as `${user_config.<key>}` in mcp_config.env,
 * so credentials are collected by the host keychain, never inlined.
 */

import { resolve } from "node:path";

import type { ResolvedConnector, ServerDef } from "../types.js";
import {
  MCPB_MANIFEST_VERSION,
  isConcreteSemver,
  isPlaceholderVersion,
} from "../mcp-standard.js";
import type { EmitContext, FormatEmitter, PackageResult } from "./shared.js";
import { createEmitter, json } from "./shared.js";

/** "ACME_DB_TOKEN" → "Acme Db Token" for a user_config field title. */
function titleize(s: string): string {
  return s
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** The names of env vars that hold secrets (the bearer token). */
function secretEnvNames(server: ServerDef): Set<string> {
  const names = new Set<string>();
  if (server.auth?.type === "bearerEnv" && server.auth.bearerEnvVar) {
    names.add(server.auth.bearerEnvVar);
  }
  return names;
}

function recipeReadme(connector: ResolvedConnector): string {
  return `# ${connector.displayName} — MCPB bundle

\`agent-connector package --format mcpb\` emitted the conformant **manifest.json**
(manifest_version ${MCPB_MANIFEST_VERSION}) for this connector. It does NOT build
the \`.mcpb\` zip — that step vendors your server and is yours to run, so the
bundle stays self-contained and signable.

## Finish the bundle

1. Put your built, self-contained MCP server at \`server/index.js\`
   (the manifest's \`entry_point\` / \`mcp_config\`).
2. Vendor production dependencies into the bundle:

   \`\`\`bash
   cd server && npm install --omit=dev && cd ..
   \`\`\`

3. Pack (and optionally sign) with the official MCPB CLI:

   \`\`\`bash
   npx @anthropic-ai/mcpb pack .      # → ${connector.id}.mcpb
   npx @anthropic-ai/mcpb sign ${connector.id}.mcpb
   \`\`\`

The resulting \`.mcpb\` installs one-click into Claude Desktop and any MCPB host.
Secrets are declared under \`user_config\` and collected by the host keychain at
install time — never inline them in the manifest.
`;
}

/** Emit a conformant MCPB manifest.json + packaging recipe for `connector`. */
export const emitMcpbBundle: FormatEmitter = (
  connector: ResolvedConnector,
  ctx: EmitContext,
): PackageResult => {
  const publish = connector.publish ?? {};
  if (!publish.author?.name) {
    throw new Error(
      "package --format mcpb needs publish.author.name — the MCPB manifest requires an author.",
    );
  }
  if (!isConcreteSemver(connector.version)) {
    throw new Error(
      `mcpb manifest version must be a concrete SemVer; got "${connector.version}".`,
    );
  }

  const server = connector.server;
  if (!server) {
    throw new Error("package --format mcpb needs a server (an MCPB bundle packages an MCP server).");
  }
  if (server.transport !== "stdio") {
    throw new Error(
      `package --format mcpb supports stdio servers; "${server.transport}" is a remote server — ` +
        "publish it via the registry (--format mcp-server-json) instead.",
    );
  }

  const notes: string[] = [];
  if (isPlaceholderVersion(connector.version)) {
    notes.push('version is the unset placeholder "0.0.0" — set a real version before packing.');
  }

  // Route secret env vars through user_config; pass the rest through verbatim.
  const secrets = secretEnvNames(server);
  const env: Record<string, string> = {};
  const userConfig: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(server.env ?? {})) {
    if (secrets.has(k)) {
      const key = k.toLowerCase();
      userConfig[key] = {
        type: "string",
        title: titleize(k),
        description: `Value for ${k}`,
        sensitive: true,
        required: true,
      };
      env[k] = `\${user_config.${key}}`;
    } else {
      env[k] = v;
    }
  }
  // A bearer-token env not already present in server.env still needs a field.
  for (const name of secrets) {
    if (!(name in env)) {
      const key = name.toLowerCase();
      userConfig[key] = {
        type: "string",
        title: titleize(name),
        description: `Value for ${name}`,
        sensitive: true,
        required: true,
      };
      env[name] = `\${user_config.${key}}`;
    }
  }

  const author: Record<string, string> = { name: publish.author.name };
  if (publish.author.email) author.email = publish.author.email;
  if (publish.author.url) author.url = publish.author.url;

  const mcpConfig: Record<string, unknown> = {
    command: "node",
    args: ["${__dirname}/server/index.js"],
  };
  if (Object.keys(env).length > 0) mcpConfig.env = env;

  const manifest: Record<string, unknown> = {
    manifest_version: MCPB_MANIFEST_VERSION,
    name: connector.id,
    version: connector.version,
    description: connector.displayName,
    author,
    server: {
      type: "node",
      entry_point: "server/index.js",
      mcp_config: mcpConfig,
    },
  };
  if (Object.keys(userConfig).length > 0) manifest.user_config = userConfig;

  // If the dev's real command is not node-ish, the node template needs adjusting.
  if (server.command && !/\b(node|npx)\b/.test(server.command)) {
    notes.push(
      `your server command is "${server.command}" — the emitted manifest assumes a node ` +
        "server (server.type:node); adjust server.type/entry_point for your runtime (python|binary).",
    );
  }
  notes.push(
    "emitted manifest.json + README recipe; this format does NOT build the .mcpb zip. " +
      "Place your self-contained server at server/index.js, vendor deps, then run `mcpb pack` (see README).",
  );

  const emitter = createEmitter(ctx.dryRun);
  emitter.emit(resolve(ctx.outDir, "manifest.json"), json(manifest));
  emitter.emit(resolve(ctx.outDir, "README.md"), recipeReadme(connector));
  return { files: emitter.files, pluginDir: ctx.outDir, notes };
};
