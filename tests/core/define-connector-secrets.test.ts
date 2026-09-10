/**
 * core/define-connector — `${secret:NAME}` handling.
 *
 * defineConnector splits `server.env` into `env` (what adapters may write into
 * a host config file) and `secretEnv` (delivered by the `serve` wrapper from
 * the OS keystore at launch), validates WHERE a ref may appear (only the env
 * of a stdio server), and leaves a ref-free config untouched. Per-platform
 * `server` overrides get exactly the same treatment.
 */

import { describe, expect, it } from "vitest";

import { ConnectorConfigError, defineConnector } from "../../src/core/define-connector.js";
import type { ConnectorConfig } from "../../src/core/types.js";

const STDIO = { transport: "stdio" as const, command: "npx", args: ["-y", "@acme/db-mcp"] };

function withEnv(env: Record<string, string>): ConnectorConfig {
  return { id: "acme-db", server: { ...STDIO, env } };
}

describe("defineConnector — secret refs in server.env", () => {
  it("moves every `${secret:NAME}` entry into secretEnv (verbatim) and keeps the rest in env", () => {
    const resolved = defineConnector(
      withEnv({
        MODE: "prod",
        API_KEY: "${secret:API_KEY}",
        AUTH: "Bearer ${secret:TOKEN}",
        HOME_DIR: "${env:HOME}",
      }),
    );
    const server = resolved.server!;
    expect(server.env).toEqual({ MODE: "prod", HOME_DIR: "${env:HOME}" });
    expect(server.secretEnv).toEqual({
      API_KEY: "${secret:API_KEY}",
      AUTH: "Bearer ${secret:TOKEN}",
    });
    // Nothing an adapter renders from `env` can carry a ref.
    expect(JSON.stringify(server.env)).not.toContain("${secret:");
  });

  it("drops env entirely when every entry is a secret (no ref ever reaches a host config)", () => {
    const resolved = defineConnector(withEnv({ API_KEY: "${secret:API_KEY}" }));
    const server = resolved.server!;
    expect(server.env).toBeUndefined();
    expect(Object.keys(server)).not.toContain("env");
    expect(server.secretEnv).toEqual({ API_KEY: "${secret:API_KEY}" });
  });

  it("leaves a ref-free server untouched: same env object, no secretEnv key", () => {
    const env = { A: "1", B: "${env:B}", C: "not-a-ref {secret:C}" };
    const resolved = defineConnector(withEnv(env));
    expect(resolved.server!.env).toBe(env);
    expect(Object.keys(resolved.server!)).not.toContain("secretEnv");

    const bare = defineConnector({ id: "acme-db", server: { ...STDIO } });
    expect(Object.keys(bare.server!)).not.toContain("env");
    expect(Object.keys(bare.server!)).not.toContain("secretEnv");
  });

  it("rejects a secret-bearing value that also contains the literal placeholder text", () => {
    expect(() => defineConnector(withEnv({ X: "${secret:A} {secret:B}" }))).toThrow(
      ConnectorConfigError,
    );
    expect(() => defineConnector(withEnv({ X: "${secret:A} {secret:B}" }))).toThrow(
      /server\.env\.X: .*must not also contain the literal text "\{secret:"/,
    );
  });

  it("rejects a secret-bearing entry whose key is not an environment-variable name, or whose name the store would refuse", () => {
    expect(() => defineConnector(withEnv({ "A=B": "${secret:k}" }))).toThrow(
      /server\.env\.A=B: an env entry that references .* must have an environment-variable name/,
    );
    expect(() => defineConnector(withEnv({ "not a var": "${secret:k}" }))).toThrow(ConnectorConfigError);
    const long = "a".repeat(65);
    expect(() => defineConnector(withEnv({ K: `\${secret:${long}}` }))).toThrow(
      /server\.env\.K: "a{65}" is not a valid secret name/,
    );
    // Plain entries keep whatever key they had.
    expect(defineConnector(withEnv({ "A=B": "plain" })).server!.env).toEqual({ "A=B": "plain" });
  });

  it("rejects refs in cwd and auth too (every field but env reaches a host config verbatim)", () => {
    expect(() => defineConnector({ id: "acme-db", server: { ...STDIO, cwd: "/x/${secret:api-key}" } })).toThrow(
      /server: secret refs .*\(found api-key\)/,
    );
    expect(() =>
      defineConnector({
        id: "acme-db",
        server: { ...STDIO, auth: { type: "bearerEnv", bearerEnvVar: "${secret:tok}" } },
      }),
    ).toThrow(/server: secret refs .*\(found tok\)/);
  });

  it("rejects refs anywhere but env: command, args, url, headers", () => {
    const cases: Array<[string, ConnectorConfig["server"], string]> = [
      ["command", { transport: "stdio", command: "${secret:BIN}" }, "BIN"],
      ["args", { ...STDIO, args: ["--token", "${secret:TOKEN}"] }, "TOKEN"],
      [
        "url",
        { transport: "http", url: "https://example.com/mcp/${secret:PATH_KEY}" },
        "PATH_KEY",
      ],
      [
        "headers",
        {
          transport: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer ${secret:HDR}" },
        },
        "HDR",
      ],
    ];
    for (const [what, server, name] of cases) {
      const build = () => defineConnector({ id: "acme-db", server });
      expect(build, what).toThrow(ConnectorConfigError);
      expect(build, what).toThrow(
        new RegExp(`server: secret refs .* only in server\\.env of a stdio server \\(found ${name}\\)`),
      );
    }
  });

  it("rejects refs in the env of a remote (non-stdio) server — there is no wrapper to inject them", () => {
    const build = () =>
      defineConnector({
        id: "acme-db",
        server: {
          transport: "http",
          url: "https://example.com/mcp",
          env: { API_KEY: "${secret:API_KEY}" },
        },
      });
    expect(build).toThrow(ConnectorConfigError);
    expect(build).toThrow(/transport "http" — found API_KEY/);
  });
});

describe("defineConnector — secret refs in platforms.<id>.server overrides", () => {
  it("splits an override's env exactly like the base server; other overrides stay verbatim", () => {
    const cursorOverride = { hooks: false as const };
    const resolved = defineConnector({
      id: "acme-db",
      server: { ...STDIO, env: { BASE: "1" } },
      platforms: {
        codex: { server: { env: { API_KEY: "${secret:API_KEY}", REGION: "eu" } } },
        "claude-code": { server: false },
        cursor: cursorOverride,
      },
    });
    expect(resolved.platforms.codex).toEqual({
      server: { env: { REGION: "eu" }, secretEnv: { API_KEY: "${secret:API_KEY}" } },
    });
    expect(resolved.platforms["claude-code"]).toEqual({ server: false });
    expect(resolved.platforms.cursor).toBe(cursorOverride);
    // The base server is unaffected by the override's secrets.
    expect(resolved.server!.env).toEqual({ BASE: "1" });
    expect(Object.keys(resolved.server!)).not.toContain("secretEnv");
    // Only `secretEnv` (wrapper-delivered) carries the ref; `env` (host config) never does.
    const codexServer = resolved.platforms.codex!.server as {
      env?: Record<string, string>;
      secretEnv?: Record<string, string>;
    };
    expect(JSON.stringify(codexServer.env)).not.toContain("${secret:");
    expect(JSON.stringify(codexServer.secretEnv)).toContain("${secret:");
  });

  it("drops the override's env when every entry is a secret", () => {
    const resolved = defineConnector({
      id: "acme-db",
      server: { ...STDIO },
      platforms: { codex: { server: { env: { API_KEY: "${secret:API_KEY}" } } } },
    });
    expect(resolved.platforms.codex).toEqual({
      server: { secretEnv: { API_KEY: "${secret:API_KEY}" } },
    });
    expect(Object.keys(resolved.platforms.codex!.server as object)).not.toContain("env");
  });

  it("judges an override by the effective transport: rejected on an http base, split on a stdio base", () => {
    expect(() =>
      defineConnector({
        id: "acme-db",
        server: { transport: "http", url: "https://example.com/mcp" },
        platforms: { codex: { server: { env: { K: "${secret:K}" } } } },
      }),
    ).toThrow(/platforms\.codex\.server: secret refs .*transport "http" — found K\)/);
    const ok = defineConnector({
      id: "acme-db",
      server: { ...STDIO },
      platforms: { codex: { server: { env: { K: "${secret:K}" } } } },
    });
    expect(ok.platforms.codex).toEqual({ server: { secretEnv: { K: "${secret:K}" } } });
  });

  it("an override env replaces the base env and its secrets; an override without env keeps them", () => {
    const resolved = defineConnector({
      id: "acme-db",
      server: { ...STDIO, env: { API_KEY: "${secret:API_KEY}", MODE: "prod" } },
      platforms: {
        codex: { server: { env: { MODE: "debug" } } },
        cursor: { server: { args: ["--quiet"] } },
      },
    });
    expect(resolved.platforms.codex).toEqual({ server: { env: { MODE: "debug" }, secretEnv: {} } });
    expect(resolved.platforms.cursor).toEqual({ server: { args: ["--quiet"] } });
    // The adapters' shallow merge: no secret for codex, the base secret for cursor.
    const merged = (id: "codex" | "cursor") => ({
      ...resolved.server!,
      ...(resolved.platforms[id]!.server as object),
    });
    expect(merged("codex").secretEnv).toEqual({});
    expect(merged("cursor").secretEnv).toEqual({ API_KEY: "${secret:API_KEY}" });
    // A base without secrets is untouched by an override env.
    const plain = defineConnector({
      id: "acme-db",
      server: { ...STDIO, env: { MODE: "prod" } },
      platforms: { codex: { server: { env: { MODE: "debug" } } } },
    });
    expect(plain.platforms.codex).toEqual({ server: { env: { MODE: "debug" } } });
  });

  it("keeps `server: false` verbatim when the base server has secrets (that host runs no server)", () => {
    const resolved = defineConnector({
      id: "acme-db",
      server: { ...STDIO, env: { API_KEY: "${secret:API_KEY}" } },
      platforms: { codex: { server: false } },
    });
    expect(resolved.platforms.codex).toEqual({ server: false });
    expect(resolved.server!.secretEnv).toEqual({ API_KEY: "${secret:API_KEY}" });
  });

  it("rejects refs outside env, or in a remote override's env, naming the platform", () => {
    expect(() =>
      defineConnector({
        id: "acme-db",
        server: { ...STDIO },
        platforms: { codex: { server: { args: ["${secret:X}"] } } },
      }),
    ).toThrow(/platforms\.codex\.server: secret refs .*\(found X\)/);

    expect(() =>
      defineConnector({
        id: "acme-db",
        server: { ...STDIO },
        platforms: {
          codex: {
            server: {
              transport: "http",
              url: "https://example.com/mcp",
              env: { K: "${secret:K}" },
            },
          },
        },
      }),
    ).toThrow(/platforms\.codex\.server: secret refs .*transport "http" — found K/);

    expect(() =>
      defineConnector({
        id: "acme-db",
        server: { ...STDIO },
        platforms: { codex: { server: { env: { X: "${secret:A}{secret:B}" } } } },
      }),
    ).toThrow(/platforms\.codex\.server\.env\.X: .*literal text "\{secret:"/);
  });
});
