// ─────────────────────────────────────────────────────────────────────────
// host-paths.ts — shared OS user-config-dir base resolvers
//
// Several adapters resolve the SAME per-OS "user config base" directory with
// the same logic (XDG on posix; %APPDATA%/%LOCALAPPDATA% on Windows, each with
// a ~/AppData fallback). These helpers consolidate that resolution so the
// per-host adapters only carry their host-specific SUFFIX. The result is
// byte-identical for absolute/clean config-dir inputs (the realistic case);
// a non-canonical env value (relative, trailing slash, `..`) is normalized via
// `resolve()` rather than passed through bare — a safe canonicalization.
//
// Scope note: these are the USER-CONFIG-DIR bases (where a host keeps its
// settings/config files). The agent-connector *data-root* paths (our own
// per-project state) live in core/paths.ts — do NOT conflate the two.
//
// Host-specific config-home resolvers that are SHARED across modules (e.g.
// `codexConfigHome`, used by BOTH the codex adapter and marketplace detection)
// DO live here, so the writer and the probe can never disagree on the dir.
// Single-caller host envs (PI_CODING_AGENT_DIR, OPENCLAW_*) stay in their own
// adapter.
// ─────────────────────────────────────────────────────────────────────────

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** $XDG_CONFIG_HOME when set & non-empty, else ~/.config. */
export function xdgConfigHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && xdg.trim() !== "" ? resolve(xdg) : join(homedir(), ".config");
}

/** %APPDATA% (Roaming) when set & non-empty, else ~/AppData/Roaming. */
export function roamingAppData(): string {
  const appData = process.env.APPDATA;
  return appData && appData.trim() !== ""
    ? resolve(appData)
    : join(homedir(), "AppData", "Roaming");
}

/** %LOCALAPPDATA% when set & non-empty, else ~/AppData/Local. */
export function localAppData(): string {
  const local = process.env.LOCALAPPDATA;
  return local && local.trim() !== ""
    ? resolve(local)
    : join(homedir(), "AppData", "Local");
}

/** Codex's config home: $CODEX_HOME (tilde-expanded, then resolved) when set
 *  & non-empty, else ~/.codex. Shared by the codex adapter (writer) and the
 *  marketplace detection probe so they never disagree on the config dir. */
export function codexConfigHome(): string {
  const env = process.env.CODEX_HOME;
  if (env && env.trim() !== "") {
    if (env.startsWith("~")) return join(homedir(), env.replace(/^~[/\\]?/, ""));
    return resolve(env);
  }
  return join(homedir(), ".codex");
}

/**
 * Grok Build's config home: $GROK_HOME (tilde-expanded, then resolved) when set
 * & non-empty, else ~/.grok.
 *
 * Source: xai-org/grok-build user guide 05-configuration.md ("`GROK_HOME` |
 * Override config directory (default: `~/.grok`)") and 26-config-reference.md
 * ("`$GROK_HOME/config.toml` … Default `$GROK_HOME` is `~/.grok`").
 *
 * COLLISION NOTE: the unrelated community CLI behind adapter id `grok-cli`
 * (superagent-ai/grok-cli) hardcodes `~/.grok` too and does NOT honor
 * $GROK_HOME. The two products therefore share the default directory but never
 * a FILE: Grok Build owns `config.toml`, Grok CLI owns `user-settings.json`.
 * Both adapters key detection on their own exclusive marker file and bow out of
 * a bare shared dir that carries only the sibling's marker.
 */
export function grokBuildConfigHome(): string {
  const env = process.env.GROK_HOME;
  if (env && env.trim() !== "") {
    if (env.startsWith("~")) return join(homedir(), env.replace(/^~[/\\]?/, ""));
    return resolve(env);
  }
  return join(homedir(), ".grok");
}
