/**
 * core/yaml — round-trip / fail-soft / dryRun tests for the minimal YAML config IO
 * used by the YAML-native adapters (Goose, Hermes).
 *
 * The contract mirrors BaseAdapter's readJson/writeJson:
 *   • writeYaml then readYaml round-trips a plain object (parse(stringify(x)) === x).
 *   • readYaml returns null for a missing file (treat-as-absent, never throws).
 *   • writeYaml with dryRun=true writes nothing (no file is created on disk).
 *
 * Filesystem isolation: each test gets a fresh os.tmpdir mkdtemp dir, removed in
 * afterEach so nothing leaks. We assert against REAL files on disk, and confirm
 * the on-disk bytes are valid YAML by parsing them with the `yaml` package directly.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";

import { readYaml, writeYaml } from "../../src/core/yaml.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ac-yaml-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("core/yaml", () => {
  it("writeYaml then readYaml round-trips an object (and writes parseable YAML to disk)", () => {
    const path = join(dir, "config.yaml");
    const data = {
      mcp_servers: {
        "acme-db": { command: "npx", args: ["-y", "@x/y"], env: { ACME: "1" } },
      },
      extensions: { foo: { type: "stdio", cmd: "bar", args: [], timeout: 300, enabled: true } },
      nested: { a: [1, 2, 3], b: { c: true, d: null } },
    };

    writeYaml(path, data);
    expect(existsSync(path)).toBe(true);

    // readYaml gives back a structurally identical object.
    const back = readYaml<typeof data>(path);
    expect(back).toEqual(data);

    // The bytes on disk are valid YAML (independent parse via the `yaml` package).
    const reparsed = parse(readFileSync(path, "utf8"));
    expect(reparsed).toEqual(data);
  });

  it("creates parent directories as needed when writing", () => {
    const path = join(dir, "deep", "nested", "config.yaml");
    writeYaml(path, { hello: "world" });
    expect(existsSync(path)).toBe(true);
    expect(readYaml(path)).toEqual({ hello: "world" });
  });

  it("readYaml returns null for a missing file", () => {
    const missing = join(dir, "does-not-exist.yaml");
    expect(existsSync(missing)).toBe(false);
    expect(readYaml(missing)).toBeNull();
  });

  it("readYaml returns null (fail-soft) for a corrupt YAML file", () => {
    const path = join(dir, "corrupt.yaml");
    // Unbalanced/invalid YAML that the parser rejects.
    writeFileSync(path, "key: [unterminated\n  : :: :\n", "utf8");
    expect(readYaml(path)).toBeNull();
  });

  it("readYaml normalizes an empty document to null", () => {
    const path = join(dir, "empty.yaml");
    writeFileSync(path, "", "utf8");
    expect(readYaml(path)).toBeNull();
  });

  it("writeYaml with dryRun=true writes nothing", () => {
    const path = join(dir, "dry.yaml");
    writeYaml(path, { should: "not-exist" }, true);
    expect(existsSync(path)).toBe(false);
    // And reading the (still-absent) file yields null.
    expect(readYaml(path)).toBeNull();
  });
});
