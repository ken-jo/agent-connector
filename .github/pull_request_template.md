## What & why

<!-- One paragraph: what changed and why. Link any related issue. -->

## Host(s) touched

<!-- ONE host per PR. Name the adapter id (e.g. `cursor`, `kiro`, `amazon-q`).
     If this is a core/infra change with no per-host impact, write "none". -->

## How verified

**tsc clean:**
```
npm run typecheck
# paste output (or "exit 0, no errors")
```

**Host suite (byte-oracle):**
```
npx vitest run --pool=forks --poolOptions.forks.singleFork=true --poolOptions.forks.maxForks=1 \
  tests/adapters/<host>.test.ts
# paste summary line
```

**Drift tests:**
```
npx vitest run --pool=forks --poolOptions.forks.singleFork=true --poolOptions.forks.maxForks=1 \
  tests/docs/platform-drift.test.ts tests/docs/hook-event-drift.test.ts
# paste summary line
```

## Checklist

- [ ] Commit title follows conventional-commit format (`fix(<host>): …`, `feat(<host>): …`, `refactor(core): …`, etc.)
- [ ] `npm run typecheck` exits 0
- [ ] Drift tests pass (`tests/docs/platform-drift.test.ts`, `tests/docs/hook-event-drift.test.ts`)
- [ ] This PR touches exactly one host adapter (or is a host-agnostic core/infra change)
- [ ] Every capability flag and behavior claim is grounded in a primary source (official docs or host source), cited in a code comment
- [ ] If AI-assisted: `Co-Authored-By:` trailer is present in the commit message
