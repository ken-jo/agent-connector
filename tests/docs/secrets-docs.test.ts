/**
 * secrets documentation drift — the places that document `secrets` (the README
 * command table + `${secret:NAME}` paragraph, the llms-full.txt CLI reference,
 * the site CLI reference + ServerDef field rows in docs-data.ts, the Operate
 * guide, and the authoring skill reference) must agree with the CLI. Source of
 * truth for the signature lines is the `secrets` usage string in src/cli/app.ts;
 * the backend ids come from src/core/secrets.ts.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { cliCommands, serverDefFields } from "../../site/src/components/docs/docs-data.js";
import { searchIndex } from "../../site/src/components/docs/search-index.js";
import { defineConnector } from "../../src/core/define-connector.js";
import { SECRETS_BACKEND_ENV, SECRET_BACKEND_IDS, SecretResolutionError } from "../../src/core/secrets.js";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const app = read("src/cli/app.ts");
const README = read("README.md");
const LLMS_FULL = read("llms-full.txt");
const AUTHORING = read("skills/agent-connector/references/authoring.md");
const DOCS_CONTENT = read("site/src/components/docs/DocsContent.tsx");

const VERBS = ["set", "delete", "list", "check"] as const;

/**
 * The `secrets` usage lines COMMAND_USAGE in src/cli/app.ts declares — every
 * string literal of the entry, concatenated, split on newlines, keeping the
 * lines that start with `secrets `.
 */
function secretsUsageLines(): string[] {
  const start = app.indexOf("const COMMAND_USAGE");
  if (start < 0) throw new Error("COMMAND_USAGE not found in src/cli/app.ts");
  const block = app.slice(start, app.indexOf("\n};", start));
  const m = block.match(/\n  secrets:([\s\S]*?)(?=\n  [a-z]+:|$)/);
  if (!m) throw new Error("secrets usage string not found in src/cli/app.ts COMMAND_USAGE");
  const text = [...m[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((x) => JSON.parse(`"${x[1]}"`) as string)
    .join("");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("secrets "));
}

/** The README command-table row for secrets. */
function readmeSecretsRow(): string {
  const row = README.split("\n").find((l) => l.startsWith("| `secrets "));
  if (!row) throw new Error("README secrets row not found");
  return row;
}

/** The README `${secret:NAME}` paragraph plus its backends table. */
function readmeSecretsParagraph(): string {
  const start = README.indexOf("**OS keystore secrets (`${secret:NAME}`).**");
  if (start < 0) throw new Error("README has no OS keystore secrets paragraph");
  const end = README.indexOf("**Native hooks escape hatch.**", start);
  return README.slice(start, end < 0 ? undefined : end);
}

/** The `### secrets` section of llms-full.txt (up to the next ### heading). */
function llmsSecretsSection(): string {
  const start = LLMS_FULL.indexOf("\n### secrets\n");
  if (start < 0) throw new Error("llms-full.txt has no ### secrets section");
  const rest = LLMS_FULL.slice(start + 1);
  const end = rest.indexOf("\n### ", 1);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The `### 2.2 ServerDef` section of llms-full.txt. */
function llmsServerDefSection(): string {
  const start = LLMS_FULL.indexOf("\n### 2.2 ");
  if (start < 0) throw new Error("llms-full.txt has no ### 2.2 section");
  const rest = LLMS_FULL.slice(start + 1);
  return rest.slice(0, rest.indexOf("\n### ", 1));
}

function siteSecretsEntry(): { signature: string; summary: string; flags?: { flag: string; desc: string }[] } {
  const entry = cliCommands.find((c) => c.name === "secrets");
  if (!entry) throw new Error("docs-data cliCommands has no secrets entry");
  return entry;
}

const stripTicks = (line: string) => line.replace(/^`/, "").replace(/`$/, "");
/** llms-full.txt wraps prose at ~80 columns; compare prose with whitespace collapsed. */
const flat = (text: string) => text.replace(/\s+/g, " ");
const stripBrand = (line: string) => line.replace(/^agent-connector /, "");

describe("secrets docs agree with the CLI usage string", () => {
  it("the CLI declares one usage line per verb (set, delete, list, check)", () => {
    const lines = secretsUsageLines();
    expect(lines.map((l) => l.split(" ")[1])).toEqual([...VERBS]);
  });

  it("llms-full.txt secrets signature lines are the CLI usage lines, verbatim", () => {
    const section = llmsSecretsSection().split("\n");
    expect(section.slice(1, 1 + VERBS.length).map(stripTicks)).toEqual(secretsUsageLines());
  });

  it("site CLI reference signature lines are the CLI usage lines, verbatim", () => {
    const lines = siteSecretsEntry().signature.split("\n").map(stripBrand);
    expect(lines).toEqual(secretsUsageLines());
  });

  it("README command table row names every verb and every option group the CLI accepts", () => {
    const row = readmeSecretsRow();
    for (const verb of VERBS) expect(row, `README secrets row lacks ${verb}`).toContain(verb);
    const flags = new Set(secretsUsageLines().flatMap((l) => [...l.matchAll(/--[a-z-]+/g)].map((x) => x[0])));
    for (const f of ["--backend", "--stdin", "--json"]) {
      expect(flags, `CLI usage no longer declares ${f} — update the README row`).toContain(f);
      expect(row, `README secrets row lacks ${f}`).toContain(f);
    }
  });

  it("no usage line offers a --value flag (values come from a prompt or stdin only)", () => {
    for (const line of secretsUsageLines()) expect(line).not.toContain("--value");
    expect(readmeSecretsRow()).not.toMatch(/\[--value/);
    expect(siteSecretsEntry().signature).not.toContain("--value");
  });
});

describe("secrets docs name the backends and the reference syntax", () => {
  it("README, llms-full and the site list every backend id", () => {
    const readme = readmeSecretsParagraph();
    const llms = llmsSecretsSection();
    const site = siteSecretsEntry();
    const siteText = `${site.summary}\n${(site.flags ?? []).map((f) => `${f.flag} ${f.desc}`).join("\n")}`;
    for (const id of SECRET_BACKEND_IDS) {
      expect(readme, `README backends table lacks ${id}`).toContain(`| \`${id}\` |`);
      expect(readmeSecretsRow(), `README secrets row lacks ${id}`).toContain(id);
      expect(llms, `llms-full secrets section lacks ${id}`).toContain(`\`${id}\``);
      expect(siteText, `site secrets entry lacks ${id}`).toContain(id);
    }
  });

  it("README and the site call the file backend opt-in plaintext", () => {
    for (const [name, text] of [
      ["README", readmeSecretsParagraph()],
      ["site", siteSecretsEntry().summary],
      ["llms-full", llmsSecretsSection()],
    ] as const) {
      expect(flat(text), `${name} does not say the file backend is opt-in`).toMatch(/opt-in/i);
      expect(flat(text), `${name} does not say the file backend is plaintext`).toMatch(/plaintext/i);
      expect(flat(text), `${name} does not say the file backend is not encrypted`).toMatch(/not encrypted/i);
    }
  });

  it("README, llms-full and the site name the backend selection env var", () => {
    for (const [name, text] of [
      ["README", readmeSecretsParagraph()],
      ["llms-full", llmsSecretsSection()],
      ["site", siteSecretsEntry().summary],
    ] as const) {
      expect(text, `${name} does not name ${SECRETS_BACKEND_ENV}`).toContain(SECRETS_BACKEND_ENV);
    }
  });

  it("every surface documents the ${secret:NAME} reference and the {secret:NAME} host-config placeholder", () => {
    for (const [name, text] of [
      ["README", readmeSecretsParagraph()],
      ["llms-full", LLMS_FULL],
      ["site summary", siteSecretsEntry().summary],
      ["Operate guide", DOCS_CONTENT],
      ["authoring reference", AUTHORING],
    ] as const) {
      expect(text, `${name} does not document \${secret:NAME}`).toContain("${secret:");
      expect(text, `${name} does not show the --secret-env placeholder form`).toMatch(/[^$]\{secret:/);
    }
  });

  it("ServerDef docs (site + llms-full) mark env as secret-ref capable and document secretEnv", () => {
    const env = serverDefFields.find((f) => f.name === "env");
    expect(env?.notes).toContain("${secret:NAME}");
    const secretEnv = serverDefFields.find((f) => f.name === "secretEnv");
    expect(secretEnv, "docs-data serverDefFields has no secretEnv row").toBeDefined();
    expect(secretEnv?.notes).toMatch(/defineConnector/);
    const section = llmsServerDefSection();
    expect(section).toContain("${secret:NAME}");
    expect(section).toContain("secretEnv?: Record<string, string>;");
    expect(flat(section)).toContain("supported only in server.env of a stdio server");
  });

  it("the ServerDef fields the site documents exist on the ServerDef type", () => {
    const types = read("src/core/types.ts");
    for (const name of ["env", "secretEnv"]) {
      expect(types, `src/core/types.ts ServerDef has no ${name}`).toMatch(new RegExp(`^  ${name}\\?: Record<string, string>;`, "m"));
    }
  });

  it("the Operate guide has the secrets section and the search index lists it", () => {
    expect(DOCS_CONTENT).toContain('<H3 id="operate-secrets">');
    const entry = searchIndex.find((e) => e.id === "operate-secrets");
    expect(entry, "search index has no operate-secrets heading").toBeDefined();
    expect(entry?.sectionId).toBe("operate-connector");
  });

  it("the authoring reference tells connector authors to use ${secret:NAME} and `secrets set`", () => {
    expect(AUTHORING).toContain("secrets set");
    expect(AUTHORING).toMatch(/stdio server/);
  });

  it("the SDK section of llms-full documents openSecretStore with the synchronous get contract", () => {
    const start = LLMS_FULL.indexOf("### 9.1 ");
    const sdk = LLMS_FULL.slice(start, LLMS_FULL.indexOf("### 9.3 ", start));
    expect(sdk).toContain("openSecretStore");
    expect(sdk).toContain("string | null");
    for (const name of ["SecretError", "SecretResolutionError", "SECRET_BACKEND_IDS", "resolveSecretBackendId", "findSecretRefs"]) {
      expect(sdk, `llms-full §9 does not export ${name}`).toContain(name);
    }
  });
});

describe("the messages the secrets docs quote are the ones the code emits", () => {
  it("defineConnector rejects refs outside server.env with the documented message", () => {
    expect(() =>
      defineConnector({ id: "acme-db", server: { transport: "stdio", command: "npx", args: ["${secret:tok}"] } }),
    ).toThrow("secret refs (${secret:NAME}) are supported only in server.env of a stdio server");
    expect(LLMS_FULL).toContain("supported only in\nserver.env of a stdio server");
  });

  it("the resolution error ends with the documented `secrets set` hint", () => {
    const err = new SecretResolutionError("acme-db", ["api-key", "db-pass"]);
    expect(err.message).toMatch(/Run `secrets set <name> --connector-id acme-db` for each/);
    expect(LLMS_FULL).toContain("Run `secrets set <name> --connector-id\n<id>` for each");
  });

  // The prompt label and the doctor wording are pinned by behavior in
  // tests/cli/secrets.test.ts and tests/cli/doctor-secrets.test.ts; here only
  // the docs side is checked against the same literals.
  it("the hidden prompt text is the one the docs quote", () => {
    const cli = read("src/cli/commands/secrets.ts");
    expect(cli).toContain("(input hidden):");
    expect(LLMS_FULL).toContain("Enter value for <name> (input hidden):");
  });

  it("doctor emits the `secret(s) present in` check the docs quote", () => {
    const doctor = read("src/cli/commands/doctor.ts");
    expect(doctor).toContain("secret(s) present in");
    expect(LLMS_FULL).toContain("secret(s) present in <backend>");
  });
});
