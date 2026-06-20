#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// scripts/verify-mcp-echo-server.mjs — a minimal, zero-dep JSON-RPC stdio MCP
// server for the verify-host deep-verb lanes (mcp-tool-load / mcp-tool-call /
// telemetry).
//
// WHY IT EXISTS: the `.acverify` default connector points its server at
// `command:'true'`, which exits immediately and exposes NO tools — it proves
// only that the host ACCEPTS the written config, never that a tool LOADS or a
// tool CALL round-trips. Those lanes need a server that actually speaks MCP, so
// the harness installs a connector whose server wraps THIS script.
//
// It implements the three MCP methods a host exercises to load + call a tool:
//   initialize        → returns protocolVersion + capabilities + serverInfo
//   tools/list        → returns one tool, `ac_echo` (a string `text` input)
//   tools/call        → for `ac_echo`, returns content text `AC_ECHO_MARKER:<text>`
// plus the `notifications/initialized` notification (no reply).
//
// OBSERVABILITY (the assertion oracle for the lanes):
//   • $AC_MCP_LOG        — one JSON line per RECEIVED method ({"recv":"<method>",
//                          "id":<id>}), so a lane can prove the host actually
//                          performed the handshake + listed tools OFFLINE, and
//                          that a deny blocked the call BEFORE it reached here
//                          (grep -c '"recv":"tools/call"' == 0).
//   • $AC_TOOL_MARK_DIR  — on every ac_echo call, append a marker line to
//                          tool-calls.log: {"tool":"ac_echo","text":"<text>",...}
//                          — the decisive proof the real server process was
//                          invoked through the AC serve wrapper.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdio (one JSON object per
// line), the framing the AC serve proxy and every host MCP client speak. No
// Content-Length headers — line framing keeps this dependency-free and is what
// the live recipes were verified against.
//
// No imports beyond node:fs / node:path. Never throws on the hot path (a marker
// IO error must never break the JSON-RPC reply, exactly like a hook handler).
// ─────────────────────────────────────────────────────────────────────────

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PROTOCOL_VERSION = "2024-11-05";
const ECHO_MARKER = "AC_ECHO_MARKER";

/** Append one JSON line to a file, creating its dir; never throws. */
function appendLine(file, obj) {
  try {
    appendFileSync(file, JSON.stringify(obj) + "\n");
  } catch {
    /* fail-open: marker IO must never break the JSON-RPC reply */
  }
}

/** Log a received method to $AC_MCP_LOG (the handshake/list/call oracle). */
function logRecv(method, id) {
  const file = process.env.AC_MCP_LOG;
  if (!file) return;
  appendLine(file, { recv: method, ...(id !== undefined ? { id } : {}) });
}

/** Record an ac_echo call to $AC_TOOL_MARK_DIR/tool-calls.log (the call oracle). */
function markToolCall(text) {
  const dir = process.env.AC_TOOL_MARK_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* fail-open */
  }
  appendLine(join(dir, "tool-calls.log"), {
    tool: "ac_echo",
    text,
    pid: process.pid,
    ts: Date.now(),
  });
}

/** Write one JSON-RPC response line to stdout. */
function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const TOOLS = [
  {
    name: "ac_echo",
    description:
      "AC verify echo tool. Returns the provided text prefixed with AC_ECHO_MARKER: so a live turn can prove the round-trip.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to echo back." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

/** Dispatch one parsed JSON-RPC message. Returns a response object or null. */
function handle(msg) {
  const { id, method, params } = msg ?? {};
  logRecv(method, id);

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "ac-verify-echo", version: "1.0.0" },
        },
      };

    case "notifications/initialized":
      // A notification has no id and expects no reply.
      return null;

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name !== "ac_echo") {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown tool: ${String(name)}` },
        };
      }
      const text = typeof args.text === "string" ? args.text : "";
      markToolCall(text);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `${ECHO_MARKER}:${text}` }],
          isError: false,
        },
      };
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      // Unknown request → method-not-found (notifications, which carry no id,
      // are swallowed silently per JSON-RPC).
      if (id === undefined || id === null) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${String(method)}` },
      };
  }
}

// ── stdin line reader (newline-delimited JSON-RPC) ───────────────────────────
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore malformed lines (never crash the server)
    }
    const res = handle(msg);
    if (res) reply(res);
  }
});
process.stdin.on("end", () => process.exit(0));
