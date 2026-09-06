# Hook SDK Developer Support Proposal

Date: 2026-07-04

## Current Baseline

The hook SDK is already stronger than a plain config writer:

- `HookEventName` covers 13 normalized lifecycle events.
- `HookDefinition<E>` narrows handler payloads by event through `defineHook(event, def)`.
- `HookResponse` normalizes `allow`, `deny`, `modify`, `context`, and `ask`, with host adapters degrading unsupported fields.
- Per-host handler overrides exist through `hooks.<event>.hosts`.
- `platforms.<host>.nativeHooks` gives a host-scoped escape hatch for non-normalized native events.
- `@ken-jo/agent-connector/sdk/test` provides `explain`, `explainHooks`, and `simulate`, and `simulate` runs the real adapter parse -> handler -> format chain offline.

The main gap is not raw capability. It is developer ergonomics: plugin authors still need to know host-shaped payloads, matcher behavior, degradation semantics, and install/runtime wiring before they can confidently write hooks.

## Highest-Value Additions

### 1. Structured Hook Analysis API

Add `analyzeHooks(connector, opts?)` in `@ken-jo/agent-connector/sdk/test`.

Proposed shape:

```ts
const report = await analyzeHooks(connector, {
  hosts: ["claude-code", "codex", "qwen-code"],
  decisions: ["deny", "modify", "context", "ask"],
});
```

Output should be a stable JSON matrix:

- host
- event
- fires: boolean
- declared: boolean
- matcherStatus: `matches` | `excluded` | `invalid`
- requestedDecision
- honored: boolean
- degradationKind: `not-supported` | `decision-dropped` | `field-dropped` | `matcher-excluded` | `runtime-error`
- installEffect: `native` | `skip-warn` | `disabled`
- reason

Why: `explainHooks` is useful but still event-centric and terse. Plugin developers need a compatibility report they can paste into CI, docs, and release notes.

### 2. Hook Fixture Builders

Add host/event payload helpers so developers do not need to hand-author raw host JSON for `simulate`.

Proposed exports:

```ts
sampleHookPayload("claude-code", "PreToolUse", {
  toolName: "Bash",
  toolInput: { command: "echo hi" },
});

sampleHookPayload("codex", "UserPromptSubmit", {
  prompt: "refactor this",
});
```

Also provide event-level defaults:

```ts
sampleEvent("PreToolUse", { toolName: "acme_query" });
```

Why: current `simulate` correctly expects host-shaped raw payloads, but that is exactly the hard part for a plugin author who is trying to test behavior before learning every host dialect.

### 3. Richer `simulate` Result

Keep the current simple result, but add structured optional fields.

Proposed extension:

```ts
interface SimulateResult {
  honored: boolean;
  hostReply?: string;
  reason: string;
  parsedEvent?: EventPayloadMap[HookEventName];
  handlerResponse?: HookResponse;
  formattedReply?: { stdout?: string; exitCode?: number };
  degradation?: {
    kind: "decision-dropped" | "field-dropped" | "unsupported-event" | "handler-error";
    droppedFields?: string[];
  };
  capabilities?: PlatformCapabilities;
}
```

Why: `honored:false` is not enough during development. Authors need to know whether the handler did not run, the matcher excluded it, the response was unsupported, or a specific response field was dropped.

### 4. Matcher Utilities

Add utilities around matcher behavior:

```ts
compileHookMatcher(matcher);
matchesHookSubject(matcher, { event: "PreToolUse", toolName: "Bash" });
explainMatcher(connector, { event: "PreToolUse", host: "claude-code" });
```

Why: matchers are deceptively simple but affect whether hooks run at all. The SDK should catch invalid regexes and show sample subjects that pass/fail.

### 5. Hook Replay CLI

Add a developer-only CLI surface:

```bash
agent-connector hooks simulate --host claude-code --event PreToolUse --connector ./agent-connector.config.mjs --fixture bash
agent-connector hooks replay --host claude-code --event PreToolUse --stdin payload.json --connector ./agent-connector.config.mjs
agent-connector hooks matrix --connector ./agent-connector.config.mjs --json
```

Why: `@ken-jo/agent-connector/sdk/test` is good for tests. CLI replay is better for plugin developers debugging payloads from real host logs or docs.

## Medium-Term Additions

### 6. Optional Second-Argument Hook Context

Add a non-breaking optional second argument:

```ts
handler(event, ctx) {
  ctx.log.info("checking tool call");
  const recent = await ctx.state.get("lastDecision");
}
```

Suggested fields:

- `ctx.host`
- `ctx.connectorId`
- `ctx.capabilities`
- `ctx.scope`
- `ctx.log`
- `ctx.state` small namespaced key/value store
- `ctx.telemetry`
- `ctx.redact(value)`

Why: event objects already carry runtime metadata, but a dedicated context object is clearer and gives room for logging/state/secrets without bloating every event payload.

### 7. Native Hook Metadata Catalog

Keep `nativeHooks` raw by default, but expose metadata:

```ts
nativeHookEvents("claude-code");
nativeHookPayloadSchema("claude-code", "TaskCompleted");
```

Start with schema metadata and examples rather than full TypeScript payload typing for every host-only event.

Why: raw passthrough is the right escape hatch, but plugin developers need discoverability for host-only events.

### 8. Hook Recipes Package

Ship copyable recipes under docs and examples:

- deny dangerous shell commands
- redact secret-looking tool inputs
- inject project context on session start
- ask before network or file writes
- record hook telemetry
- per-host override when a host drops `context` or `modify`

Why: most plugin developers will start from a guard/telemetry/context-injection use case, not from the full event model.

## Guardrails

- Do not promote host-only native events into the normalized union until multiple hosts have real analogs.
- Do not mark a response as honored unless the real adapter output carries the intent.
- Do not add a broad policy DSL before the low-level analysis/replay tools are solid.
- Keep `llms.txt` short; detailed hook examples belong in `llms-full.txt`, docs, and skill references.

## Recommended Build Order

1. Add `sampleHookPayload` / `sampleEvent` fixture builders.
2. Extend `simulate` with structured optional fields while preserving the current return contract.
3. Add `analyzeHooks` as the CI-friendly compatibility matrix.
4. Add `agent-connector hooks simulate|replay|matrix` CLI commands on top of the same SDK internals.
5. Add matcher utilities and recipes.
6. Add optional `handler(event, ctx)` after the analysis tools prove the context fields developers actually need.
