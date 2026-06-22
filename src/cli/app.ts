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
import { homedir } from "node:os";

import { PALETTES, renderBrandBanner, resolveColorMode, shouldShowBanner } from "./banner.js";
import type {
  ChangeRecord,
  ConnectorSummary,
  InstallResult,
  InstallScope,
  PlatformId,
  ResolvedConnector,
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
 * instead of always `agent-connector:`.
 */
let activeProgramName = "agent-connector";

/** Print an error to stderr (branded) and return a non-zero exit code (default 2). */
export function fail(message: string, code = 2): number {
  process.stderr.write(`${activeProgramName}: ${message}\n`);
  return code;
}

/**
 * The brand active for THIS invocation (what the banner renders in ASCII art).
 * main() sets it from {@link MainOptions.programName} before dispatch; reading it
 * here keeps the banner branded for an embedding SDK CLI without each command
 * module needing the program name threaded through.
 */
export function getActiveProgramName(): string {
  return activeProgramName;
}

/**
 * Print the branded ASCII banner once, atop install / uninstall / upgrade /
 * doctor — but ONLY for an interactive TTY (suppressed when piped/redirected,
 * under --json, or under --quiet) so scripts and pipelines see byte-identical
 * command output. The pure render lives in cli/banner; this thin wrapper reads
 * the real stdout/env and feeds it in.
 */
export function maybePrintBanner(flags: { json?: boolean; quiet?: boolean }): void {
  const isTTY = process.stdout.isTTY === true;
  const noColor = process.env.NO_COLOR != null && process.env.NO_COLOR !== "";
  if (!shouldShowBanner({ isTTY, noColor, json: flags.json === true, quiet: flags.quiet === true })) {
    return;
  }
  const color = resolveColorMode({
    noColor,
    colorterm: process.env.COLORTERM,
    term: process.env.TERM,
  });
  const columns = typeof process.stdout.columns === "number" ? process.stdout.columns : 80;
  // Rotate the gradient per run so each real invocation reads differently. The
  // random pick lives HERE (the impure wrapper) so the pure renderer stays
  // deterministic for tests/direct callers.
  const palette = PALETTES[Math.floor(Math.random() * PALETTES.length)]!;
  print(renderBrandBanner(activeProgramName, { color, columns, palette }));
  print("");
}

/**
 * Resolve agent-connector's own package version at runtime. Works from both the
 * bundled dist layout (dist/*.js → ../package.json) and the src layout under
 * tsx/vitest (src/cli/ → ../../package.json); the name check guards against
 * accidentally reading some other package.json on the walk.
 */
export function resolveOwnVersion(): string {
  const req = createRequire(import.meta.url);
  for (const rel of ["../package.json", "../../package.json", "../../../package.json"]) {
    try {
      const pkg = req(rel) as { name?: string; version?: string };
      if (pkg.name === "@ken-jo/agent-connector" && typeof pkg.version === "string") {
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

/**
 * Build the render-only {@link ConnectorSummary} from a resolved connector. The
 * command modules call this on the {@link ResolvedConnector} they already loaded
 * and attach the result to {@link InstallResult.connector}, so the friendly
 * renderer can print a header describing WHAT was deployed without importing the
 * heavyweight connector type or its live handlers.
 */
export function buildConnectorSummary(connector: ResolvedConnector): ConnectorSummary {
  let server: ConnectorSummary["server"];
  if (connector.server) {
    const s = connector.server;
    // stdio → "node server.mjs"; remote → the URL (best-effort one-liner).
    // HOME-relativize each part so a bundled absolute server path reads short.
    const cmd =
      s.transport === "stdio"
        ? [s.command, ...(s.args ?? [])]
            .filter((p): p is string => p != null && p !== "")
            .map((p) => tildify(p))
            .join(" ")
        : (s.url ?? "");
    server = { transport: s.transport, command: cmd };
  }
  return {
    id: connector.id,
    version: connector.version,
    displayName: connector.displayName,
    server,
    hookEvents: [...connector.hookEvents],
    telemetryEnabled: connector.telemetry.enabled,
    commands: connector.commands.length,
    skills: connector.skills.length,
    subagents: connector.subagents.length,
    memory: connector.memory.length,
    hasStatusline: connector.statusline != null,
    actions: connector.actions.length,
  };
}

/**
 * Rewrite an absolute path under the user's home dir to a leading `~/…` so the
 * per-host paths read short. Leaves non-home and relative paths untouched.
 */
function tildify(path: string): string {
  // Normalize both to forward slashes so the home-prefix check is separator-
  // robust (Windows mixes `\` and `/`) and the displayed path reads `~/…`
  // consistently on every platform (Windows terminals accept `/` fine).
  const home = homedir().replace(/\\/g, "/");
  const np = path.replace(/\\/g, "/");
  if (home && (np === home || np.startsWith(home + "/"))) {
    return "~" + np.slice(home.length);
  }
  return np;
}

/** Truncate a long single-line command for the header (keeps it scannable). */
function truncateCommand(cmd: string, max = 64): string {
  if (cmd.length <= max) return cmd;
  return cmd.slice(0, max - 1) + "…";
}

/**
 * The surface a ChangeRecord touched, derived from its detail (primary signal)
 * then its path (fallback for content files whose detail is a bare basename).
 */
type Surface = "mcp" | "hooks" | "commands" | "skills" | "subagents" | "memory" | "statusline" | "actions" | "backup" | "other";

function classifySurface(c: ChangeRecord): Surface {
  const detail = c.detail.toLowerCase();
  // A safety backup the installer wrote before a destructive change.
  if (detail.startsWith("backed up") || detail.includes("backup")) return "backup";
  // MCP server entry: mcpServers.<id> / mcp_servers.<id> / mcp.servers.<id>.
  if (/^mcp[._]?servers?\./.test(detail) || detail.startsWith("mcp.")) return "mcp";
  // Normalized + native hook entries: hooks.<Event> (case varies per host).
  if (detail.startsWith("hooks.") || detail.startsWith("hook ")) return "hooks";
  if (detail.includes("nativehooks")) return "hooks";
  if (detail.startsWith("memory")) return "memory";
  if (detail.startsWith("statusline")) return "statusline";
  if (detail.startsWith("actions") || detail.startsWith("action ")) return "actions";
  if (detail.includes("configpatch")) return "other";
  // Path-based fallback for content-file surfaces (detail is a bare basename).
  const p = (c.path ?? "").replace(/\\/g, "/").toLowerCase();
  if (/\/commands?\//.test(p)) return "commands";
  if (/\/skills?\//.test(p)) return "skills";
  if (/\/(subagents?|agents?)\//.test(p)) return "subagents";
  // Detail mentions a surface noun (skip/warn lines like "no skills").
  if (/\bcommands?\b/.test(detail)) return "commands";
  if (/\bskills?\b/.test(detail)) return "skills";
  if (/\bsubagents?\b/.test(detail)) return "subagents";
  return "other";
}

const SURFACE_LABEL_SINGULAR: Record<Surface, string> = {
  mcp: "MCP server",
  hooks: "hook",
  commands: "command",
  skills: "skill",
  subagents: "subagent",
  memory: "memory block",
  statusline: "status line",
  actions: "action",
  backup: "backup",
  other: "change",
};

/** Pluralize a surface count, e.g. (2,"hooks") → "2 hooks". */
function countLabel(n: number, surface: Surface): string {
  const base = SURFACE_LABEL_SINGULAR[surface];
  if (surface === "mcp") return "MCP server"; // singular by construction
  return n === 1 ? `1 ${base}` : `${n} ${base}s`;
}

/** Verb-appropriate glyph for a host's NET status. */
function hostGlyph(status: "ok" | "skip" | "warn"): string {
  return status === "warn" ? "!" : status === "skip" ? "=" : "✓";
}

/**
 * One host's collapsed view: its net status, a surface summary line, the
 * deduped HOME-relativized paths it touched, and any inline warnings.
 */
interface HostGroup {
  platform: PlatformId;
  status: "ok" | "skip" | "warn";
  summary: string;
  paths: string[];
  warnings: string[];
}

/**
 * Collapse the per-(host,surface) ChangeRecords into ONE entry per host:
 *   - status: warn if any record warned; ok if any created/updated/removed;
 *     else skip (everything was a no-op).
 *   - summary: the active (non-skip) surfaces, joined ("MCP server + 2 hooks").
 *     When every record skipped, the reason is surfaced instead.
 */
function groupByHost(changes: ChangeRecord[], verb: Verb): HostGroup[] {
  const order: PlatformId[] = [];
  const byHost = new Map<PlatformId, ChangeRecord[]>();
  for (const c of changes) {
    if (!byHost.has(c.platform)) {
      byHost.set(c.platform, []);
      order.push(c.platform);
    }
    byHost.get(c.platform)!.push(c);
  }

  const groups: HostGroup[] = [];
  for (const platform of order) {
    const recs = byHost.get(platform)!;
    // A safety backup the installer wrote is INCIDENTAL, not an installed
    // surface: it must not flip an otherwise-no-op host to "changed" (an
    // idempotent re-install that only re-backs-up should still read "already
    // current"). It is shown only ALONGSIDE a real surface change.
    const written = recs.filter((c) => c.action !== "skip" && c.action !== "warn");
    const realChanges = written.filter((c) => classifySurface(c) !== "backup");
    const warned = recs.filter((c) => c.action === "warn");
    const status: HostGroup["status"] =
      warned.length > 0 ? "warn" : realChanges.length > 0 ? "ok" : "skip";

    // Surface summary from the written records (created/updated/removed),
    // preserving a stable surface order and collapsing per-surface counts. The
    // incidental `backup` surface is included ONLY when a real surface changed.
    const SURFACE_ORDER: Surface[] = [
      "mcp",
      "hooks",
      "commands",
      "skills",
      "subagents",
      "memory",
      "statusline",
      "actions",
      "backup",
      "other",
    ];
    const counts = new Map<Surface, number>();
    const summarySource = realChanges.length > 0 ? written : realChanges;
    for (const c of summarySource) {
      const s = classifySurface(c);
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const parts = SURFACE_ORDER.filter((s) => counts.has(s)).map((s) =>
      countLabel(counts.get(s)!, s),
    );

    let summary: string;
    if (parts.length > 0) {
      summary = parts.join(" + ");
    } else if (status === "warn") {
      // No real surface change but a warning — the warning line carries detail.
      summary = "";
    } else {
      // Nothing real changed: surface a skip reason (or note the incidental
      // backup) for context.
      const reason =
        recs.find((c) => c.action === "skip")?.detail ??
        (written.length > 0 ? "already current (re-backed-up only)" : "no changes");
      summary = verb === "uninstall" ? `nothing to remove (${reason})` : `unchanged (${reason})`;
    }

    const paths = [
      ...new Set(
        recs
          .filter((c) => c.path != null && c.path !== "")
          .map((c) => tildify(c.path!)),
      ),
    ];
    const warnings = warned.map((c) => c.detail);

    groups.push({ platform, status, summary, paths, warnings });
  }
  return groups;
}

type Verb = "install" | "upgrade" | "uninstall";

/**
 * Render an InstallResult as a friendly, grouped report (the DEFAULT output):
 *   1. a connector header (id/version/displayName + server/hooks/telemetry +
 *      one line per shipped content surface), when the summary is threaded in;
 *   2. one line per host (net glyph + surface summary + deduped ~/… paths),
 *      with any host warnings inline beneath it;
 *   3. a friendly closing line + restart hint + doctor/uninstall next steps.
 *
 * Used by install / upgrade / uninstall. The exit-non-zero-on-warn convention
 * is enforced by the callers (this function only renders).
 */
export function renderInstallResult(result: InstallResult, verb: Verb): string {
  const lines: string[] = [];
  const summary = result.connector;

  // ── 1. Connector header ───────────────────────────────────────────────────
  if (summary) {
    const head = [`${summary.id}  v${summary.version}`];
    if (summary.displayName && summary.displayName !== summary.id) {
      head.push(summary.displayName);
    }
    lines.push(head.join("  ·  "));

    if (summary.server) {
      lines.push(
        `  server      ${summary.server.transport} · ${truncateCommand(summary.server.command)}`,
      );
    } else {
      lines.push("  server      (hooks-only)");
    }
    if (summary.hookEvents.length > 0) {
      lines.push(`  hooks       ${summary.hookEvents.join(", ")}`);
    }
    lines.push(`  telemetry   ${summary.telemetryEnabled ? "on" : "off"}`);
    if (summary.commands > 0)
      lines.push(`  commands    ${summary.commands}`);
    if (summary.skills > 0) lines.push(`  skills      ${summary.skills}`);
    if (summary.subagents > 0)
      lines.push(`  subagents   ${summary.subagents}`);
    if (summary.memory > 0) lines.push(`  memory      ${summary.memory}`);
    if (summary.hasStatusline) lines.push(`  statusline  1`);
    if (summary.actions > 0) lines.push(`  actions     ${summary.actions}`);
    lines.push("");
  } else {
    // No summary threaded (back-compat): keep a minimal verb header.
    const mode = result.dryRun ? " (dry-run — nothing written)" : "";
    lines.push(`${verb} "${result.connectorId}"${mode}`);
  }

  // ── 2. Per-host grouping ──────────────────────────────────────────────────
  const groups = groupByHost(result.changes, verb);
  if (groups.length === 0) {
    lines.push("(no changes)");
  } else {
    const verbed = verb === "uninstall" ? "removed from" : verb === "upgrade" ? "synced to" : "detected";
    lines.push(`→ ${groups.length} agent ${groups.length === 1 ? "CLI" : "CLIs"} ${verbed}:`);
    // Width-align the platform column for a scannable table; the summary column
    // gets a fixed min width but always keeps a 2-space gap before the paths
    // even when an unusually long summary overflows it.
    const pad = Math.max(...groups.map((g) => g.platform.length));
    for (const g of groups) {
      const glyph = hostGlyph(g.status);
      const name = g.platform.padEnd(pad);
      const pathsCol = g.paths.join(", ");
      const gap = pathsCol === "" ? "" : "  ";
      const summaryCol = pathsCol === "" ? g.summary : g.summary.padEnd(26) + gap;
      lines.push(`  ${glyph} ${name}   ${summaryCol}${pathsCol}`.trimEnd());
      for (const w of g.warnings) lines.push(`      ! ${w}`);
    }
  }

  // ── 3. Closing summary + next steps ───────────────────────────────────────
  // The headline file tally counts only REAL surface writes — an incidental
  // safety backup must not masquerade as an installed file, so a re-install
  // whose only write was a backup honestly reports 0 files / "already current".
  const tally = result.changes.reduce(
    (acc, c) => {
      const isWrite = c.action === "create" || c.action === "update" || c.action === "remove";
      if (isWrite && classifySurface(c) !== "backup") acc.files += 1;
      if (c.action === "warn") acc.warns += 1;
      return acc;
    },
    { files: 0, warns: 0 },
  );
  const cliCount = groups.length;
  const cliWord = cliCount === 1 ? "CLI" : "CLIs";
  const fileWord = tally.files === 1 ? "file" : "files";

  lines.push("");
  if (verb === "uninstall") {
    if (result.dryRun) {
      lines.push(`✓ Would remove ${summary?.id ?? result.connectorId} from ${cliCount} ${cliWord} · ${tally.files} ${fileWord} (dry-run — nothing written).`);
    } else if (tally.files === 0 && tally.warns === 0) {
      lines.push(`✓ Nothing to remove — ${summary?.id ?? result.connectorId} was not installed (zero residue).`);
    } else {
      lines.push(`✓ Removed ${summary?.id ?? result.connectorId} from ${cliCount} ${cliWord} · ${tally.files} ${fileWord} cleaned${tally.warns === 0 ? " (zero residue)" : ""}.`);
    }
  } else {
    const what = verb === "upgrade" ? "Synced" : "Installed";
    const wouldWhat = verb === "upgrade" ? "sync" : "install";
    if (result.dryRun) {
      lines.push(`✓ Would ${wouldWhat} ${summary?.id ?? result.connectorId} to ${cliCount} ${cliWord} · ${tally.files} ${fileWord} (dry-run — nothing written).`);
    } else if (tally.files === 0) {
      lines.push(`✓ ${summary?.id ?? result.connectorId}: already current on ${cliCount} ${cliWord} — nothing to write.`);
    } else {
      lines.push(`✓ ${what} ${summary?.id ?? result.connectorId} to ${cliCount} ${cliWord} · ${tally.files} ${fileWord}. Restart each CLI to load it.`);
    }
  }

  // Warnings block (kept explicit — callers exit non-zero on any warn). A
  // remote-transport connector pushes the SAME string to both a warn
  // ChangeRecord (already shown inline on its host line) and result.warnings, so
  // skip any bottom-block entry already surfaced inline to show each warning ONCE.
  const inlineWarnings = new Set(groups.flatMap((g) => g.warnings));
  const blockWarnings = result.warnings.filter((w) => !inlineWarnings.has(w));
  if (blockWarnings.length > 0) {
    lines.push("");
    lines.push("warnings:");
    for (const w of blockWarnings) lines.push(`  ! ${w}`);
  }

  // Next-step hints (the verbs read as the active brand).
  if (verb === "uninstall") {
    lines.push(`  Verify it's gone: ${activeProgramName} doctor`);
  } else {
    lines.push(
      `  Verify: ${activeProgramName} doctor   ·   Remove: ${activeProgramName} uninstall`,
    );
  }

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
  // Internal (omitted from USAGE): the statusline (HUD) entrypoint a host's
  // status line config points at. Fail-safe: always exits 0 with at most a
  // rendered line. See cli/commands/statusline.ts.
  statusline: () => import("./commands/statusline.js"),
  // Internal (omitted from USAGE): the user-invokable action entrypoint a future
  // host affordance points at. USER-TRIGGERED: surfaces errors (exit 1 + stderr),
  // unlike the fail-open hook / fail-safe statusline. See cli/commands/action.ts.
  action: () => import("./commands/action.js"),
  serve: () => import("./commands/serve.js"),
  // Hidden (omitted from USAGE): the opt-in host-native turn-usage entrypoint an
  // AfterModel / PostInvocation hook points at. Always exits 0; records a
  // distinct `model_turn` row. See cli/commands/usage-event.ts.
  "usage-event": () => import("./commands/usage-event.js"),
};

/** Default program name; an embedding SDK CLI overrides it via {@link MainOptions}. */
export const DEFAULT_PROGRAM_NAME = "agent-connector";

/**
 * One-line usage signature per command — the single central copy behind
 * `<command> --help` and the friendly bad-flag error. Command modules use
 * node:util parseArgs (strict), which THROWS on an unknown flag; without the
 * dispatcher-level handling in {@link main}, `agent-connector install --help`
 * would die with a raw ERR_PARSE_ARGS stack trace — the very invocation the
 * root help tells users to run.
 */
const COMMAND_USAGE: Record<string, string> = {
  detect: "detect [--json] [--project <dir>]",
  install:
    "install [<source>] [--method direct|marketplace] [--connector <source>] [--scope user|project] [--targets a,b] [--project <dir>] [--dry-run] [--force] [--quiet]\n" +
    "  <source>    a local path OR a remote GitHub connector: owner/repo[/subpath][#ref], a github.com URL (incl. /tree/<ref>/<sub>), git@github.com:owner/repo, or github:owner/repo. Remote sources are fetched to ~/.agent-connector/sources/ and must be an agent-connector package (have an agent-connector.config.{mjs,js,json}).",
  uninstall:
    "uninstall [--method auto|direct|marketplace] [--connector <path>] [--connector-id <id>] [--scope user|project] [--targets a,b] [--project <dir>] [--dry-run] [--purge] [--quiet]",
  upgrade:
    "upgrade [--method direct|marketplace] [--channel stable|latest] [--connector <path>] [--scope user|project] [--targets a,b] [--project <dir>] [--dry-run] [--quiet]",
  sync: "sync — alias of upgrade (see `upgrade --help`)",
  update: "update — alias of upgrade (see `upgrade --help`)",
  package:
    "package [--connector <path>] [--format <fmt>|all] [--out <dir>] [--project <dir>] [--dry-run]",
  doctor:
    "doctor [--targets a,b] [--connector <path>] [--scope user|project] [--project <dir>] [--probe] [--explain] [--json] [--heal] [--dry-run] [--quiet]\n" +
    "  --explain   per-(host,event) hook honor matrix (honored/degraded/dropped). Exit non-zero ONLY when an explicitly-targeted host DEGRADES a declared event (fires it but silently won't honor the reply); dropped/mcp-only hosts and fleet-wide (targets:auto) gaps are informational (exit 0).",
  status: "status [--connector <path>] [--scope user|project] [--project <dir>] [--json]",
  telemetry:
    "telemetry report|export|leaderboard [--by <dim>] [--since <dur>] [--connector <id>] [--scope <slice>] [--format csv|json] [--out <file>] [--json]",
  usage:
    "usage report|export|leaderboard [--by <dim>] [--since <dur>] [--platform <id>] [--format csv|json] [--out <file>] [--json]",
  leaderboard: "leaderboard [--since <dur>] [--connector <id>] [--scope <slice>] [--json]",
  hook: "hook <platform> <event> --connector <id>   (internal — host hook configs point here)",
  statusline:
    "statusline <platform> --connector <id>   (internal — host status line configs point here)",
  action:
    "action <platform> <actionId> --connector <id>   (internal — host action affordances point here)",
  serve:
    "serve --connector <id> [--scope user|project] [--host <platformId>] -- <command> [args...]   (internal — host MCP entries point here)",
};

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
  install      Deploy a connector across its target platforms (--method direct writes host config; --method marketplace drives the host's plugin install).
  uninstall    Remove a connector's registrations (--method auto reverses whichever method is actually installed).
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
