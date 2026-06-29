import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditConnectorPackage } from "../../src/core/package-audit.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ac-package-audit-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writePackageJson(body: Record<string, unknown>): string {
  const path = join(tmp, "package.json");
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return path;
}

function writeConfig(body: string): string {
  const sdkUrl = pathToFileURL(join(__dirname, "..", "..", "src", "index.ts")).href;
  const path = join(tmp, "agent-connector.config.mjs");
  writeFileSync(
    path,
    `import { defineConnector } from ${JSON.stringify(sdkUrl)};\nexport default defineConnector(${body});\n`,
    "utf8",
  );
  return path;
}

function codes(result: Awaited<ReturnType<typeof auditConnectorPackage>>): string[] {
  return result.findings.map((finding) => finding.code);
}

describe("auditConnectorPackage", () => {
  it("passes a package-first branded MCP connector", async () => {
    const packageJsonPath = writePackageJson({
      name: "@acme/acme-db-mcp",
      version: "1.2.3",
      type: "module",
      mcpName: "io.github.acme/acme-db",
      bin: { "acme-db": "./bin.mjs" },
      files: ["bin.mjs", "agent-connector.config.mjs", "server.mjs"],
      dependencies: { "@ken-jo/agent-connector": "^0.4.98" },
    });
    writeFileSync(join(tmp, "bin.mjs"), "#!/usr/bin/env node\n", "utf8");
    writeFileSync(join(tmp, "server.mjs"), "\n", "utf8");
    const connectorPath = writeConfig(`{
      server: { transport: "stdio", command: "node", args: ["server.mjs"] },
    }`);

    const result = await auditConnectorPackage({ packageJsonPath, connectorPath });

    expect(result.ok).toBe(true);
    expect(result.connectorId).toBe("acme-db");
    expect(result.binName).toBe("acme-db");
    expect(result.findings.filter((finding) => finding.severity !== "info")).toEqual([]);
  });

  it("fails when package identity cannot ship as a branded CLI", async () => {
    const packageJsonPath = writePackageJson({
      name: "@acme/broken-mcp",
      type: "module",
    });
    const connectorPath = writeConfig(`{
      id: "broken",
      server: { transport: "stdio", command: "node", args: ["server.mjs"] },
    }`);

    const result = await auditConnectorPackage({ packageJsonPath, connectorPath });

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("missing-version");
    expect(codes(result)).toContain("missing-bin");
    expect(codes(result)).toContain("missing-agent-connector-dependency");
  });

  it("warns when the user-facing bin and connector id drift", async () => {
    const packageJsonPath = writePackageJson({
      name: "@acme/acme-db-example-mcp",
      version: "1.0.0",
      type: "module",
      mcpName: "io.github.acme/acme-db",
      bin: { "acme-db-example": "./bin.mjs" },
      dependencies: { "@ken-jo/agent-connector": "../.." },
    });
    writeFileSync(join(tmp, "bin.mjs"), "#!/usr/bin/env node\n", "utf8");
    const connectorPath = writeConfig(`{
      server: { transport: "stdio", command: "node", args: ["server.mjs"] },
    }`);

    const result = await auditConnectorPackage({ packageJsonPath, connectorPath });

    expect(result.ok).toBe(true);
    expect(codes(result)).toContain("bin-id-drift");
    expect(result.findings.find((finding) => finding.code === "bin-id-drift")?.severity).toBe("warn");
  });
});
