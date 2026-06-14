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

/** Per-spawn options for {@link runHostCommand}. */
export interface RunHostCommandOptions {
  /** Hard timeout (ms) before the child is SIGKILLed. */
  timeoutMs?: number;
  /**
   * Working directory for the spawned child. Omit to INHERIT the parent's cwd
   * (the historical behavior — claude/codex/agy pass none and are unaffected).
   * The npm-local driver passes a NEUTRAL dir so the host CLI does not pollute
   * a project-local `./.opencode/opencode.json`.
   */
  cwd?: string;
}

/**
 * Run one host CLI command headlessly: direct spawn (no shell on POSIX;
 * spawnChild handles the Windows .cmd launcher), stdin ignored, output
 * captured, hard timeout kill. Resolves ALWAYS — failure shapes are data.
 *
 * The third argument is BACKWARD-COMPATIBLE: a bare number is the legacy
 * `timeoutMs` positional (kept so existing callers need no change), an options
 * object carries `{ timeoutMs?, cwd? }`. No `cwd` → the child inherits the
 * parent's cwd exactly as before.
 */
export function runHostCommand(
  command: string,
  args: string[],
  optionsOrTimeout: number | RunHostCommandOptions = HOST_COMMAND_TIMEOUT_MS,
): Promise<HostCommandResult> {
  const opts: RunHostCommandOptions =
    typeof optionsOrTimeout === "number"
      ? { timeoutMs: optionsOrTimeout }
      : optionsOrTimeout;
  const timeoutMs = opts.timeoutMs ?? HOST_COMMAND_TIMEOUT_MS;
  const cwd = opts.cwd;
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
        // Only set cwd when a caller asked for it — omitting the key inherits
        // the parent's cwd, keeping claude/codex/agy spawns byte-identical.
        ...(cwd != null ? { cwd } : {}),
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
