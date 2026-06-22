<!-- Thanks for contributing! See CONTRIBUTING.md for the host-adapter walkthrough
     + testing discipline. Keep this description concise and human-reviewed —
     please don't paste large unedited AI-generated walls (they're hard to review). -->

## What & why

<!-- One short paragraph: what changed and why. -->

Closes #

## Type of change

- [ ] Host adapter (one host)
- [ ] Host-agnostic core / infra
- [ ] Docs / examples
- [ ] Tests / tooling

## Host(s) & OS

**Host adapter(s):** <!-- ONE adapter id per PR (e.g. `cursor`, `kiro`, `amazon-q`), or "none / core" -->

**Verified on:**

- [ ] Linux
- [ ] macOS
- [ ] Windows
- [ ] N/A (docs / infra only)

<!-- For any unchecked OS, say why it's unaffected or wasn't verified. -->

## How verified

<!-- Paste real output. Scope tests to what you changed — never bare `npm test`
     (it can OOM low-RAM machines). -->

**Typecheck** — `npm run typecheck` → <!-- exit 0 / errors -->

**Tests (scoped, single-fork):**

```
npx vitest run --pool=forks --poolOptions.forks.singleFork=true --poolOptions.forks.maxForks=1 \
  tests/adapters/<host>.test.ts
# paste the summary line
```

**Drift guards** (only if you changed config rendering / the registry / docs):

```
npx vitest run --pool=forks --poolOptions.forks.singleFork=true --poolOptions.forks.maxForks=1 \
  tests/docs/platform-drift.test.ts tests/docs/hook-event-drift.test.ts
```

**Behavioral evidence** (for a behavior change — otherwise N/A):

- BEFORE:
- AFTER:

## Checklist

- [ ] Conventional-commit title (`fix(<host>): …`, `feat(<host>): …`, `refactor(core): …`, `docs: …`)
- [ ] `npm run typecheck` exits 0
- [ ] Scoped tests pass (single-fork); drift tests pass if config / registry / docs changed
- [ ] Exactly one host adapter touched, **or** a host-agnostic core/infra change
- [ ] Every capability flag / behavior claim is grounded in a **primary source** (official docs or host source) and cited in a code comment
- [ ] Docs / `llms.txt` / site mirror updated if user-facing behavior changed
- [ ] If AI-assisted: `Co-Authored-By:` trailer is present and the description was human-reviewed
