/**
 * core/define-connector — the public write-once entry point.
 *
 * Validates a ConnectorConfig and normalizes it into a ResolvedConnector with
 * every optional field resolved to a default. Validation is intentionally
 * dependency-free (no zod) to keep the single-binary install lean.
 */

import type {
  ConnectorConfig,
  HookEventName,
  HooksConfig,
  ResolvedConnector,
} from "./types.js";

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const ALL_EVENTS: HookEventName[] = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "Stop",
  "Notification",
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
  if (!config.server && !config.hooks) {
    throw new ConnectorConfigError(
      "a connector must declare at least one of `server` or `hooks`",
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
      store: t.store ?? "ndjson",
      calibration: {
        anthropicCountTokens: t.calibration?.anthropicCountTokens ?? false,
      },
    },
    platforms: config.platforms ?? {},
    targets: config.targets ?? "auto",
  };

  return resolved;
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
