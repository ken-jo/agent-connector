/**
 * usage/jsonl — tolerant JSONL / JSON readers + a file-mtime helper.
 *
 * Every reader is fail-open: a malformed line is skipped (never thrown), a
 * missing/unreadable file yields no rows. Mirrors the NdjsonStore.query and host
 * parser behavior — bad input degrades to empty, it does not crash a report.
 *
 * Ports tokscale sessions/utils.rs file_modified_timestamp_ms (mtime fallback)
 * and the per-line skip-malformed loop used by every JSONL parser.
 */

import { readFileSync, statSync } from "node:fs";

/**
 * Parse a JSONL file into objects, skipping blank/malformed lines. Returns [] on
 * any read error (missing file, permissions). Each yielded value is whatever
 * `JSON.parse` produced — callers narrow it. Order matches the file.
 *
 * Returns an array (not a generator) so callers can index/slice; for the file
 * sizes here (session logs) a full read is acceptable, matching the Rust
 * BufReader-per-file approach.
 */
export function readJsonlLines(path: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      continue; // skip malformed line
    }
  }
  return out;
}

/**
 * Read and parse a whole JSON file. Returns undefined on any read/parse error
 * (the fail-open contract for JSON readers). Caller narrows the unknown result.
 */
export function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * File modification time in epoch ms, used as a timestamp fallback when a log
 * line carries none. Port of file_modified_timestamp_ms: falls back to "now"
 * when the file cannot be stat'd so a row is never dropped for lack of a ts.
 */
export function fileMtimeMs(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs);
  } catch {
    return Date.now();
  }
}
