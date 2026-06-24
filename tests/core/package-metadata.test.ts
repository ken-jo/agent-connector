import { describe, expect, it } from "vitest";

import {
  deriveHostAliasFromMcpName,
  deriveHostAliasFromPackageName,
  inferNpmPackageFromServer,
  resolveMcpPackageIdentity,
} from "../../src/core/package-metadata.js";

describe("MCP package metadata identity derivation", () => {
  it("derives common host aliases from famous MCP package names", () => {
    expect(
      deriveHostAliasFromPackageName("@modelcontextprotocol/server-filesystem"),
    ).toBe("filesystem");
    expect(deriveHostAliasFromPackageName("@playwright/mcp")).toBe(
      "playwright",
    );
    expect(deriveHostAliasFromPackageName("@upstash/context7-mcp")).toBe(
      "context7",
    );
    expect(deriveHostAliasFromPackageName("@sentry/mcp-server")).toBe("sentry");
    expect(
      deriveHostAliasFromPackageName("@supabase/mcp-server-supabase"),
    ).toBe("supabase");
    expect(deriveHostAliasFromPackageName("@acme/acme-db-mcp")).toBe("acme-db");
    expect(deriveHostAliasFromPackageName("@acme/db-mcp")).toBe("db");
  });

  it("derives aliases from MCP registry names", () => {
    expect(deriveHostAliasFromMcpName("io.github.upstash/context7")).toBe(
      "context7",
    );
    expect(deriveHostAliasFromMcpName("com.supabase/mcp")).toBe("supabase");
    expect(
      deriveHostAliasFromMcpName("io.github.microsoft/playwright-mcp"),
    ).toBe("playwright");
  });

  it("infers an npm package from npx-style server args", () => {
    expect(
      inferNpmPackageFromServer({
        transport: "stdio",
        command: "npx",
        args: ["-y", "@acme/acme-db-mcp"],
      }),
    ).toBe("@acme/acme-db-mcp");
    expect(
      inferNpmPackageFromServer({
        transport: "stdio",
        command: "node",
        args: ["server.js"],
      }),
    ).toBeUndefined();
  });

  it("lets an explicit multi-instance hostAlias override package defaults", () => {
    expect(
      resolveMcpPackageIdentity({
        mcp: {
          packageName: "@github/github-mcp-server",
          hostAlias: "github-octocorp",
        },
      }).hostAlias,
    ).toBe("github-octocorp");
  });
});
