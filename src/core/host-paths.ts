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
// Host-specific env overrides (CODEX_HOME, PI_CODING_AGENT_DIR, …) are
// intentionally NOT modelled here; they belong to their own resolvers.
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
