/**
 * cli/secrets — the `secrets set | delete | list | check` command.
 *
 * Drives the real command through the io seam (a Readable as stdin, a prompt
 * stub for the TTY path) against the `file` backend in a throwaway data root,
 * so no OS keystore is touched. The byte-level contract under test:
 *   • the value enters ONLY via stdin / the hidden prompt and is never printed
 *   • exactly one trailing newline is stripped from a piped value
 *   • connector resolution order (--connector-id, --connector, local config,
 *     the single registered connector, else an error asking for --connector-id)
 *   • usage errors exit 2 with the verb's signature; keystore failures exit 1
 *   • `secrets --help` prints the fixed signature lines; the root usage lists it
 *   • a branded CLI (createConnectorCli) auto-scopes `secrets` to its connector
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/app.js";
import { SECRETS_USAGE_LINES, run } from "../../src/cli/commands/secrets.js";
import { createConnectorCli } from "../../src/cli/sdk.js";
import { defineConnector } from "../../src/core/define-connector.js";
import { registerConnector } from "../../src/core/load-connector.js";
import { openSecretStore } from "../../src/core/secrets.js";

const SECRET_VALUE = "s3cr3t-value-never-printed";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  AGENT_CONNECTOR_DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  AGENT_CONNECTOR_SECRETS_BACKEND: process.env.AGENT_CONNECTOR_SECRETS_BACKEND,
};

let tmp: string;
let dataDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ac-secrets-cli-"));
  dataDir = join(tmp, ".agent-connector");
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.AGENT_CONNECTOR_DATA_DIR = dataDir;
  process.env.AGENT_CONNECTOR_SECRETS_BACKEND = "file";
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function capture(stream: "stdout" | "stderr"): { restore: () => void; text: () => string } {
  let out = "";
  const spy = vi
    .spyOn(process[stream], "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
  return { restore: () => spy.mockRestore(), text: () => out };
}

/** Run the command with both streams captured; `stdin` is what a pipe would carry. */
async function secrets(
  argv: string[],
  io: { stdin?: string; isTTY?: boolean; prompt?: (label: string) => Promise<string> } = {},
): Promise<{ code: number; out: string; err: string }> {
  const out = capture("stdout");
  const err = capture("stderr");
  let code: number;
  try {
    code = await run(argv, {
      isTTY: io.isTTY ?? false,
      ...(io.stdin !== undefined ? { stdin: Readable.from([io.stdin]) } : {}),
      ...(io.prompt ? { prompt: io.prompt } : {}),
    });
  } finally {
    out.restore();
    err.restore();
  }
  return { code, out: out.text(), err: err.text() };
}

const ID = ["--connector-id", "acme-db", "--project"] as const;
/** `--connector-id acme-db --project <tmp>` — deterministic resolution, no discovery. */
function byId(): string[] {
  return [...ID, tmp];
}

function writeConfigJson(dir: string, id: string, name = "agent-connector.config.json"): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(
    p,
    JSON.stringify({ id, version: "1.0.0", memory: [{ content: `Use the ${id} tools.` }] }),
    "utf8",
  );
  return p;
}

describe("secrets set — value input", () => {
  it("stores a piped value (non-TTY stdin), stripping exactly one trailing newline", async () => {
    const r = await secrets(["set", "api-key", ...byId()], { stdin: `${SECRET_VALUE}\n` });
    expect(r.code).toBe(0);
    expect(r.out).toBe('stored "api-key" for connector acme-db in file\n');
    // Reading a pipe nobody asked for with --stdin is announced, so an open
    // inherited pipe never looks like a hang.
    expect(r.err).toBe("reading the value for api-key from stdin (until EOF)\n");
    const store = openSecretStore({ connectorId: "acme-db", backend: "file", dataRoot: dataDir });
    expect(store.get("api-key")).toBe(SECRET_VALUE);

    // CRLF counts as one newline; a second newline is part of the value.
    await secrets(["set", "crlf", ...byId()], { stdin: "abc\r\n" });
    await secrets(["set", "double", ...byId()], { stdin: "abc\n\n" });
    expect(store.get("crlf")).toBe("abc");
    expect(store.get("double")).toBe("abc\n");
  });

  it("never prints the value on stdout or stderr across set / list / check", async () => {
    const seen: string[] = [];
    const push = (r: { out: string; err: string }) => seen.push(r.out, r.err);
    push(await secrets(["set", "api-key", ...byId()], { stdin: `${SECRET_VALUE}\n` }));
    push(await secrets(["list", ...byId()]));
    push(await secrets(["list", "--json", ...byId()]));
    push(await secrets(["check", "--json", ...byId()]));
    expect(seen.join("")).not.toContain(SECRET_VALUE);
  });

  it("TTY: asks through the hidden prompt with the fixed label", async () => {
    const labels: string[] = [];
    const r = await secrets(["set", "api-key", ...byId()], {
      isTTY: true,
      prompt: async (label) => {
        labels.push(label);
        return SECRET_VALUE;
      },
    });
    expect(r.code).toBe(0);
    expect(labels).toEqual(["Enter value for api-key (input hidden):"]);
    expect(
      openSecretStore({ connectorId: "acme-db", backend: "file", dataRoot: dataDir }).get("api-key"),
    ).toBe(SECRET_VALUE);
  });

  it("--stdin forces the pipe even on a TTY (the prompt is never called)", async () => {
    const prompt = vi.fn(async () => "from-prompt");
    const r = await secrets(["set", "api-key", "--stdin", ...byId()], {
      isTTY: true,
      stdin: "from-pipe\n",
      prompt,
    });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(prompt).not.toHaveBeenCalled();
    expect(
      openSecretStore({ connectorId: "acme-db", backend: "file", dataRoot: dataDir }).get("api-key"),
    ).toBe("from-pipe");
  });

  it("an empty value stores nothing (exit 1)", async () => {
    const r = await secrets(["set", "api-key", ...byId()], { stdin: "\n" });
    expect(r.code).toBe(1);
    expect(r.err).toContain('no value given for "api-key"');
    expect(
      openSecretStore({ connectorId: "acme-db", backend: "file", dataRoot: dataDir }).has("api-key"),
    ).toBe(false);
  });

  it("rejects an invalid name before reading any value (exit 1)", async () => {
    const r = await secrets(["set", "bad name!", ...byId()], { stdin: "x\n" });
    expect(r.code).toBe(1);
    expect(r.err).toContain('"bad name!" is not a valid secret name');
  });

  it("rejects an unknown --backend before asking for the value (exit 1)", async () => {
    const prompt = vi.fn(async () => SECRET_VALUE);
    const r = await secrets(["set", "api-key", "--backend", "vault", ...byId()], { isTTY: true, prompt });
    expect(r.code).toBe(1);
    expect(r.err).toContain('unknown secrets backend "vault"');
    expect(prompt).not.toHaveBeenCalled();
  });

  it("--backend file works when the env default is the OS keystore", async () => {
    process.env.AGENT_CONNECTOR_SECRETS_BACKEND = "auto";
    const r = await secrets(["set", "api-key", "--backend", "file", ...byId()], { stdin: "v\n" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("in file");
  });
});

describe("secrets list / delete / check", () => {
  it("list: an empty store says so (text) and is [] (--json)", async () => {
    const text = await secrets(["list", ...byId()]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("no secrets recorded for connector acme-db");
    const json = await secrets(["list", "--json", ...byId()]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toEqual([]);
  });

  it("list: names + backend + presence, never values", async () => {
    await secrets(["set", "api-key", ...byId()], { stdin: `${SECRET_VALUE}\n` });
    await secrets(["set", "db-pass", ...byId()], { stdin: "other\n" });
    const json = await secrets(["list", "--json", ...byId()]);
    const entries = JSON.parse(json.out) as { name: string; backend: string; present: boolean }[];
    expect(entries.map((e) => [e.name, e.backend, e.present])).toEqual([
      ["api-key", "file", true],
      ["db-pass", "file", true],
    ]);
    const text = await secrets(["list", ...byId()]);
    const lines = text.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^name\s+backend\s+present\s+updated$/);
    expect(lines[1]).toMatch(/^api-key\s+file\s+yes\s+\d{4}-\d{2}-\d{2}T/);
    expect(lines[2]).toMatch(/^db-pass\s+file\s+yes\s+/);
  });

  it("a damaged names index is reported (exit 1), never a crash, and set repairs nothing silently", async () => {
    mkdirSync(join(dataDir, "secrets"), { recursive: true });
    writeFileSync(join(dataDir, "secrets", "acme-db.index.json"), "{ not json", "utf8");
    const list = await secrets(["list", ...byId()]);
    expect(list.code).toBe(1);
    expect(list.err).toMatch(/not valid JSON/);
    const set = await secrets(["set", "api-key", ...byId()], { stdin: `${SECRET_VALUE}\n` });
    expect(set.code).toBe(1);
    expect(set.err).toMatch(/not valid JSON/);
    expect(set.err).not.toContain(SECRET_VALUE);
  });

  it("delete: removes the value; a second delete is a no-op that still exits 0", async () => {
    await secrets(["set", "api-key", ...byId()], { stdin: "v\n" });
    const first = await secrets(["delete", "api-key", ...byId()]);
    expect(first.code).toBe(0);
    expect(first.out).toBe('deleted "api-key" for connector acme-db\n');
    const second = await secrets(["delete", "api-key", ...byId()]);
    expect(second.code).toBe(0);
    expect(second.out).toContain('"api-key" is not set for connector acme-db');
    expect(JSON.parse((await secrets(["list", "--json", ...byId()])).out)).toEqual([]);
  });

  it("check --json: availability + a write/read/delete self-test on the chosen backend", async () => {
    const r = await secrets(["check", "--json", ...byId()]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as {
      ok: boolean;
      connectorId: string;
      connectorResolved: boolean;
      backend: string;
      availability: { ok: boolean };
      selfTest: { ok: boolean; backend: string };
    };
    expect(report.ok).toBe(true);
    expect(report.connectorId).toBe("acme-db");
    expect(report.connectorResolved).toBe(true);
    expect(report.backend).toBe("file");
    expect(report.availability.ok).toBe(true);
    expect(report.selfTest).toMatchObject({ ok: true, backend: "file" });
    // The self-test leaves nothing behind.
    expect(JSON.parse((await secrets(["list", "--json", ...byId()])).out)).toEqual([]);
  });

  it("check: text report, and exit 1 with the reason when the backend is unavailable here", async () => {
    const ok = await secrets(["check", ...byId()]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("connector:  acme-db");
    expect(ok.out).toContain("backend:    file");
    expect(ok.out).toContain("available:  yes");
    expect(ok.out).toContain("self-test:  ok");

    // A backend that cannot exist on this OS: credential-manager off Windows,
    // keychain on Windows.
    const foreign = process.platform === "win32" ? "keychain" : "credential-manager";
    const bad = await secrets(["check", "--backend", foreign, "--json", ...byId()]);
    expect(bad.code).toBe(1);
    const report = JSON.parse(bad.out) as {
      ok: boolean;
      availability: { ok: boolean; reason?: string };
      selfTest: { ok: boolean; reason?: string };
    };
    expect(report.ok).toBe(false);
    expect(report.availability.ok).toBe(false);
    expect(report.availability.reason).toMatch(/only$/);
    expect(report.selfTest.ok).toBe(false);
  });

  it("check without any connector falls back to the framework id (keystore-only check)", async () => {
    const r = await secrets(["check", "--json", "--project", tmp]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as { connectorId: string; connectorResolved: boolean };
    expect(report.connectorId).toBe("agent-connector");
    expect(report.connectorResolved).toBe(false);
  });
});

describe("secrets — connector resolution", () => {
  it("--connector <path> loads the config and uses its id", async () => {
    const cfg = writeConfigJson(join(tmp, "proj"), "path-conn");
    const set = await secrets(["set", "api-key", "--connector", cfg, "--project", tmp], { stdin: "v\n" });
    expect(set.code).toBe(0);
    expect(set.out).toContain("for connector path-conn");
    const list = await secrets(["list", "--json", "--connector-id", "path-conn", "--project", tmp]);
    expect((JSON.parse(list.out) as { name: string }[]).map((e) => e.name)).toEqual(["api-key"]);
  });

  it("--connector <bad path> is an error even for check (exit 1)", async () => {
    const r = await secrets(["check", "--connector", join(tmp, "nope.json"), "--project", tmp]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot load connector");
  });

  it("finds agent-connector.config.* in --project", async () => {
    writeConfigJson(join(tmp, "proj"), "local-conn");
    const r = await secrets(["list", "--json", "--project", join(tmp, "proj")]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
    // and set/list agree on the id it resolved
    await secrets(["set", "k", "--project", join(tmp, "proj")], { stdin: "v\n" });
    const byIdList = await secrets(["list", "--json", "--connector-id", "local-conn", "--project", tmp]);
    expect((JSON.parse(byIdList.out) as { name: string }[]).map((e) => e.name)).toEqual(["k"]);
  });

  it("falls back to the single registered connector", async () => {
    registerConnector(
      defineConnector({ id: "reg-only", version: "1.0.0", memory: [{ content: "x" }] }),
      join(tmp, "reg-only.mjs"),
    );
    const set = await secrets(["set", "api-key", "--project", tmp], { stdin: "v\n" });
    expect(set.code).toBe(0);
    expect(set.out).toContain("for connector reg-only");
  });

  it("with several registered connectors it asks for --connector-id (exit 1)", async () => {
    for (const id of ["reg-a", "reg-b"]) {
      registerConnector(
        defineConnector({ id, version: "1.0.0", memory: [{ content: "x" }] }),
        join(tmp, `${id}.mjs`),
      );
    }
    const r = await secrets(["list", "--project", tmp]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("2 connectors are registered (reg-a, reg-b)");
    expect(r.err).toContain("--connector-id <id>");
  });

  it("with nothing to resolve, set/list/delete fail asking for --connector-id (exit 1)", async () => {
    for (const argv of [["set", "k"], ["list"], ["delete", "k"]]) {
      const r = await secrets([...argv, "--project", tmp], { stdin: "v\n" });
      expect(r.code).toBe(1);
      expect(r.err).toContain("no connector found — pass --connector-id <id>");
    }
  });
});

describe("secrets — usage", () => {
  it("`secrets --help` prints the fixed signature lines (exit 0)", async () => {
    const out = capture("stdout");
    const code = await main(["secrets", "--help"]);
    out.restore();
    expect(code).toBe(0);
    expect(out.text()).toContain(`usage: agent-connector ${SECRETS_USAGE_LINES[0]}`);
    for (const line of SECRETS_USAGE_LINES) expect(out.text()).toContain(line);
  });

  it("the root usage lists secrets after status", async () => {
    const out = capture("stdout");
    await main(["--help"]);
    out.restore();
    const text = out.text();
    const line =
      "  secrets      Store the secrets a connector references (${secret:NAME}) in the OS keystore (set | delete | list | check).";
    expect(text).toContain(line);
    expect(text.indexOf("  status       ")).toBeLessThan(text.indexOf(line));
  });

  it("a bare `secrets` is a usage error: the signatures on stderr, exit 2", async () => {
    const out = capture("stdout");
    const err = capture("stderr");
    const code = await main(["secrets"]);
    out.restore();
    err.restore();
    expect(code).toBe(2);
    expect(out.text()).toBe("");
    expect(err.text()).toContain(`usage: agent-connector ${SECRETS_USAGE_LINES[0]}`);
    expect(err.text()).toContain("secrets: missing subcommand (set | delete | list | check)");
  });

  it("usage errors exit 2 with the verb's signature on stderr", async () => {
    const cases: [string[], string][] = [
      [["bogus"], 'unknown secrets subcommand "bogus" (use set|delete|list|check)'],
      [["set"], "secrets set: missing <name>"],
      [["delete"], "secrets delete: missing <name>"],
      [["list", "extra"], 'secrets list: unexpected argument "extra"'],
      [["set", "k", "extra"], 'secrets set: unexpected argument "extra"'],
      [["list", "--stdin"], "--stdin is not accepted by `secrets list`"],
      [["delete", "k", "--json"], "--json is not accepted by `secrets delete`"],
      [["delete", "k", "--backend", "file"], "--backend is not accepted by `secrets delete`"],
    ];
    for (const [argv, message] of cases) {
      const r = await secrets([...argv, ...byId()]);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err, argv.join(" ")).toContain(message);
    }
    // an unknown flag is the dispatcher's friendly parse error (exit 2, usage shown)
    const errCap = capture("stderr");
    const code = await main(["secrets", "list", "--no-such-flag"]);
    errCap.restore();
    expect(code).toBe(2);
    expect(errCap.text()).toContain("usage: agent-connector secrets set");
  });
});

describe("secrets — branded CLI (createConnectorCli)", () => {
  it("auto-scopes `secrets` to the package's connector config", async () => {
    const cfg = writeConfigJson(join(tmp, "pkg"), "brand-conn");
    const cli = createConnectorCli({ name: "brand-conn", connector: cfg });
    const out = capture("stdout");
    const err = capture("stderr");
    let code: number;
    try {
      code = await cli.run(["secrets", "list", "--json", "--project", tmp]);
    } finally {
      out.restore();
      err.restore();
    }
    expect(code, err.text()).toBe(0);
    expect(JSON.parse(out.text())).toEqual([]);

    // and the branded per-command help reads as the developer's tool
    const help = capture("stdout");
    const helpCode = await cli.run(["secrets", "--help"]);
    help.restore();
    expect(helpCode).toBe(0);
    expect(help.text()).toContain(`usage: brand-conn ${SECRETS_USAGE_LINES[0]}`);
  });
});
