import { execSync } from "node:child_process";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// "Last updated" date shown in the docs header. We use the HEAD commit date
// (the commit the deploy was built from) rather than a version number: a
// version would drift ahead of the docs (a release bump redeploys the site and
// the number rises even though doc content is unchanged → false freshness),
// whereas the commit date only moves when the site is actually rebuilt from a
// new commit. Falls back to today's date for a tarball build with no git.
function docsBuildDate(): string {
  try {
    return execSync("git log -1 --format=%cs", {
      cwd: __dirname,
    })
      .toString()
      .trim();
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  define: {
    __DOCS_BUILD_DATE__: JSON.stringify(docsBuildDate()),
  },
  // Absolute base: this is a client-routed SPA, so a relative base ("./") breaks
  // a full load / direct deep link of any 2+-level route (e.g. /docs/hooks-guide
  // resolves "./assets/…" to /docs/assets/… → 404 → blank page). An absolute base
  // keeps assets at <base>/assets for every route depth.
  //   - custom domain / local preview → "/"
  //   - GitHub Pages PROJECT site (ken-jo.github.io/agent-connector/) → CI passes
  //     VITE_BASE=/agent-connector/ so assets + the router basename live under it.
  // BrowserRouter reads this via import.meta.env.BASE_URL (see main.tsx).
  base: process.env.VITE_BASE ?? "/",
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
