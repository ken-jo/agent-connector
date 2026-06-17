# Test suite layout & conventions

This suite is organized so that **tests are predictable to place and cheap to
add** — a contributor should never have to invent a new file or guess where a
test belongs. The structure is modelled on two references the project follows:

- **Vercel AI SDK** — one tiny per-provider test file calls a shared
  `createFeatureTestSuite(...)` factory that encodes the rules every provider
  must satisfy. We mirror this with `createAdapterSuite(...)` (see below).
- **context-mode** — a single shared `tests/` tree with central fixtures and a
  single vitest config, rather than per-feature helper sprawl.

## The three buckets

| Bucket | Lives in | Rule |
|---|---|---|
| **Per-host behaviour** | `tests/adapters/<host>.test.ts` | **ONE file per host.** Everything about host `X` — MCP shape, hooks, skills/commands/subagents, statusline, memory — goes in `X.test.ts`. Need a new test for an existing host? **Append to its file. Do not create a new file.** |
| **Fleet-wide invariants** | `tests/contracts/*.contract.test.ts` | Rules that must hold for **every** host (or every host of a paradigm). Written with `describe.each(ADAPTER_REGISTRY)` so a newly-registered adapter is **automatically covered** — no new file, no hand-maintained host list. |
| **Doc-claim drift** | `tests/docs/*.test.ts` | Guards that machine-readable docs (`llms.txt`, `llms-full.txt`, the site matrix, README badges) match the code. See `robot-support.test.ts`. |

Everything else keeps its existing home: `tests/core`, `tests/runtime`,
`tests/cli`, `tests/usage`, `tests/telemetry`, `tests/integration`, `tests/sdk`.

## Shared harness — `tests/support/`

Import the harness instead of re-declaring helpers per file (the old suite
redeclared `buildCtx` in ~68 files and `freshProject` in ~55 — and that
copy-paste is exactly how the Windows 8.3 short-name bug shipped: only ~13 of the
55 copies expanded the short name).

`tests/support/env.ts`:
- **`tempDir(prefix?)`** — the Windows-safe temp-dir primitive. Uses
  `realpathSync.native` so the GitHub Windows runner's 8.3 short name
  (`C:\Users\RUNNER~1\…`) is expanded — otherwise `~` → `%7E` in `pathToFileURL`
  and a dynamic `import()` of a generated plugin fails. **Every temp dir goes
  through here.** Never call `mkdtempSync` directly in a test.
- **`freshProject(prefix?)`** — shape A: one dir that is both HOME and the
  project dir (most adapters).
- **`freshHomeProject(prefix?)`** — shape B: separate HOME + `project/` subdir +
  APPDATA/XDG roots (user-scoped hosts whose config lives under HOME, e.g.
  windsurf / amazon-q / cursor).
- **`buildCtx(projectDir, connector, scopeOrOpts?)`** — an InstallContext with
  canonical defaults; 3rd arg is a bare scope string **or** an options object.
- **`isolateEnv(extraKeys?)`** — registers beforeEach/afterEach that snapshot &
  restore the env keys a test mutates. Call once at suite top.
- **`HOME_BIN`** — the one canonical fake home-bin path.

`tests/support/adapter-suite.ts`:
- **`createAdapterSuite({ adapter, paradigm? })`** — the "same rules for every
  host" baseline contract (stable id/paradigm, `detectInstalled` identity, and
  `hooks:false` is always honored). Call it once per host file; append the
  host-specific `it()`s below it. Surface round-trips whose written bytes differ
  per host stay in the host file; what's asserted in the factory is only the
  SPI-level contract that holds regardless of output shape.

## The shape of a host file

```ts
import { describe, expect, it } from "vitest";
import fooAdapter from "../../src/adapters/foo/index.js";
import { buildCtx, freshProject, isolateEnv } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";

// fixtures (connector builder, sample server/skill, path helpers) …

isolateEnv();
createAdapterSuite({ adapter: fooAdapter, paradigm: "json-stdio" });

describe("foo adapter — <surface>", () => {
  it("…", () => { /* host-specific behaviour */ });
});
```

`tests/adapters/windsurf.test.ts` is the reference implementation.
