import { describe, it, expect } from "vitest";
import {
  defineConnector,
  ConnectorConfigError,
} from "../../src/core/define-connector.js";
import type { ConnectorConfig } from "../../src/core/types.js";

describe("defineConnector — normalization of a valid config", () => {
  it("applies all defaults for a minimal stdio server connector", () => {
    const resolved = defineConnector({
      id: "acme-db",
      server: { transport: "stdio", command: "npx", args: ["-y", "@acme/db-mcp"] },
    });

    // displayName defaults to id
    expect(resolved.displayName).toBe("acme-db");
    // version default
    expect(resolved.version).toBe("0.0.0");

    // telemetry defaults
    expect(resolved.telemetry.enabled).toBe(true);
    expect(resolved.telemetry.modelFamilyHint).toBe("auto");
    expect(resolved.telemetry.measureToolDefs).toBe(true);
    expect(resolved.telemetry.store).toBe("ndjson");
    expect(resolved.telemetry.calibration.anthropicCountTokens).toBe(false);

    // server defaults
    expect(resolved.server).toBeDefined();
    expect(resolved.server!.enabled).toBe(true);
    expect(resolved.server!.tools).toEqual({ include: ["*"] });
    // stdio → wrapForTelemetry defaults true
    expect(resolved.server!.wrapForTelemetry).toBe(true);

    // empty hooks / no events / default platforms / default targets
    expect(resolved.hooks).toEqual({});
    expect(resolved.hookEvents).toEqual([]);
    expect(resolved.platforms).toEqual({});
    expect(resolved.targets).toBe("auto");
  });

  it("preserves explicit displayName, version, and telemetry overrides", () => {
    const resolved = defineConnector({
      id: "acme-db",
      displayName: "Acme DB Tools",
      version: "1.2.3",
      server: { transport: "stdio", command: "node", args: ["s.js"] },
      telemetry: {
        enabled: false,
        modelFamilyHint: "anthropic",
        measureToolDefs: false,
        store: "sqlite",
        calibration: { anthropicCountTokens: true },
      },
    });
    expect(resolved.displayName).toBe("Acme DB Tools");
    expect(resolved.version).toBe("1.2.3");
    expect(resolved.telemetry.enabled).toBe(false);
    expect(resolved.telemetry.modelFamilyHint).toBe("anthropic");
    expect(resolved.telemetry.measureToolDefs).toBe(false);
    expect(resolved.telemetry.store).toBe("sqlite");
    expect(resolved.telemetry.calibration.anthropicCountTokens).toBe(true);
  });

  it("defaults wrapForTelemetry to false for a remote (http) server", () => {
    const resolved = defineConnector({
      id: "remote-conn",
      server: { transport: "http", url: "https://api.example.com/mcp" },
    });
    expect(resolved.server!.wrapForTelemetry).toBe(false);
    expect(resolved.server!.enabled).toBe(true);
    expect(resolved.server!.tools).toEqual({ include: ["*"] });
  });

  it("respects an explicit wrapForTelemetry=false on a stdio server", () => {
    const resolved = defineConnector({
      id: "no-wrap",
      server: {
        transport: "stdio",
        command: "node",
        args: ["s.js"],
        wrapForTelemetry: false,
      },
    });
    expect(resolved.server!.wrapForTelemetry).toBe(false);
  });

  it("preserves an explicit tools filter rather than the default", () => {
    const resolved = defineConnector({
      id: "filtered",
      server: {
        transport: "stdio",
        command: "node",
        tools: { include: ["a", "b"], exclude: ["c"] },
      },
    });
    expect(resolved.server!.tools).toEqual({ include: ["a", "b"], exclude: ["c"] });
  });

  it("omits server entirely for a hooks-only connector", () => {
    const resolved = defineConnector({
      id: "hooks-only",
      hooks: {
        PreToolUse: { handler: () => ({ decision: "allow" }) },
      },
    });
    expect(resolved.server).toBeUndefined();
  });
});

describe("defineConnector — hookEvents lists only events with a handler", () => {
  it("lists only the events that declare a handler function", () => {
    const resolved = defineConnector({
      id: "hooked",
      server: { transport: "stdio", command: "node" },
      hooks: {
        PreToolUse: { matcher: "x", handler: () => ({ decision: "allow" }) },
        Stop: { handler: () => {} },
      },
    });
    expect(resolved.hookEvents.sort()).toEqual(["PreToolUse", "Stop"].sort());
    // Events without a handler are not present.
    expect(resolved.hookEvents).not.toContain("PostToolUse");
    expect(resolved.hookEvents).not.toContain("SessionStart");
  });

  it("returns an empty hookEvents array when no hooks are declared", () => {
    const resolved = defineConnector({
      id: "no-hooks",
      server: { transport: "stdio", command: "node" },
    });
    expect(resolved.hookEvents).toEqual([]);
  });

  it("preserves the canonical event ordering in hookEvents", () => {
    const resolved = defineConnector({
      id: "ordered",
      hooks: {
        Stop: { handler: () => {} },
        SessionStart: { handler: () => {} },
        PreToolUse: { handler: () => {} },
      },
    });
    // ALL_EVENTS order: SessionStart ... PreToolUse ... Stop
    expect(resolved.hookEvents).toEqual(["SessionStart", "PreToolUse", "Stop"]);
  });
});

describe("defineConnector — validation errors", () => {
  it("throws ConnectorConfigError when config is not an object", () => {
    expect(() => defineConnector(null as unknown as ConnectorConfig)).toThrow(
      ConnectorConfigError,
    );
    expect(() =>
      defineConnector(undefined as unknown as ConnectorConfig),
    ).toThrow(ConnectorConfigError);
  });

  it("throws on a missing id", () => {
    expect(() =>
      defineConnector({
        server: { transport: "stdio", command: "node" },
      } as unknown as ConnectorConfig),
    ).toThrow(ConnectorConfigError);
  });

  it("throws on a bad (non-kebab-case) id", () => {
    for (const badId of ["Acme_DB", "ACME", "-leading", "has space", ""]) {
      expect(() =>
        defineConnector({
          id: badId,
          server: { transport: "stdio", command: "node" },
        }),
      ).toThrow(ConnectorConfigError);
    }
  });

  it("accepts a well-formed kebab-case id", () => {
    expect(() =>
      defineConnector({
        id: "acme-db-2",
        server: { transport: "stdio", command: "node" },
      }),
    ).not.toThrow();
  });

  it("throws when neither server nor hooks is declared", () => {
    expect(() =>
      defineConnector({ id: "empty" } as unknown as ConnectorConfig),
    ).toThrow(ConnectorConfigError);
  });

  it("throws on a stdio server without a command", () => {
    expect(() =>
      defineConnector({
        id: "no-cmd",
        server: { transport: "stdio" } as unknown as ConnectorConfig["server"],
      }),
    ).toThrow(ConnectorConfigError);
  });

  it("throws on an http server without a url", () => {
    expect(() =>
      defineConnector({
        id: "no-url",
        server: { transport: "http" } as unknown as ConnectorConfig["server"],
      }),
    ).toThrow(ConnectorConfigError);
  });

  it("throws on an sse server without a url", () => {
    expect(() =>
      defineConnector({
        id: "no-url-sse",
        server: { transport: "sse" } as unknown as ConnectorConfig["server"],
      }),
    ).toThrow(ConnectorConfigError);
  });

  it("throws when a declared hook's handler is not a function", () => {
    expect(() =>
      defineConnector({
        id: "bad-handler",
        hooks: {
          PreToolUse: { handler: "nope" } as unknown as never,
        },
      }),
    ).toThrow(ConnectorConfigError);
  });

  it("error message is namespaced and the error name is set", () => {
    try {
      defineConnector({ id: "Bad Id" } as unknown as ConnectorConfig);
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConnectorConfigError);
      expect((e as ConnectorConfigError).name).toBe("ConnectorConfigError");
      expect((e as ConnectorConfigError).message).toContain(
        "Invalid connector config:",
      );
    }
  });
});
