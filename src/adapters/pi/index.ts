/**
 * adapters/pi — Pi platform adapter for agentconnect.
 *
 * Pi is an **mcp-only** host with NO writable MCP config that agentconnect
 * can target, and no lifecycle hook system. Its one extensibility surface that
 * this connector drives is **Agent Skills**: folder-per-skill `SKILL.md` files
 * (md+frontmatter, the Agent Skills open standard) under `<piDir>/skills/`.
 *
 * So this adapter deliberately implements ONLY the skills content surface:
 *   - server  → single "skip" (Pi has no writable MCP config).
 *   - hooks   → single "skip" (Pi is mcp-only; no lifecycle hooks).
 *   - skills  → write `<piDir>/skills/<name>/SKILL.md` (+ declared resources).
 *   - commands / subagents → inherit BaseAdapter skip/warn (unsupported).
 *
 * Config dir (skills home):
 *   - user scope    → ~/.pi
 *   - project scope → <projectDir>/.pi
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BaseAdapter } from "../base.js";
import type { Adapter, InstallContext } from "../spi.js";
import type {
  ChangeRecord,
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
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Pi has no lifecycle hook system — every hook capability is false.
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
    // No writable MCP config we can register a server into.
    transports: [],
    // Content surfaces: skills ONLY.
    supportsCommands: false,
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

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".pi")
      : join(homedir(), ".pi");
  }

  /**
   * Pi has no writable MCP config that agentconnect targets. Returning the
   * config dir keeps the generic doctor/backup sensible while installServer
   * itself always skips.
   */
  getServerConfigPath(ctx: InstallContext): string {
    return this.getConfigDir(ctx);
  }

  /** Pi has no hook file — point at the config dir for generic doctor/backup. */
  getHookConfigPath(ctx: InstallContext): string {
    return this.getConfigDir(ctx);
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

  // ── Hooks (unavailable — Pi is mcp-only) ─────────────────────────────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Pi is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Pi is mcp-only)",
      },
    ];
  }

  // ── Content surface: skills ──────────────────────────────────────────────
  // CONTENT-ONLY: pure native-file writer under <configDir>/skills/<name>.
  // Idempotent (byte-identical → skip) via BaseAdapter.writeContentFile and
  // reversible via removeContentFile. Honors platforms["pi"].skills === false.

  private skillsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "skills");
  }

  /** Native skill dir: <configDir>/skills/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }

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
      // Defense-in-depth: skip+warn on any key that escapes the skill dir
      // (config-time validation already rejects these, but never trust input).
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
      // Remove only the files we wrote (SKILL.md + declared resources), then the
      // skill dir itself when we own its full contents.
      changes.push(this.removeContentFile(join(dir, "SKILL.md"), ctx.dryRun));
      for (const rel of Object.keys(skill.resources ?? {})) {
        const target = this.resolveWithin(dir, rel);
        if (target === null) continue; // never delete outside the skill dir
        changes.push(this.removeContentFile(target, ctx.dryRun));
      }
      // Only remove the skill dir when WE own its full contents — never rm -rf a
      // dir that still holds user-added / sibling-tool / shared files.
      changes.push(this.removeDirIfEmpty(dir, ctx.dryRun));
    }
    return changes;
  }

  /**
   * Render a skill's SKILL.md: frontmatter (name, description + optional model,
   * allowed-tools, disable-model-invocation) + body.
   */
  private renderSkill(skill: SkillDef): string {
    const frontmatter: Record<string, unknown> = {
      name: skill.name,
      description: skill.description,
    };
    if (skill.model !== undefined) frontmatter.model = skill.model;
    const allow = skill.tools?.allow;
    if (allow && allow.length > 0) frontmatter["allowed-tools"] = allow.join(", ");
    if (skill.disableModelInvocation !== undefined) {
      frontmatter["disable-model-invocation"] = skill.disableModelInvocation;
    }
    if (skill.extra) Object.assign(frontmatter, skill.extra);
    return this.renderFrontmatterMd(frontmatter, skill.body);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const checks: HealthCheck[] = [];
    // Skill-surface checks: only assert presence of the SKILL.md files this
    // connector declares (skip silently when none are declared).
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
