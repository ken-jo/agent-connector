/**
 * core/json-leaf — dotted leaf-path helpers over a parsed JSON object.
 *
 * Shared by every adapter that owns ONE key in a host settings file through the
 * config-patch ownership ledger (claude-code `statusLine`, qwen-code
 * `ui.statusLine`, antigravity-cli / droid `statusLine`, raw configPatch). The
 * contract the callers rely on:
 *   - read reports "blocked" for the first intermediate that exists but is not
 *     a plain object — the skip-warn case (never replace a user's `ui: "dark"`);
 *   - write creates ONLY absent intermediate objects (callers verify not blocked);
 *   - delete removes the leaf key only — intermediates, even ones we created, are
 *     left in place (pruning risks clobbering sibling keys the user set).
 */

import type { JsonValue } from "./types.js";

/** Result of looking up a dotted leaf path in a parsed JSON object. */
export type JsonLeafLookup =
  | { kind: "absent" }
  | { kind: "present"; value: JsonValue }
  | { kind: "blocked"; atPath: string };

/** Walk `segments` through `root`; see the module contract for "blocked". */
export function readJsonLeaf(root: Record<string, unknown>, segments: string[]): JsonLeafLookup {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = node[segments[i]!];
    if (next === undefined) return { kind: "absent" };
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      return { kind: "blocked", atPath: segments.slice(0, i + 1).join(".") };
    }
    node = next as Record<string, unknown>;
  }
  const leaf = node[segments[segments.length - 1]!];
  if (leaf === undefined) return { kind: "absent" };
  return { kind: "present", value: leaf as JsonValue };
}

/** Write `value` at the leaf, creating ONLY absent intermediate objects. */
export function writeJsonLeaf(
  root: Record<string, unknown>,
  segments: string[],
  value: JsonValue,
): void {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = node[seg];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      node[seg] = created;
      node = created;
    } else {
      node = next as Record<string, unknown>;
    }
  }
  node[segments[segments.length - 1]!] = value;
}

/** Delete the leaf key only; intermediates are left in place. */
export function deleteJsonLeaf(root: Record<string, unknown>, segments: string[]): void {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = node[segments[i]!];
    if (next === null || typeof next !== "object" || Array.isArray(next)) return;
    node = next as Record<string, unknown>;
  }
  delete node[segments[segments.length - 1]!];
}
