/**
 * core/define-connector — the public write-once entry point.
 *
 * Validates a ConnectorConfig and normalizes it into a ResolvedConnector with
 * every optional field resolved to a default. Validation is intentionally
 * dependency-free (no zod) to keep the single-binary install lean.
 */

import { isAbsolute, normalize } from "node:path";

import type {
  ActionDef,
  CommandDef,
  ConfigPatchDef,
  ConnectorConfig,
  HookDefinition,
  HookEventName,
  HooksConfig,
  MemoryDef,
  NativeHookDef,
  OAuthFlow,
  OAuthTokenEndpointAuth,
  PlatformId,
  PlatformOverride,
  PublishConfig,
  ResolvedConnector,
  ResolvedOAuthLoginDef,
  ServerDef,
  SkillDef,
  StatuslineDef,
  StatuslineOptions,
  SubagentDef,
} from "./types.js";
import { REGISTERED_PLATFORM_IDS } from "../adapters/registry.js";
import { REGISTRY_NAMESPACE_RE } from "./mcp-standard.js";
import { CONNECTOR_ID_RE, isValidConnectorId } from "./ids.js";
import { SECRET_NAME_RE, SECRET_REF_RE, findSecretRefs, hasSecretRef, isValidSecretName, wholeSecretRefName } from "./secrets.js";
import { OAUTH_PRESET_IDS, POSTHOG_REGIONS, getOAuthPreset } from "./oauth/presets.js";
import { RESERVED_AUTHORIZATION_PARAMS } from "./oauth/reserved.js";
import {
  currentConnectorPackageMetadata,
  resolveMcpPackageIdentity,
} from "./package-metadata.js";
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

/** kebab-case name regex shared by command/skill/subagent names. */
const SURFACE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Max length of a skill description (Agent Skills open standard). */
const SKILL_DESCRIPTION_MAX = 1024;

// NOTE: canonical ordering — append new events at the END (hookEvents ordering
// is pinned by tests and feeds install-file ordering). Exported so the
// hook-dispatch gate + Claude-bundle event sets can be drift-tested against it.
export const ALL_EVENTS: HookEventName[] = [
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
  "PostCompact",
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

  const packageMetadata = currentConnectorPackageMetadata();
  const packageIdentity = packageMetadata?.mcp;
  if (packageIdentity && Object.keys(packageIdentity).length > 0) {
    config = {
      ...config,
      mcp: {
        ...packageIdentity,
        ...config.mcp,
      },
    };
  }

  const mcpIdentity = resolveMcpPackageIdentity(config);
  const connectorId = config.id ?? mcpIdentity.hostAlias;
  if (!isValidConnectorId(connectorId)) {
    throw new ConnectorConfigError(
      `id must be kebab-case matching ${CONNECTOR_ID_RE} or derivable from mcp/package metadata (got ${JSON.stringify(config.id)})`,
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
  // Actions (each a user-invokable run handler) are a legitimate sole payload —
  // a connector whose whole job is shipping dispatchable actions.
  const hasActions = Array.isArray(config.actions) && config.actions.length > 0;
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
    !hasActions &&
    !hasNativeHooks &&
    !hasConfigPatch
  ) {
    throw new ConnectorConfigError(
      "a connector must declare at least one of `server`, `hooks`, `commands`, `skills`, `subagents`, `memory`, `statusline`, `actions`, " +
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
    validateSecretRefPlacement(s, "server");
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
  const actions = normalizeActions(config.actions);

  const t = config.telemetry ?? {};
  const server = normalizeServer(config.server);

  const resolved: ResolvedConnector = {
    id: connectorId,
    ...(Object.keys(mcpIdentity).length > 0 ? { mcp: mcpIdentity } : {}),
    displayName: config.displayName ?? connectorId,
    version: config.version ?? packageMetadata?.version ?? "0.0.0",
    ...(server ? { server } : {}),
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
    actions,
    platforms: normalizePlatformServers(config.platforms, server),
    targets: config.targets ?? "auto",
    ...(config.publish ? { publish: normalizePublish(config.publish) } : {}),
    oauth: normalizeOAuth(config.oauth),
  };

  return resolved;
}

/** The 13 normalized event names, for the nativeHooks collision check. */
const NORMALIZED_EVENT_SET: ReadonlySet<string> = new Set(ALL_EVENTS);

/**
 * Validate a per-host override map (`hosts?:`) declared on a hook definition or
 * on the statusline. Shared by the hook-validation loop and normalizeStatusline:
 *   - the value must be a plain object keyed by platform id;
 *   - every key MUST be a REGISTERED platform id (REGISTERED_PLATFORM_IDS) —
 *     an unknown id is an author-time ConnectorConfigError (NOT a skip-warn:
 *     a typo'd host would otherwise silently never fire);
 *   - every entry's implementation field (`handler` for hooks, `render` for
 *     statusline, `run` for actions) MUST be a function (it is re-imported from
 *     the connector module at runtime, like the top-level handler/render/run).
 * `undefined` (no map) is valid and skipped.
 */
function validateHostsMap(
  map: unknown,
  surfaceLabel: string,
  implField: "handler" | "render" | "run",
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

function validateStatuslineOptions(
  options: unknown,
  surfaceLabel: string,
): void {
  if (options === undefined) return;
  if (options == null || typeof options !== "object" || Array.isArray(options)) {
    throw new ConnectorConfigError(`${surfaceLabel} must be an object`);
  }
  const o = options as StatuslineOptions;
  if (
    o.refreshInterval !== undefined &&
    (!Number.isInteger(o.refreshInterval) || o.refreshInterval < 1)
  ) {
    throw new ConnectorConfigError(`${surfaceLabel}.refreshInterval must be an integer >= 1`);
  }
  if (
    o.maxLines !== undefined &&
    (!Number.isInteger(o.maxLines) || o.maxLines < 1)
  ) {
    throw new ConnectorConfigError(`${surfaceLabel}.maxLines must be an integer >= 1`);
  }
  if (
    o.respectUserColors !== undefined &&
    typeof o.respectUserColors !== "boolean"
  ) {
    throw new ConnectorConfigError(`${surfaceLabel}.respectUserColors must be a boolean`);
  }
  if (
    o.hideContextIndicator !== undefined &&
    typeof o.hideContextIndicator !== "boolean"
  ) {
    throw new ConnectorConfigError(`${surfaceLabel}.hideContextIndicator must be a boolean`);
  }
}

function validateStatuslineHosts(map: unknown, surfaceLabel: string): void {
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
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConnectorConfigError(`${surfaceLabel}.${platformId} must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (e.render !== undefined && typeof e.render !== "function") {
      throw new ConnectorConfigError(`${surfaceLabel}.${platformId}.render must be a function`);
    }
    validateStatuslineOptions(e.options, `${surfaceLabel}.${platformId}.options`);
    if (e.render === undefined && e.options === undefined) {
      throw new ConnectorConfigError(
        `${surfaceLabel}.${platformId} must declare render or options`,
      );
    }
  }
}

function validateOptionalString(value: unknown, surfaceLabel: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new ConnectorConfigError(`${surfaceLabel} must be a string`);
  }
}

function validateActionPlacement(value: unknown, surfaceLabel: string): void {
  if (value === undefined) return;
  if (typeof value === "string") return;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return;
  throw new ConnectorConfigError(`${surfaceLabel} must be a string or string[]`);
}

function validateActionConfirm(value: unknown, surfaceLabel: string): void {
  if (value === undefined || typeof value === "boolean") return;
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorConfigError(`${surfaceLabel} must be a boolean or object`);
  }
  const c = value as Record<string, unknown>;
  validateOptionalString(c.title, `${surfaceLabel}.title`);
  validateOptionalString(c.message, `${surfaceLabel}.message`);
}

function validateActionMetadata(def: Record<string, unknown>, surfaceLabel: string): void {
  validateOptionalString(def.label, `${surfaceLabel}.label`);
  validateOptionalString(def.description, `${surfaceLabel}.description`);
  validateOptionalString(def.icon, `${surfaceLabel}.icon`);
  validateActionPlacement(def.placement, `${surfaceLabel}.placement`);
  validateActionConfirm(def.confirm, `${surfaceLabel}.confirm`);
}

function validateActionHosts(map: unknown, surfaceLabel: string): void {
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
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConnectorConfigError(`${surfaceLabel}.${platformId} must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (e.run !== undefined && typeof e.run !== "function") {
      throw new ConnectorConfigError(`${surfaceLabel}.${platformId}.run must be a function`);
    }
    validateActionMetadata(e, `${surfaceLabel}.${platformId}`);
    if (
      e.run === undefined &&
      e.label === undefined &&
      e.description === undefined &&
      e.icon === undefined &&
      e.placement === undefined &&
      e.confirm === undefined
    ) {
      throw new ConnectorConfigError(
        `${surfaceLabel}.${platformId} must declare run or metadata`,
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

/** Login keys (`oauth.<key>`): kebab-case, 1..32 chars. */
const OAUTH_KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const OAUTH_FLOWS: readonly OAuthFlow[] = ["auto", "loopback", "device"];
const OAUTH_TOKEN_ENDPOINT_AUTHS: readonly OAuthTokenEndpointAuth[] = [
  "client_secret_post",
  "client_secret_basic",
  "none",
];
/** Login fields that hold a URL; https only, except http on 127.0.0.1 / localhost (a loopback provider in tests). */
const OAUTH_URL_FIELDS = [
  "issuer",
  "authorizationEndpoint",
  "tokenEndpoint",
  "deviceAuthorizationEndpoint",
  "revocationEndpoint",
  "tokenExchangeUrl",
] as const;
function isOAuthEndpointUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  // `new URL()` strips CR / LF silently: a control character is refused first.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // Userinfo and a fragment have no place in an OAuth endpoint (RFC 6749 §3.2).
  if (url.username !== "" || url.password !== "" || url.hash !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

/**
 * Validate the `oauth.<key>` logins and apply the three defaults (flow
 * "auto", redirectPath "/callback", storeAs `oauth.<key>.refresh-token`).
 * Nothing is resolved against a preset or the network here — presets are
 * applied by the login engine — so a config stays valid offline. Returns {}
 * for a config without `oauth`.
 */
function normalizeOAuth(input: ConnectorConfig["oauth"]): Record<string, ResolvedOAuthLoginDef> {
  if (input === undefined) return {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ConnectorConfigError("oauth must be an object keyed by login key");
  }
  const out: Record<string, ResolvedOAuthLoginDef> = {};
  for (const [key, def] of Object.entries(input)) {
    if (!OAUTH_KEY_RE.test(key)) {
      throw new ConnectorConfigError(
        `oauth: "${key}" is not a valid login key (expected ${OAUTH_KEY_RE.source})`,
      );
    }
    const where = `oauth.${key}`;
    if (def === null || typeof def !== "object" || Array.isArray(def)) {
      throw new ConnectorConfigError(`${where} must be an object`);
    }
    if (!(OAUTH_PRESET_IDS as readonly string[]).includes(def.provider)) {
      throw new ConnectorConfigError(
        `${where}.provider: "${String(def.provider)}" is not a known OAuth preset (${OAUTH_PRESET_IDS.join(", ")})`,
      );
    }
    // A client id is a literal, `${env:VAR}`, or — when each user registers
    // their own app — exactly one `${secret:NAME}` reference; a reference mixed
    // into other text has no reader (the engine resolves whole-value references only).
    if (
      typeof def.clientId !== "string" ||
      def.clientId.trim() === "" ||
      (def.clientId.includes("${secret:") && wholeSecretRefName(def.clientId) === null)
    ) {
      throw new ConnectorConfigError(
        `${where}.clientId: must be a non-empty string — a literal, \${env:VAR}, or exactly one \${secret:NAME} reference`,
      );
    }
    if (def.clientSecret !== undefined) {
      const isRef = typeof def.clientSecret === "string" && wholeSecretRefName(def.clientSecret) !== null;
      if (getOAuthPreset(def.provider).clientSecretPublic) {
        // The provider documents the secret as not confidential: a literal is
        // stored verbatim (no `${env:}` expansion, ever), so any other `${…}`
        // form is a mistake, not a value.
        if (
          typeof def.clientSecret !== "string" ||
          def.clientSecret.trim() === "" ||
          (def.clientSecret.includes("${") && !isRef)
        ) {
          throw new ConnectorConfigError(
            `${where}.clientSecret: must be a \${secret:NAME} reference or a non-empty literal ` +
              `(provider "${def.provider}" documents an installed app's client secret as not confidential)`,
          );
        }
      } else if (!isRef) {
        throw new ConnectorConfigError(
          `${where}.clientSecret: must be a \${secret:NAME} reference (a literal secret is never written into a connector config)`,
        );
      }
    }
    if (
      !Array.isArray(def.scopes) ||
      def.scopes.length === 0 ||
      def.scopes.some((scope) => typeof scope !== "string" || scope.trim() === "")
    ) {
      throw new ConnectorConfigError(`${where}.scopes: at least one scope string is required`);
    }
    if (def.flow !== undefined && !OAUTH_FLOWS.includes(def.flow)) {
      throw new ConnectorConfigError(`${where}.flow: expected ${OAUTH_FLOWS.join(" | ")}`);
    }
    if (def.tokenEndpointAuth !== undefined && !OAUTH_TOKEN_ENDPOINT_AUTHS.includes(def.tokenEndpointAuth)) {
      throw new ConnectorConfigError(
        `${where}.tokenEndpointAuth: expected ${OAUTH_TOKEN_ENDPOINT_AUTHS.join(" | ")}`,
      );
    }
    if (
      def.redirectPort !== undefined &&
      (!Number.isInteger(def.redirectPort) || def.redirectPort < 1024 || def.redirectPort > 65535)
    ) {
      throw new ConnectorConfigError(`${where}.redirectPort: expected an integer in 1024..65535`);
    }
    if (def.redirectPath !== undefined && (typeof def.redirectPath !== "string" || !def.redirectPath.startsWith("/"))) {
      throw new ConnectorConfigError(`${where}.redirectPath: must start with "/"`);
    }
    if (def.provider === "generic" && !def.issuer && !(def.authorizationEndpoint && def.tokenEndpoint)) {
      throw new ConnectorConfigError(
        `${where}: provider "generic" needs issuer, or authorizationEndpoint and tokenEndpoint`,
      );
    }
    for (const field of OAUTH_URL_FIELDS) {
      if (def[field] !== undefined && !isOAuthEndpointUrl(def[field])) {
        throw new ConnectorConfigError(`${where}.${field}: must be an https URL`);
      }
    }
    // The exchange service holds the client secret; a login names one or the other.
    if (def.clientSecret !== undefined && def.tokenExchangeUrl !== undefined) {
      throw new ConnectorConfigError(
        `${where}: clientSecret and tokenExchangeUrl are exclusive — the token exchange service holds the client secret`,
      );
    }
    if (def.storeAs !== undefined && (typeof def.storeAs !== "string" || !isValidSecretName(def.storeAs))) {
      throw new ConnectorConfigError(`${where}.storeAs: "${String(def.storeAs)}" is not a valid secret name`);
    }
    if (def.pkce !== undefined && typeof def.pkce !== "boolean") {
      throw new ConnectorConfigError(`${where}.pkce: must be a boolean`);
    }
    if (def.extraAuthorizationParams !== undefined && !isStringRecord(def.extraAuthorizationParams)) {
      throw new ConnectorConfigError(`${where}.extraAuthorizationParams: must be an object of string values`);
    }
    if (getOAuthPreset(def.provider).echoesState === false && def.redirectPort === undefined) {
      throw new ConnectorConfigError(
        `${where}.redirectPort: required for provider "${def.provider}" (redirect URIs are matched exactly and the authorization response carries no state)`,
      );
    }
    for (const name of Object.keys(def.extraAuthorizationParams ?? {})) {
      if (RESERVED_AUTHORIZATION_PARAMS.has(name)) {
        throw new ConnectorConfigError(
          `${where}.extraAuthorizationParams: "${name}" is set by the login flow and cannot be overridden`,
        );
      }
    }
    if (def.options !== undefined && !isStringRecord(def.options)) {
      throw new ConnectorConfigError(`${where}.options: must be an object of string values`);
    }
    if (
      def.provider === "posthog" &&
      def.options?.region !== undefined &&
      !(POSTHOG_REGIONS as readonly string[]).includes(def.options.region)
    ) {
      throw new ConnectorConfigError(`${where}.options.region: expected ${POSTHOG_REGIONS.join(" | ")}`);
    }
    if (def.provider === "microsoft" && def.options?.tenant !== undefined && def.options.tenant.trim() === "") {
      throw new ConnectorConfigError(`${where}.options.tenant: must be a non-empty string`);
    }
    out[key] = {
      ...def,
      key,
      flow: def.flow ?? "auto",
      redirectPath: def.redirectPath ?? "/callback",
      storeAs: def.storeAs ?? `oauth.${key}.refresh-token`,
    };
  }
  return out;
}

/** Validate a surface name (kebab-case) or throw a ConnectorConfigError. */
function assertSurfaceName(
  surface: string,
  name: unknown,
  index: number,
  field = "name",
): string {
  if (typeof name !== "string" || !SURFACE_NAME_RE.test(name)) {
    throw new ConnectorConfigError(
      `${surface}[${index}].${field} must be kebab-case matching ${SURFACE_NAME_RE} (got ${JSON.stringify(name)})`,
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
  field = "name",
): void {
  if (seen.has(name)) {
    throw new ConnectorConfigError(`${surface}[${index}] duplicate ${field} "${name}"`);
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
  validateStatuslineOptions(input.options, "statusline.options");
  // Per-host override map: registered platform ids only. A host entry may
  // override render, options, or both; top-level render remains mandatory.
  validateStatuslineHosts(input.hosts, "statusline.hosts");
  return { ...input, name };
}

/**
 * Validate + normalize `actions` (the user-invokable action handler surface):
 *   - the value must be an array;
 *   - each entry's `id` must be kebab-case (the shared surface-name validator)
 *     and UNIQUE within the connector (ConnectorConfigError on dup — the id is
 *     the verb's positional arg, so a duplicate would be ambiguous);
 *   - `run` MUST be a function (it is the handler, re-imported at runtime like a
 *     hook handler / statusline render);
 *   - `description`, when present, must be a string;
 *   - the per-host `hosts:` override map is validated via the shared
 *     validateHostsMap (registered platform ids only, each `run` a function).
 * Returns [] when no actions are declared (defaults applied, like the other
 * array surfaces).
 */
function normalizeActions(input: ActionDef[] | undefined): ActionDef[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new ConnectorConfigError("actions must be an array");
  }
  const seen = new Set<string>();
  return input.map((action, i) => {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new ConnectorConfigError(`actions[${i}] must be an object`);
    }
    const id = assertSurfaceName("actions", action.id, i, "id");
    assertNoDuplicate("actions", seen, id, i, "id");
    if (typeof action.run !== "function") {
      throw new ConnectorConfigError(`actions[${i}].run must be a function`);
    }
    validateActionMetadata(action as unknown as Record<string, unknown>, `actions[${i}]`);
    // Per-host override map: registered platform ids only. A host entry may
    // override run, metadata, or both; top-level run remains mandatory.
    validateActionHosts(action.hosts, `actions.${id}.hosts`);
    return { ...action, id };
  });
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
 * Typed identity helper for authoring a user-invokable {@link ActionDef} in its
 * own module. Returns the def unchanged (kebab-case unique id + run-is-function
 * + the per-host hosts map validated by defineConnector when the connector is
 * assembled).
 */
export const defineAction = (def: ActionDef): ActionDef => def;

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
  const split = splitSecretEnv(server.env, "server.env");
  // Only when secrets were split out does `env` change shape (dropped when
  // every entry was a secret); a ref-free server is spread verbatim so its
  // rendered output stays byte-identical.
  const base = split.secretEnv ? withoutEnv(server) : server;
  return {
    ...base,
    ...split,
    enabled: server.enabled ?? true,
    tools: server.tools ?? { include: ["*"] },
    wrapForTelemetry: server.wrapForTelemetry ?? wrapDefault,
  };
}

function withoutEnv<T extends { env?: unknown }>(server: T): Omit<T, "env"> {
  const { env: _dropped, ...rest } = server;
  void _dropped;
  return rest;
}

const SECRET_REF_PLACEMENT_ERROR =
  "secret refs (${secret:NAME}) are supported only in server.env of a stdio server";

/**
 * `${secret:NAME}` may appear ONLY in the env values of a stdio server: the
 * serve wrapper injects those into the real server's environment. Anywhere
 * else (command/args/url/headers, or a remote server's env) there is no
 * delivery path that keeps the value out of the host config file.
 */
function validateSecretRefPlacement(
  server: Partial<ServerDef>,
  where: string,
  transport: ServerDef["transport"] | undefined = server.transport,
): void {
  // Every field but `env` reaches a host config or the spawn line verbatim.
  const elsewhere = findSecretRefs(
    Object.fromEntries(Object.entries(server).filter(([key]) => key !== "env" && key !== "secretEnv")),
  );
  if (elsewhere.length > 0) {
    throw new ConnectorConfigError(`${where}: ${SECRET_REF_PLACEMENT_ERROR} (found ${elsewhere.join(", ")})`);
  }
  if (transport !== undefined && transport !== "stdio") {
    const inEnv = findSecretRefs(server.env);
    if (inEnv.length > 0) {
      throw new ConnectorConfigError(
        `${where}: ${SECRET_REF_PLACEMENT_ERROR} (transport "${transport}" — found ${inEnv.join(", ")})`,
      );
    }
  }
}

/**
 * Split `env` into the entries adapters may write into host config (`env`)
 * and the secret-bearing ones the serve wrapper delivers (`secretEnv`,
 * values kept verbatim). An input without any secret ref is returned
 * untouched so existing rendered output is byte-identical.
 */
function splitSecretEnv(
  env: Record<string, string> | undefined,
  where: string,
): { env?: Record<string, string>; secretEnv?: Record<string, string> } {
  if (!env) return {};
  const plain: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && hasSecretRef(value)) {
      // The wrapper carries `{secret:NAME}` placeholders in host config; a
      // literal "{secret:" in the same value would be indistinguishable.
      if (/\{secret:/.test(value.replace(new RegExp(SECRET_REF_RE.source, "g"), ""))) {
        throw new ConnectorConfigError(
          `${where}.${key}: a value that references \${secret:NAME} must not also contain the literal text "{secret:"`,
        );
      }
      // The entry travels as `--secret-env KEY=template`: the key must be an
      // environment-variable name, and every referenced name must be one the
      // store accepts (a longer name could never be set).
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new ConnectorConfigError(
          `${where}.${key}: an env entry that references \${secret:NAME} must have an environment-variable name ([A-Za-z_][A-Za-z0-9_]*)`,
        );
      }
      for (const name of findSecretRefs(value)) {
        if (!isValidSecretName(name)) {
          throw new ConnectorConfigError(
            `${where}.${key}: "${name}" is not a valid secret name (expected ${SECRET_NAME_RE.source})`,
          );
        }
      }
      secret[key] = value;
    } else {
      plain[key] = value;
    }
  }
  if (Object.keys(secret).length === 0) return { env };
  return {
    ...(Object.keys(plain).length > 0 ? { env: plain } : {}),
    secretEnv: secret,
  };
}

/**
 * Per-platform `server` overrides get the SAME secret handling as the base
 * server (placement validation + env/secretEnv split), so an override can
 * never leak a `${secret:NAME}` into a host config file. Placement is judged
 * by the effective transport (the override's, else the base server's), and an
 * override `env` replaces the base `env` together with its secrets — the
 * same shallow `{ ...base, ...override }` merge every adapter applies.
 * Everything else in `platforms` is kept verbatim (live nativeHooks handlers
 * must survive).
 */
function normalizePlatformServers(
  platforms: ConnectorConfig["platforms"],
  base: ResolvedConnector["server"],
): ResolvedConnector["platforms"] {
  if (platforms == null) return {};
  const out: ResolvedConnector["platforms"] = {};
  for (const [platformId, override] of Object.entries(platforms) as [PlatformId, PlatformOverride][]) {
    if (!override || typeof override !== "object" || !override.server) {
      out[platformId] = override;
      continue;
    }
    const where = `platforms.${String(platformId)}.server`;
    validateSecretRefPlacement(override.server, where, override.server.transport ?? base?.transport);
    const split = splitSecretEnv(override.server.env, `${where}.env`);
    if (!split.secretEnv) {
      const baseHasSecrets = base?.secretEnv !== undefined && Object.keys(base.secretEnv).length > 0;
      out[platformId] =
        override.server.env !== undefined && baseHasSecrets
          ? { ...override, server: { ...override.server, secretEnv: {} } }
          : override;
      continue;
    }
    out[platformId] = { ...override, server: { ...withoutEnv(override.server), ...split } };
  }
  return out;
}
