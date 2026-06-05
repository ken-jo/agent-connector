/**
 * tests/core/mcp-standard — the pinned MCP-standard constants + emit-time guards
 * and the `publish` config validation they back.
 */

import { describe, expect, it } from "vitest";

import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_SCHEMA_URL,
  MCPB_MANIFEST_VERSION,
  REGISTRY_NAME_RE,
  isConcreteSemver,
  isPlaceholderVersion,
  registryTransportType,
} from "../../src/core/mcp-standard.js";
import { defineConnector, ConnectorConfigError } from "../../src/core/define-connector.js";

describe("pinned constants", () => {
  it("hold the verified current values", () => {
    expect(MCP_SERVER_SCHEMA_URL).toBe(
      "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    );
    expect(MCPB_MANIFEST_VERSION).toBe("0.3");
    expect(MCP_PROTOCOL_VERSION).toBe("2025-06-18");
  });
});

describe("registryTransportType — our Transport → server.json slug", () => {
  it("maps stdio/http/sse and REJECTS non-spec ws", () => {
    expect(registryTransportType("stdio")).toBe("stdio");
    expect(registryTransportType("http")).toBe("streamable-http");
    expect(registryTransportType("sse")).toBe("sse");
    // ws is not an MCP spec transport — a conformant artifact must reject it.
    expect(registryTransportType("ws")).toBeNull();
  });
});

describe("version guards", () => {
  it("accepts concrete SemVer and rejects ranges", () => {
    expect(isConcreteSemver("1.0.0")).toBe(true);
    expect(isConcreteSemver("1.2.3-beta.1")).toBe(true);
    expect(isConcreteSemver("1.2.3+build.5")).toBe(true);
    expect(isConcreteSemver("0.0.0")).toBe(true);
    for (const bad of ["^1.2.3", "~1.2.3", ">=1.2.3", "1.x", "1.*", "1.2", "latest"]) {
      expect(isConcreteSemver(bad), bad).toBe(false);
    }
  });

  it("flags the unset placeholder version", () => {
    expect(isPlaceholderVersion("0.0.0")).toBe(true);
    expect(isPlaceholderVersion("1.0.0")).toBe(false);
  });
});

describe("REGISTRY_NAME_RE — server.json name", () => {
  it("requires exactly one '/' separating namespace from server-name", () => {
    expect(REGISTRY_NAME_RE.test("io.github.acme/acme-db")).toBe(true);
    expect(REGISTRY_NAME_RE.test("com.acme/acme-db")).toBe(true);
    expect(REGISTRY_NAME_RE.test("acme-db")).toBe(false); // no namespace
    expect(REGISTRY_NAME_RE.test("io.github.acme/a/b")).toBe(false); // two slashes
  });
});

describe("defineConnector — publish validation", () => {
  const base = { id: "acme-db", server: { transport: "stdio" as const, command: "node" } };

  it("accepts a well-formed publish block", () => {
    const c = defineConnector({
      ...base,
      publish: {
        registryNamespace: "io.github.acme",
        packageName: "@acme/acme-db-mcp",
        author: { name: "Acme Inc", email: "dev@acme.example" },
      },
    });
    expect(c.publish?.registryNamespace).toBe("io.github.acme");
    expect(c.publish?.author?.name).toBe("Acme Inc");
  });

  it("rejects a namespace with an illegal char (underscore / slash)", () => {
    expect(() =>
      defineConnector({ ...base, publish: { registryNamespace: "io.github.acme/db" } }),
    ).toThrow(ConnectorConfigError);
    expect(() =>
      defineConnector({ ...base, publish: { registryNamespace: "io.github.acme_db" } }),
    ).toThrow(ConnectorConfigError);
  });

  it("rejects an author with no name", () => {
    expect(() =>
      // @ts-expect-error — exercising the runtime guard with a bad shape
      defineConnector({ ...base, publish: { author: { email: "x@y.z" } } }),
    ).toThrow(ConnectorConfigError);
  });

  it("omits publish entirely when not provided", () => {
    expect(defineConnector(base).publish).toBeUndefined();
  });
});
