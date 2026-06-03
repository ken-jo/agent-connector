/**
 * core/yaml — minimal YAML config IO.
 *
 * The YAML analog of BaseAdapter's JSON helpers (readJson/writeJson). Adapters
 * whose native config is YAML (Goose's config.yaml, Hermes's config.yaml) cannot
 * use the JSON helpers, so they reach for these two functions instead — same
 * existsSync-guard / parse-failure-tolerant / dryRun-respecting contract, just
 * over the `yaml` package's parse()/stringify() rather than JSON.parse/stringify.
 *
 * Deliberately tiny: read-or-null and ensureDir+write. All merge/upsert/idempotency
 * logic lives in each adapter (the shapes differ per platform), exactly as the
 * JSON adapters layer their own upsert on top of writeJson.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { parse, stringify } from "yaml";

import { ensureDir } from "./paths.js";

/**
 * Read and parse a YAML file. Returns `null` when the file is missing OR when it
 * fails to parse (mirrors BaseAdapter.readJson's fail-soft behavior so a corrupt
 * file degrades to "treat as absent" rather than throwing mid-install).
 */
export function readYaml<T = Record<string, unknown>>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = parse(readFileSync(path, "utf8")) as T | null | undefined;
    // An empty YAML document parses to null/undefined — normalize to null.
    return parsed == null ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * Serialize `data` to YAML and write it to `path`, creating parent dirs as
 * needed. Honors `dryRun` (no write). Mirrors BaseAdapter.writeJson's signature.
 */
export function writeYaml(path: string, data: unknown, dryRun = false): void {
  if (dryRun) return;
  ensureDir(dirname(path));
  writeFileSync(path, stringify(data), "utf8");
}
