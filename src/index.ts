/**
 * agent-connector — public API surface.
 *
 * Write your MCP server + hooks once:
 *
 *   import { defineConnector } from "@ken-jo/agent-connector";
 *   export default defineConnector({ server: {...}, hooks: {...} });
 *
 * Then `npx @acme/acme-db-mcp install` deploys it across every detected platform
 * and collects platform-independent per-tool token telemetry.
 */

export {
  defineConnector,
  defineStatusline,
  defineAction,
  defineHook,
  defineCommand,
  defineSkill,
  defineSubagent,
  defineMemory,
  defineConfigPatch,
  defineNativeHook,
  ConnectorConfigError,
} from "./core/define-connector.js";

export {
  deriveHostAliasFromPackageName,
  deriveHostAliasFromMcpName,
  inferNpmPackageFromServer,
  resolveMcpPackageIdentity,
} from "./core/package-metadata.js";

export type {
  ConnectorConfig,
  ResolvedConnector,
  McpPackageIdentity,
  ResolvedMcpPackageIdentity,
  ServerDef,
  Transport,
  ToolFilter,
  AuthSpec,
  HooksConfig,
  HookDefinition,
  HookEventName,
  HookResponse,
  NativeHookDef,
  NativeHookEvent,
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
  TelemetryConfig,
  MemoryDef,
  StatuslineDef,
  StatuslineContext,
  ActionDef,
  ActionResult,
  HostCtx,
  TelemetryAccessor,
  TelemetryUsageSummary,
  PlatformMemoryOverride,
  PlatformId,
  PlatformOverride,
  PlatformCapabilities,
  HookParadigm,
  InstallScope,
  DetectedPlatform,
  InstallResult,
  ChangeRecord,
  DiagnosticResult,
} from "./core/types.js";
