/**
 * agent-connector — public API surface.
 *
 * Write your MCP server + hooks once:
 *
 *   import { defineConnector } from "agent-connector";
 *   export default defineConnector({ id: "acme-db", server: {...}, hooks: {...} });
 *
 * Then `agent-connector install` deploys it across every detected platform and
 * collects platform-independent per-tool token telemetry.
 */

export { defineConnector, ConnectorConfigError } from "./core/define-connector.js";

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
  EventPayloadMap,
  PreToolUseEvent,
  PostToolUseEvent,
  SessionStartEvent,
  SessionEndEvent,
  UserPromptSubmitEvent,
  PreCompactEvent,
  StopEvent,
  NotificationEvent,
  TelemetryConfig,
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
