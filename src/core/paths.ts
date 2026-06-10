/**
 * core/paths — home data-root, stable home binary, and project identity.
 *
 * Operating model (docs/ARCHITECTURE.md §3):
 *   • One home data-root holds the single binary + shared telemetry + state.
 *     Override with AGENT_CONNECTOR_DATA_DIR (the cross-agent shared-DB key).
 *     This relocates FRAMEWORK state only — never platform-native config files.
 *   • The home binary lives at a STABLE path so every host's pointer config
 *     keeps working across updates (no versioned cache dir → no cache-heal bug).
 *   • Per-project data is keyed by a stable project identity (git remote ||
 *     normalized absolute path), hashed — not by code location.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Framework data-root: AGENT_CONNECTOR_DATA_DIR || ~/.agent-connector. */
export function dataRoot(): string {
  const override = process.env.AGENT_CONNECTOR_DATA_DIR;
  if (override && override.trim() !== "") return resolve(override);
  return join(homedir(), ".agent-connector");
}

export function connectorsDir(): string {
  return join(dataRoot(), "connectors");
}
export function connectorDir(id: string): string {
  return join(connectorsDir(), id);
}
export function backupsDir(): string {
  return join(dataRoot(), "backups");
}
export function logsDir(): string {
  return join(dataRoot(), "logs");
}

/** Telemetry store path for the selected backend. */
export function telemetryPath(store: "ndjson" | "sqlite" = "ndjson"): string {
  return join(dataRoot(), store === "sqlite" ? "telemetry.db" : "telemetry.ndjson");
}

/** Stable, OS-correct path to the single home binary pointer. */
export function homeBinPath(): string {
  const name = process.platform === "win32" ? "agent-connector.cmd" : "agent-connector";
  return join(dataRoot(), "bin", name);
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Write a stable launcher at homeBinPath() that execs the real CLI entry.
 * Avoids symlinks (Windows constraint) and versioned paths. Idempotent.
 *
 * @param cliEntry absolute path to the installed cli.js
 * @param nodePath node runtime to exec with (defaults to current process.execPath)
 * @returns the stable launcher path
 */
export function ensureHomeBin(cliEntry: string, nodePath: string = process.execPath): string {
  const binPath = homeBinPath();
  ensureDir(join(dataRoot(), "bin"));
  const node = nodePath.replace(/\\/g, "/");
  const cli = cliEntry.replace(/\\/g, "/");
  if (process.platform === "win32") {
    writeFileSync(binPath, `@echo off\r\n"${node}" "${cli}" %*\r\n`, "utf8");
  } else {
    writeFileSync(binPath, `#!/bin/sh\nexec "${node}" "${cli}" "$@"\n`, "utf8");
    chmodSync(binPath, 0o755);
  }
  return binPath;
}

/** Read remote.origin.url from a project's .git/config without spawning git. */
function gitRemoteUrl(projectDir: string): string | null {
  const cfg = join(projectDir, ".git", "config");
  if (!existsSync(cfg)) return null;
  try {
    const text = readFileSync(cfg, "utf8");
    // Find [remote "origin"] ... url = X
    const lines = text.split(/\r?\n/);
    let inOrigin = false;
    for (const line of lines) {
      const s = line.trim();
      if (s.startsWith("[")) inOrigin = /^\[remote\s+"origin"\]$/.test(s);
      else if (inOrigin) {
        const m = s.match(/^url\s*=\s*(.+)$/);
        if (m && m[1]) return m[1].trim();
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export interface ProjectIdentity {
  /** Hashed stable key used to partition telemetry/state. */
  key: string;
  /** Human-readable label (git remote or directory name). */
  label: string;
  /** Absolute project directory. */
  dir: string;
}

/**
 * Derive a stable project identity. Prefers the git origin URL (stable across
 * clones/locations); falls back to the normalized absolute path.
 */
export function projectIdentity(projectDir: string): ProjectIdentity {
  const dir = resolve(projectDir);
  const remote = gitRemoteUrl(dir);
  const basis = remote ?? dir;
  const key = createHash("sha256").update(basis).digest("hex").slice(0, 16);
  return { key, label: remote ?? basename(dir), dir };
}
