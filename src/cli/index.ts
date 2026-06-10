/**
 * cli/index — the agent-connector bin entry.
 *
 * Intentionally tiny: it imports `main` from ./app.js and runs it
 * UNCONDITIONALLY. All helpers + dispatch live in ./app.ts (no side effects), so
 * command modules can import helpers without re-triggering the program, and the
 * auto-run survives bundler entry-splitting (no import.meta.url entry-guard).
 */

import { main } from "./app.js";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`agent-connector: fatal: ${message}\n`);
    process.exitCode = 1;
  });
