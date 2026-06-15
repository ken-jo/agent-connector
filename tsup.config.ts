import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli/index.ts",
    "cli/sdk": "src/cli/sdk.ts",
    "runtime/index": "src/runtime/index.ts",
    "sdk/index": "src/sdk/index.ts",
    "sdk/test": "src/sdk/test.ts",
  },
  format: ["esm"],
  target: "node18",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  // Keep the dependency tree external; the home install resolves them.
  // gpt-tokenizer is heavy — keep it external and lazy-required at runtime.
  external: ["gpt-tokenizer", "@iarna/toml", "yaml", "sql.js", "fzstd"],
  // The shebang banner is applied to ALL entries, including the library barrels
  // (index / runtime / sdk). It is harmless on a library import — Node strips a
  // leading shebang when a module is imported — and keeps the bin entry runnable.
  banner: { js: "#!/usr/bin/env node" },
});
