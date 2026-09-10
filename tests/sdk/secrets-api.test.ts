/**
 * sdk — the secrets surface re-exported from `@ken-jo/agent-connector/sdk`.
 *
 * A connector author (or their MCP server) reaches the keystore through the
 * SDK import alone: `openSecretStore`, `findSecretRefs`,
 * `resolveSecretBackendId`, `SECRET_BACKEND_IDS`, the two error classes and
 * the `SecretStore` / `SecretEntry` / `SecretListEntry` / `SecretBackendId` /
 * `BackendAvailability` types. Exercised end-to-end against the `file` backend
 * in a throwaway data root so no OS keystore is touched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as sdk from "../../src/sdk/index.js";
import type {
  BackendAvailability,
  SecretBackendId,
  SecretEntry,
  SecretListEntry,
  SecretStore,
} from "../../src/sdk/index.js";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "ac-sdk-secrets-"));
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("sdk secrets exports", () => {
  it("exposes the documented functions, constants and error classes", () => {
    expect(typeof sdk.openSecretStore).toBe("function");
    expect(typeof sdk.findSecretRefs).toBe("function");
    expect(typeof sdk.resolveSecretBackendId).toBe("function");
    expect(sdk.SECRET_BACKEND_IDS).toEqual(["keychain", "secret-service", "credential-manager", "file"]);
    expect(new sdk.SecretError("invalid-name", "x")).toBeInstanceOf(Error);
    expect(new sdk.SecretError("invalid-name", "x", "h").hint).toBe("h");
    const res = new sdk.SecretResolutionError("acme-db", ["a", "b"]);
    expect(res).toBeInstanceOf(Error);
    expect(res.missing).toEqual(["a", "b"]);
    expect(res.message).toContain('connector "acme-db": 2 secrets not set: a, b');
  });

  it("findSecretRefs + resolveSecretBackendId behave as the core module does", () => {
    expect(sdk.findSecretRefs({ A: "${secret:api-key}", B: "plain ${env:X}", C: "${secret:api-key}" })).toEqual([
      "api-key",
    ]);
    const backend: SecretBackendId = sdk.resolveSecretBackendId("file");
    expect(backend).toBe("file");
    expect(() => sdk.resolveSecretBackendId("vault")).toThrow(sdk.SecretError);
  });

  it("openSecretStore round-trips through the file backend with the exported types", () => {
    const store: SecretStore = sdk.openSecretStore({ connectorId: "acme-db", backend: "file", dataRoot });
    expect(store.connectorId).toBe("acme-db");
    expect(store.backend).toBe("file");

    const availability: BackendAvailability = store.availability();
    expect(availability.ok).toBe(true);

    expect(store.get("api-key")).toBeNull();
    expect(store.has("api-key")).toBe(false);

    const entry: SecretEntry = store.set("api-key", "value-1");
    expect(entry).toMatchObject({ name: "api-key", backend: "file" });
    expect(store.get("api-key")).toBe("value-1");
    expect(store.has("api-key")).toBe(true);

    const listed: SecretListEntry[] = store.list();
    expect(listed.map((e) => [e.name, e.backend, e.present])).toEqual([["api-key", "file", true]]);

    expect(store.selfTest()).toMatchObject({ ok: true, backend: "file" });
    expect(store.delete("api-key")).toBe(true);
    expect(store.delete("api-key")).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("rejects an empty value and an invalid name with SecretError", () => {
    const store = sdk.openSecretStore({ connectorId: "acme-db", backend: "file", dataRoot });
    expect(() => store.set("api-key", "")).toThrow(sdk.SecretError);
    expect(() => store.set("bad name", "v")).toThrow(sdk.SecretError);
  });
});
