/**
 * doctor documentation drift — the three places that document `doctor`
 * (README command table, llms-full.txt reference, the site CLI reference in
 * docs-data.ts) must all list the flags the CLI actually accepts, and all must
 * describe the version checks doctor performs. Source of truth for the flag set
 * is the usage string in src/cli/app.ts.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { cliCommands } from "../../site/src/components/docs/docs-data.js";

const app = readFileSync("src/cli/app.ts", "utf8");
const README = readFileSync("README.md", "utf8");
const LLMS_FULL = readFileSync("llms-full.txt", "utf8");

/** Every `--flag` the doctor usage string in app.ts declares. */
function doctorFlagsFromUsage(): string[] {
  const m = app.match(/doctor:\n\s+"doctor ([^"]+)"/);
  if (!m) throw new Error("doctor usage string not found in src/cli/app.ts");
  const flags = [...m[1]!.matchAll(/--[a-z-]+/g)].map((x) => x[0]);
  return [...new Set(flags)];
}

/** The README command-table row for doctor. */
function readmeDoctorRow(): string {
  const row = README.split("\n").find((l) => l.startsWith("| `doctor "));
  if (!row) throw new Error("README doctor row not found");
  return row;
}

/** The `### doctor` section of llms-full.txt (up to the next ### heading). */
function llmsDoctorSection(): string {
  const start = LLMS_FULL.indexOf("\n### doctor\n");
  if (start < 0) throw new Error("llms-full.txt has no ### doctor section");
  const rest = LLMS_FULL.slice(start + 1);
  const end = rest.indexOf("\n### ", 1);
  return end < 0 ? rest : rest.slice(0, end);
}

function siteDoctorEntry(): { signature: string; summary: string } {
  const entry = cliCommands.find((c) => c.name === "doctor");
  if (!entry) throw new Error("docs-data cliCommands has no doctor entry");
  return entry;
}

describe("doctor docs agree with the CLI", () => {
  const flags = doctorFlagsFromUsage();
  // Flags that are plumbing rather than behavior — documented once in the
  // signature lines, not required in the README's one-line table row.
  const plumbing = new Set(["--targets", "--connector", "--scope", "--project", "--quiet"]);
  const behavior = flags.filter((f) => !plumbing.has(f));

  it("the usage string declares the behavior flags this test expects", () => {
    expect(behavior).toEqual(
      expect.arrayContaining(["--probe", "--explain", "--json", "--heal", "--dry-run"]),
    );
  });

  it("README command table lists every behavior flag", () => {
    const row = readmeDoctorRow();
    for (const f of behavior) expect(row, `README doctor row lacks ${f}`).toContain(f);
  });

  it("llms-full.txt doctor signature lists every flag but --quiet", () => {
    const section = llmsDoctorSection();
    const signature = section.split("\n")[1] ?? "";
    for (const f of flags.filter((x) => x !== "--quiet")) {
      expect(signature, `llms-full doctor signature lacks ${f}`).toContain(f);
    }
  });

  it("site CLI reference signature lists every flag but --quiet", () => {
    const { signature } = siteDoctorEntry();
    for (const f of flags.filter((x) => x !== "--quiet")) {
      expect(signature, `site doctor signature lacks ${f}`).toContain(f);
    }
  });

  it("all three describe the version checks (home-bin + framework version → upgrade)", () => {
    for (const [name, text] of [
      ["README", readmeDoctorRow()],
      ["llms-full", llmsDoctorSection()],
      ["site", siteDoctorEntry().summary],
    ] as const) {
      expect(text, `${name} doctor docs do not mention version checks`).toMatch(/version/i);
      expect(text, `${name} doctor docs do not mention the home bin`).toMatch(/home[- ]bin/i);
      expect(text, `${name} doctor docs do not point at upgrade`).toContain("upgrade");
    }
  });

  it("the version checks documented are the ones doctor emits", () => {
    const doctor = readFileSync("src/cli/commands/doctor.ts", "utf8");
    for (const check of [
      '"agent-connector: home-bin"',
      '"agent-connector: home-bin version"',
      "framework version",
      "connector version",
    ]) {
      expect(doctor).toContain(check);
    }
  });
});
