/**
 * core/secrets — the local secret store behind `${secret:NAME}`.
 *
 * A connector references a secret by NAME in `server.env`
 * (`API_KEY: "${secret:api-key}"`). defineConnector moves such entries into
 * `server.secretEnv`, so no host config file ever carries the reference or the
 * value; the `serve` wrapper resolves the names against THIS store at launch
 * and injects the values into the real server's environment only.
 *
 * Storage is the operating system's own keystore, driven through its
 * first-party command-line tool (node stdlib only, no native modules):
 *   keychain            macOS  `/usr/bin/security`  (generic password items)
 *   secret-service      Linux  `secret-tool`        (libsecret / Secret Service)
 *   credential-manager  Windows `powershell.exe`    (advapi32 CredRead/Write/Delete)
 *   file                any    `<dataRoot>/secrets/file-store.json` — OPT-IN,
 *                              mode 0600, NOT encrypted; the headless/CI fallback.
 *
 * Every item is scoped to a connector: service `agent-connector/<connectorId>`,
 * account `<name>`. A names index (`<dataRoot>/secrets/<id>.index.json`) records
 * WHICH backend holds each name — names only, never values — so reads and
 * `secrets list` work without probing every backend.
 *
 * Secret values never appear in a process argument list: the keychain path
 * pipes a hex-encoded value through `security -i`, secret-tool reads stdin, and
 * the PowerShell path passes the value through the child's environment.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveEnvRefs } from "./interpolate.js";
import { isValidConnectorId } from "./ids.js";

import { dataRoot as resolveDataRoot } from "./paths.js";

// ── Names, references, placeholders ───────────────────────────────────────

/** A secret NAME: `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. */
export const SECRET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `${secret:NAME}` as written in a connector config (server.env values). */
export const SECRET_REF_RE = /\$\{secret:([A-Za-z0-9][A-Za-z0-9._-]*)\}/g;

/**
 * `{secret:NAME}` — the form the serve wrapper carries in host config
 * (`--secret-env NAME=<template>`). No `$`, so no host ever expands it
 * (Claude Code `${VAR}`, VS Code / Cursor `${env:VAR}`, cmd.exe `%VAR%`).
 */
export const SECRET_PLACEHOLDER_RE = /\{secret:([A-Za-z0-9][A-Za-z0-9._-]*)\}/g;

/** Upper bound on a stored value (chars). Windows caps the blob at 2560 bytes. */
export const SECRET_VALUE_MAX_CHARS = 8192;

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

export function hasSecretRef(input: string): boolean {
  return new RegExp(SECRET_REF_RE.source).test(input);
}

/** Names of every `${secret:NAME}` in a JSON-ish value — deduped, first-seen order. */
export function findSecretRefs(value: unknown): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(new RegExp(SECRET_REF_RE.source, "g"))) {
        const name = m[1] as string;
        if (!seen.has(name)) {
          seen.add(name);
          order.push(name);
        }
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return order;
}

/** Names of every `{secret:NAME}` placeholder in a wrapper template. */
export function findSecretPlaceholders(template: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const m of template.matchAll(new RegExp(SECRET_PLACEHOLDER_RE.source, "g"))) {
    const name = m[1] as string;
    if (!seen.has(name)) {
      seen.add(name);
      order.push(name);
    }
  }
  return order;
}

/** `${secret:X}` → `{secret:X}` (the wrapper-flag form). */
export function toWrapperTemplate(value: string): string {
  return value.replace(new RegExp(SECRET_REF_RE.source, "g"), (_m, name: string) => `{secret:${name}}`);
}

/**
 * Render a template by replacing each reference (`form: "ref"` = `${secret:X}`,
 * `form: "placeholder"` = `{secret:X}`) with `lookup(name)`. A name whose lookup
 * returns null/undefined/"" is left in place and reported through `onMissing`.
 * `transformLiteral` runs over the text BETWEEN references only, never over a
 * substituted value.
 */
export function renderSecretTemplate(
  template: string,
  lookup: (name: string) => string | null | undefined,
  form: "ref" | "placeholder",
  onMissing?: (name: string) => void,
  transformLiteral?: (text: string) => string,
): string {
  const re = new RegExp(form === "ref" ? SECRET_REF_RE.source : SECRET_PLACEHOLDER_RE.source, "g");
  const literal = (text: string): string => (transformLiteral ? transformLiteral(text) : text);
  let out = "";
  let last = 0;
  for (let m = re.exec(template); m !== null; m = re.exec(template)) {
    out += literal(template.slice(last, m.index));
    const name = m[1] as string;
    const v = lookup(name);
    // An empty value counts as unset: the store never writes one, and a
    // server must not start with an empty credential. Substituted text is
    // never rescanned, so a value may contain anything.
    if (v == null || v === "") {
      onMissing?.(name);
      out += m[0];
    } else {
      out += v;
    }
    last = m.index + m[0].length;
  }
  return out + literal(template.slice(last));
}

/** Parse one `--secret-env NAME=template` flag value. */
export function parseSecretEnvFlag(flag: string): { name: string; template: string } {
  const eq = flag.indexOf("=");
  if (eq <= 0) throw new SecretError("invalid-value", `--secret-env expects NAME=template, got "${flag}"`);
  const name = flag.slice(0, eq);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new SecretError("invalid-value", `--secret-env: "${name}" is not an environment variable name`);
  }
  return { name, template: flag.slice(eq + 1) };
}

/** The keystore service (namespace) every secret of a connector lives under. */
export function secretServiceName(connectorId: string): string {
  return `agent-connector/${connectorId}`;
}

// ── Errors ────────────────────────────────────────────────────────────────

export type SecretErrorCode =
  | "invalid-name"
  | "invalid-value"
  | "backend-unavailable"
  | "backend-failed"
  | "unsupported-platform";

export class SecretError extends Error {
  readonly code: SecretErrorCode;
  readonly hint?: string;
  constructor(code: SecretErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "SecretError";
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

/** Thrown when a connector's referenced secrets are not all set. */
export class SecretResolutionError extends Error {
  readonly connectorId: string;
  readonly missing: string[];
  constructor(connectorId: string, missing: string[], detail?: string) {
    const list = missing.join(", ");
    super(
      `connector "${connectorId}": ${missing.length} secret${missing.length === 1 ? "" : "s"} not set: ${list}. ` +
        `Run \`secrets set <name> --connector-id ${connectorId}\` for each` +
        (detail ? ` (${detail})` : "") +
        ".",
    );
    this.name = "SecretResolutionError";
    this.connectorId = connectorId;
    this.missing = missing;
  }
}

// ── Backends ──────────────────────────────────────────────────────────────

export type SecretBackendId = "keychain" | "secret-service" | "credential-manager" | "file";

export const SECRET_BACKEND_IDS: readonly SecretBackendId[] = [
  "keychain",
  "secret-service",
  "credential-manager",
  "file",
];

/** Env var that picks the backend `set` writes to (`auto` = the OS keystore). */
export const SECRETS_BACKEND_ENV = "AGENT_CONNECTOR_SECRETS_BACKEND";

export interface BackendAvailability {
  ok: boolean;
  reason?: string;
  hint?: string;
}

export interface SecretBackend {
  readonly id: SecretBackendId;
  readonly label: string;
  availability(): BackendAvailability;
  get(service: string, account: string): string | null;
  set(service: string, account: string, value: string): void;
  delete(service: string, account: string): boolean;
}

/** Result shape of the subprocess seam (spawnSync-compatible, injectable in tests). */
export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut?: boolean;
}

export type ExecFn = (
  file: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
) => ExecResult;

export interface SecretBackendOptions {
  /** Framework data-root (file backend + index). Defaults to paths.dataRoot(). */
  dataRoot?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Subprocess seam (tests). Defaults to spawnSync. */
  exec?: ExecFn;
  /**
   * TEST SEAM (keychain only): operate on this keychain file instead of the
   * default keychain, so the round trip can be proven against a throwaway
   * keychain with a known password. Must not contain whitespace.
   */
  keychainPath?: string;
}

const EXEC_TIMEOUT_MS = 20_000;

// The keystore CLIs run from their system locations when those exist, so a
// writable directory earlier on PATH cannot substitute a binary that would
// receive the value.
const SECURITY_BIN = "/usr/bin/security";
const SECRET_TOOL_BIN = "/usr/bin/secret-tool";
/** `secret-tool store` reads its stdin into a fixed 8192-byte buffer. */
const SECRET_TOOL_MAX_BYTES = 8192;

function secretToolBin(): string {
  return existsSync(SECRET_TOOL_BIN) ? SECRET_TOOL_BIN : "secret-tool";
}

/** Windows PowerShell under %SystemRoot%; PATH lookup only when that host is absent. */
function powershellBin(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.windir;
  if (root) {
    const candidate = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "powershell.exe";
}

const defaultExec: ExecFn = (file, args, opts) => {
  const r = spawnSync(file, args, {
    input: opts.input ?? "",
    env: opts.env ?? process.env,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    windowsHide: true,
  });
  const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  return {
    status: r.status,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
    ...(r.error ? { error: r.error } : {}),
    timedOut,
  };
};

const FILE_BACKEND_HINT = `set ${SECRETS_BACKEND_ENV}=file to use the plaintext file store (mode 0600, not encrypted)`;

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? "";
}

function failure(backend: string, verb: string, r: ExecResult): SecretError {
  if (r.timedOut) {
    return new SecretError(
      "backend-failed",
      `${backend}: ${verb} timed out after ${EXEC_TIMEOUT_MS / 1000}s — the keystore is probably waiting for an interactive prompt`,
      "run the command from a GUI session once so the keystore can ask for access, or " + FILE_BACKEND_HINT,
    );
  }
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    return new SecretError("backend-unavailable", `${backend}: its command-line tool is not installed`, FILE_BACKEND_HINT);
  }
  const detail = firstLine(r.stderr) || firstLine(r.stdout) || (r.error ? r.error.message : `exit ${r.status}`);
  return new SecretError("backend-failed", `${backend}: ${verb} failed: ${detail}`);
}

// ── keychain (macOS) ──────────────────────────────────────────────────────

/** `find-generic-password -g` prints the value on stderr as `password: 0x<HEX>  "…"` or `password: "<text>"`. */
export function parseKeychainPasswordLine(stderr: string): string | null {
  const line = stderr.split(/\r?\n/).find((l) => l.startsWith("password:"));
  if (line === undefined) return null;
  const hex = line.match(/^password:\s*0x([0-9A-Fa-f]*)/);
  if (hex) return Buffer.from(hex[1] ?? "", "hex").toString("utf8");
  const first = line.indexOf('"');
  const last = line.lastIndexOf('"');
  if (first < 0 || last <= first) return "";
  return line.slice(first + 1, last);
}

function keychainBackend(opts: SecretBackendOptions): SecretBackend {
  const exec = opts.exec ?? defaultExec;
  const platform = opts.platform ?? process.platform;
  // The path is spliced into a `security -i` command line, which tokenizes on
  // whitespace and quotes.
  if (opts.keychainPath !== undefined && /[\s"'\\]/.test(opts.keychainPath)) {
    throw new SecretError("invalid-value", "keychainPath must not contain whitespace, quotes or backslashes");
  }
  const extra = opts.keychainPath ? [opts.keychainPath] : [];
  const lockedHint =
    "the login keychain is locked or this is not a GUI session — open Keychain Access (or log in on the desktop) and retry, or " +
    FILE_BACKEND_HINT;
  const LOCKED = /passphrase you entered is not correct|User interaction is not allowed|-25308|-25293/;
  return {
    id: "keychain",
    label: "macOS Keychain (security)",
    availability() {
      if (platform !== "darwin") return { ok: false, reason: "macOS only" };
      if (!existsSync(SECURITY_BIN)) return { ok: false, reason: `${SECURITY_BIN} not found` };
      return { ok: true };
    },
    get(service, account) {
      const r = exec(SECURITY_BIN, ["find-generic-password", "-a", account, "-s", service, "-g", ...extra], {
        timeoutMs: EXEC_TIMEOUT_MS,
      });
      if (r.status === 0) return parseKeychainPasswordLine(r.stderr);
      if (r.status === 44 || /could not be found/.test(r.stderr)) return null;
      const err = failure("keychain", "read", r);
      if (LOCKED.test(r.stderr)) throw new SecretError("backend-failed", err.message, lockedHint);
      throw err;
    },
    set(service, account, value) {
      const hex = Buffer.from(value, "utf8").toString("hex");
      // Interactive mode: the item data travels on stdin as hex, never in argv.
      const line = [
        "add-generic-password",
        "-a",
        account,
        "-s",
        service,
        "-l",
        `${service}/${account}`,
        "-X",
        hex,
        "-U",
        ...extra,
      ].join(" ");
      const r = exec(SECURITY_BIN, ["-i"], { input: `${line}\n`, timeoutMs: EXEC_TIMEOUT_MS });
      if (r.status === 0 && !/returned -?\d+/.test(r.stderr)) return;
      const err = failure("keychain", "write", r);
      if (LOCKED.test(r.stderr)) throw new SecretError("backend-failed", err.message, lockedHint);
      throw err;
    },
    delete(service, account) {
      const r = exec(SECURITY_BIN, ["delete-generic-password", "-a", account, "-s", service, ...extra], {
        timeoutMs: EXEC_TIMEOUT_MS,
      });
      if (r.status === 0) return true;
      if (r.status === 44 || /could not be found/.test(r.stderr)) return false;
      throw failure("keychain", "delete", r);
    },
  };
}

// ── secret-service (Linux, libsecret) ─────────────────────────────────────

function secretServiceBackend(opts: SecretBackendOptions): SecretBackend {
  const exec = opts.exec ?? defaultExec;
  const bin = secretToolBin();
  const platform = opts.platform ?? process.platform;
  const DBUS = /dbus|D-Bus|Cannot autolaunch|org\.freedesktop\.secrets|No such interface/i;
  const unavailable = (detail: string) =>
    new SecretError(
      "backend-unavailable",
      `secret-service: no Secret Service (gnome-keyring / KDE Wallet) is reachable: ${detail}`,
      "start a keyring daemon with a D-Bus session, or " + FILE_BACKEND_HINT,
    );
  return {
    id: "secret-service",
    label: "Secret Service (secret-tool)",
    availability() {
      if (platform !== "linux") return { ok: false, reason: "Linux only" };
      const r = exec(bin, ["--help"], { timeoutMs: EXEC_TIMEOUT_MS });
      if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: false, reason: "secret-tool is not installed (libsecret-tools)", hint: FILE_BACKEND_HINT };
      }
      return { ok: true };
    },
    get(service, account) {
      const r = exec(bin, ["lookup", "service", service, "account", account], {
        timeoutMs: EXEC_TIMEOUT_MS,
      });
      if (r.status === 0) return r.stdout;
      if (r.error) throw failure("secret-service", "read", r);
      if (DBUS.test(r.stderr)) throw unavailable(firstLine(r.stderr));
      // `lookup` exits 1 with no output when nothing matches.
      if (r.stderr.trim() === "") return null;
      throw failure("secret-service", "read", r);
    },
    set(service, account, value) {
      // secret-tool reads stdin to EOF but keeps at most 8192 bytes.
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes > SECRET_TOOL_MAX_BYTES) {
        throw new SecretError(
          "invalid-value",
          `secret-tool stores at most ${SECRET_TOOL_MAX_BYTES} bytes; this value is ${bytes} bytes`,
        );
      }
      const r = exec(
        bin,
        ["store", `--label=${service}/${account}`, "service", service, "account", account],
        { input: value, timeoutMs: EXEC_TIMEOUT_MS },
      );
      if (r.status === 0) return;
      if (!r.error && DBUS.test(r.stderr)) throw unavailable(firstLine(r.stderr));
      throw failure("secret-service", "write", r);
    },
    delete(service, account) {
      // `clear` exits 0 whether or not anything matched, so probe first.
      const before = this.get(service, account);
      if (before === null) return false;
      const r = exec(bin, ["clear", "service", service, "account", account], {
        timeoutMs: EXEC_TIMEOUT_MS,
      });
      if (r.status === 0) return true;
      throw failure("secret-service", "delete", r);
    },
  };
}

// ── credential-manager (Windows) ──────────────────────────────────────────

/**
 * The PowerShell program (Windows PowerShell 5.1 compatible, C# 5 syntax) that
 * drives the Credential Manager through advapi32. Operation and data come from
 * the child's environment; a read prints the value to stdout as UTF-8.
 * Exit codes: 0 ok, 3 not found, 1 error (message on stderr).
 */
export const CREDENTIAL_MANAGER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
if (-not ('ACCred' -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ACCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr buffer);
  const uint GENERIC = 1; const uint PERSIST_LOCAL_MACHINE = 2; const int NOT_FOUND = 1168;
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, GENERIC, 0, out p)) {
      int e = Marshal.GetLastWin32Error();
      if (e == NOT_FOUND) return null;
      throw new System.ComponentModel.Win32Exception(e);
    }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      if (c.CredentialBlobSize == 0) return "";
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return Encoding.Unicode.GetString(b);
    } finally { CredFree(p); }
  }
  public static void Write(string target, string user, string value) {
    byte[] b = Encoding.Unicode.GetBytes(value);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = GENERIC; c.TargetName = target; c.UserName = user; c.Persist = PERSIST_LOCAL_MACHINE;
    c.CredentialBlobSize = (uint)b.Length; c.CredentialBlob = Marshal.AllocHGlobal(b.Length);
    try {
      Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
      if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static bool Delete(string target) {
    if (CredDeleteW(target, GENERIC, 0)) return true;
    int e = Marshal.GetLastWin32Error();
    if (e == NOT_FOUND) return false;
    throw new System.ComponentModel.Win32Exception(e);
  }
}
"@
}
$op = $env:AC_SECRET_OP
$target = $env:AC_SECRET_TARGET
switch ($op) {
  'get' {
    $v = [ACCred]::Read($target)
    if ($null -eq $v) { exit 3 }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($v)
    $out = [Console]::OpenStandardOutput()
    $out.Write($bytes, 0, $bytes.Length)
    $out.Flush()
    exit 0
  }
  'set' {
    [ACCred]::Write($target, $env:AC_SECRET_USER, $env:AC_SECRET_VALUE)
    exit 0
  }
  'delete' {
    if ([ACCred]::Delete($target)) { exit 0 } else { exit 3 }
  }
  'probe' { exit 0 }
  default { [Console]::Error.WriteLine("unknown op"); exit 1 }
}
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

function credentialManagerBackend(opts: SecretBackendOptions): SecretBackend {
  const exec = opts.exec ?? defaultExec;
  const platform = opts.platform ?? process.platform;
  const baseEnv = opts.env ?? process.env;
  const encoded = Buffer.from(CREDENTIAL_MANAGER_SCRIPT, "utf16le").toString("base64");
  const bin = powershellBin(baseEnv);
  const run = (op: "get" | "set" | "delete" | "probe", target: string, user = "", value = "") =>
    exec(
      bin,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      {
        env: {
          ...baseEnv,
          AC_SECRET_OP: op,
          AC_SECRET_TARGET: target,
          AC_SECRET_USER: user,
          AC_SECRET_VALUE: value,
        },
        timeoutMs: EXEC_TIMEOUT_MS,
      },
    );
  const target = (service: string, account: string) => `${service}/${account}`;
  return {
    id: "credential-manager",
    label: "Windows Credential Manager (powershell)",
    availability() {
      if (platform !== "win32") return { ok: false, reason: "Windows only" };
      const r = run("probe", "agent-connector/probe");
      if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: false, reason: "powershell.exe not found", hint: FILE_BACKEND_HINT };
      }
      if (r.status !== 0) return { ok: false, reason: firstLine(r.stderr) || `powershell exited ${r.status}` };
      return { ok: true };
    },
    get(service, account) {
      const r = run("get", target(service, account));
      if (r.status === 0) return r.stdout;
      if (r.status === 3) return null;
      throw failure("credential-manager", "read", r);
    },
    set(service, account, value) {
      if (Buffer.byteLength(value, "utf16le") > 2560) {
        throw new SecretError(
          "invalid-value",
          "credential-manager: Windows caps a credential blob at 2560 bytes (1280 UTF-16 characters)",
        );
      }
      const r = run("set", target(service, account), account, value);
      if (r.status === 0) return;
      throw failure("credential-manager", "write", r);
    },
    delete(service, account) {
      const r = run("delete", target(service, account));
      if (r.status === 0) return true;
      if (r.status === 3) return false;
      throw failure("credential-manager", "delete", r);
    },
  };
}

// ── file (opt-in, plaintext) ──────────────────────────────────────────────

interface FileStoreShape {
  version: 1;
  /** service → account → value. */
  items: Record<string, Record<string, string>>;
}

/** Parse a JSON file; null when absent; SecretError when unreadable or not JSON. */
export function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    throw new SecretError("backend-failed", `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** Write `data` as JSON atomically (tmp + rename) with a 0700 directory and a 0600 file. */
export function writePrivateJson(path: string, data: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows: mode bits are advisory */
  }
  renameSync(tmp, path);
}

export function fileStorePath(dataRoot: string): string {
  return join(dataRoot, "secrets", "file-store.json");
}

function fileBackend(opts: SecretBackendOptions): SecretBackend {
  const root = opts.dataRoot ?? resolveDataRoot();
  const path = fileStorePath(root);
  const load = (): FileStoreShape => readJsonFile<FileStoreShape>(path) ?? { version: 1, items: {} };
  return {
    id: "file",
    label: `plaintext file (${path})`,
    availability() {
      return { ok: true, reason: "NOT encrypted — file mode 0600 is the only protection" };
    },
    get(service, account) {
      const v = load().items[service]?.[account];
      return typeof v === "string" ? v : null;
    },
    set(service, account, value) {
      const store = load();
      (store.items[service] ??= {})[account] = value;
      writePrivateJson(path, store);
    },
    delete(service, account) {
      const store = load();
      const bucket = store.items[service];
      if (!bucket || !(account in bucket)) return false;
      delete bucket[account];
      if (Object.keys(bucket).length === 0) delete store.items[service];
      writePrivateJson(path, store);
      return true;
    },
  };
}

export function createSecretBackend(id: SecretBackendId, opts: SecretBackendOptions = {}): SecretBackend {
  switch (id) {
    case "keychain":
      return keychainBackend(opts);
    case "secret-service":
      return secretServiceBackend(opts);
    case "credential-manager":
      return credentialManagerBackend(opts);
    case "file":
      return fileBackend(opts);
    default: {
      const never: never = id;
      throw new SecretError("backend-unavailable", `unknown secrets backend "${String(never)}"`);
    }
  }
}

/** The OS keystore backend for a platform, or null where none is wired. */
export function nativeSecretBackendId(platform: NodeJS.Platform = process.platform): SecretBackendId | null {
  if (platform === "darwin") return "keychain";
  if (platform === "linux") return "secret-service";
  if (platform === "win32") return "credential-manager";
  return null;
}

export function isSecretBackendId(value: unknown): value is SecretBackendId {
  return typeof value === "string" && (SECRET_BACKEND_IDS as readonly string[]).includes(value);
}

/**
 * Which backend `set` writes to: an explicit choice, else
 * `$AGENT_CONNECTOR_SECRETS_BACKEND` (`auto` = native), else the OS keystore.
 * Throws on an unknown id or on a platform with no native keystore.
 */
export function resolveSecretBackendId(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SecretBackendId {
  const pick = (raw: string, source: string): SecretBackendId | null => {
    if (raw === "auto") return null;
    if (isSecretBackendId(raw)) return raw;
    throw new SecretError(
      "backend-unavailable",
      `${source}: unknown secrets backend "${raw}" (expected ${SECRET_BACKEND_IDS.join(" | ")} | auto)`,
    );
  };
  if (explicit !== undefined && explicit !== "") {
    const chosen = pick(explicit, "--backend");
    if (chosen) return chosen;
  }
  const fromEnv = env[SECRETS_BACKEND_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const chosen = pick(fromEnv.trim(), SECRETS_BACKEND_ENV);
    if (chosen) return chosen;
  }
  const native = nativeSecretBackendId(platform);
  if (native) return native;
  throw new SecretError(
    "unsupported-platform",
    `no OS keystore backend is wired for platform "${platform}"`,
    FILE_BACKEND_HINT,
  );
}

// ── Names index (names only — never values) ───────────────────────────────

interface IndexEntry {
  backend: SecretBackendId;
  updatedAt: string;
}

interface IndexFile {
  version: 1;
  connectorId: string;
  entries: Record<string, IndexEntry>;
}

export function secretIndexPath(dataRoot: string, connectorId: string): string {
  return join(dataRoot, "secrets", `${connectorId}.index.json`);
}

function loadIndex(dataRoot: string, connectorId: string): IndexFile {
  const path = secretIndexPath(dataRoot, connectorId);
  const raw = readJsonFile<Partial<IndexFile>>(path);
  const entries: Record<string, IndexEntry> = {};
  for (const [name, e] of Object.entries(raw?.entries ?? {})) {
    if (e && typeof e === "object" && isSecretBackendId((e as IndexEntry).backend)) {
      entries[name] = { backend: (e as IndexEntry).backend, updatedAt: String((e as IndexEntry).updatedAt ?? "") };
    }
  }
  return { version: 1, connectorId, entries };
}

function saveIndex(dataRoot: string, index: IndexFile): void {
  writePrivateJson(secretIndexPath(dataRoot, index.connectorId), index);
}

// ── Store ─────────────────────────────────────────────────────────────────

export interface SecretEntry {
  name: string;
  backend: SecretBackendId;
  /** ISO timestamp of the last `set`. */
  updatedAt: string;
}

export interface SecretListEntry extends SecretEntry {
  /** Whether the backend currently holds the value; null when the backend is unavailable. */
  present: boolean | null;
}

export interface SecretStore {
  readonly connectorId: string;
  /** The backend `set` writes to (see {@link resolveSecretBackendId}). */
  readonly backend: SecretBackendId;
  /** Value of `name`, or null when not set. Reads the backend the index recorded, else the default. */
  get(name: string): string | null;
  has(name: string): boolean;
  set(name: string, value: string, opts?: { backend?: SecretBackendId }): SecretEntry;
  /** True when a value was removed (from the backend or the index). */
  delete(name: string): boolean;
  /** Every name this store has recorded (values are never returned). */
  list(): SecretListEntry[];
  availability(backend?: SecretBackendId): BackendAvailability;
  /** Write → read → delete a throwaway item; proves the backend works on this box. */
  selfTest(backend?: SecretBackendId): { ok: boolean; backend: SecretBackendId; reason?: string; hint?: string };
}

export interface OpenSecretStoreOptions extends SecretBackendOptions {
  connectorId: string;
  /** Backend `set` writes to. Default: `$AGENT_CONNECTOR_SECRETS_BACKEND`, else the OS keystore. */
  backend?: SecretBackendId | "auto";
}

function assertName(name: string): void {
  if (!isValidSecretName(name)) {
    throw new SecretError(
      "invalid-name",
      `"${name}" is not a valid secret name (expected ${SECRET_NAME_RE.source})`,
    );
  }
}

/** `set` never stores an empty value, so an empty item read back counts as unset. */
function nonEmpty(value: string | null): string | null {
  return value === "" ? null : value;
}

function assertConnectorId(id: string): void {
  if (!isValidConnectorId(id)) {
    throw new SecretError("invalid-name", `"${String(id)}" is not a valid connector id`);
  }
}

export function openSecretStore(options: OpenSecretStoreOptions): SecretStore {
  const { connectorId } = options;
  assertConnectorId(connectorId);
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const root = options.dataRoot ?? resolveDataRoot();
  const backendOpts: SecretBackendOptions = { ...options, dataRoot: root, env, platform };
  const defaultBackend = resolveSecretBackendId(
    options.backend === "auto" ? undefined : options.backend,
    env,
    platform,
  );
  const service = secretServiceName(connectorId);
  const backends = new Map<SecretBackendId, SecretBackend>();
  const backend = (id: SecretBackendId): SecretBackend => {
    let b = backends.get(id);
    if (!b) {
      b = createSecretBackend(id, backendOpts);
      backends.set(id, b);
    }
    return b;
  };
  const ensureAvailable = (id: SecretBackendId): SecretBackend => {
    const b = backend(id);
    const a = b.availability();
    if (!a.ok) throw new SecretError("backend-unavailable", `${b.label}: ${a.reason ?? "unavailable"}`, a.hint ?? FILE_BACKEND_HINT);
    return b;
  };
  const backendFor = (name: string): SecretBackendId => loadIndex(root, connectorId).entries[name]?.backend ?? defaultBackend;

  const store: SecretStore = {
    connectorId,
    backend: defaultBackend,
    get(name) {
      assertName(name);
      return nonEmpty(ensureAvailable(backendFor(name)).get(service, name));
    },
    has(name) {
      return store.get(name) !== null;
    },
    set(name, value, opts = {}) {
      assertName(name);
      if (typeof value !== "string" || value === "") {
        throw new SecretError("invalid-value", "a secret value must be a non-empty string");
      }
      if (value.length > SECRET_VALUE_MAX_CHARS) {
        throw new SecretError("invalid-value", `a secret value must be at most ${SECRET_VALUE_MAX_CHARS} characters`);
      }
      const target = opts.backend ?? defaultBackend;
      ensureAvailable(target).set(service, name, value);
      const index = loadIndex(root, connectorId);
      const previous = index.entries[name];
      // Moving a name to another backend: drop the old copy so one value exists.
      if (previous && previous.backend !== target) {
        try {
          backend(previous.backend).delete(service, name);
        } catch {
          /* the stale copy is reported by list() as present under the old backend */
        }
      }
      const entry: IndexEntry = { backend: target, updatedAt: new Date().toISOString() };
      index.entries[name] = entry;
      saveIndex(root, index);
      return { name, ...entry };
    },
    delete(name) {
      assertName(name);
      const index = loadIndex(root, connectorId);
      const recorded = index.entries[name];
      const removed = ensureAvailable(recorded?.backend ?? defaultBackend).delete(service, name);
      if (recorded) {
        delete index.entries[name];
        saveIndex(root, index);
      }
      return removed || recorded !== undefined;
    },
    list() {
      const index = loadIndex(root, connectorId);
      return Object.entries(index.entries)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, e]) => {
          let present: boolean | null;
          try {
            present = backend(e.backend).availability().ok ? nonEmpty(backend(e.backend).get(service, name)) !== null : null;
          } catch {
            present = null;
          }
          return { name, backend: e.backend, updatedAt: e.updatedAt, present };
        });
    },
    availability(id = defaultBackend) {
      return backend(id).availability();
    },
    selfTest(id = defaultBackend) {
      const b = backend(id);
      const a = b.availability();
      if (!a.ok) return { ok: false, backend: id, reason: a.reason ?? "unavailable", ...(a.hint ? { hint: a.hint } : {}) };
      const probeName = `ac-selftest-${process.pid}-${Date.now().toString(36)}`;
      const probeValue = `ok-${probeName}`;
      try {
        b.set(service, probeName, probeValue);
        const back = b.get(service, probeName);
        b.delete(service, probeName);
        if (back !== probeValue) {
          return { ok: false, backend: id, reason: `round trip returned ${back === null ? "nothing" : "a different value"}` };
        }
        return { ok: true, backend: id };
      } catch (err) {
        const e = err instanceof SecretError ? err : new SecretError("backend-failed", err instanceof Error ? err.message : String(err));
        return { ok: false, backend: id, reason: e.message, ...(e.hint ? { hint: e.hint } : {}) };
      }
    },
  };
  return store;
}

// ── Resolution (serve wrapper / probe) ────────────────────────────────────

export interface ResolveSecretEnvOptions extends SecretBackendOptions {
  /** `"placeholder"` for wrapper templates (`{secret:X}`), `"ref"` for config values (`${secret:X}`). */
  form?: "ref" | "placeholder";
  /**
   * Expand `${env:VAR}` / `${env:VAR:-default}` in the template text around
   * the secret references against this environment (an unset variable
   * without a default becomes ""). Secret values themselves are never
   * expanded. Omit to leave the references verbatim.
   */
  expandEnv?: NodeJS.ProcessEnv;
}

/**
 * Turn a connector's `secretEnv` templates into concrete env values. Every
 * referenced name must be set; otherwise a {@link SecretResolutionError} lists
 * the missing names (the server is never launched with an empty secret).
 */
export function resolveSecretEnv(
  connectorId: string,
  secretEnv: Record<string, string>,
  options: ResolveSecretEnvOptions = {},
): Record<string, string> {
  const entries = Object.entries(secretEnv);
  if (entries.length === 0) return {};
  const form = options.form ?? "ref";
  const store = openSecretStore({ connectorId, ...options });
  const cache = new Map<string, string | null>();
  const missing = new Set<string>();
  let backendProblem: string | undefined;
  const lookup = (name: string): string | null => {
    if (cache.has(name)) return cache.get(name) ?? null;
    let v: string | null = null;
    // After one backend failure the remaining names are reported unset
    // without another subprocess round (a locked keychain would otherwise
    // cost the timeout once per name and outlive the host's launch timeout).
    if (backendProblem === undefined) {
      try {
        v = store.get(name);
      } catch (err) {
        backendProblem = err instanceof Error ? err.message : String(err);
      }
    }
    cache.set(name, v);
    return v;
  };
  const expand = options.expandEnv;
  const literal = expand ? (text: string) => resolveEnvRefs(text, expand) : undefined;
  const out: Record<string, string> = {};
  for (const [key, template] of entries) {
    out[key] = renderSecretTemplate(template, lookup, form, (name) => missing.add(name), literal);
  }
  if (missing.size > 0) throw new SecretResolutionError(connectorId, [...missing], backendProblem);
  return out;
}
