/**
 * core/define-connector — the public write-once entry point.
 *
 * Validates a ConnectorConfig and normalizes it into a ResolvedConnector with
 * every optional field resolved to a default. Validation is intentionally
 * dependency-free (no zod) to keep the single-binary install lean.
 */

import { isAbsolute, normalize } from "node:path";

import type {
  CommandDef,
  ConnectorConfig,
  HookEventName,
  HooksConfig,
  PublishConfig,
  ResolvedConnector,
  SkillDef,
  SubagentDef,
} from "./types.js";
import { REGISTRY_NAMESPACE_RE } from "./mcp-standard.js";

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** kebab-case name regex shared by command/skill/subagent names. */
const SURFACE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Max length of a skill description (Agent Skills open standard). */
const SKILL_DESCRIPTION_MAX = 1024;

// NOTE: canonical ordering — append new events at the END (hookEvents ordering
// is pinned by tests and feeds install-file ordering).
const ALL_EVENTS: HookEventName[] = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "Stop",
  "Notification",
  "PermissionRequest",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
];

/** Thrown on an invalid connector configuration. */
export class ConnectorConfigError extends Error {
  constructor(message: string) {
    super(`Invalid connector config: ${message}`);
    this.name = "ConnectorConfigError";
  }
}

function declaredEvents(hooks: HooksConfig | undefined): HookEventName[] {
  if (!hooks) return [];
  return ALL_EVENTS.filter((e) => typeof hooks[e]?.handler === "function");
}

/**
 * Validate + normalize a connector definition.
 * Returns a ResolvedConnector that adapters and the CLI consume directly.
 */
export function defineConnector(config: ConnectorConfig): ResolvedConnector {
  if (!config || typeof config !== "object") {
    throw new ConnectorConfigError("config must be an object");
  }
  if (typeof config.id !== "string" || !ID_RE.test(config.id)) {
    throw new ConnectorConfigError(
      `id must be kebab-case matching ${ID_RE} (got ${JSON.stringify(config.id)})`,
    );
  }
  const hasCommands = Array.isArray(config.commands) && config.commands.length > 0;
  const hasSkills = Array.isArray(config.skills) && config.skills.length > 0;
  const hasSubagents = Array.isArray(config.subagents) && config.subagents.length > 0;
  // A platform-scoped nativeHooks declaration is a legitimate sole payload
  // (a hooks-only connector wired entirely through native passthrough events).
  const hasNativeHooks = Object.values(config.platforms ?? {}).some(
    (override) =>
      override?.nativeHooks != null && Object.keys(override.nativeHooks).length > 0,
  );
  if (
    !config.server &&
    !config.hooks &&
    !hasCommands &&
    !hasSkills &&
    !hasSubagents &&
    !hasNativeHooks
  ) {
    throw new ConnectorConfigError(
      "a connector must declare at least one of `server`, `hooks`, `commands`, `skills`, `subagents`, " +
        "or a per-platform `nativeHooks` declaration",
    );
  }

  if (config.server) {
    const s = config.server;
    if (s.transport === "stdio") {
      if (!s.command || typeof s.command !== "string") {
        throw new ConnectorConfigError(
          "server.command is required for stdio transport",
        );
      }
    } else {
      if (!s.url || typeof s.url !== "string") {
        throw new ConnectorConfigError(
          `server.url is required for ${s.transport} transport`,
        );
      }
    }
  }

  // Validate hook handlers are functions.
  if (config.hooks) {
    for (const ev of ALL_EVENTS) {
      const def = config.hooks[ev];
      if (def != null && typeof def.handler !== "function") {
        throw new ConnectorConfigError(`hooks.${ev}.handler must be a function`);
      }
    }
  }

  // Validate per-platform native passthrough hooks (handlers live in this same
  // config module, exactly like normalized hooks — the resolved connector keeps
  // `platforms` verbatim, so live handlers survive resolution and are recovered
  // at runtime by re-importing the module via the registry's modulePath).
  validateNativeHooks(config.platforms);

  const commands = normalizeCommands(config.commands);
  const skills = normalizeSkills(config.skills);
  const subagents = normalizeSubagents(config.subagents);

  const t = config.telemetry ?? {};

  const resolved: ResolvedConnector = {
    id: config.id,
    displayName: config.displayName ?? config.id,
    version: config.version ?? "0.0.0",
    ...(config.server ? { server: normalizeServer(config.server) } : {}),
    hooks: config.hooks ?? {},
    hookEvents: declaredEvents(config.hooks),
    telemetry: {
      enabled: t.enabled ?? true,
      modelFamilyHint: t.modelFamilyHint ?? "auto",
      measureToolDefs: t.measureToolDefs ?? true,
      // OPT-IN: host-native turn-usage capture is OFF unless explicitly enabled
      // in config (or forced on at install via AGENT_CONNECTOR_HOST_NATIVE=1).
      hostNativeUsage: t.hostNativeUsage ?? false,
      store: t.store ?? "ndjson",
      calibration: {
        anthropicCountTokens: t.calibration?.anthropicCountTokens ?? false,
      },
    },
    commands,
    skills,
    subagents,
    platforms: config.platforms ?? {},
    targets: config.targets ?? "auto",
    ...(config.publish ? { publish: normalizePublish(config.publish) } : {}),
  };

  return resolved;
}

/** The 12 normalized event names, for the nativeHooks collision check. */
const NORMALIZED_EVENT_SET: ReadonlySet<string> = new Set(ALL_EVENTS);

/**
 * Validate every `platforms[<id>].nativeHooks` declaration:
 *   - the value must be an object keyed by HOST-NATIVE event name;
 *   - an event name must NOT collide with the normalized {@link HookEventName}
 *     union (those belong in the cross-platform `hooks` API, which gets
 *     normalization, matcher evaluation, and HookResponse mapping);
 *   - each handler must be a function (it is re-imported from the config module
 *     at runtime, like normalized hook handlers);
 *   - `matcher`, when present, must be a string (written verbatim into the
 *     host's hook config — the host evaluates it).
 */
function validateNativeHooks(platforms: ConnectorConfig["platforms"]): void {
  if (platforms == null) return;
  for (const [platformId, override] of Object.entries(platforms)) {
    const native = override?.nativeHooks;
    if (native == null) continue;
    const where = `platforms.${platformId}.nativeHooks`;
    if (typeof native !== "object" || Array.isArray(native)) {
      throw new ConnectorConfigError(
        `${where} must be an object keyed by host-native event name`,
      );
    }
    for (const [event, def] of Object.entries(native)) {
      if (NORMALIZED_EVENT_SET.has(event)) {
        throw new ConnectorConfigError(
          `${where}.${event} collides with the normalized hook event "${event}"; ` +
            `declare it under \`hooks.${event}\` (the normalized, cross-platform hooks API) instead`,
        );
      }
      if (def == null || typeof def !== "object" || typeof def.handler !== "function") {
        throw new ConnectorConfigError(`${where}.${event}.handler must be a function`);
      }
      if (def.matcher !== undefined && typeof def.matcher !== "string") {
        throw new ConnectorConfigError(`${where}.${event}.matcher must be a string`);
      }
    }
  }
}

/**
 * Validate the optional `publish` block (registry server.json + MCPB bundle
 * distribution metadata). Light, dependency-free: we only reject shapes that
 * would emit a clearly INVALID standard artifact. The per-format required-field
 * checks (e.g. server.json needs registryNamespace, mcpb needs author.name)
 * live in the emitters so a connector that never publishes pays nothing.
 */
function normalizePublish(publish: PublishConfig): PublishConfig {
  if (typeof publish !== "object" || Array.isArray(publish)) {
    throw new ConnectorConfigError("publish must be an object");
  }
  if (publish.registryNamespace !== undefined) {
    const ns = publish.registryNamespace;
    if (typeof ns !== "string" || !REGISTRY_NAMESPACE_RE.test(ns)) {
      throw new ConnectorConfigError(
        `publish.registryNamespace must be a reverse-DNS namespace matching ${REGISTRY_NAMESPACE_RE} ` +
          `(e.g. "io.github.acme" or "com.acme"); got ${JSON.stringify(ns)}`,
      );
    }
  }
  if (publish.packageName !== undefined && typeof publish.packageName !== "string") {
    throw new ConnectorConfigError("publish.packageName must be a string");
  }
  if (publish.author !== undefined) {
    const a = publish.author;
    if (typeof a !== "object" || a == null || typeof a.name !== "string" || a.name === "") {
      throw new ConnectorConfigError("publish.author.name must be a non-empty string");
    }
  }
  return { ...publish };
}

/** Validate a surface name (kebab-case) or throw a ConnectorConfigError. */
function assertSurfaceName(surface: string, name: unknown, index: number): string {
  if (typeof name !== "string" || !SURFACE_NAME_RE.test(name)) {
    throw new ConnectorConfigError(
      `${surface}[${index}].name must be kebab-case matching ${SURFACE_NAME_RE} (got ${JSON.stringify(name)})`,
    );
  }
  return name;
}

/** Require a non-empty string field on a surface entry. */
function assertNonEmptyString(
  surface: string,
  index: number,
  field: string,
  value: unknown,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConnectorConfigError(`${surface}[${index}].${field} must be a non-empty string`);
  }
  return value;
}

/** Detect a duplicate surface name within one array, throwing on collision. */
function assertNoDuplicate(
  surface: string,
  seen: Set<string>,
  name: string,
  index: number,
): void {
  if (seen.has(name)) {
    throw new ConnectorConfigError(`${surface}[${index}] duplicate name "${name}"`);
  }
  seen.add(name);
}

function normalizeCommands(input: CommandDef[] | undefined): CommandDef[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new ConnectorConfigError("commands must be an array");
  }
  const seen = new Set<string>();
  return input.map((cmd, i) => {
    if (!cmd || typeof cmd !== "object") {
      throw new ConnectorConfigError(`commands[${i}] must be an object`);
    }
    const name = assertSurfaceName("commands", cmd.name, i);
    assertNoDuplicate("commands", seen, name, i);
    assertNonEmptyString("commands", i, "prompt", cmd.prompt);
    // Pass through verbatim (content); arrays are content, not handlers.
    return { ...cmd, name };
  });
}

function normalizeSkills(input: SkillDef[] | undefined): SkillDef[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new ConnectorConfigError("skills must be an array");
  }
  const seen = new Set<string>();
  return input.map((skill, i) => {
    if (!skill || typeof skill !== "object") {
      throw new ConnectorConfigError(`skills[${i}] must be an object`);
    }
    const name = assertSurfaceName("skills", skill.name, i);
    assertNoDuplicate("skills", seen, name, i);
    const description = assertNonEmptyString("skills", i, "description", skill.description);
    if (description.length > SKILL_DESCRIPTION_MAX) {
      throw new ConnectorConfigError(
        `skills[${i}].description exceeds ${SKILL_DESCRIPTION_MAX} chars (got ${description.length})`,
      );
    }
    assertNonEmptyString("skills", i, "body", skill.body);
    assertSafeResourceKeys("skills", i, skill.resources);
    return { ...skill, name };
  });
}

/**
 * Validate every `skill.resources` key as a SAFE relative path that stays inside
 * the skill dir. Each resource is later written/removed via join(skillDir, rel)
 * by every adapter, so an unvalidated key like "../../settings.json" would
 * escape the skill dir → arbitrary file write/delete. Reject (throw) when a key
 * is empty/".", absolute, or normalizes to a path that begins with ".." or
 * contains a "/.." (or platform-sep) traversal segment.
 */
function assertSafeResourceKeys(
  surface: string,
  index: number,
  resources: Record<string, string> | undefined,
): void {
  if (resources == null) return;
  if (typeof resources !== "object" || Array.isArray(resources)) {
    throw new ConnectorConfigError(`${surface}[${index}].resources must be an object`);
  }
  for (const rel of Object.keys(resources)) {
    if (rel === "" || rel === "." || rel.trim() === "") {
      throw new ConnectorConfigError(
        `${surface}[${index}].resources key must be a non-empty relative path (got ${JSON.stringify(rel)})`,
      );
    }
    if (isAbsolute(rel)) {
      throw new ConnectorConfigError(
        `${surface}[${index}].resources key must be a relative path inside the skill dir, not absolute (got ${JSON.stringify(rel)})`,
      );
    }
    // Normalize with BOTH posix and native separators flattened so a Windows
    // "..\\x" or a posix "../x" is caught regardless of the host OS.
    const norm = normalize(rel.replace(/\\/g, "/"));
    const segs = norm.split(/[/\\]/);
    if (norm === ".." || norm.startsWith("../") || norm.startsWith("..\\") || segs.includes("..")) {
      throw new ConnectorConfigError(
        `${surface}[${index}].resources key must not escape the skill dir via ".." (got ${JSON.stringify(rel)})`,
      );
    }
  }
}

function normalizeSubagents(input: SubagentDef[] | undefined): SubagentDef[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new ConnectorConfigError("subagents must be an array");
  }
  const seen = new Set<string>();
  return input.map((agent, i) => {
    if (!agent || typeof agent !== "object") {
      throw new ConnectorConfigError(`subagents[${i}] must be an object`);
    }
    const name = assertSurfaceName("subagents", agent.name, i);
    assertNoDuplicate("subagents", seen, name, i);
    assertNonEmptyString("subagents", i, "description", agent.description);
    assertNonEmptyString("subagents", i, "prompt", agent.prompt);
    return { ...agent, name };
  });
}

function normalizeServer(server: ConnectorConfig["server"]): ResolvedConnector["server"] {
  if (!server) return undefined;
  const wrapDefault = server.transport === "stdio";
  return {
    ...server,
    enabled: server.enabled ?? true,
    tools: server.tools ?? { include: ["*"] },
    wrapForTelemetry: server.wrapForTelemetry ?? wrapDefault,
  };
}
