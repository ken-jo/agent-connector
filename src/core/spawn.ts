/**
 * core/spawn — cross-platform command construction.
 *
 * Borrowed from context-mode (issues #369/#372/#548/#738): bare `node` is
 * unreliable on Windows Git Bash (MSYS) and MSYS rewrites absolute paths on
 * non-C: drives. Always use the resolved runtime path, forward slashes, and
 * double-quoting. No-ops on macOS/Linux.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { InstallScope, PlatformId, ServerDef } from "./types.js";
import type {
  LaunchMethod,
  TelemetryInstallScope,
} from "../telemetry/types.js";

/**
 * Narrow the framework's 5-value {@link InstallScope} down to the two telemetry
 * slicing buckets: only a `project`-local install is `project`; everything else
 * (system/user/profile/managed) is global and reads as `user`.
 */
export function narrowInstallScope(scope: InstallScope): TelemetryInstallScope {
  return scope === "project" ? "project" : "user";
}

/** Build `"<nodePath>" "<scriptPath>"`. */
export function buildNodeCommand(
  scriptPath: string,
  opts?: { nodePath?: string },
): string {
  const nodePath = (opts?.nodePath ?? process.execPath).replace(/\\/g, "/");
  const safe = scriptPath.replace(/\\/g, "/");
  return `"${nodePath}" "${safe}"`;
}

/**
 * Strict inverse of buildNodeCommand. Returns the two quoted tokens, or null if
 * `cmd` was not produced by buildNodeCommand (no fragile last-whitespace tail
 * grabbing — that was the #548 doubled-path bug when paths contained spaces).
 */
export function parseNodeCommand(
  cmd: string,
): { nodePath: string; scriptPath: string } | null {
  if (typeof cmd !== "string" || cmd.length === 0) return null;
  const m = cmd.match(/^"([^"]+)"\s+"([^"]+)"\s*$/);
  if (!m || !m[1] || !m[2]) return null;
  return { nodePath: m[1], scriptPath: m[2] };
}

/** Quote a single argument for inclusion in a host hook command string. */
export function quoteArg(arg: string): string {
  return `"${arg.replace(/\\/g, "/")}"`;
}

/**
 * True when `hay` (slash-normalized) has the quoted home-bin path IMMEDIATELY
 * followed by `verb` — i.e. the verb sits in its command SLOT (right after the
 * home binary), not merely somewhere in the argument list. This distinguishes
 * `"<bin>" statusline …` from `"<bin>" action … statusline …`: the action verb
 * takes a free-form `actionId` positional that can legitimately equal another
 * verb's name (`statusline` / `usage-event` / `hook`), and only the SLOT
 * position identifies the real verb. `homeBinNorm` is the slash-normalized
 * home-bin path the caller already derived.
 */
function hasVerbSlot(hay: string, homeBinNorm: string, verb: string): boolean {
  return hay.includes(`"${homeBinNorm}" ${verb} `);
}

/**
 * Build the universal hook command a host config points at:
 *   "<homeBin>" hook <platformId> <event> --connector <id>
 * Pointing every host at the one stable home binary is how a single update
 * propagates everywhere (docs/ARCHITECTURE.md §3 R1).
 */
export function buildHomeBinHookCommand(
  homeBinPath: string,
  platformId: string,
  event: string,
  connectorId: string,
): string {
  return `${quoteArg(homeBinPath)} hook ${platformId} ${event} --connector ${connectorId}`;
}

/**
 * True when `command` is a home-bin hook command for exactly `connectorId`.
 *
 * Critical: the connector id is the LAST token of the hook command
 * (`... --connector <id>`), so a naive `command.includes("--connector " + id)`
 * collides on shared-prefix ids — `--connector acme-db` contains
 * `--connector acme`, which would let uninstalling `acme` strip `acme-db`'s
 * hooks. We anchor the id token: the character after it must be end-of-string,
 * whitespace, or a closing double-quote (the JSON-embedded case). Connector ids
 * are kebab-case (ID_RE) so they never contain whitespace or quotes themselves.
 */
export function isHomeBinHookCommand(
  command: string | undefined,
  homeBinPath: string,
  connectorId: string,
): boolean {
  if (!command) return false;
  // The stored command was forward-slashed by quoteArg(); homeBinPath() yields
  // NATIVE (back)slashes on Windows (node:path join). Normalize BOTH sides so the
  // ownership substring test holds on win32 (without this, detection always
  // returns false there → duplicate hooks on re-install + orphans on uninstall).
  // No-op on POSIX.
  const hay = command.replace(/\\/g, "/");
  if (!hay.includes(homeBinPath.replace(/\\/g, "/"))) return false;
  const token = `--connector ${connectorId}`;
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(token, from);
    if (idx < 0) return false;
    const after = hay.charAt(idx + token.length);
    if (after === "" || after === '"' || /\s/.test(after)) return true;
    from = idx + token.length;
  }
}

/**
 * Build the OPT-IN host-native usage-event command an AfterModel / PostInvocation
 * hook points at:
 *   "<homeBin>" usage-event <platformId> --connector <id>
 * Mirrors {@link buildHomeBinHookCommand} (same anchoring rules apply) but routes
 * to the hidden `usage-event` entrypoint, which records a DISTINCT `model_turn`
 * row instead of dispatching a connector handler.
 */
export function buildUsageEventCommand(
  homeBinPath: string,
  platformId: string,
  connectorId: string,
): string {
  return `${quoteArg(homeBinPath)} usage-event ${platformId} --connector ${connectorId}`;
}

/**
 * True when `command` is OUR host-native usage-event command for exactly
 * `connectorId`. Same end-of-token anchoring as {@link isHomeBinHookCommand} so a
 * shared-prefix id can't collide; additionally requires the ` usage-event ` verb
 * so it is never confused with a plain `hook` command during uninstall.
 */
export function isUsageEventCommand(
  command: string | undefined,
  homeBinPath: string,
  connectorId: string,
): boolean {
  if (!command) return false;
  // Normalize separators like isHomeBinHookCommand (win32 ownership detection).
  const hay = command.replace(/\\/g, "/");
  const homeBinNorm = homeBinPath.replace(/\\/g, "/");
  if (!hay.includes(homeBinNorm)) return false;
  if (!hasVerbSlot(hay, homeBinNorm, "usage-event")) return false;
  return isHomeBinHookCommand(command, homeBinPath, connectorId);
}

/**
 * Build the home-bin statusline command a host's status line config points at:
 *   "<homeBin>" statusline <platformId> --connector <id>
 * Mirrors {@link buildHomeBinHookCommand} / {@link buildUsageEventCommand} (the
 * same single-home-binary indirection) but routes to the `statusline`
 * entrypoint, which renders the connector's HUD line for the host.
 */
export function buildHomeBinStatuslineCommand(
  homeBinPath: string,
  platformId: string,
  connectorId: string,
): string {
  return `${quoteArg(homeBinPath)} statusline ${platformId} --connector ${connectorId}`;
}

/**
 * True when `command` is OUR home-bin statusline command for exactly
 * `connectorId`. Same end-of-token anchoring as {@link isHomeBinHookCommand} so a
 * shared-prefix id can't collide; additionally requires the ` statusline ` verb
 * so it is never confused with a plain `hook` / `usage-event` command.
 */
export function isHomeBinStatuslineCommand(
  command: string | undefined,
  homeBinPath: string,
  connectorId: string,
): boolean {
  if (!command) return false;
  // Normalize separators like isHomeBinHookCommand (win32 ownership detection).
  const hay = command.replace(/\\/g, "/");
  const homeBinNorm = homeBinPath.replace(/\\/g, "/");
  if (!hay.includes(homeBinNorm)) return false;
  if (!hasVerbSlot(hay, homeBinNorm, "statusline")) return false;
  return isHomeBinHookCommand(command, homeBinPath, connectorId);
}

/**
 * Build the home-bin action command a future host affordance (slash command /
 * keybinding) points at:
 *   "<homeBin>" action <platformId> <actionId> --connector <id>
 * Mirrors {@link buildHomeBinStatuslineCommand} (the same single-home-binary
 * indirection) but routes to the `action` entrypoint, which re-imports the
 * connector and runs the named action's run(ctx). v1 ships only this command
 * builder + the runtime verb; no adapter EMITS the affordance yet.
 */
export function buildHomeBinActionCommand(
  homeBinPath: string,
  platformId: string,
  actionId: string,
  connectorId: string,
): string {
  return `${quoteArg(homeBinPath)} action ${platformId} ${actionId} --connector ${connectorId}`;
}

/**
 * True when `command` is OUR home-bin action command for exactly `connectorId`.
 * Same end-of-token anchoring as {@link isHomeBinHookCommand} so a shared-prefix
 * id can't collide; additionally requires the ` action ` verb so it is never
 * confused with a plain `hook` / `usage-event` / `statusline` command.
 */
export function isHomeBinActionCommand(
  command: string | undefined,
  homeBinPath: string,
  connectorId: string,
): boolean {
  if (!command) return false;
  // Normalize separators like isHomeBinHookCommand (win32 ownership detection).
  const hay = command.replace(/\\/g, "/");
  const homeBinNorm = homeBinPath.replace(/\\/g, "/");
  if (!hay.includes(homeBinNorm)) return false;
  if (!hasVerbSlot(hay, homeBinNorm, "action")) return false;
  return isHomeBinHookCommand(command, homeBinPath, connectorId);
}

/**
 * Single source of truth for "is OPT-IN host-native turn-usage capture enabled
 * for this connector?" — read by the Gemini / Antigravity adapters at install
 * time to decide whether to ALSO write the AfterModel / PostInvocation usage hook.
 * Enabled when the connector opts in via telemetry.hostNativeUsage OR when the
 * install-time env switch AGENT_CONNECTOR_HOST_NATIVE=1 forces it on. Off by
 * default (privacy: host-native capture is never installed silently).
 */
export function isHostNativeUsageEnabled(
  telemetry: { enabled: boolean; hostNativeUsage?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (telemetry.enabled !== true) return false;
  if (env.AGENT_CONNECTOR_HOST_NATIVE === "1") return true;
  return telemetry.hostNativeUsage === true;
}

/**
 * Single source of truth for "should this server be wrapped by `serve` for
 * telemetry?" — so every adapter behaves identically even for a server that
 * skipped normalizeServer (e.g. a per-platform override). On by default for an
 * stdio server with a command, unless explicitly disabled or telemetry is off.
 */
export function shouldWrapForTelemetry(
  server: ServerDef,
  telemetry: { enabled: boolean },
): boolean {
  return (
    server.wrapForTelemetry !== false &&
    telemetry.enabled === true &&
    server.transport === "stdio" &&
    typeof server.command === "string" &&
    server.command !== ""
  );
}

/**
 * Build the telemetry-wrapping server command:
 *   "<homeBin>" serve --connector <id> --scope <scope> --host <platformId> -- <realCommand> <realArgs...>
 * Used when a stdio server opts into transparent telemetry capture.
 *
 * `scope` records the install dimension (global user vs project-local) on every
 * telemetry row so usage can be sliced by it later. It is OPTIONAL for backward
 * compatibility: when omitted, the `--scope` flag is not emitted and the runtime
 * treats the scope as "unknown".
 *
 * `platformId` bakes the install TARGET platform into the wrapper so the proxy
 * stamps `hostPlatform` correctly even under a headless spawn where runtime env
 * markers are absent (detectRuntimeHost only knows claude-code/cursor/codex and
 * otherwise mis-attributes). Emitted as `--host <platformId>` in the FLAG
 * section (before `--`). It is OPTIONAL + backward-compatible: when omitted the
 * `--host` flag is not emitted and the runtime falls back to env detection.
 */
export function buildServeWrapperCommand(
  homeBinPath: string,
  connectorId: string,
  realCommand: string,
  realArgs: string[],
  scope?: InstallScope,
  platformId?: PlatformId,
): { command: string; args: string[] } {
  const flags = ["serve", "--connector", connectorId];
  if (scope !== undefined) flags.push("--scope", narrowInstallScope(scope));
  if (platformId !== undefined) flags.push("--host", platformId);
  return {
    command: homeBinPath,
    args: [...flags, "--", realCommand, ...realArgs],
  };
}

/** Injectable deps for {@link resolveSpawnCommand} (so the win32 branch is unit-testable on POSIX). */
export interface SpawnResolveDeps {
  platform?: NodeJS.Platform;
  /** PATH value (`;`-separated on Windows). */
  pathEnv?: string;
  /** PATHEXT value (`;`-separated). */
  pathExt?: string;
  /** File-existence probe (defaults to fs.existsSync). */
  exists?: (p: string) => boolean;
}

/** How a child command should be handed to spawn() on this platform. */
export interface SpawnResolution {
  /** The command to pass to spawn() (an absolute path on win32 when resolved). */
  file: string;
  /**
   * Whether spawn() MUST use `shell: true`. On native Windows a `.cmd`/`.bat`
   * shim (npx.cmd, pnpm.cmd, the agent-connector.cmd launcher) cannot be run by
   * raw CreateProcess — Node throws EINVAL since the 2024 security fix unless a
   * shell is used. `.exe` resolves directly with no shell.
   */
  needsShell: boolean;
}

/**
 * Resolve a child command for spawn() across platforms. NO-OP on macOS/Linux
 * (returns the command unchanged, no shell). On native Windows it fixes the two
 * spawn failure modes for bare package runners:
 *   1. raw CreateProcess ignores PATHEXT, so spawn("npx") → ENOENT even though
 *      `npx.cmd` is on PATH. We search PATH × PATHEXT and return the resolved
 *      absolute path.
 *   2. a resolved `.cmd`/`.bat` still cannot be launched without a shell, so we
 *      flag `needsShell` for those (and `.exe`/`.com` run directly).
 * A bare name that PATH search misses falls back to `{ file: command,
 * needsShell: true }` so cmd.exe's own PATHEXT lookup still finds it.
 */
export function resolveSpawnCommand(
  command: string,
  deps: SpawnResolveDeps = {},
): SpawnResolution {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return { file: command, needsShell: false };

  const isBatch = (s: string): boolean => /\.(cmd|bat)$/i.test(s);

  // Already a path or already has an extension → don't search; only decide shell.
  if (/[\\/]/.test(command) || /\.[a-z0-9]+$/i.test(command)) {
    return { file: command, needsShell: isBatch(command) };
  }

  const exists = deps.exists ?? existsSync;
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? process.env.Path ?? "";
  const pathExt = deps.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const dirs = pathEnv.split(";").filter((d) => d !== "");
  const exts = pathExt.split(";").filter((e) => e !== "");
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (exists(candidate)) return { file: candidate, needsShell: isBatch(ext) };
    }
  }
  // Not found on PATH — let cmd.exe resolve it (handles shim dirs we may miss).
  return { file: command, needsShell: true };
}

/** Basenames (case-insensitive, sans common extensions) of the ephemeral package runners. */
const PACKAGE_RUNNERS: Record<string, Extract<LaunchMethod, "npx" | "bunx" | "uvx">> = {
  npx: "npx",
  bunx: "bunx",
  uvx: "uvx",
};

/** Basenames of language interpreters that launch a local script. */
const INTERPRETERS: ReadonlySet<string> = new Set(["node", "bun", "deno"]);

/**
 * Strip a directory prefix and a trailing executable extension to get the bare
 * program name. Tolerates both POSIX and Windows separators (the wrapped command
 * may be an absolute Windows path) and lowercases for case-insensitive matching.
 */
function commandBasename(realCommand: string): string {
  const noDir = realCommand.replace(/\\/g, "/").split("/").pop() ?? realCommand;
  return noDir.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();
}

/**
 * Classify how the real MCP server is launched, for the "launch-method" slicing
 * dimension. Package runners (npx/bunx/uvx) and interpreters (node/bun/deno) are
 * detected by the command basename. A remote (http) server is not launched
 * locally, so the caller — which alone knows the transport — passes
 * `isRemote: true` to force "http". Anything else resolves to "binary".
 */
export function detectLaunchMethod(
  realCommand: string,
  realArgs: string[],
  opts?: { isRemote?: boolean },
): LaunchMethod {
  void realArgs; // reserved: args may later refine node-vs-script heuristics
  if (opts?.isRemote === true) return "http";
  if (typeof realCommand !== "string" || realCommand.trim() === "") {
    return "unknown";
  }
  const base = commandBasename(realCommand);
  if (base === "") return "unknown";
  const runner = PACKAGE_RUNNERS[base];
  if (runner !== undefined) return runner;
  if (INTERPRETERS.has(base)) return "node";
  return "binary";
}
