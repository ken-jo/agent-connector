#!/usr/bin/env node
/**
 * A minimal fake MCP stdio server for the serve-proxy integration test.
 *
 * Speaks the MCP stdio wire format: newline-delimited JSON-RPC (one single-line
 * JSON object per message, terminated by "\n"). It answers exactly three request
 * methods and ignores everything else:
 *   • initialize  → a result echoing protocol/serverInfo.
 *   • tools/list  → a result with TWO tool descriptors.
 *   • tools/call  → a result with a single text content block.
 *
 * It exits cleanly when its stdin ends (the proxy ends the child's stdin once the
 * host stream ends), which is how the proxy's promise resolves in the test.
 */

let buf = "";

process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl).replace(/\r$/, "");
    buf = buf.slice(nl + 1);
    if (line.trim() !== "") handleLine(line);
    nl = buf.indexOf("\n");
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "fake-mcp", version: "0.0.1" },
        capabilities: { tools: {} },
      },
    });
    return;
  }

  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo back the provided text.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          {
            name: "add",
            description: "Add two numbers and return the sum.",
            inputSchema: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "number" } },
              required: ["a", "b"],
            },
          },
        ],
      },
    });
    return;
  }

  if (method === "tools/call") {
    const name = msg.params?.name ?? "unknown";
    const args = msg.params?.arguments ?? {};
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: `tool ${name} called with ${JSON.stringify(args)}`,
          },
        ],
      },
    });
    return;
  }

  // Unknown methods: ignore (notifications carry no id; nothing to answer).
}
