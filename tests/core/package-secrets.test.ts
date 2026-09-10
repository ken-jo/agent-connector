/**
 * core/package — bundles never carry a secret ref or value.
 *
 * For a connector whose server env references `${secret:NAME}` (telemetry
 * OFF, so only the secret forces the wrapper), every feasible format emits
 * the serve wrapper with `--secret-env NAME={secret:X}` placeholders, keeps
 * only the plain entries in the entry's `env`, and no emitted file contains
 * a `${secret:` ref. A secret-free, telemetry-off connector stays unwrapped.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { FEASIBLE_FORMATS, packageConnector } from "../../src/core/package.js";
import type { PackageFormat } from "../../src/core/package.js";
import { HOME_BIN } from "../support/env.js";

const CONNECTOR_ID = "acme-secrets";
const REAL = ["npx", "-y", "@acme/db-mcp", "--flag"];

/** Formats that render an MCP server entry at all (npm-plugin ships source, no host config). */
const MCP_FORMATS: readonly PackageFormat[] = FEASIBLE_FORMATS.filter((f) => f !== "npm-plugin");

interface McpEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Every `mcpServers` entry found in the emitted JSON files. */
function mcpEntries(files: string[]): Array<{ file: string; name: string; entry: McpEntry }> {
  const out: Array<{ file: string; name: string; entry: McpEntry }> = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const servers = (parsed as { mcpServers?: Record<string, McpEntry> } | null)?.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    for (const [name, entry] of Object.entries(servers)) out.push({ file, name, entry });
  }
  return out;
}

let savedHome: string | undefined;
let savedDataDir: string | undefined;
let outDir: string;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  outDir = mkdtempSync(join(tmpdir(), "ac-pkg-secrets-"));
  process.env.HOME = outDir;
  process.env.USERPROFILE = outDir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(outDir, ".agent-connector");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedDataDir === undefined) delete process.env.AGENT_CONNECTOR_DATA_DIR;
  else process.env.AGENT_CONNECTOR_DATA_DIR = savedDataDir;
  rmSync(outDir, { recursive: true, force: true });
});

describe("packageConnector + secretEnv", () => {
  it("emits the serve wrapper with placeholders in every MCP-bearing format, refs in none", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      telemetry: { enabled: false },
      server: {
        transport: "stdio",
        command: REAL[0]!,
        args: REAL.slice(1),
        env: { API_TOKEN: "${secret:ACME_TOKEN}", REGION: "eu" },
      },
    });

    for (const format of FEASIBLE_FORMATS) {
      const res = packageConnector(connector, {
        outDir: join(outDir, format),
        format,
        homeBinPath: HOME_BIN,
      });
      for (const file of res.files) {
        expect(readFileSync(file, "utf8"), `${format}: ${file}`).not.toContain("${secret:");
      }
      if (!MCP_FORMATS.includes(format)) continue;

      const entries = mcpEntries(res.files).filter((e) => e.name === CONNECTOR_ID);
      expect(entries.length, `${format}: no mcpServers entry`).toBeGreaterThan(0);
      for (const { file, entry } of entries) {
        const args = entry.args ?? [];
        const sep = args.indexOf("--");
        expect(sep, `${format}: ${file} has no serve wrapper`).toBeGreaterThan(0);
        expect(args, `${format}: ${file}`).toContain("serve");
        expect(args.slice(sep - 2, sep), `${format}: ${file}`).toEqual([
          "--secret-env",
          "API_TOKEN={secret:ACME_TOKEN}",
        ]);
        expect(args.slice(sep + 1), `${format}: ${file}`).toEqual(REAL);
        // Only the plain entry is written as env; the secret never is.
        expect(entry.env ?? {}, `${format}: ${file}`).toEqual({ REGION: "eu" });
      }
    }
  });

  it("leaves a telemetry-off, secret-free connector unwrapped (regression)", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      telemetry: { enabled: false },
      server: {
        transport: "stdio",
        command: REAL[0]!,
        args: REAL.slice(1),
        env: { REGION: "eu" },
      },
    });
    for (const format of MCP_FORMATS) {
      const res = packageConnector(connector, {
        outDir: join(outDir, format),
        format,
        homeBinPath: HOME_BIN,
      });
      const entries = mcpEntries(res.files).filter((e) => e.name === CONNECTOR_ID);
      expect(entries.length, `${format}: no mcpServers entry`).toBeGreaterThan(0);
      for (const { file, entry } of entries) {
        expect(entry.args ?? [], `${format}: ${file}`).not.toContain("serve");
        expect(entry.args ?? [], `${format}: ${file}`).not.toContain("--secret-env");
        expect(entry.env, `${format}: ${file}`).toEqual({ REGION: "eu" });
      }
    }
  });
});
