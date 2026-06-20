# verify-host — the MANUAL live-smoke harness

`scripts/verify-host.mjs` drives a host's **real, authed CLI** against a generated
`agent-connector` connector in an **isolated, auth-preserving** sandbox HOME and
asserts that the host actually accepts, loads, fires, honors, and cleanly removes
what we install. It is the live complement to the binary-free CI test
`tests/integration/install-roundtrip.test.ts` (which proves config placement +
removal for all 35 adapters headlessly, in-process).

> **This harness is MANUAL, not CI.** Most lanes need a real authed host CLI on
> the box (and, for runtime lanes, a model turn). A missing binary or missing
> auth is a **SKIP**, never a failure. Do **not** wire any of this into
> `.github/workflows/`. The CI complement is `install-roundtrip.test.ts`.

## Two layers

### 1. Default roundtrip (CI-safe, no `--verb`)

```
node scripts/verify-host.mjs <host-id> [--scope user|project] [--keep] [--install]
node scripts/verify-host.mjs --all     [--scope user|project] [--keep] [--install]
```

Climbs as far as the host's binary + auth allow: **install-roundtrip → live-accept
→ live-runtime**, then asserts uninstall leaves zero residue. Exit 1 only on a real
placement miss or residue (an `OUR`-code bug). Everything else is a skip → exit 0.
Requires the dev fixture connector `.acverify/agent-connector.config.mjs` (untracked,
like `.omg/`).

### 2. Deep-verb live-smoke lanes (`--verb` / `--all-verbs`)

```
node scripts/verify-host.mjs <host-id> --verb <verb> [--scope ...] [--keep]
node scripts/verify-host.mjs <host-id> --all-verbs   [--scope ...] [--keep]
```

Each lane codifies a recipe that a verification workflow **live-verified** on a real
authed CLI. The harness generates a verb-specific connector into the repo-tree
`.acverify/` dir (so its `import "@ken-jo/agent-connector"` resolves via the repo
self-link), builds the auth-preserving sandbox, drives the host, and asserts a real
signal. JSON results stream on stdout; a human summary on stderr.

Lane result statuses:

| result | meaning |
|---|---|
| `pass` | the live assertion held (the host did the thing) |
| `skip` | binary/auth absent, or a turn timed out — never a failure |
| `ceiling` | a rung was driven (placement / dispatcher-render) but the host's final render needs an interactive TUI we cannot drive headless |
| `unsupported` | the host has no field/path for this behavior (honest, by design) |
| `bug` | the host supports the protocol but our adapter writes bytes it does not honor (recorded, not passed) |
| `fail` | the live assertion did **not** hold → exit 1 |

## Prerequisites for the deep-verb lanes

- A **built** `dist/cli.js` (`npm run build`).
- The committed MCP fixture `scripts/verify-mcp-echo-server.mjs` (a zero-dep
  JSON-RPC stdio server exposing one `ac_echo` tool; logs handshake + tool calls
  so a lane can assert load/call/telemetry). It is committed; nothing to do.
- A **real authed** host CLI for the host you target:
  - `copilot-cli` — `~/.copilot/config.json` with `loggedInUsers`/`copilotTokens`.
    The sandbox copies it, resets our mcp+hooks surfaces, **scrubs** the absolute
    real-HOME paths in `installedPlugins[].cache_path`/`source.path`, empties
    `installedPlugins`, and removes `session-store.db` (the escape guard).
  - `claude-code` — `~/.claude/.credentials.json` + `~/.claude.json`. The sandbox
    copies the credentials and writes an onboarding-stamped `.claude.json` (and
    pre-approves the sandboxed project so a project-scope MCP is not "Pending").
  - `opencode` — no auth needed; advances offline with the bundled zero-auth model
    `opencode/big-pickle`.
  - `antigravity-cli` (`agy`) — **authed-runtime** (no offline model): a turn needs
    the real Google OAuth token. The sandbox copies `~/.gemini/oauth_creds.json`
    (+ `google_accounts.json`/`installation_id`/`settings.json`/`state.json`/
    `trustedFolders.json`) and `~/.gemini/antigravity-cli/antigravity-oauth-token`
    (+ `installation_id`/`settings.json`/`keybindings.json`), and starts with an
    **empty** `~/.gemini/config` so our `mcp_config.json` + `hooks.json` are written
    fresh. A turn runs `agy --dangerously-skip-permissions --model 'Gemini 3.5 Flash
    (Low)' -p <prompt>`; the dual oracle is our `events.log` + the host's own
    `~/.gemini/antigravity-cli/cli.log` (`jsonhook__hooks_<Event>_0_0`).

The real HOME is **never written**. Sandbox prep only ever reads from it.

## Codified lane matrix (live-verified)

`V` = verified (real lane) · `CB` = ceiling-blocked (driven rung + honest ceiling) ·
`U` = host-unsupported · `BUG` = host-supported-but-adapter-broken.

| verb | copilot-cli | claude-code | opencode | antigravity-cli |
|---|---|---|---|---|
| mcp-install | V | V (project) | V | V |
| mcp-tool-load | V | V | V | V |
| mcp-tool-call | V | V | V | V |
| telemetry | V | V | V | V |
| hook-fire | (roundtrip lane) | — | V | V |
| per-event-fire | V | V | V | V⁵ |
| hook-reply-deny | V¹ | V | V | V |
| hook-reply-context | **U** | V | V | **CB**⁶ |
| content-command | — | V | V | — |
| content-skill | — | V | **CB**² | **CB**⁷ |
| content-subagent | — | V | V³ | **U**⁸ |
| content-memory | — | V | — | (in content-skill⁷) |
| content-statusline | — | **CB**⁴ | — | — |
| update | V | V | V | V |
| doctor | V | V | V | V |
| uninstall-residue | V | V | V | V |
| idempotency | V | V | V | V |
| coexistence | V | V | V | V |

Honest ceilings / non-gaps recorded by the lanes:

1. **copilot-cli `hook-reply-deny`** — the original spec marked this ceiling-blocked
   (two adapter bugs: deny nested under `hookSpecificOutput`, and snake_case
   `parseEvent`). Both are **fixed on the `fix/copilot-cli-reply-and-pretooluse-input`
   branch** (flat top-level `permissionDecision` + camelCase `toolName`/`toolArgs`),
   so the lane is now **V** and the runner asserts the tool is BLOCKED.
2. **opencode `content-skill`** — opencode has no headless `skill list/run` verb;
   the lane verifies placement (and doctor/residue via the lifecycle lanes), and
   records in-session model self-invocation as the un-driveable-offline ceiling.
3. **opencode `content-subagent`** — pass = `opencode agent list` shows the subagent
   **and** `--agent <name>` emits no "not found / falling back" warning. A
   subagent-mode system-prompt marker on a direct primary run is not reliable
   (documented ceiling inside the recipe).
4. **claude-code `content-statusline`** — placement + dispatcher-render are driven;
   the host actually rendering the line needs an interactive TUI (`claude -p` never
   refreshes the status line), so host-render is a documented TUI-only ceiling.
5. **antigravity-cli `per-event-fire`** — `agy -p` (print mode) fires **PreToolUse**
   (toolName `run_command`) + **PostToolUse** (the adapter sends no tool fields on
   PostToolUse → `toolName ""`) + **Stop**. `SessionStart` is **not** fireable under
   print mode (it only fires on an interactive session start) and `UserPromptSubmit`
   is host-unsupported (install warn-skips it) — both are honest carve-outs the lane
   records, not failures. Live-verified on `agy 1.0.9`/`1.0.10`; the dual oracle is
   our `events.log` + the host's own `cli.log` `jsonhook__hooks_<Event>_0_0` lines.
6. **antigravity-cli `hook-reply-context`** — the reply-**render** rung is driven via
   direct home-bin dispatch (the adapter emits `{"additionalContext":"…ZX9…"}` for a
   SessionStart context reply). The host's **consumption** is the ceiling: SessionStart
   never fires under `agy -p`, so headless activation is not observable (interactive
   session start only).
7. **antigravity-cli `content-skill`** — covers the markdown content surfaces:
   placement is verified (skill → `~/.gemini/antigravity-cli/skills/<n>/SKILL.md`,
   workflow → `~/.gemini/antigravity/global_workflows/<n>.md`, memory →
   `~/.gemini/AGENTS.md` managed block). Headless `agy -p` **activation** of a
   workflow/skill is model-discretion (non-deterministic offline) — the ceiling.
8. **antigravity-cli `content-subagent`** — host-unsupported: antigravity-cli has no
   subagent surface; install warn-skips ("subagents not supported on antigravity-cli").

**copilot-cli `hook-reply-context`** is **host-unsupported**: copilot 1.0.63 has no
`additionalContext` injection field (only a full `modifiedPrompt` rewrite, which
`HookResponse` does not expose). The lane records this honestly without a host run.

**antigravity-cli is an authed-runtime lane**, not a bundled-offline-model lane:
unlike `opencode` (zero-auth model) the deep-verb lanes require the real Google OAuth
token copied into the sandbox. There is **no** reproducible network-install entry for
`agy` (it ships through the Antigravity app installer, not npm or a pinned vendor URL),
so it is not in `HOST_INSTALL`; the lane is exercised only where `agy` is already
present and authed on the box. A missing/unauthed `agy` is a **SKIP**, never a failure.

## Examples

```bash
npm run build                                   # dist/cli.js must exist

# one lane:
node scripts/verify-host.mjs copilot-cli     --verb mcp-tool-call
node scripts/verify-host.mjs claude-code      --verb hook-reply-deny
node scripts/verify-host.mjs opencode         --verb hook-fire
node scripts/verify-host.mjs antigravity-cli  --verb per-event-fire

# every codified lane for a host:
node scripts/verify-host.mjs claude-code --all-verbs
```

The `verify:host` package script passes args through, so the npm equivalents are:

```bash
npm run verify:host -- copilot-cli --verb mcp-tool-call
npm run verify:host -- claude-code --all-verbs
```

## Honest ceiling — what this harness can and cannot reach

It reaches exactly the verbs codified above for `copilot-cli`, `claude-code`,
`opencode`, and `antigravity-cli` (the four hosts a verification workflow
live-confirmed). Other hosts have no deep-verb recipe yet and report `no-lane` for
`--verb` — they remain covered for placement by `install-roundtrip.test.ts`. Adding a
host means adding a runner + a `HOST_VERBS` entry grounded in a real live run (never a
guessed recipe).
