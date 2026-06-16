# Host-specific hook events: core promotion vs. nativeHooks

**Status:** accepted · **Date:** 2026-06-16

Agent CLIs keep adding hook events beyond the canonical set agent-connector
normalizes. This note records the rule we use to decide whether a newly-discovered
host event becomes a **core** `HookEventName` (normalized, cross-host) or stays a
**host-specific** event reached through the `nativeHooks` passthrough — and applies
it to the events surfaced by the 2026-06 official-doc surface audit.

## The two tiers

1. **Core `HookEventName`** (`src/core/types.ts`). A normalized event with a
   `NormalizedEvent` interface, a `parseEvent` mapping on every supporting adapter,
   a `PlatformCapabilities` flag, a hooks-matrix cell, and a place in the
   allow/deny/context/ask **decision model** (`HookResponse`). Adding one is a
   cross-cutting change: every adapter must decide how it maps (or warn-skips) the
   event, and the drift tests enforce capability⟺matrix⟺parse consistency.

2. **Host-specific events via `nativeHooks`.** A connector declares
   `platforms["<host>"].nativeHooks: { "<EventName>": { handler } }`. Dispatch
   bypasses the normalized parse/format entirely: raw host stdin → handler →
   verbatim host stdout (`runNativeHook` in `src/runtime`, gated by
   `isNativeHookDeclared`). This is the seam for events that are real on one host
   but do not belong in the shared model.

## Promotion criteria (host event → core `HookEventName`)

Promote **only when both** hold:

- **≥3-host support.** At least three registered hosts fire an analogous event.
  A 1- or 2-host event in the core union forces all ~35 adapters to reason about
  something almost none of them have — net complexity with no cross-host payoff.
  (Two hosts plus a strong structural pair — see PostCompact — is a judgment-call
  boundary, not an automatic promotion.)
- **Fits the decision model.** The event's host-side effect maps onto
  allow / deny / context / ask (+ the existing modify flags). An event whose
  contract is to *rewrite the request*, *mock a response*, *swap the model*, or
  *filter the tool list* does not fit; normalizing it would mean inventing a
  decision shape no other host honors.

If either fails, the event stays host-specific (nativeHooks). Honesty rule: a
declared-but-unsupported **core** event must warn-skip at install — never silently
drop (`warnSkipHookEvents`). A host-specific event simply isn't a core event, so it
never reaches that path; it is documented as nativeHooks-eligible instead.

## Worked decisions (2026-06 audit)

### Promoted — PostCompact (#48)

- **Hosts:** codex (fires natively) + kimi (fires natively) — and it is the natural
  pair of the already-core `PreCompact`.
- **Decision model:** pure observation (`trigger: manual|auto`), exactly like
  PreCompact. Fits.
- **Outcome:** promoted to the core union, wired on codex, parse-ready on kimi,
  added to the CLI dispatch gate + Claude-bundle set with a drift guard.

### Not promoted — kimi: StopFailure, PermissionResult, Interrupt (#39)

| Event | Payload | Effect | Hosts |
| --- | --- | --- | --- |
| `StopFailure` | error type | observation only | kimi only |
| `PermissionResult` | tool name | observation only | kimi only |
| `Interrupt` | reason (Esc) | observation only | kimi only |

- **≥3-host:** no — each is documented for kimi alone; the audit surfaced no analog
  on any other host.
- **Decision model:** they would fit (observation-only), but the host-count bar is
  not met.
- **Outcome:** nativeHooks-eligible. `Interrupt` is the most interesting (kimi fires
  it instead of `Stop` on a user Esc), but "useful" is not the bar — host count is.
  Re-promote if ≥2 more hosts add an interrupt/turn-failure/permission-result hook.

### Not promoted — gemini-cli: BeforeModel, AfterAgent, BeforeToolSelection (#36)

| Event | When | Documented effect |
| --- | --- | --- |
| `BeforeModel` | before sending the request to the LLM | Block Turn / **Mock** — modify prompts, swap models, mock responses |
| `AfterAgent` | when the agent loop ends | **Retry / Halt** — force retry or halt execution |
| `BeforeToolSelection` | before the LLM selects tools | **Filter Tools** — filter the available tool list |

- **≥3-host:** no — gemini-cli only. These are part of gemini's LLM-lifecycle hook
  family (`BeforeAgent`/`BeforeModel`/`AfterModel`/`BeforeToolSelection`/…), which no
  other registered host exposes.
- **Decision model:** **fails twice over.** Their contract is to *mutate the
  request/flow* — override `llm_request`, emit a synthetic `llm_response`, rewrite
  `toolConfig`, force a retry. None of that maps to allow/deny/context/ask. Even if a
  second and third host appeared, these would need a *new* request-mutating decision
  shape before they could be normalized.
- **Outcome:** nativeHooks-eligible; `#36` stays honestly unwired as core events. A
  connector that needs gemini's lifecycle hooks declares them under
  `platforms["gemini-cli"].nativeHooks` and works the raw gemini wire directly.

## Re-evaluation

These are not permanent rejections. When the surface audit (or a new host) shows a
second/third host firing an analogous event, revisit: promote the observation-only
ones outright; for the request-mutating gemini family, first design the
request-mutation decision extension, then promote. Until then, nativeHooks is the
correct, honest home — host-specific power without diluting the shared model.
