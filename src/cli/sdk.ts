/**
 * cli/sdk — the EMBEDDED SDK entry point for a developer-branded CLI.
 *
 * A developer adds agent-connector as a dependency, writes their connector
 * config, and ships their OWN bin. `createConnectorCli` returns a runner that
 * exposes EVERY agent-connector subcommand under the developer's brand, fully
 * delegated and AUTO-SCOPED to the developer's connector:
 *
 *   #!/usr/bin/env node
 *   import { fileURLToPath } from "node:url";
 *   import { createConnectorCli } from "agent-connector/cli";
 *   createConnectorCli({
 *     name: "acme-db",
 *     connector: fileURLToPath(new URL("./agent-connector.config.mjs", import.meta.url)),
 *   }).run();
 *   // fileURLToPath, NOT URL.pathname — .pathname yields "/C:/…" on Windows.
 *
 * Then a consumer runs `acme-db install`, `acme-db leaderboard`, `acme-db
 * telemetry`, `acme-db doctor`, etc. — and each one targets the developer's
 * connector WITHOUT the consumer having to pass --connector.
 *
 * This module is PURE ARGUMENT TRANSFORMATION: it injects the right --connector
 * (path) or --connector <id> filter when the user did not supply one, then hands
 * off to {@link main} with the developer's program name. It never duplicates any
 * command logic — every behavior still lives in the command modules.
 */

import { loadConnectorFromPath } from "../core/load-connector.js";
import { main } from "./app.js";

/** Options for {@link createConnectorCli}. */
export interface CreateConnectorCliOptions {
  /** The developer's bin/brand name (shown in usage/help, e.g. "acme-db"). */
  name: string;
  /**
   * Absolute path to the developer's connector config (.mjs / .js / .json) that
   * ships inside their package. Injected as `--connector <path>` for the
   * connector-targeted subcommands when the user did not pass one.
   */
  connector: string;
  /**
   * The connector id used for the telemetry/leaderboard FILTER injection. When
   * omitted it is derived lazily by loading the connector config the first time a
   * telemetry/leaderboard subcommand runs.
   */
  connectorId?: string;
}

/** The runner returned by {@link createConnectorCli}. */
export interface ConnectorCli {
  /**
   * Run a branded invocation. `argv` defaults to `process.argv.slice(2)`.
   * Resolves to the process exit code (0 success, non-zero failure).
   */
  run(argv?: string[]): Promise<number>;
}

/**
 * Connector-targeted subcommands whose `--connector` is a CONFIG PATH: they load
 * the connector definition from disk. For these we inject the developer's config
 * PATH so their connector is the implicit target.
 *
 * (`uninstall` also accepts `--connector-id`; injecting the path is sufficient —
 * uninstall derives the id from the config when no explicit id is given.)
 */
const CONFIG_PATH_COMMANDS: ReadonlySet<string> = new Set([
  "install",
  "uninstall",
  "upgrade",
  // `sync` + `update` are back-compat aliases of `upgrade`; scope them too so a
  // branded `acme-db sync` / `acme-db update` still targets the dev connector.
  "sync",
  "update",
  "doctor",
  "status",
  "package",
]);

/**
 * Connector-targeted subcommands whose `--connector` is the registered connector
 * ID, spliced right AFTER the subcommand token: `serve` and `hook` pass it
 * straight to the runtime. (They cannot take a trailing flag — serve has a `--`
 * separator and hook has positionals — so the flag must lead.)
 */
const ID_HEAD_COMMANDS: ReadonlySet<string> = new Set(["serve", "hook"]);

/**
 * View subcommands where `--connector <id>` is a FILTER appended at the END:
 * `leaderboard` (top-level) and `telemetry` (whose own sub — report|export|
 * leaderboard — is the leading positional, so the filter must come after it).
 * Appending keeps that leading positional intact while parseArgs still reads the
 * flag, so the branded tool shows ITS connector's data.
 *
 * Note: `usage` reads host CLI logs which carry no connector attribution, so it
 * is intentionally absent — there is nothing to scope it to.
 */
const ID_TAIL_COMMANDS: ReadonlySet<string> = new Set(["telemetry", "leaderboard"]);

/**
 * Should the tail (telemetry/leaderboard) filter injection be SKIPPED because the
 * invocation is just asking for help / has no actionable sub? Skipping leaves the
 * branded usage text intact instead of turning `acme-db telemetry` into
 * `telemetry --connector <id>` (which the telemetry dispatcher would reject as an
 * unknown sub). True when a help flag appears, or when `telemetry` has no sub.
 */
function wantsHelp(argv: string[]): boolean {
  if (argv.includes("--help") || argv.includes("-h")) return true;
  // `telemetry` with no sub-subcommand → show its help, don't inject a filter.
  if (argv[0] === "telemetry" && argv[1] === undefined) return true;
  return false;
}

/** Did the user already pass a --connector / --connector-id flag (any form)? */
function hasConnectorFlag(argv: string[]): boolean {
  for (const a of argv) {
    if (a === "--connector" || a === "--connector-id") return true;
    if (a.startsWith("--connector=") || a.startsWith("--connector-id=")) return true;
  }
  return false;
}

/**
 * Splice `--connector <value>` immediately after the subcommand token (argv[0])
 * so it sits BEFORE any positionals or a `serve` `--` separator. Used for the
 * config-path commands and for serve/hook (whose `--` / positional grammar makes
 * trailing append unsafe). The original argv is never mutated.
 */
function injectAfterCommand(argv: string[], flag: string, value: string): string[] {
  return [argv[0] as string, flag, value, ...argv.slice(1)];
}

/**
 * Append `--connector <value>` to the END of argv. Used for the view commands
 * (`leaderboard`/`telemetry`) whose leading positional sub must be preserved.
 * The original argv is never mutated.
 */
function appendFlag(argv: string[], flag: string, value: string): string[] {
  return [...argv, flag, value];
}

export function createConnectorCli(opts: CreateConnectorCliOptions): ConnectorCli {
  if (typeof opts.name !== "string" || opts.name.trim() === "") {
    throw new TypeError("createConnectorCli: `name` must be a non-empty string");
  }
  if (typeof opts.connector !== "string" || opts.connector.trim() === "") {
    throw new TypeError("createConnectorCli: `connector` must be a non-empty path");
  }

  // Cache the derived id so the connector module is loaded at most once across
  // repeated `.run()` calls in the same process.
  let cachedId: string | undefined = opts.connectorId;

  async function resolveConnectorId(): Promise<string> {
    if (cachedId !== undefined && cachedId !== "") return cachedId;
    const { connector } = await loadConnectorFromPath(opts.connector);
    cachedId = connector.id;
    return cachedId;
  }

  async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
    const command = argv[0];

    // No subcommand, a help/version flag, or an unknown command: nothing to scope
    // — hand off verbatim so usage/version is branded and errors stay accurate.
    if (command === undefined || command.startsWith("-")) {
      return main(argv, { programName: opts.name });
    }

    let scoped = argv;

    if (!hasConnectorFlag(argv)) {
      if (CONFIG_PATH_COMMANDS.has(command)) {
        // Inject the connector CONFIG PATH as the implicit target.
        scoped = injectAfterCommand(argv, "--connector", opts.connector);
      } else if (ID_HEAD_COMMANDS.has(command)) {
        // serve/hook take the connector ID and pass it to the runtime. Splice it
        // right after the subcommand token so a serve `--` separator and hook's
        // positionals are preserved.
        const id = await resolveConnectorId();
        scoped = injectAfterCommand(argv, "--connector", id);
      } else if (ID_TAIL_COMMANDS.has(command) && !wantsHelp(argv)) {
        // leaderboard/telemetry use the connector ID as a FILTER. Append it so
        // telemetry's leading positional sub (report|export|leaderboard) stays
        // the first token while parseArgs still reads the flag. We skip injection
        // for a bare/help invocation so the (un-filtered) usage text still shows.
        const id = await resolveConnectorId();
        scoped = appendFlag(argv, "--connector", id);
      }
    }

    return main(scoped, { programName: opts.name });
  }

  return { run };
}
