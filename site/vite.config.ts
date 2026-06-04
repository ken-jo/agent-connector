import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // Absolute base: this is a client-routed SPA, so a relative base ("./") breaks
  // a full load / direct deep link of any 2+-level route (e.g. /docs/hooks-guide
  // resolves "./assets/…" to /docs/assets/… → 404 → blank page). "/" keeps assets
  // at /assets for every route depth. Served at the domain root (incl. the
  // Tailscale preview); set a subpath here only if ever deployed under one.
  base: "/",
  // Local preview/dev over a private network (e.g. Tailscale): bind all
  // interfaces and accept the tailnet host header. Harmless for a static
  // preview server; does not affect the production build output.
  server: { host: true, allowedHosts: true },
  preview: { host: true, allowedHosts: true },
  build: {
    minify: "esbuild",
  },
  esbuild:
    mode === "production"
      ? {
          drop: ["console", "debugger"],
          legalComments: "none",
        }
      : undefined,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
