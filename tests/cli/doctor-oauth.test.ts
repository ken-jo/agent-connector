/**
 * doctor — the `<id>: logins` framework check.
 *
 * A connector that declares `oauth.<key>` logins makes its server's first
 * `getAccessToken` open a browser (or fail closed) for every login the user
 * never ran, so doctor reports:
 *   • warn  "not logged in: a, b — run auth login <key>"   (never `fixable`)
 *   • pass  "<n> login(s) present"   (literal "login(s)", as documented)
 *   • warn  "backend <id> unavailable: <reason>"
 * and no check at all for a connector without `oauth`. No network: presence is
 * the refresh token's presence under `storeAs` in the keystore. Runs against
 * the `file` backend in a throwaway data root; the connector is a registered
 * record (registerConnector persists `oauth` verbatim).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/app.js";
import { defineConnector } from "../../src/core/define-connector.js";
import { registerConnector } from "../../src/core/load-connector.js";
import { openSecretStore } from "../../src/core/secrets.js";
import type { ResolvedConnector, ResolvedOAuthLoginDef, ServerDef } from "../../src/core/types.js";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  AGENT_CONNECTOR_DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  AGENT_CONNECTOR_SECRETS_BACKEND: process.env.AGENT_CONNECTOR_SECRETS_BACKEND,
  APPDATA: process.env.APPDATA,
};
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ac-doctor-oauth-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(tmp, ".agent-connector");
  process.env.AGENT_CONNECTOR_SECRETS_BACKEND = "file";
  process.env.APPDATA = join(tmp, "AppData", "Roaming");
  mkdirSync(join(tmp, ".claude"), { recursive: true });
  writeFileSync(join(tmp, ".claude", "settings.json"), "{}", "utf8");
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

interface Result {
  check: string;
  status: string;
  message: string;
  fix?: string;
  fixable?: boolean;
}
interface Bucket {
  platform: string;
  results: Result[];
}

function captureStdout(): { restore: () => void; text: () => string } {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as unknown as typeof process.stdout.write;
  return {
    restore: () => {
      process.stdout.write = orig;
    },
    text: () => out,
  };
}

async function doctorJson(): Promise<Bucket[]> {
  const cap = captureStdout();
  try {
    await main(["doctor", "--json", "--targets", "claude-code", "--project", tmp]);
  } finally {
    cap.restore();
  }
  return JSON.parse(cap.text()) as Bucket[];
}

function frameworkResults(buckets: Bucket[]): Result[] {
  const b = buckets.find((x) => x.platform === "agent-connector");
  if (!b) throw new Error("no agent-connector bucket in doctor output");
  return b.results;
}

function loginsCheck(buckets: Bucket[], id: string): Result | undefined {
  return frameworkResults(buckets).find((r) => r.check === `${id}: logins`);
}

const STDIO: ServerDef = { transport: "stdio", command: "node", args: ["server.js"], env: { PLAIN: "x" } };

/** A resolved login definition with the defaults applied, as defineConnector produces it. */
function loginDef(key: string, provider: ResolvedOAuthLoginDef["provider"]): ResolvedOAuthLoginDef {
  return {
    key,
    provider,
    clientId: `${key}-client-id`,
    scopes: ["read"],
    flow: "auto",
    redirectPath: "/callback",
    storeAs: `oauth.${key}.refresh-token`,
  };
}

/** A resolved connector carrying the given logins (built explicitly, as defineConnector would). */
function withLogins(id: string, logins: ResolvedOAuthLoginDef[]): ResolvedConnector {
  const base = defineConnector({
    id,
    version: "1.0.0",
    server: STDIO,
    targets: ["claude-code"],
    telemetry: { enabled: false },
  });
  return { ...base, oauth: Object.fromEntries(logins.map((l) => [l.key, l])) };
}

function register(connector: ResolvedConnector): void {
  registerConnector(connector, join(tmp, `${connector.id}.mjs`), "user");
}

/** What a completed `auth login <key>` leaves in the keystore: the refresh token under storeAs. */
function storeRefreshToken(id: string, key: string): void {
  openSecretStore({ connectorId: id, backend: "file" }).set(`oauth.${key}.refresh-token`, `rt-${key}`);
}

describe("doctor — <id>: logins", () => {
  it("warns with the absent keys, not fixable, with the exact command as the fix", async () => {
    register(withLogins("oauth-fix", [loginDef("google", "google"), loginDef("ms", "microsoft")]));
    const r = loginsCheck(await doctorJson(), "oauth-fix");
    expect(r).toBeDefined();
    expect(r?.status).toBe("warn");
    expect(r?.message).toBe("not logged in: google, ms — run auth login <key>");
    expect(r?.fixable).toBeFalsy();
    expect(r?.fix).toBe("run `auth login <key> --connector-id oauth-fix` for each of: google, ms");
  });

  it("passes once every login is present", async () => {
    register(withLogins("oauth-fix", [loginDef("google", "google"), loginDef("ms", "microsoft")]));
    storeRefreshToken("oauth-fix", "google");
    const partial = loginsCheck(await doctorJson(), "oauth-fix");
    expect(partial?.status).toBe("warn");
    expect(partial?.message).toBe("not logged in: ms — run auth login <key>");

    storeRefreshToken("oauth-fix", "ms");
    const full = loginsCheck(await doctorJson(), "oauth-fix");
    expect(full?.status).toBe("pass");
    expect(full?.message).toBe("2 login(s) present");
  });

  it("uses the documented literal `login(s)` wording for a single login too", async () => {
    register(withLogins("one-login", [loginDef("github", "github")]));
    storeRefreshToken("one-login", "github");
    expect(loginsCheck(await doctorJson(), "one-login")?.message).toBe("1 login(s) present");
  });

  it("honors a custom storeAs name", async () => {
    register(withLogins("custom-store", [{ ...loginDef("posthog", "posthog"), storeAs: "ph-refresh" }]));
    expect(loginsCheck(await doctorJson(), "custom-store")?.status).toBe("warn");
    openSecretStore({ connectorId: "custom-store", backend: "file" }).set("ph-refresh", "rt");
    expect(loginsCheck(await doctorJson(), "custom-store")?.message).toBe("1 login(s) present");
  });

  it("a connector without oauth gets no logins check", async () => {
    register(withLogins("plain", []));
    const buckets = await doctorJson();
    expect(loginsCheck(buckets, "plain")).toBeUndefined();
    // the rest of the framework bucket is still there
    expect(frameworkResults(buckets).some((r) => r.check === "plain: connector version")).toBe(true);
  });

  it("a damaged names index is a warn, never a crash", async () => {
    register(withLogins("oauth-idx", [loginDef("google", "google")]));
    const indexPath = join(tmp, ".agent-connector", "secrets", "oauth-idx.index.json");
    mkdirSync(join(tmp, ".agent-connector", "secrets"), { recursive: true });
    writeFileSync(indexPath, "{ not json", "utf8");
    const r = loginsCheck(await doctorJson(), "oauth-idx");
    expect(r?.status).toBe("warn");
    expect(r?.message).toMatch(/^backend( file)? unavailable: .*not valid JSON/);
    expect(r?.fixable).toBeFalsy();
  });

  it("a damaged login metadata file is a warn, never a crash", async () => {
    register(withLogins("oauth-meta", [loginDef("google", "google")]));
    storeRefreshToken("oauth-meta", "google");
    mkdirSync(join(tmp, ".agent-connector", "oauth"), { recursive: true });
    writeFileSync(join(tmp, ".agent-connector", "oauth", "oauth-meta.json"), "{ not json", "utf8");
    const buckets = await doctorJson();
    const r = loginsCheck(buckets, "oauth-meta");
    expect(r).toBeDefined();
    expect(["warn", "pass"]).toContain(r?.status);
    expect(frameworkResults(buckets).some((x) => x.check === "oauth-meta: connector version")).toBe(true);
  });

  it("warns when the configured backend is unavailable on this OS", async () => {
    // credential-manager off Windows / keychain on Windows can never be reached here.
    const foreign = process.platform === "win32" ? "keychain" : "credential-manager";
    process.env.AGENT_CONNECTOR_SECRETS_BACKEND = foreign;
    register(withLogins("no-backend", [loginDef("google", "google")]));
    const r = loginsCheck(await doctorJson(), "no-backend");
    expect(r?.status).toBe("warn");
    expect(r?.message).toMatch(new RegExp(`^backend ${foreign} unavailable: .+ only$`));
    expect(r?.fixable).toBeFalsy();
  });
});
