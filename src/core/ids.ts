/** Shared connector-id grammar for author-time configs and runtime ids. */
export const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidConnectorId(id: unknown): id is string {
  return typeof id === "string" && CONNECTOR_ID_RE.test(id);
}

export function assertConnectorId(id: unknown, label = "connector id"): string {
  if (isValidConnectorId(id)) return id;
  throw new Error(
    `${label} must be kebab-case matching ${CONNECTOR_ID_RE} (got ${JSON.stringify(id)})`,
  );
}
