import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConnectorFromPath } from "../../src/core/load-connector.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ac-package-metadata-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writePackageJson(body: Record<string, unknown>): void {
  writeFileSync(join(tmp, "package.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

function writeDefineConnectorConfig(body: string): string {
  const sdkUrl = pathToFileURL(join(__dirname, "..", "..", "src", "index.ts")).href;
  const configPath = join(tmp, "agent-connector.config.mjs");
  writeFileSync(
    configPath,
    `import { defineConnector } from ${JSON.stringify(sdkUrl)};\nexport default defineConnector(${body});\n`,
    "utf8",
  );
  return configPath;
}

describe("loadConnectorFromPath package metadata defaults", () => {
  it("lets defineConnector derive identity from the nearest package.json", async () => {
    writePackageJson({
      name: "@acme/acme-db-mcp",
      version: "1.2.3",
      mcpName: "io.github.acme/acme-db",
      bin: { "acme-db": "./bin.mjs" },
    });
    const configPath = writeDefineConnectorConfig(`{
      server: { transport: "stdio", command: "node", args: ["server.mjs"] },
    }`);

    const { connector } = await loadConnectorFromPath(configPath);

    expect(connector.id).toBe("acme-db");
    expect(connector.displayName).toBe("acme-db");
    expect(connector.version).toBe("1.2.3");
    expect(connector.mcp).toEqual({
      packageName: "@acme/acme-db-mcp",
      mcpName: "io.github.acme/acme-db",
      bin: "acme-db",
      hostAlias: "acme-db",
    });
  });

  it("preserves explicit mcp overrides while filling omitted package fields", async () => {
    writePackageJson({
      name: "@acme/acme-db-mcp",
      version: "1.2.3",
      mcpName: "io.github.acme/acme-db",
      bin: { "acme-db": "./bin.mjs" },
    });
    const configPath = writeDefineConnectorConfig(`{
      mcp: { hostAlias: "acme-db-staging" },
      server: { transport: "stdio", command: "node", args: ["server.mjs"] },
    }`);

    const { connector } = await loadConnectorFromPath(configPath);

    expect(connector.id).toBe("acme-db-staging");
    expect(connector.mcp).toEqual({
      packageName: "@acme/acme-db-mcp",
      mcpName: "io.github.acme/acme-db",
      bin: "acme-db",
      hostAlias: "acme-db-staging",
    });
  });

  it("lets an explicit connector version override package.json", async () => {
    writePackageJson({
      name: "@acme/acme-db-mcp",
      version: "1.2.3",
    });
    const configPath = writeDefineConnectorConfig(`{
      version: "9.9.9",
      server: { transport: "stdio", command: "node", args: ["server.mjs"] },
    }`);

    const { connector } = await loadConnectorFromPath(configPath);

    expect(connector.id).toBe("acme-db");
    expect(connector.version).toBe("9.9.9");
  });

  it("applies package metadata defaults to JSON configs too", async () => {
    writePackageJson({
      name: "@upstash/context7-mcp",
      version: "0.7.0",
      mcpName: "io.github.upstash/context7",
      bin: { context7: "./bin.mjs" },
    });
    const configPath = join(tmp, "agent-connector.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        server: { transport: "stdio", command: "node", args: ["server.mjs"] },
      }),
      "utf8",
    );

    const { connector } = await loadConnectorFromPath(configPath);

    expect(connector.id).toBe("context7");
    expect(connector.version).toBe("0.7.0");
    expect(connector.mcp?.packageName).toBe("@upstash/context7-mcp");
    expect(connector.mcp?.mcpName).toBe("io.github.upstash/context7");
  });
});
