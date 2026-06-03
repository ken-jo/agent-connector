/**
 * adapters/antigravity-cli — Google Antigravity CLI (`agy`) platform adapter.
 *
 * Antigravity ships in two distinct runtimes that share the Gemini-family
 * `~/.gemini` tree and ALL of the same native formats (the JSON `mcp_config.json`
 * shape, the `hooks.json` lifecycle-hook shape, markdown Workflows, and Agent
 * Skills `SKILL.md`): the IDE/desktop app (the parent `AntigravityAdapter`,
 * id "antigravity") and this standalone CLI binary `agy` (id "antigravity-cli").
 *
 * This adapter is a thin fork of the IDE adapter. It REUSES every render / hook /
 * parse / surface path from {@link AntigravityAdapter} unchanged — the only
 * differences are identity and the user-scope on-disk roots:
 *
 *   - id   = "antigravity-cli", name = "Antigravity CLI". Identity flows into the
 *     universal hook command (`<homeBin> hook antigravity-cli <event> …`) and the
 *     `hostPlatform` stamp, so a CLI-installed hook dispatches back to THIS
 *     adapter at runtime — the reason the parent's install/parse logic was made
 *     to read `this.id` rather than a fixed host constant.
 *   - User MCP config candidates → prefer an existing
 *     ~/.gemini/config/mcp_config.json (canonical shared 2.0), else the CLI-only
 *     ~/.gemini/antigravity-cli/mcp_config.json (NOT the IDE's legacy
 *     ~/.gemini/antigravity/ path).
 *   - User global skills dir → ~/.gemini/antigravity-cli/skills (the CLI's own
 *     store; NEVER ~/.gemini/antigravity/skills, reportedly broken).
 *   - Detection probes the CLI's own install root ~/.gemini/antigravity-cli/ and
 *     the `agy` binary at ~/.local/bin/agy.
 *
 * Project scope is IDENTICAL to the IDE adapter (`<proj>/.agents/…`), as is every
 * hook/command/skill render and the runtime parse/format — all inherited.
 *
 * MEDIUM-CONFIDENCE / PATH-PROBING: Antigravity ships fast and its docs render
 * JS-only, so user-scope locations are corroborated but not byte-verified. Every
 * user-scope path is PROBED (prefer-existing-else-canonical, inherited from the
 * parent) and surfaced by the doctor; we NEVER hard-code a single guessed path,
 * and any unsupported event/surface warn-skips (never throws) at install time.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { AntigravityAdapter } from "../antigravity/index.js";
import type { Adapter, InstallContext } from "../spi.js";
import type { DetectedPlatform, PlatformId } from "../../core/types.js";

const HOST: PlatformId = "antigravity-cli";

/**
 * User-scope MCP config candidates for the CLI, in preference order. We prefer a
 * candidate that already exists; otherwise default to candidate[0]
 * (~/.gemini/config/mcp_config.json — the canonical shared 2.0 path). The
 * CLI-only ~/.gemini/antigravity-cli/mcp_config.json is the fork-specific
 * fallback. The IDE adapter's legacy ~/.gemini/antigravity/ path is deliberately
 * NOT a CLI candidate.
 */
const USER_CONFIG_CANDIDATES = [
  [".gemini", "config", "mcp_config.json"],
  [".gemini", "antigravity-cli", "mcp_config.json"],
] as const;

export class AntigravityCliAdapter extends AntigravityAdapter implements Adapter {
  override readonly id: PlatformId = HOST;
  override readonly name = "Antigravity CLI";

  // ── Detection ────────────────────────────────────────────────────────────

  /**
   * Probe the CLI's OWN install footprint, distinct from the IDE app: the CLI
   * dir ~/.gemini/antigravity-cli/, the `agy` binary at ~/.local/bin/agy, or any
   * of our user-scope MCP config candidates / the project config. Reported before
   * the IDE adapter in the registry so the more-specific CLI marker wins host
   * detection.
   */
  override detectInstalled(projectDir: string): DetectedPlatform {
    const home = homedir();
    const userConfig = this.resolveUserConfigPath();
    const cliDir = join(home, ".gemini", "antigravity-cli");
    const agyBin = join(home, ".local", "bin", "agy");
    const projectConfig = join(projectDir, ".agents", "mcp_config.json");

    const userInstalled =
      existsSync(cliDir) ||
      existsSync(agyBin) ||
      this.userConfigCandidates().some((parts) => existsSync(join(home, ...parts)));
    const projInstalled = existsSync(projectConfig);
    const installed = userInstalled || projInstalled;

    // Report the scope/path that actually matched, so a project-only install
    // isn't misreported as a (non-existent) user install.
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projectConfig : userConfig;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? scope === "project"
          ? `found project Antigravity CLI config at ${projectConfig}`
          : `found Antigravity CLI install at ${cliDir} / ${agyBin}`
        : `no Antigravity CLI install at ${cliDir}, ${agyBin}, or ${projectConfig}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── User-scope path overrides (project scope inherited unchanged) ─────────

  /** CLI user-scope MCP candidates (config/ first, then the CLI-only dir). */
  protected override userConfigCandidates(): ReadonlyArray<readonly string[]> {
    return USER_CONFIG_CANDIDATES;
  }

  /**
   * Resolve the Agent Skills dir. Project scope is identical to the IDE adapter
   * (<proj>/.agents/skills — inherited). User scope is the CLI's OWN global store
   * ~/.gemini/antigravity-cli/skills (NOT the shared ~/.gemini/skills the IDE may
   * fall back to, and NEVER the reportedly-broken ~/.gemini/antigravity/skills).
   */
  protected override resolveSkillsDir(ctx: InstallContext): string {
    if (ctx.scope === "project") {
      return super.resolveSkillsDir(ctx);
    }
    return join(homedir(), ".gemini", "antigravity-cli", "skills");
  }
}

export const adapter = new AntigravityCliAdapter();
export default adapter;
