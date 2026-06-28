import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

function copyAsset(source, target) {
  const stat = statSync(source);
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) {
      copyAsset(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(source));
}

for (const [from, to] of assets) {
  const source = path.join(repoRoot, from);
  const target = path.join(distRoot, to);
  if (!existsSync(source)) {
    throw new Error(`agent asset source not found: ${from}`);
  }
  copyAsset(source, target);
  console.log(`copied ${from} -> dist/${to}`);
}
