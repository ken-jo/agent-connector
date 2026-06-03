/**
 * core/toml — minimal TOML string IO.
 *
 * The TOML analog of core/yaml's read/write helpers. Lifted from the codex
 * adapter's private readToml/writeToml so the Group-B command renderers for
 * Gemini/Qwen/Codex (which author `.toml` command files) share one
 * implementation rather than each re-importing @iarna/toml.
 *
 * Deliberately tiny and string-oriented: these are pure (de)serializers — no
 * filesystem touches, no dryRun, no merge logic. Callers own reading/writing
 * and any idempotency/upsert (the shapes differ per platform), exactly as the
 * adapters layer their own logic on top of the JSON/YAML helpers.
 */

import TOML from "@iarna/toml";

/**
 * Serialize a plain object to a TOML string.
 *
 * @iarna/toml's `stringify` is typed to accept its own `JsonMap`; our objects
 * are structurally compatible, so we cast at the boundary (same approach the
 * codex adapter used). Returns the TOML text — the caller writes it.
 */
export function writeTomlString(obj: Record<string, unknown>): string {
  return TOML.stringify(obj as never);
}

/**
 * Parse a TOML string into a typed object. Throws on malformed TOML (callers
 * that want fail-soft behavior should wrap in try/catch, mirroring how the
 * codex adapter degrades a corrupt config.toml to `{}`).
 */
export function readTomlString<T = Record<string, unknown>>(text: string): T {
  return TOML.parse(text) as T;
}
