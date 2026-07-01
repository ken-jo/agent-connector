#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage: node scripts/prepare-release.mjs [--dry-run] <patch|minor|major|x.y.z>

Updates package version sources, README dependency examples, the package-audit
fixture, and CHANGELOG.md for an automated release workflow.`);
  process.exit(exitCode);
}

const args = process.argv.slice(2);
let dryRun = false;
let requested = "";

for (const arg of args) {
  if (arg === "--help" || arg === "-h") usage(0);
  if (arg === "--dry-run") {
    dryRun = true;
    continue;
  }
  if (requested) usage(1);
  requested = arg;
}

if (!requested) usage(1);

function file(...parts) {
  return path.join(repoRoot, ...parts);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(file(relativePath), "utf8"));
}

function writeJson(relativePath, value) {
  if (dryRun) {
    console.log(`[release] would write ${relativePath}`);
    return;
  }
  writeFileSync(file(relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readText(relativePath) {
  return readFileSync(file(relativePath), "utf8");
}

function writeText(relativePath, value) {
  if (dryRun) {
    console.log(`[release] would write ${relativePath}`);
    return;
  }
  writeFileSync(file(relativePath), value, "utf8");
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`Invalid semver version: ${value}`);
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function nextVersion(current, request) {
  const [major, minor, patch] = parseVersion(current);
  if (request === "patch") return `${major}.${minor}.${patch + 1}`;
  if (request === "minor") return `${major}.${minor + 1}.0`;
  if (request === "major") return `${major + 1}.0.0`;
  parseVersion(request);
  return request;
}

function git(args, fallback = "") {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

function releaseNotes(previousTag) {
  if (!previousTag) return [];
  const range = `${previousTag}..HEAD`;
  const output = git(["log", "--no-merges", "--format=%s", range]);
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^chore\(release\): prepare v?\d+\.\d+\.\d+$/i.test(line))
    .filter((line) => !/^chore\(site\): refresh release status/i.test(line))
    .slice(0, 12);
}

function updateChangelog(version, previousTag) {
  const relativePath = "CHANGELOG.md";
  const changelog = readText(relativePath);
  if (new RegExp(`^## ${version} \\u2014 `, "m").test(changelog)) {
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const notes = releaseNotes(previousTag);
  const bullets =
    notes.length > 0
      ? notes.map((line) => `- ${line}`)
      : [`- Prepared release ${version} from the current main branch.`];
  const previous = previousTag ? ` since ${previousTag}` : "";
  const section = `## ${version} \u2014 ${today}

Automated release preparation${previous}.

### Changed

${bullets.join("\n")}

`;

  writeText(relativePath, changelog.replace(/^# Changelog\n\n/, `# Changelog\n\n${section}`));
}

const pkg = readJson("package.json");
const currentVersion = pkg.version;
const version = nextVersion(currentVersion, requested);

if (compareVersions(version, currentVersion) <= 0) {
  throw new Error(`Next release version ${version} must be greater than ${currentVersion}`);
}

const previousTag = git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*"]);

pkg.version = version;
writeJson("package.json", pkg);

const lock = readJson("package-lock.json");
lock.version = version;
if (lock.packages?.[""]) lock.packages[""].version = version;
writeJson("package-lock.json", lock);

const dependencyLiteral = `"@ken-jo/agent-connector": "^${version}"`;
for (const relativePath of ["README.md", "tests/core/package-audit.test.ts"]) {
  const original = readText(relativePath);
  const updated = original.replace(
    /"@ken-jo\/agent-connector": "\^\d+\.\d+\.\d+"/g,
    dependencyLiteral,
  );
  if (updated === original) {
    throw new Error(`No agent-connector dependency literal updated in ${relativePath}`);
  }
  writeText(relativePath, updated);
}

updateChangelog(version, previousTag);

console.log(
  `[release] ${dryRun ? "would prepare" : "prepared"} v${version} from ${currentVersion}${previousTag ? ` after ${previousTag}` : ""}`,
);
