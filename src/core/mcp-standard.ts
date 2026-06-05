/**
 * core/mcp-standard — pinned literals + guards for the official MCP standards
 * agent-connector EMITS (registry server.json, MCPB bundle) or SPEAKS (the
 * connection-lifecycle wire used by `doctor --probe`).
 *
 * Each pinned constant is the CURRENT released value verified 2026-06-05 against
 * the upstream spec/schema. They are deliberately centralized + annotated
 * MUST-VERIFY-AT-IMPLEMENTATION: a newer spec revision can supersede any of them
 * without breaking us, so the bump is a one-line change here, never scattered.
 *
 * Sources:
 *  • server.schema.json 2025-12-11 — https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
 *  • MCPB manifest 0.3 — github.com/anthropics/mcpb (MANIFEST.md)
 *  • MCP protocol 2025-11-25 — modelcontextprotocol.io/specification/2025-11-25
 *    (latest RELEASED revision. 2026-07-28 is a release-candidate only — do NOT
 *    advance to it until it publishes as a stable dated revision. The probe
 *    offers this version but ACCEPTS whatever a server negotiates, so the
 *    offered literal being stale never breaks interop — only this constant.)
 */

import type { Transport } from "./types.js";

/** Registry server.json JSON Schema URL (released 2025-12-11). MUST-VERIFY on bump. */
export const MCP_SERVER_SCHEMA_URL =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

/** Current MCPB bundle manifest_version (anthropics/mcpb). MUST-VERIFY on bump. */
export const MCPB_MANIFEST_VERSION = "0.3";

/**
 * Latest RELEASED MCP protocol revision `doctor --probe` offers in `initialize`.
 * Current = 2025-11-25. MUST-VERIFY on bump; stay on the latest *released*
 * revision (2026-07-28 is RC-only as of 2026-06). Negotiation accepts whatever
 * the server returns, so this is the offered value, not a hard requirement.
 */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

/** Default npm registry base URL stamped into server.json npm packages. */
export const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org";

/**
 * server.json transport.type enum — the EXACT values the 2025-12-11 schema
 * accepts (packages[].transport.type and remotes[].type). Our `http` Transport
 * maps to the spec slug "streamable-http"; "ws" is non-spec (see below).
 */
export type RegistryTransportType = "stdio" | "streamable-http" | "sse";

/**
 * Map our {@link Transport} union to the registry/server.json transport slug.
 * Returns null for "ws" — WebSocket is NOT a spec transport (it can only exist
 * as a vendor custom transport, e.g. Claude Code's non-spec type:"ws"), so a
 * conformant artifact must REJECT it rather than emit an invalid type. The spec
 * defines exactly stdio + streamable-http, with sse the deprecated HTTP+SSE.
 */
export function registryTransportType(transport: Transport): RegistryTransportType | null {
  switch (transport) {
    case "stdio":
      return "stdio";
    case "http":
      return "streamable-http";
    case "sse":
      return "sse";
    case "ws":
      return null;
  }
}

/**
 * Is `v` a CONCRETE version the MCP Registry accepts? The registry rejects
 * ranges ("^1.2.3", "~1.2.3", ">=1.2.3", "1.x", "1.*"); only a pinned SemVer
 * (optionally with a -prerelease / +build suffix) is valid. "0.0.0" is concrete
 * (so it passes this guard) but is the unset placeholder — callers warn on it
 * separately via {@link isPlaceholderVersion}.
 */
export function isConcreteSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v);
}

/** The unset default version a connector ships with until the dev sets a real one. */
export function isPlaceholderVersion(v: string): boolean {
  return v === "0.0.0";
}

/**
 * Reverse-DNS registry namespace pattern (the part BEFORE the "/" in a
 * server.json `name`). The full name regex is
 * `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`; the namespace side allows letters, digits,
 * dots and hyphens (NO underscore) — e.g. "io.github.acme" or "com.acme".
 */
export const REGISTRY_NAMESPACE_RE = /^[a-zA-Z0-9.-]+$/;

/** The full server.json `name` regex (namespace "/" server-name), per the schema. */
export const REGISTRY_NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
