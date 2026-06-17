/**
 * tests/support/fs — shared filesystem read helpers for adapter tests.
 *
 * These two helpers were inlined-and-duplicated across the per-host suite
 * (`readJson` in ~19 files, `splitFrontmatter` in ~21). Centralising them here
 * removes that copy-paste exactly as `tests/support/env.ts` did for the env
 * harness. A per-host file imports only the helper(s) it needs.
 */
import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

/** JSON.parse a file (the readJson wrapper duplicated across ~19 test files). */
export function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Split a md+frontmatter doc into { frontmatter, body } (duplicated across ~21 files). */
export function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  if (!m) throw new Error(`not a frontmatter doc:\n${text}`);
  return { frontmatter: parseYaml(m[1]!) as Record<string, unknown>, body: m[2]! };
}
