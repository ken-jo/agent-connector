/**
 * cli/commands/update — managed-update guidance + stable-pointer refresh.
 *
 * By design (docs/ARCHITECTURE.md §3 R1) agent-connector NEVER silently
 * auto-updates: a forced single-binary update means one bad release breaks every
 * project × every platform at once. Instead this command:
 *
 *   1. Prints managed-update guidance for the chosen channel (stable | latest),
 *      including the exact `npm i -g agent-connector@<channel>` command when the
 *      install looks npm-managed.
 *   2. Refreshes the stable home-bin pointer (ensureHomeBin) so every host's
 *      pointer config keeps execing a working CLI after an update.
 */

import { parseArgs } from "node:util";

import { resolveCliEntry } from "../../core/installer.js";
import { ensureHomeBin, homeBinPath } from "../../core/paths.js";
import { fail, print } from "../app.js";

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
    },
    allowPositionals: false,
  });

  const channel = values.channel;
  if (channel !== "stable" && channel !== "latest") {
    return fail(`invalid --channel "${channel}" (use stable|latest)`);
  }
  const ch: Channel = channel;

  print("agent-connector uses managed (explicit) updates — never silent");
  print("auto-update — so one bad release can't break every project at once.\n");

  const dist = ch === "stable" ? "latest" : "next";
  if (looksNpmManaged()) {
    print(`To update the ${ch} channel, run:`);
    print(`  npm i -g agent-connector@${dist}`);
  } else {
    print(
      `This install does not look npm-managed. Update it the way you installed it,`,
    );
    print(`then re-run \`agent-connector update\` to refresh the home pointer.`);
    print(`(npm installs would use: npm i -g agent-connector@${dist})`);
  }

  // Refresh the stable home-bin pointer so hosts keep execing a working CLI.
  try {
    const binPath = ensureHomeBin(resolveCliEntry());
    print(`\nRefreshed home binary pointer: ${binPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    print(`\n[warn] could not refresh home binary at ${homeBinPath()}: ${message}`);
    return 1;
  }

  return 0;
}
