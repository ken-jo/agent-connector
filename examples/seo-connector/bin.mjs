#!/usr/bin/env node
/**
 * seo-connector-example — package-first wrapper for the runnable SEO example.
 *
 * package.json supplies name, mcpName, bin and version; this file exposes the
 * framework CLI under the package's own bin and auto-scopes every command
 * (install, doctor, secrets, auth …) to the adjacent connector config.
 */

import { createConnectorCli } from "@ken-jo/agent-connector/cli";

createConnectorCli({
  packageJson: new URL("./package.json", import.meta.url),
  connector: new URL("./agent-connector.config.mjs", import.meta.url),
})
  .run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`seo-connector-example: fatal: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
