/**
 * tests/cli/doctor-explain — the `doctor --explain` per-(host, event) surface.
 *
 * `doctor` is coarse ("any hook present = OK"); `--explain` is the additive,
 * OFFLINE detail layer that reports each declared (host, event) pair as
 * honored / degraded / dropped with the simulate()-grade reason — the
 * trustworthy per-event verdict the README-pointed `explain()` matrix could not
 * give. Plain `doctor` behavior is unchanged (asserted by the other doctor tests).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/app.js";

function captureStdout(): { restore: () => void; text: () => string } {
  let out = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
  return { restore: () => spy.mockRestore(), text: () => out };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ac-doctor-explain-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Write a `.mjs` connector (handlers are functions → cannot be JSON) that
 * resolves defineConnector from the SOURCE entrypoint, so the test runs against
 * the in-repo build, not the published package.
 */
function writeConnector(body: string): string {
  const sdkUrl = pathToFileURL(
    join(__dirname, "..", "..", "src", "index.ts"),
  ).href;
  const p = join(tmp, "agent-connector.config.mjs");
  writeFileSync(
    p,
    `import { defineConnector } from ${JSON.stringify(sdkUrl)};\nexport default defineConnector(${body});\n`,
    "utf8",
  );
  return p;
}

describe("doctor --explain — per-(host, event) honor", () => {
  it("reports a Stop-only connector as honored/degraded/dropped per host", async () => {
    const cfg = writeConnector(`{
      id: "explain-cli-stop",
      hooks: { Stop: { handler: () => ({ decision: "deny", reason: "go" }) } },
      targets: ["claude-code", "codex", "crush", "warp"],
    }`);
    const cap = captureStdout();
    const code = await main(["doctor", "--explain", "--connector", cfg]);
    cap.restore();
    const out = cap.text();

    expect(out).toContain("explain-cli-stop — per-event hook honor:");
    // claude-code fires Stop and carries the continuation intent.
    expect(out).toMatch(/\[honored\] claude-code \/ Stop/);
    // codex fires Stop but drops the deny.
    expect(out).toMatch(/\[degraded\] codex \/ Stop .*drops deny on Stop/);
    // crush cannot fire Stop (the false-green host) — dropped.
    expect(out).toMatch(/\[dropped\] crush \/ Stop .*no Stop equivalent/);
    // warp is mcp-only — dropped.
    expect(out).toMatch(/\[dropped\] warp \/ Stop .*mcp-only/);
    // codex (an EXPLICITLY-targeted host) DEGRADES the deny → exit 1. The
    // dropped crush/warp cells alone would NOT fail — only the degraded one does.
    expect(out).toMatch(/DEGRADED on an explicitly-targeted host/);
    expect(code).toBe(1);
  });

  it("REGRESSION: the Stop-only-on-crush cell is dropped, never honored", async () => {
    const cfg = writeConnector(`{
      id: "explain-cli-regress",
      hooks: { Stop: { handler: () => ({ decision: "deny", reason: "go" }) } },
      targets: ["crush"],
    }`);
    const cap = captureStdout();
    await main(["doctor", "--explain", "--connector", cfg]);
    cap.restore();
    const out = cap.text();
    expect(out).toMatch(/\[dropped\] crush \/ Stop/);
    expect(out).not.toMatch(/\[honored\] crush \/ Stop/);
  });

  it("exits 0 and reports cleanly when every declared event is honored", async () => {
    const cfg = writeConnector(`{
      id: "explain-cli-clean",
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      targets: ["claude-code"],
    }`);
    const cap = captureStdout();
    const code = await main(["doctor", "--explain", "--connector", cfg]);
    cap.restore();
    const out = cap.text();
    expect(out).toMatch(/\[honored\] claude-code \/ PreToolUse/);
    expect(out).toContain("every declared hook event is honored");
    expect(code).toBe(0);
  });

  it("reports the no-hooks case without failing", async () => {
    const cfg = writeConnector(`{
      id: "explain-cli-nohooks",
      server: { transport: "stdio", command: "node" },
      targets: ["claude-code"],
    }`);
    const cap = captureStdout();
    const code = await main(["doctor", "--explain", "--connector", cfg]);
    cap.restore();
    expect(cap.text()).toContain("(connector declares no hooks)");
    expect(code).toBe(0);
  });

  it("--json emits the per-(host, event) verdict array", async () => {
    const cfg = writeConnector(`{
      id: "explain-cli-json",
      hooks: { Stop: { handler: () => ({ decision: "deny", reason: "go" }) } },
      targets: ["crush"],
    }`);
    const cap = captureStdout();
    await main(["doctor", "--explain", "--json", "--connector", cfg]);
    cap.restore();
    const parsed = JSON.parse(cap.text());
    expect(Array.isArray(parsed)).toBe(true);
    const entry = parsed.find(
      (e: { connector: string }) => e.connector === "explain-cli-json",
    );
    expect(entry).toBeTruthy();
    const row = entry.rows.find(
      (r: { host: string; event: string }) => r.host === "crush" && r.event === "Stop",
    );
    expect(row.verdict).toBe("dropped");
  });
});

describe("doctor --explain — scope-aware exit semantics (footgun fix)", () => {
  it("REGRESSION: a DEFAULT (targets:auto) hooks connector exits 0 despite mcp-only drops", async () => {
    // The footgun: a healthy default connector declaring one benign hook used to
    // exit 1 purely because ~9 mcp-only hosts architecturally cannot fire hooks.
    // dropped is EXPECTED (mirrors install's skip = exit 0) — fleet-wide gaps must
    // NOT fail the command.
    const cfg = writeConnector(`{
      id: "explain-cli-auto",
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    }`);
    const cap = captureStdout();
    const code = await main(["doctor", "--explain", "--connector", cfg]);
    cap.restore();
    const out = cap.text();
    // The matrix still shows the mcp-only drops (visibility unchanged)…
    expect(out).toMatch(/\[dropped\] warp \/ PreToolUse .*mcp-only/);
    // …but a fleet-wide auto connector with no degradations exits 0, informational.
    expect(out).toMatch(/informational, exit 0/);
    expect(code).toBe(0);
  });

  it("an explicitly-targeted DEGRADED host fails (exit 1)", async () => {
    // codex fires Stop but drops the deny (fails open) → degraded; targeting it
    // explicitly makes that a real finding worth flagging.
    const cfg = writeConnector(`{
      id: "explain-cli-degraded",
      hooks: { Stop: { handler: () => ({ decision: "deny", reason: "go" }) } },
      targets: ["codex"],
    }`);
    const cap = captureStdout();
    const code = await main(["doctor", "--explain", "--connector", cfg]);
    cap.restore();
    expect(cap.text()).toMatch(/\[degraded\] codex \/ Stop/);
    expect(code).toBe(1);
  });

  it("an explicitly-targeted DROPPED-only host does NOT fail (exit 0)", async () => {
    // crush has no Stop equivalent (dropped, not degraded) — the no-equivalent
    // case install skip-warns at exit 0. Even when explicitly targeted, a dropped
    // cell must NOT fail: the host cannot do hooks AS DESIGNED, not a connector bug.
    const cfg = writeConnector(`{
      id: "explain-cli-dropped",
      hooks: { Stop: { handler: () => ({ decision: "deny", reason: "go" }) } },
      targets: ["crush"],
    }`);
    const cap = captureStdout();
    const code = await main(["doctor", "--explain", "--connector", cfg]);
    cap.restore();
    expect(cap.text()).toMatch(/\[dropped\] crush \/ Stop/);
    expect(code).toBe(0);
  });
});
