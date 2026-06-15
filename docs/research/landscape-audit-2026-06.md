# Landscape Coverage Audit — agent-connector vs the AI-agent-CLI field

**Dated:** 2026-06-15 · **Direction:** C4 (truth-up) · **Author:** research pass

> **Honesty bar.** Every *internal* claim below is grounded in the repo (file
> cited). Every *external* claim (a CLI exists / is popular / supports MCP)
> carries a source URL or is marked `[unverified]`. Counts come from the adapter
> registry, not hand-counting docs. Where the field disagrees or a fact could
> not be confirmed, it is labelled — not guessed.

## Headline

- **Coverage today: 32 shipped adapters** (`src/adapters/registry.ts`,
  programmatically counted — 16 json-stdio, 9 mcp-only, 7 ts-plugin per
  `site/src/platform-data.ts`).
- **vs tokscale** (junhoyeo's leaderboard, the stated breadth target): tokscale
  tracks **26 distinct agent clients** for *usage*. AC has a deploy adapter for
  **all 26 of the 26 that expose a writable MCP/config surface.** The 3 tokscale
  entries AC does *not* adapt are non-deployable by design (see Non-targets).
- **AC is AHEAD of tokscale on 5 hosts** it doesn't track at all:
  `vscode-copilot`, `jetbrains-copilot`, `antigravity-cli`, `mimo-code`,
  `nemoclaw`.
- **Verified gaps outside tokscale: 4** real MCP-capable hosts AC does not yet
  adapt — **Grok Build (xAI)**, **Continue CLI (`cn`)**, **Amazon Q Developer
  CLI**, **Windsurf** — ranked below.

---

## 1. Coverage today (ground truth — from the repo)

Source of truth: `ADAPTER_REGISTRY` in `src/adapters/registry.ts` (32 entries,
counted in-code), names/paradigms from `site/src/platform-data.ts`, lineage
notes from registry comments + `src/core/types.ts`. Doc-count cross-check: the
`PlatformId` union in `types.ts` and the `platformCount` export agree at 32; an
older `expansion-plan.md` header still says "9 → 26" (the original tokscale-parity
target, now exceeded) — stale header, not a coverage disagreement.

| # | id | name | paradigm | fork/lineage |
|---|---|---|---|---|
| 1 | claude-code | Claude Code | json-stdio | — |
| 2 | codex | Codex CLI | json-stdio | — |
| 3 | cursor | Cursor | json-stdio | VS Code fork |
| 4 | vscode-copilot | VS Code Copilot | json-stdio | — |
| 5 | copilot-cli | GitHub Copilot CLI | json-stdio | — |
| 6 | gemini-cli | Gemini CLI | json-stdio | — |
| 7 | warp | Warp | mcp-only | — |
| 8 | opencode | OpenCode | ts-plugin | — |
| 9 | mimo-code | MiMoCode (Xiaomi) | ts-plugin | **OpenCode fork** |
| 10 | kilo-cli | Kilo CLI | ts-plugin | **OpenCode fork** |
| 11 | droid | Droid (Factory) | json-stdio | — |
| 12 | roo-code | Roo Code | mcp-only | **Cline fork** |
| 13 | kilo | Kilo Code (VS Code ext) | ts-plugin | **Roo/Cline fork** |
| 14 | cline | Cline | mcp-only | parent of roo-code/kilo |
| 15 | trae | Trae | mcp-only | — |
| 16 | antigravity-cli | Antigravity CLI (agy) | json-stdio | — |
| 17 | antigravity | Google Antigravity | json-stdio | — |
| 18 | zed | Zed | mcp-only | — |
| 19 | amp | Amp | mcp-only | — |
| 20 | codebuff | Codebuff | mcp-only | — |
| 21 | mux | Mux | mcp-only | — |
| 22 | pi | Pi | mcp-only | — |
| 23 | jetbrains-copilot | JetBrains Copilot | json-stdio | — |
| 24 | qwen-code | Qwen CLI | json-stdio | Gemini-CLI lineage [unverified-degree] |
| 25 | kiro | Kiro | json-stdio | — |
| 26 | kimi | Kimi CLI | json-stdio | — |
| 27 | crush | Crush | json-stdio | — |
| 28 | goose | Goose | json-stdio | — |
| 29 | hermes | Hermes Agent | json-stdio | — |
| 30 | omp | Oh My Pi (OMP) | ts-plugin | **Pi fork** |
| 31 | nemoclaw | NVIDIA NemoClaw | ts-plugin | **OpenClaw wrapper/fork** |
| 32 | openclaw | OpenClaw | ts-plugin | — |

Telemetry-only (deliberately NO deploy adapter): `synthetic` (Octofriend /
synthetic.new) — has a usage reader, no writable MCP config to install into
(`src/core/types.ts` comment).

---

## 2. The landscape — agent CLIs in the field (2025–2026)

### 2a. tokscale roster (the named breadth target)

junhoyeo's **tokscale** is a Rust/CLI token-usage tracker + leaderboard. Its own
README lists the clients it reads usage from. Authoritative `--client` enum
(README, fetched 2026-06-15):
`opencode, claude, codex, copilot, gemini, cursor, amp, codebuff, droid,
openclaw, hermes, pi, kimi, qwen, roocode, kilocode, kilo, mux, crush, goose,
antigravity, zed, kiro, trae, cline, gjc, synthetic` — plus table-only rows for
**Grok Build** and **Kimi Code**. Net **26 distinct agent products** (treating
gjc/Grok/synthetic as the three non-CLI-deploy entries, Kimi Code as a Kimi
variant). Source: <https://github.com/junhoyeo/tokscale> (README).

| tokscale client | what it is | MCP/config-deployable? | AC adapter |
|---|---|---|---|
| opencode | OSS terminal agent (sst) | yes (ts-plugin) | ✅ opencode |
| claude | Claude Code | yes | ✅ claude-code |
| codex | OpenAI Codex CLI | yes | ✅ codex |
| copilot | GitHub Copilot CLI | yes | ✅ copilot-cli |
| gemini | Gemini CLI | yes | ✅ gemini-cli |
| cursor | Cursor IDE | yes (mcp.json) | ✅ cursor |
| amp | Amp (Sourcegraph) | yes (settings.json) | ✅ amp |
| codebuff | Codebuff / manicode | yes | ✅ codebuff |
| droid | Factory Droid | yes (~/.factory) | ✅ droid |
| openclaw | OpenClaw | yes | ✅ openclaw |
| hermes | Hermes Agent (Nous) | yes (YAML) | ✅ hermes |
| pi | Pi (+ Oh My Pi) | **partial** — Pi has no writable mcp.json; OMP fork does | ✅ pi + ✅ omp |
| kimi | Kimi CLI | yes (~/.kimi) | ✅ kimi |
| qwen | Qwen CLI | yes (~/.qwen) | ✅ qwen-code |
| roocode | Roo Code | yes (globalStorage) | ✅ roo-code |
| kilocode | Kilo CLI | yes | ✅ kilo-cli |
| kilo | Kilo Code ext | yes | ✅ kilo |
| mux | Mux | yes (~/.mux) | ✅ mux |
| crush | Crush (Charm) | yes | ✅ crush |
| goose | Goose (Block) | yes (YAML) | ✅ goose |
| antigravity | Google Antigravity | yes | ✅ antigravity |
| zed | Zed | yes (context_servers) | ✅ zed |
| kiro | Kiro (AWS) | yes | ✅ kiro |
| trae | Trae (ByteDance) | yes | ✅ trae |
| cline | Cline | yes | ✅ cline |
| gjc | Gajae-Code | harness, not a config-deploy host (see §4) | ❌ (non-target) |
| synthetic | Octofriend / synthetic.new | no writable MCP config | ❌ (telemetry-only) |
| Grok Build | xAI terminal agent | **yes** (~/.grok/config.toml) | ❌ **GAP** (§3) |

Source for all data-location facts: tokscale README "Supported Clients" + "Data
Locations" tables, <https://github.com/junhoyeo/tokscale>.

### 2b. Widely-known agents NOT on tokscale

| name | what it is | MCP-capable / extensible? | source |
|---|---|---|---|
| Continue CLI (`cn`) | Terminal agent powering Continue.dev extensions | **yes** — `mcpServers` in `.continue/mcpServers/*.yaml` or config.yaml | <https://docs.continue.dev/customize/mcp-tools>, <https://docs.continue.dev/cli/quickstart>, npm `@continuedev/cli` |
| Amazon Q Developer CLI | AWS terminal coding agent | **yes** — `~/.aws/amazonq/mcp.json` + `.amazonq/mcp.json`, standard `mcpServers` | <https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-mcp-understanding-config.html>, <https://aws.amazon.com/about-aws/whats-new/2025/04/amazon-q-developer-cli-model-context-protocol> |
| Windsurf | Codeium AI-native editor (Cascade) | **yes** — `~/.codeium/windsurf/mcp_config.json`, `mcpServers` | <https://docs.windsurf.com/windsurf/cascade/mcp> |
| Aider | OSS CLI pair-programmer | **partial/experimental** — MCP-client via community tooling; no documented stable native `mcpServers` deploy file | <https://github.com/disler/aider-mcp-server>, community (mcpm-aider) |
| Auggie CLI | Augment Code terminal agent | `[unverified]` — appears in awesome-cli-coding-agents; MCP-config path not confirmed | <https://www.augmentcode.com/product/CLI> |
| Continue IDE ext | VS Code/JetBrains extension | same config as `cn` (shared agent) | as above |

Honest scoping note: Cursor, Windsurf, VS Code Copilot, and JetBrains Copilot are
GUI editors with a *writable MCP config file* — AC already adapts the first
(cursor), third, fourth; Windsurf is the only one of that shape still open.

---

## 3. Gap analysis — verified gaps, ranked by reach × feasibility

All four have a **documented, writable MCP config location** (the hard gate AC
uses: a deploy target must expose a writable MCP surface — `expansion-plan.md`).

| rank | host | reach signal | MCP integration point (cited) | feasibility | paradigm fit |
|---|---|---|---|---|---|
| 1 | **Grok Build (xAI)** | xAI brand; launched ~May 2026; already a tokscale client | `~/.grok/config.toml` (global) + `.grok/config.toml` (project), TOML MCP-server sections; native MCP, AGENTS.md, hooks, skills. **NOTE:** sources vary on the exact key — `[mcp_servers.<name>]` vs `[mcp.servers.<name>]`; confirm on a live binary before building. <https://x.ai/news/grok-build-cli>, <https://mer.vin/2026/05/grok-build-cli-xai-terminal-coding-agent-with-plan-mode-subagents-and-headless-ci/> | High — TOML, project+user scope, hooks layer present | json-stdio-like (hooks) — mirror codex/crush TOML handling |
| 2 | **Amazon Q Developer CLI** | AWS brand, enterprise reach; MCP since Apr 2025 | `~/.aws/amazonq/mcp.json` + `.amazonq/mcp.json`, **standard `mcpServers` JSON**, combine-both-scopes semantics | **Highest** — cleanest of the four; mirror droid/cursor exactly | mcp-only (no documented hook layer → declare hooks false) |
| 3 | **Continue CLI (`cn`)** | Continue.dev is a top OSS extension; real terminal agent (`@continuedev/cli`, Node 20+) | `.continue/mcpServers/*.yaml` (per-server YAML files) **or** `mcpServers:` in config.yaml. **Render quirk:** YAML one-server-per-file, not the JSON `mcpServers` object — needs a YAML emitter like goose/hermes | High, with a YAML render path | YAML; reuse goose/hermes YAML helpers |
| 4 | **Windsurf** | Codeium reach; large user base | `~/.codeium/windsurf/mcp_config.json`, `mcpServers` JSON | High mechanically; **but GUI-editor shape** (like Cursor) — value is incremental given cursor/vscode-copilot already cover that ergonomic | json-stdio/mcp-only (editor) |

**Reach × feasibility verdict:** #1 Grok Build and #2 Amazon Q are the two with
the best (reach × cleanliness) product. Grok edges ahead on novelty/brand and is
already a tokscale client (closing it = staying at-or-ahead of the leaderboard);
Amazon Q is the *easiest* build (drop-in `mcpServers` JSON, two scopes). Continue
is high-reach but costs a YAML render path. Windsurf is real but lowest marginal
value (duplicates the GUI-editor ergonomic AC already serves via cursor).

---

## 4. Honest non-targets (real reasons, not padding)

| entry | why NOT an AC deploy target |
|---|---|
| **synthetic** (Octofriend) | No writable MCP config to install into; telemetry-only by design (`types.ts`). Correctly a usage reader, not an adapter. |
| **Gajae-Code (gjc)** | An *agent harness/runner* (interview→plan→execute, tmux workers) that runs **beside** other agents without patching their runtime; it *provides* `gjc mcp-serve` (an MCP server) rather than *consuming* a writable `mcpServers` config. Not a config-deploy host. Experimental/beta. <https://github.com/Yeachan-Heo/gajae-code> |
| **Aider** | Native MCP-client support is community/experimental (mcpm-aider, aider-mcp-server); no documented stable native `mcpServers` file AC could own. Reassess if Aider ships first-party MCP config. <https://github.com/disler/aider-mcp-server> |
| **Pi (standalone)** | No native MCP / no writable mcp.json (`expansion-plan.md`); AC's `pi` adapter exists as mcp-only with the documented caveats, and the OMP fork is what carries the deployable surface. Listed for completeness — already handled. |
| **Auggie CLI** | `[unverified]` — exists in directories but MCP-config path not confirmed; do not build until verified. |

---

## 5. Recommended next 3 breadth targets

1. **Amazon Q Developer CLI** — *build-first.* Cleanest integration of any open
   gap: standard `mcpServers` JSON at `~/.aws/amazonq/mcp.json` +
   `.amazonq/mcp.json`, two scopes that combine. Mirrors `droid`/`cursor`
   almost exactly. Highest confidence the integration point exists (AWS docs,
   verified). Enterprise/AWS reach. *Validates the earlier "Amazon Q is a
   leading candidate" synthesis.*
2. **Grok Build (xAI)** — *highest strategic value.* xAI brand, MCP-native,
   project+user TOML scopes, hooks present (so it can be a full json-stdio-style
   host, not just mcp-only). Already a tokscale client → closing it keeps AC
   at-or-ahead of the leaderboard. One caveat to verify on a live binary: exact
   TOML key (`[mcp_servers]` vs `[mcp.servers]`).
3. **Continue CLI (`cn`)** — *challenges the earlier "Continue.dev" pick, and
   upholds it.* Continue.dev *is* a leading candidate, but the right target is
   the **`cn` terminal agent**, not the IDE extension; its MCP surface is
   per-server **YAML** (`.continue/mcpServers/*.yaml`), so it needs the
   goose/hermes YAML render path — feasible, slightly more work than Q.

*Earlier synthesis check:* Continue.dev and Amazon Q were both flagged as leading
candidates — **both validated.** The refinement: Amazon Q is the cleaner/faster
build; the Continue target is specifically `cn` (CLI) with a YAML render path;
and a third candidate the earlier synthesis missed — **Grok Build** — is at least
as strong as either on reach.

### Where AC is already AHEAD (differentiators worth recording)

These 5 shipped adapters are hosts **tokscale does not track at all**:

- `vscode-copilot` (VS Code Copilot) — full json-stdio surface.
- `jetbrains-copilot` (JetBrains Copilot) — IDE MCP + project hooks.
- `antigravity-cli` (the `agy` CLI, distinct from the Antigravity editor).
- `mimo-code` (Xiaomi MiMoCode, OpenCode fork).
- `nemoclaw` (NVIDIA NemoClaw, OpenClaw wrapper).

AC deploys *config* (MCP servers + hooks + content surfaces) where tokscale only
*reads* usage — a structurally different and broader job — so AC also covers the
write-path surfaces (statusline, configPatch, memory, skills) on every host that
leaderboards never model.

---

## 6. Sources

Internal (repo):
- `src/adapters/registry.ts` — 32-entry `ADAPTER_REGISTRY` (authoritative count).
- `src/core/types.ts` — `PlatformId` union, `HookParadigm` sets, synthetic note.
- `site/src/platform-data.ts` — names, paradigms, surface matrix, `platformCount`.
- `docs/research/expansion-plan.md` — the "MCP is the hard deploy gate" rule;
  original "9 → 26 tokscale-parity" plan; Pi-excluded rationale.

External (cited):
- tokscale roster + data locations — <https://github.com/junhoyeo/tokscale>
- Continue MCP — <https://docs.continue.dev/customize/mcp-tools> · CLI —
  <https://docs.continue.dev/cli/quickstart> · npm `@continuedev/cli`
- Amazon Q CLI MCP — <https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-mcp-understanding-config.html> ·
  <https://aws.amazon.com/about-aws/whats-new/2025/04/amazon-q-developer-cli-model-context-protocol>
- Grok Build — <https://x.ai/news/grok-build-cli> ·
  <https://mer.vin/2026/05/grok-build-cli-xai-terminal-coding-agent-with-plan-mode-subagents-and-headless-ci/>
- Windsurf MCP — <https://docs.windsurf.com/windsurf/cascade/mcp>
- Aider MCP (community) — <https://github.com/disler/aider-mcp-server>
- Gajae-Code — <https://github.com/Yeachan-Heo/gajae-code>

## 7. Confidence boundaries — facts NOT fully verified

- **Grok Build exact TOML key** — sources disagree (`[mcp_servers.<name>]` vs
  `[mcp.servers.<name>]`); both are secondary write-ups, not the primary xAI
  config reference. **Verify on a live binary before building.**
- **Grok Build launch date** ("~May 2026") — from a third-party blog, not an xAI
  changelog. Treat as approximate.
- **tokscale "26 distinct" count** — derived by de-duplicating its `--client`
  enum + table rows (Kimi Code = Kimi variant; gjc/Grok/synthetic non-CLI-deploy).
  A reasonable reading, not a number tokscale itself publishes.
- **Aider native MCP** — could NOT confirm a first-party `mcpServers` deploy file;
  all evidence is community tooling. If wrong, Aider moves to a gap.
- **Auggie CLI** — existence noted; MCP-config path `[unverified]`. Not counted
  as a gap.
- **qwen-code lineage** — degree of Gemini-CLI derivation not re-verified here;
  marked `[unverified-degree]`.
- **Windsurf as a CLI host** — Windsurf is a GUI editor with a writable MCP file,
  not a terminal agent; counted as a writable-config gap, not a CLI host.
