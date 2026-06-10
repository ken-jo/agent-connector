/**
 * cli/app — shared CLI helpers + command dispatch (NO side effects).
 *
 * Command modules import the shared helpers (print, fail, parse-flags,
 * renderInstallResult) from here, and main() dispatches the first positional to a
 * command module.
 * This module never auto-runs — `cli/index.ts` is the thin bin entry that calls
 * `main()`. Keeping the auto-run out of here is what prevents a dispatch recursion
 * (a command module importing a helper must not re-trigger the program) and makes
 * it robust to bundler entry-splitting (the old import.meta.url entry-guard broke
 * once tsup hoisted this code into a shared chunk).
 */

import { createRequire } from "node:module";

import type {
  ChangeRecord,
  InstallResult,
  InstallScope,
  PlatformId,
} from "../core/types.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared helpers (imported by the command modules)
// ─────────────────────────────────────────────────────────────────────────

/** Print a line to stdout (machine-readable payloads must stay on stdout). */
export function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * The brand active for THIS invocation. main() sets it from
 * {@link MainOptions.programName} before dispatch, so error messages printed by
 * command modules via {@link fail} read as the embedding tool (e.g. `acme-db:`)
 * instead of always `agentconnect:`.
 */
let activeProgramName = "agentconnect";

/** Print an error to stderr (branded) and return a non-zero exit code (default 2). */
export function fail(message: string, code = 2): number {
  process.stderr.write(`${activeProgramName}: ${message}\n`);
  return code;
}

/**
 * Resolve agentconnect's own package version at runtime. Works from both the
 * bundled dist layout (dist/*.js → ../package.json) and the src layout under
 * tsx/vitest (src/cli/ → ../../package.json); the name check guards against
 * accidentally reading some other package.json on the walk.
 */
export function resolveOwnVersion(): string {
  const req = createRequire(import.meta.url);
  for (const rel of ["../package.json", "../../package.json", "../../../package.json"]) {
    try {
      const pkg = req(rel) as { name?: string; version?: string };
      if (pkg.name === "agentconnect" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      /* keep walking */
    }
  }
  return "0.0.0";
}

/** Parse a --scope value the CLI accepts (user|project) into an InstallScope. */
export function parseScope(value: string | undefined): InstallScope | null {
  if (value === "user" || value === "project") return value;
  return null;
}

/**
 * Parse a comma-separated --targets value into PlatformId[]. Returns undefined
 * when the flag is absent/empty so callers can fall back to connector/detection.
 */
export function parseTargets(value: string | undefined): PlatformId[] | undefined {
  if (value == null || value.trim() === "") return undefined;
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "") as PlatformId[];
  return ids.length > 0 ? ids : undefined;
}

const ACTION_GLYPH: Record<ChangeRecord["action"], string> = {
  create: "+",
  update: "~",
  remove: "-",
  skip: "=",
  warn: "!",
};

/**
 * Render an InstallResult as a readable diff: one line per ChangeRecord (glyph,
 * platform, detail, path) followed by any warnings and a summary tally. Used by
 * install / upgrade / uninstall.
 */
export function renderInstallResult(
  result: InstallResult,
  verb: "install" | "upgrade" | "uninstall",
): string {
  const lines: string[] = [];
  const mode = result.dryRun ? " (dry-run — nothing written)" : "";
  lines.push(`${verb} "${result.connectorId}"${mode}`);

  if (result.changes.length === 0) {
    lines.push("  (no changes)");
  } else {
    for (const c of result.changes) {
      const glyph = ACTION_GLYPH[c.action];
      const where = c.path ? `  ${c.path}` : "";
      lines.push(`  ${glyph} [${c.platform}] ${c.action}: ${c.detail}${where}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("warnings:");
    for (const w of result.warnings) lines.push(`  ! ${w}`);
  }

  const tally = result.changes.reduce<Record<ChangeRecord["action"], number>>(
    (acc, c) => {
      acc[c.action] += 1;
      return acc;
    },
    { create: 0, update: 0, remove: 0, skip: 0, warn: 0 },
  );
  lines.push("");
  lines.push(
    `summary: ${tally.create} created, ${tally.update} updated, ` +
      `${tally.remove} removed, ${tally.skip} skipped, ${tally.warn} warning(s)`,
  );

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Command dispatch
// ─────────────────────────────────────────────────────────────────────────

/** A command module: takes the post-command argv slice, returns an exit code. */
type CommandModule = { run: (argv: string[]) => Promise<number> | number };

/** Lazy command loaders — keyed by the first positional. Imported on demand. */
const COMMANDS: Record<string, () => Promise<CommandModule>> = {
  detect: () => import("./commands/detect.js"),
  install: () => import("./commands/install.js"),
  uninstall: () => import("./commands/uninstall.js"),
  // `upgrade` is the single "bring everything current" verb (re-render host
  // config + refresh the home pointer + managed channel guidance). `sync` and
  // `update` are kept as back-compat aliases that route to the same module so
  // existing scripts/docs keep working without a second concept to learn.
  upgrade: () => import("./commands/upgrade.js"),
  sync: () => import("./commands/upgrade.js"),
  update: () => import("./commands/upgrade.js"),
  package: () => import("./commands/package.js"),
  doctor: () => import("./commands/doctor.js"),
  status: () => import("./commands/status.js"),
  telemetry: () => import("./commands/telemetry.js"),
  usage: () => import("./commands/usage.js"),
  leaderboard: () => import("./commands/leaderboard.js"),
  hook: () => import("./commands/hook.js"),
  serve: () => import("./commands/serve.js"),
  // Hidden (omitted from USAGE): the opt-in host-native turn-usage entrypoint an
  // AfterModel / PostInvocation hook points at. Always exits 0; records a
  // distinct `model_turn` row. See cli/commands/usage-event.ts.
  "usage-event": () => import("./commands/usage-event.js"),
};

/** Default program name; an embedding SDK CLI overrides it via {@link MainOptions}. */
export const DEFAULT_PROGRAM_NAME = "agentconnect";

/**
 * One-line usage signature per command — the single central copy behind
 * `<command> --help` and the friendly bad-flag error. Command modules use
 * node:util parseArgs (strict), which THROWS on an unknown flag; without the
 * dispatcher-level handling in {@link main}, `agentconnect install --help`
 * would die with a raw ERR_PARSE_ARGS stack trace — the very invocation the
 * root help tells users to run.
 */
const COMMAND_USAGE: Record<string, string> = {
  detect: "detect [--json] [--project <dir>]",
  install:
    "install [--connector <path>] [--scope user|project] [--targets a,b] [--project <dir>] [--dry-run]",
  uninstall:
    "uninstall [--connector <path>] [--connector-id <id>] [--scope user|project] [--targets a,b] [--project <dir>] [--dry-run] [--purge]",
  upgrade:
    "upgrade [--channel stable|latest] [--connector <path>] [--scope user|project] [--targets a,b] [--project <dir>] [--dry-run]",
  sync: "sync — alias of upgrade (see `upgrade --help`)",
  update: "update — alias of upgrade (see `upgrade --help`)",
  package:
    "package [--connector <path>] [--format <fmt>|all] [--out <dir>] [--project <dir>] [--dry-run]",
  doctor:
    "doctor [--targets a,b] [--connector <path>] [--scope user|project] [--project <dir>] [--probe] [--json]",
  status: "status [--connector <path>] [--scope user|project] [--project <dir>] [--json]",
  telemetry:
    "telemetry report|export|leaderboard [--by <dim>] [--since <dur>] [--connector <id>] [--scope <slice>] [--format csv|json] [--out <file>] [--json]",
  usage:
    "usage report|export|leaderboard [--by <dim>] [--since <dur>] [--platform <id>] [--format csv|json] [--out <file>] [--json]",
  leaderboard: "leaderboard [--since <dur>] [--connector <id>] [--scope <slice>] [--json]",
  hook: "hook <platform> <event> --connector <id>   (internal — host hook configs point here)",
  serve:
    "serve --connector <id> [--scope user|project] [--host <platformId>] -- <command> [args...]   (internal — host MCP entries point here)",
};

/**
 * Build the top-level usage string for a given program name. The brand replaces
 * "agentconnect" in the title, the `usage:` line, and the per-command help
 * footer so an embedded CLI (e.g. `acme-db`) reads as its own tool.
 */
function buildUsage(programName: string): string {
  return `${programName} — write your MCP server + hooks once, install everywhere.

usage: ${programName} <command> [flags]

commands:
  detect       List the AI-agent platforms installed on this machine.
  install      Deploy a connector across its target platforms.
  uninstall    Remove a connector's MCP + hook registrations.
  upgrade      Bring everything current: re-render host config + heal the home pointer + managed update guidance (alias: update, sync).
  package      Emit a marketplace/extension bundle (9 host formats, or the standard artifacts mcp-server-json | mcpb).
  doctor       Health-check every detected platform; non-zero exit on any failure.
  status       Light install-state summary: which connectors are present on which hosts (always exits 0).
  telemetry    Inspect local per-tool token telemetry (report | export | leaderboard).
  usage        Inspect host-native token usage from agent CLI logs (report | export | leaderboard).
  leaderboard  Three leaderboards: 🔌 MCP/plugin (mcp-self) + 🖥️ host/user (host-scan-logs) + 🛰️ host-native turns (host-native-live) — never summed.
  hook         Universal json-stdio hook entrypoint (hosts call this).
  serve        Telemetry-wrapping MCP stdio proxy (wraps a real server command).

Run \`${programName} <command> --help\` for command-specific flags.`;
}

/** Options accepted by {@link main}. */
export interface MainOptions {
  /**
   * The brand shown in usage/help text. Defaults to {@link DEFAULT_PROGRAM_NAME}.
   * An embedding SDK CLI (see cli/sdk.ts) passes its own bin name so every
   * subcommand's help reads as the developer's tool.
   */
  programName?: string;
}

export async function main(argv: string[], opts: MainOptions = {}): Promise<number> {
  const programName = opts.programName ?? DEFAULT_PROGRAM_NAME;
  activeProgramName = programName; // brand every fail() in this invocation
  const usage = buildUsage(programName);
  const command = argv[0];

  if (command == null || command === "--help" || command === "-h" || command === "help") {
    print(usage);
    return command == null ? 1 : 0;
  }
  if (command === "--version" || command === "-v") {
    print(`${programName} ${resolveOwnVersion()}`);
    return 0;
  }

  const loader = COMMANDS[command];
  if (!loader) {
    process.stderr.write(`${programName}: unknown command "${command}"\n\n`);
    process.stderr.write(`${usage}\n`);
    return 2;
  }

  // Per-command help: no command module defines a --help flag (strict parseArgs
  // would throw on it), so answer it centrally from COMMAND_USAGE.
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    const sig = COMMAND_USAGE[command];
    if (sig) {
      print(`usage: ${programName} ${sig}`);
      return 0;
    }
  }

  const mod = await loader();
  try {
    return await mod.run(rest);
  } catch (err) {
    // Friendly bad-flag errors: strict parseArgs throws ERR_PARSE_ARGS_* for an
    // unknown/malformed option — print the message + the usage line instead of
    // letting a raw stack trace reach the user. Everything else still rethrows
    // (the bin entry reports those as fatal).
    const code = (err as { code?: string }).code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      const message = err instanceof Error ? err.message : String(err);
      const sig = COMMAND_USAGE[command];
      if (sig) process.stderr.write(`usage: ${programName} ${sig}\n`);
      return fail(message);
    }
    throw err;
  }
}
