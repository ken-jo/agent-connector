/**
 * core/oauth/presets — the provider facts the flow engine runs on.
 *
 * Every preset names the page it was checked against and the date, carries
 * https endpoints or a discovery issuer (generic carries neither: the login
 * supplies them), and states PKCE, device-grant and token-endpoint auth
 * explicitly. The posthog region and microsoft tenant resolvers are pure
 * functions of the login's `options`.
 */

import { describe, expect, it } from "vitest";

import { OAUTH_PRESET_IDS, POSTHOG_REGIONS, getOAuthPreset } from "../../src/core/oauth/presets.js";
import type { OAuthPreset } from "../../src/core/oauth/presets.js";
import type { OAuthPresetId, ResolvedOAuthLoginDef } from "../../src/core/types.js";

const URL_FIELDS = [
  "issuer",
  "authorizationEndpoint",
  "tokenEndpoint",
  "deviceAuthorizationEndpoint",
  "revocationEndpoint",
] as const;

function loginDef(provider: OAuthPresetId, options?: Record<string, string>): ResolvedOAuthLoginDef {
  return {
    key: "acme",
    provider,
    clientId: "client-id",
    scopes: ["read"],
    flow: "auto",
    redirectPath: "/callback",
    storeAs: "oauth.acme.refresh-token",
    ...(options ? { options } : {}),
  };
}

describe("OAUTH_PRESET_IDS / getOAuthPreset", () => {
  it("lists the six presets in the documented order", () => {
    expect([...OAUTH_PRESET_IDS]).toEqual(["google", "microsoft", "github", "bing-webmaster", "posthog", "generic"]);
  });

  it("returns the preset whose id was asked for, frozen", () => {
    for (const id of OAUTH_PRESET_IDS) {
      const preset = getOAuthPreset(id);
      expect(preset.id).toBe(id);
      expect(Object.isFrozen(preset)).toBe(true);
      expect(getOAuthPreset(id)).toBe(preset);
    }
  });

  it("throws for an unknown id, naming the presets", () => {
    expect(() => getOAuthPreset("nope" as OAuthPresetId)).toThrow(
      '"nope" is not a known OAuth preset (google, microsoft, github, bing-webmaster, posthog, generic)',
    );
    expect(() => getOAuthPreset("toString" as OAuthPresetId)).toThrow('"toString" is not a known OAuth preset');
  });
});

describe.each(OAUTH_PRESET_IDS)("preset %s", (id) => {
  const preset: OAuthPreset = getOAuthPreset(id);

  it("names its label, docs page and verification date", () => {
    expect(preset.label.trim().length).toBeGreaterThan(0);
    expect(preset.docsUrl).toMatch(/^https:\/\/\S+$/);
    expect(preset.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const checked = Date.parse(preset.verifiedOn);
    expect(Number.isNaN(checked)).toBe(false);
    expect(checked).toBeLessThanOrEqual(Date.now());
  });

  it("states pkce, deviceFlow and tokenEndpointAuth", () => {
    expect(typeof preset.pkce).toBe("boolean");
    expect(typeof preset.deviceFlow).toBe("boolean");
    expect(["client_secret_post", "client_secret_basic", "none"]).toContain(preset.tokenEndpointAuth);
  });

  it(id === "google" ? "documents the client secret as not confidential (clientSecretPublic)" : "leaves clientSecretPublic unset", () => {
    if (id === "google") expect(preset.clientSecretPublic).toBe(true);
    else expect(preset.clientSecretPublic).toBeUndefined();
  });

  it("uses https for every URL it carries", () => {
    for (const field of URL_FIELDS) {
      if (preset[field] !== undefined) expect(preset[field]).toMatch(/^https:\/\/\S+$/);
    }
    if (preset.scopeSeparator !== undefined) expect(preset.scopeSeparator.length).toBeGreaterThan(0);
  });

  it(id === "generic" ? "carries no endpoint (the login supplies them)" : "carries endpoints or a discovery issuer", () => {
    if (id === "generic") {
      for (const field of URL_FIELDS) expect(preset[field]).toBeUndefined();
      return;
    }
    const explicit = preset.authorizationEndpoint !== undefined && preset.tokenEndpoint !== undefined;
    expect(preset.issuer !== undefined || explicit).toBe(true);
    if (preset.deviceFlow) expect(preset.deviceAuthorizationEndpoint ?? preset.issuer).toBeDefined();
  });

  it("resolves the same endpoints for the same login and leaves the login alone", () => {
    if (!preset.resolve) return;
    const def = loginDef(id);
    const before = JSON.stringify(def);
    const a = preset.resolve(def);
    const b = preset.resolve(def);
    expect(a).toEqual(b);
    expect(JSON.stringify(def)).toBe(before);
    for (const [field, value] of Object.entries(a)) {
      expect((URL_FIELDS as readonly string[]).includes(field)).toBe(true);
      expect(value).toMatch(/^https:\/\/\S+$/);
    }
  });
});

describe("provider facts", () => {
  it("google: OIDC issuer, PKCE, form-body secret, offline-access params, no device fallback", () => {
    const google = getOAuthPreset("google");
    expect(google.issuer).toBe("https://accounts.google.com");
    expect(google.authorizationEndpoint).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(google.tokenEndpoint).toBe("https://oauth2.googleapis.com/token");
    expect(google.deviceAuthorizationEndpoint).toBe("https://oauth2.googleapis.com/device/code");
    expect(google.revocationEndpoint).toBe("https://oauth2.googleapis.com/revoke");
    expect(google.pkce).toBe(true);
    expect(google.tokenEndpointAuth).toBe("client_secret_post");
    // "the client secret is obviously not treated as a secret" — a literal clientSecret is accepted.
    expect(google.clientSecretPublic).toBe(true);
    // The device grant covers only sign-in, Drive file and YouTube scopes.
    expect(google.deviceFlow).toBe(false);
    expect(google.extraAuthorizationParams).toEqual({ access_type: "offline", prompt: "consent" });
    expect(google.refreshTokenHint).toContain("access_type=offline");
    expect(google.refreshTokenHint).toContain("prompt=consent");
    expect(google.resolve).toBeUndefined();
  });

  it("microsoft: v2.0 authority per tenant, PKCE, device grant, offline_access hint", () => {
    const microsoft = getOAuthPreset("microsoft");
    const common = "https://login.microsoftonline.com/common";
    expect(microsoft.issuer).toBe(`${common}/v2.0`);
    expect(microsoft.authorizationEndpoint).toBe(`${common}/oauth2/v2.0/authorize`);
    expect(microsoft.tokenEndpoint).toBe(`${common}/oauth2/v2.0/token`);
    expect(microsoft.deviceAuthorizationEndpoint).toBe(`${common}/oauth2/v2.0/devicecode`);
    expect(microsoft.revocationEndpoint).toBeUndefined();
    expect(microsoft.pkce).toBe(true);
    expect(microsoft.tokenEndpointAuth).toBe("client_secret_post");
    expect(microsoft.deviceFlow).toBe(true);
    expect(microsoft.refreshTokenHint).toContain("offline_access");

    expect(microsoft.resolve!(loginDef("microsoft"))).toEqual({
      issuer: `${common}/v2.0`,
      authorizationEndpoint: `${common}/oauth2/v2.0/authorize`,
      tokenEndpoint: `${common}/oauth2/v2.0/token`,
      deviceAuthorizationEndpoint: `${common}/oauth2/v2.0/devicecode`,
    });
    const contoso = "https://login.microsoftonline.com/contoso.onmicrosoft.com";
    expect(microsoft.resolve!(loginDef("microsoft", { tenant: "contoso.onmicrosoft.com" }))).toEqual({
      issuer: `${contoso}/v2.0`,
      authorizationEndpoint: `${contoso}/oauth2/v2.0/authorize`,
      tokenEndpoint: `${contoso}/oauth2/v2.0/token`,
      deviceAuthorizationEndpoint: `${contoso}/oauth2/v2.0/devicecode`,
    });
    const tenantId = "72f988bf-86f1-41af-91ab-2d7cd011db47";
    expect(microsoft.resolve!(loginDef("microsoft", { tenant: tenantId })).issuer).toBe(
      `https://login.microsoftonline.com/${tenantId}/v2.0`,
    );
    expect(microsoft.resolve!(loginDef("microsoft", { tenant: "organizations" })).tokenEndpoint).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
    );
  });

  it("github: fixed endpoints, JSON via Accept, PKCE, device grant, no revocation endpoint", () => {
    const github = getOAuthPreset("github");
    expect(github.issuer).toBeUndefined();
    expect(github.authorizationEndpoint).toBe("https://github.com/login/oauth/authorize");
    expect(github.tokenEndpoint).toBe("https://github.com/login/oauth/access_token");
    expect(github.deviceAuthorizationEndpoint).toBe("https://github.com/login/device/code");
    expect(github.revocationEndpoint).toBeUndefined();
    expect(github.pkce).toBe(true);
    expect(github.tokenEndpointAuth).toBe("client_secret_post");
    expect(github.deviceFlow).toBe(true);
    expect(github.tokenRequestHeaders).toEqual({ Accept: "application/json" });
    expect(github.refreshTokenHint).toContain("expiring user tokens");
    expect(github.refreshTokenHint).toContain("offline_access");
    expect(github.resolve).toBeUndefined();
  });

  it("bing-webmaster: fixed endpoints, client secret in the form body, no PKCE, no device grant", () => {
    const bing = getOAuthPreset("bing-webmaster");
    expect(bing.issuer).toBeUndefined();
    expect(bing.authorizationEndpoint).toBe("https://www.bing.com/webmasters/oauth/authorize");
    expect(bing.tokenEndpoint).toBe("https://www.bing.com/webmasters/oauth/token");
    expect(bing.deviceAuthorizationEndpoint).toBeUndefined();
    expect(bing.revocationEndpoint).toBeUndefined();
    expect(bing.pkce).toBe(false);
    expect(bing.tokenEndpointAuth).toBe("client_secret_post");
    expect(bing.deviceFlow).toBe(false);
    expect(bing.extraAuthorizationParams).toBeUndefined();
    expect(bing.refreshTokenHint).toContain("redirect URI");
    expect(bing.resolve).toBeUndefined();
  });

  it("posthog: region-agnostic issuer by default, us / eu on request, public client with PKCE", () => {
    const posthog = getOAuthPreset("posthog");
    expect([...POSTHOG_REGIONS]).toEqual(["us", "eu"]);
    expect(posthog.issuer).toBe("https://oauth.posthog.com");
    expect(posthog.authorizationEndpoint).toBe("https://oauth.posthog.com/oauth/authorize/");
    expect(posthog.tokenEndpoint).toBe("https://oauth.posthog.com/oauth/token/");
    expect(posthog.revocationEndpoint).toBe("https://oauth.posthog.com/oauth/revoke/");
    expect(posthog.deviceAuthorizationEndpoint).toBeUndefined();
    expect(posthog.pkce).toBe(true);
    expect(posthog.tokenEndpointAuth).toBe("none");
    expect(posthog.deviceFlow).toBe(false);
    expect(posthog.refreshTokenHint).toContain("Client ID Metadata Document");

    expect(posthog.resolve!(loginDef("posthog"))).toEqual({
      issuer: "https://oauth.posthog.com",
      authorizationEndpoint: "https://oauth.posthog.com/oauth/authorize/",
      tokenEndpoint: "https://oauth.posthog.com/oauth/token/",
      revocationEndpoint: "https://oauth.posthog.com/oauth/revoke/",
    });
    for (const region of POSTHOG_REGIONS) {
      const origin = `https://${region}.posthog.com`;
      expect(posthog.resolve!(loginDef("posthog", { region }))).toEqual({
        issuer: origin,
        authorizationEndpoint: `${origin}/oauth/authorize/`,
        tokenEndpoint: `${origin}/oauth/token/`,
        revocationEndpoint: `${origin}/oauth/revoke/`,
      });
    }
  });

  it("generic: PKCE requested, form-body secret, device grant when the server publishes one", () => {
    const generic = getOAuthPreset("generic");
    expect(generic.pkce).toBe(true);
    expect(generic.tokenEndpointAuth).toBe("client_secret_post");
    expect(generic.deviceFlow).toBe(true);
    expect(generic.refreshTokenHint?.length).toBeGreaterThan(0);
    expect(generic.resolve).toBeUndefined();
  });
});
