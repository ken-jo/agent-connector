/**
 * tests/sdk/define-helpers — the `define*` typed-identity family.
 *
 * Each helper is a one-line identity function: it returns its argument UNCHANGED
 * (===, not a copy) and does NOT validate (validation stays in defineConnector).
 * We assert the runtime identity AND that the returned value flows back into a
 * real defineConnector() so the type plumbing is exercised end-to-end.
 */

import { describe, expect, it } from "vitest";

import {
  defineCommand,
  defineConfigPatch,
  defineConnector,
  defineHook,
  defineMemory,
  defineNativeHook,
  defineSkill,
  defineStatusline,
  defineSubagent,
} from "../../src/sdk/index.js";

describe("define* identity helpers", () => {
  it("each helper returns its argument unchanged (same reference)", () => {
    const hook = { handler: () => ({ decision: "allow" as const }) };
    // defineHook is event-parameterized: the leading event tag infers the
    // handler's payload type; the def is returned UNCHANGED (same reference).
    expect(defineHook("PreToolUse", hook)).toBe(hook);

    const command = { name: "deploy", prompt: "Deploy {env}" };
    expect(defineCommand(command)).toBe(command);

    const skill = { name: "lint", description: "Lint the repo", body: "# Lint" };
    expect(defineSkill(skill)).toBe(skill);

    const subagent = { name: "reviewer", description: "Reviews code", prompt: "Review." };
    expect(defineSubagent(subagent)).toBe(subagent);

    const memory = { name: "house-rules", content: "Be terse." };
    expect(defineMemory(memory)).toBe(memory);

    const patch = { key: "statusLine", value: { type: "command" }, reason: "HUD" };
    expect(defineConfigPatch(patch)).toBe(patch);

    const native = { handler: () => ({ continue: false }) };
    expect(defineNativeHook(native)).toBe(native);

    const statusline = { render: () => "hello" };
    expect(defineStatusline(statusline)).toBe(statusline);
  });

  it("does NOT validate (an invalid shape passes through untouched)", () => {
    // A name that defineConnector would reject still passes through here —
    // the helpers are pure identity, validation is centralized.
    const bad = { name: "Not Kebab Case", prompt: "x" };
    expect(defineCommand(bad)).toBe(bad);
  });

  it("the returned defs assemble into a real connector", () => {
    const connector = defineConnector({
      id: "helpers-demo",
      hooks: {
        UserPromptSubmit: defineHook("UserPromptSubmit", {
          handler: () => ({ decision: "context", additionalContext: "hi" }),
        }),
        PreToolUse: defineHook("PreToolUse", {
          // the event tag narrows evt to a PreToolUseEvent (evt.toolName typed).
          handler: (evt) =>
            evt.toolName === "Bash" ? { decision: "deny", reason: "no" } : undefined,
        }),
      },
      commands: [defineCommand({ name: "go", prompt: "Go." })],
      skills: [defineSkill({ name: "s", description: "A skill", body: "# s" })],
      subagents: [defineSubagent({ name: "a", description: "An agent", prompt: "Do." })],
      memory: [defineMemory({ name: "m", content: "Remember." })],
      statusline: defineStatusline({ render: () => "line" }),
      platforms: {
        "claude-code": {
          configPatch: [
            defineConfigPatch({
              key: "env.SOME_FLAG",
              value: "1",
              reason: "enable flag",
            }),
          ],
          nativeHooks: {
            TaskCreated: defineNativeHook({ handler: () => ({ continue: true }) }),
          },
        },
      },
    });

    expect(connector.id).toBe("helpers-demo");
    expect(connector.commands).toHaveLength(1);
    expect(connector.statusline?.name).toBe("statusline");
    expect(connector.hookEvents).toContain("UserPromptSubmit");
  });
});
