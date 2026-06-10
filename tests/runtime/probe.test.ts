/**
 * tests/runtime/probe — the live MCP lifecycle probe behind `doctor --probe`.
 *
 * Drives probeStdioServer against a tiny fake stdio MCP server (NDJSON JSON-RPC)
 * and asserts the initialize → capabilities → ping → tools/list steps, the
 * tools-capability gate, and the fail-fast path for an unlaunchable command.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { probeStdioServer } from "../../src/runtime/probe.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ac-probe-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a fake NDJSON stdio MCP server; `caps` is the initialize capabilities object. */
function fakeServer(caps: string, tools = "[{\"name\":\"a\"},{\"name\":\"b\"}]"): string {
  const path = join(dir, "fake-server.mjs");
  writeFileSync(
    path,
    `let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === "initialize")
      reply(m.id, { protocolVersion: "2025-06-18", capabilities: ${caps}, serverInfo: { name: "FakeServer", version: "9.9.9" } });
    else if (m.method === "ping") reply(m.id, {});
    else if (m.method === "tools/list") reply(m.id, { tools: ${tools} });
  }
});
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
`,
    "utf8",
  );
  return path;
}

describe("probeStdioServer", () => {
  it("runs initialize → capabilities → ping → tools/list against a live server", async () => {
    const server = fakeServer("{ tools: {} }");
    const results = await probeStdioServer(process.execPath, [server], {
      label: "acme-db",
      timeoutMs: 3000,
    });
    const byCheck = Object.fromEntries(results.map((r) => [r.check, r]));

    expect(byCheck["acme-db: MCP initialize"].status).toBe("pass");
    expect(byCheck["acme-db: MCP initialize"].message).toContain("FakeServer@9.9.9");
    expect(byCheck["acme-db: MCP initialize"].message).toContain("2025-06-18");
    expect(byCheck["acme-db: capabilities"].message).toContain("tools");
    expect(byCheck["acme-db: ping"].status).toBe("pass");
    expect(byCheck["acme-db: tools/list"].status).toBe("pass");
    expect(byCheck["acme-db: tools/list"].message).toBe("2 tool(s)");
    // every step passed → no FAIL
    expect(results.some((r) => r.status === "fail")).toBe(false);
  });

  it("SKIPS tools/list (warn) when the server advertises no tools capability", async () => {
    const server = fakeServer("{ resources: {} }");
    const results = await probeStdioServer(process.execPath, [server], { timeoutMs: 3000 });
    const toolsRow = results.find((r) => r.check.includes("tools/list"));
    expect(toolsRow?.status).toBe("warn");
    expect(toolsRow?.message).toContain("skipped");
  });

  it("FAILs fast with an actionable fix when the server command is not launchable", async () => {
    const results = await probeStdioServer("agent-connector-no-such-binary-xyz", [], {
      label: "broken",
      timeoutMs: 3000,
    });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("fail");
    expect(results[0].check).toBe("broken: MCP initialize");
    expect(results[0].message).toMatch(/not launchable/);
    expect(results[0].fix).toContain("PATH");
  });
});
