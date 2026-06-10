import { describe, it, expect } from "vitest";
import {
  buildNodeCommand,
  parseNodeCommand,
  quoteArg,
  buildHomeBinHookCommand,
  buildServeWrapperCommand,
} from "../../src/core/spawn.js";

describe("buildNodeCommand + parseNodeCommand round-trip", () => {
  it("round-trips a simple node + script path", () => {
    const cmd = buildNodeCommand("/usr/local/lib/cli.js", {
      nodePath: "/usr/bin/node",
    });
    expect(cmd).toBe(`"/usr/bin/node" "/usr/local/lib/cli.js"`);
    const parsed = parseNodeCommand(cmd);
    expect(parsed).toEqual({
      nodePath: "/usr/bin/node",
      scriptPath: "/usr/local/lib/cli.js",
    });
  });

  it("#548 regression: a scriptPath containing spaces still parses to exactly two tokens", () => {
    const nodePath = "/usr/bin/node";
    const scriptPath = "/Users/Jane Doe/My Apps/agent connect/cli.js";
    const cmd = buildNodeCommand(scriptPath, { nodePath });
    expect(cmd).toBe(`"${nodePath}" "${scriptPath}"`);

    const parsed = parseNodeCommand(cmd);
    expect(parsed).not.toBeNull();
    // The whole space-containing path must come back as ONE token, unsplit
    // and not doubled (the #548 doubled-path bug).
    expect(parsed).toEqual({ nodePath, scriptPath });
    expect(parsed!.scriptPath).toBe(scriptPath);
  });

  it("normalizes backslashes to forward slashes (Windows/MSYS safety) and still round-trips", () => {
    const cmd = buildNodeCommand("C:\\Apps\\agent connect\\cli.js", {
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
    });
    expect(cmd).toBe(
      `"C:/Program Files/nodejs/node.exe" "C:/Apps/agent connect/cli.js"`,
    );
    const parsed = parseNodeCommand(cmd);
    expect(parsed).toEqual({
      nodePath: "C:/Program Files/nodejs/node.exe",
      scriptPath: "C:/Apps/agent connect/cli.js",
    });
  });

  it("defaults nodePath to process.execPath when not supplied", () => {
    const cmd = buildNodeCommand("/some/script.js");
    const expectedNode = process.execPath.replace(/\\/g, "/");
    expect(cmd).toBe(`"${expectedNode}" "/some/script.js"`);
    const parsed = parseNodeCommand(cmd);
    expect(parsed).toEqual({
      nodePath: expectedNode,
      scriptPath: "/some/script.js",
    });
  });
});

describe("parseNodeCommand rejects malformed input", () => {
  it("returns null on a bare/unquoted command", () => {
    expect(parseNodeCommand("node /some/script.js")).toBeNull();
  });

  it("returns null on a single quoted token (only one path)", () => {
    expect(parseNodeCommand(`"/usr/bin/node"`)).toBeNull();
  });

  it("returns null on the empty string", () => {
    expect(parseNodeCommand("")).toBeNull();
  });

  it("returns null when only the second token is quoted", () => {
    expect(parseNodeCommand(`node "/some/script.js"`)).toBeNull();
  });

  it("returns null on three quoted tokens (trailing junk)", () => {
    expect(parseNodeCommand(`"/a" "/b" "/c"`)).toBeNull();
  });
});

describe("quoteArg", () => {
  it("wraps an argument in double quotes and forward-slashes it", () => {
    expect(quoteArg("C:\\path\\bin")).toBe(`"C:/path/bin"`);
    expect(quoteArg("/home/user/bin")).toBe(`"/home/user/bin"`);
  });
});

describe("buildHomeBinHookCommand", () => {
  it("formats `\"<homeBin>\" hook <platform> <event> --connector <id>`", () => {
    const cmd = buildHomeBinHookCommand(
      "/home/u/.agentconnect/bin/agentconnect",
      "claude-code",
      "PreToolUse",
      "acme-db",
    );
    expect(cmd).toBe(
      `"/home/u/.agentconnect/bin/agentconnect" hook claude-code PreToolUse --connector acme-db`,
    );
  });

  it("quotes (and forward-slashes) the home binary path", () => {
    const cmd = buildHomeBinHookCommand(
      "C:\\Users\\Jane\\.agentconnect\\bin\\agentconnect.cmd",
      "cursor",
      "PostToolUse",
      "my-conn",
    );
    expect(cmd).toBe(
      `"C:/Users/Jane/.agentconnect/bin/agentconnect.cmd" hook cursor PostToolUse --connector my-conn`,
    );
  });
});

describe("buildServeWrapperCommand", () => {
  it("returns command + args with the '--' separator before the real command", () => {
    const { command, args } = buildServeWrapperCommand(
      "/home/u/.agentconnect/bin/agentconnect",
      "acme-db",
      "npx",
      ["-y", "@acme/db-mcp"],
    );
    expect(command).toBe("/home/u/.agentconnect/bin/agentconnect");
    expect(args).toEqual([
      "serve",
      "--connector",
      "acme-db",
      "--",
      "npx",
      "-y",
      "@acme/db-mcp",
    ]);
  });

  it("places '--' immediately before the real command and keeps real args after it", () => {
    const { args } = buildServeWrapperCommand(
      "/bin/ac",
      "c1",
      "node",
      ["server.js", "--port", "3000"],
    );
    const sep = args.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    expect(args[sep + 1]).toBe("node");
    expect(args.slice(sep + 2)).toEqual(["server.js", "--port", "3000"]);
  });

  it("handles a real command with no extra args", () => {
    const { command, args } = buildServeWrapperCommand(
      "/bin/ac",
      "c1",
      "my-server",
      [],
    );
    expect(command).toBe("/bin/ac");
    expect(args).toEqual(["serve", "--connector", "c1", "--", "my-server"]);
  });
});
