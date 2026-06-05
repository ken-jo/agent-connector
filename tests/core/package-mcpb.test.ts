/**
 * tests/core/package-mcpb — the `mcpb` format emits a conformant MCPB bundle
 * manifest.json (self-contained node shape) + a packaging recipe, routing
 * secrets through user_config. It does NOT build the .mcpb zip (the dev's step).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { packageConnector, readPackagedJson } from "../../src/core/package.js";
import { MCPB_MANIFEST_VERSION } from "../../src/core/mcp-standard.js";

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "ac-mcpb-"));
});
afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

describe("mcpb — stdio node server", () => {
  const connector = defineConnector({
    id: "acme-db",
    displayName: "Acme DB connector",
    version: "1.2.0",
    server: {
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { ACME_DB_URL: "https://db.acme.example", ACME_DB_TOKEN: "${env:ACME_DB_TOKEN}" },
      auth: { type: "bearerEnv", bearerEnvVar: "ACME_DB_TOKEN" },
    },
    publish: { author: { name: "Acme Inc", email: "dev@acme.example" } },
  });

  it("emits a conformant manifest.json + README recipe", () => {
    const res = packageConnector(connector, { outDir: out, format: "mcpb" });
    expect(res.files.some((f) => f.endsWith("manifest.json"))).toBe(true);
    expect(res.files.some((f) => f.endsWith("README.md"))).toBe(true);

    const m = readPackagedJson<Record<string, any>>(join(out, "manifest.json"))!;
    expect(m.manifest_version).toBe(MCPB_MANIFEST_VERSION);
    expect(m.name).toBe("acme-db");
    expect(m.version).toBe("1.2.0");
    expect(m.author).toEqual({ name: "Acme Inc", email: "dev@acme.example" });
    expect(m.server.type).toBe("node");
    expect(m.server.entry_point).toBe("server/index.js");
    expect(m.server.mcp_config.command).toBe("node");
    expect(m.server.mcp_config.args).toEqual(["${__dirname}/server/index.js"]);
  });

  it("routes the secret env var through user_config (keychain), not inline", () => {
    packageConnector(connector, { outDir: out, format: "mcpb" });
    const m = readPackagedJson<Record<string, any>>(join(out, "manifest.json"))!;
    // secret token → ${user_config.<key>}; plain var passes through
    expect(m.server.mcp_config.env.ACME_DB_TOKEN).toBe("${user_config.acme_db_token}");
    expect(m.server.mcp_config.env.ACME_DB_URL).toBe("https://db.acme.example");
    expect(m.user_config.acme_db_token).toEqual({
      type: "string",
      title: "Acme Db Token",
      description: "Value for ACME_DB_TOKEN",
      sensitive: true,
      required: true,
    });
  });

  it("notes that it does not build the .mcpb zip (dev's pack step)", () => {
    const res = packageConnector(connector, { outDir: out, format: "mcpb" });
    expect(res.notes?.some((n) => n.includes("does NOT build the .mcpb zip"))).toBe(true);
  });
});

describe("mcpb — guards", () => {
  it("THROWS when publish.author.name is missing (manifest requires author)", () => {
    const c = defineConnector({
      id: "no-author",
      version: "1.0.0",
      server: { transport: "stdio", command: "node" },
    });
    expect(() => packageConnector(c, { outDir: out, format: "mcpb" })).toThrow(/author/);
  });

  it("THROWS for a remote server (MCPB is for local stdio servers)", () => {
    const c = defineConnector({
      id: "remote",
      version: "1.0.0",
      server: { transport: "http", url: "https://x.example" },
      publish: { author: { name: "Acme" } },
    });
    expect(() => packageConnector(c, { outDir: out, format: "mcpb" })).toThrow(/stdio/);
  });
});

describe("mcpb — opt-in (excluded from --format all)", () => {
  it("is a valid format, in ALL_FORMATS but not FEASIBLE_FORMATS", async () => {
    const { FEASIBLE_FORMATS, ALL_FORMATS, isPackageFormat } = await import(
      "../../src/core/package.js"
    );
    expect(isPackageFormat("mcpb")).toBe(true);
    expect(ALL_FORMATS).toContain("mcpb");
    expect(FEASIBLE_FORMATS).not.toContain("mcpb");
  });

  it("plans files under dryRun without touching disk", () => {
    const c = defineConnector({
      id: "dry",
      version: "1.0.0",
      server: { transport: "stdio", command: "node" },
      publish: { author: { name: "Acme" } },
    });
    const res = packageConnector(c, { outDir: out, format: "mcpb", dryRun: true });
    expect(res.files.length).toBeGreaterThan(0);
    for (const f of res.files) expect(existsSync(f)).toBe(false);
  });
});
