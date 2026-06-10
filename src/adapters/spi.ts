/**
 * adapters/spi — the contract every platform adapter implements.
 *
 * Generalized from context-mode's HookAdapter, with three deliberate changes:
 *   1. The served identity is a parameter (ResolvedConnector in InstallContext),
 *      not the hardcoded "context-mode".
 *   2. Session/memory/instruction-file/FTS domain logic is removed.
 *   3. MCP server registration is part of the contract (root key + format differ
 *      per platform), alongside hook registration.
 *
 * An adapter has two responsibilities:
 *   • INSTALL-TIME (render): write/remove this platform's native MCP + hook config.
 *   • RUNTIME (dispatch): for json-stdio / ts-plugin hosts, parse the host's hook
 *     payload into a normalized event and format the normalized response back.
 */

import type {
  ChangeRecord,
  DetectedPlatform,
  DiagnosticResult,
  EventPayloadMap,
  HealthCheck,
  HookEventName,
  HookParadigm,
  HookResponse,
  InstallScope,
  PlatformCapabilities,
  PlatformId,
  ResolvedConnector,
} from "../core/types.js";

/** Union of every normalized event payload. */
export type NormalizedEvent = EventPayloadMap[HookEventName];

/**
 * Everything an adapter needs to install for one connector on this machine.
 * Built by the CLI/install layer from the resolved connector + flags + paths.
 */
export interface InstallContext {
  connector: ResolvedConnector;
  scope: InstallScope;
  /** Resolved project root (cwd or --project). Used by project-scoped adapters. */
  projectDir: string;
  /**
   * Stable absolute path to the single home binary
   * (`~/.agent-connector/bin/agent-connector`). All hook commands and the
   * telemetry-wrapping `serve` invocation point here — so one update propagates
   * to every host. Never a versioned cache path (avoids the cache-heal bug class).
   */
  homeBinPath: string;
  /** Framework data-root (`~/.agent-connector`, or AGENT_CONNECTOR_DATA_DIR). */
  dataRoot: string;
  dryRun: boolean;
}

/** Normalized reply the runtime turns into the host's native hook response. */
export interface HookReply {
  /** Process exit code the host interprets (0 = allow; non-zero conventions vary). */
  exitCode: number;
  /** JSON or text written to stdout (host-native control payload). */
  stdout?: string;
  /** Diagnostic text for stderr. */
  stderr?: string;
}

/**
 * One generated plugin file for ts-plugin hosts (OpenCode/Kilo/Hermes/OpenClaw).
 * The framework writes these and registers them in the host's plugin list.
 */
export interface GeneratedPluginFile {
  path: string;
  contents: string;
  /** Set executable bit after writing. */
  executable?: boolean;
}

export interface Adapter {
  readonly id: PlatformId;
  readonly name: string;
  readonly paradigm: HookParadigm;
  readonly capabilities: PlatformCapabilities;

  // ── Detection ──────────────────────────────────────────────────────────
  /**
   * Is this host installed on the machine? Probes config dirs + marker files.
   * `projectDir` lets project-scoped adapters resolve their path.
   */
  detectInstalled(projectDir: string): DetectedPlatform;

  // ── Native paths ───────────────────────────────────────────────────────
  /** Native config directory for the given scope/project (always absolute). */
  getConfigDir(ctx: InstallContext): string;
  /** File where the MCP server entry is written (may equal the hook settings file). */
  getServerConfigPath(ctx: InstallContext): string;
  /** File where hook registration is written (json-stdio) or the plugin dir (ts-plugin). */
  getHookConfigPath(ctx: InstallContext): string;

  // ── Install / uninstall (idempotent, reversible) ────────────────────────
  /** Render + write the MCP server registration. No-op + "skip" if server omitted. */
  installServer(ctx: InstallContext): ChangeRecord[];
  /** Remove the MCP server registration this connector wrote. */
  uninstallServer(ctx: InstallContext): ChangeRecord[];
  /**
   * Install hooks per paradigm:
   *   json-stdio → write hook config pointing at `homeBinPath hook <id> <event>`;
   *   ts-plugin  → synthesize + register a plugin module;
   *   mcp-only   → return a single "skip" change (hooks unavailable here).
   */
  installHooks(ctx: InstallContext): ChangeRecord[];
  /** Inverse of installHooks — fully removes registrations so the host stops loading them. */
  uninstallHooks(ctx: InstallContext): ChangeRecord[];

  // ── Content surfaces (commands / skills / subagents) ─────────────────────
  // OPTIONAL on the adapter interface, but BaseAdapter provides CONCRETE
  // defaults for all six so the installer can call them unconditionally (no
  // optional-chaining). Supporting adapters override only the surfaces they
  // honor; the rest inherit a skip/warn from BaseAdapter.unsupportedSurface.
  /** Write native slash-command content file(s). */
  installCommands?(ctx: InstallContext): ChangeRecord[];
  /** Remove the slash-command content file(s) this connector wrote. */
  uninstallCommands?(ctx: InstallContext): ChangeRecord[];
  /** Write native Agent Skill folder(s) (SKILL.md + resources). */
  installSkills?(ctx: InstallContext): ChangeRecord[];
  /** Remove the Agent Skill folder(s) this connector wrote. */
  uninstallSkills?(ctx: InstallContext): ChangeRecord[];
  /** Write native subagent content file(s). */
  installSubagents?(ctx: InstallContext): ChangeRecord[];
  /** Remove the subagent content file(s) this connector wrote. */
  uninstallSubagents?(ctx: InstallContext): ChangeRecord[];

  /** Back up the settings file(s) before mutation. Returns backup path or null. */
  backupSettings(ctx: InstallContext): string | null;

  // ── Diagnostics (doctor) ────────────────────────────────────────────────
  doctor(ctx: InstallContext): DiagnosticResult[];
  /** Optional lightweight per-platform health checks rendered by the generic doctor. */
  getHealthChecks?(ctx: InstallContext): readonly HealthCheck[];

  // ── Runtime dispatch (json-stdio / ts-plugin only) ──────────────────────
  /** Parse a raw host hook payload into the normalized event for `event`. */
  parseEvent?(event: HookEventName, raw: unknown): NormalizedEvent;
  /** Format a normalized response into this host's native hook reply. */
  formatReply?(event: HookEventName, response: HookResponse): HookReply;
  /** ts-plugin hosts: produce the plugin module(s) to write. */
  synthesizePlugin?(ctx: InstallContext): GeneratedPluginFile[];
}

/**
 * Lazy adapter loader entry for the registry. Keeps startup cheap — an adapter
 * module is only imported when it is actually needed.
 */
export interface AdapterFactory {
  readonly id: PlatformId;
  readonly load: () => Promise<Adapter>;
}
