#!/usr/bin/env node
// Minimal stdio MCP server used only for host verification.
// Implements initialize, tools/list and tools/call (acme_query → "ok: <sql>").
// Every tools/call is appended to $ACME_PROBE_LOG so the harness can prove the
// HOST actually invoked the tool (not just listed it).
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG = process.env.ACME_PROBE_LOG;
const tools = [
  {
    name: "acme_query",
    description: "Run a read-only SQL query against the Acme DB (verification probe).",
    inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
  },
];
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "acme-probe-mcp-server", version: "1.0.0" } } });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
  } else if (method === "tools/call") {
    const sql = params?.arguments?.sql ?? "";
    if (LOG) appendFileSync(LOG, `tools/call ${params?.name} ${JSON.stringify(params?.arguments ?? {})} ${new Date().toISOString()}\n`);
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `ok: ${sql} -> 1 row` }], isError: false } });
  } else if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
