/**
 * tests/support/oauth-fixtures — helpers the OAuth test files share: the
 * strings a mock provider mints that must never surface in a log, a message
 * or a file the tests inspect; the mock's token-endpoint requests; a
 * user-registered login (both credentials are keystore references).
 */

import { expect } from "vitest";

import type { ResolvedOAuthLoginDef } from "../../src/core/types.js";
import type { MockOAuthRequest, MockOAuthServer } from "./mock-oauth-server.js";

/** Prefixes of every token, code and secret the mock provider and a relay handle. */
export const LEAK_MARKERS = ["mock-access-", "mock-refresh-", "mock-code-", "mock-device-", "mock-client-secret"] as const;

/** Fails when `text` carries any of {@link LEAK_MARKERS}. */
export function expectNoLeak(text: string): void {
  for (const marker of LEAK_MARKERS) expect(text).not.toContain(marker);
}

/** The mock provider's token-endpoint requests, in order. */
export function tokenRequests(server: MockOAuthServer): MockOAuthRequest[] {
  return server.requests.filter((r) => r.method === "POST" && r.path === "/token");
}

/**
 * `base` as a user-registered Bing Webmaster login: the client id and the
 * client secret are `${secret:NAME}` references the user stores with
 * `secrets set`, on the fixed redirect port the preset requires.
 */
export function userRegisteredBing(
  base: ResolvedOAuthLoginDef,
  clientIdName = "bing-client-id",
  clientSecretName = "bing-client-secret",
): ResolvedOAuthLoginDef {
  return {
    ...base,
    provider: "bing-webmaster",
    clientId: `\${secret:${clientIdName}}`,
    clientSecret: `\${secret:${clientSecretName}}`,
    redirectPort: 48213,
  };
}
