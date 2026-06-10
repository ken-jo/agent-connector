/**
 * cli/commands/upgrade — bring an agentconnect install current.
 *
 * `upgrade` (aliases: `update`, `sync`) consolidates the two former verbs into
 * ONE the way npm/brew pair `install` + `upgrade`, so there is a single verb to
 * learn for "make everything current". It:
 *
 *   1. re-renders the connector's config into every target host idempotently
 *      (identical entries report "skip"), exactly like the old `sync` — this is
 *      also the self-heal path: run `upgrade` to repair a drifted install; then
 *   2. refreshes the stable home-bin pointer and prints managed (never-silent)
 *      update guidance for the chosen channel, exactly like the old `update`.
 *
 * When no connector config is resolvable it still does step 2, so `upgrade`
 * works as a pure tool-refresh from anywhere. By design agentconnect NEVER
 * silently auto-updates (docs/ARCHITECTURE.md §3 R1).
 */

import { parseArgs } from "node:util";

import { resolveCliEntry, syncConnector } from "../../core/installer.js";
import { findConnectorConfig, loadConnectorFromPath } from "../../core/load-connector.js";
import { ensureHomeBin, homeBinPath } from "../../core/paths.js";
import { fail, parseScope, parseTargets, print, renderInstallResult } from "../app.js";

type Channel = "stable" | "latest";

/** Heuristic: does the running CLI live under an npm-style node_modules tree? */
function looksNpmManaged(): boolean {
  const entry = resolveCliEntry().replace(/\\/g, "/");
  return entry.includes("/node_modules/");
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      channel: { type: "string", default: "stable" },
      scope: { type: "string", default: "user" },
      targets: { type: "string" },
      connector: { type: "string" },
      project: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const channel = values.channel;
  if (channel !== "stable" && channel !== "latest") {
    return fail(`invalid --channel "${channel}" (use stable|latest)`);
  }
  const ch: Channel = channel;

  const scope = parseScope(values.scope);
  if (scope == null) return fail(`invalid --scope "${values.scope}" (use user|project)`);

  let hadWarn = false;

  // ── Step 1: re-render the connector into every target host (former `sync`). ──
  const projectDir = values.project ?? process.cwd();
  const configPath = values.connector ?? findConnectorConfig(projectDir);
  if (configPath) {
    const { connector, modulePath } = await loadConnectorFromPath(configPath);
    const targets = parseTargets(values.targets);
    const result = await syncConnector({
      connector,
      modulePath,
      scope,
      projectDir,
      dryRun: values["dry-run"],
      ...(targets ? { targets } : {}),
    });
    print(renderInstallResult(result, "upgrade"));
    if (result.changes.some((c) => c.action === "warn")) hadWarn = true;
    print("");
  } else {
    print("upgrade: no connector config found — refreshing the tool only.");
    print(
      "(pass --connector <path> or run inside a project to also re-render host config.)\n",
    );
  }

  // ── Step 2: managed update guidance + home-bin pointer refresh (former `update`). ──
  print("agentconnect uses managed (explicit) updates — never silent");
  print("auto-update — so one bad release can't break every project at once.\n");

  const dist = ch === "stable" ? "latest" : "next";
  if (looksNpmManaged()) {
    print(`To update the ${ch} channel, run:`);
    print(`  npm i -g agentconnect@${dist}`);
  } else {
    print(
      `This install does not look npm-managed. Update it the way you installed it,`,
    );
    print(`then re-run \`agentconnect upgrade\` to refresh the home pointer.`);
    print(`(npm installs would use: npm i -g agentconnect@${dist})`);
  }

  // Refresh the stable home-bin pointer so hosts keep execing a working CLI.
  if (!values["dry-run"]) {
    try {
      const binPath = ensureHomeBin(resolveCliEntry());
      print(`\nRefreshed home binary pointer: ${binPath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      print(`\n[warn] could not refresh home binary at ${homeBinPath()}: ${message}`);
      return 1;
    }
  }

  return hadWarn ? 1 : 0;
}
