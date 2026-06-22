# Contributing to agent-connector

agent-connector is the layer between your MCP server and every AI-agent CLI platform. You write standard MCP functionality once; agent-connector owns the non-functional cross-CLI infrastructure — packaging, hook normalization, telemetry wrapping, and rendering native config per host — so your connector deploys across all 42 supported platforms without touching platform-specific details.

---

## Contents

- [Dev setup](#dev-setup)
- [Testing discipline](#testing-discipline)
- [The golden rule: verify-first](#the-golden-rule-verify-first)
- [PR conventions](#pr-conventions)
- [Adding a new host adapter](#adding-a-new-host-adapter)
- [CI](#ci)

---

## Dev setup

```sh
git clone https://github.com/ken-jo/agent-connector.git
cd agent-connector
npm install
npm run build      # tsup — compiles src/ → dist/
npm run typecheck  # tsc --noEmit, must be clean before any PR
```

The `dist/` tree is the published artifact. The CLI entry point is `dist/cli.js` (bin `agent-connector`).

---

## Testing discipline

**Run scoped, single-fork vitest — not the bare `npm test`.** On shared or low-RAM machines, `npm test` (plain `vitest run`) spawns multiple worker processes and can exhaust memory. Always scope runs to the files you are working on:

```sh
npx vitest run --pool=forks --poolOptions.forks.singleFork=true --poolOptions.forks.maxForks=1 \
  tests/adapters/cursor.test.ts
```

Substitute whichever file(s) you need. The same flags apply to contract and drift suites.

### Test layout

| Bucket | Path | Rule |
|---|---|---|
| Per-host behaviour | `tests/adapters/<host>.test.ts` | **One file per host. Append to it; never create a second file for an existing host.** |
| Fleet-wide invariants | `tests/contracts/*.contract.test.ts` | `describe.each(ADAPTER_REGISTRY)` — a newly registered adapter is automatically covered. |
| Docs/drift guards | `tests/docs/*.test.ts` | Assert that `site/src/.../platform-data.ts`, `hooks-matrix.ts`, `docs-data.ts`, and `llms.txt` mirror the registry. |

Everything else lives in `tests/core`, `tests/runtime`, `tests/cli`, `tests/usage`, `tests/telemetry`, `tests/integration`, `tests/sdk`.

### Shared harness

Import from `tests/support/` — do not re-declare helpers in individual test files.

- **`tempDir(prefix?)`** — the Windows-safe temp-dir primitive. Uses `realpathSync.native` to expand Windows 8.3 short names (`RUNNER~1` → `%7E` breaks `pathToFileURL`/dynamic `import()`). Every temp dir must go through here; never call `mkdtempSync` directly.
- **`freshProject(prefix?)`** — shape A: one dir that is both `HOME` and the project dir. Sandboxes `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, and `AGENT_CONNECTOR_DATA_DIR`.
- **`freshHomeProject(prefix?)`** — shape B: separate `HOME` + `project/` subdir + `APPDATA`/XDG roots. For user-scoped hosts whose config lives under `HOME` (e.g. windsurf, amazon-q, cursor).
- **`buildCtx(projectDir, connector, scopeOrOpts?)`** — constructs an `InstallContext` with canonical defaults.
- **`isolateEnv(extraKeys?)`** — registers `beforeEach`/`afterEach` to snapshot and restore mutated env keys. Call once at the top of each suite.
- **`HOME_BIN`** — the canonical fake home-bin path every adapter test points hook commands at.

`tests/support/adapter-suite.ts` exports `createAdapterSuite({ adapter, paradigm? })` — the baseline SPI contract every host file calls once. Append host-specific `it()` blocks below it.

### A host test file looks like this

```ts
import { describe, expect, it } from "vitest";
import fooAdapter from "../../src/adapters/foo/index.js";
import { buildCtx, freshProject, isolateEnv } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";

isolateEnv();
createAdapterSuite({ adapter: fooAdapter, paradigm: "json-stdio" });

describe("foo adapter — MCP server", () => {
  it("writes mcpServers entry to the expected path", () => { /* … */ });
});
```

See `tests/adapters/windsurf.test.ts` for the reference implementation.

### Byte-oracle contract

Each `tests/adapters/<host>.test.ts` is the **byte-oracle** for that adapter — it asserts the exact bytes written to disk. If a refactor changes the on-disk output it must be verified against the host's primary source before the test is updated.

### Drift tests must stay green

`tests/docs/platform-drift.test.ts` and `tests/docs/hook-event-drift.test.ts` assert that `site/src/.../platform-data.ts`, `hooks-matrix.ts`, `docs-data.ts`, and `llms.txt` exactly mirror `src/adapters/registry.ts`. They must pass on every PR. Do not patch them to accommodate a failing state — fix the data instead.

### Typecheck

```sh
npm run typecheck
```

`tsc --noEmit` must be clean. Run it after every change to `src/`.

---

## The golden rule: verify-first

**Before adding or changing any adapter, verify the host's actual behavior against its primary source — the host's official documentation or source code — then cite it in a code comment.**

Do not assume a host behaves like Claude Code. Hosts diverge in ways that are not obvious:

- One host sends `tool_output` on PostToolUse; another sends `tool_response`.
- One host's HTTP transport key is `streamable-http`, not `http`.
- One host reads hook context from plain stdout, not a JSON envelope.
- One host's "permission gate" is an output field of before-hooks, not an observable event.
- One host's default agent filename must be `q_cli_default.json`, not `default.json`, or hooks never fire in a normal session.

**Capability flags must be fail-safe.** A flag (e.g. `postToolUse: true`, `canModifyOutput: true`) must reflect only what a user's installed, released, stable version of the host reliably honors. Over-claiming a capability silently breaks connectors on every machine that runs that host.

When you cite a source in a code comment, use the format:

```ts
// Source: <host> docs — <url-or-doc-path> (verified <YYYY-MM-DD>)
```

---

## PR conventions

- **One host per PR.** Never bundle several hosts into one PR. Multi-host work must be separable in git history — squashing obscures the blast radius when a regression needs bisecting.
- **Conventional-commit titles**: `fix(<host>): …`, `feat(<host>): …`, `refactor(core): …`, `docs: …`, `chore: …`.
- **AI-assisted changes**: add a `Co-Authored-By:` trailer to the commit message.
- **Authoring and review are separate passes.** A PR opened by the author must not be self-approved in the same context.
- **Squash merge + delete branch** is the merge policy (enforced in repo settings).

### Cross-cutting changes

"One host per PR" is the *specialization* of a more general rule: **one logical concern per PR, revertable as a unit.** Some changes are cross-cutting by nature — a shared engine or codec, an SPI field, the test harness, the registry — and cannot be split per host. Handle them like this:

- **One concern per PR.** Scope a cross-cutting PR to a single lift / codec / SPI change. Never bundle several unrelated cross-cutting changes, and never entangle a refactor with a feature or a per-host fix — if it needs reverting, it must come out cleanly. Title with the affected layer: `refactor(core):`, `feat(core):`, `fix(core):`.
- **Behavior-preserving refactors must be byte-identical.** Commonization, dedup, and lifts must produce the exact same on-disk output for every affected host. The per-host byte-oracle suites and `tests/contracts/` are the proof. **Revert-on-mismatch:** if any host's bytes change, either the refactor is wrong, or that host has a real divergence that must be handled explicitly — never silently absorbed.
- **Behavior-changing shared mechanisms land with contract coverage, then adoption follows per host.** A new capability, a shared bug fix, or a new surface lands as one host-agnostic PR whose `tests/contracts/*.contract.test.ts` (`describe.each` over the registry) proves the invariant holds for every host. Any per-host adoption that isn't automatic is a separate per-host PR. Keep the *mechanism* (cross-cutting, one PR) separate from the *adoption* (per-host, one PR each).
- **Registry / SPI / drift data move together.** A change to `src/adapters/registry.ts` or the SPI that ripples into `platform-data.ts` / `hooks-matrix.ts` / `docs-data.ts` / `llms.txt` is one PR — the drift tests enforce they stay in sync, so splitting them leaves `main` red.

---

## Adding a new host adapter

Work through this checklist in order. Every step is required.

### 1. Verify-first (before writing any code)

Locate the host's primary source: its official docs, its published config schema, or its source repository. Answer:

- Where does its MCP config live on disk? What is the root JSON/YAML key?
- Does it support hooks? What paradigm (`json-stdio`, `ts-plugin`, or `mcp-only`)?
- If it has hooks: what are the exact event names on the wire? What does it send as stdin? What does it read from stdout?
- Which capability flags are actually supported by released, stable versions?

Do not proceed until you can answer these from primary sources. Cite every non-obvious fact in a comment in the adapter file.

### 2. Implement the adapter

Create `src/adapters/<host>/index.ts`. Extend `BaseAdapter` and implement the `Adapter` SPI defined in `src/adapters/spi.ts`.

Required exports:

```ts
export const adapter = new HostAdapter();
export default adapter;
```

The adapter must:

- Set `readonly id: PlatformId = "<host>"` to a stable, kebab-case identifier.
- Implement `detectInstalled(projectDir)` — probe the host's config directories and marker files.
- Implement `getConfigDir`, `getServerConfigPath`, `getHookConfigPath`.
- Implement `installServer` / `uninstallServer` — write/remove the host's native MCP entry (idempotent).
- Implement `installHooks` / `uninstallHooks` — or defer to `BaseAdapter`'s `mcp-only` skip for hosts without a hook layer.
- Set `readonly capabilities: PlatformCapabilities` accurately (fail-safe; see [verify-first](#the-golden-rule-verify-first)).

If the host supports runtime hook dispatch (`json-stdio` or `ts-plugin`), implement `parseEvent` and `formatReply`.

### 3. Register the adapter

Add one entry to `ADAPTER_REGISTRY` in `src/adapters/registry.ts`:

```ts
{
  id: "<host>",
  load: () => import("./host/index.js").then((m) => m.default),
},
```

**Order is load-bearing for host detection:** forks must precede their parent (e.g. `cursor` before `vscode-copilot`, `antigravity-cli` before `antigravity`). Read the existing ordering comments before inserting.

### 4. Update the drift data

The drift tests assert that the registry and the site data are in sync. Add the new host's row to:

- `site/src/platform-data.ts` — `id`, `name`, `paradigm`, `surfaces`, `hostNative`, form-factor band.
- `site/src/components/docs/docs-data.ts` — the relevant paradigm list (`jsonStdioPlatforms`, `tsPluginPlatforms`, or `mcpOnlyPlatforms`).
- `site/src/components/docs/hooks-matrix.ts` — the per-platform event matrix row.

Do not add a host to the `surfaces` map with a flag that `hostNative` does not also have — the `ours ⊆ hostNative` invariant is enforced by the drift test and must hold.

Also update:

- `site/src/content/llms.txt` and `llms-full.txt` — paradigm bullet lists.
- `README.md` — the platforms badge count (`platforms-N-`) must equal `ADAPTER_REGISTRY.length`.

### 5. Write the byte-oracle test

Create `tests/adapters/<host>.test.ts`. It must:

- Call `isolateEnv()` at suite top.
- Call `createAdapterSuite({ adapter: hostAdapter, paradigm: "…" })`.
- Assert the exact bytes written to every config file for each install surface (MCP server, hooks, commands, skills, subagents, memory — whichever the adapter supports).
- Assert correct uninstall (removes only what it wrote; leaves unrelated config intact).
- If the adapter implements `parseEvent`/`formatReply`, assert round-trips for every supported event.

### 6. Verify

Run all three checks:

```sh
# 1. Typecheck
npm run typecheck

# 2. Host suite (byte-oracle)
npx vitest run --pool=forks --poolOptions.forks.singleFork=true --poolOptions.forks.maxForks=1 \
  tests/adapters/<host>.test.ts

# 3. Drift tests
npx vitest run --pool=forks --poolOptions.forks.singleFork=true --poolOptions.forks.maxForks=1 \
  tests/docs/platform-drift.test.ts tests/docs/hook-event-drift.test.ts
```

All three must be green before opening a PR.

---

## CI

Three jobs run on every PR:

| Job | Runner | Notes |
|---|---|---|
| `core` | Linux | **Authoritative.** Full test suite. A failure here is a real failure. |
| `site` | Linux | Builds the docs site and runs drift tests. |
| `windows-smoke` | Windows | Runs the install-roundtrip suite. Known: marketplace tests can timeout on heavy-I/O under runner load — this is a CI resource issue, not a regression. Re-run with `gh run rerun <id> --failed`; do not treat a timeout-only failure as a code defect. |

PRs merge via squash + delete-branch.
