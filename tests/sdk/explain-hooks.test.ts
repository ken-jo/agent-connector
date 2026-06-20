/**
 * tests/sdk/explain-hooks — the per-(host, event) hook honor matrix.
 *
 * The trustworthy detail behind `doctor --explain`: for each DECLARED event it
 * classifies every target host as
 *   • honored  — the host fires the event AND carries the response intent;
 *   • degraded — the host fires it but silently DROPS the decision (codex
 *                drops a UserPromptSubmit context injection / a Stop deny);
 *   • dropped  — the host cannot fire the event at all (no native equivalent,
 *                e.g. crush/Stop) or has no hook runtime (mcp-only, e.g. warp).
 *
 * It RUNS the real adapter parse→handler→format chain via simulate() and reuses
 * the per-event capability signal — no per-event honor logic is re-derived.
 */

import { describe, expect, it } from "vitest";

import { defineConnector } from "../../src/sdk/index.js";
import { explainHooks } from "../../src/sdk/test.js";

describe("explainHooks — honored / degraded / dropped", () => {
  function stopOnly() {
    return defineConnector({
      id: "eh-stop-only",
      hooks: {
        Stop: { handler: () => ({ decision: "deny", reason: "keep going" }) },
      },
    });
  }

  it("classifies a Stop deny per host (the trustworthy per-event verdict)", async () => {
    const rows = await explainHooks(stopOnly(), [
      "claude-code",
      "codex",
      "crush",
      "warp",
    ]);
    const by = (host: string) => rows.find((r) => r.host === host)!;

    // claude-code fires Stop and carries the continuation intent → honored.
    expect(by("claude-code").verdict).toBe("honored");
    // codex fires Stop but drops the deny (fails open) → degraded.
    expect(by("codex").verdict).toBe("degraded");
    expect(by("codex").reason).toMatch(/codex drops deny on Stop/);
    // crush has NO Stop equivalent → dropped (the false-green host).
    expect(by("crush").verdict).toBe("dropped");
    expect(by("crush").reason).toMatch(/no Stop equivalent/);
    // warp is mcp-only → dropped.
    expect(by("warp").verdict).toBe("dropped");
    expect(by("warp").reason).toMatch(/no hook runtime \(mcp-only\)/);
  });

  it("surfaces the codex UserPromptSubmit context drop as degraded", async () => {
    const ctx = defineConnector({
      id: "eh-ctx",
      hooks: {
        UserPromptSubmit: {
          handler: () => ({ decision: "context", additionalContext: "X" }),
        },
      },
    });
    const rows = await explainHooks(ctx, ["claude-code", "codex"]);
    const claude = rows.find((r) => r.host === "claude-code")!;
    const codex = rows.find((r) => r.host === "codex")!;
    expect(claude.verdict).toBe("honored");
    expect(codex.verdict).toBe("degraded");
    expect(codex.reason).toMatch(/codex drops context on UserPromptSubmit/);
  });

  it("plants a matcher-satisfying subject so a matcher-gated hook actually runs", async () => {
    const guarded = defineConnector({
      id: "eh-guarded",
      hooks: {
        PreToolUse: {
          matcher: "acme_query",
          handler: (event) => {
            const sql = String(
              (event.toolInput && event.toolInput["sql"]) ?? "",
            ).toLowerCase();
            return /drop\s+table/.test(sql)
              ? { decision: "deny", reason: "blocked" }
              : { decision: "allow" };
          },
        },
      },
    });
    const rows = await explainHooks(guarded, ["claude-code"]);
    const claude = rows.find((r) => r.host === "claude-code")!;
    // The synthetic subject matches "acme_query", so the handler RAN (and allowed
    // the benign synthetic command) — NOT a spurious "matcher excludes" verdict.
    expect(claude.verdict).toBe("honored");
    expect(claude.reason).toBe("pass-through allow");
  });

  it("returns rows sorted by host then event", async () => {
    const both = defineConnector({
      id: "eh-both",
      hooks: {
        PreToolUse: { handler: () => ({ decision: "allow" }) },
        Stop: { handler: () => ({ decision: "deny", reason: "x" }) },
      },
    });
    const rows = await explainHooks(both, ["codex", "claude-code"]);
    const keys = rows.map((r) => `${r.host} ${r.event}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("reports an unknown host as dropped for every declared event", async () => {
    const rows = await explainHooks(stopOnly(), ["nope"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe("dropped");
    expect(rows[0]!.reason).toMatch(/unknown host/);
  });

  it("returns no rows for a connector that declares no hooks", async () => {
    const noHooks = defineConnector({
      id: "eh-none",
      server: { transport: "stdio", command: "node" },
    });
    const rows = await explainHooks(noHooks, ["claude-code", "codex"]);
    expect(rows).toEqual([]);
  });
});
