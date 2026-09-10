/**
 * doctor — the `<id>: secrets` framework check.
 *
 * A connector whose server references `${secret:NAME}` (ServerDef.secretEnv,
 * on the base server or a per-host override) cannot launch until every
 * referenced name is in the keystore, so doctor reports:
 *   • warn  "not set: a, b — run secrets set <name>"   (never `fixable`)
 *   • pass  "<n> secret(s) present in <backend>"   (literal "secret(s)", as documented)
 *   • warn  "backend <id> unavailable: <reason>"
 * and no check at all for a connector without secretEnv. Runs against the
 * `file` backend in a throwaway data root; the connector is a registered record
 * (registerConnector stores `server` verbatim, secretEnv included).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/app.js";
import { run as secrets } from "../../src/cli/commands/secrets.js";
import { defineConnector } from "../../src/core/define-connector.js";
import { registerConnector } from "../../src/core/load-connector.js";
import type { ResolvedConnector, ServerDef } from "../../src/core/types.js";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  AGENT_CONNECTOR_DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  AGENT_CONNECTOR_SECRETS_BACKEND: process.env.AGENT_CONNECTOR_SECRETS_BACKEND,
  APPDATA: process.env.APPDATA,
};
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ac-doctor-secrets-"));
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

function secretsCheck(buckets: Bucket[], id: string): Result | undefined {
  return frameworkResults(buckets).find((r) => r.check === `${id}: secrets`);
}

const STDIO: ServerDef = { transport: "stdio", command: "node", args: ["server.js"], env: { PLAIN: "x" } };

/** A resolved connector whose server carries `secretEnv` (built explicitly, as defineConnector would). */
function withSecrets(
  id: string,
  secretEnv: Record<string, string> | undefined,
  overrideSecretEnv?: Record<string, string>,
): ResolvedConnector {
  const base = defineConnector({
    id,
    version: "1.0.0",
    server: STDIO,
    targets: ["claude-code"],
    telemetry: { enabled: false },
  });
  const server = base.server as ServerDef;
  return {
    ...base,
    server: secretEnv ? { ...server, secretEnv } : server,
    ...(overrideSecretEnv
      ? { platforms: { "claude-code": { server: { secretEnv: overrideSecretEnv } } } }
      : {}),
  };
}

function register(connector: ResolvedConnector): void {
  registerConnector(connector, join(tmp, `${connector.id}.mjs`), "user");
}

async function setSecret(id: string, name: string): Promise<void> {
  const code = await secrets(["set", name, "--connector-id", id, "--project", tmp], {
    isTTY: false,
    stdin: Readable.from([`value-of-${name}\n`]),
  });
  if (code !== 0) throw new Error(`secrets set ${name} exited ${code}`);
}

describe("doctor — <id>: secrets", () => {
  it("warns with the unset names, not fixable, with the exact command as the fix", async () => {
    register(withSecrets("sec-fix", { API_KEY: "${secret:api-key}", DB_PASS: "${secret:db-pass}" }));
    const r = secretsCheck(await doctorJson(), "sec-fix");
    expect(r).toBeDefined();
    expect(r?.status).toBe("warn");
    expect(r?.message).toBe("not set: api-key, db-pass — run secrets set <name>");
    expect(r?.fixable).toBeFalsy();
    expect(r?.fix).toBe("run `secrets set <name> --connector-id sec-fix` for each of: api-key, db-pass");
  });

  it("passes once every referenced secret is set, naming the backend", async () => {
    register(withSecrets("sec-fix", { API_KEY: "${secret:api-key}", DB_PASS: "${secret:db-pass}" }));
    await setSecret("sec-fix", "api-key");
    const partial = secretsCheck(await doctorJson(), "sec-fix");
    expect(partial?.status).toBe("warn");
    expect(partial?.message).toBe("not set: db-pass — run secrets set <name>");

    await setSecret("sec-fix", "db-pass");
    const full = secretsCheck(await doctorJson(), "sec-fix");
    expect(full?.status).toBe("pass");
    expect(full?.message).toBe("2 secret(s) present in file");
  });

  it("uses the documented literal `secret(s)` wording for a single secret too", async () => {
    register(withSecrets("one-sec", { TOKEN: "${secret:token}" }));
    await setSecret("one-sec", "token");
    expect(secretsCheck(await doctorJson(), "one-sec")?.message).toBe("1 secret(s) present in file");
  });

  it("a connector without secretEnv gets no secrets check", async () => {
    register(withSecrets("plain", undefined));
    const buckets = await doctorJson();
    expect(secretsCheck(buckets, "plain")).toBeUndefined();
    // the rest of the framework bucket is still there
    expect(frameworkResults(buckets).some((r) => r.check === "plain: connector version")).toBe(true);
  });

  it("counts secrets referenced only by a per-host server override", async () => {
    register(withSecrets("override-only", undefined, { HOST_KEY: "${secret:host-key}" }));
    const r = secretsCheck(await doctorJson(), "override-only");
    expect(r?.status).toBe("warn");
    expect(r?.message).toBe("not set: host-key — run secrets set <name>");
  });

  it("a damaged names index is a warn, never a crash", async () => {
    register(withSecrets("sec-idx", { API_KEY: "${secret:api-key}" }));
    const indexPath = join(tmp, ".agent-connector", "secrets", "sec-idx.index.json");
    mkdirSync(join(tmp, ".agent-connector", "secrets"), { recursive: true });
    writeFileSync(indexPath, "{ not json", "utf8");
    const r = secretsCheck(await doctorJson(), "sec-idx");
    expect(r?.status).toBe("warn");
    expect(r?.message).toMatch(/^backend unavailable: .*not valid JSON/);
  });

  it("warns when the configured backend is unavailable on this OS", async () => {
    // credential-manager off Windows / keychain on Windows can never be reached here.
    const foreign = process.platform === "win32" ? "keychain" : "credential-manager";
    process.env.AGENT_CONNECTOR_SECRETS_BACKEND = foreign;
    register(withSecrets("no-backend", { API_KEY: "${secret:api-key}" }));
    const r = secretsCheck(await doctorJson(), "no-backend");
    expect(r?.status).toBe("warn");
    expect(r?.message).toMatch(new RegExp(`^backend ${foreign} unavailable: .+ only$`));
    expect(r?.fixable).toBeFalsy();
  });
});
