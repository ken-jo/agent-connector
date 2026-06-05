#!/usr/bin/env node
/**
 * acme-db — Acme's branded CLI, built on agent-connector.
 *
 * Every agent-connector subcommand is exposed under the `acme-db` brand and
 * AUTO-SCOPED to the connector shipped beside this file. The consumer runs
 * `acme-db install` / `acme-db leaderboard` / `acme-db telemetry` / `acme-db
 * doctor` — and never has to point at the connector with `--connector`.
 */

import { fileURLToPath } from "node:url";

import { createConnectorCli } from "agent-connector/cli";

const connectorPath = fileURLToPath(
  new URL("./agent-connector.config.mjs", import.meta.url),
);

createConnectorCli({
  name: "acme-db",
  connector: connectorPath,
})
  .run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`acme-db: fatal: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
