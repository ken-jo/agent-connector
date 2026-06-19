import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import { defineConfig } from "vitest/config";

function allowPath(path: string): string[] {
  const real = realpathSync.native(path);
  const normalized = real.replace(/\\/g, "/");
  return real === normalized ? [real] : [real, normalized];
}

export default defineConfig({
  server: {
    fs: {
      allow: [...allowPath(tmpdir()), ...allowPath(process.cwd())],
    },
  },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
