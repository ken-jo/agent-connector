/**
 * core/marketplace-drivers/shared — the helpers every marketplace driver is
 * built on: PATH binary detection and a hard-timeout, non-TTY host-CLI runner.
 *
 * Drivers spawn YOUNG host-CLI surfaces (plugin verbs change between releases),
 * so the runner is deliberately defensive: no shell, stdin ignored (a host CLI
 * waiting on TTY input must fail fast, not hang the install), stdout/stderr
 * captured for tolerant parsing, and a hard per-spawn timeout that kills the
 * child and reports `timedOut` instead of throwing. It NEVER rejects — drivers
 * key decisions off presence probes first and treat command failure as a warn.
 */

import { existsSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import { spawnChild } from "../spawn-child.js";

/** Default hard timeout for one host-CLI spawn. */
export const HOST_COMMAND_TIMEOUT_MS = 30_000;

/** Outcome of one host-CLI invocation (never thrown). */
export interface HostCommandResult {
  /** True iff the process exited 0 within the timeout. */
  ok: boolean;
  /** Exit code (null when killed / failed to spawn). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the hard timeout killed the child. */
  timedOut: boolean;
  /** Spawn-level error message, when the process could not start. */
  error?: string;
}

/**
 * Locate `command` on PATH, returning the absolute executable path or null.
 * On win32 the PATHEXT extensions are tried (claude installs as claude.cmd);
 * elsewhere a plain existing file is accepted (we spawn it directly, so the
 * exec bit check is left to spawn itself).
 */
export function findOnPath(command: string): string | null {
  const pathVar = process.env.PATH ?? "";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").concat("")
      : [""];
  for (const dir of pathVar.split(delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext.toLowerCase());
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        /* unreadable PATH entry — keep walking */
      }
    }
  }
  return null;
}

/**
 * Run one host CLI command headlessly: direct spawn (no shell on POSIX;
 * spawnChild handles the Windows .cmd launcher), stdin ignored, output
 * captured, hard timeout kill. Resolves ALWAYS — failure shapes are data.
 */
export function runHostCommand(
  command: string,
  args: string[],
  timeoutMs: number = HOST_COMMAND_TIMEOUT_MS,
): Promise<HostCommandResult> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const settle = (result: HostCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    let child;
    try {
      child = spawnChild(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolvePromise({
        ok: false,
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        error: message,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      settle({
        ok: false,
        code: null,
        stdout,
        stderr,
        timedOut,
        error: err.message,
      });
    });
    child.on("close", (code) => {
      settle({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

/** First line of a host CLI's output, for compact warn details. */
export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "");
  return line ? line.trim() : "";
}

/**
 * Path equivalence for comparing a path WE built (e.g. a staging root) against a
 * path a HOST CLI recorded in its own state. A plain `===` is wrong on Windows:
 * codex canonicalizes the marketplace `source` to the extended-length form
 * `\\?\C:\…` (live-confirmed on codex-cli 0.139.0), which never string-equals our
 * `path.join` result. Normalize both: strip the `\\?\` / `\\?\UNC\` prefix,
 * `resolve()`, and case-fold on win32 (NTFS is case-insensitive). On POSIX this
 * is just `resolve(a) === resolve(b)`, so existing exact-match behavior is
 * preserved (an exact match always stays a match — samePath only widens).
 */
export function samePath(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  const norm = (p: string): string => {
    let s = p;
    if (process.platform === "win32") {
      s = s.replace(/^\\\\\?\\UNC\\/, "\\\\").replace(/^\\\\\?\\/, "");
    }
    s = resolve(s);
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}
