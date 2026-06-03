/**
 * core/surfaces-define-connector — validation + normalization of the three
 * content surfaces (commands / skills / subagents) in defineConnector.
 *
 * Covers: bad surface names throw; a skills-only connector is valid (the
 * server|hooks gate is relaxed); duplicate names within a surface throw;
 * required-field checks; normalization defaults each missing array to [].
 */

import { describe, expect, it } from "vitest";

import {
  ConnectorConfigError,
  defineConnector,
} from "../../src/core/define-connector.js";

describe("defineConnector — content-surface validation", () => {
  it("throws on a bad (non-kebab-case) command name", () => {
    for (const bad of ["Deploy", "has space", "-leading", "UP_CASE", ""]) {
      expect(() =>
        defineConnector({
          id: "acme",
          commands: [{ name: bad, prompt: "do it" }],
        }),
      ).toThrow(ConnectorConfigError);
    }
  });

  it("throws on a bad skill name and a bad subagent name", () => {
    expect(() =>
      defineConnector({
        id: "acme",
        skills: [{ name: "Bad Name", description: "x", body: "y" }],
      }),
    ).toThrow(ConnectorConfigError);
    expect(() =>
      defineConnector({
        id: "acme",
        subagents: [{ name: "Bad_Name", description: "x", prompt: "y" }],
      }),
    ).toThrow(ConnectorConfigError);
  });

  it("a skills-only connector is valid (no server, no hooks)", () => {
    const resolved = defineConnector({
      id: "skills-only",
      skills: [
        {
          name: "pdf-tools",
          description: "Extract text from PDFs.",
          body: "instructions",
        },
      ],
    });
    expect(resolved.server).toBeUndefined();
    expect(resolved.hookEvents).toEqual([]);
    expect(resolved.skills).toHaveLength(1);
    expect(resolved.skills[0]!.name).toBe("pdf-tools");
  });

  it("a commands-only and a subagents-only connector are each valid", () => {
    expect(() =>
      defineConnector({ id: "cmd-only", commands: [{ name: "go", prompt: "p" }] }),
    ).not.toThrow();
    expect(() =>
      defineConnector({
        id: "sub-only",
        subagents: [{ name: "rev", description: "d", prompt: "p" }],
      }),
    ).not.toThrow();
  });

  it("still throws when NONE of server|hooks|commands|skills|subagents is declared", () => {
    expect(() => defineConnector({ id: "empty" })).toThrow(ConnectorConfigError);
    // Empty arrays do not count as a declaration.
    expect(() =>
      defineConnector({ id: "empty2", commands: [], skills: [], subagents: [] }),
    ).toThrow(ConnectorConfigError);
  });

  it("throws on duplicate names within a surface array", () => {
    expect(() =>
      defineConnector({
        id: "dup-cmd",
        commands: [
          { name: "go", prompt: "a" },
          { name: "go", prompt: "b" },
        ],
      }),
    ).toThrow(ConnectorConfigError);
    expect(() =>
      defineConnector({
        id: "dup-skill",
        skills: [
          { name: "s", description: "d", body: "b" },
          { name: "s", description: "d2", body: "b2" },
        ],
      }),
    ).toThrow(ConnectorConfigError);
    expect(() =>
      defineConnector({
        id: "dup-sub",
        subagents: [
          { name: "a", description: "d", prompt: "p" },
          { name: "a", description: "d2", prompt: "p2" },
        ],
      }),
    ).toThrow(ConnectorConfigError);
  });

  it("the same name may be reused ACROSS different surfaces", () => {
    expect(() =>
      defineConnector({
        id: "cross",
        commands: [{ name: "shared", prompt: "p" }],
        skills: [{ name: "shared", description: "d", body: "b" }],
        subagents: [{ name: "shared", description: "d", prompt: "p" }],
      }),
    ).not.toThrow();
  });

  it("throws on missing/empty required fields", () => {
    // command prompt required
    expect(() =>
      defineConnector({ id: "c", commands: [{ name: "go", prompt: "" }] }),
    ).toThrow(ConnectorConfigError);
    // skill description required
    expect(() =>
      defineConnector({ id: "c", skills: [{ name: "s", description: "", body: "b" }] }),
    ).toThrow(ConnectorConfigError);
    // skill body required
    expect(() =>
      defineConnector({ id: "c", skills: [{ name: "s", description: "d", body: "" }] }),
    ).toThrow(ConnectorConfigError);
    // subagent description + prompt required
    expect(() =>
      defineConnector({ id: "c", subagents: [{ name: "a", description: "", prompt: "p" }] }),
    ).toThrow(ConnectorConfigError);
    expect(() =>
      defineConnector({ id: "c", subagents: [{ name: "a", description: "d", prompt: "" }] }),
    ).toThrow(ConnectorConfigError);
  });

  it("throws when a skill description exceeds 1024 chars", () => {
    expect(() =>
      defineConnector({
        id: "long",
        skills: [{ name: "s", description: "x".repeat(1025), body: "b" }],
      }),
    ).toThrow(ConnectorConfigError);
  });

  it("normalization defaults each missing surface array to []", () => {
    const resolved = defineConnector({
      id: "hooks-only",
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    });
    expect(resolved.commands).toEqual([]);
    expect(resolved.skills).toEqual([]);
    expect(resolved.subagents).toEqual([]);
  });

  it("passes surface content through verbatim (tools, model, resources, extra)", () => {
    const resolved = defineConnector({
      id: "verbatim",
      commands: [
        {
          name: "go",
          prompt: "p",
          description: "d",
          argumentHint: "[x]",
          tools: { allow: ["Bash"] },
          model: "sonnet",
          extra: { custom: 1 },
        },
      ],
      skills: [
        {
          name: "s",
          description: "d",
          body: "b",
          resources: { "a.txt": "hi" },
        },
      ],
    });
    expect(resolved.commands[0]).toMatchObject({
      name: "go",
      argumentHint: "[x]",
      tools: { allow: ["Bash"] },
      model: "sonnet",
      extra: { custom: 1 },
    });
    expect(resolved.skills[0]!.resources).toEqual({ "a.txt": "hi" });
  });
});
