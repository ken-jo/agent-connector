/**
 * agent-connector/sdk — the consolidated developer authoring surface.
 *
 * Everything a connector AUTHOR needs in one import: the `defineConnector`
 * entry point, the full `define*` typed-identity family (author each surface in
 * its own module with full inference), the host-capability introspection
 * helpers, and the public types. It re-exports from the existing modules — the
 * root `@ken-jo/agent-connector` export (src/index.ts) is unchanged for backward
 * compatibility; `/sdk` is the superset a new connector reaches for.
 *
 * The offline behavioral harness (`explain` / `simulate`) lives in the sibling
 * `@ken-jo/agent-connector/sdk/test` subpath so test-only tooling stays out of
 * the authoring import.
 */

export {
  defineConnector,
  ConnectorConfigError,
  defineStatusline,
  defineAction,
  defineHook,
  defineCommand,
  defineSkill,
  defineSubagent,
  defineMemory,
  defineConfigPatch,
  defineNativeHook,
} from "../core/define-connector.js";

export {
  SURFACE_PREDICATES,
  capabilitiesOf,
  hostsSupporting,
  surfaceSupport,
} from "./introspect.js";

export type { SurfaceName } from "./introspect.js";

export { toolName, style } from "./helpers.js";

// Secrets — `${secret:NAME}` values live in the OS keystore. Server code
// normally just reads the env var the serve wrapper injected; a connector
// can also read/write its own store directly.
export {
  openSecretStore,
  findSecretRefs,
  resolveSecretBackendId,
  SECRET_BACKEND_IDS,
  SecretError,
  SecretResolutionError,
} from "../core/secrets.js";

export type {
  SecretStore,
  SecretEntry,
  SecretListEntry,
  SecretBackendId,
  BackendAvailability,
} from "../core/secrets.js";

// OAuth logins — `oauth.<key>` providers the user authorizes once (`auth login`).
// A server calls `getAccessToken` for a fresh access token; with no stored
// login it opens the browser itself when it can, else fails closed with the
// exact `auth login` command.
export {
  getAccessToken,
  login,
  logout,
  loginStatus,
  canOpenBrowser,
  OAUTH_PRESET_IDS,
  getOAuthPreset,
  discoverEndpoints,
  OAuthError,
  OAuthLoginRequiredError,
} from "../core/oauth/index.js";

export type {
  OAuthPreset,
  TokenSet,
  LoginResult,
  LoginStatus,
  AccessTokenOptions,
} from "../core/oauth/index.js";

export type {
  OAuthLoginDef,
  ResolvedOAuthLoginDef,
  OAuthPresetId,
} from "../core/types.js";

export type {
  ConnectorConfig,
  ResolvedConnector,
  ServerDef,
  Transport,
  ToolFilter,
  AuthSpec,
  HooksConfig,
  HookDefinition,
  HookEventName,
  HookResponse,
  CommandDef,
  SkillDef,
  SubagentDef,
  MemoryDef,
  StatuslineDef,
  StatuslineContext,
  ActionDef,
  ActionResult,
  HostCtx,
  TelemetryAccessor,
  TelemetryUsageSummary,
  ConfigPatchDef,
  NativeHookDef,
  NativeHookEvent,
  JsonValue,
  SurfaceToolPolicy,
  TelemetryConfig,
  PublishConfig,
  EventPayloadMap,
  PreToolUseEvent,
  PostToolUseEvent,
  SessionStartEvent,
  SessionEndEvent,
  UserPromptSubmitEvent,
  PreCompactEvent,
  StopEvent,
  NotificationEvent,
  PermissionRequestEvent,
  PostToolUseFailureEvent,
  SubagentStartEvent,
  SubagentStopEvent,
  PlatformId,
  PlatformOverride,
  PlatformMemoryOverride,
  PlatformCapabilities,
  HookParadigm,
  InstallScope,
} from "../core/types.js";
