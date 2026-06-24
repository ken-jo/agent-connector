import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

type PackageJson = {
  name?: unknown;
  bin?: unknown;
};

const FALLBACK_PACKAGE_NAME = "@ken-jo/agent-connector";
const FALLBACK_BIN_NAME = "agent-connector";

function frameworkPackageMetadata(): {
  packageName: string;
  binName: string;
} {
  const fallback = {
    packageName: FALLBACK_PACKAGE_NAME,
    binName: FALLBACK_BIN_NAME,
  };

  try {
    const pkg = JSON.parse(
      readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
    ) as PackageJson;
    const packageName =
      typeof pkg.name === "string" && pkg.name ? pkg.name : fallback.packageName;
    const bin =
      typeof pkg.bin === "string"
        ? pkg.bin
        : pkg.bin && typeof pkg.bin === "object"
          ? Object.keys(pkg.bin as Record<string, unknown>)[0]
          : undefined;

    return {
      packageName,
      binName: bin || fallback.binName,
    };
  } catch {
    return fallback;
  }
}

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

const frameworkPackage = frameworkPackageMetadata();

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  define: {
    __DOCS_BUILD_DATE__: JSON.stringify(docsBuildDate()),
    __AGENT_CONNECTOR_PACKAGE_NAME__: JSON.stringify(
      frameworkPackage.packageName,
    ),
    __AGENT_CONNECTOR_BIN_NAME__: JSON.stringify(frameworkPackage.binName),
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
