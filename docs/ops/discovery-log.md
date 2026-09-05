# Agent discovery log

One row per weekly run of `/discovery-check` (`.claude/commands/discovery-check.md`).
Window: the 7 full days ending the day before `date` (UTC). Sources: Google Search
Console, Bing Webmaster Tools, Cloudflare GraphQL Analytics, npm registry, Context7,
GitHub. Numbers are read from the tools; `n/a` means the source was unavailable that
week. Interpretation belongs in `agent-discovery.md`, not here.

| date | gsc_impr | gsc_clicks | gsc_pos | gsc_intent_queries | bing_impr | bing_clicks | llms_fetches | llms_agent_uas | npm_rank_name | npm_rank_publish | npm_dl_7d | context7 | stars |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

Columns

- `gsc_impr` / `gsc_clicks` / `gsc_pos` — Search Console totals and average position for `sc-domain:agent-connector.ai`.
- `gsc_intent_queries` — distinct queries with ≥1 impression that contain `mcp`, `agent host`, `agent-connector`, `defineconnector`, `publish`, `deploy` or `install`.
- `bing_impr` / `bing_clicks` — Bing Webmaster totals for `https://agent-connector.ai`.
- `llms_fetches` — Cloudflare requests to `/llms.txt` + `/llms-full.txt` + `/skills/agent-connector/SKILL.md`.
- `llms_agent_uas` — AI/agent user agents seen on those paths (ClaudeBot, GPTBot, PerplexityBot, …) or `none`.
- `npm_rank_name` / `npm_rank_publish` — position of `@ken-jo/agent-connector` in npm search for `agent-connector` and for `publish mcp server`; `>20` when absent from the first 20.
- `npm_dl_7d` — npm downloads, last 7 days.
- `context7` — `indexed` / `not indexed` (`GET context7.com/api/v1/ken-jo/agent-connector`).
- `stars` — GitHub stargazers.

Baseline, read on 2026-09-05 before the routine existed: npm_rank_name 18 (was >20 before the 0.6.4 metadata), npm_rank_publish >20, npm_dl_7d 356 (per-version endpoint; release-day mirror traffic), context7 not indexed, stars 8. GSC / Bing / Cloudflare not yet read through MCP.
