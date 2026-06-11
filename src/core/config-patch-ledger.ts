/**
 * core/config-patch-ledger — the persisted, refcounted ownership ledger behind
 * the declarative `configPatch` surface, plus the shared configPatch helpers
 * (leaf-path grammar, JSON-value checks, the agent-connector namespace guard,
 * canonical hashing, and the manual-edit hint every skip-warn prints).
 *
 * WHY A LEDGER (and not the hooks-style recompute ownership): hook entries
 * embed the connector id in their command string, so uninstall can identify
 * "mine" by inspection. configPatch writes bare host keys (`true` is `true`) —
 * not attributable by inspection — and the same key may be needed by SEVERAL
 * connectors (a shared host feature flag). Without a persisted refcount,
 * connector A uninstalling would delete a key connector B still relies on.
 *
 * Contract (docs/ARCHITECTURE.md §4 "configPatch"):
 *   • One global file at `<dataRoot>/state/config-patches.json`, written
 *     ATOMICALLY (temp + rename) — shared across connectors because
 *     refcounting requires a global view; survives a connector's record purge.
 *   • Primary key per entry: (platform, file, key). `prior` is ALWAYS
 *     `{ present: false }` — ownership only ever attaches to keys
 *     agent-connector itself created (set-if-absent), so the blind
 *     "restore prior value" footgun is structurally impossible.
 *   • Uninstall removes a key ONLY when the releasing connector is the LAST
 *     owner AND the current value still deep-equals `writtenValue` AND prior
 *     was absent; any mismatch → skip-warn and leave the key in place.
 *   • The ledger is advisory FOR DELETION ONLY: the worst desync outcome is a
 *     skip-warn and a leftover key, never data loss.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { ConfigPatchDef, JsonValue, PlatformId } from "./types.js";
import { ensureDir } from "./paths.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared configPatch helpers (grammar / values / namespace guard / hints)
// ─────────────────────────────────────────────────────────────────────────

/** Grammar for ONE dotted-path segment: no dots-in-key, no array indices. */
export const CONFIG_PATCH_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/**
 * True when `key` is a valid dotted LEAF path: 1+ segments joined by ".",
 * every segment matching {@link CONFIG_PATCH_SEGMENT_RE}.
 */
export function isValidConfigPatchKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0) return false;
  return key.split(".").every((seg) => CONFIG_PATCH_SEGMENT_RE.test(seg));
}

/**
 * True when `value` is JSON-serializable data (string / finite number /
 * boolean / null / arrays / plain objects thereof). Rejects undefined,
 * functions, symbols, bigints, NaN/Infinity (JSON.stringify silently corrupts
 * those), and class instances other than plain objects/arrays.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      break;
    default:
      return false;
  }
  if (Array.isArray(value)) return value.every((v) => isJsonValue(v));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every((v) => isJsonValue(v));
}

/**
 * GUARDED NAMESPACE: keys agent-connector already models are NOT patchable —
 * the proper surface must be used instead (otherwise a connector could smuggle
 * hooks past the nativeHooks modeling/reporting, or fight the server install).
 * Returns a human-readable violation pointing at the proper surface, or null.
 * Checked at defineConnector (statically knowable) AND re-enforced in the
 * adapter (meta-loaded connectors must not bypass it).
 */
export function configPatchNamespaceViolation(key: string): string | null {
  const head = key.split(".")[0] ?? "";
  if (head === "hooks") {
    return `"${key}" targets the hooks config agent-connector already models; declare it via \`hooks\` (normalized) or \`platforms.<id>.nativeHooks\` instead`;
  }
  if (
    head === "mcpServers" ||
    head === "enableAllProjectMcpServers" ||
    head === "enabledMcpjsonServers" ||
    head === "disabledMcpjsonServers"
  ) {
    return `"${key}" targets MCP server registration agent-connector already models; declare it via \`server\` / \`platforms.<id>.server\` / \`extra\` instead`;
  }
  return null;
}

/**
 * The exact manual edit a user can perform when a patch is skipped (conflict,
 * drift, unsupported host, denylist…). Printed in every skip-warn so a single
 * declaration doubles as its own documented manual step.
 */
export function configPatchManualEdit(patch: ConfigPatchDef): string {
  const docs = patch.docsUrl ? ` — see ${patch.docsUrl}` : "";
  return (
    `manual edit if wanted: set ${patch.key} = ${describeJsonValue(patch.value)} ` +
    `(${patch.reason})${docs}`
  );
}

/** Compact single-line JSON rendering for diffs/warnings ("<absent>" for undefined). */
export function describeJsonValue(value: JsonValue | undefined): string {
  if (value === undefined) return "<absent>";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Canonical JSON / deep equality
// ─────────────────────────────────────────────────────────────────────────

/** Canonical (sorted-keys) JSON of a value — the hash/equality basis. */
export function canonicalJson(value: JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
  return `{${parts.join(",")}}`;
}

/** sha256 of the canonical JSON — the fast path; deep-equal is the authority. */
export function hashJsonValue(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Order-insensitive (object keys) deep equality over JSON data. */
export function jsonDeepEquals(
  a: JsonValue | undefined,
  b: JsonValue | undefined,
): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

// ─────────────────────────────────────────────────────────────────────────
// Ledger shape + persistence
// ─────────────────────────────────────────────────────────────────────────

/** One connector's registration on a ledger entry. */
export interface ConfigPatchOwner {
  connectorId: string;
  connectorVersion: string;
  installedAt: string;
}

/** Refcounted ownership record for one (platform, file, key). */
export interface ConfigPatchLedgerEntry {
  platform: PlatformId;
  /** Absolute path of the file actually written (scope-resolved at install time). */
  file: string;
  /** Dotted leaf path — (platform, file, key) is the primary key. */
  key: string;
  writtenValue: JsonValue;
  /** sha256 of canonical (sorted-keys) JSON of writtenValue (fast path only). */
  writtenValueHash: string;
  /** Always { present: false } — ownership ONLY attaches to keys we created. */
  prior: { present: false };
  owners: ConfigPatchOwner[];
}

export interface ConfigPatchLedger {
  version: 1;
  entries: ConfigPatchLedgerEntry[];
}

/** Ledger file path under the framework data-root. */
export function configPatchLedgerPath(dataRoot: string): string {
  return join(dataRoot, "state", "config-patches.json");
}

/**
 * Load the ledger; a missing or corrupt file degrades to an empty ledger
 * (advisory-for-deletion-only: a lost ledger can never cause data loss, only
 * retained keys + skip-warns).
 */
export function loadConfigPatchLedger(dataRoot: string): ConfigPatchLedger {
  const path = configPatchLedgerPath(dataRoot);
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ConfigPatchLedger;
    if (!parsed || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
    return { version: 1, entries: parsed.entries.filter(isPlausibleEntry) };
  } catch {
    return { version: 1, entries: [] };
  }
}

/** Minimal shape sanity for a persisted entry (corrupt rows are dropped). */
function isPlausibleEntry(e: unknown): e is ConfigPatchLedgerEntry {
  if (e == null || typeof e !== "object") return false;
  const entry = e as Partial<ConfigPatchLedgerEntry>;
  return (
    typeof entry.platform === "string" &&
    typeof entry.file === "string" &&
    typeof entry.key === "string" &&
    Array.isArray(entry.owners)
  );
}

/**
 * Persist the ledger ATOMICALLY: write to a temp file in the same directory,
 * then rename over the target (rename is atomic on the same filesystem).
 */
export function saveConfigPatchLedger(dataRoot: string, ledger: ConfigPatchLedger): void {
  const path = configPatchLedgerPath(dataRoot);
  ensureDir(dirname(path));
  const tmpFile = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmpFile, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    renameSync(tmpFile, path);
  } catch (err) {
    rmSync(tmpFile, { force: true });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Ledger operations (pure in-memory; callers load → mutate → save)
// ─────────────────────────────────────────────────────────────────────────

/** Find the entry for (platform, file, key), or undefined. */
export function findLedgerEntry(
  ledger: ConfigPatchLedger,
  platform: PlatformId,
  file: string,
  key: string,
): ConfigPatchLedgerEntry | undefined {
  return ledger.entries.find(
    (e) => e.platform === platform && e.file === file && e.key === key,
  );
}

/** Every entry on `platform` owned (at least in part) by `connectorId`. */
export function ledgerEntriesOwnedBy(
  ledger: ConfigPatchLedger,
  platform: PlatformId,
  connectorId: string,
): ConfigPatchLedgerEntry[] {
  return ledger.entries.filter(
    (e) => e.platform === platform && e.owners.some((o) => o.connectorId === connectorId),
  );
}

/** Create a fresh entry (prior is absent BY CONSTRUCTION) and append it. */
export function createLedgerEntry(
  ledger: ConfigPatchLedger,
  init: {
    platform: PlatformId;
    file: string;
    key: string;
    value: JsonValue;
    connectorId: string;
    connectorVersion: string;
  },
): ConfigPatchLedgerEntry {
  const entry: ConfigPatchLedgerEntry = {
    platform: init.platform,
    file: init.file,
    key: init.key,
    writtenValue: init.value,
    writtenValueHash: hashJsonValue(init.value),
    prior: { present: false },
    owners: [
      {
        connectorId: init.connectorId,
        connectorVersion: init.connectorVersion,
        installedAt: new Date().toISOString(),
      },
    ],
  };
  ledger.entries.push(entry);
  return entry;
}

/**
 * Register `connectorId` as a (co-)owner. Returns true when added, false when
 * it was already an owner (idempotent re-install → no ledger mutation).
 */
export function addLedgerOwner(
  entry: ConfigPatchLedgerEntry,
  connectorId: string,
  connectorVersion: string,
): boolean {
  if (entry.owners.some((o) => o.connectorId === connectorId)) return false;
  entry.owners.push({
    connectorId,
    connectorVersion,
    installedAt: new Date().toISOString(),
  });
  return true;
}

/**
 * Remove `connectorId` from the owners. Returns whether an owner was removed
 * and whether the entry is now ownerless (last owner out).
 */
export function removeLedgerOwner(
  entry: ConfigPatchLedgerEntry,
  connectorId: string,
): { removed: boolean; lastOwner: boolean } {
  const before = entry.owners.length;
  entry.owners = entry.owners.filter((o) => o.connectorId !== connectorId);
  return { removed: entry.owners.length < before, lastOwner: entry.owners.length === 0 };
}

/** Drop an entry from the ledger (identity match). */
export function dropLedgerEntry(
  ledger: ConfigPatchLedger,
  entry: ConfigPatchLedgerEntry,
): void {
  ledger.entries = ledger.entries.filter((e) => e !== entry);
}
