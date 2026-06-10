/**
 * tests/core/package-server-json — the `mcp-server-json` package format emits a
 * registry-conformant server.json describing the dev's REAL upstream server
 * (not our serve wrapper), from the connector's `publish` metadata.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { packageConnector, readPackagedJson } from "../../src/core/package.js";
import { MCP_SERVER_SCHEMA_URL } from "../../src/core/mcp-standard.js";

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "ac-serverjson-"));
});
afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

function emit(connector: ReturnType<typeof defineConnector>): Record<string, any> {
  const res = packageConnector(connector, { outDir: out, format: "mcp-server-json" });
  expect(res.files.some((f) => f.endsWith("server.json"))).toBe(true);
  return readPackagedJson<Record<string, any>>(join(out, "server.json"))!;
}

describe("mcp-server-json — stdio npm server", () => {
  const connector = defineConnector({
    id: "acme-db",
    displayName: "Acme DB connector",
    version: "1.2.0",
    server: {
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { ACME_DB_URL: "${env:ACME_DB_URL}", ACME_DB_TOKEN: "${env:ACME_DB_TOKEN}" },
      auth: { type: "bearerEnv", bearerEnvVar: "ACME_DB_TOKEN" },
    },
    publish: {
      registryNamespace: "io.github.acme",
      packageName: "@acme/acme-db-mcp",
      author: { name: "Acme Inc" },
    },
  });

  it("emits a conformant server.json describing the REAL package (no serve wrapper)", () => {
    const j = emit(connector);
    expect(j.$schema).toBe(MCP_SERVER_SCHEMA_URL);
    expect(j.name).toBe("io.github.acme/acme-db");
    expect(j.description).toBe("Acme DB connector");
    expect(j.version).toBe("1.2.0");
    expect(j.packages).toHaveLength(1);
    const pkg = j.packages[0];
    expect(pkg.registryType).toBe("npm");
    expect(pkg.identifier).toBe("@acme/acme-db-mcp"); // the dev's REAL pkg, NOT agent-connector serve
    expect(pkg.registryBaseUrl).toBe("https://registry.npmjs.org");
    expect(pkg.version).toBe("1.2.0");
    expect(pkg.transport).toEqual({ type: "stdio" });
    // never wraps with agent-connector serve: npm packages declare an identifier,
    // not a launch command, and nothing references our wrapper/home-bin.
    expect(pkg.command).toBeUndefined();
    expect(pkg.args).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain("agent-connector");
  });

  it("marks the bearer token env var as secret + required", () => {
    const j = emit(connector);
    const tokenVar = j.packages[0].environmentVariables.find(
      (v: any) => v.name === "ACME_DB_TOKEN",
    );
    expect(tokenVar).toEqual({ name: "ACME_DB_TOKEN", isSecret: true, isRequired: true });
    const plainVar = j.packages[0].environmentVariables.find(
      (v: any) => v.name === "ACME_DB_URL",
    );
    expect(plainVar).toEqual({ name: "ACME_DB_URL" });
  });
});

describe("mcp-server-json — remote (streamable-http)", () => {
  it("emits remotes[] with the spec slug streamable-http for an http server", () => {
    const connector = defineConnector({
      id: "acme-remote",
      version: "0.3.1",
      server: { transport: "http", url: "https://mcp.acme.example/v1" },
      publish: { registryNamespace: "io.github.acme" },
    });
    const j = emit(connector);
    expect(j.packages).toBeUndefined();
    expect(j.remotes).toEqual([{ type: "streamable-http", url: "https://mcp.acme.example/v1" }]);
  });
});

describe("mcp-server-json — guards", () => {
  it("THROWS a clear error when registryNamespace is missing", () => {
    const c = defineConnector({
      id: "no-ns",
      version: "1.0.0",
      server: { transport: "stdio", command: "node" },
    });
    expect(() => packageConnector(c, { outDir: out, format: "mcp-server-json" })).toThrow(
      /registryNamespace/,
    );
  });

  it("THROWS when a stdio server has no published packageName", () => {
    const c = defineConnector({
      id: "no-pkg",
      version: "1.0.0",
      server: { transport: "stdio", command: "node" },
      publish: { registryNamespace: "io.github.acme" },
    });
    expect(() => packageConnector(c, { outDir: out, format: "mcp-server-json" })).toThrow(
      /packageName/,
    );
  });

  it("THROWS when the version is a range (registry rejects ranges)", () => {
    const c = defineConnector({
      id: "ranged",
      version: "^1.0.0",
      server: { transport: "stdio", command: "node" },
      publish: { registryNamespace: "io.github.acme", packageName: "@acme/x" },
    });
    expect(() => packageConnector(c, { outDir: out, format: "mcp-server-json" })).toThrow(
      /concrete SemVer/,
    );
  });

  it("notes (does not throw) the placeholder version 0.0.0", () => {
    const c = defineConnector({
      id: "unset-ver",
      server: { transport: "stdio", command: "node" },
      publish: { registryNamespace: "io.github.acme", packageName: "@acme/x" },
    });
    const res = packageConnector(c, { outDir: out, format: "mcp-server-json" });
    expect(res.notes?.some((n) => n.includes("0.0.0"))).toBe(true);
  });
});

describe("mcp-server-json — excluded from --format all", () => {
  it("is NOT in the FEASIBLE (--format all) set but IS a valid format", async () => {
    const { FEASIBLE_FORMATS, ALL_FORMATS, isPackageFormat } = await import(
      "../../src/core/package.js"
    );
    expect(isPackageFormat("mcp-server-json")).toBe(true);
    expect(ALL_FORMATS).toContain("mcp-server-json");
    expect(FEASIBLE_FORMATS).not.toContain("mcp-server-json");
  });
});
