/**
 * adapters/pi — Pi platform adapter for agent-connector.
 *
 * Pi is a file-based-skills host with NO writable MCP config and a native
 * prompt-template (slash command) surface. It has no lifecycle hook system in
 * the json-stdio or ts-plugin sense. Its extensibility surfaces are:
 *
 *   - server    → single "skip" (Pi has no writable MCP config).
 *   - hooks     → single "skip" (no json-stdio / ts-plugin hook layer).
 *   - commands  → write prompt templates under <piPromptsDir>/<name>.md.
 *                   project scope → <projectDir>/.pi/prompts/<name>.md
 *                   user scope    → ~/.pi/agent/prompts/<name>.md
 *   - skills    → write <piSkillsDir>/<name>/SKILL.md (+ declared resources).
 *                   project scope → <projectDir>/.pi/skills/<name>/SKILL.md
 *                   user scope    → ~/.pi/agent/skills/<name>/SKILL.md
 *   - subagents → unsupported (BaseAdapter skip/warn).
 *
 * Ground-truth refs (docs/research/kilo-pi-ground-truth.md):
 *   - prompt templates: docs/prompt-templates.md → ~/.pi/agent/prompts/*.md
 *     and .pi/prompts/*.md, invoked as /name.
 *   - global skills: ~/.pi/agent/skills/<n>/SKILL.md (NOT ~/.pi/skills/).
 *   - project skills: .pi/skills/<n>/SKILL.md (unchanged).
 *   - allowed-tools: space-delimited (NOT comma-delimited).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BaseAdapter } from "../base.js";
import type { Adapter, InstallContext } from "../spi.js";
import type {
  ChangeRecord,
  CommandDef,
  DetectedPlatform,
  HealthCheck,
  HookParadigm,
  PlatformCapabilities,
  PlatformId,
  SkillDef,
} from "../../core/types.js";

const HOST: PlatformId = "pi";

export class PiAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Pi";
  /**
   * Pi has no MCP surface at all — the paradigm label "mcp-only" is backwards
   * for a host with NO writable MCP config. Pi is purely a content-surface host
   * (skills + prompt templates). Use "mcp-only" only because the HookParadigm
   * union has no "no-mcp" variant; MCP is explicitly unsupported below.
   */
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block via the BaseAdapter default
    // (user scope: ~/.pi/agent/AGENTS.md per base.ts AGENTS_MD_USER_PATHS).
    supportsMemory: true,
    // Pi has no json-stdio / ts-plugin lifecycle hook system.
    preToolUse: false,
    postToolUse: false,
    preCompact: false,
    sessionStart: false,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: false,
    // No writable MCP config.
    transports: [],
    // Content surfaces: prompt-template commands + skills.
    supportsCommands: true,
    supportsSkills: true,
    supportsSubagents: false,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".pi");
    const projDir = join(projectDir, ".pi");

    const userInstalled = existsSync(userDir);
    const projInstalled = existsSync(projDir);
    const installed = userInstalled || projInstalled;
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projDir : userDir;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? `found Pi config (${scope}) at ${configPath}`
        : `no .pi config at ${userDir} or ${projDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  /**
   * Base config dir (used for server/hook doctor paths only; content surfaces
   * use dedicated helpers below so the scope split is explicit).
   */
  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".pi")
      : join(homedir(), ".pi");
  }

  /**
   * Pi has no writable MCP config. Returning the config dir keeps the generic
   * doctor/backup sensible while installServer always skips.
   */
  getServerConfigPath(ctx: InstallContext): string {
    return this.getConfigDir(ctx);
  }

  /** Pi has no hook file — point at the config dir for generic doctor/backup. */
  getHookConfigPath(ctx: InstallContext): string {
    return this.getConfigDir(ctx);
  }

  /**
   * Prompt-templates dir (slash commands):
   *   project scope → <projectDir>/.pi/prompts/
   *   user scope    → ~/.pi/agent/prompts/
   * (ground truth: docs/prompt-templates.md)
   */
  private promptsDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".pi", "prompts")
      : join(homedir(), ".pi", "agent", "prompts");
  }

  /**
   * Skills dir:
   *   project scope → <projectDir>/.pi/skills/
   *   user scope    → ~/.pi/agent/skills/
   * (ground truth: ~/.pi/agent/skills/ is what Pi actually reads for global skills)
   */
  private skillsDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".pi", "skills")
      : join(homedir(), ".pi", "agent", "skills");
  }

  /** Native skill dir: <skillsDir>/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }

  // ── MCP server (unavailable — Pi has no writable MCP config) ─────────────

  installServer(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "Pi has no writable MCP config",
      },
    ];
  }

  uninstallServer(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "Pi has no writable MCP config",
      },
    ];
  }

  // ── Hooks (unavailable — Pi has no json-stdio/ts-plugin hook layer) ───────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Pi has no hook layer)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Pi has no hook layer)",
      },
    ];
  }

  // ── Content surface: commands (prompt templates) ─────────────────────────
  // Pi slash commands are prompt template files: <promptsDir>/<name>.md.
  // Idempotent (byte-identical → skip) via BaseAdapter.writeContentFile and
  // reversible via removeContentFile. Honors platforms["pi"].commands === false.

  /** Native prompt-template file path: <promptsDir>/<name>.md. */
  private commandPath(ctx: InstallContext, name: string): string {
    return join(this.promptsDir(ctx), `${name}.md`);
  }

  override installCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.commands === false) {
      return [{ platform: this.id, action: "skip", detail: "commands disabled for pi" }];
    }
    if (connector.commands.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no commands" }];
    }
    return connector.commands.map((cmd) =>
      this.writeContentFile(
        this.commandPath(ctx, cmd.name),
        this.renderCommand(cmd),
        ctx.dryRun,
      ),
    );
  }

  override uninstallCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.commands.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no commands" }];
    }
    return connector.commands.map((cmd) =>
      this.removeContentFile(this.commandPath(ctx, cmd.name), ctx.dryRun),
    );
  }

  /**
   * Render a command as a Pi prompt template (md+frontmatter).
   * Pi's format mirrors the generic command render: description, optional model,
   * optional argument-hint. The body is the prompt template text.
   */
  private renderCommand(cmd: CommandDef): string {
    const frontmatter: Record<string, unknown> = {};
    if (cmd.description !== undefined) frontmatter.description = cmd.description;
    if (cmd.model !== undefined) frontmatter.model = cmd.model;
    if (cmd.argumentHint !== undefined) frontmatter["argument-hint"] = cmd.argumentHint;
    if (cmd.extra) Object.assign(frontmatter, cmd.extra);
    return this.renderFrontmatterMd(frontmatter, cmd.prompt);
  }

  // ── Content surface: skills ──────────────────────────────────────────────
  // CONTENT-ONLY: pure native-file writer under <skillsDir>/<name>.
  // Idempotent (byte-identical → skip) via BaseAdapter.writeContentFile and
  // reversible via removeContentFile. Honors platforms["pi"].skills === false.

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for pi" }];
    }
    if (connector.skills.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no skills" }];
    }
    const changes: ChangeRecord[] = [];
    for (const skill of connector.skills) {
      const dir = this.skillDir(ctx, skill.name);
      changes.push(
        this.writeContentFile(join(dir, "SKILL.md"), this.renderSkill(skill), ctx.dryRun),
      );
      // Bundle any resource files beside SKILL.md (relative path → contents).
      // Defense-in-depth: skip+warn on any key that escapes the skill dir.
      for (const [rel, contents] of Object.entries(skill.resources ?? {})) {
        const target = this.resolveWithin(dir, rel);
        if (target === null) {
          changes.push({
            platform: this.id,
            action: "warn",
            detail: `skill resource "${rel}" escapes the skill dir; skipped`,
          });
          continue;
        }
        changes.push(this.writeContentFile(target, contents, ctx.dryRun));
      }
    }
    return changes;
  }

  override uninstallSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.skills.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no skills" }];
    }
    const changes: ChangeRecord[] = [];
    for (const skill of connector.skills) {
      const dir = this.skillDir(ctx, skill.name);
      changes.push(this.removeContentFile(join(dir, "SKILL.md"), ctx.dryRun));
      for (const rel of Object.keys(skill.resources ?? {})) {
        const target = this.resolveWithin(dir, rel);
        if (target === null) continue;
        changes.push(this.removeContentFile(target, ctx.dryRun));
      }
      // Only remove the skill dir when WE own its full contents.
      changes.push(this.removeDirIfEmpty(dir, ctx.dryRun));
    }
    return changes;
  }

  /**
   * Render a skill's SKILL.md.
   *
   * Pi's allowed-tools field is SPACE-delimited (not comma-delimited).
   * Every other field follows the uniform SKILL.md convention.
   */
  private renderSkill(skill: SkillDef): string {
    const frontmatter: Record<string, unknown> = {
      name: skill.name,
      description: skill.description,
    };
    if (skill.model !== undefined) frontmatter.model = skill.model;
    const allow = skill.tools?.allow;
    // Pi reads allowed-tools as space-separated — NOT the ", " used by other hosts.
    if (allow && allow.length > 0) frontmatter["allowed-tools"] = allow.join(" ");
    if (skill.disableModelInvocation !== undefined) {
      frontmatter["disable-model-invocation"] = skill.disableModelInvocation;
    }
    if (skill.extra) Object.assign(frontmatter, skill.extra);
    return this.renderFrontmatterMd(frontmatter, skill.body);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const checks: HealthCheck[] = [];

    // Command (prompt-template) checks.
    for (const cmd of ctx.connector.commands) {
      const p = this.commandPath(ctx, cmd.name);
      checks.push({
        name: `${this.name}: command ${cmd.name} present`,
        check: () =>
          existsSync(p)
            ? { status: "OK", detail: p }
            : { status: "FAIL", detail: `not found: ${p}` },
      });
    }

    // Skill-surface checks.
    for (const skill of ctx.connector.skills) {
      const p = join(this.skillDir(ctx, skill.name), "SKILL.md");
      checks.push({
        name: `${this.name}: skill ${skill.name} present`,
        check: () =>
          existsSync(p)
            ? { status: "OK", detail: p }
            : { status: "FAIL", detail: `not found: ${p}` },
      });
    }
    return checks;
  }
}

export const adapter = new PiAdapter();
export default adapter;
