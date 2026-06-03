/**
 * integration/serve — the telemetry-wrapping MCP stdio proxy, end to end.
 *
 * Spawns the fake MCP server fixture (newline-delimited JSON-RPC) through the
 * real {@link runServeProxy}, drives a full session over swapped process streams
 * (initialize → tools/list → two tools/call), and asserts that an in-test
 * {@link TelemetryStore} stub received:
 *   • one `tool_defs` record (the one-time tools/list overhead), and
 *   • one `call` record per tools/call,
 * each with positive token counts.
 *
 * Why swap process.stdin/stdout? runServeProxy reads process.stdin and writes
 * process.stdout (it IS the host-facing pipe). We replace both with PassThrough
 * streams so the test can feed JSON-RPC request lines in and observe the proxy's
 * forwarded bytes out — all guarded by try/finally so the real streams are
 * always restored even on failure.
 *
 * Isolation: HOME / AGENT_CONNECTOR_DATA_DIR point at temp dirs and are restored
 * in afterEach; the store is a pure in-memory stub so nothing touches disk.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runServeProxy } from "../../src/telemetry/proxy.js";
import { getTokenizer } from "../../src/telemetry/tokenizer.js";
import { measureToolCall, measureToolDefs } from "../../src/telemetry/measure.js";
import type {
  QueryFilter,
  RollupRow,
  TelemetryStore,
  ToolEventRecord,
} from "../../src/telemetry/types.js";

const FAKE_SERVER = join(__dirname, "fixtures", "fake-mcp-server.mjs");
const CONNECTOR_ID = "telemetry-conn";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
};

let tmpHome: string;
let tmpData: string;

/** In-memory {@link TelemetryStore} stub that collects appended records. */
class ArrayStore implements TelemetryStore {
  readonly records: ToolEventRecord[] = [];
  closed = false;
  append(record: ToolEventRecord): void {
    this.records.push(record);
  }
  query(_filter: QueryFilter): ToolEventRecord[] {
    return [...this.records];
  }
  rollup(_by: "tool" | "session" | "project", _filter: QueryFilter): RollupRow[] {
    return [];
  }
  close(): void {
    this.closed = true;
  }
}

/** Override a process stream getter with a stand-in; returns a restore thunk. */
function swapStream(name: "stdin" | "stdout", replacement: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(process, name);
  Object.defineProperty(process, name, {
    value: replacement,
    configurable: true,
    writable: true,
  });
  return () => {
    if (original) Object.defineProperty(process, name, original);
  };
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-serve-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-serve-data-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  delete process.env.AGENT_CONNECTOR_TELEMETRY;
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of [tmpHome, tmpData]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** One newline-delimited JSON-RPC line. */
function rpcLine(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

describe("runServeProxy (full proxy wiring over swapped process streams)", () => {
  it("records tool_defs once and one record per tools/call with positive tokens", async () => {
    const store = new ArrayStore();
    const fakeStdin = new PassThrough();
    const fakeStdout = new PassThrough();
    // Drain the forwarded host-facing output so the PassThrough never stalls.
    fakeStdout.resume();

    const restoreStdin = swapStream("stdin", fakeStdin);
    const restoreStdout = swapStream("stdout", fakeStdout);

    try {
      const proxyPromise = runServeProxy({
        connectorId: CONNECTOR_ID,
        command: process.execPath,
        args: [FAKE_SERVER],
        store,
        tokenizer: getTokenizer(),
        modelFamilyHint: "auto",
        hostPlatform: "claude-code",
        sessionId: "sess-serve-1",
        projectKey: "proj-key-serve",
        projectDir: "/home/dev/telemetry",
        measureToolDefs: true,
      });

      // Drive a full MCP session. The fake server answers each request
      // synchronously on receipt, so writing the lines then ending stdin lets
      // every response flow back (and be measured) before the child exits.
      fakeStdin.write(
        rpcLine({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "claude-ai" } },
        }),
      );
      fakeStdin.write(
        rpcLine({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      );
      fakeStdin.write(
        rpcLine({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "echo", arguments: { text: "hello telemetry world" } },
        }),
      );
      fakeStdin.write(
        rpcLine({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "add", arguments: { a: 2, b: 40 } },
        }),
      );
      // End the host stream → proxy ends the child's stdin → fake server exits.
      fakeStdin.end();

      const exitCode = await proxyPromise;
      expect(exitCode).toBe(0);
    } finally {
      restoreStdout();
      restoreStdin();
    }

    // The store stub must have been closed by the proxy on finish.
    expect(store.closed).toBe(true);

    const defs = store.records.filter((r) => r.scope === "tool_defs");
    const calls = store.records.filter((r) => r.scope === "call");

    // Exactly one tool-defs record (tools/list measured once).
    expect(defs).toHaveLength(1);
    expect(defs[0]!.toolName).toBe("*");
    expect(defs[0]!.inputTokens).toBeGreaterThan(0);

    // One record per tools/call.
    expect(calls).toHaveLength(2);
    const byTool = new Map(calls.map((c) => [c.toolName, c]));
    expect(byTool.has("echo")).toBe(true);
    expect(byTool.has("add")).toBe(true);
    for (const c of calls) {
      expect(c.inputTokens).toBeGreaterThan(0);
      expect(c.outputTokens).toBeGreaterThan(0);
      expect(c.isError).toBe(false);
      // Per-session identity is stamped on every record.
      expect(c.connectorId).toBe(CONNECTOR_ID);
      expect(c.hostPlatform).toBe("claude-code");
      expect(c.sessionId).toBe("sess-serve-1");
      expect(c.projectKey).toBe("proj-key-serve");
    }
  });

  it("AGENT_CONNECTOR_TELEMETRY=0 proxies transparently but records nothing", async () => {
    process.env.AGENT_CONNECTOR_TELEMETRY = "0";
    const store = new ArrayStore();
    const fakeStdin = new PassThrough();
    const fakeStdout = new PassThrough();
    fakeStdout.resume();

    const restoreStdin = swapStream("stdin", fakeStdin);
    const restoreStdout = swapStream("stdout", fakeStdout);

    try {
      const proxyPromise = runServeProxy({
        connectorId: CONNECTOR_ID,
        command: process.execPath,
        args: [FAKE_SERVER],
        store,
        tokenizer: getTokenizer(),
        modelFamilyHint: "auto",
        hostPlatform: "claude-code",
        sessionId: "sess-off",
        projectKey: "proj-off",
        projectDir: "/home/dev/off",
        measureToolDefs: true,
      });

      fakeStdin.write(
        rpcLine({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      );
      fakeStdin.write(
        rpcLine({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "echo", arguments: { text: "no telemetry" } },
        }),
      );
      fakeStdin.end();

      const exitCode = await proxyPromise;
      expect(exitCode).toBe(0);
    } finally {
      restoreStdout();
      restoreStdin();
    }

    // Kill switch on → measurement skipped entirely.
    expect(store.records).toHaveLength(0);
  });
});

/**
 * Focused measure + store integration. Independent of the spawned proxy so it
 * still pins the measurement→record contract even if process-stream swapping is
 * ever impractical on a given runner. Mirrors what the proxy stores per call.
 */
describe("measure + store integration (proxy-independent)", () => {
  it("measureToolCall over a text result yields positive input/output tokens", () => {
    const tok = getTokenizer();
    const m = measureToolCall(
      { text: "hello telemetry world" },
      { content: [{ type: "text", text: "the quick brown fox jumps over" }] },
      "anthropic",
      tok,
    );
    expect(m.inputTokens).toBeGreaterThan(0);
    expect(m.outputTokens).toBeGreaterThan(0);
  });

  it("measureToolDefs over a 2-tool list yields positive tokens", () => {
    const tok = getTokenizer();
    const tools = [
      { name: "echo", description: "Echo back text.", inputSchema: { type: "object" } },
      { name: "add", description: "Add two numbers.", inputSchema: { type: "object" } },
    ];
    const c = measureToolDefs(tools, "openai", tok);
    expect(c.tokens).toBeGreaterThan(0);
  });

  it("a record assembled from a measurement collects into the store stub", () => {
    const store = new ArrayStore();
    const tok = getTokenizer();
    const m = measureToolCall(
      { a: 2, b: 40 },
      { content: [{ type: "text", text: "42" }] },
      "openai",
      tok,
    );
    const record: ToolEventRecord = {
      id: "rec-1",
      ts: Date.now(),
      connectorId: CONNECTOR_ID,
      toolName: "add",
      scope: "call",
      hostPlatform: "claude-code",
      sessionId: "s1",
      projectKey: "pk",
      projectDir: "/p",
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      confidenceSource: m.source,
      isError: false,
    };
    store.append(record);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]!.inputTokens).toBeGreaterThan(0);
  });
});
