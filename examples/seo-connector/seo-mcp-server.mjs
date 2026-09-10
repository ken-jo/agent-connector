#!/usr/bin/env node
// seo-mcp-server.mjs — a stdio MCP server that reads three SEO sources with
// OAuth access tokens minted by agent-connector's `getAccessToken`.
//
// Speaks newline-delimited JSON-RPC (initialize, ping, tools/list, tools/call)
// without the MCP SDK so the example stays dependency-free; for a production
// server use https://modelcontextprotocol.io/quickstart/server and keep the
// `getAccessToken` calls.
//
// Each tool asks for a token right before the HTTP call. Under a normal launch
// (the host started this server) the stored refresh token is exchanged
// silently; when nothing is stored the engine opens the browser for a one-time
// login if it can, and otherwise the tool answers with the exact `auth login`
// command to run. Human text goes to stderr only — stdout is the protocol.

import { createInterface } from "node:readline";

import { getAccessToken, OAuthError } from "@ken-jo/agent-connector/sdk";
import connector from "./agent-connector.config.mjs";

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const replyError = (id, code, message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);

/** Mint an access token for one of the connector's logins. */
async function token(key) {
  const set = await getAccessToken({
    connectorId: connector.id,
    key,
    // The login definition travels with the server, so this works before the
    // connector is registered (a bare `node seo-mcp-server.mjs`) as well as
    // under the serve wrapper or a host plugin.
    def: connector.oauth[key],
  });
  return set.accessToken;
}

async function getJson(url, accessToken, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${new URL(url).pathname} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text === "" ? {} : JSON.parse(text);
}

const isoDaysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

// ── Tools ──────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "gsc_sites",
    description: "List the Google Search Console properties the signed-in Google account can read.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const body = await getJson("https://www.googleapis.com/webmasters/v3/sites", await token("google"));
      return (body.siteEntry ?? []).map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
    },
  },
  {
    name: "gsc_search_analytics",
    description: "Top queries from Google Search Console for a property over the last N days (clicks, impressions, CTR, position).",
    inputSchema: {
      type: "object",
      properties: {
        siteUrl: { type: "string", description: "Property URL, e.g. https://example.com/ or sc-domain:example.com" },
        days: { type: "integer", minimum: 1, maximum: 480, default: 28 },
        rowLimit: { type: "integer", minimum: 1, maximum: 1000, default: 25 },
      },
      required: ["siteUrl"],
    },
    async run({ siteUrl, days = 28, rowLimit = 25 }) {
      const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
      const body = await getJson(url, await token("google"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ startDate: isoDaysAgo(days + 2), endDate: isoDaysAgo(2), dimensions: ["query"], rowLimit }),
      });
      return (body.rows ?? []).map((r) => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
    },
  },
  {
    name: "bing_query_stats",
    description: "Top queries from Bing Webmaster Tools for a site (clicks, impressions, average position).",
    inputSchema: {
      type: "object",
      properties: { siteUrl: { type: "string", description: "Site URL as registered in Bing Webmaster Tools, e.g. https://example.com/" } },
      required: ["siteUrl"],
    },
    async run({ siteUrl }) {
      const url = `https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?siteUrl=${encodeURIComponent(siteUrl)}`;
      const body = await getJson(url, await token("bing"));
      return (body.d ?? []).map((r) => ({ query: r.Query, clicks: r.Clicks, impressions: r.Impressions, avgPosition: r.AvgClickPosition }));
    },
  },
  {
    name: "posthog_query",
    description: "Run a read-only HogQL query against a PostHog project (defaults to page views by path over the last 7 days).",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "integer", description: "PostHog project id (see posthog_projects)" },
        hogql: {
          type: "string",
          default: "select properties.$pathname as path, count() as views from events where event = '$pageview' and timestamp > now() - interval 7 day group by path order by views desc limit 25",
        },
      },
      required: ["projectId"],
    },
    async run({ projectId, hogql }) {
      const query =
        hogql ??
        "select properties.$pathname as path, count() as views from events where event = '$pageview' and timestamp > now() - interval 7 day group by path order by views desc limit 25";
      const body = await getJson(`${posthogOrigin()}/api/projects/${projectId}/query/`, await token("posthog"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      });
      return { columns: body.columns ?? [], results: body.results ?? [] };
    },
  },
  {
    name: "posthog_projects",
    description: "List the PostHog projects the signed-in account can read.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const body = await getJson(`${posthogOrigin()}/api/projects/`, await token("posthog"));
      return (body.results ?? []).map((p) => ({ id: p.id, name: p.name }));
    },
  },
];

function posthogOrigin() {
  const region = connector.oauth.posthog?.options?.region;
  return region === "eu" ? "https://eu.posthog.com" : "https://us.posthog.com";
}

/** A tool failure as an MCP tool result: the message names the fix, never a token. */
function toolFailure(err) {
  if (err instanceof OAuthError) {
    const hint = err.hint ? ` (${err.hint})` : "";
    return { isError: true, content: [{ type: "text", text: `${err.message}${hint}` }] };
  }
  return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
}

// ── Protocol loop ──────────────────────────────────────────────────────────

createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || msg.id === null) return; // notification — no reply
  switch (msg.method) {
    case "initialize":
      reply(msg.id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "seo-mcp-server", version: "1.0.0" },
      });
      return;
    case "ping":
      reply(msg.id, {});
      return;
    case "tools/list":
      reply(msg.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) {
        replyError(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
        return;
      }
      try {
        const data = await tool.run(msg.params?.arguments ?? {});
        reply(msg.id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
      } catch (err) {
        reply(msg.id, toolFailure(err));
      }
      return;
    }
    default:
      replyError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
});
