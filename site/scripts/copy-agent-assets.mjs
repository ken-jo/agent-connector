import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(siteRoot, "..");
const distRoot = path.join(siteRoot, "dist");

const assets = [
  ["llms.txt", "llms.txt"],
  ["llms-full.txt", "llms-full.txt"],
  ["skills/agent-connector", "skills/agent-connector"],
];

if (!existsSync(distRoot)) {
  throw new Error("site/dist not found; run vite build before copying agent assets");
}

for (const [from, to] of assets) {
  const source = path.join(repoRoot, from);
  const target = path.join(distRoot, to);
  if (!existsSync(source)) {
    throw new Error(`agent asset source not found: ${from}`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  console.log(`copied ${from} -> dist/${to}`);
}
