---
description: Weekly agent-discovery check — GSC + Bing query impressions, Cloudflare bot fetches of llms.txt, npm search rank, Context7 status → one row in docs/ops/discovery-log.md
---

Run the agent-discovery check for agent-connector.ai and append ONE row to
`docs/ops/discovery-log.md`. Facts only — numbers you actually read from the tools,
"n/a" where a source is unavailable, no interpretation in the row itself. Put a
one-line factual note under the table only if something changed materially
(a query newly ranking, a bot newly fetching llms.txt, an index status flip).

Window: the last 7 full days ending yesterday (UTC). Site property:
`sc-domain:agent-connector.ai` (Search Console) / `https://agent-connector.ai` (Bing).

## 1. Google Search Console (`gsc` MCP)

- Total impressions, clicks, average position for the window.
- Top 5 queries by impressions, and separately every query containing any of:
  `mcp`, `agent host`, `agent-connector`, `defineconnector`, `publish`, `deploy`,
  `install` — with impressions, clicks, position.
- Index status of `https://agent-connector.ai/` and `https://agent-connector.ai/llms.txt`
  (URL inspection), if the tool exposes it.

## 2. Bing Webmaster Tools (`bing-webmaster` MCP)

- Same window: impressions, clicks, and the query stats for the same keyword set.
- Crawl stats: pages crawled, crawl errors, if exposed.

## 3. Cloudflare (`cloudflare-graphql` MCP)

Zone `agent-connector.ai`, same window, via the GraphQL Analytics API
(`httpRequestsAdaptiveGroups`): request counts for paths `/llms.txt`,
`/llms-full.txt`, `/skills/agent-connector/SKILL.md`, and `/` — grouped by
`clientRequestHTTPHost`/path and `userAgent`. Report the top user agents per
path, and single out these if present: ClaudeBot, Claude-User, anthropic-ai,
GPTBot, ChatGPT-User, OAI-SearchBot, PerplexityBot, Google-Extended, Googlebot,
bingbot, CCBot, Bytespider, Applebot-Extended.

## 4. Registry and index status (no MCP — plain HTTP)

- npm search rank of `@ken-jo/agent-connector` for the queries `agent-connector`,
  `publish mcp server`, `mcp install claude code cursor codex`
  (`https://registry.npmjs.org/-/v1/search?text=…&size=20`).
- npm downloads, last 7 days (`https://api.npmjs.org/downloads/point/last-week/@ken-jo/agent-connector`).
- Context7: `GET https://context7.com/api/v1/ken-jo/agent-connector?type=txt&tokens=100` →
  `indexed` on 200, `not indexed` on 404.
- GitHub stars (`gh api repos/ken-jo/agent-connector -q .stargazers_count`).

## 5. Append the row

Append to the table in `docs/ops/discovery-log.md` in this column order:

`date | gsc_impr | gsc_clicks | gsc_pos | gsc_intent_queries | bing_impr | bing_clicks | llms_fetches | llms_agent_uas | npm_rank_name | npm_rank_publish | npm_dl_7d | context7 | stars`

- `gsc_intent_queries`: count of distinct queries from the keyword set that had ≥1 impression.
- `llms_fetches`: total requests to `/llms.txt` + `/llms-full.txt` + the skill file.
- `llms_agent_uas`: the agent/AI user agents seen on those paths, comma-separated (or `none`).
- `npm_rank_*`: position 1–20 or `>20`.

Then show me the row and the top intent queries. Do not commit; I review first.

If an MCP is not connected or returns an auth error, write `n/a` in its columns and
tell me which one and the exact error — do not retry with different credentials.
