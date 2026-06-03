/**
 * telemetry/proxy — the telemetry-wrapping MCP stdio proxy.
 *
 * `agent-connector serve <command> <args…>` spawns the developer's REAL MCP
 * server as a child and sits transparently between the host and that server,
 * speaking the MCP stdio wire format: NEWLINE-DELIMITED JSON-RPC (one single-line
 * JSON object per message, terminated by `\n`; stdio has NO Content-Length
 * framing). Bytes are forwarded VERBATIM in both directions so the proxy can
 * never corrupt the stream; a side line-buffer tees a COPY of each direction,
 * parses complete messages, and measures per-tool token usage out of band.
 *
 * Honesty / safety rules baked in here:
 *   • Forwarding always happens FIRST. Measurement runs after the bytes are out
 *     the door and is wrapped so a measurement bug can never break a tool call.
 *   • Telemetry stores AGGREGATE COUNTS ONLY — the parsed `tools/call` arguments
 *     and results are tokenized and discarded; raw content is never persisted.
 *   • AGENT_CONNECTOR_TELEMETRY=0 → still proxy transparently, skip all measure.
 *
 * The proxy resolves with the child's exit code and propagates SIGINT/SIGTERM.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { PlatformId } from "../core/types.js";
import { measureToolCall, measureToolDefs } from "./measure.js";
import { newRecordId } from "./store.js";
import { inferModelFamily } from "./tokenizer.js";
import type {
  ModelFamily,
  TelemetryStore,
  Tokenizer,
  ToolEventRecord,
} from "./types.js";

/** Options for {@link runServeProxy}. */
export interface RunServeProxyOptions {
  /** Connector id this server belongs to (stamped on every record). */
  connectorId: string;
  /** The real MCP server executable to spawn. */
  command: string;
  /** Arguments passed to that executable. */
  args: string[];
  /** Where measured records are appended. */
  store: TelemetryStore;
  /** Tokenizer used for measurement (defaults baked into measure helpers). */
  tokenizer: Tokenizer;
  /**
   * Telemetry model-family hint. "auto" infers the family from the MCP client's
   * `initialize` clientInfo.name; any explicit family wins outright.
   */
  modelFamilyHint: "auto" | ModelFamily;
  /** Host platform executing this proxy (stamped on every record). */
  hostPlatform: PlatformId;
  /** Host session id (stamped on every record). */
  sessionId: string;
  /** Hashed stable project identity (stamped on every record). */
  projectKey: string;
  /** Human-readable project directory (stamped on every record). */
  projectDir: string;
  /** When true, tokenize the `tools/list` schema once → tool-defs overhead. */
  measureToolDefs: boolean;
}

// ── JSON-RPC shapes we read (kept local + narrow; everything else opaque) ─────

/** Any newline-delimited JSON-RPC message — request, response, or notification. */
interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** A client→server `tools/call` we remember until its result comes back. */
interface PendingCall {
  toolName: string;
  args: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** JSON-RPC ids are number | string; normalize to a Map key. `null` → no key. */
function idKey(id: unknown): string | null {
  if (typeof id === "string") return `s:${id}`;
  if (typeof id === "number") return `n:${id}`;
  return null;
}

/**
 * Buffer a byte stream into complete `\n`-terminated lines and invoke `onLine`
 * for each. Carriage returns are tolerated (some hosts emit CRLF). This is a
 * pure side-channel: it never owns or mutates the bytes being forwarded — the
 * caller has already written the original chunk downstream verbatim.
 */
class LineBuffer {
  private buf = "";
  private readonly onLine: (line: string) => void;
  // Incremental UTF-8 decoder: `data` events split on arbitrary byte
  // boundaries, so a multi-byte sequence (emoji/CJK in a tool arg or result)
  // can straddle two chunks. StringDecoder holds back a trailing partial
  // sequence until it completes, keeping the measured copy byte-accurate.
  // (The forwarded stream is untouched — this is only the tee copy.)
  private readonly decoder = new StringDecoder("utf8");

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine;
  }

  push(chunk: Buffer): void {
    this.buf += this.decoder.write(chunk);
    let nl = this.buf.indexOf("\n");
    while (nl !== -1) {
      // Slice off one line (without the newline), tolerate a trailing CR.
      let line = this.buf.slice(0, nl);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) this.onLine(line);
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf("\n");
    }
  }
}

/**
 * Run the telemetry-wrapping MCP stdio proxy.
 *
 * Spawns `command args` with piped stdin/stdout (stderr inherited), forwards
 * both directions byte-for-byte, and measures `tools/call` round-trips and the
 * one-time `tools/list` tool-defs overhead into `store`. Resolves with the
 * child's exit code (or a signal-derived code) once the child closes.
 */
export async function runServeProxy(
  opts: RunServeProxyOptions,
): Promise<number> {
  const {
    connectorId,
    command,
    args,
    store,
    tokenizer,
    modelFamilyHint,
    hostPlatform,
    sessionId,
    projectKey,
    projectDir,
    measureToolDefs: shouldMeasureToolDefs,
  } = opts;

  // Global kill switch: still proxy transparently, but skip ALL measurement.
  const measuringEnabled = process.env.AGENT_CONNECTOR_TELEMETRY !== "0";

  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });

  // ── Per-session measurement state ───────────────────────────────────────
  // Family resolved from the client's `initialize` (or the hint) and cached.
  let family: ModelFamily = inferModelFamily("", modelFamilyHint);
  // Outstanding tools/call requests, keyed by JSON-RPC id.
  const pending = new Map<string, PendingCall>();
  // Monotonic sequence so two records in the same ms still get distinct ids.
  let seq = 0;
  // tools/list overhead is measured exactly once per session.
  let toolDefsMeasured = false;

  /** Build a base record stamped with the per-session identity fields. */
  function baseRecord(): Omit<
    ToolEventRecord,
    "toolName" | "scope" | "inputTokens" | "outputTokens" | "confidenceSource" | "isError"
  > {
    return {
      id: newRecordId(seq++),
      ts: Date.now(),
      connectorId,
      hostPlatform,
      sessionId,
      projectKey,
      projectDir,
    };
  }

  /**
   * Inspect one parsed CLIENT→SERVER message. Caches the model family on
   * `initialize` and remembers `tools/call` requests so their results can be
   * measured when they come back. Never throws into the data path.
   */
  function onClientMessage(msg: JsonRpcMessage): void {
    const method = msg.method;
    if (method === "initialize") {
      const params = isObject(msg.params) ? msg.params : undefined;
      const clientInfo =
        params && isObject(params["clientInfo"])
          ? (params["clientInfo"] as Record<string, unknown>)
          : undefined;
      const clientName =
        clientInfo && typeof clientInfo["name"] === "string"
          ? (clientInfo["name"] as string)
          : "";
      family = inferModelFamily(clientName, modelFamilyHint);
      return;
    }

    if (method === "tools/call") {
      const key = idKey(msg.id);
      if (key === null) return; // a call with no id has no result to match
      const params = isObject(msg.params) ? msg.params : undefined;
      const toolName =
        params && typeof params["name"] === "string"
          ? (params["name"] as string)
          : "unknown";
      const callArgs = params ? params["arguments"] : undefined;
      pending.set(key, { toolName, args: callArgs });
    }
  }

  /**
   * Inspect one parsed SERVER→CLIENT message. Matches `tools/call` results to
   * remembered requests and measures them; measures `tools/list` results once.
   * Never throws into the data path.
   */
  function onServerMessage(msg: JsonRpcMessage): void {
    const key = idKey(msg.id);
    if (key === null) return; // notifications carry no id we can correlate

    const pendingCall = pending.get(key);
    if (pendingCall !== undefined) {
      pending.delete(key);
      recordToolCall(pendingCall, msg);
      return;
    }

    // Not a tracked tools/call — it may be the tools/list result we measure
    // once for the fixed tool-definition overhead.
    if (shouldMeasureToolDefs && !toolDefsMeasured) {
      const result = isObject(msg.result) ? msg.result : undefined;
      const tools = result ? result["tools"] : undefined;
      if (Array.isArray(tools)) {
        recordToolDefs(tools);
      }
    }
  }

  /** Measure a matched tools/call round-trip and append the record. */
  function recordToolCall(call: PendingCall, response: JsonRpcMessage): void {
    const hasError = response.error !== undefined;
    const result = response.result;
    // A JSON-RPC error has no `result`; measure against an empty object so the
    // input (args) tokens are still recorded honestly.
    const resultForMeasure = hasError ? {} : result;
    const measurement = measureToolCall(
      call.args,
      resultForMeasure,
      family,
      tokenizer,
    );
    // MCP signals a tool-level failure via result.isError===true; a JSON-RPC
    // protocol error (response.error) is also a failure.
    const resultIsError =
      isObject(result) && result["isError"] === true;
    store.append({
      ...baseRecord(),
      toolName: call.toolName,
      scope: "call",
      inputTokens: measurement.inputTokens,
      outputTokens: measurement.outputTokens,
      confidenceSource: measurement.source,
      isError: hasError || resultIsError,
    });
  }

  /** Measure the one-time tools/list overhead and append the record. */
  function recordToolDefs(tools: readonly unknown[]): void {
    toolDefsMeasured = true;
    const count = measureToolDefs(tools, family, tokenizer);
    store.append({
      ...baseRecord(),
      toolName: "*",
      scope: "tool_defs",
      inputTokens: count.tokens,
      outputTokens: 0,
      confidenceSource: count.source,
      isError: false,
    });
  }

  /** Parse one NDJSON line and route it, swallowing any measurement error. */
  function handleLine(line: string, direction: "client" | "server"): void {
    if (!measuringEnabled) return;
    let msg: JsonRpcMessage;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isObject(parsed)) return;
      msg = parsed as JsonRpcMessage;
    } catch {
      return; // not a complete/valid JSON message — ignore for telemetry
    }
    try {
      if (direction === "client") onClientMessage(msg);
      else onServerMessage(msg);
    } catch {
      // Measurement must NEVER break the proxy. Drop the record silently.
    }
  }

  const clientLines = new LineBuffer((line) => handleLine(line, "client"));
  const serverLines = new LineBuffer((line) => handleLine(line, "server"));

  // ── Transparent byte forwarding (host stdin → child stdin) ───────────────
  // Forward VERBATIM first, then tee a copy into the line buffer to measure.
  // Honor backpressure: if the child's stdin buffer is full, pause the host
  // stdin and resume on drain so a slow server can't make us buffer unboundedly.
  process.stdin.on("data", (chunk: Buffer) => {
    if (child.stdin && child.stdin.writable) {
      const ok = child.stdin.write(chunk);
      if (!ok) {
        process.stdin.pause();
        child.stdin.once("drain", () => process.stdin.resume());
      }
    }
    if (measuringEnabled) {
      try {
        clientLines.push(chunk);
      } catch {
        /* tee side-channel must never affect forwarding */
      }
    }
  });
  process.stdin.on("end", () => {
    if (child.stdin && !child.stdin.destroyed) child.stdin.end();
  });

  // ── Transparent byte forwarding (child stdout → host stdout) ─────────────
  if (child.stdout) {
    const childStdout = child.stdout;
    childStdout.on("data", (chunk: Buffer) => {
      const ok = process.stdout.write(chunk);
      if (!ok) {
        childStdout.pause();
        process.stdout.once("drain", () => childStdout.resume());
      }
      if (measuringEnabled) {
        try {
          serverLines.push(chunk);
        } catch {
          /* tee side-channel must never affect forwarding */
        }
      }
    });
  }

  // ── Signal propagation: forward SIGINT/SIGTERM to the child ──────────────
  const forwardSignal = (signal: NodeJS.Signals): void => {
    try {
      if (!child.killed) child.kill(signal);
    } catch {
      /* child may already be gone */
    }
  };
  const onSigint = (): void => forwardSignal("SIGINT");
  const onSigterm = (): void => forwardSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  // ── Resolve with the child's exit code (or signal-derived code) ──────────
  return await new Promise<number>((resolve) => {
    const finish = (code: number): void => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      try {
        store.close();
      } catch {
        /* best-effort flush */
      }
      resolve(code);
    };

    child.on("error", () => {
      // The server could not be spawned/launched. Surface a conventional
      // "command not executable" style failure code.
      finish(126);
    });

    child.on("close", (code, signal) => {
      if (typeof code === "number") {
        finish(code);
        return;
      }
      // Killed by a signal → conventional 128 + signal number where known.
      if (signal) {
        const num = signalToNumber(signal);
        finish(num === undefined ? 1 : 128 + num);
        return;
      }
      finish(1);
    });
  });
}

/** Map the common termination signals to their numbers for exit-code math. */
function signalToNumber(signal: NodeJS.Signals): number | undefined {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return table[signal];
}

export default runServeProxy;
