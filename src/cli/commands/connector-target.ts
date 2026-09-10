/**
 * cli/commands/connector-target — which connector a connector-scoped command
 * (`secrets`, `auth`) acts on.
 *
 * Resolution order (first hit wins): --connector-id, --connector <path>,
 * agent-connector.config.* in --project / cwd, the single registered
 * connector; otherwise an error asking for --connector-id. An explicitly
 * named connector that fails to load is an error the caller must surface
 * (`explicit: true`); a failed implicit discovery falls through to the registry.
 */

import type { ResolvedConnector } from "../../core/types.js";
import {
  findConnectorConfig,
  listRegisteredConnectors,
  loadConnectorFromPath,
} from "../../core/load-connector.js";

export type ConnectorChoice =
  | {
      id: string;
      /**
       * The loaded definition when the connector came from a module path
       * (`--connector`, or the config found in the project); absent when only
       * the id is known (`--connector-id`, the registry).
       */
      connector?: ResolvedConnector;
    }
  | {
      error: string;
      /** True when the user named a connector that failed to load (never fall back). */
      explicit: boolean;
    };

export async function resolveConnectorId(
  connectorId: string | undefined,
  connectorPath: string | undefined,
  projectDir: string,
): Promise<ConnectorChoice> {
  if (connectorId !== undefined) return { id: connectorId };

  if (connectorPath !== undefined) {
    try {
      const { connector } = await loadConnectorFromPath(connectorPath);
      return { id: connector.id, connector };
    } catch (err) {
      return {
        error: `cannot load connector "${connectorPath}": ${err instanceof Error ? err.message : String(err)}`,
        explicit: true,
      };
    }
  }

  const configPath = findConnectorConfig(projectDir);
  if (configPath) {
    try {
      const { connector } = await loadConnectorFromPath(configPath);
      return { id: connector.id, connector };
    } catch {
      /* implicit discovery is a convenience — fall through to the registry */
    }
  }

  const registered = listRegisteredConnectors();
  const only = registered[0];
  if (registered.length === 1 && only) return { id: only.id };
  if (registered.length > 1) {
    return {
      error:
        `${registered.length} connectors are registered (${registered.map((c) => c.id).join(", ")}) — ` +
        "pass --connector-id <id> (or --connector <path>)",
      explicit: false,
    };
  }
  return {
    error:
      "no connector found — pass --connector-id <id> or --connector <path>, " +
      "or run inside a project with an agent-connector.config.* file",
    explicit: false,
  };
}
