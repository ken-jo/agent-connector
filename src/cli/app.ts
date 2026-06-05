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

/** Print an error to stderr and return a non-zero exit code (default 2). */
export function fail(message: string, code = 2): number {
  process.stderr.write(`agent-connector: ${message}\n`);
  return code;
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
 * install / sync / uninstall.
 */
export function renderInstallResult(
  result: InstallResult,
  verb: "install" | "sync" | "uninstall",
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
  sync: () => import("./commands/sync.js"),
  uninstall: () => import("./commands/uninstall.js"),
  package: () => import("./commands/package.js"),
  doctor: () => import("./commands/doctor.js"),
  update: () => import("./commands/update.js"),
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
export const DEFAULT_PROGRAM_NAME = "agent-connector";

/**
 * Build the top-level usage string for a given program name. The brand replaces
 * "agent-connector" in the title, the `usage:` line, and the per-command help
 * footer so an embedded CLI (e.g. `acme-db`) reads as its own tool.
 */
function buildUsage(programName: string): string {
  return `${programName} — write your MCP server + hooks once, install everywhere.

usage: ${programName} <command> [flags]

commands:
  detect       List the AI-agent platforms installed on this machine.
  install      Deploy a connector across its target platforms.
  sync         Idempotent re-install (re-renders config, heals the home pointer).
  uninstall    Remove a connector's MCP + hook registrations.
  package      Emit a marketplace-installable Claude Code plugin bundle + marketplace.json.
  doctor       Health-check every detected platform; non-zero exit on any failure.
  update       Managed-update guidance + refresh of the stable home pointer.
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
  const usage = buildUsage(programName);
  const command = argv[0];

  if (command == null || command === "--help" || command === "-h" || command === "help") {
    print(usage);
    return command == null ? 1 : 0;
  }
  if (command === "--version" || command === "-v") {
    print(programName);
    return 0;
  }

  const loader = COMMANDS[command];
  if (!loader) {
    process.stderr.write(`${programName}: unknown command "${command}"\n\n`);
    process.stderr.write(`${usage}\n`);
    return 2;
  }

  const mod = await loader();
  return mod.run(argv.slice(1));
}
