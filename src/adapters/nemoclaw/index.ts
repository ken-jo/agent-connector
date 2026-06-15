/**
 * adapters/nemoclaw — NVIDIA NemoClaw platform adapter for agent-connector.
 *
 * NemoClaw (github.com/NVIDIA/NemoClaw, Apache-2.0, v0.1.0) is an
 * orchestrator/wrapper that deploys and lifecycle-manages an OpenClaw agent
 * (the default) inside an NVIDIA OpenShell sandbox. It is ALSO an OpenClaw
 * plugin. It is NOT a Claude/Codex/Gemini fork: the agent it wraps is OpenClaw,
 * and the config the wrapped agent actually loads is the SAME
 * `~/.openclaw/openclaw.json` the OpenClaw adapter already targets (top-level
 * `mcp.servers.<id>` for MCP sidecars; plugins.entries + plugins.load.paths for
 * the ts-plugin bridge — OpenClaw's verified DUAL REGISTRATION shape).
 *
 * DESIGN — a thin fork of {@link OpenClawAdapter} (precedent:
 * AntigravityCliAdapter extends AntigravityAdapter). It REUSES every render /
 * hook / parse / surface path from the parent unchanged — MCP still lands in
 * the wrapped `~/.openclaw/openclaw.json`, the paradigm stays ts-plugin, and the
 * content surfaces (skills) are inherited. The ONLY differences are identity and
 * detection:
 *
 *   - id = "nemoclaw", name = "NVIDIA NemoClaw". Identity flows into the
 *     ChangeRecord `platform` stamp and the host-detection result.
 *   - detectInstalled probes the NemoClaw-specific marker `~/.nemoclaw/`
 *     (config.json + rebuild-backups/ + blueprints/). A NemoClaw box has BOTH
 *     markers on disk: it DRIVES the wrapped `~/.openclaw/openclaw.json`, so
 *     `~/.openclaw/` is present too. Exclusivity is therefore guaranteed at the
 *     SOURCE, not by registry order alone — {@link OpenClawAdapter.detectInstalled}
 *     BOWS OUT (reports its user scope not-installed) whenever `~/.nemoclaw/`
 *     exists, so the shared config is never double-targeted as two platforms
 *     (an `uninstall openclaw` would otherwise strip nemoclaw's entries). nemoclaw
 *     is ALSO registered BEFORE openclaw (PlatformId union AND ADAPTER_REGISTRY)
 *     as the deterministic tie-break — a NemoClaw box classifies as nemoclaw; an
 *     OpenClaw-only box (no `~/.nemoclaw/`) classifies as openclaw.
 *
 * HOOKS: NemoClaw ships NO Claude-style lifecycle hooks of its own
 * (managedChannels are messaging; plugin activation.onStartup and runtime-slash
 * aliases are not hook events). It nonetheless INHERITS OpenClaw's ts-plugin
 * hook machinery — when a connector declares hooks, the inherited installHooks
 * writes the same self-contained OpenClaw plugin bridge into the wrapped
 * `~/.openclaw/openclaw.json` (the agent NemoClaw runs), so the paradigm stays
 * ts-plugin honestly.
 *
 * SOURCES: github.com/NVIDIA/NemoClaw (README, nemoclaw/openclaw.plugin.json,
 * src/onboard/config.ts, test/openclaw-config-snapshot.test.ts,
 * src/lib/state/sandbox.ts), docs.nvidia.com/nemoclaw.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { OpenClawAdapter } from "../openclaw/index.js";
import type { Adapter } from "../spi.js";
import type { DetectedPlatform, PlatformId } from "../../core/types.js";

const HOST: PlatformId = "nemoclaw";

export class NemoClawAdapter extends OpenClawAdapter implements Adapter {
  override readonly id: PlatformId = HOST;
  override readonly name = "NVIDIA NemoClaw";

  // ── Detection ────────────────────────────────────────────────────────────

  /**
   * Probe the NemoClaw-specific marker `~/.nemoclaw/` (its onboarding writes
   * config.json + rebuild-backups/ + blueprints/ there). This is DISTINCT from
   * OpenClaw's `~/.openclaw/` marker even though NemoClaw drives the wrapped
   * OpenClaw config: a box with `~/.nemoclaw/` is a NemoClaw install. Reported
   * before the OpenClaw adapter in the registry so the more-specific NemoClaw
   * marker wins host detection (a plain OpenClaw box — `~/.openclaw/` only,
   * no `~/.nemoclaw/` — falls through to the openclaw adapter).
   *
   * The config path returned is the WRAPPED OpenClaw config (where MCP/hooks are
   * actually written) so install/doctor point at the file the agent loads.
   */
  override detectInstalled(projectDir: string): DetectedPlatform {
    const nemoclawDir = join(homedir(), ".nemoclaw");
    const installed = existsSync(nemoclawDir);

    // Inherit OpenClaw's path resolution for the wrapped config (the file the
    // agent NemoClaw runs actually loads) and the capabilities/paradigm.
    const base = super.detectInstalled(projectDir);

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      // Where MCP/hooks land for NemoClaw: the wrapped OpenClaw config.
      configPath: base.configPath,
      scope: base.scope,
      reason: installed
        ? `found NVIDIA NemoClaw config at ${nemoclawDir} (wraps OpenClaw at ${base.configPath})`
        : `no NVIDIA NemoClaw config at ${nemoclawDir}`,
      confidence: installed ? "high" : "low",
    };
  }
}

export const adapter = new NemoClawAdapter();
export default adapter;
