/**
 * tests/examples/seo-connector-smoke — the three-login example is runnable.
 *
 * Executes the example the way a reader would (`node bin.mjs …` and the MCP
 * server over stdio) against the repo build, in a sandboxed HOME with the
 * file secrets backend and no browser: the CLI plans an install and names the
 * absent logins, the server answers the MCP handshake, lists its tools, and
 * turns a tool call without a login into the exact `auth login` command
 * instead of a crash or a token.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const EXAMPLE = join(__dirname, "..", "..", "examples", "seo-connector");
const BIN = join(EXAMPLE, "bin.mjs");
const SERVER = join(EXAMPLE, "seo-mcp-server.mjs");
const LINK = join(__dirname, "..", "..", "node_modules", "@ken-jo", "agent-connector");
const DIST = join(__dirname, "..", "..", "dist", "cli", "sdk.js");

let sandbox: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "ac-seo-smoke-"));
  mkdirSync(join(sandbox, ".claude"), { recursive: true });
  writeFileSync(join(sandbox, ".claude", "settings.json"), "{}", "utf8");
  env = {
    ...process.env,
    HOME: sandbox,
    USERPROFILE: sandbox,
    AGENT_CONNECTOR_DATA_DIR: join(sandbox, ".agent-connector"),
    AGENT_CONNECTOR_SECRETS_BACKEND: "file",
    AGENT_CONNECTOR_BROWSER: "never",
    SEO_GOOGLE_CLIENT_ID: "test-google-client-id.apps.googleusercontent.com",
    SEO_BING_CLIENT_ID: "test-bing-client-id",
    SEO_POSTHOG_CLIENT_ID: "https://example.com/.well-known/seo-connector-oauth.json",
  };
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function runExample(args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const ready = existsSync(LINK) && existsSync(DIST);
const maybeDescribe = ready ? describe : describe.skip;

maybeDescribe("examples/seo-connector is actually runnable", () => {
  it("`install --dry-run` plans the connector and warns per login that is not present (exit 1: the warn convention)", () => {
    const { code, stdout } = runExample(["install", "--dry-run", "--targets", "claude-code"]);
    // install exits 1 whenever a host entry carries a warn record — here the
    // three absent logins — exactly as it does for an unset secret.
    expect(code).toBe(1);
    expect(stdout).toContain("Would install seo-connector to 1 host");
    for (const [key, provider] of [
      ["google", "google"],
      ["bing", "bing-webmaster"],
      ["posthog", "posthog"],
    ]) {
      expect(stdout).toContain(`login "${key}" (${provider}) is not present — run \`auth login ${key}\` before the server needs it`);
    }
  });

  it("`auth status --json` lists the three logins as absent without touching the network", () => {
    const { code, stdout } = runExample(["auth", "status", "--json"]);
    expect(code).toBe(0);
    const statuses = JSON.parse(stdout) as Array<{ key: string; provider: string; present: boolean | null }>;
    expect(statuses.map((s) => [s.key, s.provider, s.present])).toEqual([
      ["google", "google", false],
      ["bing", "bing-webmaster", false],
      ["posthog", "posthog", false],
    ]);
  });

  it("the MCP server answers the handshake, lists five tools, and a tool call without a login names the auth login command", async () => {
    const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
    const replies = new Map<number, unknown>();
    const waiters = new Map<number, (v: unknown) => void>();
    createInterface({ input: child.stdout }).on("line", (line) => {
      const msg = JSON.parse(line) as { id: number };
      replies.set(msg.id, msg);
      waiters.get(msg.id)?.(msg);
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const call = (id: number, method: string, params?: unknown): Promise<unknown> =>
      new Promise((resolve) => {
        waiters.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
      });
    try {
      const init = (await call(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } })) as {
        result: { serverInfo: { name: string }; capabilities: { tools: object } };
      };
      expect(init.result.serverInfo.name).toBe("seo-mcp-server");
      expect(init.result.capabilities.tools).toEqual({});
      const list = (await call(2, "tools/list")) as { result: { tools: Array<{ name: string }> } };
      expect(list.result.tools.map((t) => t.name)).toEqual(["gsc_sites", "gsc_search_analytics", "bing_query_stats", "posthog_query", "posthog_projects"]);
      const gsc = (await call(3, "tools/call", { name: "gsc_sites", arguments: {} })) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(gsc.result.isError).toBe(true);
      expect(gsc.result.content[0]?.text).toBe(
        'login "google" is not present for connector seo-connector — run `auth login google --connector-id seo-connector`',
      );
      const unknown = (await call(4, "tools/call", { name: "nope", arguments: {} })) as { error: { code: number } };
      expect(unknown.error.code).toBe(-32602);
      expect(stderr).not.toMatch(/token|secret/i);
    } finally {
      child.kill();
    }
  });
});
