/**
 * tests/sdk/packaging — the /sdk + /sdk/test subpath barrels resolve.
 *
 * A smoke test: importing from the source barrels yields the expected runtime
 * exports (the same names the built dist subpaths surface). This guards the
 * barrel composition; the BUILT subpath resolution (dist/sdk/*.js) is verified
 * out-of-band in the acceptance steps (node -e import of the dist file).
 */

import { describe, expect, it } from "vitest";

import * as sdk from "../../src/sdk/index.js";
import * as sdkTest from "../../src/sdk/test.js";

describe("/sdk barrel", () => {
  it("exports defineConnector + the full define* family + introspect", () => {
    const keys = Object.keys(sdk).sort();
    for (const name of [
      "defineConnector",
      "ConnectorConfigError",
      "defineStatusline",
      "defineAction",
      "defineHook",
      "defineCommand",
      "defineSkill",
      "defineSubagent",
      "defineMemory",
      "defineConfigPatch",
      "defineNativeHook",
      "toolName",
      "style",
      "SURFACE_PREDICATES",
      "capabilitiesOf",
      "hostsSupporting",
      "surfaceSupport",
    ]) {
      expect(keys, `missing ${name}`).toContain(name);
    }
  });

  it("every define* export is a function", () => {
    for (const [name, value] of Object.entries(sdk)) {
      if (name.startsWith("define")) {
        expect(typeof value, `${name} should be a function`).toBe("function");
      }
    }
  });
});

describe("/sdk/test barrel", () => {
  it("exports explain + simulate", () => {
    expect(typeof sdkTest.explain).toBe("function");
    expect(typeof sdkTest.simulate).toBe("function");
  });
});
