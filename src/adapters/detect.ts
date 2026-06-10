/**
 * adapters/detect — two complementary detection answers.
 *
 *   1. detectInstalledPlatforms(projectDir): which hosts are INSTALLED on this
 *      machine (probe each adapter's config dirs / marker files). Drives the
 *      install planner ("auto" target expansion, `doctor`).
 *
 *   2. detectRuntimeHost(env): which host is EXECUTING right now (read env
 *      markers the host runtime injects into its child processes). Drives the
 *      universal hook entrypoint — it must know which adapter's wire format the
 *      stdin payload is in before it can parse it.
 *
 * Both derive their platform set from `ADAPTER_REGISTRY` (the single source of
 * truth in registry.ts), generalizing context-mode's detection cascade
 * (env-var tier → config-dir tier → low-confidence fallback) to our
 * Adapter/AdapterFactory contract. The config-dir tier is delegated to each
 * adapter's `detectInstalled()` rather than duplicated here, so adding a
 * platform never requires editing this file.
 */

import type { DetectedPlatform, DetectionSignal, PlatformId } from "../core/types.js";
import { ADAPTER_REGISTRY, loadAdapter } from "./registry.js";

/**
 * Detect every platform installed on this machine.
 *
 * Loads each registered adapter and calls its `detectInstalled(projectDir)`
 * (which probes the platform's native config dirs + marker files), returning
 * only those reported `installed === true`, in registry order. Adapters never
 * throw from detection, but we guard each call so one misbehaving adapter
 * cannot abort the whole probe.
 *
 * @param projectDir Resolved project root — lets project-scoped adapters look
 *   for `<projectDir>/.mcp.json`, `<projectDir>/.cursor`, etc.
 */
export async function detectInstalledPlatforms(
  projectDir: string,
): Promise<DetectedPlatform[]> {
  const adapters = await Promise.all(
    ADAPTER_REGISTRY.map(async (factory) => {
      try {
        return await factory.load();
      } catch {
        return undefined;
      }
    }),
  );

  const detected: DetectedPlatform[] = [];
  for (const adapter of adapters) {
    if (!adapter) continue;
    try {
      const result = adapter.detectInstalled(projectDir);
      if (result.installed) detected.push(result);
    } catch {
      // A single adapter's detection failure must not sink the whole probe.
    }
  }
  return detected;
}

/**
 * One env-marker rule for runtime-host detection. `vars` is checked in order;
 * the FIRST rule with any non-empty matching env var wins, so the table order
 * is the detection precedence (forks before parents). Each var is documented at
 * the rule so the source of the marker is auditable.
 */
interface RuntimeSignalRule {
  readonly platform: PlatformId;
  /** Env var names that prove "this host is executing me". */
  readonly vars: readonly string[];
  /** Human-readable note (printed in the DetectionSignal.reason). */
  readonly note: string;
}

/**
 * Ordered env-marker table. Forks BEFORE parents (cursor — a VS Code fork —
 * precedes any future vscode-copilot entry so a Cursor session inside a
 * VS Code-derived shell is not misclassified). Markers are verified against
 * each host's source:
 *
 *   - claude-code: CLAUDE_CODE_ENTRYPOINT is set on every Claude Code session;
 *     CLAUDE_PLUGIN_ROOT is set when a plugin is loaded. Both are CC-exclusive
 *     and serve as the disambiguators when CC runs inside another IDE's shell.
 *   - codex:       CODEX_THREAD_ID is set per exec (codex-rs/core exec_env);
 *     CODEX_CI is set in CI mode (unified_exec process_manager).
 *   - cursor:      CURSOR_TRACE_ID is the widely-observed Cursor marker (Cursor
 *     CLI / agent); CURSOR_CLI marks the Cursor terminal; CURSOR_CWD is the
 *     documented workspace var.
 */
const RUNTIME_SIGNALS: readonly RuntimeSignalRule[] = [
  {
    platform: "claude-code",
    vars: ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PROJECT_DIR", "CLAUDE_SESSION_ID"],
    note: "Claude Code env marker set",
  },
  {
    platform: "cursor",
    vars: ["CURSOR_TRACE_ID", "CURSOR_CLI", "CURSOR_CWD"],
    note: "Cursor env marker set",
  },
  {
    platform: "codex",
    vars: ["CODEX_THREAD_ID", "CODEX_CI"],
    note: "Codex env marker set",
  },
];

/**
 * Identify which host runtime is executing the current process from environment
 * markers. High confidence on an env-marker hit; otherwise an explicit
 * `AGENTCONNECT_PLATFORM` override (high confidence, validated against the
 * registry) is honored; failing both, returns `unknown` at low confidence so
 * the caller can decide on a safe default.
 *
 * Pure with respect to its `env` argument (defaults to `process.env`) so it is
 * trivially testable — pass a synthetic env to assert each rule.
 */
export function detectRuntimeHost(env: NodeJS.ProcessEnv = process.env): DetectionSignal {
  // ── Explicit override (highest priority, validated against the registry) ──
  const override = env.AGENTCONNECT_PLATFORM;
  if (override && override.trim() !== "") {
    if (REGISTERED_RUNTIME_IDS.has(override as PlatformId)) {
      return {
        platform: override as PlatformId,
        confidence: "high",
        reason: `AGENTCONNECT_PLATFORM=${override} override`,
      };
    }
  }

  // ── Env-marker tier (forks before parents; first hit wins) ──────────────
  for (const rule of RUNTIME_SIGNALS) {
    const hit = rule.vars.find((name) => {
      const value = env[name];
      return typeof value === "string" && value !== "";
    });
    if (hit) {
      return {
        platform: rule.platform,
        confidence: "high",
        reason: `${rule.note} (${hit})`,
      };
    }
  }

  // ── Fallback: no host marker present ────────────────────────────────────
  return {
    platform: "unknown",
    confidence: "low",
    reason: "no host runtime env marker detected",
  };
}

/** Platform ids the runtime-signal table knows how to detect. */
const REGISTERED_RUNTIME_IDS: ReadonlySet<PlatformId> = new Set(
  RUNTIME_SIGNALS.map((rule) => rule.platform),
);

// Re-export for callers that resolve an adapter straight from a detection
// result without reaching into registry.ts.
export { loadAdapter };
