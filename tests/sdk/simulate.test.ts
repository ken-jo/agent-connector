/**
 * tests/sdk/simulate — the real adapter parse→handler→format chain, inline.
 *
 * The trustworthy part of the harness: it runs the connector's handler through
 * the ACTUAL host adapter and reports whether the host honors the response.
 *
 *   • statusline on claude-code → honored:true, hostReply carries the rendered
 *     string; a throwing render → honored:false (fail-safe).
 *   • UserPromptSubmit "context" → honored:true on claude-code (it has a stdout
 *     additionalContext path) but honored:FALSE on codex — the DOCUMENTED gap
 *     (codex has no UserPromptSubmit context stdout path, so the injection is
 *     silently dropped).
 *   • hooks on an mcp-only host (warp) → honored:false ("no hook runtime").
 *   • a PreToolUse deny → honored:true on claude-code (the block shape is on
 *     stdout); an allow/void handler → honored:true (pass-through).
 */

import { describe, expect, it } from "vitest";

import { defineConnector } from "../../src/sdk/index.js";
import { simulate } from "../../src/sdk/test.js";

// A connector that injects context on every user prompt — the surface that
// claude-code honors and codex silently drops.
function contextConnector() {
  return defineConnector({
    id: "sim-ctx",
    hooks: {
      UserPromptSubmit: {
        handler: () => ({
          decision: "context",
          additionalContext: "INJECTED-GUIDANCE-TOKEN",
        }),
      },
    },
  });
}

describe("simulate — statusline", () => {
  const connector = defineConnector({
    id: "sim-status",
    statusline: { render: (ctx) => `model=${ctx.model?.id ?? "?"}` },
  });

  it("renders on claude-code and carries the rendered string", async () => {
    const result = await simulate(connector, {
      surface: "statusline",
      host: "claude-code",
      input: JSON.stringify({ model: { id: "claude-x" }, session_id: "s1" }),
    });
    expect(result.honored).toBe(true);
    expect(result.hostReply).toContain("model=claude-x");
    expect(result.reason).toBe("rendered");
  });

  it("is fail-safe when render throws", async () => {
    const throwing = defineConnector({
      id: "sim-throw",
      statusline: {
        render: () => {
          throw new Error("boom");
        },
      },
    });
    const result = await simulate(throwing, {
      surface: "statusline",
      host: "claude-code",
      input: "{}",
    });
    expect(result.honored).toBe(false);
    expect(result.reason).toMatch(/render threw: boom/);
  });

  it("reports no statusline surface on a non-supporting host", async () => {
    const result = await simulate(connector, {
      surface: "statusline",
      host: "codex",
      input: "{}",
    });
    expect(result.honored).toBe(false);
    expect(result.reason).toMatch(/no statusline surface/);
  });
});

describe("simulate — hooks (the context-drop gap)", () => {
  it("honors UserPromptSubmit context on claude-code", async () => {
    const result = await simulate(contextConnector(), {
      surface: "hooks",
      host: "claude-code",
      event: "UserPromptSubmit",
      input: JSON.stringify({ prompt: "hi", session_id: "s1" }),
    });
    expect(result.honored).toBe(true);
    expect(result.hostReply).toContain("INJECTED-GUIDANCE-TOKEN");
  });

  it("does NOT honor UserPromptSubmit context on codex (the documented gap)", async () => {
    const result = await simulate(contextConnector(), {
      surface: "hooks",
      host: "codex",
      event: "UserPromptSubmit",
      input: JSON.stringify({ prompt: "hi", session_id: "s1" }),
    });
    expect(result.honored).toBe(false);
    expect(result.reason).toMatch(/codex drops context on UserPromptSubmit/);
  });
});

describe("simulate — hooks (other paths)", () => {
  it("reports no hook runtime on an mcp-only host", async () => {
    const result = await simulate(contextConnector(), {
      surface: "hooks",
      host: "warp",
      event: "UserPromptSubmit",
      input: "{}",
    });
    expect(result.honored).toBe(false);
    expect(result.reason).toMatch(/no hook runtime \(mcp-only\)/);
  });

  it("reports the missing-handler case", async () => {
    const result = await simulate(contextConnector(), {
      surface: "hooks",
      host: "claude-code",
      event: "PreToolUse",
      input: "{}",
    });
    expect(result.honored).toBe(false);
    expect(result.reason).toMatch(/connector declares no PreToolUse handler/);
  });

  it("honors a PreToolUse deny on claude-code (block shape on stdout)", async () => {
    const denier = defineConnector({
      id: "sim-deny",
      hooks: {
        PreToolUse: {
          handler: () => ({ decision: "deny", reason: "nope" }),
        },
      },
    });
    const result = await simulate(denier, {
      surface: "hooks",
      host: "claude-code",
      event: "PreToolUse",
      input: JSON.stringify({ tool_name: "Bash", tool_input: {} }),
    });
    expect(result.honored).toBe(true);
    expect(result.hostReply).toMatch(/deny/);
  });

  it("honors a pass-through allow / void handler", async () => {
    const passthrough = defineConnector({
      id: "sim-allow",
      hooks: {
        PostToolUse: {
          handler: () => undefined,
        },
      },
    });
    const result = await simulate(passthrough, {
      surface: "hooks",
      host: "claude-code",
      event: "PostToolUse",
      input: JSON.stringify({ tool_name: "Bash", tool_input: {} }),
    });
    expect(result.honored).toBe(true);
    expect(result.reason).toBe("pass-through allow");
  });

  it("errors clearly when event is missing for a hooks simulate", async () => {
    const result = await simulate(contextConnector(), {
      surface: "hooks",
      host: "claude-code",
      input: "{}",
    });
    expect(result.honored).toBe(false);
    expect(result.reason).toMatch(/event is required/);
  });

  it("reports an unknown host", async () => {
    const result = await simulate(contextConnector(), {
      surface: "hooks",
      host: "nope",
      event: "UserPromptSubmit",
      input: "{}",
    });
    expect(result.honored).toBe(false);
    expect(result.reason).toMatch(/unknown host/);
  });
});

describe("simulate — parse-based verdicts (not substring/word matching)", () => {
  it("Stop deny → honored:true but reason says CONTINUES (persistence), not blocks", async () => {
    // claude-code renders a Stop deny as the TOP-LEVEL {decision:"block"} which
    // KEEPS the session running — the semantic OPPOSITE of a block. The verdict
    // must call that out, not label it "blocks".
    const ralph = defineConnector({
      id: "sim-stop",
      hooks: {
        Stop: { handler: () => ({ decision: "deny", reason: "keep going" }) },
      },
    });
    const result = await simulate(ralph, {
      surface: "hooks",
      host: "claude-code",
      event: "Stop",
      input: JSON.stringify({ session_id: "s1" }),
    });
    expect(result.honored).toBe(true);
    expect(result.reason).toMatch(/continues/i);
    expect(result.reason).toMatch(/persistence/i);
    expect(result.reason).not.toMatch(/\bblocks\b/);
  });

  it("context with newline + backslash + quote → honored via DECODED-field compare", async () => {
    // A naive stdout.includes() breaks when the additionalContext contains a
    // newline / Windows path / double-quote (JSON-escaped in the serialized
    // reply). Comparing the DECODED field instead is robust.
    const gnarly = 'line1\nC:\\Users\\dev "x"';
    const connector = defineConnector({
      id: "sim-gnarly",
      hooks: {
        UserPromptSubmit: {
          handler: () => ({ decision: "context", additionalContext: gnarly }),
        },
      },
    });
    const result = await simulate(connector, {
      surface: "hooks",
      host: "claude-code",
      event: "UserPromptSubmit",
      input: JSON.stringify({ prompt: "hi", session_id: "s1" }),
    });
    expect(result.honored).toBe(true);
    // and the decoded reply really does carry the exact text.
    expect(JSON.parse(result.hostReply ?? "{}").hookSpecificOutput.additionalContext).toBe(
      gnarly,
    );
  });

  it("SubagentStart deny (reason contains the word 'block') → honored:FALSE (degraded to context)", async () => {
    // The handler's reason text literally contains "block"; a word-matching
    // judge would wrongly call this a block. claude-code DEGRADES a SubagentStart
    // deny to an additionalContext note — the spawn is not blocked.
    const connector = defineConnector({
      id: "sim-subdeny",
      hooks: {
        SubagentStart: {
          handler: () => ({ decision: "deny", reason: "we should block this" }),
        },
      },
    });
    const result = await simulate(connector, {
      surface: "hooks",
      host: "claude-code",
      event: "SubagentStart",
      input: JSON.stringify({ agent_type: "reviewer", session_id: "s1" }),
    });
    expect(result.honored).toBe(false);
    expect(result.reason).toMatch(/context note/);
    expect(result.reason).toMatch(/not blocked/);
  });

  it("PermissionRequest ask on claude-code (no stdout) → honored:true (native dialog)", async () => {
    const connector = defineConnector({
      id: "sim-ask",
      hooks: {
        PermissionRequest: { handler: () => ({ decision: "ask", reason: "confirm?" }) },
      },
    });
    const result = await simulate(connector, {
      surface: "hooks",
      host: "claude-code",
      event: "PermissionRequest",
      input: JSON.stringify({ tool_name: "Bash", tool_input: {} }),
    });
    expect(result.honored).toBe(true);
    expect(result.reason).toMatch(/native confirmation dialog/);
  });

  it("matcher-scoped PreToolUse not matching the tool → handler NOT run, honored:true", async () => {
    let ran = false;
    const connector = defineConnector({
      id: "sim-matcher",
      hooks: {
        PreToolUse: {
          matcher: "Bash",
          handler: () => {
            ran = true;
            return { decision: "deny", reason: "no bash" };
          },
        },
      },
    });
    const result = await simulate(connector, {
      surface: "hooks",
      host: "claude-code",
      event: "PreToolUse",
      input: JSON.stringify({ tool_name: "Read", tool_input: {} }),
    });
    expect(ran).toBe(false);
    expect(result.honored).toBe(true);
    expect(result.reason).toMatch(/matcher excludes Read \(handler not run\)/);
  });

  it("PreToolUse modify → honored:true when the decoded updatedInput deep-equals", async () => {
    const updatedInput = { command: "echo safe", flags: ["--dry-run"] };
    const connector = defineConnector({
      id: "sim-modify",
      hooks: {
        PreToolUse: {
          handler: () => ({ decision: "modify", updatedInput }),
        },
      },
    });
    const result = await simulate(connector, {
      surface: "hooks",
      host: "claude-code",
      event: "PreToolUse",
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
    });
    expect(result.honored).toBe(true);
    expect(result.reason).toMatch(/rewrites tool input/);
  });
});
