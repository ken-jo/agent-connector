/**
 * core/remote-transport-telemetry-note — install-time visibility for the
 * per-tool telemetry / remote-transport gap.
 *
 * `shouldWrapForTelemetry` requires stdio transport: a remote (http/sse/ws)
 * MCP server is registered without a telemetry proxy, so per-tool telemetry
 * is never captured for it. This is expected + documented, but previously
 * invisible at install time — the dev only discovered it via an empty ndjson.
 *
 * The installer now emits a `warn` ChangeRecord at the moment a remote-transport
 * server entry is written while telemetry is enabled. This suite is the
 * byte-oracle for that note:
 *
 *   • remote http  + telemetry on (default) → one warn note naming the id/transport
 *   • remote sse   + telemetry on (default) → one warn note naming the id/transport
 *   • remote ws    + telemetry on (default) → one warn note naming the id/transport
 *   • remote http  + telemetry DISABLED     → NO note (user already opted out)
 *   • stdio server + telemetry on (default) → NO note (stdio IS wrapped)
 *
 * Drives the real {@link installConnector} (dry-run) into a throwaway HOME so
 * the real user home and repo tree are never touched (mirrors unset-env-ref-warn.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConnector } from "../../src/core/define-connector.js";
import { installConnector } from "../../src/core/installer.js";
import type { PlatformId, ResolvedConnector, Transport } from "../../src/core/types.js";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
};

let tmpHome: string;
let tmpData: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-remote-tele-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-remote-tele-data-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  delete process.env.AGENT_CONNECTOR_TELEMETRY;
});

afterEach(() => {
  for (const [key, envKey] of [
    ["HOME", "HOME"],
    ["USERPROFILE", "USERPROFILE"],
    ["DATA_DIR", "AGENT_CONNECTOR_DATA_DIR"],
    ["TELEMETRY", "AGENT_CONNECTOR_TELEMETRY"],
  ] as const) {
    const value = SAVED[key];
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
  for (const d of [tmpHome, tmpData]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function remoteConnector(transport: Transport, telemetryEnabled = true): ResolvedConnector {
  return defineConnector({
    id: "acme-remote",
    displayName: "Acme Remote Tools",
    version: "1.0.0",
    server: {
      transport,
      url: "https://acme.example.com/mcp",
    },
    telemetry: { enabled: telemetryEnabled },
  });
}

function stdioConnector(): ResolvedConnector {
  return defineConnector({
    id: "acme-stdio",
    displayName: "Acme Stdio Tools",
    version: "1.0.0",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/mcp"],
    },
    // telemetry defaults to enabled:true
  });
}

async function install(connector: ResolvedConnector, target: PlatformId) {
  return installConnector({
    connector,
    modulePath: join(tmpData, "fake.mjs"),
    scope: "user",
    projectDir: tmpHome,
    targets: [target],
    dryRun: true,
  });
}

const NOTE_RE = /telemetry not captured for .+ — remote \(.+\) transport; per-tool telemetry is stdio-only/;

describe("installer — remote-transport telemetry note", () => {
  it.each(["http", "sse", "ws"] as Transport[])(
    "%s transport + telemetry on → one warn note on a literal-resolving host",
    async (transport) => {
      const result = await install(remoteConnector(transport), "claude-code");
      const notes = result.changes.filter(
        (c) => c.action === "warn" && NOTE_RE.test(c.detail),
      );
      expect(notes).toHaveLength(1);
      expect(notes[0]!.platform).toBe("claude-code");
      expect(notes[0]!.detail).toContain("acme-remote");
      expect(notes[0]!.detail).toContain(transport);
      expect(notes[0]!.detail).toContain("stdio-only");
      // Also surfaced in result.warnings so CLI output shows it.
      expect(result.warnings.some((w) => NOTE_RE.test(w))).toBe(true);
    },
  );

  it("remote http + telemetry DISABLED → NO note", async () => {
    const result = await install(remoteConnector("http", false), "claude-code");
    expect(result.changes.some((c) => c.action === "warn" && NOTE_RE.test(c.detail))).toBe(false);
  });

  it("stdio server + telemetry on → NO note (stdio is wrapped, not skipped)", async () => {
    const result = await install(stdioConnector(), "claude-code");
    expect(result.changes.some((c) => c.action === "warn" && NOTE_RE.test(c.detail))).toBe(false);
    // The server entry IS still written.
    expect(
      result.changes.some(
        (c) => c.platform === "claude-code" && (c.action === "create" || c.action === "update"),
      ),
    ).toBe(true);
  });
});
