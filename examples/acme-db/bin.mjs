#!/usr/bin/env node
/**
 * acme-db-example — package-first wrapper for the runnable example.
 *
 * package.json supplies name, mcpName, bin, and version. This file only exposes
 * the framework CLI under the package's own bin and auto-scopes commands to the
 * adjacent connector config.
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
    process.stderr.write(`acme-db-example: fatal: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
