/**
 * OAuth login documentation drift — the places that document `oauth.<key>` and
 * the `auth` command (README: the OAuth logins paragraph, the presets table, the
 * command-table row; llms.txt: the branded verb list; llms-full.txt: the §2.1
 * row, the §2.2 paragraph + presets table, the `### auth` reference and the
 * §9.1 SDK section; the site CLI reference + connector field rows in
 * docs-data.ts; the Operate guide + search index, incl. the "who supplies the
 * app" table and the token exchange wire contract; the authoring skill
 * reference) must agree with the code. Sources of truth: AUTH_USAGE_LINES in
 * src/cli/commands/auth.ts (mirrored by COMMAND_USAGE in src/cli/app.ts), the
 * presets in src/core/oauth/, the defineConnector messages, and the engine /
 * CLI / doctor / installer literals. The "By the numbers" row is pinned in
 * tests/docs/readme-facts.test.ts.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  cliCommands,
  connectorConfigFields,
  resolvedConnectorFields,
} from "../../site/src/components/docs/docs-data.js";
import { searchIndex } from "../../site/src/components/docs/search-index.js";
import { oauthProviderRegistrations, oauthSupplyModes } from "../../site/src/components/docs/docs-data.js";
import { AUTH_USAGE_LINES } from "../../src/cli/commands/auth.js";
import { defineConnector } from "../../src/core/define-connector.js";
import { installConnector } from "../../src/core/installer.js";
import { loginsCheck } from "../../src/cli/commands/doctor.js";
import type { OAuthPresetId } from "../../src/core/types.js";
import {
  OAUTH_PRESET_IDS,
  OAuthLoginRequiredError,
  getAccessToken,
  getOAuthPreset,
  login,
  loginSecretNames,
} from "../../src/core/oauth/index.js";
import { SecretResolutionError, openSecretStore } from "../../src/core/secrets.js";
import * as sdk from "../../src/sdk/index.js";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const app = read("src/cli/app.ts");
const README = read("README.md");
const LLMS = read("llms.txt");
const LLMS_FULL = read("llms-full.txt");
const AUTHORING = read("skills/agent-connector/references/authoring.md");
const DOCS_CONTENT = read("site/src/components/docs/DocsContent.tsx");
const TYPES = read("src/core/types.ts");

const VERBS = ["login", "status", "logout", "token"] as const;

/**
 * The `auth` usage lines COMMAND_USAGE in src/cli/app.ts declares — every
 * string literal of the entry, concatenated, split on newlines, keeping the
 * lines that start with `auth `. An entry built from AUTH_USAGE_LINES itself
 * (no literals) is equal by construction and returns the exported lines.
 */
function authUsageLinesFromApp(): string[] {
  const start = app.indexOf("const COMMAND_USAGE");
  if (start < 0) throw new Error("COMMAND_USAGE not found in src/cli/app.ts");
  const block = app.slice(start, app.indexOf("\n};", start));
  const m = block.match(/\n  auth:([\s\S]*?)(?=\n  [a-z]+:|$)/);
  if (!m) throw new Error("auth usage string not found in src/cli/app.ts COMMAND_USAGE");
  const literals = [...m[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`) as string);
  if (literals.length === 0 && m[1]!.includes("AUTH_USAGE_LINES")) return [...AUTH_USAGE_LINES];
  return literals
    .join("")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("auth "));
}

/** The README command-table row for auth. */
function readmeAuthRow(): string {
  const row = README.split("\n").find((l) => l.startsWith("| `auth "));
  if (!row) throw new Error("README auth row not found");
  return row;
}

/** The README `oauth.<key>` paragraph plus its presets table. */
function readmeOAuthParagraph(): string {
  const start = README.indexOf("**OAuth logins (`oauth.<key>`).**");
  if (start < 0) throw new Error("README has no OAuth logins paragraph");
  const end = README.indexOf("**Native hooks escape hatch.**", start);
  return README.slice(start, end < 0 ? undefined : end);
}

/** Rows of the presets table (the one under a `| Preset |` header, up to the next blank line): id → cells. */
function presetTable(text: string): Map<string, string[]> {
  const start = text.indexOf("| Preset |");
  if (start < 0) throw new Error("no `| Preset |` table in the text");
  const table = text.slice(start, text.indexOf("\n\n", start));
  const rows = new Map<string, string[]>();
  for (const line of table.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const cells = line.slice(1, -1).split("|").map((c) => c.trim());
    rows.set(cells[0]!.replace(/^`|`$/g, ""), cells);
  }
  return rows;
}

/** A `### <name>` section of llms-full.txt (up to the next ### heading). */
function llmsSection(heading: string): string {
  const start = LLMS_FULL.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`llms-full.txt has no ${heading} section`);
  const rest = LLMS_FULL.slice(start + 1);
  const end = rest.indexOf("\n### ", 1);
  return end < 0 ? rest : rest.slice(0, end);
}
const llmsAuthSection = () => llmsSection("### auth");
const llmsServerDefSection = () => llmsSection("### 2.2 `ServerDef` (transport-polymorphic, declared once)");
function llmsSdkSection(): string {
  const start = LLMS_FULL.indexOf("### 9.1 ");
  if (start < 0) throw new Error("llms-full.txt has no ### 9.1 section");
  return LLMS_FULL.slice(start, LLMS_FULL.indexOf("### 9.3 ", start));
}

function siteAuthEntry(): { signature: string; summary: string; flags?: { flag: string; desc: string }[] } {
  const entry = cliCommands.find((c) => c.name === "auth");
  if (!entry) throw new Error("docs-data cliCommands has no auth entry");
  return entry;
}
const siteAuthText = () => {
  const e = siteAuthEntry();
  return `${e.summary}\n${(e.flags ?? []).map((f) => `${f.flag} ${f.desc}`).join("\n")}`;
};

/** Field names declared by `interface <name> {` in a TypeScript listing. */
function interfaceFields(text: string, name: string): string[] {
  const start = text.indexOf(`interface ${name} {`);
  if (start < 0) throw new Error(`no interface ${name} in the text`);
  const body = text.slice(start, text.indexOf("\n}", start));
  return [...body.matchAll(/^\s+([A-Za-z]+)\??:/gm)].map((m) => m[1]!);
}

const stripTicks = (line: string) => line.replace(/^`/, "").replace(/`$/, "");
/** llms-full.txt wraps prose at ~80 columns; compare prose with whitespace collapsed. */
const flat = (text: string) => text.replace(/\s+/g, " ");
/** Docs quote a message that itself contains backticks without nesting them. */
const unticked = (text: string) => flat(text).replace(/`/g, "");
const stripBrand = (line: string) => line.replace(/^agent-connector /, "");

const stdio = { transport: "stdio", command: "node", args: ["server.js"] } as const;

/**
 * Runs `fn` with HOME, the data root and the secrets backend (file) redirected
 * to a throwaway directory, restoring the environment afterwards — the pins
 * that drive `installConnector` and doctor's `loginsCheck` for real.
 */
async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ac-docs-root-"));
  const keys = ["HOME", "USERPROFILE", "AGENT_CONNECTOR_DATA_DIR", "AGENT_CONNECTOR_SECRETS_BACKEND", "AGENT_CONNECTOR_TELEMETRY"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.AGENT_CONNECTOR_DATA_DIR = root;
    process.env.AGENT_CONNECTOR_SECRETS_BACKEND = "file";
    delete process.env.AGENT_CONNECTOR_TELEMETRY;
    await fn(root);
  } finally {
    for (const k of keys) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

/** A dry-run install of `connector` into `root` for claude-code: the warn details, in order. */
async function installWarns(connector: ReturnType<typeof defineConnector>, root: string): Promise<string[]> {
  const result = await installConnector({
    connector,
    modulePath: join(root, "fake.mjs"),
    scope: "user",
    projectDir: root,
    targets: ["claude-code"],
    dryRun: true,
  });
  return result.changes.filter((c) => c.action === "warn").map((c) => c.detail);
}

/** The google login as a developer-provided public client (a literal client id, no secret). */
const GOOGLE_LOGIN = { google: { provider: "google", clientId: "1234-abcd.apps.googleusercontent.com", scopes: ["openid"] } } as const;
const googleLogin = { provider: "google", clientId: "1234-abcd.apps.googleusercontent.com", scopes: ["openid"] } as const;

describe("auth docs agree with the CLI usage lines", () => {
  it("AUTH_USAGE_LINES declares one line per verb (login, status, logout, token)", () => {
    expect(AUTH_USAGE_LINES.map((l) => l.split(" ")[1])).toEqual([...VERBS]);
    for (const line of AUTH_USAGE_LINES) expect(line).toMatch(/^auth /);
  });

  it("COMMAND_USAGE in src/cli/app.ts carries the same lines", () => {
    expect(authUsageLinesFromApp()).toEqual([...AUTH_USAGE_LINES]);
  });

  it("llms-full.txt auth signature lines are the usage lines, verbatim", () => {
    const section = llmsAuthSection().split("\n");
    expect(section.slice(1, 1 + VERBS.length).map(stripTicks)).toEqual([...AUTH_USAGE_LINES]);
  });

  it("site CLI reference signature lines are the usage lines, verbatim", () => {
    expect(siteAuthEntry().signature.split("\n").map(stripBrand)).toEqual([...AUTH_USAGE_LINES]);
  });

  it("README command table row names every verb and every option group the CLI accepts", () => {
    const row = readmeAuthRow();
    for (const verb of VERBS) expect(row, `README auth row lacks ${verb}`).toContain(verb);
    const flags = new Set(AUTH_USAGE_LINES.flatMap((l) => [...l.matchAll(/--[a-z-]+/g)].map((x) => x[0])));
    for (const f of ["--device", "--loopback", "--port", "--json"]) {
      expect(flags, `CLI usage no longer declares ${f} — update the README row`).toContain(f);
      expect(row, `README auth row lacks ${f}`).toContain(f);
    }
  });

  it("the flags the site documents are the ones the usage lines declare, on the verbs the site names", () => {
    const line = (verb: string) => AUTH_USAGE_LINES.find((l) => l.startsWith(`auth ${verb} `)) ?? "";
    for (const verb of ["login", "logout", "token"]) expect(line(verb), `${verb} takes <key>`).toContain("<key>");
    expect(line("status")).not.toContain("<key>");
    for (const f of ["--device", "--loopback", "--port"]) {
      expect(line("login"), `login takes ${f}`).toContain(f);
      for (const verb of ["status", "logout", "token"]) expect(line(verb), `${verb} does not take ${f}`).not.toContain(f);
    }
    for (const verb of ["login", "status"]) expect(line(verb), `${verb} takes --json`).toContain("--json");
    for (const verb of ["logout", "token"]) expect(line(verb), `${verb} does not take --json`).not.toContain("--json");
    const flags = Object.fromEntries((siteAuthEntry().flags ?? []).map((f) => [f.flag, f.desc]));
    expect(Object.keys(flags)).toEqual(["<key>", "--device|--loopback", "--port <n>", "--json"]);
    expect(flags["<key>"]).toMatch(/login, logout and token take exactly one; status lists them all/);
    expect(flags["--device|--loopback"]).toMatch(/^login: /);
    expect(flags["--port <n>"]).toMatch(/^login: /);
    expect(flags["--json"]).toMatch(/^login: .*; status: /);
  });
});

describe("the docs name every preset", () => {
  it("the README presets table lists exactly OAUTH_PRESET_IDS, in order", () => {
    expect([...presetTable(readmeOAuthParagraph()).keys()]).toEqual([...OAUTH_PRESET_IDS]);
  });

  it("the README and llms-full flow columns equal each preset's deviceFlow", () => {
    const readme = presetTable(readmeOAuthParagraph());
    const llms = presetTable(llmsServerDefSection());
    for (const id of OAUTH_PRESET_IDS) {
      const flows = getOAuthPreset(id).deviceFlow ? "loopback, device" : "loopback";
      expect(readme.get(id)?.[2], `README flow cell for ${id}`).toBe(flows);
      expect(llms.get(id)?.[1], `llms-full flow cell for ${id}`).toBe(flows);
    }
    expect([...llms.keys()]).toEqual([...OAUTH_PRESET_IDS]);
  });

  it("the presets tables link each provider to the docs page the preset was verified against", () => {
    const readme = presetTable(readmeOAuthParagraph());
    const llms = presetTable(llmsServerDefSection());
    for (const id of OAUTH_PRESET_IDS) {
      const { docsUrl } = getOAuthPreset(id);
      expect(readme.get(id)?.[1], `README provider cell for ${id}`).toContain(`](${docsUrl})`);
      expect(llms.get(id)?.[2], `llms-full notes cell for ${id}`).toContain(docsUrl);
    }
  });

  it("the README row, llms-full, the site, the Operate guide and the authoring reference name every preset id", () => {
    for (const id of OAUTH_PRESET_IDS) {
      expect(readmeAuthRow(), `README auth row lacks ${id}`).toContain(`\`${id}\``);
      expect(llmsServerDefSection(), `llms-full §2.2 lacks ${id}`).toContain(`\`${id}\``);
      expect(siteAuthEntry().summary, `site auth entry lacks ${id}`).toContain(id);
      expect(DOCS_CONTENT, `Operate guide lacks ${id}`).toContain(`<C>${id}</C>`);
      expect(AUTHORING, `authoring reference lacks ${id}`).toContain(`\`${id}\``);
    }
  });

  it("the unknown-provider message lists the preset ids the docs list", () => {
    const list = OAUTH_PRESET_IDS.join(", ");
    expect(() =>
      defineConnector({ id: "seo-mcp", server: stdio, oauth: { google: { ...googleLogin, provider: "nope" as "google" } } }),
    ).toThrow(`oauth.google.provider: "nope" is not a known OAuth preset (${list})`);
    expect(flat(LLMS_FULL)).toContain(`<where>.provider: "<x>" is not a known OAuth preset (${list})`);
  });
});

describe("the messages the oauth docs quote are the ones the code emits", () => {
  it("defineConnector rejects a literal clientSecret for a preset whose provider keeps it confidential, with the documented message", () => {
    const github = { provider: "github", clientId: "Iv1.0123456789abcdef", scopes: ["repo"] } as const;
    for (const [key, def] of [
      ["gh", github],
      ["bing", { provider: "bing-webmaster", clientId: "bing-app", scopes: ["webmaster.read"], redirectPort: 48213 }],
      ["idp", { provider: "generic", clientId: "cid", scopes: ["read"], issuer: "https://auth.invalid" }],
    ] as const) {
      expect(() =>
        defineConnector({ id: "seo-mcp", server: stdio, oauth: { [key]: { ...def, clientSecret: "literal-secret" } } }),
      ).toThrow(`oauth.${key}.clientSecret: must be a \${secret:NAME} reference (a literal secret is never written into a connector config)`);
    }
    expect(getOAuthPreset("github").clientSecretPublic).toBeUndefined();
    expect(flat(LLMS_FULL)).toContain(
      "<where>.clientSecret: must be a ${secret:NAME} reference (a literal secret is never written into a connector config)",
    );
    expect(connectorConfigFields.find((f) => f.name === "oauth")?.notes).toContain(
      "a literal secret is never written into a connector config",
    );
    expect(AUTHORING).toContain("`${secret:NAME}` reference");
  });

  it("defineConnector accepts a literal clientSecret for google only and rejects a malformed one with the documented message", () => {
    expect(getOAuthPreset("google").clientSecretPublic).toBe(true);
    for (const id of OAUTH_PRESET_IDS.filter((p) => p !== "google")) {
      expect(getOAuthPreset(id).clientSecretPublic, `${id} must not accept a literal client secret`).toBeUndefined();
    }
    const literal = defineConnector({ id: "seo-mcp", server: stdio, oauth: { google: { ...googleLogin, clientSecret: "GOCSPX-literal" } } });
    expect(literal.oauth.google?.clientSecret).toBe("GOCSPX-literal");
    const message =
      'oauth.google.clientSecret: must be a ${secret:NAME} reference or a non-empty literal (provider "google" documents an installed app\'s client secret as not confidential)';
    for (const bad of ["", "   ", "${env:GOOGLE_SECRET}", "x-${secret:y}"]) {
      expect(
        () => defineConnector({ id: "seo-mcp", server: stdio, oauth: { google: { ...googleLogin, clientSecret: bad } } }),
        JSON.stringify(bad),
      ).toThrow(message);
    }
    expect(flat(LLMS_FULL)).toContain(
      '<where>.clientSecret: must be a ${secret:NAME} reference or a non-empty literal (provider "google" documents an installed app\'s client secret as not confidential)',
    );
    for (const [name, text] of [
      ["README", readmeOAuthParagraph()],
      ["llms-full §2.2", llmsServerDefSection()],
      ["site oauth row", connectorConfigFields.find((f) => f.name === "oauth")?.notes ?? ""],
      ["site auth entry", siteAuthEntry().summary],
      ["Operate guide", DOCS_CONTENT],
    ] as const) {
      expect(text, `${name} does not say google's literal client secret is accepted`).toContain("not confidential");
    }
    expect(presetTable(readmeOAuthParagraph()).get("google")?.[3]).toContain("A literal `clientSecret` is accepted");
  });

  it("defineConnector accepts exactly one ${secret:NAME} clientId and rejects every other secret-bearing form with the documented message", () => {
    const ref = defineConnector({ id: "seo-mcp", server: stdio, oauth: { google: { ...googleLogin, clientId: "${secret:google-client-id}" } } });
    expect(ref.oauth.google?.clientId).toBe("${secret:google-client-id}");
    const message = "oauth.google.clientId: must be a non-empty string — a literal, ${env:VAR}, or exactly one ${secret:NAME} reference";
    for (const bad of ["", "   ", "id-${secret:x}", "${secret:a}${secret:b}", "${secret:bad name}"]) {
      expect(
        () => defineConnector({ id: "seo-mcp", server: stdio, oauth: { google: { ...googleLogin, clientId: bad } } }),
        JSON.stringify(bad),
      ).toThrow(message);
    }
    expect(flat(LLMS_FULL)).toContain(
      "<where>.clientId: must be a non-empty string — a literal, ${env:VAR}, or exactly one ${secret:NAME} reference",
    );
    expect(llmsServerDefSection()).toMatch(/^  clientId: string; +\/\/ .*exactly one \$\{secret:NAME\}/m);
    expect(connectorConfigFields.find((f) => f.name === "oauth")?.notes).toContain("exactly one ${secret:NAME} reference");
    for (const [name, text] of [
      ["README", readmeOAuthParagraph()],
      ["llms-full §2.2", llmsServerDefSection()],
      ["Operate guide", DOCS_CONTENT],
    ] as const) {
      expect(text, `${name} does not show the user-registered clientId form`).toContain('clientId: "${secret:NAME}"');
      expect(text, `${name} does not show the user-registered clientSecret form`).toContain('clientSecret: "${secret:NAME}"');
    }
    expect(oauthSupplyModes.find((m) => m.mode === "User-registered")?.config).toBe('clientId: "${secret:NAME}"; clientSecret: "${secret:NAME}"');
  });

  it("defineConnector validates tokenExchangeUrl and its exclusivity with clientSecret, with the documented messages", () => {
    const withUrl = (tokenExchangeUrl: string, clientSecret?: string) =>
      defineConnector({
        id: "seo-mcp",
        server: stdio,
        oauth: { google: { ...googleLogin, tokenExchangeUrl, ...(clientSecret === undefined ? {} : { clientSecret }) } },
      });
    expect(withUrl("https://seo.example.com/oauth/google/token").oauth.google?.tokenExchangeUrl).toBe("https://seo.example.com/oauth/google/token");
    expect(withUrl("http://127.0.0.1:1/x").oauth.google?.tokenExchangeUrl).toBe("http://127.0.0.1:1/x");
    for (const bad of ["http://example.com/x", "ftp://x"]) {
      expect(() => withUrl(bad), bad).toThrow("oauth.google.tokenExchangeUrl: must be an https URL");
    }
    const exclusive = "oauth.google: clientSecret and tokenExchangeUrl are exclusive — the token exchange service holds the client secret";
    expect(() => withUrl("https://seo.example.com/t", "GOCSPX-literal")).toThrow(exclusive);
    expect(() => withUrl("https://seo.example.com/t", "${secret:google-client-secret}")).toThrow(exclusive);
    expect(flat(LLMS_FULL)).toContain("<where>.tokenExchangeUrl: must be an https URL");
    expect(flat(LLMS_FULL)).toContain(
      "<where>: clientSecret and tokenExchangeUrl are exclusive — the token exchange service holds the client secret",
    );
    expect(llmsServerDefSection()).toMatch(/^  tokenExchangeUrl\?: string;/m);
    expect(TYPES).toMatch(/^  tokenExchangeUrl\?: string;/m);
    for (const [name, text] of [
      ["README", readmeOAuthParagraph()],
      ["llms.txt", LLMS],
      ["llms-full §2.2", llmsServerDefSection()],
      ["llms-full auth section", llmsAuthSection()],
      ["llms-full §9.1", llmsSdkSection()],
      ["site oauth row", connectorConfigFields.find((f) => f.name === "oauth")?.notes ?? ""],
      ["site auth entry", siteAuthEntry().summary],
      ["Operate guide", DOCS_CONTENT],
    ] as const) {
      expect(text, `${name} does not document tokenExchangeUrl`).toContain("tokenExchangeUrl");
    }
    for (const id of ["github", "bing-webmaster", "generic"]) {
      expect(presetTable(readmeOAuthParagraph()).get(id)?.[3], `README notes for ${id}`).toContain("`tokenExchangeUrl`");
    }
  });

  it("defineConnector rejects empty scopes and a bad key with the documented messages", () => {
    expect(() => defineConnector({ id: "seo-mcp", server: stdio, oauth: { google: { ...googleLogin, scopes: [] } } })).toThrow(
      "oauth.google.scopes: at least one scope string is required",
    );
    expect(flat(LLMS_FULL)).toContain("<where>.scopes: at least one scope string is required");
    const pattern = "^[a-z0-9][a-z0-9-]{0,31}$";
    expect(() => defineConnector({ id: "seo-mcp", server: stdio, oauth: { Bad_Key: googleLogin } })).toThrow(
      `oauth: "Bad_Key" is not a valid login key (expected ${pattern})`,
    );
    expect(flat(LLMS_FULL)).toContain(`oauth: "<key>" is not a valid login key (expected ${pattern})`);
    for (const [name, text] of [
      ["llms-full §2.1", llmsSection("### 2.1 `ConnectorConfig` (the write-once surface)")],
      ["site connector fields", connectorConfigFields.find((f) => f.name === "oauth")?.notes ?? ""],
      ["site auth entry", siteAuthText()],
    ] as const) {
      expect(text, `${name} does not state the login key pattern`).toContain(pattern);
    }
  });

  it("defineConnector rejects a bad posthog region and an empty microsoft tenant with the documented messages", () => {
    expect(() =>
      defineConnector({
        id: "seo-mcp",
        server: stdio,
        oauth: { ph: { provider: "posthog", clientId: "https://app.example/oauth-client", scopes: ["read"], options: { region: "apac" } } },
      }),
    ).toThrow("oauth.ph.options.region: expected us | eu");
    expect(() =>
      defineConnector({
        id: "seo-mcp",
        server: stdio,
        oauth: { ms: { provider: "microsoft", clientId: "cid", scopes: ["offline_access"], options: { tenant: " " } } },
      }),
    ).toThrow("oauth.ms.options.tenant: must be a non-empty string");
    expect(flat(LLMS_FULL)).toContain("<where>.options.region: expected us | eu");
    expect(flat(LLMS_FULL)).toContain("<where>.options.tenant: must be a non-empty string");
  });

  it("the defaults the docs state are the ones defineConnector applies", () => {
    const login = defineConnector({ id: "seo-mcp", server: stdio, oauth: { google: googleLogin } }).oauth.google;
    expect(login).toMatchObject({ key: "google", flow: "auto", redirectPath: "/callback", storeAs: "oauth.google.refresh-token" });
    expect(defineConnector({ id: "seo-mcp", server: stdio }).oauth).toEqual({});
    expect(flat(LLMS_FULL)).toContain('`flow: "auto"`, `redirectPath: "/callback"`, `storeAs: "oauth.<key>.refresh-token"`');
    expect(flat(LLMS_FULL)).toContain("a config without `oauth` resolves to `oauth: {}`");
    expect(resolvedConnectorFields.find((f) => f.name === "oauth")?.notes).toContain("oauth.<key>.refresh-token");
    for (const [name, text] of [
      ["README", readmeOAuthParagraph()],
      ["site auth entry", siteAuthEntry().summary],
      ["Operate guide", DOCS_CONTENT],
      ["authoring reference", AUTHORING],
    ] as const) {
      expect(text, `${name} does not name the refresh-token secret`).toMatch(/oauth\.(<key>|google)\.refresh-token/);
    }
  });

  describe("getAccessToken with interactive: never", () => {
    const tmp = mkdtempSync(join(tmpdir(), "oauth-docs-"));
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    it("throws the OAuthLoginRequiredError the docs quote (no network, no browser)", async () => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: tmp,
        AGENT_CONNECTOR_DATA_DIR: tmp,
        AGENT_CONNECTOR_SECRETS_BACKEND: "file",
        AGENT_CONNECTOR_BROWSER: "never",
      };
      const connector = defineConnector({
        id: "seo-mcp",
        server: stdio,
        oauth: {
          google: {
            provider: "generic",
            clientId: "cid",
            scopes: ["read"],
            authorizationEndpoint: "https://auth.invalid/authorize",
            tokenEndpoint: "https://auth.invalid/token",
          },
        },
      });
      const secretStore = { connectorId: "seo-mcp", dataRoot: tmp, backend: "file" as const, env };
      const noNetwork = async () => {
        throw new Error("no network in docs tests");
      };
      const attempt = getAccessToken({
        connectorId: "seo-mcp",
        key: "google",
        def: connector.oauth.google!,
        interactive: "never",
        env,
        secretStore,
        fetch: noNetwork,
      });
      await expect(attempt).rejects.toBeInstanceOf(OAuthLoginRequiredError);
      const err = (await attempt.catch((e: unknown) => e)) as OAuthLoginRequiredError;
      expect(err.message).toBe('login "google" is not present for connector seo-mcp — run `auth login google --connector-id seo-mcp`');
      expect(err.code).toBe("login-required");
      expect(err).toMatchObject({ connectorId: "seo-mcp", key: "google" });
      const template = 'login "<key>" is not present for connector <id> — run `auth login <key> --connector-id <id>`';
      expect(unticked(llmsAuthSection())).toContain(unticked(template));
      expect(unticked(llmsSdkSection())).toContain(unticked(template));
      expect(unticked(siteAuthEntry().summary)).toContain(unticked(template));
    });
  });

  it("doctor emits the `<id>: logins` check the docs quote", async () => {
    await withTempRoot(async (root) => {
      const connector = defineConnector({ id: "seo-mcp", server: stdio, oauth: GOOGLE_LOGIN });
      const absent = loginsCheck("seo-mcp", connector.oauth);
      expect(absent).toMatchObject({
        check: "seo-mcp: logins",
        status: "warn",
        message: "not logged in: google — run auth login <key>",
        fix: "run `auth login <key> --connector-id seo-mcp` for each of: google",
      });
      openSecretStore({ connectorId: "seo-mcp", backend: "file", dataRoot: root }).set("oauth.google.refresh-token", "mock-refresh-docs");
      expect(loginsCheck("seo-mcp", connector.oauth)).toMatchObject({ check: "seo-mcp: logins", status: "pass", message: "1 login(s) present" });
    });
    const auth = llmsAuthSection();
    expect(auth).toContain("`<id>: logins`");
    expect(flat(auth)).toContain("`<n> login(s) present`");
    expect(flat(auth)).toContain("not logged in: a, b — run auth login <key>");
    expect(unticked(auth)).toContain("run auth login <key> --connector-id <id> for each of: a, b");
    expect(flat(auth)).toContain("no check for a connector without `oauth`");
    expect(readmeOAuthParagraph()).toContain("`<id>: logins`");
    expect(siteAuthEntry().summary).toContain("<id>: logins");
    expect(siteAuthEntry().summary).toContain("<n> login(s) present");
    expect(DOCS_CONTENT).toContain('"seo-mcp: logins"');
    expect(DOCS_CONTENT).toContain("1 login(s) present");
    expect(AUTHORING).toContain("`<id>: logins`");
  });

  it("install emits the missing-login warning the docs quote", async () => {
    const warning = 'login "<key>" (<provider>) is not present — run `auth login <key>` before the server needs it';
    await withTempRoot(async (root) => {
      const warns = await installWarns(defineConnector({ id: "seo-mcp", server: stdio, oauth: GOOGLE_LOGIN }), root);
      expect(warns).toEqual([warning.replaceAll("<key>", "google").replaceAll("<provider>", "google")]);
    });
    expect(unticked(llmsAuthSection())).toContain(unticked(warning));
    expect(unticked(siteAuthEntry().summary)).toContain(unticked(warning));
    expect(readmeOAuthParagraph()).toContain("`install` warns per missing login");
  });

  it("defineConnector refuses an endpoint URL with userinfo or a fragment with the message the docs quote", () => {
    const message = "oauth.google.tokenExchangeUrl: must not carry credentials or a fragment";
    for (const tokenExchangeUrl of ["https://user:pw@seo.example.com/t", "https://seo.example.com/t#frag"]) {
      expect(() => defineConnector({ id: "seo-mcp", server: stdio, oauth: { google: { ...GOOGLE_LOGIN.google, tokenExchangeUrl } } })).toThrow(message);
    }
    expect(() =>
      defineConnector({ id: "seo-mcp", server: stdio, oauth: { google: { ...GOOGLE_LOGIN.google, tokenEndpoint: "https://u@idp.example/token" } } }),
    ).toThrow("oauth.google.tokenEndpoint: must not carry credentials or a fragment");
    expect(flat(LLMS_FULL)).toContain("`<where>.<field>: must not carry credentials or a fragment`");
  });

  it("install and doctor name the secrets set commands the docs quote for a login whose secret is not set", async () => {
    const installLine =
      'login "<key>" (<provider>) references secret "<NAME>" which is not set — run `secrets set <NAME>` before `auth login <key>`';
    const doctorMessage = "secrets not set for login(s) <key>[, <key>…]: <NAME>[, <NAME>…] — run secrets set <name>";
    // `<name>` is literal placeholder text in the fix (as `<key>` is in the "not logged in" fix); `<NAME>` stands for a real name.
    const doctorFix = "run `secrets set <name> --connector-id <id>` for each of: <NAME>[, <NAME>…]";
    await withTempRoot(async (root) => {
      const connector = defineConnector({
        id: "seo-mcp",
        server: stdio,
        oauth: {
          bing: {
            provider: "bing-webmaster",
            clientId: "${secret:bing-client-id}",
            clientSecret: "${secret:bing-client-secret}",
            scopes: ["webmaster.read"],
            redirectPort: 48213,
          },
        },
      });
      const fill = (template: string, name: string): string =>
        template.replaceAll("<key>", "bing").replaceAll("<provider>", "bing-webmaster").replaceAll("<NAME>", name).replaceAll("<id>", "seo-mcp");
      const warns = await installWarns(connector, root);
      expect(warns.slice(0, 2)).toEqual([fill(installLine, "bing-client-id"), fill(installLine, "bing-client-secret")]);
      const check = loginsCheck("seo-mcp", connector.oauth);
      expect(check.status).toBe("warn");
      expect(check.message).toBe(fill(doctorMessage.replace("[, <key>…]", "").replace("<NAME>[, <NAME>…]", "bing-client-id, bing-client-secret"), ""));
      expect(check.fix).toBe(fill(doctorFix.replace("<NAME>[, <NAME>…]", "bing-client-id, bing-client-secret"), ""));
    });
    expect(unticked(llmsAuthSection())).toContain(unticked(installLine));
    expect(unticked(siteAuthEntry().summary)).toContain(unticked(installLine));
    expect(flat(llmsAuthSection())).toContain(doctorMessage);
    expect(unticked(llmsAuthSection())).toContain(unticked(doctorFix));
    expect(siteAuthEntry().summary).toContain(doctorMessage);
    expect(unticked(siteAuthEntry().summary)).toContain(unticked(doctorFix));
    expect(readmeOAuthParagraph()).toContain("name the `secrets set` commands still to run");
    expect(DOCS_CONTENT).toContain("name the <C>secrets set</C> commands");
  });

  describe("the login engine with a temp keystore (no network, no browser)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "oauth-docs-supply-"));
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tmp,
      AGENT_CONNECTOR_DATA_DIR: tmp,
      AGENT_CONNECTOR_SECRETS_BACKEND: "file",
      AGENT_CONNECTOR_BROWSER: "never",
    };
    const secretStore = { connectorId: "seo-mcp", dataRoot: tmp, backend: "file" as const, env };
    const noNetwork = async () => {
      throw new Error("no network in docs tests");
    };
    const generic = {
      provider: "generic",
      scopes: ["read"],
      authorizationEndpoint: "https://auth.invalid/authorize",
      tokenEndpoint: "https://auth.invalid/token",
      deviceAuthorizationEndpoint: "https://auth.invalid/device",
    } as const;

    it("auth login prints the token exchange progress line the docs quote, after resolution and before any flow starts", async () => {
      const def = defineConnector({
        id: "seo-mcp",
        server: stdio,
        oauth: { idp: { ...generic, clientId: "cid", tokenExchangeUrl: "https://seo.example.com/oauth/idp/token" } },
      }).oauth.idp!;
      const lines: string[] = [];
      await expect(
        login({ connectorId: "seo-mcp", key: "idp", def, flow: "device", env, secretStore, log: (l) => lines.push(l), fetch: noNetwork }),
      ).rejects.toThrow();
      expect(lines[0]).toBe("Tokens are exchanged through https://seo.example.com/oauth/idp/token (the connector's token exchange service)");
      const template = "Tokens are exchanged through <tokenExchangeUrl> (the connector's token exchange service)";
      expect(flat(llmsAuthSection())).toContain(template);
      expect(siteAuthEntry().summary).toContain(template);
      expect(loginSecretNames(def)).toEqual([]);
    });

    it("auth login with an unset ${secret:NAME} clientId fails with the SecretResolutionError the docs quote", async () => {
      const both = defineConnector({
        id: "seo-mcp",
        server: stdio,
        oauth: { idp: { ...generic, clientId: "${secret:acme-client-id}", clientSecret: "${secret:acme-client-secret}" } },
      }).oauth.idp!;
      expect(loginSecretNames(both)).toEqual(["acme-client-id", "acme-client-secret"]);
      const def = defineConnector({ id: "seo-mcp", server: stdio, oauth: { idp: { ...generic, clientId: "${secret:acme-client-id}" } } }).oauth.idp!;
      expect(loginSecretNames(def)).toEqual(["acme-client-id"]);
      const attempt = login({ connectorId: "seo-mcp", key: "idp", def, flow: "device", env, secretStore, log: () => undefined, fetch: noNetwork });
      await expect(attempt).rejects.toBeInstanceOf(SecretResolutionError);
      const err = (await attempt.catch((e: unknown) => e)) as SecretResolutionError;
      expect(err.message).toBe(
        'connector "seo-mcp": 1 secret not set: acme-client-id. Run `secrets set <name> --connector-id seo-mcp` for each (oauth.idp.clientId).',
      );
      expect(err.missing).toEqual(["acme-client-id"]);
      const template = 'connector "<id>": 1 secret not set: <NAME>. Run `secrets set <name> --connector-id <id>` for each (oauth.<key>.clientId).';
      expect(unticked(llmsAuthSection())).toContain(unticked(template));
      expect(flat(llmsSdkSection())).toContain("`clientId` or `clientSecret` that is not set throws `SecretResolutionError`");
    });
  });

  it("the engine literals the docs quote exist in src/core/oauth", () => {
    const dir = "src/core/oauth";
    const engine = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => read(join(dir, f)))
      .join("\n");
    const auth = llmsAuthSection();
    for (const [source, doc] of [
      ["Signed in — you can close this window.", "`Signed in — you can close this window.`"],
      ["and enter code", "Visit <verification_uri> and enter code <user_code>"],
      ["the provider returned no refresh token — ", "the provider returned no refresh token — <preset hint>"],
      ["Authorize ${resolved.preset.label} at: ${url}", "Authorize <label> at: <url>"],
      ["Could not open a browser (", "Could not open a browser (<reason>). Authorize <label> at: <url>"],
    ] as const) {
      expect(engine, `src/core/oauth no longer contains ${JSON.stringify(source)}`).toContain(source);
      expect(flat(auth), `llms-full auth section lacks ${JSON.stringify(doc)}`).toContain(doc);
    }
    expect(siteAuthEntry().summary).toContain("Visit <verification_uri> and enter code <user_code>");
    expect(siteAuthEntry().summary).toContain("Authorize <label> at: <url>");
    expect(siteAuthEntry().summary).toContain("the provider returned no refresh token — <preset hint>");
  });

  it("the CLI literals the docs quote exist in src/cli/commands/auth.ts", () => {
    const cli = read("src/cli/commands/auth.ts");
    for (const literal of [
      "authorization in your browser…",
      "refresh token stored in",
      "logged out of",
      "(revoked at the provider)",
      "declares no login",
      "  hint: ",
    ]) {
      expect(cli, `auth.ts no longer contains ${JSON.stringify(literal)}`).toContain(literal);
    }
    const docs = [
      ["llms-full auth section", llmsAuthSection()],
      ["site auth entry", siteAuthEntry().summary],
    ] as const;
    for (const quoted of [
      "Opening <label> authorization in your browser…",
      'logged in to "<key>" (<label>) for connector <id> — refresh token stored in <backend>',
      'logged out of "<key>" for connector <id>',
      "(revoked at the provider)",
      'auth <verb>: connector <id> declares no login "<key>" (declared: a, b)',
      "key  provider  present  obtained  via",
    ]) {
      for (const [name, text] of docs) expect(flat(text), `${name} lacks ${JSON.stringify(quoted)}`).toContain(flat(quoted));
    }
    expect(DOCS_CONTENT).toContain("key  provider  present  obtained  via");
  });
});

describe("the SDK surface the docs describe", () => {
  const EXPORTS = [
    "getAccessToken",
    "login",
    "logout",
    "loginStatus",
    "canOpenBrowser",
    "OAUTH_PRESET_IDS",
    "getOAuthPreset",
    "discoverEndpoints",
    "OAuthError",
    "OAuthLoginRequiredError",
  ] as const;

  it("§9.1 lists every OAuth export and the SDK module exports it", () => {
    const section = llmsSdkSection();
    for (const name of EXPORTS) {
      expect(section, `llms-full §9.1 does not list ${name}`).toContain(name);
      expect(name in sdk, `@ken-jo/agent-connector/sdk does not export ${name}`).toBe(true);
    }
    for (const type of ["OAuthLoginDef", "ResolvedOAuthLoginDef", "OAuthPresetId", "OAuthPreset", "TokenSet", "LoginResult", "LoginStatus", "AccessTokenOptions"]) {
      expect(section, `llms-full §9.1 does not list the type ${type}`).toContain(`\`${type}\``);
    }
  });

  it("§9.1 shows both getAccessToken call forms and the SDK import path", () => {
    const section = llmsSdkSection();
    expect(section).toContain('import { getAccessToken } from "@ken-jo/agent-connector/sdk";');
    expect(section).toContain('await getAccessToken({ connectorId: "seo-mcp", key: "google" });');
    expect(section).toContain('await getAccessToken({ connectorId: "seo-mcp", key: "google", def: connector.oauth.google });');
    expect(DOCS_CONTENT).toContain('getAccessToken({ connectorId: "seo-mcp", key: "google" })');
    expect(readmeOAuthParagraph()).toContain("getAccessToken({ connectorId, key })");
    expect(AUTHORING).toContain("getAccessToken({ connectorId, key })");
    expect(AUTHORING).toContain("@ken-jo/agent-connector/sdk");
  });

  it("the connector fields the docs document exist on the types, with the listed OAuthLoginDef fields", () => {
    expect(TYPES).toMatch(/^  oauth\?: Record<string, OAuthLoginDef>;/m);
    expect(TYPES).toMatch(/^  oauth: Record<string, ResolvedOAuthLoginDef>;/m);
    expect(LLMS_FULL).toContain("| `oauth` | `Record<string, OAuthLoginDef>` |");
    expect(LLMS_FULL).toContain("  oauth: Record<string, ResolvedOAuthLoginDef>;");
    const config = connectorConfigFields.find((f) => f.name === "oauth");
    expect(config?.type).toBe("Record<string, OAuthLoginDef>");
    const resolved = resolvedConnectorFields.find((f) => f.name === "oauth");
    expect(resolved?.type).toBe("Record<string, ResolvedOAuthLoginDef>");
    expect(resolved?.required).toBe(true);
    const fields = interfaceFields(TYPES, "OAuthLoginDef");
    expect(fields.length).toBeGreaterThan(0);
    expect(interfaceFields(llmsServerDefSection(), "OAuthLoginDef")).toEqual(fields);
    for (const field of fields) expect(config?.notes, `site oauth row does not mention ${field}`).toContain(field);
  });
});

describe("the site, the skill and llms.txt", () => {
  it("the Operate guide has the logins section before the renumbered uninstall section and the search index lists it", () => {
    const secrets = DOCS_CONTENT.indexOf('<H3 id="operate-secrets">6. Secrets: the OS keystore</H3>');
    const logins = DOCS_CONTENT.indexOf('<H3 id="operate-logins">7. Logins: OAuth providers</H3>');
    const register = DOCS_CONTENT.indexOf('<H3 id="operate-logins-register">8. Register the app with each provider</H3>');
    const uninstall = DOCS_CONTENT.indexOf('<H3 id="operate-uninstall">9. Reverse it cleanly</H3>');
    expect(secrets).toBeGreaterThan(-1);
    expect(logins).toBeGreaterThan(secrets);
    expect(register).toBeGreaterThan(logins);
    expect(uninstall).toBeGreaterThan(register);
    expect(DOCS_CONTENT).toContain("$ seo-mcp auth login google");
    expect(DOCS_CONTENT).toContain("$ seo-mcp auth status");
    const entry = searchIndex.find((e) => e.id === "operate-logins");
    expect(entry, "search index has no operate-logins heading").toBeDefined();
    expect(entry?.sectionId).toBe("operate-connector");
    expect(entry?.title).toBe("Logins: OAuth providers");
    const ids = searchIndex.filter((e) => e.sectionId === "operate-connector").map((e) => e.id);
    expect(ids.slice(ids.indexOf("operate-secrets"), ids.indexOf("operate-secrets") + 4)).toEqual([
      "operate-secrets",
      "operate-logins",
      "operate-logins-register",
      "operate-uninstall",
    ]);
  });

  it("the site's registration hub covers every preset with the preset's own docs page and an https registration link", () => {
    expect(DOCS_CONTENT).toContain("{oauthProviderRegistrations.map((r) => (");
    expect(oauthProviderRegistrations.map((r) => r.preset)).toEqual([...OAUTH_PRESET_IDS]);
    for (const row of oauthProviderRegistrations) {
      expect(row.docs, `${row.preset}: docs link is not the preset's docsUrl`).toBe(getOAuthPreset(row.preset as OAuthPresetId).docsUrl);
      expect(row.register).toMatch(/^https:\/\//);
      for (const field of ["where", "redirect", "credentials", "notes"] as const) {
        expect(row[field].length, `${row.preset}.${field} is empty`).toBeGreaterThan(20);
      }
      expect(row.redirect).toContain("127.0.0.1");
    }
    const bingRedirect = oauthProviderRegistrations.find((r) => r.preset === "bing-webmaster")?.redirect ?? "";
    expect(bingRedirect).toContain("redirectPort");
    // Bing's registration form rejects a redirect URI with no letters after a dot: the row names the dotted path and the field that sets it.
    expect(bingRedirect).toContain("http://127.0.0.1:<port>/callback.html");
    expect(bingRedirect).toContain("redirectPath");
    expect(oauthProviderRegistrations.find((r) => r.preset === "posthog")?.where).toContain("Client ID Metadata Document");
    expect(searchIndex.find((e) => e.id === "operate-logins-register")?.title).toBe("Register the app with each provider");
  });

  it("the site's supply-mode table has the three ways and every registration row says who supplies the app", () => {
    expect(oauthSupplyModes.map((m) => m.mode)).toEqual(["Developer-provided", "Developer-hosted token exchange", "User-registered"]);
    for (const m of oauthSupplyModes) {
      for (const field of ["config", "user", "fits"] as const) {
        expect(m[field].length, `${m.mode}.${field} is empty`).toBeGreaterThan(20);
      }
    }
    expect(oauthSupplyModes[0]?.config).toContain("google");
    expect(oauthSupplyModes[1]?.config).toContain("tokenExchangeUrl");
    expect(DOCS_CONTENT).toContain("{oauthSupplyModes.map((m) => (");
    expect(DOCS_CONTENT).toContain("{r.ships}");
    for (const row of oauthProviderRegistrations) {
      expect(row.ships.length, `${row.preset}.ships is empty`).toBeGreaterThan(20);
    }
    const ships = Object.fromEntries(oauthProviderRegistrations.map((r) => [r.preset, r.ships]));
    expect(ships.google).toContain("literal clientSecret");
    expect(ships.microsoft).toContain("no secret");
    expect(ships.github).toContain("tokenExchangeUrl");
    expect(ships["bing-webmaster"]).toContain("tokenExchangeUrl");
    expect(ships.posthog).toContain("no secret");
    expect(ships.generic).toContain("tokenExchangeUrl");
    for (const preset of ["github", "bing-webmaster", "generic"]) {
      expect(ships[preset], `${preset} offers the user-registered way`).toMatch(/user-registered/i);
    }
  });

  it("the token exchange wire contract's request bodies appear in llms-full and the Operate guide", () => {
    const bodies = [
      "grant_type=authorization_code&code=…&redirect_uri=…&code_verifier=…&client_id=…",
      "grant_type=refresh_token&refresh_token=…&client_id=…",
      "grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=…&client_id=…",
    ];
    for (const body of bodies) {
      expect(llmsServerDefSection(), `llms-full §2.2 lacks ${body}`).toContain(`\n${body}\n`);
      expect(DOCS_CONTENT, `Operate guide lacks ${body}`).toContain(body);
    }
    const section = flat(llmsServerDefSection());
    for (const duty of [
      "never `client_secret`",
      "accept only its own `client_id` and only those three `grant_type` values",
      'answer `400 {"error":"invalid_request"}` otherwise',
      "return the provider's status and body unchanged; never log request or response bodies",
      "The service must not be a public relay: one provider, one client id.",
      "PKCE stays on the client, so a code intercepted elsewhere is useless without the verifier.",
    ]) {
      expect(section, `llms-full §2.2 lacks the duty ${JSON.stringify(duty)}`).toContain(duty);
    }
    expect(DOCS_CONTENT).toContain("one provider, one client id");
    expect(DOCS_CONTENT).toContain("useless without the verifier");
    expect(flat(llmsAuthSection())).toContain("the device authorization request and revocation on `logout` still go to the provider, as a public client");
  });

  it("llms.txt lists auth in the branded verb list next to secrets and names the three ways to supply the app", () => {
    expect(LLMS).toContain("`secrets`, `auth`");
    expect(flat(LLMS)).toContain("supplied one of three ways");
    expect(LLMS).toContain("`tokenExchangeUrl`");
  });

  it("the authoring reference tells connector authors to declare oauth.<key> and point users at `auth login`", () => {
    expect(AUTHORING).toContain("**Logins.**");
    expect(AUTHORING).toContain("`oauth.<key>`");
    expect(AUTHORING).toContain("`<bin> auth login <key>`");
    expect(AUTHORING.indexOf("**Logins.**")).toBeGreaterThan(AUTHORING.indexOf("**Secrets.**"));
  });

  it("every surface says agent-connector ships no client ids", () => {
    for (const [name, text] of [
      ["README", readmeOAuthParagraph()],
      ["llms-full §2.2", llmsServerDefSection()],
      ["llms-full auth section", llmsAuthSection()],
      ["site auth entry", siteAuthEntry().summary],
      ["Operate guide", DOCS_CONTENT],
      ["authoring reference", AUTHORING],
    ] as const) {
      expect(flat(text), `${name} does not say the framework ships no client ids`).toMatch(/no client ids/);
    }
  });

  it("every surface states that only auth token prints an access token", () => {
    expect(readmeOAuthParagraph()).toContain("nothing else ever prints a token");
    expect(flat(llmsAuthSection())).toContain("the one exception is `auth token`'s stdout");
    expect(siteAuthEntry().summary).toContain("except auth token");
    expect(DOCS_CONTENT).toContain("Nothing but <C>auth token</C> ever prints a token");
  });
});
