/**
 * cli/sdk — the EMBEDDED SDK entry point for a developer-branded CLI.
 *
 * A developer adds agent-connector as a dependency, writes their connector
 * config, and ships their OWN bin. `createConnectorCli` returns a runner that
 * exposes EVERY agent-connector subcommand under the developer's brand, fully
 * delegated and AUTO-SCOPED to the developer's connector:
 *
 *   #!/usr/bin/env node
 *   import { createConnectorCli } from "@ken-jo/agent-connector/cli";
 *   createConnectorCli({
 *     packageJson: new URL("./package.json", import.meta.url),
 *     connector: new URL("./agent-connector.config.mjs", import.meta.url),
 *   }).run();
 *
 * Then a consumer runs `acme-db install`, `acme-db leaderboard`, `acme-db
 * telemetry`, `acme-db doctor`, etc. — and each one targets the developer's
 * connector WITHOUT the consumer having to pass --connector.
 *
 * This module is PURE ARGUMENT TRANSFORMATION: it injects the right --connector
 * (path) or --connector <id> filter when the user did not supply one, then hands
 * off to {@link main} with the developer's program name/version. It never
 * duplicates any command logic — every behavior still lives in the command
 * modules.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { loadConnectorFromPath } from "../core/load-connector.js";
import { main } from "./app.js";

export type ConnectorCliPath = string | URL;

export interface ConnectorCliContext {
  /** Resolved brand/bin name shown in usage, errors, and --version output. */
  programName: string;
  /** Resolved branded package version shown by --version. */
  programVersion: string;
  /** Absolute connector config path injected into connector-targeted commands. */
  connector: string;
  /** Lazily resolves the connector id for telemetry/serve/hook scoping. */
  connectorId(): Promise<string>;
}

export interface ConnectorCliPassthrough {
  /**
   * Return true when this invocation should be handled by custom package logic
   * instead of the agent-connector command dispatcher.
   */
  when(argv: readonly string[], context: ConnectorCliContext): boolean;
  /** Handle a matched invocation. Return the process exit code. */
  run(
    argv: readonly string[],
    context: ConnectorCliContext,
  ): number | Promise<number>;
}

/** Options for {@link createConnectorCli}. */
export interface CreateConnectorCliOptions {
  /**
   * The developer's bin/brand name (shown in usage/help, e.g. "acme-db").
   * Prefer `packageJson` for packaged connectors so name/version stay in one
   * source of truth; this remains available for custom launchers and tests.
   */
  name?: string;
  /**
   * package.json for the branded connector package. When supplied, the CLI
   * derives the bin name and version from package metadata.
   */
  packageJson?: ConnectorCliPath;
  /**
   * Absolute path or file URL to the developer's connector config (.mjs / .js /
   * .json) that ships inside their package. Injected as `--connector <path>` for
   * connector-targeted subcommands when the user did not pass one.
   */
  connector: ConnectorCliPath;
  /**
   * The connector id used for the telemetry/leaderboard FILTER injection. When
   * omitted it is derived lazily by loading the connector config the first time a
   * telemetry/leaderboard subcommand runs.
   */
  connectorId?: string;
  /**
   * Package-specific command escapes that should run before agent-connector's
   * dispatcher. Use sparingly for legacy/runtime commands that intentionally
   * live outside the universal connector surface.
   */
  passthrough?: readonly ConnectorCliPassthrough[];
}

/** The runner returned by {@link createConnectorCli}. */
export interface ConnectorCli {
  /** Resolved brand/bin name. */
  name: string;
  /** Resolved branded package version. */
  version: string;
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
  "audit",
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

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pathFrom(value: ConnectorCliPath, label: string): string {
  if (value instanceof URL) return fileURLToPath(value);
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new TypeError(`createConnectorCli: \`${label}\` must be a non-empty path or file URL`);
}

function normalizeBinTarget(target: string): string {
  return target.replace(/\\/g, "/").replace(/^\.\//, "");
}

function realPathIfExists(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function packageNameToBinName(packageName: string | undefined): string | undefined {
  if (!packageName) return undefined;
  if (packageName.startsWith("@")) return cleanString(packageName.split("/")[1]);
  return cleanString(packageName);
}

function readPackageCliMetadata(packageJsonPath: string): {
  name?: string;
  version?: string;
} {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
    bin?: unknown;
  };
  const packageName = cleanString(parsed.name);
  const version = cleanString(parsed.version);
  const packageBinName = packageNameToBinName(packageName);

  let name: string | undefined;
  if (typeof parsed.bin === "string") {
    name = packageBinName;
  } else if (parsed.bin && typeof parsed.bin === "object" && !Array.isArray(parsed.bin)) {
    const entries = Object.entries(parsed.bin)
      .filter(
        (entry): entry is [string, string] =>
          cleanString(entry[0]) != null && typeof entry[1] === "string",
      )
      .map(([binName, target]) => [binName, normalizeBinTarget(target)] as const);
    const packageDir = dirname(packageJsonPath);
    const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
    const invoked = invokedPath ? (realPathIfExists(invokedPath) ?? invokedPath) : undefined;
    name =
      (invoked
        ? entries.find(([, target]) => {
            const targetPath = resolve(packageDir, target);
            return (realPathIfExists(targetPath) ?? targetPath) === invoked;
          })?.[0]
        : undefined) ??
      (packageBinName ? entries.find(([binName]) => binName === packageBinName)?.[0] : undefined) ??
      (entries.length === 1 ? entries[0]?.[0] : undefined);
  }

  return { ...(name ? { name } : {}), ...(version ? { version } : {}) };
}

export function createConnectorCli(opts: CreateConnectorCliOptions): ConnectorCli {
  const packageJsonPath = opts.packageJson ? pathFrom(opts.packageJson, "packageJson") : undefined;
  const packageMetadata = packageJsonPath ? readPackageCliMetadata(packageJsonPath) : {};
  const name = cleanString(opts.name) ?? packageMetadata.name;
  const version = packageMetadata.version;

  if (!name) {
    throw new TypeError("createConnectorCli: `name` or packageJson-derived bin name is required");
  }
  const programName = name;
  const connectorPath = pathFrom(opts.connector, "connector");

  // Cache the derived id so the connector module is loaded at most once across
  // repeated `.run()` calls in the same process.
  let cachedId: string | undefined = opts.connectorId;

  async function resolveConnectorId(): Promise<string> {
    if (cachedId !== undefined && cachedId !== "") return cachedId;
    const { connector } = await loadConnectorFromPath(connectorPath);
    cachedId = connector.id;
    return cachedId;
  }

  async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
    const context: ConnectorCliContext = {
      programName,
      programVersion: version ?? "0.0.0",
      connector: connectorPath,
      connectorId: resolveConnectorId,
    };
    for (const passthrough of opts.passthrough ?? []) {
      if (passthrough.when(argv, context)) {
        return passthrough.run(argv, context);
      }
    }

    const command = argv[0];

    // No subcommand, a help/version flag, or an unknown command: nothing to scope
    // — hand off verbatim so usage/version is branded and errors stay accurate.
    if (command === undefined || command.startsWith("-")) {
      return main(
        argv,
        version ? { programName, programVersion: version } : { programName },
      );
    }

    let scoped = argv;

    if (!hasConnectorFlag(argv)) {
      if (CONFIG_PATH_COMMANDS.has(command)) {
        // Inject the connector CONFIG PATH as the implicit target.
        scoped = injectAfterCommand(argv, "--connector", connectorPath);
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

    return main(
      scoped,
      version ? { programName, programVersion: version } : { programName },
    );
  }

  return { name: programName, version: version ?? "0.0.0", run };
}
