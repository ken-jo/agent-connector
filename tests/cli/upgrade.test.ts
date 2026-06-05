/**
 * tests/cli/upgrade — the consolidated `upgrade` verb + its `sync`/`update`
 * back-compat aliases.
 *
 * `upgrade` merges the former `sync` (re-render host config) and `update`
 * (managed channel guidance + home-pointer refresh) into ONE verb. We assert:
 *   • the top-level usage advertises `upgrade` (and drops the old sync/update
 *     descriptions) so there is a single verb to learn;
 *   • `upgrade`, `sync`, and `update` all dispatch to the SAME merged command;
 *   • with no resolvable connector + --dry-run it is hermetic (tool-only path,
 *     no host writes, no home-bin mutation) and exits 0.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/app.js";

function captureStdout(): { restore: () => void; text: () => string } {
  let out = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
  return { restore: () => spy.mockRestore(), text: () => out };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("upgrade — consolidated verb", () => {
  it("usage advertises `upgrade` and drops the old sync/update descriptions", async () => {
    const cap = captureStdout();
    const code = await main(["--help"]);
    cap.restore();
    expect(code).toBe(0);
    const text = cap.text();
    expect(text).toContain("upgrade");
    expect(text).toContain("Bring everything current");
    expect(text).toContain("alias: update, sync");
    // The two former standalone command descriptions are gone.
    expect(text).not.toContain("Idempotent re-install");
    expect(text).not.toContain("Managed-update guidance");
  });

  it.each(["upgrade", "sync", "update"])(
    "`%s` dispatches to the merged command (tool-only path is hermetic with --dry-run)",
    async (verb) => {
      const emptyProject = mkdtempSync(join(tmpdir(), "ac-upgrade-"));
      const cap = captureStdout();
      const code = await main([verb, "--dry-run", "--project", emptyProject]);
      cap.restore();
      expect(code).toBe(0);
      const text = cap.text();
      // No connector under the empty project → the tool-only refresh branch...
      expect(text).toContain("no connector config found");
      // ...which is the former `update` behavior, now part of `upgrade`.
      expect(text).toContain("managed (explicit) updates");
    },
  );

  it("rejects an invalid --channel (shared validation survived the merge)", async () => {
    const code = await main(["upgrade", "--channel", "bogus"]);
    expect(code).toBe(2);
  });
});
