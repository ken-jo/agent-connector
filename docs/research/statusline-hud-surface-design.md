# Design insight — a first-class `statusline` / HUD surface (host-scoped, SDK-backed)

Status: PROPOSAL (2026-06-14). Trigger: dogfooding the OMC port surfaced that the OMC
HUD is deployable on claude-code ONLY. This doc extracts the agent-connector evolution
that the HUD case demands — it is NOT about making the OMC HUD itself portable.

## 1. What the dogfooding proved (the gap)

Functional cross-host verification of the OMC port (real runs, isolated home):

| Special feature | claude-code | codex | gemini-cli | cursor | opencode |
|---|---|---|---|---|---|
| MCP server (real tools/call) | ✅ | ✅ | ✅ | ✅ | ✅ (protocol-identical) |
| memory block | ✅ CLAUDE.md | ✅ AGENTS.md | ✅ GEMINI.md | ⚠️ skip-warn | ✅ AGENTS.md |
| hook context @ UserPromptSubmit | ✅ | ❌ host drops it | ✅ | — | — |
| hook context @ SessionStart/PostToolUse | ✅ | ✅ | ✅ | — | — |
| **HUD (statusLine)** | ✅ | ❌ | ❌ | ❌ | ❌ |

The HUD is the only feature that is **structurally** single-host, for two compounding
reasons:

1. **No surface models it.** The HUD reaches the host purely as a `configPatch`
   (`statusLine = {type:"command", command}`) — and `configPatch` is `supportsConfigPatch`
   = claude-code v1 only. There is no normalized "this is a status renderer" concept; AC
   treats it as an opaque config key.
2. **The input contract is host-specific and unmodeled.** The OMC HUD reads Claude's
   statusLine stdin JSON (`model.display_name`, `cwd`, `transcript_path`, `version`,
   `workspace.current_dir`, `cost.*`). Other hosts that have a status surface feed a
   DIFFERENT shape (or none). AC parses/normalizes nothing here, so a renderer written for
   one host cannot run on another.

Compare with hooks: AC DOES model those — `parseEvent` normalizes each host's event JSON
into a `NormalizedEvent`, the handler runs once, `formatReply` frames the result per host,
and capability flags gate/degrade gracefully (codex honoring context only on
SessionStart/PostToolUse is modeled, not a bug). **The HUD needs the same treatment.**

## 2. The ask, restated

A connector developer should be able to:

- implement a **claude-code HUD** and a **codex HUD** (etc.) — each against that host's real
  status contract,
- register them with one connector,
- have each apply to its host ONLY (per-agent / per-host scoping), and
- get an **SDK** that removes the per-host plumbing (input parsing, output framing,
  registration) so the dev writes a renderer, not glue.

## 3. Proposed surface: `statusline`

Follows the established surface template EXACTLY (the pattern every AC surface uses):
`ConnectorConfig` field → `PlatformCapabilities.supports*?` flag (read `?? false`) →
`BaseAdapter.install<Surface>/uninstall<Surface>` (default = skip-warn "unsupported") →
installer dispatch (`runStep`) → doctor health check.

### 3.1 Config shape

```ts
interface StatuslineDef {
  /** Stable id (kebab). Suffixes the connector id in the registration + ledger. Default "statusline". */
  name?: string;
  description?: string;

  /**
   * The renderer. Receives AC's NORMALIZED StatuslineContext and returns the line
   * (a plain string, or a Segment[] AC renders to host-appropriate ANSI/markup).
   * Host-agnostic by default; branch on ctx.host for per-host divergence.
   * Re-imported per render via modulePath (same mechanism as nativeHooks handlers).
   */
  render(ctx: StatuslineContext): string | Segment[] | Promise<string | Segment[]>;

  /**
   * Optional per-host overrides — a DISTINCT renderer for a given host when the
   * single render() is not enough (this is the "claude HUD AND codex HUD separately"
   * path). Keyed by PlatformId; merges over the top-level render().
   */
  hosts?: Partial<Record<PlatformId, { render: StatuslineDef["render"] }>>;
}
```

Wired on `ConnectorConfig` as `statusline?: StatuslineDef` (single; HUDs are singular per
host) and scoped via the existing `platforms[id]` knobs — `platforms[id].statusline =
false` to skip a host, object to tune. **This is the per-agent scoping**: declare the
surface only for the hosts you implemented it for; everywhere else AC skip-warns with the
manual-edit instructions (the configPatch/cursor-memory precedent), never silently.

### 3.2 Normalized context (the SDK's core type)

```ts
interface StatuslineContext {
  host: PlatformId;            // branch point for per-host divergence
  sessionId?: string;
  cwd?: string;
  model?: { id?: string; displayName?: string };
  cost?: { totalUsd?: number };
  context?: { usedTokens?: number; maxTokens?: number; percent?: number };
  transcriptPath?: string;
  raw: unknown;                // the host's verbatim status payload (escape hatch)
}
```

Each adapter maps its host's status input → this shape (the `parseEvent` analog). Fields a
host doesn't provide are simply absent — the renderer reads them defensively, exactly like
hook handlers read optional normalized fields.

## 4. The SDK (mirror the universal `hook` entrypoint)

AC already ships the exact machine this needs: `agent-connector hook <platform> <event>
--connector <id>` reads stdin, the adapter `parseEvent`-normalizes raw → `NormalizedEvent`,
the connector handler runs, the adapter `formatReply`-frames per host, fail-open. The HUD
SDK is the same machine with one new verb:

```
agent-connector statusline <platform> --connector <id>
  ↳ read host status stdin → adapter.parseStatusInput(raw) → StatuslineContext
  ↳ connector.statusline.render(ctx)  (or hosts[platform].render)
  ↳ adapter.formatStatusOutput(result) → host-appropriate stdout
  ↳ fail-SAFE: empty line on any error (a HUD must never wedge the prompt)
```

Install registers the host's native status surface to call this entrypoint (claude-code:
`configPatch statusLine = {type:command, command:"agent-connector statusline claude-code
--connector <id>"}` — note: AC now OWNS this patch, so the ledger/ownership story from the
configPatch work applies for free). The developer writes ONLY `render(ctx)`.

SDK surface (new public exports beside `defineConnector`):

- `defineStatusline({ render })` — typed authoring helper (validation, default name).
- `StatuslineContext`, `Segment` types.
- `segments` builder + `ansi`/`hostStyle(ctx.host, …)` helpers so one renderer styles
  correctly across a host that wants ANSI vs one that wants plain text vs markup.
- **AC-native data is the differentiator**: `ctx.context.percent` / `ctx.cost` and per-MCP
  token cost come from AC's OWN telemetry + usage subsystem (`src/usage`, `src/telemetry`),
  which already computes cross-host token usage. A HUD built on this SDK renders AC's
  telemetry in each host's status bar — not just re-formatting whatever the host happened to
  pass on stdin. This ties the HUD surface to the telemetry product thesis.

## 5. Adapter SPI additions (the template, filled)

Per adapter, three small additions — none touch existing adapters that opt out:

- `capabilities.supportsStatusline?: boolean` (read `?? false`).
- `statusInputContract`: which mechanism the host exposes — `"command-stdin-json"` |
  `"template-tokens"` | `"plugin-api"` | `"none"`. Drives parse + registration.
- `parseStatusInput(raw): StatuslineContext` and `formatStatusOutput(result): HostStatusReply`
  (default in BaseAdapter: stdin-JSON in, plain stdout out — claude-code shape — so
  command-stdin-json hosts inherit it; template-token / plugin-api hosts override).
- `installStatusline/uninstallStatusline` default to skip-warn "unsupported" in BaseAdapter
  (the installCommands/installMemory precedent), so unsupported hosts are safe and loud.

## 6. Per-host coverage (grounded — see §research)

The design degrades by the same rules as memory/configPatch. Three host classes:

- **command-stdin-json** (Claude-style): inherit the BaseAdapter parse/format; v1 target.
- **template-tokens / plugin-api**: addressable but need a per-adapter
  parse/format + a different registration (a config string with tokens, or an extension
  status-bar item). Renderer still portable via the normalized context.
- **none** (app-managed status bar / no documented surface): skip-warn with manual
  instructions — like cursor for memory.

Host survey — **ALL 29 adapters** (2026-06-14, authoritative-docs grounded; SPA-doc / forum
items flagged medium/low). Grouped by mechanism class:

**Class A — command-stdin (host runs a command, renders its stdout as the bar). DRIVABLE v1:**
| host | mechanism | conf |
|---|---|---|
| **claude-code** | `statusLine:{type:command}`, JSON on stdin → stdout bar (the reference) | high |
| **cursor** (`cursor-agent` CLI) | `/statusline` — command + stdin-JSON, deliberately Claude-compatible | medium (forum) |
| **droid** (Factory) | `statusLine:{command,padding?,maxRows?}` — command stdout rendered above input; `/statusline` | high (docs.factory.ai) |

→ **3 hosts**, convergent contracts. Meets the **≥3-host promotion criterion** to be a
normalized surface (the nativeHooks→hooks rule).

**Class B — in-process extension render (dev ships a TS module, NOT a shell command):**
| host | mechanism | conf |
|---|---|---|
| **pi** (`earendil-works/pi`) | extension TS `ExtensionAPI` can render a status line/footer/overlays in-process | high |
| **omp** (`oh-my-pi`) | same Pi-lineage in-process TS extension API | medium |

→ **2 hosts.** A SECOND mechanism: the SDK would emit a TS extension module here, not a
command. v2 candidate (maps to AC's ts-plugin idiom).

**Class C — IDE status-bar item via editor plugin API (click-command, not stdin renderer):**
vscode-copilot, jetbrains-copilot, kilo, roo-code → **4 hosts.** Requires an editor extension
(`createStatusBarItem` text/tooltip/`.command`-on-click). Not a content renderer; v2+ and
weaker fit.

**Class D — app-managed bar / theme / toggle / none (NOT drivable — skip-warn):** codex
(hooks pipe Claude-shaped JSON but **stdout ignored — no bar path**; `statusMessage` is a
transient label), gemini-cli, qwen-code (theme only), opencode, kilo-cli (`tui.jsonc`
themes/keybinds only), zed (`status_bar` boolean buttons), crush, goose (themes), copilot-cli
(hooks, no bar), warp (shell prompt; agent-HUD FR #8795), kiro (app bar; CLI statusline FRs),
amp (`amp.showCosts` toggle only), antigravity, antigravity-cli (`agy` sticky-panel,
app-managed), codebuff, hermes (`display.show_cost` toggle), kimi, openclaw (messaging
gateway, no TUI), trae (IDE app-managed) → **~19 hosts.**

**Class E — unknown:** mux (no single authoritative "mux" agent host could be identified) →
**1 host**, flagged for follow-up.

Tally: 3 (A) + 2 (B) + 4 (C) + 19 (D) + 1 (E) = **29**.

**Reality check that reshapes the ambition:** a true command-style status surface exists on
**3 of 29 hosts — Claude Code, Cursor's `cursor-agent` CLI, and Factory droid** — with
convergent Claude-shaped contracts. 2 more (pi/omp) render via an in-process TS extension API
(different mechanism). 4 IDE extensions can add a click-item. The remaining ~19 have an
app-managed bar (theme/toggle) or none. **Per-agent scoping exists on ZERO hosts** — the only
layering is per-project/profile config. Three consequences:

1. v1 reach = the **3 Class-A hosts** under ONE contract (command-stdin) — complete coverage
   of the command-style universe, not a slice; and it clears the 3-host promotion bar.
2. The SDK must model **two emission targets** to grow: a *command* entrypoint (Class A) and a
   *TS extension module* (Class B, pi/omp) — same `render(ctx)`, different packaging.
3. "Apply to specific agents only" CANNOT be delegated to hosts — **AC must own the scoping**
   (`platforms[id].statusline` + capability-gate). This *validates* making it an AC-owned
   surface rather than a host feature we lean on.

## 7. Why a surface, not "just keep using configPatch"

`configPatch` can WRITE the statusLine key but it is a blind set-if-absent key patch: no
input-contract parsing, no normalized renderer model, no per-host output framing, no
scoping semantics, no SDK. The `statusline` surface PROMOTES the claude-only
statusLine-via-configPatch into a first-class, multi-host, SDK-backed surface — the same
promotion path `nativeHooks` → normalized `hooks` follows (the documented ≥3-host
promotion criterion). configPatch remains the right tool for arbitrary one-off config keys;
the HUD is a recurring, structured, UI surface and earns its own.

## 8. Scoping model ("apply to specific agents only")

"Agent" here = the host CLI (a claude-code HUD vs a codex HUD). That maps to **per-host
scoping**, already native to AC: only the hosts with an implemented + supported renderer get
it; `platforms[id].statusline=false` opts a host out explicitly. (Secondary reading —
scoping a status surface to specific SUBAGENTS — is out of scope for v1: no host exposes a
per-subagent status line today; revisit if one ships.)

## 9. Phasing

- **v1 (Class A — command-stdin)** — `statusline` surface + SDK + **claude-code, cursor-agent
  CLI, and Factory droid** adapters. All three are command-stdin with convergent Claude-shaped
  contracts, so one BaseAdapter default + one renderer covers all three; AC owns the
  registration (claude: configPatch `statusLine`; cursor/droid: their settings) + the ledger.
  Ships `defineStatusline` + the universal `statusline` entrypoint. This is the COMPLETE
  command-style universe that exists today (3/29) — v1 is full coverage of drivable hosts, not
  a slice, and it clears the 3-host promotion bar to be a real normalized surface.
- **v2 (Class B — in-process TS extension)** — emit a TS extension MODULE (not a command) for
  pi / omp from the SAME `render(ctx)`, via AC's existing ts-plugin packaging idiom. This is
  why the SDK models two emission targets (§6 consequence 2).
- **v2.5 (Class C — IDE plugin-api)** — optional `createStatusBarItem` extensions for the VS
  Code / JetBrains family (vscode-copilot, jetbrains-copilot, kilo, roo-code); weaker fit
  (click-command, not a content renderer). Track host FRs (codex display-sink, warp #8795,
  kiro CLI statusline) and flip a capability flag if/when they ship.
- **v3 (the differentiator)** — wire AC telemetry/usage into `StatuslineContext`
  (`context.percent`, per-MCP cost) so the SDK's headline value is "render your AC telemetry in
  whatever bar the host has."

## 10. Open questions

- ~~Does any host besides claude-code expose a COMMAND-style status surface?~~ **ANSWERED by
  the survey:** exactly one — Cursor's `cursor-agent` CLI `/statusline` (Claude-compatible
  contract). Codex pipes Claude-shaped JSON to hooks but ignores stdout (no bar). So v1 is
  cross-host but only 2 hosts wide; the SDK's portability value is mostly future-proofing +
  the AC-telemetry data, not breadth.
- The user's "codex HUD" example is **not buildable today** — codex has no stdout→bar render
  path. Worth a tiny upstream FR to codex (it already pipes the right JSON; it just needs a
  display sink), which would make the codex adapter a one-line capability flip.
- Render cadence: claude-code spawns per-render; a cold `node` start per frame is heavy.
  Consider a resident-mode entrypoint or AC caching, reusing the HUD-cache-wrapper idea OMC
  already needed.
- For plugin-api hosts (IDE status-bar items), AC's "write a thin shim that calls the home
  bin" idiom (opencode ts-plugin) likely applies; confirm per host in v2.
