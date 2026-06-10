Confirmed. The `kilo` adapter's `id = "kilo"` and `name = "Kilo Code"`, but it implements the **CLI** config dialect — which directly contradicts the usage layer where `platformId: "kilo"` is the VS Code extension and `kilo-cli` is the CLI. I have all decisive facts. Producing the final report.

# Coverage-Correctness Audit Resolution — agentconnect (28 platforms)

## Verdict in one line
The audit caught **one** real issue (`synthetic` orphan type) but **missed a second, more serious one** and **mislabeled the KILO question as "correct."** There are **two confirmed structural misclassifications**, one **identity inversion between the adapter layer and the usage layer for Kilo**, and one orphaned `PlatformId` (`kilo-cli`). Everything else (24 of the audited adapters) is verified correct.

---

## 1. Confirmed REAL misclassifications (high confidence, code-verified)

These are grounded in the actual repo code, not web claims. Each was cross-checked against `src/core/types.ts`, `src/adapters/registry.ts`, `src/usage/registry.ts`, the adapter source, and the tokscale Rust parsers.

### 1A. `synthetic` — orphaned PlatformId, no adapter (CONFIRMED — matches audit)
- **Verified:** `PlatformId` includes `"synthetic"` (`src/core/types.ts:53`), but `ADAPTER_REGISTRY` has **no** `synthetic` entry (grep of `registry.ts` returns nothing) and there is **no** `src/adapters/synthetic/` directory.
- It exists only as a usage reader (`src/usage/readers/synthetic.ts`, registered at `src/usage/registry.ts:140-143`) for Octofriend/synthetic.new telemetry.
- **Confidence: HIGH.** The audit's finding is correct as stated.

### 1B. `kilo-cli` — orphaned PlatformId, no adapter (MISSED ENTIRELY by the audit)
- **Verified:** `PlatformId` includes `"kilo-cli"` (`src/core/types.ts`, line between `kilo` and `warp`), and there **is** a usage reader for it (`src/usage/readers/kilo-cli.ts`, registered at `src/usage/registry.ts:134-137`). But there is **NO** `src/adapters/kilo-cli/` directory and **NO** `kilo-cli` entry in `ADAPTER_REGISTRY`.
- This is the **exact same class of defect** as `synthetic` (an installable-looking `PlatformId` with no adapter behind it), yet the audit's findings array does not mention `kilo-cli` at all. **The audit was not thorough here.**
- **Confidence: HIGH.**

### 1C. Kilo identity is INVERTED between the adapter layer and the usage layer (the real KILO bug)
This is the substantive correction to the audit's "kilo … paradigm is correct, configCorrect: true, confidence: high" finding. The paradigm value (`mcp-only`) is fine; the **product identity the adapter implements is wrong relative to the rest of the codebase.**

The repo intends two distinct Kilo products (the usage layer states this explicitly):

| tokscale parser | Product | agentconnect usage `platformId` | Storage |
|---|---|---|---|
| `sessions/kilocode.rs` (wraps `roocode.rs` `parse_roo_kilo_file`) | **Kilo Code** — VS Code extension (`kilocode.kilo-code`, a Roo/Cline fork) | **`kilo`** (`usage/readers/kilo.ts`) | VS Code `globalStorage/kilocode.kilo-code/tasks/.../ui_messages.json` |
| `sessions/kilo.rs` (`parse_kilo_sqlite`) | **Kilo CLI** — SQLite, "same shape OpenCode uses" | **`kilo-cli`** (`usage/readers/kilo-cli.ts`) | `~/.local/share/kilo/kilo.db` |

`usage/readers/kilo-cli.ts` spells out the contract: *"different products … carry different platformIds (`kilo-cli` here vs `kilo` there) so their rows never merge."* So in the **usage** layer: `kilo` = the **VS Code extension**, `kilo-cli` = the **CLI**.

Now the **adapter** layer (`src/adapters/kilo/index.ts`):
- `readonly id = "kilo"`, `readonly name = "Kilo Code"` — claims to be the **VS Code extension**.
- But its config is `~/.config/kilo/kilo.jsonc` (user) / `<projectDir>/.kilo/kilo.jsonc` (project), root key `mcp`, with the **command-as-array** dialect explicitly described as *"mirrors OpenCode's new-gen dialect."* That is the **CLI's** config surface (the OpenCode-similar product), **not** the VS Code extension's.

So the `kilo` adapter is labeled as the VS Code extension but implements the CLI's config. The two layers disagree about what `kilo` *is*. The audit's claim that the kilo finding was "configCorrect: true / confidence: high" is **wrong** — it never reconciled the adapter against the usage layer's own stated identity split, and it never noticed `kilo-cli` had a usage reader but no adapter.

**Definitive answers to the KILO sub-questions posed:**

- **Is `kilo` an OpenCode fork that should be `ts-plugin`?** No. The **Kilo CLI** is *OpenCode-similar in storage/config dialect* (SQLite message table, command-array MCP entries) but is **not** a code fork that loads JS plugins, and Kilo has **no lifecycle-hook system today** (open feature request, confirmed in the adapter header and `installHooks`/`uninstallHooks` both returning `skip` with "hooks unavailable"). **`mcp-only` is correct.** Do **not** change it to `ts-plugin`. (Note: `src/core/types.ts` is internally contradictory — its doc comment lists "Kilo" under the `ts-plugin` examples *and* "Kilo-today" under `mcp-only`. The `ts-plugin` mention should be removed.)
- **Does the Kilo VS Code extension need a separate adapter?** It needs **a correctly-identified adapter**. Today's `kilo` adapter is named "Kilo Code" (the extension) but implements the CLI surface — so the extension is effectively **not** correctly served and the CLI is served under the wrong id.
- **What config / root-key / paradigm should `kilo` and `kilo-cli` adapters use?**
  - **Kilo CLI** (`kilo-cli`): `~/.config/kilo/kilo.jsonc` (user) / `<projectDir>/.kilo/kilo.jsonc` (project), root key **`mcp`**, command-as-array dialect, paradigm **`mcp-only`**. *(This is what the current `kilo` adapter actually implements.)*
  - **Kilo Code VS Code extension** (`kilo`): MCP via the extension's `globalStorage/kilocode.kilo-code/.../mcp_settings.json` (Roo/Cline-fork lineage — same family as the verified `roo-code` adapter, which uses `cline_mcp_settings.json` + root key `mcpServers`) / project `.kilocode/...`, root key **`mcpServers`**, paradigm **`mcp-only`**. The current adapter already references `.kilocode/commands` for its command surface, which is the extension's dir — another sign the file is straddling both products.
- **Confidence: HIGH** for the inversion and the orphaned `kilo-cli`; **MEDIUM** for the exact VS Code MCP filename of the Kilo Code extension (`mcp_settings.json` under `kilocode.kilo-code` globalStorage is inferred from the Roo/Cline-fork lineage + the usage reader's confirmed `globalStorage/kilocode.kilo-code/` path; confirm against a live install before shipping).

---

## 2. Fork relationships that imply a shared/derived adapter

- **Kilo Code ← Cline ← Roo Code family (RELEVANT, currently unexploited):** `kilocode.rs` reuses `roocode.rs` `parse_roo_kilo_file`; the verified `roo-code` adapter already implements the exact Cline-fork pattern (`cline_mcp_settings.json`, `mcpServers`, VS Code globalStorage). A correct **Kilo Code** adapter should be **derived from / mirror `roo-code`**, not from the OpenCode-style CLI dialect it currently uses. This is the fork-lineage error the audit missed.
- **`cursor` ← vscode, `vscode-copilot`, `jetbrains-copilot` ← vscode:** verified correct; fork ordering in `registry.ts` (`cursor` before `vscode-copilot`) is right.
- **`qwen-code` ← gemini-cli, `antigravity` ← gemini-cli, `antigravity-cli` ← antigravity:** verified correct; `antigravity-cli` correctly precedes `antigravity` in the registry for marker detection, and shares the `~/.gemini/antigravity/` tree by design.
- **`roo-code` ← cline:** verified correct.
- No other fork relationship implies a wrong shared adapter.

---

## 3. Prioritized FIX PLAN (file-by-file, by severity)

### P0 — Decide-and-resolve the two orphaned PlatformIds (build/contract integrity)
Both `synthetic` and `kilo-cli` are `PlatformId`s with no adapter and no registry entry. Pick per platform:

1. **`synthetic`** (`src/core/types.ts:53`): it is telemetry-only. **Recommended: remove `"synthetic"` from the `PlatformId` union** and let the usage reader carry its own source label, OR if `PlatformId` is deliberately the shared id space for both adapters and usage readers, leave it but add an explicit code comment + a registry-completeness test exception. Touch points: `src/core/types.ts`; `src/usage/registry.ts:140` (already references it — keep). Do **not** create an installable adapter unless Octofriend exposes a writable MCP config (it does not, per the finding).
2. **`kilo-cli`** (`src/core/types.ts`): same decision. Since `kilo-cli` is a real installable CLI with a writable `kilo.jsonc`, the cleanest fix is the rename in P1 below (promote the existing adapter to `kilo-cli`), which resolves the orphan.

### P1 — Fix the Kilo identity inversion (correctness; user-facing wrong-product installs)
This is the highest-value functional fix.

3. **Rename the current adapter to the CLI it actually implements.** `src/adapters/kilo/` → `src/adapters/kilo-cli/`; set `const HOST: PlatformId = "kilo-cli"` and `readonly name = "Kilo CLI"`; update the header comment (which currently says "Kilo Code (Kilo Org)") to describe the CLI. Keep its config exactly as-is (`~/.config/kilo/kilo.jsonc`, root key `mcp`, command-array, `mcp-only`) — that part is correct **for the CLI**.
4. **Add the real Kilo Code (VS Code extension) adapter** as `src/adapters/kilo/index.ts`, derived from / modeled on `src/adapters/roo-code/index.ts`: VS Code globalStorage under `kilocode.kilo-code`, root key `mcpServers`, paradigm `mcp-only`, project scope `.kilocode/`. (Confirm the exact MCP settings filename against a live install — MEDIUM confidence.)
5. **`src/adapters/registry.ts`:** add a `kilo-cli` entry and keep/repoint the `kilo` entry to the new VS Code-extension adapter. No fork-ordering constraint between them (distinct hosts), but place `kilo-cli` near the OpenCode-family block and `kilo` near `roo-code`.
6. **`src/core/types.ts`:** remove "Kilo" from the `ts-plugin` example list in the `HookParadigm` doc comment (keep "Kilo-today" under `mcp-only`). No union change needed (both ids already exist).
7. **`src/adapters/detect.ts`:** ensure both `kilo` and `kilo-cli` detection markers exist and don't collide (CLI = `~/.local/share/kilo/kilo.db` + `~/.config/kilo/`; extension = `kilocode.kilo-code` globalStorage).

### P2 — Tests
8. Add a **registry-completeness test**: assert every `PlatformId` (minus an explicit allowlist of telemetry-only ids like `synthetic`, and `unknown`) has an `ADAPTER_REGISTRY` entry. This single test would have caught both `synthetic` and `kilo-cli`. Put it under `tests/adapters/` (alongside `render.test.ts`).
9. Update/extend `tests/adapters/phase3.test.ts` and `tests/usage/u2-readers.test.ts` / `u3-readers.test.ts` for the renamed `kilo-cli` adapter and the new `kilo` (VS Code) adapter; assert `usage` `platformId` ↔ `adapter` `id` agreement (kilo = extension, kilo-cli = CLI) so the inversion cannot regress.

### P3 — Doc hygiene
10. Reconcile the `kilo` references in `README.md` paradigm classification and `docs/research/understand-report.md` with the corrected two-product split.

---

## 4. VERIFIED CORRECT (audit was thorough on these — 24 platforms, all HIGH confidence)

Paradigm + config + fork lineage all confirmed against adapter source (and tokscale parsers where cited):

- **ts-plugin:** `opencode` (opencode.json / `mcp`), `omp` (mcp.json / `mcpServers`), `openclaw` (openclaw.json, dual registration `plugins.entries` + `mcp.servers`).
- **json-stdio:** `claude-code` (`~/.claude.json` or `.mcp.json` / `mcpServers`), `cursor` (`~/.cursor/mcp.json` / `mcpServers`; vscode fork), `vscode-copilot` (`.vscode/mcp.json` / **`servers`** not `mcpServers` — the key distinction is correctly handled), `jetbrains-copilot` (MCP UI-managed; hooks `.github/hooks/<id>.json` / `hooks`, version 1), `codex` (`config.toml` `[mcp_servers.<id>]`; hooks `hooks.json`), `copilot-cli` (`~/.copilot/mcp-config.json` / `mcpServers`), `gemini-cli` (`settings.json` / `mcpServers` + sibling `hooks`), `qwen-code` (`~/.qwen/settings.json`; gemini fork), `antigravity` (`~/.gemini/antigravity/mcp_config.json`; gemini fork), `antigravity-cli` (shares `~/.gemini/antigravity/`; antigravity fork), `crush` (`crush.json` / `mcp` + `hooks`), `goose` (`config.yaml` / `extensions`; Open Plugins hooks), `hermes` (`~/.hermes/config.yaml` / `mcp_servers`), `kimi` (`mcp.json` / `mcpServers` + `config.toml` hooks), `kiro` (`~/.kiro/settings/mcp.json` / `mcpServers` + agent hooks).
- **mcp-only:** `warp` (`~/.warp/.mcp.json` / `mcpServers`), `droid` (`~/.factory/mcp.json` / `mcpServers`), `roo-code` (`cline_mcp_settings.json` / `mcpServers`; cline fork — correct), `trae` (`~/.trae/mcp.json` / `mcpServers`), `zed` (`settings.json` / `context_servers`), `amp` (`amp/settings.json` / `amp.mcpServers`), `codebuff` (`.agents/mcp.json` / `mcpServers`), `mux` (`mcp.jsonc` / `servers`, command-as-string), `pi` (skills-only, `SKILL.md`, no writable MCP).

The `kilo` paradigm value (`mcp-only`) is itself **correct**; what was wrong was the audit certifying its *product identity / configCorrect* without reconciling against the usage layer, and missing the `kilo-cli` orphan.

---

## Summary table of corrections

| Platform | Audit said | Reality | Action |
|---|---|---|---|
| `synthetic` | misclassified (no adapter) — CORRECT catch | Confirmed orphan PlatformId, telemetry-only | P0: remove from union or allowlist |
| `kilo-cli` | **not mentioned** | Orphan PlatformId: has usage reader, no adapter | P0/P1: promote current `kilo` adapter to this id |
| `kilo` | "correct, HIGH confidence" | **Identity inverted**: named "Kilo Code" (extension) but implements the CLI config; paradigm `mcp-only` is fine | P1: rename to `kilo-cli`; add real roo-derived `kilo` (VS Code) adapter |
| `types.ts` HookParadigm doc | n/a | Lists "Kilo" under ts-plugin AND mcp-only | P1: drop ts-plugin mention |
| Other 24 | correct | Confirmed correct | none |