/**
 * core/oauth/metadata — the NON-secret record of a connector's logins:
 * `<dataRoot>/oauth/<connectorId>.json`. It names the provider, the scope,
 * when and how the login happened and which secret holds the refresh token;
 * it never holds a token. Written 0600 in a 0700 directory, atomically.
 */

import { join } from "node:path";

import { isValidConnectorId } from "../ids.js";
import { readJsonFile, writePrivateJson } from "../secrets.js";
import type { SecretBackendId } from "../secrets.js";
import type { OAuthPresetId } from "../types.js";
import { OAuthError } from "./errors.js";

export interface LoginRecord {
  provider: OAuthPresetId;
  scope?: string;
  /** ISO timestamp of the login. */
  obtainedAt: string;
  obtainedVia: "loopback" | "device";
  /** ms since the epoch when the access token issued at login expired. */
  expiresAt?: number;
  /** Set when the provider rejected the refresh token (`invalid_grant`); the secret is gone. */
  revokedAt?: string;
  /** Secret name holding the refresh token. */
  storeAs: string;
  backend: SecretBackendId;
}

export interface OAuthMetadataFile {
  version: 1;
  connectorId: string;
  logins: Record<string, LoginRecord>;
}

/** The shape defineConnector accepts for a login key. */
const LOGIN_KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function metadataPath(dataRoot: string, connectorId: string): string {
  if (!isValidConnectorId(connectorId)) {
    throw new OAuthError("config", `"${String(connectorId)}" is not a valid connector id`);
  }
  return join(dataRoot, "oauth", `${connectorId}.json`);
}

/** The file's logins, `{}` when the file is absent; OAuthError("config") when it is damaged. */
export function readMetadata(dataRoot: string, connectorId: string): OAuthMetadataFile {
  const path = metadataPath(dataRoot, connectorId);
  let raw: Partial<OAuthMetadataFile> | null;
  try {
    raw = readJsonFile<Partial<OAuthMetadataFile>>(path);
  } catch (err) {
    throw new OAuthError("config", err instanceof Error ? err.message : String(err));
  }
  // Only well-formed login keys are copied (JSON.parse makes "__proto__" an
  // own property; assigning it here would re-parent the map instead).
  const logins: Record<string, LoginRecord> = {};
  for (const [key, rec] of Object.entries(raw?.logins ?? {})) {
    if (!LOGIN_KEY_RE.test(key)) continue;
    if (rec && typeof rec === "object" && typeof (rec as LoginRecord).storeAs === "string") {
      logins[key] = rec as LoginRecord;
    }
  }
  return { version: 1, connectorId, logins };
}

/** Replace (`record`) or remove (`null`) one login's record. */
export function updateLoginRecord(
  dataRoot: string,
  connectorId: string,
  key: string,
  record: LoginRecord | null,
): void {
  let file: OAuthMetadataFile;
  try {
    file = readMetadata(dataRoot, connectorId);
  } catch {
    // A damaged record file is replaced: it holds no secret, and the login
    // that is being recorded must not be reported as failed because of it.
    file = { version: 1, connectorId, logins: {} };
  }
  if (record === null) delete file.logins[key];
  else file.logins[key] = record;
  writePrivateJson(metadataPath(dataRoot, connectorId), file);
}
