# Design — a unified Connector SDK (per-surface, host-aware)

Status: PROPOSAL (2026-06-14). Generalizes `statusline-hud-surface-design.md` from one
surface to ALL of them: give connector developers an SDK that supports EACH surface, with
first-class host-specific implementation, so "write once, deploy across 29 hosts" extends
from declarative content to runtime behavior — and degrades honestly where a host can't.

## 1. What already exists (the SDK bones)

agent-connector already ships a partial SDK across three subpaths:

| subpath | exports today | role |
|---|---|---|
| `.` (`@ken-jo/agent-connector`) | `defineConnector`, `ConnectorConfigError`, + the full normalized type set (`HookDefinition`, `HookEventName`, `EventPayloadMap`, `PreToolUseEvent`…`SubagentStopEvent`, `*Def`, `PlatformCapabilities`, `PlatformOverride`, …) | declarative authoring API + the normalized contracts |
| `./runtime` | `runHook`, `runNativeHook`, `isNativeHookDeclared`, `runServe`, `runUsageEvent` | the universal entrypoint runtimes (parse → handler → format → fail-safe; telemetry proxy) |
| `./cli` | `createConnectorCli` | the branded-bin factory the ports use |

So the hard parts already exist: a **normalized event model**, a **runtime that
parses per-host input → normalized → runs the handler → formats per-host output → fails
open**, and **capability flags** that gate/skip-warn. The gap is that this is exposed only
for hooks, only as raw primitives — there is no per-surface authoring sugar, no host-aware
helpers, no per-host implementation map beyond hooks, no offline test harness, and no
"what actually runs where" introspection.

## 2. The four surface kinds (what SDK support each needs)

Every AC surface is one of four kinds. The SDK supports each differently:

- **Content surfaces** — `commands`, `skills`, `subagents`, `memory`. Pure declarative data;
  AC writes native files per host. No runtime. SDK support = typed builders + validation +
  per-host `extra`/override + `path`/`mode` tuning (already largely present as the `*Def`
  types). "Host-specific" here = per-host field overrides, not code.
- **Handler surfaces** — `hooks`, and (proposed) `statusline`. A developer FUNCTION runs at a
  host event/render, receives a NORMALIZED context, returns a normalized result AC formats
  per host. This is where "support each host" is real work — and where the SDK adds the most.
- **Config surfaces** — `configPatch`, `nativeHooks`. Host-native escape hatches (set-if-absent
  key patches; verbatim host hook events). SDK support = typed builders + the
  ownership/denylist/namespace safety already implemented.
- **Interactive / action surfaces** (NEW — §3b) — host-native UI a user CLICKS or that DOES
  something: a status-bar item with a click action, a command-palette entry, a
  notification/toast with buttons, a keybinding, a quick/code action, a context-menu item, a
  webview panel. Unlike a passive HUD, these bind a visible affordance to an ACTION, and they
  exist only where the host runs the developer's code (a plugin/extension) or accepts a
  declarative binding. This is the Class C family from `statusline-hud-surface-design.md`,
  generalized.

## 3. The unifying primitive: `HostCtx` + per-host implementation

Every handler surface handler already receives a normalized context carrying `host`
(`evt.hostPlatform` today). Promote that into a documented, shared shape and build the SDK on
it:

```ts
interface HostCtx {
  host: PlatformId;                 // branch point for per-host divergence
  capabilities: PlatformCapabilities; // what this host can actually honor (read-only)
  scope: InstallScope;
  projectDir?: string;
  sessionId?: string;
}
// hooks:      NormalizedEvent extends HostCtx
// statusline: StatuslineContext extends HostCtx
```

Two authoring modes for EVERY handler surface (this is the generalization of the proposed
statusline `hosts:` field to all of them):

```ts
// (a) one portable handler, branch on ctx.host where needed:
hooks: { PreToolUse: { handler(evt) { if (evt.host === "codex") …; return … } } }

// (b) per-host implementations — "implement each host separately", the user's ask:
hooks: { PreToolUse: { hosts: {
  "claude-code": { handler: claudePreTool },
  "codex":       { handler: codexPreTool },
} } }
```

AC resolves the right impl per host, **capability-gates** it (a handler declared for a host
that can't honor that event → skip-warn ChangeRecord, never silent — the existing
content-surface precedent), and at runtime the universal entrypoint formats the result into
that host's reply shape.

## 3b. Interactive / action surfaces (the Class C family, generalized)

The defining property: an affordance the user can SEE and ACT ON. It needs (a) a place to
appear and (b) an ACTION to run. Unlike content (files) and the HUD (passive stdout), this
requires the host to either run the developer's code in-process (an extension/plugin) or
accept a declarative "when clicked → run X" binding. So it lives only on
plugin/extension-capable hosts — which is exactly the set AC already deploys to via its
ts-plugin paradigm (opencode/kilo/openclaw today; pi/omp via TS extension; VS Code/JetBrains
via a GENERATED extension — new).

### Normalized affordance + action model

Split the visible affordance from the action it triggers, so one action backs many
affordances and the action set is normalized (the part AC can dispatch uniformly):

```ts
interface AffordanceDef {
  id: string;
  kind: "statusItem" | "command" | "notification"
      | "keybinding" | "quickAction" | "contextMenu" | "panel";
  label?: string; icon?: string; tooltip?: string;
  action: ActionRef;          // what happens when invoked
  when?: string;              // host-native visibility condition (passthrough → extra)
  hosts?: Partial<Record<PlatformId, { /* per-host overrides / native bits */ }>>;
}

type ActionRef =
  | { runCommand: string }    // invoke one of THIS connector's slash commands
  | { callTool: string; args?: JsonValue }  // invoke a tool on the connector's MCP server
  | { runHandler: string }    // call a dev handler via the universal entrypoint
  | { openUrl: string }
  | { insertText: string } | { sendPrompt: string };
```

The **click-command** the user asked for = `kind:"statusItem"` (or `"command"`) with
`action:{runCommand}` / `{runHandler}`. On VS Code that becomes a `StatusBarItem` whose
`.command` dispatches to the home bin; on a TUI/CLI host it becomes whatever that host's
plugin API allows (or skip-warn).

### Action dispatch = a new universal verb (mirrors hook/statusline)

`runHandler`/`runCommand`/`callTool` all resolve through ONE entrypoint, the same
parse→resolve→run→format→fail-safe spine as hooks:

```
agent-connector action <platform> <actionId> --connector <id>
  ↳ resolve ActionRef → run the connector's command / MCP tool / dev handler (HostCtx)
  ↳ return the host-appropriate result (text to insert, notification, nothing)
```

So a developer writes `defineAction({ id, run(ctx) })` once; AC wires every affordance that
references it, on every host that can host it.

### Emission targets (how AC deploys an affordance per host)

| host class | emission | what's deployable |
|---|---|---|
| VS Code / JetBrains family (Class C) | AC **generates an extension** registering the affordances; click → home bin `action` | the full set: statusItem-click, palette, notification, keybinding, quickAction, contextMenu, panel — IF the fork permits third-party extensions |
| in-process TS extension (pi/omp) | AC emits a TS module using the host `ExtensionAPI` | whatever that API exposes (status line/overlays confirmed; actions TBD by survey) |
| ts-plugin (opencode/kilo-cli/openclaw) | extend the existing generated plugin module | whatever the plugin API supports (commands; notifications maybe) |
| CLI command-stdin (claude/cursor/droid) | none for clicks (a status line can't be interactive) — declarative keybindings only where a config exists | keybinding/none |
| app-managed (the rest) | skip-warn with manual instructions | none |

### Affordance × host matrix (survey, 2026-06-14)

Kinds: 1 status-item-click · 2 palette/slash · 3 notification(+buttons) · 4 keybinding ·
5 quick/code-action · 6 context-menu · 7 webview/panel.

| host | kinds | mechanism | conf |
|---|---|---|---|
| **vscode-copilot, kilo, roo-code** (VS Code ext API) | **1–7 (full)** | `createStatusBarItem({command})`, `registerCommand`, `showInformationMessage(…items)`, `contributes.keybindings`, `registerCodeActionsProvider`, `contributes.menus`, `createWebviewPanel` | high |
| **jetbrains-copilot** (IntelliJ Platform) | **1–7 (full)** | `StatusBarWidgetFactory`, `AnAction`/plugin.xml, `Notifications`, `keyboard-shortcut`, `IntentionAction`/`LocalQuickFix`, `EditorPopupMenu`, `ToolWindow`+JCEF | high |
| **antigravity** (IDE, VS Code/Windsurf lineage) | **1–7** (via ext host, Open VSX) | = VS Code ext API; 3rd-party via Open VSX | medium (lineage-inferred) |
| **pi** (in-process TS `ExtensionAPI`) | **2,4,7** + soft 1,3 (TUI) | `registerCommand`, keybindings, render status-line/footer/overlays/widgets; status-bar render-only (no mouse click), notifications = TUI stream; NO 5/6 | high |
| **omp** (oh-my-pi, Pi lineage) | =pi (assumed) | same `ExtensionAPI` | low (no authoritative source) |
| **opencode, kilo-cli** | **none** (code-capable, UI-incapable) | plugin `Hooks` = tools/events/`command.execute.before` only — NO UI registration surface | high (opencode) / medium (kilo-cli) |
| **openclaw** | **2** only | chat/slash commands (`/status`…); messaging gateway, no host UI | low |
| **antigravity-cli** | **none** UI | CLI plugins = agent-skill/MCP bundles, not UI | high |
| **claude-code, cursor, droid, codex, gemini-cli, qwen-code, warp, zed, crush, goose, copilot-cli, amp, codebuff, hermes, kimi, mux, trae** | **none** | CLI/TUI status is app-managed or one-shot; no plugin UI-registration surface | high (most) |

**The split the survey forces — separate "action" deployability from "affordance"
deployability:**

- An **action** (the invokable behavior: run a command / call a tool / run a handler) is
  deployable on EVERY code-capable host — VS Code-family, JetBrains, pi/omp, AND
  opencode/kilo-cli/openclaw (via their command/hook surface). Broad.
- An **affordance** (the VISIBLE clickable trigger) is gated by host UI capability:
  - **true mouse-clickable + full set (1–7):** VS Code-family + JetBrains = **5 GUI-IDE hosts**.
  - **TUI-only (2,4,7; status-bar render-only):** pi/omp.
  - **slash-only (2):** openclaw.
  - **none:** opencode/kilo-cli (code runs, but no UI surface) + all CLI/TUI hosts.

This is exactly why §3 splits `AffordanceDef` from `ActionRef`: AC can deploy the ACTION
widely and the AFFORDANCE only where the host has a UI surface — capability-gated per kind,
skip-warn elsewhere. opencode/kilo-cli are the sharp case: deploy the action (a slash command
backed by the handler), skip-warn the visible affordance.

**ROI ordering (most-widely-available first):** (2) palette/slash and (4) keybinding are
available on every plugin-capable host → abstract first; (3) notification next (broad, though
action-BUTTONS are first-class only on VS Code+JetBrains); (1) clickable status-bar + (7)
webview + (5) code-action are high-value but **GUI-IDE-only** → gate behind a
`supportsRichUI` capability flag.

### Honest caveat — this is the heaviest surface

Generating and maintaining a real IDE extension (manifest, activation, packaging, the host's
review/marketplace rules) is materially more work than writing a file or a configPatch, and
several VS Code forks restrict the third-party extension host. So phase by ROI: the
affordances that are CHEAP and WIDELY available first (command-palette entries and
notifications exist on many hosts), then status-bar-click / webview (IDE-extension-only).
The survey's "widest-availability" bullet drives that ordering.

## 4. SDK helpers (the part that removes per-host plumbing)

Provided from a documented `@ken-jo/agent-connector/sdk` subpath (consolidating today's
scattered `.`/`./runtime`):

- **`define*` authoring family** — typed, validated, with autocomplete:
  `defineConnector` (exists), `defineHook`, `defineStatusline`, `defineCommand`,
  `defineSkill`, `defineSubagent`, `defineMemory`, `defineConfigPatch`, `defineNativeHook`,
  and for the interactive family (§3b) `defineAffordance` + `defineAction`. Sugar over the
  `*Def` shapes; the value is types + early validation + the `hosts:` map.
- **host introspection** — `capabilitiesOf(host)`, `hostsSupporting(surface)` so a dev can
  see, at author time, exactly which hosts will honor a surface (e.g. "UserPromptSubmit
  context injection: claude-code, gemini-cli — NOT codex").
- **host-aware output helpers** — `style(ctx, segments)` (ANSI vs plain vs markup per host),
  `toolName(ctx, baseName)` (resolve `mcp__<id>__tool` vs bare per host — the lesson from
  context-mode's `createToolNamer`, which is exactly why its routing block could NOT be a
  static memory block). These let ONE handler emit host-correct output.
- **telemetry access** — `ctx.telemetry.read({sinceMs})` / context-window + per-MCP token
  cost from AC's own `src/usage` + `src/telemetry`. The cross-cutting differentiator: any
  surface (a HUD, a SessionStart banner, a PostToolUse nudge) can render AC's telemetry.
- **the runtime** — `runHook`/`runStatusline`/`runServe` (exists/extends): parse → resolve
  per-host impl → run → format → **fail-safe**. Developers never touch it directly (the bin
  does), but it's the SDK's spine.

## 5. Offline test harness (so "does it work on host X" is answerable without host X)

The whole session's hard-won lessons (codex drops UserPromptSubmit context; HUD is
claude-only; memory skip-warns on cursor) should be discoverable by the DEVELOPER, not only
by live dogfooding. Ship a `simulate` harness:

```ts
import { simulate } from "@ken-jo/agent-connector/sdk/test";
const out = await simulate(connector, {
  surface: "hooks", event: "UserPromptSubmit", host: "codex",
  input: { prompt: "ralph fix the build" },
});
// → { honored: false, reason: "codex drops additionalContext on UserPromptSubmit",
//     hostReply: "" }   ← the SAME verdict my live test produced, offline
```

`simulate` runs the real parse→handler→format path against an adapter's declared capabilities
and returns `{honored, hostReply, reason}`. Plus a static `explain(connector)` that prints the
full per-host × per-surface matrix at build time (the matrix I had to discover by hand).

## 6. Packaging

- Introduce `@ken-jo/agent-connector/sdk` = the developer-facing surface (all `define*` +
  context types + helpers), re-exporting from today's `.`/`./runtime` so nothing breaks.
- `@ken-jo/agent-connector/sdk/test` = the `simulate`/`explain` harness (no runtime deps on a
  host).
- `./cli` (`createConnectorCli`) stays as-is. `./runtime` stays as the internal spine.
- Author guide: ONE doc per surface kind (content / handler / config), each ending with the
  `simulate` snippet for that surface.

## 7. Phasing

- **P1 — formalize handler surfaces.** Ship `defineHook` + `defineStatusline`, the shared
  `HostCtx`, the `hosts:` per-host map across handler surfaces, and `runStatusline`. (Pulls in
  the statusline v1: claude/cursor-CLI/droid.)
- **P2 — host-aware helpers + introspection.** `style`/`toolName`/`capabilitiesOf`/
  `hostsSupporting`. Retire the per-connector reimplementations (context-mode's toolNamer, the
  OMC bridge's hand-rolled reply merging) onto SDK helpers.
- **P3 — test harness.** `simulate` + `explain`; wire `explain` into `doctor --explain`.
- **P4 — telemetry in context.** `ctx.telemetry` for all handler surfaces (the differentiator).
- **P5 — content-surface builders + the consolidated `/sdk` subpath + author guides.**
- **P6 — interactive / action surfaces (§3b), in survey-ROI order:**
  - **P6a — actions everywhere.** `defineAction` + the universal `action` verb, exposed as
    palette/slash (#2) + keybinding (#4) — available on every code-capable host (incl.
    opencode/kilo-cli as a slash command, openclaw as a chat command). Broadest reach, no IDE
    extension needed.
  - **P6b — notifications (#3).** `defineAffordance{kind:"notification"}` — broad; action-
    BUTTONS first-class only on VS Code + JetBrains (degrade to a plain toast elsewhere).
  - **P6c — rich GUI affordances (#1 status-bar-click, #7 webview, #5 code-action, #6
    context-menu)** behind a `supportsRichUI` capability flag — requires AC to GENERATE an
    IDE extension (VS Code-family + JetBrains = 5 hosts; pi/omp get the TUI subset). Heaviest;
    several forks ship Open VSX, not the MS Marketplace — verify per host before relying on it.

## 8. Why this is the right generalization

The HUD investigation proved AC's real value is the **normalization + capability-gating +
scoping + telemetry** layer, not any single surface. An SDK that exposes that layer per
surface — with a uniform `HostCtx`, a uniform `hosts:` per-host map, uniform skip-warn
gating, a uniform `simulate` — lets a developer "support each host" for HUD, hooks, and
content the same way, and learn the honest reach of each at author time. It turns the
one-off lessons of this session (what works on codex vs gemini vs cursor) into a reusable,
queryable part of the framework.

## 9. Open questions

- `hosts:` map vs branch-on-`ctx.host`: keep BOTH (map for cleanly-separate impls per the
  user's ask; branch for small divergences). Validation must reject a `hosts:` entry for an
  unknown/incapable host (error vs skip-warn — lean error at author time, skip-warn at
  install).
- `simulate` fidelity: it models the adapter's declared capabilities + parse/format, but a
  handler that shells out (the OMC bridge spawning real scripts) only runs if its deps are
  present — document that `simulate` proves the AC plumbing, not the dev's external process.
- Should content-surface `define*` builders be mandatory or sugar? Sugar — the `*Def` object
  shapes must keep working (the OMC/context-mode ports build them programmatically).
