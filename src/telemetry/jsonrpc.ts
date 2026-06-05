/**
 * telemetry/jsonrpc — shared MCP stdio wire primitives.
 *
 * The MCP stdio transport is NEWLINE-DELIMITED JSON-RPC: one single-line JSON
 * object per message, terminated by `\n` (no Content-Length framing). These
 * primitives — the message shape, the id key, the line buffer — are used by BOTH
 * the telemetry proxy (which tees + measures) and `doctor --probe` (which sends
 * a real initialize/ping/tools-list handshake), so framing + id-correlation are
 * byte-identical across the two paths. Extracted here rather than duplicated.
 */

import { StringDecoder } from "node:string_decoder";

/** Any newline-delimited JSON-RPC message — request, response, or notification. */
export interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** JSON-RPC ids are number | string; normalize to a Map key. `null` → no key. */
export function idKey(id: unknown): string | null {
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
export class LineBuffer {
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
