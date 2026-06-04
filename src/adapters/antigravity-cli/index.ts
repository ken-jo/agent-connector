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
 * differences are identity and detection:
 *
 *   - id   = "antigravity-cli", name = "Antigravity CLI". Identity flows into the
 *     universal hook command (`<homeBin> hook antigravity-cli <event> …`) and the
 *     `hostPlatform` stamp, so a CLI-installed hook dispatches back to THIS
 *     adapter at runtime — the reason the parent's install/parse logic was made
 *     to read `this.id` rather than a fixed host constant.
 *   - Detection probes the `agy` binary at ~/.local/bin/agy and/or the SHARED
 *     ~/.gemini/antigravity/ presence (distinct runtime markers from the IDE).
 *
 * CONFIRMED-BY-INSTALL (2026-06-03, docs/research/antigravity-paths-confirmed.md):
 * the `agy` CLI v1.0.0 has NO separate config dir — `~/.gemini/antigravity-cli/`,
 * `~/.config/antigravity*`, and `~/.agy` are ALL ABSENT. `agy` SHARES the IDE's
 * `~/.gemini/antigravity/` tree (mcp_config.json, hooks.json, workflows, skills).
 * So the user-scope config resolution here is IDENTICAL to the IDE adapter (the
 * inherited USER_CONFIG_CANDIDATES) — installing both the IDE and CLI connectors
 * therefore writes the SAME files and is idempotent (observed as skip), which is
 * expected and correct. `agy`'s own extension surface is the `agy plugin` system
 * (install/uninstall/list/enable/disable) — future work would deploy as an agy
 * plugin; for now the MCP/workflows/skills surfaces ride the shared IDE files.
 *
 * LIVE-TEST RESOLUTION (2026-06-04, real `agy` v1.0.5 login + spawn): the prior
 * "shares the IDE's ~/.gemini/antigravity/ file" claim was WRONG for the CLI. The
 * standalone `agy` reads user MCP from **~/.gemini/config/mcp_config.json**
 * (root key `mcpServers`; project scope <proj>/.agents/mcp_config.json) — PROVEN:
 * a live `agy -p` session spawned an MCP server placed in `config/` and completed
 * a real initialize+tools/list+tools/call handshake; a negative control in
 * `antigravity/` was ignored. The binary carries "failed to read mcp_config.json"
 * + a literal "/.gemini/config" path; there is NO `--mcp-config` flag and `agy
 * mcp` is TUI-only. So this adapter now OVERRIDES userConfigCandidates to prefer
 * `~/.gemini/config/mcp_config.json` (canonical) over the inherited IDE
 * `antigravity/` default (kept as a prefer-existing fallback). Telemetry-wrap is
 * compatible: agy spawns command+args verbatim, so the home-bin serve wrapper is
 * spawned as written — i.e. a real agy session now emits a per-MCP telemetry row.
 * (agy also keeps its own home ~/.gemini/antigravity-cli/ for auth/state, but MCP
 * config lives in the shared ~/.gemini/config/.)
 *
 * Project scope is IDENTICAL to the IDE adapter (`<proj>/.agents/…`), as is every
 * hook/command/skill render and the runtime parse/format — all inherited.
 *
 * The user-scope config paths shared with the IDE (hooks.json + the global skills
 * dir) remain MEDIUM-CONFIDENCE / PATH-PROBED in the parent (not present on the
 * observed install) and surfaced by the doctor; user-scope mcp_config + workflows
 * are CONFIRMED at ~/.gemini/antigravity/.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { AntigravityAdapter } from "../antigravity/index.js";
import type { Adapter } from "../spi.js";
import type { DetectedPlatform, PlatformId } from "../../core/types.js";

const HOST: PlatformId = "antigravity-cli";

export class AntigravityCliAdapter extends AntigravityAdapter implements Adapter {
  override readonly id: PlatformId = HOST;
  override readonly name = "Antigravity CLI";

  // ── Detection ────────────────────────────────────────────────────────────

  /**
   * Probe the CLI's runtime markers, DISTINCT from the IDE app even though the
   * two share `~/.gemini/antigravity/`: the `agy` binary at ~/.local/bin/agy
   * (the definitive CLI marker, CONFIRMED present) and the shared
   * ~/.gemini/antigravity/ tree (or a user-scope mcp_config candidate / the
   * project config). Reported before the IDE adapter in the registry so the
   * more-specific CLI marker (the `agy` binary) wins host detection. Note: a
   * machine with ONLY the IDE (no `agy` binary) will not match here, while one
   * with the CLI matches on the binary regardless of the shared config dir.
   */
  override detectInstalled(projectDir: string): DetectedPlatform {
    const home = homedir();
    const userConfig = this.resolveUserConfigPath();
    const agyBin = join(home, ".local", "bin", "agy");
    const sharedDir = join(home, ".gemini", "antigravity");
    const projectConfig = join(projectDir, ".agents", "mcp_config.json");

    // The `agy` binary is the definitive CLI marker. The shared antigravity dir
    // and the user-scope mcp_config candidates are secondary signals (they also
    // match a pure-IDE install, so the binary is what truly distinguishes the CLI).
    const cliMarker = existsSync(agyBin);
    const userInstalled =
      cliMarker ||
      existsSync(sharedDir) ||
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
          : `found Antigravity CLI (agy) at ${agyBin} / shared ${sharedDir}`
        : `no Antigravity CLI install at ${agyBin}, ${sharedDir}, or ${projectConfig}`,
      // The `agy` binary is a high-confidence CLI marker; matching only the shared
      // config dir is weaker (it could be a pure-IDE install).
      confidence: cliMarker ? "high" : installed ? "medium" : "low",
    };
  }

  /**
   * MCP user-config path — LIVE-PROVEN for `agy` v1.0.5 (2026-06-04). The
   * standalone CLI reads user MCP servers from `~/.gemini/config/mcp_config.json`
   * (root key `mcpServers`), NOT the IDE's `~/.gemini/antigravity/mcp_config.json`:
   * a real `agy -p` session spawned an MCP server ONLY when it was placed in
   * `config/` (negative control: a server in `antigravity/` was ignored), and the
   * binary carries the error string "failed to read mcp_config.json" + a literal
   * "/.gemini/config" path. `agy mcp` is TUI-only (no headless add) and there is
   * no `--mcp-config` flag. So the CLI must PREFER `config/` over the inherited
   * `antigravity/` default; the IDE path stays as a prefer-existing fallback.
   * (Skills/workflows/hooks dirs remain inherited; project scope
   * `<proj>/.agents/mcp_config.json` is already correct and live-proven.)
   */
  private static readonly CLI_USER_CONFIG_CANDIDATES = [
    [".gemini", "config", "mcp_config.json"], // CONFIRMED canonical for agy v1.0.5
    [".gemini", "antigravity", "mcp_config.json"], // legacy IDE layout (prefer-existing)
  ] as const;

  protected override userConfigCandidates(): ReadonlyArray<readonly string[]> {
    return AntigravityCliAdapter.CLI_USER_CONFIG_CANDIDATES;
  }
}

export const adapter = new AntigravityCliAdapter();
export default adapter;
