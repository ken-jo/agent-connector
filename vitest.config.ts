import { tmpdir } from "node:os";

import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    fs: {
      allow: [tmpdir(), process.cwd()],
    },
  },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
