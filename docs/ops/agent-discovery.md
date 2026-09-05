# Agent discovery — where agents find this SDK, and how to measure it

Target user: an AI coding agent that is building or shipping an MCP server for a
developer and needs a way to install it into that developer's users' agent hosts.
This page lists the surfaces such an agent reads, the state of each, and the
command or dashboard that measures it. It is an operations note, not user
documentation; `context7.json` excludes `docs/ops`.

## Surfaces and state

| Surface | What the agent does | State (2026-09-05) | Owner action |
|---|---|---|---|
| Web search (Claude Code WebSearch, Codex browsing, Cursor @web) | Queries the intent — "install MCP server into Claude Code Cursor Codex", "ship MCP server to users' agents" | Not in results for either intent; brand query ranks #8 with the pre-#307 title | Landing `<title>`/description now carry the promise + host count (guarded by `tests/docs/site-meta-drift.test.ts`); re-index follows on the next crawl |
| npm search | `npm search mcp …` / npmjs.com | Not in top 10 for the intent; not in top 5 for `agent-connector` | `package.json` description names the hosts and the count; 25 keywords (guarded) |
| Context7 (`context7.com`) | Agents with the Context7 MCP resolve a library and pull its docs | **Not indexed** — `GET https://context7.com/api/v1/ken-jo/agent-connector` → 404 | Submit `https://github.com/ken-jo/agent-connector` at <https://context7.com/add-library>; `context7.json` at repo root controls the parse |
| LobeHub MCP directory | Auto-scraped listing at <https://lobehub.com/mcp/ken-jo-agent-connector> | Stale: built from a 0.1.0 README — says `npm install agent-connector` (wrong, unscoped name), lists Codebuff/Mux/Roo Code, "Unvalidated" | Claim the listing on LobeHub and trigger a refresh from the current README |
| GitHub search / topics | Topic browse, repo description | Description and topics updated 2026-09-05 (`agent-plugins`, `agent-skills`; `agent-cli`, `llm` dropped) | — |
| `llms.txt` / `llms-full.txt` / `skills/agent-connector/SKILL.md` | Fetched once the agent knows the domain | Served from GitHub Pages behind Cloudflare | Measure fetches (below) |

## Measuring

**Bot fetches of the agent-facing files.** `agent-connector.ai` is already proxied by
Cloudflare (nameservers `zita`/`gabe.ns.cloudflare.com`), so no DNS change is needed.
In the Cloudflare dashboard: *Security → Analytics* (or *Analytics & Logs → Traffic*),
filter `Path` to `/llms.txt`, `/llms-full.txt`, `/skills/*`, and group by `User Agent`.
The user agents that matter: `ClaudeBot`, `Claude-User`, `anthropic-ai`, `GPTBot`,
`ChatGPT-User`, `OAI-SearchBot`, `PerplexityBot`, `Google-Extended`, `Googlebot`,
`bingbot`, `CCBot`, `Bytespider`, `Applebot-Extended`.

For counts over time rather than sampled analytics, a Worker on the route
`agent-connector.ai/llms*` that writes `(path, user-agent)` to Workers Analytics Engine
is the free-tier option; not deployed as of this note.

**Search-engine query impressions.** Google Search Console and Bing Webmaster Tools
show which queries surfaced the site. Bing feeds ChatGPT search and Copilot, so both
matter. Verification needs the site owner's account: add the HTML verification `<meta>`
to `site/index.html` (a one-line PR) or a DNS TXT record in Cloudflare.

**Search rank for the intent queries** — run periodically and record the result:

```
"install MCP server into Claude Code Cursor Codex Gemini CLI one config"
"ship MCP server to users' AI coding agents plugin marketplace"
"publish MCP server so users can install it in any agent"
"agent-connector" defineConnector MCP
```

**npm search rank** (public API, no auth):

```sh
curl -s 'https://registry.npmjs.org/-/v1/search?text=mcp%20install%20claude%20code%20cursor%20codex&size=20' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).objects.map((o,i)=>`${i+1} ${o.package.name}`).join("\n")))'
```

**Context7 usage.** Once indexed, the library page shows tokens served and snippet counts.

## Positioning note

The tools that rank for the install intent today — `add-mcp` (Neon, ~150k/week) and
`agent-install` (~2M/week) — are the **end-user** side: add an existing server to the
agents on one machine. agent-connector is the **publisher** side: the server's author
ships a package that installs itself, with hooks, skills and a plugin bundle. Copy that
wants to be found by an agent doing the publisher task has to use the publisher's words
— *ship / publish / distribute / your users install with one command* — which the
README and landing now do.
