I have everything I need. Here is the design and build plan.

---

# Extending agentconnect: Commands, Skills, Subagents

Declare commands/skills/subagents **once**; each adapter writes the native content file(s) and skips+warns where unsupported, mirroring the existing MCP/hook handling. These three surfaces are **content-only** (markdown/TOML files) — no runtime dispatch, no telemetry wrapping, no home-bin pointer. They are pure file writers, so they reuse `ChangeRecord` and the install orchestration verbatim.

## 1. Core API additions (`core/types.ts` + `define-connector.ts`)

### New surface types (all OPTIONAL, content-only)

```ts
// ── Shared content-surface bits ──────────────────────────────────────────
/** Tool access expressed once; adapters render to allowed-tools / tools[] / readonly. */
export interface SurfaceToolPolicy {
  allow?: string[];      // allowed-tools (CSV/array per platform)
  deny?: string[];       // disallowedTools / disallowed-tools
}

/** A slash command (= a Skill on 2026 Claude; adapters pick the right surface). */
export interface CommandDef {
  /** kebab-case; becomes the slash name and the filename stem. Source of truth. */
  name: string;
  /** One-line description for /help + model auto-selection. */
  description?: string;
  /** Prompt template body (markdown). The portable core of the command. */
  prompt: string;
  /** Shown in argument completion, e.g. "[environment]". */
  argumentHint?: string;
  tools?: SurfaceToolPolicy;
  /** Model override (raw id or alias; adapters pass through or drop+warn). */
  model?: string;
  /** Force subagent / forked context where the platform supports it. */
  subtask?: boolean;
  /** Verbatim per-platform frontmatter additions (escape hatch). */
  extra?: Record<string, unknown>;
}

/** An Agent Skill (folder + SKILL.md, Agent Skills open standard). */
export interface SkillDef {
  /** <=64 chars, [a-z0-9-]; MUST equal the skill dir name. Source of truth. */
  name: string;
  /** <=1024 chars, 3rd-person "what + when"; drives model auto-selection. Required. */
  description: string;
  /** SKILL.md markdown body (instructions). */
  body: string;
  tools?: SurfaceToolPolicy;
  model?: string;
  disableModelInvocation?: boolean;   // → disable-model-invocation
  /** Extra files bundled beside SKILL.md, relative path → contents. */
  resources?: Record<string, string>; // e.g. { "scripts/run.sh": "...", "references/api.md": "..." }
  extra?: Record<string, unknown>;
}

/** A named subagent (system-prompt + tool/model scoping). */
export interface SubagentDef {
  /** kebab-case identifier. Source of truth (filename stem on most platforms). */
  name: string;
  /** Delegation hint shown to the orchestrator. Required. */
  description: string;
  /** System prompt = the agent's instructions (markdown body / developer_instructions). */
  prompt: string;
  tools?: SurfaceToolPolicy;
  /** Model: alias|full-id|"inherit". Default left to platform. */
  model?: string;
  /** Coarse permission knob → Cursor readonly, opencode/kilo permission map. */
  readonly?: boolean;
  extra?: Record<string, unknown>;
}
```

### `ConnectorConfig` additions (all OPTIONAL)

```ts
export interface ConnectorConfig {
  // ...existing...
  commands?: CommandDef[];
  skills?: SkillDef[];
  subagents?: SubagentDef[];
}
```

### `ResolvedConnector` additions

```ts
export interface ResolvedConnector {
  // ...existing...
  commands: CommandDef[];   // normalized, defaults applied; [] when none
  skills: SkillDef[];
  subagents: SubagentDef[];
}
```

Relax the "at least one of `server` or `hooks`" gate to: a connector must declare **at least one of** `server | hooks | commands | skills | subagents` (a skills-only connector is now valid).

### `PlatformOverride` additions (escape hatch parity)

```ts
export interface PlatformOverride {
  // ...existing...
  commands?: boolean;   // false → skip command files on this platform
  skills?: boolean;     // false → skip skill files
  subagents?: boolean;  // false → skip subagent files
}
```

### `defineConnector` validation/normalization (dependency-free)

Add three passes, same style as the existing hook/server validation:
- **name regex** `^[a-z0-9][a-z0-9-]*$` for every command/skill/subagent `name`; throw `ConnectorConfigError` otherwise.
- **required fields**: command `prompt` (non-empty string); skill `description` + `body`; subagent `description` + `prompt`. Skill `description` length-checked (warn via thrown error if `>1024`); skill `name` must match its dir (it is the dir).
- **duplicate-name** detection within each surface array.
- **normalize**: default each missing array to `[]`; pass `CommandDef`/`SkillDef`/`SubagentDef` through largely verbatim (they are content), defaulting `tools`/`extra` to `undefined`. Resolve `RegisteredMeta` to also persist `commands`/`skills`/`subagents` counts + content (they are JSON-serializable already — no functions — so they store cleanly for uninstall).

`registerConnector` (`load-connector.ts`) gains `commands`/`skills`/`subagents` in `RegisteredMeta` so uninstall can find files even when the source module is gone (matching the existing handler-less rebuild path).

## 2. PlatformCapabilities + Adapter SPI + BaseAdapter

### `PlatformCapabilities` additions

```ts
export interface PlatformCapabilities {
  // ...existing...
  supportsCommands: boolean;
  supportsSkills: boolean;
  supportsSubagents: boolean;
}
```

### `Adapter` SPI additions (all OPTIONAL on the adapter)

```ts
export interface Adapter {
  // ...existing...
  installCommands?(ctx: InstallContext): ChangeRecord[];
  uninstallCommands?(ctx: InstallContext): ChangeRecord[];
  installSkills?(ctx: InstallContext): ChangeRecord[];
  uninstallSkills?(ctx: InstallContext): ChangeRecord[];
  installSubagents?(ctx: InstallContext): ChangeRecord[];
  uninstallSubagents?(ctx: InstallContext): ChangeRecord[];
}
```

The installer calls these **only if defined** (`adapter.installCommands?.(ctx)`); when absent, `BaseAdapter` provides defaults so the method always exists.

### `BaseAdapter` defaults + shared helpers

Default `install*`/`uninstall*` (concrete, not abstract — overridable) return a single skip when the connector declares that surface but the platform can't honor it, mirroring `mcp-only` hook handling:

```ts
installCommands(ctx: InstallContext): ChangeRecord[] {
  return this.unsupportedSurface(ctx, "commands", ctx.connector.commands.length);
}
// ...skills, subagents identical...

protected unsupportedSurface(ctx, surface, count): ChangeRecord[] {
  if (count === 0)
    return [{ platform: this.id, action: "skip", detail: `connector declares no ${surface}` }];
  return [{ platform: this.id, action: "warn",
            detail: `${surface} not supported on ${this.id}; ${count} skipped` }];
}
```

Shared content-file helpers on `BaseAdapter` (new, used by every supporting adapter):

```ts
/** Write a content file; idempotent create/update/skip on byte-identical content. */
protected writeContentFile(path: string, contents: string, dryRun: boolean): ChangeRecord
/** Remove a content file we wrote; skip when already absent. */
protected removeContentFile(path: string, dryRun: boolean): ChangeRecord
/** Render YAML-frontmatter + markdown body: "---\n<yaml>---\n\n<body>\n". */
protected renderFrontmatterMd(frontmatter: Record<string, unknown>, body: string): string
```

The **markdown-frontmatter renderer** reuses the existing `stringify` from `core/yaml.ts` for the frontmatter block. The **TOML renderer** reuses `@iarna/toml`'s `stringify` already imported by the codex adapter (lift codex's TOML write into a tiny `core/toml.ts` `writeTomlString(obj)` so Gemini/Qwen/Codex commands share it). Frontmatter-omitting platforms (Cursor commands) just write `body`.

`getHealthChecks` additions are optional per adapter (e.g. "skill dir present"); the generic `doctor` already iterates them.

## 3. Install orchestration / doctor / CLI wiring

**`core/installer.ts`** — in `installConnector`, after `installServer`/`installHooks`, add three more `runStep`s guarded by surface declaration:

```ts
if (connector.commands.length)   runStep(id, "installCommands",   result, () => pushAll(result.changes, adapter.installCommands!(ctx)));
if (connector.skills.length)     runStep(id, "installSkills",     result, () => pushAll(result.changes, adapter.installSkills!(ctx)));
if (connector.subagents.length)  runStep(id, "installSubagents",  result, () => pushAll(result.changes, adapter.installSubagents!(ctx)));
```

Because `BaseAdapter` always defines them, the `!` is safe; the `.length` guard avoids noise when a surface isn't declared at all. `uninstallConnector` adds the inverse three (`uninstallSubagents` → `uninstallCommands` → `uninstallSkills`) before `uninstallServer`, and uses the registered metadata to know *which* files to remove. `backupSettings` is unchanged (content files are new files, not mutations of user config) — but each adapter's content write is its own idempotent create/skip, so no extra backup is needed.

The `synthetic`/handler-less connectors in `installer.ts` and `doctor.ts` gain `commands: [], skills: [], subagents: []`.

**CLI**: `install`/`sync`/`uninstall` need **no signature change** — they already pass the resolved connector through and render `ChangeRecord[]`. `renderInstallResult` already prints any action/path/detail, so command/skill/subagent file writes show up for free. `doctor` picks up new health checks automatically. Optionally add `--surfaces command,skill,subagent` filter later (not required).

## 4. Per-platform support matrix

| platform | command? | skill? | subagent? | confidence |
|---|---|---|---|---|
| **claude-code** | Y `.claude/commands/<n>.md` md+fm | Y `.claude/skills/<n>/SKILL.md` | Y `.claude/agents/<n>.md` md+fm | high |
| **gemini-cli** | Y `.gemini/commands/<n>.toml` | Y `.gemini/skills/<n>/SKILL.md` | Y `.gemini/agents/<n>.md` md+fm | high |
| **qwen-code** | Y `.qwen/commands/<n>.toml` (or .md) | N (no SKILL.md surface) | Y `.qwen/agents/<n>.md` md+fm | high / low(skill) |
| **vscode-copilot** | Y `.github/prompts/<n>.prompt.md` | Y `.github/skills/<n>/SKILL.md` | Y `.github/agents/<n>.agent.md` | high |
| **copilot-cli** | N (no prompt-file CLI support) | Y `.github/skills/<n>/SKILL.md` | Y `.github/agents/<n>.agent.md` | high / med(skill) |
| **jetbrains-copilot** | Y* `.github/prompts/<n>.prompt.md` | Y* `.github/skills/` | N (no native subagent surface) | med |
| **cursor** | Y `.cursor/commands/<n>.md` (body-only, NO fm) | Y `.cursor/skills/<n>/SKILL.md` | Y `.cursor/agents/<n>.md` md+fm | high |
| **codex** | Y `~/.codex/prompts/<n>.md` (user-only) md+fm | Y `.codex/skills/<n>/SKILL.md` | Y `.codex/agents/<n>.toml` TOML | high |
| **opencode** | Y `.opencode/commands/<n>.md` md+fm | Y `.opencode/skills/<n>/SKILL.md` | Y `.opencode/agent/<n>.md` md+fm | high |
| **kilo** | Y `.kilocode/commands/<n>.md` md+fm | N | Y `.kilo/agents/<n>.md` md+fm | med / low |
| **pi** | — | Y `.pi/skills/<n>/SKILL.md` | N | high(skill) |
| **antigravity / zed / kiro / kimi / omp / openclaw / warp / hermes / others** | N | N | N | low–med |

\*JetBrains consumes the GitHub Copilot `.github/` files; it has no distinct authoring location. Treat it as an alias of the vscode-copilot writer for command+skill, no subagent.

**Format key**: `md+fm` = YAML-frontmatter + markdown body (`renderFrontmatterMd`); `toml` = `@iarna/toml`; Cursor commands are body-only markdown. Skills are uniformly folder-per-skill `SKILL.md` (md+fm, `name`+`description` frontmatter) plus optional `resources` files — write the same SKILL.md for *every* skill-supporting platform; only the parent dir differs.

## 5. Build groups (one-by-one)

### Group A — core plumbing (DO FIRST, single PR)
1. `core/types.ts`: add `CommandDef`/`SkillDef`/`SubagentDef`/`SurfaceToolPolicy`; extend `ConnectorConfig`, `ResolvedConnector`, `PlatformOverride`, `PlatformCapabilities`.
2. `core/define-connector.ts`: validate + normalize the three arrays; relax the "server|hooks" gate.
3. `core/load-connector.ts`: add the three arrays to `RegisteredMeta` + register/rebuild paths.
4. `core/toml.ts`: extract `writeTomlString(obj)` (lift from codex).
5. `adapters/spi.ts`: add the six optional methods.
6. `adapters/base.ts`: concrete `install*`/`uninstall*` defaults (`unsupportedSurface`), plus `writeContentFile`/`removeContentFile`/`renderFrontmatterMd`; add the three capability fields to every adapter's `capabilities` literal (default `false`).
7. `core/installer.ts` + `cli/commands/doctor.ts`: wire the new steps; patch synthetic connectors with empty arrays.

### Group B — rich-surface platforms (one PR per platform)
For each, implement only its supported surfaces; inherit `BaseAdapter` defaults (warn+skip) for the rest. One-line spec per (platform, surface):

- **claude-code**: cmd→`<configDir>/commands/<name>.md` md+fm(`description,argument-hint,allowed-tools,model`); skill→`<configDir>/skills/<name>/SKILL.md` + resources; subagent→`<configDir>/agents/<name>.md` md+fm(`name,description,tools,model`).
- **gemini-cli**: cmd→`<gemini>/commands/<name>.toml` TOML(`description,prompt`, `{{args}}`); skill→`<gemini>/skills/<name>/SKILL.md`; subagent→`<gemini>/agents/<name>.md` md+fm(`name,description,tools,model`).
- **qwen-code**: cmd→`<qwen>/commands/<name>.toml` TOML; skill→default skip; subagent→`<qwen>/agents/<name>.md` md+fm(`name,description,tools,model,approvalMode`).
- **vscode-copilot** (+ jetbrains-copilot alias): cmd→`.github/prompts/<name>.prompt.md` md+fm(`description,tools,model,argument-hint`); skill→`.github/skills/<name>/SKILL.md`; subagent→`.github/agents/<name>.agent.md` md+fm(`name,description,tools,model`).
- **copilot-cli**: cmd→default skip(warn); skill→`.github/skills/<name>/SKILL.md`; subagent→`~/.copilot/agents/<name>.agent.md` (user) / `.github/agents/` (project).
- **cursor**: cmd→`<cursor>/commands/<name>.md` body-only (no fm); skill→`<cursor>/skills/<name>/SKILL.md`; subagent→`<cursor>/agents/<name>.md` md+fm(`name,description,model,readonly`).
- **codex**: cmd→`~/.codex/prompts/<name>.md` md+fm(`description,argument-hint`), user-scope only (warn on project scope); skill→`.codex/skills/<name>/SKILL.md`; subagent→`.codex/agents/<name>.toml` TOML(`name,description,developer_instructions,model`).
- **opencode**: cmd→`<oc>/commands/<name>.md` md+fm(`description,agent,model,subtask`); skill→`<oc>/skills/<name>/SKILL.md`; subagent→`<oc>/agent/<name>.md` (singular dir) md+fm(`description,mode:subagent,model,permission`).
- **kilo**: cmd→`.kilocode/commands/<name>.md` md+fm(`description,argument-hint,mode,model`); skill→default skip; subagent→`.kilo/agents/<name>.md` md+fm(`description,mode:subagent,model,permission`).
- **pi**: skill→`.pi/skills/<name>/SKILL.md`; cmd/subagent→default skip.

### Group C — the rest (no code per platform)
antigravity, zed, kiro, kimi, omp, openclaw, warp, hermes, droid, roo-code, trae, amp, codebuff, mux, crush, goose, kilo-cli, synthetic: implement **nothing**. `capabilities.supports* = false` + `BaseAdapter` defaults produce the skip/warn automatically — same as `mcp-only` hook handling. (Optional later: openclaw "skill-like" prompt injection per its context-mode precedent — out of scope for v1.)

## 6. Recommended build order

1. **Group A** end-to-end first (types → define-connector → load-connector → toml helper → spi → base → installer/doctor). Land it with `supports*: false` on every adapter so the whole repo compiles and every platform safely skips/warns. This is the contract; nothing else can land before it.
2. **claude-code** (Group B) as the reference implementation — it exercises all three surfaces (md+fm commands, SKILL.md skills with resources, md+fm subagents) and validates the `BaseAdapter` helpers. Write tests against it.
3. **gemini-cli + qwen-code** next (introduces the TOML command renderer + the md+fm subagent; qwen reuses gemini, skill-skips).
4. **cursor** (introduces body-only command writer + readonly→permission mapping).
5. **vscode-copilot** (+ jetbrains-copilot alias) and **copilot-cli** (shared `.github/` writer; copilot-cli command-skips).
6. **opencode** (singular `agent/` dir; permission map) and **codex** (user-only command scope warn; TOML subagent via `developer_instructions`).
7. **kilo** and **pi** (partial surfaces).
8. Leave **Group C** as-is.

**Key files to touch**: `/home/ubuntu/workspace/github/agentconnect/src/core/types.ts`, `/home/ubuntu/workspace/github/agentconnect/src/core/define-connector.ts`, `/home/ubuntu/workspace/github/agentconnect/src/core/load-connector.ts`, new `/home/ubuntu/workspace/github/agentconnect/src/core/toml.ts`, `/home/ubuntu/workspace/github/agentconnect/src/adapters/spi.ts`, `/home/ubuntu/workspace/github/agentconnect/src/adapters/base.ts`, `/home/ubuntu/workspace/github/agentconnect/src/core/installer.ts`, `/home/ubuntu/workspace/github/agentconnect/src/cli/commands/doctor.ts`, then each `src/adapters/<platform>/index.ts`. The `core/yaml.ts` `stringify` and `@iarna/toml` `stringify` already in-repo are reused — no new dependencies.