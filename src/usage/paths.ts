/**
 * usage/paths — per-platform HOST storage-root resolution + small fs walkers.
 *
 * This is the read-only complement to core/paths.ts: where that module resolves
 * the FRAMEWORK data-root (~/.agent-connector), this one resolves each agent
 * CLI's OWN native storage roots (~/.qwen, ~/.claude, …) so the usage readers
 * can parse them. It NEVER writes; it only enumerates files.
 *
 * Ported from tokscale paths.rs (the tokscale cache dir) and from each reader's
 * storage-path spec (docs/research/usage-readers.json). Resolution order is
 * uniform across platforms:
 *   1. an explicit AGENT_CONNECTOR_<PLATFORM>_DIR env override (verbatim, when
 *      non-empty — an empty string is treated as unset so we never resolve to "");
 *   2. the platform-specific default for the current OS.
 *
 * The "tokscale cache dir" (~/.config/tokscale, or AGENT_CONNECTOR_TOKSCALE_DIR)
 * is where synced readers (cursor/antigravity/trae/warp) look for a local cache
 * that a separate tokscale run may have produced — we read it if present, but we
 * never create or sync it.
 */

import {
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────
// Home / env helpers
// ─────────────────────────────────────────────────────────────────────────

/** Expand a leading "~" (and "~/") to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Read an env override, treating empty/blank as unset (mirrors tokscale's
 * is_config_dir_overridden contract: an empty override must NOT resolve to "").
 * Relative paths are resolved against the process CWD; "~" is expanded.
 */
function envOverride(name: string): string | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return undefined;
  const expanded = expandHome(raw.trim());
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** $XDG_DATA_HOME (when set & non-empty) else ~/.local/share. */
function xdgDataHome(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.trim() !== "") return resolve(expandHome(xdg.trim()));
  return join(homedir(), ".local", "share");
}

/** $XDG_CONFIG_HOME (when set & non-empty) else ~/.config. */
function xdgConfigHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== "") return resolve(expandHome(xdg.trim()));
  return join(homedir(), ".config");
}

/** Windows %LOCALAPPDATA% else ~/AppData/Local. */
function localAppData(): string {
  const v = process.env.LOCALAPPDATA;
  if (v && v.trim() !== "") return resolve(v.trim());
  return join(homedir(), "AppData", "Local");
}

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

// ─────────────────────────────────────────────────────────────────────────
// tokscale cache dir (for synced readers)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve the tokscale config dir (where synced caches live). Ported from
 * tokscale paths.rs get_config_dir():
 *   1. AGENT_CONNECTOR_TOKSCALE_DIR override (verbatim, non-empty);
 *   2. macOS: $HOME/.config/tokscale (NOT ~/Library/Application Support);
 *   3. Linux: $XDG_CONFIG_HOME/tokscale or ~/.config/tokscale;
 *   4. Windows: %APPDATA%/tokscale (config_dir equivalent) else ~/.config/tokscale.
 *
 * We use AGENT_CONNECTOR_TOKSCALE_DIR (not TOKSCALE_CONFIG_DIR) so the framework
 * never accidentally couples to a tokscale install's hermetic test env.
 */
export function tokscaleConfigDir(): string {
  const override = envOverride("AGENT_CONNECTOR_TOKSCALE_DIR");
  if (override) return override;
  if (isMac) return join(homedir(), ".config", "tokscale");
  if (isWin) {
    const appData = process.env.APPDATA;
    if (appData && appData.trim() !== "") return join(resolve(appData.trim()), "tokscale");
    return join(homedir(), ".config", "tokscale");
  }
  return join(xdgConfigHome(), "tokscale");
}

/** The directory a synced platform's local cache lives under, e.g. `<tokscale>/cursor-cache`. */
export function tokscaleCacheDir(name: string): string {
  return join(tokscaleConfigDir(), name);
}

// ─────────────────────────────────────────────────────────────────────────
// Per-platform host roots
// ─────────────────────────────────────────────────────────────────────────

/**
 * Candidate host storage roots for a platform, most-preferred first. Readers
 * iterate the returned list and use the first that exists (each variant is the
 * OS-correct default; the env override, when present, is prepended).
 *
 * Only the platforms this subsystem currently ships a reader for are listed in
 * detail; the table is structured so a new platform is one new case. Returning
 * `[]` (no candidate root) makes a reader fail-open to zero records.
 */
export function hostRoots(platformId: string): string[] {
  const out: string[] = [];
  const override = envOverride(`AGENT_CONNECTOR_${platformId.toUpperCase().replace(/-/g, "_")}_DIR`);
  if (override) out.push(override);

  switch (platformId) {
    case "qwen-code":
      // ~/.qwen/projects/*/chats/*.jsonl
      out.push(join(homedir(), ".qwen", "projects"));
      break;
    case "claude-code":
      out.push(join(homedir(), ".claude", "projects"));
      break;
    case "codex":
      out.push(join(homedir(), ".codex", "sessions"));
      break;
    case "gemini-cli":
      out.push(join(homedir(), ".gemini", "tmp"));
      break;
    case "pi":
      out.push(join(homedir(), ".pi", "agent", "sessions"));
      break;
    case "kimi":
      out.push(join(homedir(), ".kimi", "sessions"));
      break;
    case "copilot-cli":
      out.push(join(xdgDataHome(), "Copilot", "telemetry"));
      out.push(join(xdgConfigHome(), "copilot", "telemetry"));
      break;
    case "amp":
      out.push(join(xdgDataHome(), "amp", "threads"));
      break;
    case "droid":
      out.push(join(homedir(), ".factory", "sessions"));
      break;
    case "mux":
      out.push(join(homedir(), ".mux", "sessions"));
      break;
    case "kiro":
      out.push(join(homedir(), ".kiro", "sessions", "cli"));
      break;
    case "opencode":
      out.push(join(xdgDataHome(), "opencode", "opencode.db"));
      break;
    case "goose":
      if (isMac) out.push(join(homedir(), "Library", "Application Support", "goose", "sessions", "sessions.db"));
      out.push(join(xdgDataHome(), "goose", "sessions", "sessions.db"));
      out.push(join(xdgDataHome(), "Block", "goose", "sessions", "sessions.db"));
      break;
    case "hermes":
      out.push(join(homedir(), ".hermes", "state.db"));
      break;
    case "kilo-cli":
      out.push(join(xdgDataHome(), "kilo", "kilo.db"));
      break;
    case "crush":
      out.push(join(homedir(), ".cache", "crush", "crush.db"));
      break;
    case "zed":
      if (isMac) out.push(join(homedir(), "Library", "Application Support", "Zed", "threads", "threads.db"));
      else if (isWin) out.push(join(localAppData(), "Zed", "threads", "threads.db"));
      else out.push(join(xdgDataHome(), "zed", "threads", "threads.db"));
      break;
    // Synced platforms: local cache under the tokscale config dir.
    case "cursor":
      out.push(tokscaleCacheDir("cursor-cache"));
      break;
    case "antigravity":
      out.push(tokscaleCacheDir("antigravity-cache"));
      break;
    case "trae":
      out.push(tokscaleCacheDir("trae-cache"));
      break;
    case "warp":
      out.push(tokscaleCacheDir("warp-cache"));
      break;
    default:
      break;
  }
  return out;
}

/** First existing host root for a platform, or undefined when none is present. */
export function firstExistingRoot(platformId: string): string | undefined {
  for (const root of hostRoots(platformId)) {
    if (existsSync(root)) return root;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Directory / glob walkers (tolerant — never throw)
// ─────────────────────────────────────────────────────────────────────────

/** Is the path an existing directory? Tolerant (false on any stat error). */
export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Is the path an existing regular file? Tolerant (false on any stat error). */
export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Recursively list every file under `root` whose name matches `predicate`.
 * Tolerant: an unreadable directory is skipped, never thrown. Returns absolute
 * paths in directory-walk order. A non-existent root yields [].
 */
export function walkFiles(
  root: string,
  predicate: (name: string, absPath: string) => boolean,
  maxDepth = 12,
): string[] {
  const out: string[] = [];
  if (!isDir(root)) return out;

  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir → skip
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: abs, depth: depth + 1 });
      } else if (entry.isFile() && predicate(entry.name, abs)) {
        out.push(abs);
      }
    }
  }
  return out;
}

/**
 * List immediate subdirectory names of `dir` (not recursive). Tolerant: returns
 * [] for a missing/unreadable directory.
 */
export function listSubdirs(dir: string): string[] {
  if (!isDir(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}
