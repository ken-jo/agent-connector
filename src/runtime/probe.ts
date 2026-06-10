/**
 * runtime/probe — a live MCP connection-lifecycle probe for `doctor --probe`.
 *
 * Where `doctor` checks files on disk, this spawns the connector's REAL stdio
 * server and speaks the MCP wire protocol to it: initialize → (read negotiated
 * protocolVersion + capabilities + serverInfo) → notifications/initialized →
 * ping (liveness) → tools/list (gated on the tools capability). It reuses the
 * SAME newline-delimited JSON-RPC framing + id-correlation as the telemetry
 * proxy (telemetry/jsonrpc), so the probe and the serve path read the wire
 * identically. Each step becomes a DiagnosticResult so doctor renders/aggregates
 * it uniformly; a dead/unlaunchable server FAILs (non-zero doctor exit).
 *
 * Negotiation rule: we OFFER {@link MCP_PROTOCOL_VERSION} but ACCEPT whatever
 * version the server returns (we only report it), per the spec — never a
 * hardcoded equality. There is no MCP shutdown message; we close stdin then
 * SIGTERM/SIGKILL.
 */

import type { DiagnosticResult } from "../core/types.js";
import { MCP_PROTOCOL_VERSION } from "../core/mcp-standard.js";
import { spawnChild } from "../core/spawn-child.js";
import { type JsonRpcMessage, LineBuffer, idKey, isObject } from "../telemetry/jsonrpc.js";

const DEFAULT_TIMEOUT_MS = 5000;

export interface ProbeOptions {
  /** Per-step timeout in ms (default 5000). */
  timeoutMs?: number;
  /** Prefix for each DiagnosticResult.check (e.g. the connector id). */
  label?: string;
  /** Env merged over process.env for the spawned server (${env:VAR} resolved). */
  env?: Record<string, string>;
  /** Protocol version offered in initialize. Default {@link MCP_PROTOCOL_VERSION}. */
  protocolVersion?: string;
}

function diag(
  status: DiagnosticResult["status"],
  check: string,
  message: string,
  fix?: string,
): DiagnosticResult {
  return { check, status, message, ...(fix ? { fix } : {}) };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Resolve `${env:VAR}` references in env values against the current process env. */
function resolveEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    out[k] = v.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => process.env[name] ?? "");
  }
  return out;
}

/**
 * Spawn the stdio MCP server `command args` and run a real lifecycle probe.
 * Always resolves (never rejects) with one DiagnosticResult per step.
 */
export async function probeStdioServer(
  command: string,
  args: string[],
  opts: ProbeOptions = {},
): Promise<DiagnosticResult[]> {
  const label = opts.label ? `${opts.label}: ` : "";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const protocolVersion = opts.protocolVersion ?? MCP_PROTOCOL_VERSION;
  const results: DiagnosticResult[] = [];

  // spawnChild resolves a bare Windows package runner (npx/uvx → .cmd/.exe) so
  // the probe agrees with the live serve path; no-op on macOS/Linux.
  const child = spawnChild(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...resolveEnv(opts.env) },
  });

  interface Pending {
    resolve: (m: JsonRpcMessage) => void;
    reject: (e: Error) => void;
  }
  const pending = new Map<string, Pending>();
  let spawnErr: Error | null = null;
  let exitCode: number | null = null;

  const rejectAll = (e: Error): void => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  child.on("error", (e) => {
    spawnErr = e;
    rejectAll(e);
  });
  child.on("exit", (code) => {
    exitCode = code ?? 0;
    rejectAll(new Error(`server exited (code ${exitCode}) before responding`));
  });

  const lines = new LineBuffer((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // non-JSON stdout noise — ignore
    }
    if (!isObject(parsed)) return;
    const k = idKey((parsed as JsonRpcMessage).id);
    if (k && pending.has(k)) {
      const p = pending.get(k)!;
      pending.delete(k);
      p.resolve(parsed as JsonRpcMessage);
    }
  });
  child.stdout?.on("data", (c: Buffer) => lines.push(c));

  const send = (m: JsonRpcMessage): void => {
    if (child.stdin && child.stdin.writable) child.stdin.write(`${JSON.stringify(m)}\n`);
  };
  const request = (id: number | string, method: string, params?: unknown): Promise<JsonRpcMessage> => {
    const key = idKey(id)!;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error(`no response within ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      pending.set(key, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  };

  const cleanup = (): DiagnosticResult[] => {
    try {
      if (child.stdin && child.stdin.writable) child.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 500);
    if (typeof killTimer.unref === "function") killTimer.unref();
    return results;
  };

  // 1. initialize
  let initResult: Record<string, unknown>;
  try {
    const res = await request(1, "initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "agent-connector-probe", version: "1" },
    });
    if (isObject(res.error)) {
      results.push(
        diag("fail", `${label}MCP initialize`, `server returned error: ${JSON.stringify(res.error)}`),
      );
      return cleanup();
    }
    initResult = isObject(res.result) ? res.result : {};
  } catch (e) {
    if (spawnErr) {
      results.push(
        diag(
          "fail",
          `${label}MCP initialize`,
          `server not launchable: ${errMsg(spawnErr)}`,
          `check that "${command}" is installed and on PATH`,
        ),
      );
    } else if (exitCode !== null) {
      // On Windows an unresolvable command surfaces as an early non-zero exit
      // (cmd.exe "command not found") rather than a spawn 'error' event, so fold
      // the not-launchable hint in here too — useful whether the command is
      // missing or the server genuinely crashed before initialize.
      results.push(
        diag(
          "fail",
          `${label}MCP initialize`,
          `server not launchable, or it exited (code ${exitCode}) before initialize`,
          `check that "${command}" is installed and on PATH`,
        ),
      );
    } else {
      results.push(diag("fail", `${label}MCP initialize`, errMsg(e)));
    }
    return cleanup();
  }

  const serverInfo = isObject(initResult.serverInfo) ? initResult.serverInfo : {};
  const sName = typeof serverInfo.name === "string" ? serverInfo.name : "unknown";
  const sVer = typeof serverInfo.version === "string" ? serverInfo.version : "?";
  const negotiated =
    typeof initResult.protocolVersion === "string" ? initResult.protocolVersion : "(none)";
  results.push(diag("pass", `${label}MCP initialize`, `serverInfo ${sName}@${sVer}, protocol ${negotiated}`));

  // capabilities (presence = feature offered)
  const caps = isObject(initResult.capabilities) ? initResult.capabilities : {};
  const capNames = ["tools", "resources", "prompts", "logging", "completions"].filter((c) => c in caps);
  results.push(
    diag("pass", `${label}capabilities`, capNames.length > 0 ? capNames.join(", ") : "(none advertised)"),
  );

  // 2. initialized notification (required before normal requests)
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  // 3. ping — liveness confirm (warn, not fail, on timeout)
  try {
    await request("probe-ping", "ping");
    results.push(diag("pass", `${label}ping`, "alive"));
  } catch (e) {
    results.push(diag("warn", `${label}ping`, `no ping response (${errMsg(e)})`));
  }

  // 4. tools/list — only if the server advertised a tools capability
  if ("tools" in caps) {
    try {
      const res = await request(2, "tools/list", {});
      const r = isObject(res.result) ? res.result : {};
      const tools = Array.isArray(r.tools) ? r.tools : [];
      results.push(diag("pass", `${label}tools/list`, `${tools.length} tool(s)`));
    } catch (e) {
      results.push(diag("fail", `${label}tools/list`, `no tools/list response (${errMsg(e)})`));
    }
  } else {
    results.push(
      diag("warn", `${label}tools/list`, "skipped — server advertised no tools capability"),
    );
  }

  return cleanup();
}
