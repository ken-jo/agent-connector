/**
 * core/secrets — the store behind `${secret:NAME}`.
 *
 * Hermetic parts: reference/placeholder parsing, the names index, the opt-in
 * file backend (0600), backend selection, resolution errors, and every OS
 * backend driven through the injectable exec seam (argv/stdin/env contracts —
 * a value must never appear in argv).
 *
 * Live part: the macOS keychain backend against a THROWAWAY keychain created
 * with a known password (`security create-keychain`), so the real `security`
 * round trip is proven without touching the login keychain. Skipped off macOS
 * and when `security` cannot create a keychain in this session.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CREDENTIAL_MANAGER_SCRIPT,
  SECRETS_BACKEND_ENV,
  SecretError,
  SecretResolutionError,
  createSecretBackend,
  fileStorePath,
  findSecretPlaceholders,
  findSecretRefs,
  hasSecretRef,
  isValidSecretName,
  openSecretStore,
  parseKeychainPasswordLine,
  parseSecretEnvFlag,
  renderSecretTemplate,
  resolveSecretBackendId,
  resolveSecretEnv,
  secretIndexPath,
  secretServiceName,
  toWrapperTemplate,
  type ExecFn,
  type ExecResult,
} from "../../src/core/secrets.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ac-secrets-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const NO_ENV: NodeJS.ProcessEnv = {};

describe("references and placeholders", () => {
  it("validates names", () => {
    expect(isValidSecretName("api-key")).toBe(true);
    expect(isValidSecretName("db.pass_1")).toBe(true);
    expect(isValidSecretName("-bad")).toBe(false);
    expect(isValidSecretName("has space")).toBe(false);
    expect(isValidSecretName("a".repeat(65))).toBe(false);
  });

  it("finds ${secret:NAME} refs in nested values, deduped in first-seen order", () => {
    const v = {
      env: { A: "${secret:api-key}", DSN: "pg://u:${secret:db-pass}@h/${secret:api-key}" },
      args: ["${secret:tok}"],
    };
    expect(findSecretRefs(v)).toEqual(["api-key", "db-pass", "tok"]);
    expect(hasSecretRef("x ${secret:a} y")).toBe(true);
    expect(hasSecretRef("${env:A}")).toBe(false);
    expect(hasSecretRef("{secret:a}")).toBe(false);
  });

  it("rewrites refs to the wrapper placeholder form and back", () => {
    const t = toWrapperTemplate("pg://u:${secret:db-pass}@h?k=${secret:api-key}");
    expect(t).toBe("pg://u:{secret:db-pass}@h?k={secret:api-key}");
    expect(findSecretPlaceholders(t)).toEqual(["db-pass", "api-key"]);
    const lookup = (n: string) => ({ "db-pass": "p w", "api-key": "K" })[n] ?? null;
    expect(renderSecretTemplate(t, lookup, "placeholder")).toBe("pg://u:p w@h?k=K");
    expect(renderSecretTemplate("x=${secret:api-key}", lookup, "ref")).toBe("x=K");
  });

  it("reports missing names and leaves their reference in place", () => {
    const missing: string[] = [];
    const out = renderSecretTemplate("{secret:a}-{secret:b}", (n) => (n === "a" ? "1" : null), "placeholder", (n) =>
      missing.push(n),
    );
    expect(out).toBe("1-{secret:b}");
    expect(missing).toEqual(["b"]);
  });

  it("never rescans a substituted value", () => {
    const lookup = (n: string) => (n === "x" ? "{secret:y}${secret:y}" : "Y");
    expect(renderSecretTemplate("a {secret:x} b", lookup, "placeholder")).toBe("a {secret:y}${secret:y} b");
    expect(renderSecretTemplate("a ${secret:x} b", lookup, "ref")).toBe("a {secret:y}${secret:y} b");
    expect(renderSecretTemplate("{secret:x}", () => "", "placeholder", (n) => expect(n).toBe("x"))).toBe("{secret:x}");
  });

  it("parses --secret-env NAME=template", () => {
    expect(parseSecretEnvFlag("DSN=pg://{secret:p}@h=1")).toEqual({ name: "DSN", template: "pg://{secret:p}@h=1" });
    expect(() => parseSecretEnvFlag("=x")).toThrow(SecretError);
    expect(() => parseSecretEnvFlag("BAD-NAME=x")).toThrow(SecretError);
  });

  it("namespaces the keystore service per connector", () => {
    expect(secretServiceName("acme-db")).toBe("agent-connector/acme-db");
  });
});

describe("backend selection", () => {
  it("explicit > env > native, and rejects unknown ids", () => {
    expect(resolveSecretBackendId(undefined, NO_ENV, "darwin")).toBe("keychain");
    expect(resolveSecretBackendId(undefined, NO_ENV, "linux")).toBe("secret-service");
    expect(resolveSecretBackendId(undefined, NO_ENV, "win32")).toBe("credential-manager");
    expect(resolveSecretBackendId(undefined, { [SECRETS_BACKEND_ENV]: "file" }, "darwin")).toBe("file");
    expect(resolveSecretBackendId(undefined, { [SECRETS_BACKEND_ENV]: "auto" }, "darwin")).toBe("keychain");
    expect(resolveSecretBackendId("file", { [SECRETS_BACKEND_ENV]: "keychain" }, "linux")).toBe("file");
    expect(() => resolveSecretBackendId("vault", NO_ENV, "darwin")).toThrow(/unknown secrets backend/);
    expect(() => resolveSecretBackendId(undefined, NO_ENV, "freebsd")).toThrow(SecretError);
  });
});

describe("file backend + names index (opt-in, plaintext, 0600)", () => {
  it("round-trips, records names (never values) in the index, and deletes", () => {
    const store = openSecretStore({ connectorId: "acme-db", backend: "file", dataRoot: tmp, env: NO_ENV, platform: "linux" });
    expect(store.backend).toBe("file");
    expect(store.get("api-key")).toBeNull();
    expect(store.has("api-key")).toBe(false);

    const entry = store.set("api-key", "s3cr3t-value");
    expect(entry).toMatchObject({ name: "api-key", backend: "file" });
    expect(store.get("api-key")).toBe("s3cr3t-value");
    expect(store.has("api-key")).toBe(true);

    const indexText = readFileSync(secretIndexPath(tmp, "acme-db"), "utf8");
    expect(indexText).toContain('"api-key"');
    expect(indexText).not.toContain("s3cr3t-value");
    expect(store.list()).toEqual([{ name: "api-key", backend: "file", updatedAt: entry.updatedAt, present: true }]);

    if (process.platform !== "win32") {
      expect(statSync(fileStorePath(tmp)).mode & 0o777).toBe(0o600);
      expect(statSync(join(tmp, "secrets")).mode & 0o777).toBe(0o700);
    }

    expect(store.delete("api-key")).toBe(true);
    expect(store.delete("api-key")).toBe(false);
    expect(store.get("api-key")).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it("scopes values per connector and validates names and values", () => {
    const a = openSecretStore({ connectorId: "conn-a", backend: "file", dataRoot: tmp, env: NO_ENV });
    const b = openSecretStore({ connectorId: "conn-b", backend: "file", dataRoot: tmp, env: NO_ENV });
    a.set("k", "va");
    expect(b.get("k")).toBeNull();
    expect(() => a.set("bad name", "x")).toThrow(SecretError);
    expect(() => a.set("k", "")).toThrow(/non-empty/);
    expect(() => a.set("k", "x".repeat(8193))).toThrow(/at most/);
    expect(() => openSecretStore({ connectorId: "Bad_Id", backend: "file", dataRoot: tmp })).toThrow(SecretError);
  });

  it("honors AGENT_CONNECTOR_SECRETS_BACKEND=file as the default", () => {
    const store = openSecretStore({ connectorId: "acme-db", dataRoot: tmp, env: { [SECRETS_BACKEND_ENV]: "file" }, platform: "darwin" });
    expect(store.backend).toBe("file");
    expect(store.availability().ok).toBe(true);
    expect(store.selfTest()).toEqual({ ok: true, backend: "file" });
    expect(existsSync(fileStorePath(tmp))).toBe(true);
    expect(store.list()).toEqual([]); // the self-test item is gone and never indexed
  });
});

describe("resolveSecretEnv", () => {
  it("renders every template from the store and fails loudly on missing names", () => {
    const store = openSecretStore({ connectorId: "acme-db", backend: "file", dataRoot: tmp, env: NO_ENV });
    store.set("api-key", "K");
    store.set("db-pass", "p@ss");
    const env = resolveSecretEnv(
      "acme-db",
      { API_KEY: "{secret:api-key}", DSN: "pg://u:{secret:db-pass}@h", PLAIN: "no refs" },
      { form: "placeholder", dataRoot: tmp, env: { [SECRETS_BACKEND_ENV]: "file" } },
    );
    expect(env).toEqual({ API_KEY: "K", DSN: "pg://u:p@ss@h", PLAIN: "no refs" });

    let err: unknown;
    try {
      resolveSecretEnv(
        "acme-db",
        { A: "${secret:api-key}", B: "${secret:nope}", C: "${secret:also-nope}" },
        { form: "ref", dataRoot: tmp, env: { [SECRETS_BACKEND_ENV]: "file" } },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SecretResolutionError);
    expect((err as SecretResolutionError).missing).toEqual(["nope", "also-nope"]);
    expect((err as SecretResolutionError).message).toContain("secrets set <name> --connector-id acme-db");
    expect(resolveSecretEnv("acme-db", {}, { dataRoot: tmp })).toEqual({});
  });

  it("expands ${env:VAR} around a reference, never inside a value, and only when expandEnv is given", () => {
    const store = openSecretStore({ connectorId: "acme-db", backend: "file", dataRoot: tmp, env: NO_ENV });
    store.set("db-pass", "p${env:HOME}w"); // a value is opaque text
    const templates = { DSN: "pg://${env:DB_USER}:{secret:db-pass}@${env:DB_HOST:-localhost}/db" };
    const opts = { form: "placeholder" as const, dataRoot: tmp, env: { [SECRETS_BACKEND_ENV]: "file" } };
    expect(resolveSecretEnv("acme-db", templates, opts)).toEqual({
      DSN: "pg://${env:DB_USER}:p${env:HOME}w@${env:DB_HOST:-localhost}/db",
    });
    expect(resolveSecretEnv("acme-db", templates, { ...opts, expandEnv: { DB_USER: "ken" } })).toEqual({
      DSN: "pg://ken:p${env:HOME}w@localhost/db",
    });
  });

  it("stops asking the backend after its first failure and reports the rest unset", () => {
    const { exec, calls } = fakeExec((c) =>
      c.args[0] === "lookup" ? { status: 1, stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" } : {},
    );
    const opts = { backend: "secret-service" as const, exec, platform: "linux", dataRoot: tmp, env: NO_ENV };
    let err: unknown;
    try {
      resolveSecretEnv(
        "acme-db",
        { A: "{secret:a}", B: "{secret:b}", C: "{secret:c}" },
        { form: "placeholder", ...opts },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SecretResolutionError);
    expect((err as SecretResolutionError).missing).toEqual(["a", "b", "c"]);
    expect((err as SecretResolutionError).message).toContain("D-Bus");
    expect(calls.filter((c) => c.args[0] === "lookup")).toHaveLength(1);
  });

  it("treats an empty value read back from a backend as unset (get / has / list / resolve)", () => {
    // secret-tool answers every lookup with exit 0 and no output.
    const { exec } = fakeExec((c) => (c.args[0] === "lookup" ? { status: 0, stdout: "" } : {}));
    const opts = { backend: "secret-service" as const, exec, platform: "linux", dataRoot: tmp, env: NO_ENV };
    const store = openSecretStore({ connectorId: "acme-db", ...opts });
    store.set("api-key", "K");
    expect(store.get("api-key")).toBeNull();
    expect(store.has("api-key")).toBe(false);
    expect(store.list()).toMatchObject([{ name: "api-key", backend: "secret-service", present: false }]);
    let err: unknown;
    try {
      resolveSecretEnv("acme-db", { API_KEY: "{secret:api-key}" }, { form: "placeholder", ...opts });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SecretResolutionError);
    expect((err as SecretResolutionError).missing).toEqual(["api-key"]);
  });
});

// ── OS backends through the exec seam: argv / stdin / env contracts ────────

interface Call {
  file: string;
  args: string[];
  input?: string;
  env?: NodeJS.ProcessEnv;
}

function fakeExec(reply: (call: Call) => Partial<ExecResult>): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = (file, args, opts) => {
    const call: Call = { file, args, ...(opts.input !== undefined ? { input: opts.input } : {}), ...(opts.env ? { env: opts.env } : {}) };
    calls.push(call);
    return { status: 0, stdout: "", stderr: "", ...reply(call) };
  };
  return { exec, calls };
}

describe("keychain backend (macOS `security`) — exec contract", () => {
  it("refuses a keychainPath the `security -i` line could not carry", () => {
    const { exec } = fakeExec(() => ({}));
    for (const keychainPath of ["/tmp/my keychain.db", "/tmp/a\\b.db", "/tmp/\"q\".db"]) {
      expect(() => createSecretBackend("keychain", { exec, platform: "darwin", keychainPath })).toThrow(
        /whitespace, quotes or backslashes/,
      );
    }
  });

  it("writes via `security -i` with the value hex-encoded on stdin, never in argv", () => {
    const { exec, calls } = fakeExec(() => ({}));
    const b = createSecretBackend("keychain", { exec, platform: "darwin" });
    b.set("agent-connector/acme-db", "api-key", "héllo\nworld");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("/usr/bin/security");
    expect(calls[0]!.args).toEqual(["-i"]);
    expect(calls[0]!.input).toBe(
      `add-generic-password -a api-key -s agent-connector/acme-db -l agent-connector/acme-db/api-key -X ${Buffer.from("héllo\nworld", "utf8").toString("hex")} -U\n`,
    );
    expect(JSON.stringify(calls[0]!.args)).not.toContain("héllo");
  });

  it("reads with -g and parses both stderr forms; 44 is not-found; a locked keychain gets a hint", () => {
    expect(parseKeychainPasswordLine('password: "v2"\n')).toBe("v2");
    expect(parseKeychainPasswordLine('password: 0x68C3A96C6C6F  "h\\303\\251llo"\n')).toBe("héllo");
    expect(parseKeychainPasswordLine('password: "say "hi""\n')).toBe('say "hi"');
    expect(parseKeychainPasswordLine("keychain: x\n")).toBeNull();

    const { exec } = fakeExec((c) => {
      if (c.args[0] === "find-generic-password" && c.args[2] === "missing") {
        return { status: 44, stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." };
      }
      if (c.args[0] === "find-generic-password" && c.args[2] === "locked") {
        return { status: 51, stderr: "security: SecKeychainSearchCopyNext: The user name or passphrase you entered is not correct." };
      }
      return { status: 0, stderr: 'password: 0x4B  "K"\n' };
    });
    const b = createSecretBackend("keychain", { exec, platform: "darwin" });
    expect(b.get("svc", "api-key")).toBe("K");
    expect(b.get("svc", "missing")).toBeNull();
    let err: unknown;
    try {
      b.get("svc", "locked");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SecretError);
    expect((err as SecretError).hint).toMatch(/Keychain Access|GUI session/);
  });

  it("delete maps 44 to false and a timeout to an interactive-prompt hint", () => {
    const { exec } = fakeExec((c) =>
      c.args[0] === "delete-generic-password" && c.args[2] === "gone" ? { status: 44, stderr: "could not be found" } : { status: null, timedOut: true },
    );
    const b = createSecretBackend("keychain", { exec, platform: "darwin" });
    expect(b.delete("svc", "gone")).toBe(false);
    expect(() => b.delete("svc", "hangs")).toThrow(/timed out/);
  });
});

describe("secret-service backend (Linux secret-tool) — exec contract", () => {
  it("stores through stdin, looks up, and treats an empty exit-1 lookup as not found", () => {
    const { exec, calls } = fakeExec((c) => {
      if (c.args[0] === "lookup") return c.args[4] === "missing" ? { status: 1 } : { status: 0, stdout: "K" };
      return {};
    });
    const b = createSecretBackend("secret-service", { exec, platform: "linux" });
    b.set("agent-connector/acme-db", "api-key", "K");
    expect(calls[0]!.file).toMatch(/(^|\/)secret-tool$/);
    expect(calls[0]).toMatchObject({
      args: ["store", "--label=agent-connector/acme-db/api-key", "service", "agent-connector/acme-db", "account", "api-key"],
      input: "K",
    });
    expect(b.get("agent-connector/acme-db", "api-key")).toBe("K");
    expect(b.get("agent-connector/acme-db", "missing")).toBeNull();
    expect(b.delete("agent-connector/acme-db", "missing")).toBe(false);
    expect(b.delete("agent-connector/acme-db", "api-key")).toBe(true);
  });

  it("round-trips a multi-line value and refuses what secret-tool's 8192-byte buffer would truncate", () => {
    const stored = new Map<string, string>();
    const { exec } = fakeExec((c) => {
      if (c.args[0] === "store") stored.set(c.args[5]!, c.input ?? "");
      if (c.args[0] === "lookup") return stored.has(c.args[4]!) ? { stdout: stored.get(c.args[4]!) } : { status: 1 };
      return {};
    });
    const b = createSecretBackend("secret-service", { exec, platform: "linux" });
    const pem = "-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----";
    b.set("svc", "key", pem);
    expect(b.get("svc", "key")).toBe(pem);
    expect(() => b.set("svc", "big", "é".repeat(4097))).toThrow(/8192 bytes; this value is 8194 bytes/);
    expect(() => b.set("svc", "max", "x".repeat(8192))).not.toThrow();
  });

  it("reports a missing tool / no D-Bus session as unavailable with the file hint", () => {
    const enoent = Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" });
    const { exec } = fakeExec(() => ({ status: null, error: enoent }));
    const b = createSecretBackend("secret-service", { exec, platform: "linux" });
    expect(b.availability()).toMatchObject({ ok: false, reason: expect.stringContaining("not installed") });
    const dbus = fakeExec(() => ({ status: 1, stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY" }));
    const b2 = createSecretBackend("secret-service", { exec: dbus.exec, platform: "linux" });
    let err: unknown;
    try {
      b2.get("svc", "k");
    } catch (e) {
      err = e;
    }
    expect((err as SecretError).code).toBe("backend-unavailable");
    expect((err as SecretError).hint).toContain(`${SECRETS_BACKEND_ENV}=file`);
  });
});

describe("credential-manager backend (Windows PowerShell) — exec contract", () => {
  it("passes op/target/value through the child env and the script via -EncodedCommand", () => {
    const { exec, calls } = fakeExec((c) => (c.env?.AC_SECRET_OP === "get" ? { status: 0, stdout: "K" } : {}));
    const b = createSecretBackend("credential-manager", { exec, platform: "win32", env: { PATH: "x" } });
    b.set("agent-connector/acme-db", "api-key", "K");
    const c = calls[0]!;
    expect(c.file).toMatch(/(^|[\\/])powershell\.exe$/);
    expect(c.args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    expect(Buffer.from(c.args[5]!, "base64").toString("utf16le")).toBe(CREDENTIAL_MANAGER_SCRIPT);
    expect(c.env).toMatchObject({
      PATH: "x",
      AC_SECRET_OP: "set",
      AC_SECRET_TARGET: "agent-connector/acme-db/api-key",
      AC_SECRET_USER: "api-key",
      AC_SECRET_VALUE: "K",
    });
    expect(JSON.stringify(c.args)).not.toContain("K\"");
    expect(b.get("agent-connector/acme-db", "api-key")).toBe("K");
  });

  it("maps exit 3 to not-found and enforces the 2560-byte blob cap", () => {
    const { exec } = fakeExec((c) => (c.env?.AC_SECRET_OP === "delete" ? { status: 3 } : { status: 3 }));
    const b = createSecretBackend("credential-manager", { exec, platform: "win32" });
    expect(b.get("svc", "k")).toBeNull();
    expect(b.delete("svc", "k")).toBe(false);
    expect(() => b.set("svc", "k", "x".repeat(1281))).toThrow(/2560 bytes/);
  });
});

// ── Live: the real macOS keychain against a throwaway keychain ─────────────

const canMakeKeychain = (() => {
  if (process.platform !== "darwin") return false;
  const dir = mkdtempSync(join(tmpdir(), "ac-kc-probe-"));
  const path = join(dir, "probe.keychain-db");
  try {
    execFileSync("security", ["create-keychain", "-p", "pw", path], { stdio: "ignore", timeout: 10_000 });
    execFileSync("security", ["delete-keychain", path], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe.skipIf(!canMakeKeychain)("keychain backend — LIVE round trip against a throwaway keychain", () => {
  let keychainPath: string;
  beforeEach(() => {
    keychainPath = join(tmp, "test.keychain-db");
    execFileSync("security", ["create-keychain", "-p", "test-password", keychainPath], { stdio: "ignore" });
    execFileSync("security", ["unlock-keychain", "-p", "test-password", keychainPath], { stdio: "ignore" });
  });
  afterEach(() => {
    try {
      execFileSync("security", ["delete-keychain", keychainPath], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  });

  it("set (hex via -i) → get (-g) → update → delete, including unicode and multi-line values", () => {
    const b = createSecretBackend("keychain", { keychainPath });
    const svc = "agent-connector/ac-secrets-test";
    expect(b.get(svc, "api-key")).toBeNull();
    b.set(svc, "api-key", "héllo\nworld \"q\" \\ deadbeef");
    expect(b.get(svc, "api-key")).toBe("héllo\nworld \"q\" \\ deadbeef");
    b.set(svc, "api-key", "v2");
    expect(b.get(svc, "api-key")).toBe("v2");
    b.set(svc, "hexy", "deadbeef");
    expect(b.get(svc, "hexy")).toBe("deadbeef");
    expect(b.delete(svc, "api-key")).toBe(true);
    expect(b.delete(svc, "api-key")).toBe(false);
    expect(b.get(svc, "api-key")).toBeNull();
    expect(b.delete(svc, "hexy")).toBe(true);
  });

  it("openSecretStore uses it end to end (index records backend=keychain)", () => {
    const store = openSecretStore({ connectorId: "ac-secrets-test", backend: "keychain", dataRoot: tmp, keychainPath, env: NO_ENV });
    expect(store.selfTest()).toEqual({ ok: true, backend: "keychain" });
    store.set("api-key", "K1");
    expect(store.get("api-key")).toBe("K1");
    expect(store.list()).toEqual([expect.objectContaining({ name: "api-key", backend: "keychain", present: true })]);
    expect(store.delete("api-key")).toBe(true);
    expect(store.list()).toEqual([]);
  });
});
