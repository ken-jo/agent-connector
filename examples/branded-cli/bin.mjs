#!/usr/bin/env node
/**
 * acme-db — Acme's branded CLI, built on agent-connector.
 *
 * Every agent-connector subcommand is exposed under the `acme-db` brand and
 * AUTO-SCOPED to the connector shipped beside this file. The consumer runs
 * `acme-db install` / `acme-db leaderboard` / `acme-db telemetry` / `acme-db
 * doctor` — and never has to point at the connector with `--connector`.
 */

import { createConnectorCli } from "@ken-jo/agent-connector/cli";

createConnectorCli({
  // Public identity comes from package.json; do not repeat it in the config.
  packageJson: new URL("./package.json", import.meta.url),
  // Behavior comes from the connector config. This is not a second id source.
  connector: new URL("./agent-connector.config.mjs", import.meta.url),
})
  .run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`acme-db: fatal: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
