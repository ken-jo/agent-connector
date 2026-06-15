/**
 * agent-connector — public API surface.
 *
 * Write your MCP server + hooks once:
 *
 *   import { defineConnector } from "@ken-jo/agent-connector";
 *   export default defineConnector({ id: "acme-db", server: {...}, hooks: {...} });
 *
 * Then `agent-connector install` deploys it across every detected platform and
 * collects platform-independent per-tool token telemetry.
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
