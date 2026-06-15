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
  ConfigPatchDef,
  ConnectorConfig,
  HookDefinition,
  HookEventName,
  HooksConfig,
  MemoryDef,
  NativeHookDef,
  PlatformId,
  PublishConfig,
  ResolvedConnector,
  SkillDef,
  StatuslineDef,
  SubagentDef,
} from "./types.js";
import { REGISTERED_PLATFORM_IDS } from "../adapters/registry.js";
import { REGISTRY_NAMESPACE_RE } from "./mcp-standard.js";
import {
  MANAGED_BLOCK_BEGIN_TOKEN,
  MANAGED_BLOCK_END_TOKEN,
  MEMORY_CONTENT_HARD_CAP_BYTES,
} from "./managed-block.js";
import {
  CONFIG_PATCH_SEGMENT_RE,
  configPatchNamespaceViolation,
  isJsonValue,
  isValidConfigPatchKey,
} from "./config-patch-ledger.js";

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
  const hasMemory = Array.isArray(config.memory) && config.memory.length > 0;
  // A statusline (a HUD) is a legitimate sole payload — a connector whose whole
  // job is rendering a status line. SINGULAR (one per connector), so a plain
  // presence check (object with a render handler — validated in normalizeStatusline).
  const hasStatusline = config.statusline != null;
  // A platform-scoped nativeHooks declaration is a legitimate sole payload
  // (a hooks-only connector wired entirely through native passthrough events).
  const hasNativeHooks = Object.values(config.platforms ?? {}).some(
    (override) =>
      override?.nativeHooks != null && Object.keys(override.nativeHooks).length > 0,
  );
  // Likewise a platform-scoped configPatch declaration (a connector whose whole
  // job is asserting a host config key, e.g. an experimental feature flag).
  const hasConfigPatch = Object.values(config.platforms ?? {}).some(
    (override) => Array.isArray(override?.configPatch) && override.configPatch.length > 0,
  );
  if (
    !config.server &&
    !config.hooks &&
    !hasCommands &&
    !hasSkills &&
    !hasSubagents &&
    !hasMemory &&
    !hasStatusline &&
    !hasNativeHooks &&
    !hasConfigPatch
  ) {
    throw new ConnectorConfigError(
      "a connector must declare at least one of `server`, `hooks`, `commands`, `skills`, `subagents`, `memory`, `statusline`, " +
        "or a per-platform `nativeHooks` / `configPatch` declaration",
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

  // Validate hook handlers are functions, plus any per-host override map.
  if (config.hooks) {
    for (const ev of ALL_EVENTS) {
      const def = config.hooks[ev];
      if (def != null && typeof def.handler !== "function") {
        throw new ConnectorConfigError(`hooks.${ev}.handler must be a function`);
      }
      // Per-host override map: every key must be a registered platform id and
      // every entry's handler a function (author-time hard error, not skip-warn).
      validateHostsMap(def?.hosts, `hooks.${ev}.hosts`, "handler");
    }
  }

  // Validate per-platform native passthrough hooks (handlers live in this same
  // config module, exactly like normalized hooks — the resolved connector keeps
  // `platforms` verbatim, so live handlers survive resolution and are recovered
  // at runtime by re-importing the module via the registry's modulePath).
  validateNativeHooks(config.platforms);

  // Validate per-platform declarative config patches (pure JSON — persisted
  // whole; semantics are FIXED set-if-absent/skip-warn, so only the shape is
  // validated here; the host adapter enforces its sensitive-key denylist).
  validateConfigPatches(config.platforms);

  const commands = normalizeCommands(config.commands);
  const skills = normalizeSkills(config.skills);
  const subagents = normalizeSubagents(config.subagents);
  const memory = normalizeMemory(config.memory);
  const statusline = normalizeStatusline(config.statusline);

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
    memory,
    ...(statusline ? { statusline } : {}),
    platforms: config.platforms ?? {},
    targets: config.targets ?? "auto",
    ...(config.publish ? { publish: normalizePublish(config.publish) } : {}),
  };

  return resolved;
}

/** The 12 normalized event names, for the nativeHooks collision check. */
const NORMALIZED_EVENT_SET: ReadonlySet<string> = new Set(ALL_EVENTS);

/**
 * Validate a per-host override map (`hosts?:`) declared on a hook definition or
 * on the statusline. Shared by the hook-validation loop and normalizeStatusline:
 *   - the value must be a plain object keyed by platform id;
 *   - every key MUST be a REGISTERED platform id (REGISTERED_PLATFORM_IDS) —
 *     an unknown id is an author-time ConnectorConfigError (NOT a skip-warn:
 *     a typo'd host would otherwise silently never fire);
 *   - every entry's implementation field (`handler` for hooks, `render` for
 *     statusline) MUST be a function (it is re-imported from the connector
 *     module at runtime, like the top-level handler/render).
 * `undefined` (no map) is valid and skipped.
 */
function validateHostsMap(
  map: unknown,
  surfaceLabel: string,
  implField: "handler" | "render",
): void {
  if (map == null) return;
  if (typeof map !== "object" || Array.isArray(map)) {
    throw new ConnectorConfigError(
      `${surfaceLabel} must be an object keyed by platform id`,
    );
  }
  for (const [platformId, entry] of Object.entries(map as Record<string, unknown>)) {
    if (!REGISTERED_PLATFORM_IDS.has(platformId as PlatformId)) {
      const valid = [...REGISTERED_PLATFORM_IDS].sort().join(", ");
      throw new ConnectorConfigError(
        `unknown platform id "${platformId}" in hosts map for ${surfaceLabel}; valid ids: ${valid}`,
      );
    }
    if (
      entry == null ||
      typeof entry !== "object" ||
      typeof (entry as Record<string, unknown>)[implField] !== "function"
    ) {
      throw new ConnectorConfigError(
        `${surfaceLabel}.${platformId}.${implField} must be a function`,
      );
    }
  }
}

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
 * Validate every `platforms[<id>].configPatch` declaration:
 *   - the value must be an array of patch objects;
 *   - `key` must be a dotted LEAF path whose segments match
 *     {@link CONFIG_PATCH_SEGMENT_RE} — no dots-in-key, no array indices;
 *   - `key` must not collide with the agent-connector-modeled namespace
 *     (`hooks*` → hooks/nativeHooks; `mcpServers*` & friends → server/extra);
 *   - duplicate keys within one platform's list are rejected (a duplicate
 *     would double-apply / fight itself on refcounts);
 *   - `value` must be JSON-serializable data (it is persisted whole in the
 *     connector record and in the ownership ledger);
 *   - `reason` is REQUIRED (printed in the install diff and every skip-warn);
 *   - `docsUrl`, when present, must be a string.
 * The HOST-side sensitive-key denylist is deliberately NOT validated here —
 * it lives in (and is documented by) each supporting adapter.
 */
function validateConfigPatches(platforms: ConnectorConfig["platforms"]): void {
  if (platforms == null) return;
  for (const [platformId, override] of Object.entries(platforms)) {
    const patches = override?.configPatch;
    if (patches == null) continue;
    const where = `platforms.${platformId}.configPatch`;
    if (!Array.isArray(patches)) {
      throw new ConnectorConfigError(`${where} must be an array of patch objects`);
    }
    const seen = new Set<string>();
    patches.forEach((patch, i) => {
      if (patch == null || typeof patch !== "object" || Array.isArray(patch)) {
        throw new ConnectorConfigError(`${where}[${i}] must be an object`);
      }
      if (!isValidConfigPatchKey(patch.key)) {
        throw new ConnectorConfigError(
          `${where}[${i}].key must be a dotted LEAF path whose segments match ` +
            `${CONFIG_PATCH_SEGMENT_RE} (no dots-in-key, no array indices); ` +
            `got ${JSON.stringify(patch.key)}`,
        );
      }
      const violation = configPatchNamespaceViolation(patch.key);
      if (violation) {
        throw new ConnectorConfigError(`${where}[${i}].key ${violation}`);
      }
      if (seen.has(patch.key)) {
        throw new ConnectorConfigError(
          `${where}[${i}] duplicate key "${patch.key}"`,
        );
      }
      seen.add(patch.key);
      if (!isJsonValue(patch.value)) {
        throw new ConnectorConfigError(
          `${where}[${i}].value must be JSON-serializable data ` +
            `(string/finite number/boolean/null/array/plain object)`,
        );
      }
      if (typeof patch.reason !== "string" || patch.reason.trim() === "") {
        throw new ConnectorConfigError(
          `${where}[${i}].reason is required (a human-readable why, printed in ` +
            `the install diff and every skip-warn)`,
        );
      }
      if (patch.docsUrl !== undefined && typeof patch.docsUrl !== "string") {
        throw new ConnectorConfigError(`${where}[${i}].docsUrl must be a string`);
      }
    });
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

/** Default name for a single-entry memory declaration. */
const MEMORY_DEFAULT_NAME = "memory";

/**
 * Validate + normalize `memory` entries (the managed-block content surface).
 *   - `name` defaults to "memory", then must be kebab-case and unique — it is
 *     half of the block marker id (`<connectorId>/<name>`) and must stay stable;
 *   - `content` must be a non-empty string, ≤ 16 KiB (hard cap — memory files
 *     are injected into every prompt of every session on the host), and must
 *     NOT contain the literal marker tokens `agent-connector:begin` /
 *     `agent-connector:end` (they would corrupt marker scanning in the shared
 *     file — rephrase the guidance instead). The 4 KiB SOFT budget is reported
 *     at install time as a `warn` ChangeRecord, not a config error
 *     (defineConnector has no warning channel).
 */
function normalizeMemory(input: MemoryDef[] | undefined): MemoryDef[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new ConnectorConfigError("memory must be an array");
  }
  const seen = new Set<string>();
  return input.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConnectorConfigError(`memory[${i}] must be an object`);
    }
    const name =
      entry.name === undefined
        ? MEMORY_DEFAULT_NAME
        : assertSurfaceName("memory", entry.name, i);
    assertNoDuplicate("memory", seen, name, i);
    const content = assertNonEmptyString("memory", i, "content", entry.content);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MEMORY_CONTENT_HARD_CAP_BYTES) {
      throw new ConnectorConfigError(
        `memory[${i}].content exceeds the ${MEMORY_CONTENT_HARD_CAP_BYTES}-byte hard cap ` +
          `(got ${bytes} bytes); memory is inlined into every prompt of every targeted host — keep it terse`,
      );
    }
    for (const token of [MANAGED_BLOCK_BEGIN_TOKEN, MANAGED_BLOCK_END_TOKEN]) {
      if (content.includes(token)) {
        throw new ConnectorConfigError(
          `memory[${i}].content must not contain the literal marker token "${token}" ` +
            `(it would corrupt managed-block scanning in the shared memory file); rephrase the guidance`,
        );
      }
    }
    if (entry.description !== undefined && typeof entry.description !== "string") {
      throw new ConnectorConfigError(`memory[${i}].description must be a string`);
    }
    return { ...entry, name };
  });
}

/** Default name for the (singular) statusline declaration. */
const STATUSLINE_DEFAULT_NAME = "statusline";

/**
 * Validate + normalize the SINGULAR `statusline` (a HUD handler surface):
 *   - `render` MUST be a function (it is the renderer, re-imported at runtime
 *     like a hook handler);
 *   - `name` defaults to "statusline", then must be kebab-case (the shared
 *     surface-name validator);
 *   - `description`, when present, must be a string.
 * Returns undefined when no statusline is declared (it is optional and singular,
 * unlike the memory[] array).
 */
function normalizeStatusline(
  input: StatuslineDef | undefined,
): StatuslineDef | undefined {
  if (input == null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ConnectorConfigError("statusline must be an object");
  }
  if (typeof input.render !== "function") {
    throw new ConnectorConfigError("statusline.render must be a function");
  }
  const name =
    input.name === undefined
      ? STATUSLINE_DEFAULT_NAME
      : assertSurfaceName("statusline", input.name, 0);
  if (input.description !== undefined && typeof input.description !== "string") {
    throw new ConnectorConfigError("statusline.description must be a string");
  }
  // Per-host render override map: registered platform ids only, each render a
  // function (author-time hard error, mirroring the hook hosts-map validation).
  validateHostsMap(input.hosts, "statusline.hosts", "render");
  return { ...input, name };
}

/**
 * Typed identity helper for authoring a status line in its own module:
 *   export const myStatusline = defineStatusline({ render: (ctx) => "…" });
 * Mirrors the (informal) defineX helpers; gives the developer full type
 * inference on {@link StatuslineContext} without importing the type by hand.
 */
export const defineStatusline = (def: StatuslineDef): StatuslineDef => def;

// ─────────────────────────────────────────────────────────────────────────
// Typed identity helpers (the `define*` authoring family)
//
// Each is a one-line identity function: it returns its argument UNCHANGED and
// does NOT validate or mutate (validation still happens centrally in
// defineConnector). Their only job is ergonomics — authoring a surface in its
// own module with full type inference + autocomplete on the *Def shape, and a
// single import site — mirroring the existing {@link defineStatusline}.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Typed identity helper for authoring ONE normalized lifecycle hook in its own
 * module, EVENT-PARAMETERIZED so the handler's payload narrows to that event:
 *
 *   export const onPre = defineHook("PreToolUse", {
 *     handler(evt) { evt.toolName // ← typed as a PreToolUseEvent, not the union
 *       return { decision: "deny", reason: "no" };
 *     },
 *   });
 *
 * The leading `event` argument exists ONLY to infer `E`; the def is returned
 * unchanged (identity — validation still happens in defineConnector). Passing
 * `HookDefinition` without an event would widen the handler param to the full
 * {@link HookEventName} union and lose per-event narrowing, so the event tag is
 * required.
 */
export const defineHook = <E extends HookEventName>(
  event: E,
  def: HookDefinition<E>,
): HookDefinition<E> => {
  void event; // tag-only: used solely to infer E (the def carries no event field)
  return def;
};

/**
 * Typed identity helper for authoring a slash {@link CommandDef} in its own
 * module. Returns the def unchanged (kebab-case name + prompt are validated by
 * defineConnector when the connector is assembled).
 */
export const defineCommand = (def: CommandDef): CommandDef => def;

/**
 * Typed identity helper for authoring an Agent {@link SkillDef} in its own
 * module. Returns the def unchanged (name/description/body + safe resource keys
 * are validated by defineConnector).
 */
export const defineSkill = (def: SkillDef): SkillDef => def;

/**
 * Typed identity helper for authoring a {@link SubagentDef} in its own module.
 * Returns the def unchanged (name/description/prompt validated by defineConnector).
 */
export const defineSubagent = (def: SubagentDef): SubagentDef => def;

/**
 * Typed identity helper for authoring a {@link MemoryDef} (standing-guidance
 * managed block) in its own module. Returns the def unchanged (name/content +
 * byte budget + marker-token guard validated by defineConnector).
 */
export const defineMemory = (def: MemoryDef): MemoryDef => def;

/**
 * Typed identity helper for authoring a declarative {@link ConfigPatchDef}
 * (set-if-absent host-config key patch) in its own module. Returns the def
 * unchanged (leaf-path grammar + namespace guard + required reason validated by
 * defineConnector when it appears under `platforms[<id>].configPatch`).
 */
export const defineConfigPatch = (def: ConfigPatchDef): ConfigPatchDef => def;

/**
 * Typed identity helper for authoring a {@link NativeHookDef} (host-native
 * passthrough hook) in its own module. Returns the def unchanged (event-name
 * collision + handler-is-function validated by defineConnector when it appears
 * under `platforms[<id>].nativeHooks`).
 */
export const defineNativeHook = (def: NativeHookDef): NativeHookDef => def;

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
