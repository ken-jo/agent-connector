import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import { searchForWorkspaceRoot } from "vite";
import { defineConfig } from "vitest/config";

export function allowPath(path: string): string[] {
  const real = realpathSync.native(path);
  const normalized = real.replace(/\\/g, "/");
  return real === normalized ? [real] : [real, normalized];
}

export const vitestFsAllow = [
  ...allowPath(tmpdir()),
  ...allowPath(searchForWorkspaceRoot(process.cwd())),
];

export default defineConfig({
  server: {
    fs: {
      allow: vitestFsAllow,
    },
  },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
