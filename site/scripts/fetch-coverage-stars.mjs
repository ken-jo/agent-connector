/**
 * Build-time GitHub-stars refresh for the coverage rank tiers.
 *
 * Wired as the `prebuild` npm script, so `npm run build` refreshes star counts
 * each deploy. It:
 *   1. transpiles src/platform-data.ts (dependency-free data module) to read
 *      `coverageRepos` — the verified OSS "owner/name" list, single-sourced
 *      there alongside the closed/OSS classification;
 *   2. fetches each repo's stargazers_count from the GitHub API (unauthenticated
 *      is fine for ~26 repos; uses GITHUB_TOKEN / GH_TOKEN if present for a
 *      higher rate limit);
 *   3. writes src/coverage-stars.generated.json ({ "owner/name": 12345, ... }).
 *
 * Determinism + offline/rate-limit safety: the generated JSON is COMMITTED as a
 * snapshot. On a failed fetch (network down, 403 rate-limit, transient error)
 * the script KEEPS the existing snapshot value for that repo, so the build
 * never breaks and every host always renders a tier. A repo missing from BOTH
 * the live fetch and the snapshot is written as 0 (→ Bronze) and warned, never
 * fatal. This is a justified build-determinism fallback, not an ad-hoc shim.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(siteDir, "src", "coverage-stars.generated.json");

/** Transpile + evaluate a dependency-free TS data module, returning exports. */
function loadTsDataModule(relPath) {
  const file = path.join(siteDir, relPath);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const mod = { exports: {} };
  new Function("exports", "module", "require", outputText)(mod.exports, mod, () => {
    throw new Error(`${relPath} unexpectedly has runtime imports`);
  });
  return mod.exports;
}

const { coverageRepos } = loadTsDataModule("src/platform-data.ts");
if (!Array.isArray(coverageRepos) || coverageRepos.length === 0) {
  throw new Error("[stars] platform-data.ts exported no coverageRepos");
}

/** Existing committed snapshot (fallback source), or {} on first run. */
const snapshot = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "agent-connector-site-build",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

async function fetchStars(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const stars = json?.stargazers_count;
  if (typeof stars !== "number") throw new Error("no stargazers_count");
  return stars;
}

const result = {};
let fetched = 0;
let kept = 0;

await Promise.all(
  coverageRepos.map(async (repo) => {
    try {
      result[repo] = await fetchStars(repo);
      fetched++;
    } catch (err) {
      if (repo in snapshot) {
        result[repo] = snapshot[repo];
        kept++;
        console.warn(`[stars] ${repo}: fetch failed (${err.message}); kept snapshot ${snapshot[repo]}`);
      } else {
        result[repo] = 0;
        console.warn(`[stars] ${repo}: fetch failed (${err.message}) and no snapshot; defaulting to 0 (Bronze)`);
      }
    }
  }),
);

// Stable key order for a clean, reviewable diff.
const ordered = Object.fromEntries(Object.keys(result).sort().map((k) => [k, result[k]]));
writeFileSync(OUT, JSON.stringify(ordered, null, 2) + "\n");
console.log(
  `[stars] wrote ${path.relative(siteDir, OUT)} — ${Object.keys(ordered).length} repos (${fetched} fetched, ${kept} from snapshot)`,
);
