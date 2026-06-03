import { describe, it, expect } from "vitest";
import {
  resolveEnvRefs,
  resolveEnvRefsDeep,
  rewriteEnvRefs,
  hasEnvRef,
  ENV_REF_RE,
} from "../../src/core/interpolate.js";

describe("resolveEnvRefs", () => {
  it("substitutes a set variable from the provided env", () => {
    const env = { ACME_KEY: "secret-value" } as NodeJS.ProcessEnv;
    expect(resolveEnvRefs("${env:ACME_KEY}", env)).toBe("secret-value");
  });

  it("resolves an unset variable (no default) to empty string", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(resolveEnvRefs("${env:MISSING}", env)).toBe("");
  });

  it("resolves an unset variable with a default to the default", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(resolveEnvRefs("${env:MISSING:-https://fallback}", env)).toBe(
      "https://fallback",
    );
  });

  it("treats a present-but-empty variable as unset and uses the default", () => {
    const env = { EMPTY: "" } as NodeJS.ProcessEnv;
    expect(resolveEnvRefs("${env:EMPTY:-defaulted}", env)).toBe("defaulted");
  });

  it("prefers the set value over the default when present and non-empty", () => {
    const env = { SET: "real" } as NodeJS.ProcessEnv;
    expect(resolveEnvRefs("${env:SET:-fallback}", env)).toBe("real");
  });

  it("resolves multiple references and surrounding literal text", () => {
    const env = { A: "1", B: "2" } as NodeJS.ProcessEnv;
    expect(resolveEnvRefs("x=${env:A};y=${env:B}", env)).toBe("x=1;y=2");
  });

  it("leaves text with no references unchanged", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(resolveEnvRefs("plain text", env)).toBe("plain text");
  });

  it("uses an empty default ( :- with nothing after) for an unset var", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(resolveEnvRefs("${env:MISSING:-}", env)).toBe("");
  });
});

describe("resolveEnvRefsDeep", () => {
  const env = { TOKEN: "abc", URL: "https://x" } as NodeJS.ProcessEnv;

  it("resolves refs inside nested objects", () => {
    const input = {
      auth: { header: "Bearer ${env:TOKEN}" },
      endpoint: "${env:URL}",
    };
    expect(resolveEnvRefsDeep(input, env)).toEqual({
      auth: { header: "Bearer abc" },
      endpoint: "https://x",
    });
  });

  it("resolves refs inside arrays (including nested arrays)", () => {
    const input = ["${env:TOKEN}", ["${env:URL}", "literal"]];
    expect(resolveEnvRefsDeep(input, env)).toEqual([
      "abc",
      ["https://x", "literal"],
    ]);
  });

  it("leaves non-string scalars (number, boolean, null) untouched", () => {
    const input = { n: 42, b: true, z: null, s: "${env:TOKEN}" };
    expect(resolveEnvRefsDeep(input, env)).toEqual({
      n: 42,
      b: true,
      z: null,
      s: "abc",
    });
  });

  it("returns a plain non-string scalar unchanged", () => {
    expect(resolveEnvRefsDeep(123, env)).toBe(123);
    expect(resolveEnvRefsDeep(false, env)).toBe(false);
    expect(resolveEnvRefsDeep(null, env)).toBe(null);
  });

  it("resolves a bare string value", () => {
    expect(resolveEnvRefsDeep("${env:TOKEN}", env)).toBe("abc");
  });
});

describe("rewriteEnvRefs", () => {
  it("translates ${env:VAR} into a host-native token via render", () => {
    const render = (name: string) => "${" + name + "}";
    expect(rewriteEnvRefs("Bearer ${env:TOKEN}", render)).toBe("Bearer ${TOKEN}");
  });

  it("passes the default through to the renderer", () => {
    const render = (name: string, def?: string) =>
      `<${name}|${def ?? "NONE"}>`;
    expect(rewriteEnvRefs("${env:URL:-https://x}", render)).toBe(
      "<URL|https://x>",
    );
    expect(rewriteEnvRefs("${env:URL}", render)).toBe("<URL|NONE>");
  });

  it("rewrites every reference in a string", () => {
    const render = (name: string) => `%${name}%`;
    expect(rewriteEnvRefs("${env:A}-${env:B}", render)).toBe("%A%-%B%");
  });
});

describe("hasEnvRef", () => {
  it("returns true when the string contains an env reference", () => {
    expect(hasEnvRef("prefix ${env:FOO} suffix")).toBe(true);
  });

  it("returns true for a reference with a default", () => {
    expect(hasEnvRef("${env:FOO:-bar}")).toBe(true);
  });

  it("returns false when there is no env reference", () => {
    expect(hasEnvRef("no refs here ${notenv:FOO}")).toBe(false);
    expect(hasEnvRef("plain")).toBe(false);
  });

  it("is repeatable (resets the shared global regex lastIndex)", () => {
    const s = "${env:FOO}";
    expect(hasEnvRef(s)).toBe(true);
    // Because ENV_REF_RE has the /g flag, a naive second call could fail if
    // lastIndex were not reset; this guards that behavior.
    expect(hasEnvRef(s)).toBe(true);
    expect(hasEnvRef(s)).toBe(true);
  });
});

describe("ENV_REF_RE", () => {
  it("is exported and global so resolve/rewrite can replace all matches", () => {
    expect(ENV_REF_RE.global).toBe(true);
  });
});
