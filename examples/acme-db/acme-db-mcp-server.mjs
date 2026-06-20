#!/usr/bin/env node
// acme-db-mcp-server.mjs — minimal stdio MCP stub so the example runs end-to-end.
// Speaks newline-delimited JSON-RPC: answers initialize, ping, and tools/list.
// Copy this as a starting point for your own MCP server; for production use the
// official MCP SDK at https://modelcontextprotocol.io/quickstart/server
import { createInterface } from "node:readline";

const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return; // notification — no reply
  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "acme-db-mcp-server", version: "1.0.0" },
    });
  } else if (msg.method === "ping") {
    reply(msg.id, {});
  } else if (msg.method === "tools/list") {
    reply(msg.id, {
      tools: [{
        name: "acme_query",
        description: "Run a read-only SQL query against the Acme demo DB.",
        inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
      }, {
        name: "acme_write",
        description: "Write data to the Acme demo DB.",
        inputSchema: { type: "object", properties: { table: { type: "string" }, data: { type: "object" } }, required: ["table", "data"] },
      }],
    });
  } else {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    })}\n`);
  }
});
