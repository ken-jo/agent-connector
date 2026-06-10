/**
 * core/spawn-child — the cross-platform child_process.spawn wrapper.
 *
 * Kept SEPARATE from core/spawn.ts (pure string/path helpers, imported widely
 * and early) so that pulling in `node:child_process` here does not perturb the
 * module-eval order of test suites that vi.mock("node:child_process").
 */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";

import { resolveSpawnCommand } from "./spawn.js";

/**
 * Quote one token for a cmd.exe command line: wrap in double quotes, doubling any
 * embedded double quote. Sufficient for the paths / package names / flags we
 * spawn (connector config, not untrusted end-user input) — we intentionally do
 * not escape cmd metacharacters (& | ^ %), which never appear in those tokens.
 */
function winQuoteArg(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Cross-platform child spawn that fixes native-Windows package-runner launches.
 * Direct spawn on macOS/Linux. On win32 it routes through
 * {@link resolveSpawnCommand}; an `.exe` runs directly, while a `.cmd`/`.bat`
 * (npx.cmd, the agentconnect.cmd launcher) is launched via a SINGLE quoted
 * command line with `shell: true` — a string rather than an args array, which
 * Node requires for a batch file AND which avoids the DEP0190 deprecation that
 * `shell: true` + an args array triggers on Node ≥ 24.
 */
export function spawnChild(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  const resolved = resolveSpawnCommand(command);
  if (!resolved.needsShell) return spawn(resolved.file, args, options);
  const line = [resolved.file, ...args].map(winQuoteArg).join(" ");
  return spawn(line, { ...options, shell: true });
}
