import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli/index.ts",
    "runtime/index": "src/runtime/index.ts",
  },
  format: ["esm"],
  target: "node18",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  // Keep the dependency tree external; the home install resolves them.
  // gpt-tokenizer is heavy — keep it external and lazy-required at runtime.
  external: ["gpt-tokenizer", "@iarna/toml", "yaml"],
  banner: { js: "#!/usr/bin/env node" },
});
