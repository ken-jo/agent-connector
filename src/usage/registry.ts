/**
 * usage/registry — the single source of truth for HOST usage readers.
 *
 * Mirrors adapters/registry.ts: each platform is ONE entry with a lazy `load()`
 * thunk resolving the reader module's default export. Adding a platform is a
 * single new entry here plus one `readers/<id>.ts` file — `getUsageReader` /
 * `allUsageReaders` and the scan orchestrator all derive from this list.
 *
 * `format` and `kind` are declared on the factory so the scan layer can describe
 * a reader (e.g. note a "synced" reader as skipped) without importing it.
 */

import type { PlatformId } from "../core/types.js";
import type { UsageReader, UsageReaderFactory } from "./types.js";

/**
 * Authoritative list of usage readers. To add a platform: drop
 * `src/usage/readers/<id>.ts` (default-exporting a {@link UsageReader}) and add
 * one entry below.
 */
export const USAGE_READER_REGISTRY: readonly UsageReaderFactory[] = [
  // U1 — JSONL readers
  {
    platformId: "claude-code",
    format: "jsonl",
    kind: "local",
    load: () => import("./readers/claude-code.js").then((m) => m.default),
  },
  {
    platformId: "codex",
    format: "jsonl",
    kind: "local",
    load: () => import("./readers/codex.js").then((m) => m.default),
  },
  {
    platformId: "gemini-cli",
    format: "jsonl",
    kind: "local",
    load: () => import("./readers/gemini-cli.js").then((m) => m.default),
  },
  {
    platformId: "qwen-code",
    format: "jsonl",
    kind: "local",
    load: () => import("./readers/qwen-code.js").then((m) => m.default),
  },
  {
    platformId: "copilot-cli",
    format: "jsonl",
    kind: "local",
    load: () => import("./readers/copilot-cli.js").then((m) => m.default),
  },
  {
    platformId: "pi",
    format: "jsonl",
    kind: "local",
    load: () => import("./readers/pi.js").then((m) => m.default),
  },
  {
    platformId: "kimi",
    format: "jsonl",
    kind: "local",
    load: () => import("./readers/kimi.js").then((m) => m.default),
  },
  {
    platformId: "openclaw",
    format: "jsonl",
    kind: "local",
    load: () => import("./readers/openclaw.js").then((m) => m.default),
  },
];

/** O(1) lookup index, built once at module-load time. */
const REGISTRY_BY_ID: ReadonlyMap<PlatformId, UsageReaderFactory> = new Map(
  USAGE_READER_REGISTRY.map((factory) => [factory.platformId, factory] as const),
);

/** Look up the lazy factory for a platform id, or undefined when unregistered. */
export function getUsageReaderFactory(id: PlatformId | string): UsageReaderFactory | undefined {
  return REGISTRY_BY_ID.get(id as PlatformId);
}

/** Resolve a platform id to its reader singleton, or undefined when unregistered. */
export async function getUsageReader(id: PlatformId | string): Promise<UsageReader | undefined> {
  const factory = getUsageReaderFactory(id);
  return factory ? factory.load() : undefined;
}

/** Load every registered reader (imports run in parallel; preserves order). */
export async function allUsageReaders(): Promise<UsageReader[]> {
  return Promise.all(USAGE_READER_REGISTRY.map((factory) => factory.load()));
}
