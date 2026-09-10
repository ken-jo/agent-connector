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

  it("prefers an explicit MCP registry name over a package wrapper name", () => {
    expect(
      resolveMcpPackageIdentity({
        mcp: {
          packageName: "@acme/acme-db-example-mcp",
          mcpName: "io.github.acme/acme-db",
          bin: "acme-db-example",
        },
      }).hostAlias,
    ).toBe("acme-db");
  });
});

describe("package metadata context — shared across framework copies", () => {
  it("keeps the AsyncLocalStorage on globalThis under a well-known key", async () => {
    const { PACKAGE_METADATA_CONTEXT_KEY, withConnectorPackageMetadata, currentConnectorPackageMetadata } =
      await import("../../src/core/package-metadata.js");
    expect(PACKAGE_METADATA_CONTEXT_KEY).toBe(Symbol.for("@ken-jo/agent-connector:package-metadata-context"));
    const store = (globalThis as Record<symbol, unknown>)[PACKAGE_METADATA_CONTEXT_KEY] as {
      getStore(): unknown;
    };
    expect(typeof store.getStore).toBe("function");
    // A second copy of the framework would read the same store: what this copy
    // puts in scope is visible through the global handle.
    await withConnectorPackageMetadata({ version: "9.9.9" }, async () => {
      expect(store.getStore()).toEqual({ version: "9.9.9" });
      expect(currentConnectorPackageMetadata()).toEqual({ version: "9.9.9" });
    });
  });
});
