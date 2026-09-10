/**
 * cli/commands/auth — log in to the OAuth providers a connector declares.
 *
 * A connector names the providers it needs under `oauth.<key>`. The user
 * authorizes once here — browser loopback or device code — and the refresh
 * token lands in the connector's secret namespace (OS keystore, or the opt-in
 * plaintext `file` backend) under the login's `storeAs` name; the runtime
 * mints access tokens from it (core/oauth). Nothing this command prints ever
 * carries a token, an authorization code or a client secret, with one
 * deliberate exception: `auth token`, whose entire stdout IS the access token.
 *
 *   auth login <key>    authorize in the browser (or with a device code), store the refresh token
 *   auth status         key, provider, presence, when and how — never a token
 *   auth logout <key>   revoke at the provider when it has a revocation endpoint, then forget the token
 *   auth token <key>    print a fresh access token (exit 1 when not logged in)
 *
 * Connector resolution is the one `secrets` uses (cli/commands/connector-target):
 * --connector-id, --connector <path>, agent-connector.config.* in --project /
 * cwd, the single registered connector. The login definitions come from the
 * loaded config when the connector came from a path, else from its registry
 * record — so a bare --connector-id needs the connector to be registered.
 */

import { parseArgs } from "node:util";

import {
  OAuthError,
  getAccessToken,
  getOAuthPreset,
  login,
  loginStatus,
  logout,
  openBrowser,
} from "../../core/oauth/index.js";
import type { LoginStatus } from "../../core/oauth/index.js";
import { readRegisteredMeta } from "../../core/load-connector.js";
import { SecretError, SecretResolutionError } from "../../core/secrets.js";
import type { OAuthFlow, ResolvedConnector, ResolvedOAuthLoginDef } from "../../core/types.js";
import { fail, getActiveProgramName, print } from "../app.js";
import { resolveConnectorId } from "./connector-target.js";

/**
 * The four usage lines — the same text app.ts prints for `auth --help`
 * (COMMAND_USAGE) and the docs quote; tests pin the copies together.
 */
export const AUTH_USAGE_LINES: readonly string[] = [
  "auth login <key> [--connector <path>] [--connector-id <id>] [--project <dir>] [--device|--loopback] [--port <n>] [--json]",
  "auth status [--connector <path>] [--connector-id <id>] [--project <dir>] [--json]",
  "auth logout <key> [--connector <path>] [--connector-id <id>] [--project <dir>]",
  "auth token <key> [--connector <path>] [--connector-id <id>] [--project <dir>]",
];

const VERBS = ["login", "status", "logout", "token"] as const;
type Verb = (typeof VERBS)[number];

type OptionalFlag = "device" | "loopback" | "port" | "json";

/** The optional flags each verb accepts; any other flag is a usage error. */
const VERB_FLAGS: Record<Verb, readonly OptionalFlag[]> = {
  login: ["device", "loopback", "port", "json"],
  status: ["json"],
  logout: [],
  token: [],
};

/** Loopback ports below 1024 need privileges; the config validation draws the same line. */
const PORT_MIN = 1024;
const PORT_MAX = 65535;

/** Seams for tests and embedders; production uses the browser opener, stderr and global fetch. */
export interface AuthIo {
  /** Hands the authorization URL to a browser (default: the platform opener from core/oauth). */
  openBrowser?: (url: string) => Promise<void> | void;
  /** Progress lines — the "Opening …" line, the URL, the device prompt (default: stderr). */
  log?: (line: string) => void;
  /** HTTP seam for discovery and the token / revocation endpoints (default: global fetch). */
  fetch?: typeof fetch;
  /** Whole-flow login timeout in ms (default: the engine's). */
  loginTimeoutMs?: number;
  /** Environment for `${env:VAR}` expansion and the browser heuristics (default: process.env). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function isVerb(value: string): value is Verb {
  return (VERBS as readonly string[]).includes(value);
}

function usageLine(verb: Verb): string {
  return AUTH_USAGE_LINES[VERBS.indexOf(verb)] as string;
}

/** Usage error: the verb's signature on stderr, then the branded message (exit 2). */
function usageError(verb: Verb, message: string): number {
  process.stderr.write(`usage: ${getActiveProgramName()} ${usageLine(verb)}\n`);
  return fail(message);
}

/** Operational failure (exit 1) with the engine's or keystore's hint, when it has one. */
function failWithHint(message: string, hint?: string): number {
  const code = fail(message, 1);
  if (hint) process.stderr.write(`  hint: ${hint}\n`);
  return code;
}

function stderrLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

// ── Login definitions ─────────────────────────────────────────────────────

type Logins = Record<string, ResolvedOAuthLoginDef>;

/**
 * The `oauth.<key>` definitions of the resolved connector: from the loaded
 * config when it came from a path, else from the registry record.
 */
function loginsOf(choice: { id: string; connector?: ResolvedConnector }): { logins: Logins } | { error: string } {
  if (choice.connector) return { logins: choice.connector.oauth ?? {} };
  const meta = readRegisteredMeta(choice.id);
  if (!meta) {
    return {
      error:
        `connector "${choice.id}" is not registered here — pass --connector <path> ` +
        "so its oauth logins can be read from the config",
    };
  }
  return { logins: meta.oauth ?? {} };
}

// ── Verbs ─────────────────────────────────────────────────────────────────

interface Flags {
  flow?: OAuthFlow;
  port?: number;
  json: boolean;
}

/** The engine options every verb forwards from the io seam. */
function netOptions(io: AuthIo): { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } {
  return {
    ...(io.fetch ? { fetch: io.fetch } : {}),
    ...(io.env ? { env: io.env } : {}),
  };
}

async function runLogin(
  connectorId: string,
  key: string,
  def: ResolvedOAuthLoginDef,
  flags: Flags,
  io: AuthIo,
): Promise<number> {
  const label = getOAuthPreset(def.provider).label;
  const log = io.log ?? stderrLine;
  const open = io.openBrowser ?? openBrowser;
  const result = await login({
    connectorId,
    key,
    def: flags.port !== undefined ? { ...def, redirectPort: flags.port } : def,
    ...(flags.flow ? { flow: flags.flow } : {}),
    openBrowser: async (url: string) => {
      log(`Opening ${label} authorization in your browser…`);
      log(url);
      await open(url);
    },
    log,
    ...netOptions(io),
    ...(io.loginTimeoutMs !== undefined ? { loginTimeoutMs: io.loginTimeoutMs } : {}),
    ...(io.platform ? { platform: io.platform } : {}),
  });
  if (flags.json) {
    print(JSON.stringify(result, null, 2));
    return 0;
  }
  print(
    `logged in to "${key}" (${label}) for connector ${connectorId} — refresh token stored in ${result.backend}`,
  );
  return 0;
}

function presenceLabel(present: boolean | null): string {
  return present === null ? "unknown" : present ? "yes" : "no";
}

function renderTable(statuses: LoginStatus[]): string {
  const header = ["key", "provider", "present", "obtained", "via"];
  const rows = statuses.map((s) => [
    s.key,
    s.provider,
    presenceLabel(s.present),
    s.obtainedAt ?? "-",
    s.obtainedVia ?? "-",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] as number))).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

function runStatus(connectorId: string, logins: Logins, io: AuthIo, json: boolean): number {
  const statuses = loginStatus({ connectorId, logins, ...(io.env ? { env: io.env } : {}) });
  if (json) {
    print(JSON.stringify(statuses, null, 2));
    return 0;
  }
  if (statuses.length === 0) {
    print(`no logins declared for connector ${connectorId} — add oauth.<key> to the connector config`);
    return 0;
  }
  print(renderTable(statuses));
  return 0;
}

async function runLogout(
  connectorId: string,
  key: string,
  def: ResolvedOAuthLoginDef,
  io: AuthIo,
): Promise<number> {
  const { removed, revoked } = await logout({ connectorId, key, def, ...netOptions(io) });
  print(
    `logged out of "${key}" for connector ${connectorId}` +
      (revoked ? " (revoked at the provider)" : removed ? "" : " (nothing was stored)"),
  );
  return 0;
}

/** The one place a token is printed: the access token alone, then a newline. */
async function runToken(
  connectorId: string,
  key: string,
  def: ResolvedOAuthLoginDef,
  io: AuthIo,
): Promise<number> {
  const token = await getAccessToken({ connectorId, key, def, interactive: "never", ...netOptions(io) });
  process.stdout.write(`${token.accessToken}\n`);
  return 0;
}

// ── Entry point ───────────────────────────────────────────────────────────

export async function run(argv: string[], io: AuthIo = {}): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      connector: { type: "string" },
      "connector-id": { type: "string" },
      project: { type: "string" },
      device: { type: "boolean", default: false },
      loopback: { type: "boolean", default: false },
      port: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const [verbRaw, key, ...extra] = positionals;
  if (verbRaw === undefined) {
    process.stderr.write(`usage: ${getActiveProgramName()} ${AUTH_USAGE_LINES.join("\n  ")}\n`);
    return fail("auth: missing subcommand (login | status | logout | token)");
  }
  if (!isVerb(verbRaw)) {
    return fail(`unknown auth subcommand "${verbRaw}" (use ${VERBS.join("|")})`);
  }
  const verb = verbRaw;
  const given: Record<OptionalFlag, boolean> = {
    device: values.device ?? false,
    loopback: values.loopback ?? false,
    port: values.port !== undefined,
    json: values.json ?? false,
  };
  for (const flag of ["device", "loopback", "port", "json"] as const) {
    if (given[flag] && !VERB_FLAGS[verb].includes(flag)) {
      return usageError(verb, `--${flag} is not accepted by \`auth ${verb}\``);
    }
  }

  const needsKey = verb !== "status";
  if (needsKey && key === undefined) return usageError(verb, `auth ${verb}: missing <key>`);
  if (!needsKey && key !== undefined) {
    return usageError(verb, `auth ${verb}: unexpected argument "${key}"`);
  }
  if (extra.length > 0) return usageError(verb, `auth ${verb}: unexpected argument "${extra[0]}"`);
  if (given.device && given.loopback) {
    return usageError(verb, "auth login: --device and --loopback are mutually exclusive");
  }
  const flags: Flags = {
    ...(given.device ? { flow: "device" as const } : given.loopback ? { flow: "loopback" as const } : {}),
    json: given.json,
  };
  if (values.port !== undefined) {
    const port = /^\d+$/.test(values.port) ? Number(values.port) : Number.NaN;
    if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
      return usageError(verb, `auth login: --port expected an integer in ${PORT_MIN}..${PORT_MAX}`);
    }
    flags.port = port;
  }

  const choice = await resolveConnectorId(
    values["connector-id"],
    values.connector,
    values.project ?? process.cwd(),
  );
  if ("error" in choice) return fail(choice.error, 1);
  const connectorId = choice.id;
  const resolved = loginsOf(choice);
  if ("error" in resolved) return fail(resolved.error, 1);
  const logins = resolved.logins;

  let def: ResolvedOAuthLoginDef | undefined;
  if (needsKey) {
    def = Object.prototype.hasOwnProperty.call(logins, key as string) ? logins[key as string] : undefined;
    if (!def) {
      const declared = Object.keys(logins);
      return usageError(
        verb,
        `auth ${verb}: connector ${connectorId} declares no login "${key}" ` +
          `(declared: ${declared.length > 0 ? declared.join(", ") : "none"})`,
      );
    }
  }

  try {
    switch (verb) {
      case "login":
        return await runLogin(connectorId, key as string, def as ResolvedOAuthLoginDef, flags, io);
      case "status":
        return runStatus(connectorId, logins, io, flags.json);
      case "logout":
        return await runLogout(connectorId, key as string, def as ResolvedOAuthLoginDef, io);
      case "token":
        return await runToken(connectorId, key as string, def as ResolvedOAuthLoginDef, io);
    }
  } catch (err) {
    if (err instanceof OAuthError) return failWithHint(err.message, err.hint);
    if (err instanceof SecretError) return failWithHint(err.message, err.hint);
    if (err instanceof SecretResolutionError) return fail(err.message, 1);
    throw err;
  }
}
