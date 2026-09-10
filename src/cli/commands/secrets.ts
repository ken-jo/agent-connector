/**
 * cli/commands/secrets — store the secrets a connector references.
 *
 * A stdio server's `env` may reference a stored secret as `${secret:NAME}`.
 * The value never touches a host config file: it lives in the OS keystore
 * (macOS Keychain / Linux Secret Service / Windows Credential Manager — or the
 * opt-in plaintext `file` backend) under the service `agent-connector/<id>`,
 * and the `serve` wrapper injects it into the MCP server's environment at
 * launch (see core/secrets.ts). This command is the one place a value ENTERS
 * the system, so it takes the value only from a hidden prompt or stdin — never
 * from a flag (shell history, process lists) — and it never prints one back.
 *
 *   secrets set <name>      hidden prompt (TTY) or stdin → keystore
 *   secrets delete <name>   remove the stored value
 *   secrets list            names, backend, presence — never values
 *   secrets check           backend availability + a write/read/delete self-test
 *
 * Connector resolution (first hit wins): --connector-id, --connector <path>,
 * agent-connector.config.* in --project / cwd, the single registered
 * connector; otherwise the command asks for --connector-id. `check` alone
 * falls back to the framework id when nothing resolves — the keystore can be
 * verified before any connector exists.
 */

import { parseArgs } from "node:util";

import {
  SecretError,
  isValidSecretName,
  openSecretStore,
  resolveSecretBackendId,
} from "../../core/secrets.js";
import type { SecretBackendId, SecretListEntry } from "../../core/secrets.js";
import {
  findConnectorConfig,
  listRegisteredConnectors,
  loadConnectorFromPath,
} from "../../core/load-connector.js";
import { fail, getActiveProgramName, print } from "../app.js";

/**
 * The four usage lines — the same text app.ts prints for `secrets --help`
 * (COMMAND_USAGE) and the docs quote; tests pin the two copies together.
 */
export const SECRETS_USAGE_LINES: readonly string[] = [
  "secrets set <name> [--connector <path>] [--connector-id <id>] [--backend keychain|secret-service|credential-manager|file] [--stdin]",
  "secrets delete <name> [--connector <path>] [--connector-id <id>]",
  "secrets list [--connector <path>] [--connector-id <id>] [--json]",
  "secrets check [--connector <path>] [--connector-id <id>] [--backend <backend>] [--json]",
];

const VERBS = ["set", "delete", "list", "check"] as const;
type Verb = (typeof VERBS)[number];

/** The optional flags each verb accepts; any other flag is a usage error. */
const VERB_FLAGS: Record<Verb, readonly ("backend" | "stdin" | "json")[]> = {
  set: ["backend", "stdin"],
  delete: [],
  list: ["json"],
  check: ["backend", "json"],
};

/** Connector id used by `check` when no connector resolves (keystore-only check). */
const CHECK_FALLBACK_CONNECTOR_ID = "agent-connector";

// Raw-mode key codes the hidden prompt reacts to.
const KEY_CTRL_C = "\u0003";
const KEY_CTRL_D = "\u0004";
const KEY_DELETE = "\u007f";

/** Value-input seam for tests and embedders; production uses the process streams. */
export interface SecretsIo {
  /** Where a non-interactive `set` reads the value from (default `process.stdin`). */
  stdin?: NodeJS.ReadableStream;
  /** Whether stdin is interactive (default `process.stdin.isTTY`). */
  isTTY?: boolean;
  /** Hidden-prompt override: label → value (default: a raw-mode TTY prompt). */
  prompt?: (label: string) => Promise<string>;
}

/** Thrown by the hidden prompt on Ctrl-C. */
class PromptAborted extends Error {
  constructor() {
    super("aborted");
    this.name = "PromptAborted";
  }
}

function isVerb(value: string): value is Verb {
  return (VERBS as readonly string[]).includes(value);
}

function usageLine(verb: Verb): string {
  return SECRETS_USAGE_LINES[VERBS.indexOf(verb)] as string;
}

/** Usage error: the verb's signature on stderr, then the branded message (exit 2). */
function usageError(verb: Verb, message: string): number {
  process.stderr.write(`usage: ${getActiveProgramName()} ${usageLine(verb)}\n`);
  return fail(message);
}

/** Operational failure (exit 1) with the keystore's hint, when it has one. */
function failWithHint(message: string, hint?: string): number {
  const code = fail(message, 1);
  if (hint) process.stderr.write(`  hint: ${hint}\n`);
  return code;
}

// ── Connector resolution ──────────────────────────────────────────────────

type ConnectorChoice =
  | { id: string }
  | {
      error: string;
      /** True when the user named a connector that failed to load (never fall back). */
      explicit: boolean;
    };

async function resolveConnectorId(
  connectorId: string | undefined,
  connectorPath: string | undefined,
  projectDir: string,
): Promise<ConnectorChoice> {
  if (connectorId !== undefined) return { id: connectorId };

  if (connectorPath !== undefined) {
    try {
      const { connector } = await loadConnectorFromPath(connectorPath);
      return { id: connector.id };
    } catch (err) {
      return {
        error: `cannot load connector "${connectorPath}": ${err instanceof Error ? err.message : String(err)}`,
        explicit: true,
      };
    }
  }

  const configPath = findConnectorConfig(projectDir);
  if (configPath) {
    try {
      const { connector } = await loadConnectorFromPath(configPath);
      return { id: connector.id };
    } catch {
      /* implicit discovery is a convenience — fall through to the registry */
    }
  }

  const registered = listRegisteredConnectors();
  const only = registered[0];
  if (registered.length === 1 && only) return { id: only.id };
  if (registered.length > 1) {
    return {
      error:
        `${registered.length} connectors are registered (${registered.map((c) => c.id).join(", ")}) — ` +
        "pass --connector-id <id> (or --connector <path>)",
      explicit: false,
    };
  }
  return {
    error:
      "no connector found — pass --connector-id <id> or --connector <path>, " +
      "or run inside a project with an agent-connector.config.* file",
    explicit: false,
  };
}

// ── Value input ───────────────────────────────────────────────────────────

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Strip exactly one trailing `\r?\n` — what `echo`/heredocs append; a second one is kept. */
function stripOneNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/**
 * Raw-mode hidden prompt on the controlling TTY: no echo, backspace edits,
 * Enter (or Ctrl-D) submits, Ctrl-C aborts. The label goes to stderr so
 * stdout stays clean for the confirmation line.
 */
function hiddenPrompt(label: string): Promise<string> {
  const stdin = process.stdin as NodeJS.ReadStream & {
    setRawMode?: (mode: boolean) => unknown;
    isRaw?: boolean;
  };
  return new Promise<string>((resolve, reject) => {
    process.stderr.write(`${label} `);
    const wasRaw = stdin.isRaw === true;
    const restoreMode = (): void => {
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(wasRaw);
    };
    // The terminal must not be left in raw mode when the process dies
    // mid-prompt: restore on exit, and on a signal restore then re-raise it.
    const SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGHUP", "SIGINT"];
    const onSignal = (signal: NodeJS.Signals): void => {
      restoreMode();
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    };
    process.once("exit", restoreMode);
    for (const signal of SIGNALS) process.on(signal, onSignal);
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const chars: string[] = [];
    const finish = (outcome: () => void): void => {
      stdin.removeListener("data", onData);
      process.removeListener("exit", restoreMode);
      for (const signal of SIGNALS) process.removeListener(signal, onSignal);
      restoreMode();
      stdin.pause();
      process.stderr.write("\n");
      outcome();
    };
    const onData = (chunk: string | Buffer): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const ch of text) {
        if (ch === KEY_CTRL_C) return finish(() => reject(new PromptAborted()));
        if (ch === "\r" || ch === "\n" || ch === KEY_CTRL_D) {
          return finish(() => resolve(chars.join("")));
        }
        if (ch === KEY_DELETE || ch === "\b") chars.pop();
        else chars.push(ch);
      }
    };
    stdin.on("data", onData);
  });
}

// ── Verbs ─────────────────────────────────────────────────────────────────

interface Flags {
  backend?: string;
  stdin: boolean;
  json: boolean;
}

async function runSet(connectorId: string, name: string, flags: Flags, io: SecretsIo): Promise<number> {
  // Resolve the backend BEFORE asking for the value so a typo in --backend
  // never costs the user a hidden-prompt round.
  const backend: SecretBackendId = resolveSecretBackendId(flags.backend);
  const interactive = !flags.stdin && (io.isTTY ?? process.stdin.isTTY === true);
  // A non-TTY stdin is read to EOF without --stdin being asked for; say so, or
  // an inherited pipe nobody closes looks like a hang.
  if (!interactive && !flags.stdin) process.stderr.write(`reading the value for ${name} from stdin (until EOF)\n`);
  const value = interactive
    ? await (io.prompt ?? hiddenPrompt)(`Enter value for ${name} (input hidden):`)
    : stripOneNewline(await readAll(io.stdin ?? process.stdin));
  if (value.length === 0) return fail(`no value given for "${name}" — nothing stored`, 1);
  const entry = openSecretStore({ connectorId, backend }).set(name, value);
  print(`stored "${name}" for connector ${connectorId} in ${entry.backend}`);
  return 0;
}

function runDelete(connectorId: string, name: string): number {
  const removed = openSecretStore({ connectorId }).delete(name);
  print(
    removed
      ? `deleted "${name}" for connector ${connectorId}`
      : `"${name}" is not set for connector ${connectorId} — nothing to delete`,
  );
  return 0;
}

function presenceLabel(present: boolean | null): string {
  return present === null ? "unknown" : present ? "yes" : "no";
}

function renderTable(entries: SecretListEntry[]): string {
  const header = ["name", "backend", "present", "updated"];
  const rows = entries.map((e) => [e.name, e.backend, presenceLabel(e.present), e.updatedAt]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] as number))).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

function runList(connectorId: string, json: boolean): number {
  const entries = openSecretStore({ connectorId }).list();
  if (json) {
    print(JSON.stringify(entries, null, 2));
    return 0;
  }
  if (entries.length === 0) {
    print(`no secrets recorded for connector ${connectorId} — run \`secrets set <name>\` to add one`);
    return 0;
  }
  print(renderTable(entries));
  return 0;
}

function runCheck(
  connectorId: string,
  connectorResolved: boolean,
  backendFlag: string | undefined,
  json: boolean,
): number {
  const backend: SecretBackendId = resolveSecretBackendId(backendFlag);
  const store = openSecretStore({ connectorId, backend });
  const availability = store.availability();
  const selfTest = availability.ok
    ? store.selfTest()
    : { ok: false, backend, reason: "not run — backend unavailable" };
  const ok = availability.ok && selfTest.ok;
  if (json) {
    print(JSON.stringify({ ok, connectorId, connectorResolved, backend, availability, selfTest }, null, 2));
    return ok ? 0 : 1;
  }
  print(
    `connector:  ${connectorResolved ? connectorId : `${connectorId} (no connector resolved — keystore check only)`}`,
  );
  print(`backend:    ${backend}`);
  print(`available:  ${availability.ok ? "yes" : `no — ${availability.reason ?? "unknown reason"}`}`);
  if (!availability.ok && availability.hint) print(`hint:       ${availability.hint}`);
  print(
    `self-test:  ${selfTest.ok ? "ok (write → read → delete round trip)" : `failed — ${selfTest.reason ?? "unknown reason"}`}`,
  );
  if (!selfTest.ok && selfTest.hint) print(`hint:       ${selfTest.hint}`);
  return ok ? 0 : 1;
}

// ── Entry point ───────────────────────────────────────────────────────────

export async function run(argv: string[], io: SecretsIo = {}): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      connector: { type: "string" },
      "connector-id": { type: "string" },
      backend: { type: "string" },
      project: { type: "string" },
      stdin: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const [verbRaw, name, ...extra] = positionals;
  if (verbRaw === undefined) {
    process.stderr.write(`usage: ${getActiveProgramName()} ${SECRETS_USAGE_LINES.join("\n  ")}\n`);
    return fail("secrets: missing subcommand (set | delete | list | check)");
  }
  if (!isVerb(verbRaw)) {
    return fail(`unknown secrets subcommand "${verbRaw}" (use ${VERBS.join("|")})`);
  }
  const verb = verbRaw;
  const flags: Flags = {
    ...(values.backend !== undefined ? { backend: values.backend } : {}),
    stdin: values.stdin ?? false,
    json: values.json ?? false,
  };
  for (const flag of ["backend", "stdin", "json"] as const) {
    const given = flag === "backend" ? flags.backend !== undefined : flags[flag];
    if (given && !VERB_FLAGS[verb].includes(flag)) {
      return usageError(verb, `--${flag} is not accepted by \`secrets ${verb}\``);
    }
  }

  const needsName = verb === "set" || verb === "delete";
  if (needsName && name === undefined) return usageError(verb, `secrets ${verb}: missing <name>`);
  if (!needsName && name !== undefined) {
    return usageError(verb, `secrets ${verb}: unexpected argument "${name}"`);
  }
  if (extra.length > 0) return usageError(verb, `secrets ${verb}: unexpected argument "${extra[0]}"`);
  if (needsName && !isValidSecretName(name as string)) {
    return fail(
      `"${name}" is not a valid secret name (1–64 of letters, digits, ".", "_", "-"; must start with a letter or digit)`,
      1,
    );
  }

  const choice = await resolveConnectorId(
    values["connector-id"],
    values.connector,
    values.project ?? process.cwd(),
  );
  let connectorId: string;
  let connectorResolved = true;
  if ("error" in choice) {
    if (verb !== "check" || choice.explicit) return fail(choice.error, 1);
    connectorId = CHECK_FALLBACK_CONNECTOR_ID;
    connectorResolved = false;
  } else {
    connectorId = choice.id;
  }

  try {
    switch (verb) {
      case "set":
        return await runSet(connectorId, name as string, flags, io);
      case "delete":
        return runDelete(connectorId, name as string);
      case "list":
        return runList(connectorId, flags.json);
      case "check":
        return runCheck(connectorId, connectorResolved, flags.backend, flags.json);
    }
  } catch (err) {
    if (err instanceof SecretError) return failWithHint(err.message, err.hint);
    if (err instanceof PromptAborted) return fail("aborted — nothing stored", 1);
    throw err;
  }
}
