/**
 * core/fetch-source — resolve an `install <source>` argument that may be a
 * LOCAL path OR a REMOTE package/source spec into a local connector-config path.
 *
 * Responsibilities (MVP):
 *   1. CLASSIFY a source string as local-path vs. remote GitHub spec. A value
 *      that exists on disk, or that looks like a filesystem path (starts with
 *      `.`, `/`, `~`, a `file://` URL, or a Windows drive/UNC), stays LOCAL and
 *      keeps today's behavior. Everything else is parsed as a remote spec.
 *   2. PARSE the supported remote forms:
 *        owner/repo · owner/repo#ref · owner/repo/sub · owner/repo/sub#ref
 *        github:owner/repo · https://github.com/owner/repo[/tree/ref/sub]
 *        git@github.com:owner/repo.git · the .git suffix on any of the above.
 *        npm:<package>[@version] · archive:<path-or-url> · *.tgz / *.tar.gz
 *   3. FETCH + PERSIST the repo to a STABLE cache dir under the data-root
 *      (`sources/<owner>__<repo>[__<ref>]/`), NOT a temp dir, so a connector
 *      with a local stdio server keeps resolving after install. Re-fetch updates
 *      it. `git clone --depth 1` is preferred; a codeload tarball is the
 *      fallback when `git` is unavailable.
 *   4. GATE: the fetched (sub)dir MUST contain an `agent-connector.config.*`
 *      that loads — otherwise the target is not an agent-connector connector.
 *
 * The actual fetch is injected via a {@link Fetcher} seam so tests can drive the
 * pipeline against a `file://` git fixture without any real network/GitHub hit.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findConnectorConfig, loadConnectorFromPath } from "./load-connector.js";
import { sourcesDir } from "./paths.js";
import type { ResolvedConnector } from "./types.js";

/** A parsed remote source to fetch (a GitHub spec, or a raw git clone URL such
 *  as `file://`/`ssh://`/`git@…`). `ref` is a branch/tag/sha; `subpath` is the
 *  directory within the repo that holds the connector config. */
export interface RemoteSource {
  owner: string;
  repo: string;
  /**
   * Non-git source kind. Omitted for GitHub/raw-git sources to preserve the
   * original object shape used by tests and callers.
   */
  sourceKind?: "npm" | "archive";
  /** Branch / tag / commit. Undefined → the repo default branch. */
  ref?: string;
  /** Sub-directory inside the repo holding the connector config. */
  subpath?: string;
  /**
   * A raw clone URL (file://, ssh://, git@host:…, https://non-github) when the
   * source is NOT a github.com owner/repo we can derive a URL for. Present → the
   * tarball fallback is unavailable (we can only `git clone` it).
   */
  cloneUrl?: string;
  /** npm package spec for sourceKind:"npm", e.g. "@acme/db-mcp@1.2.3". */
  packageSpec?: string;
  /** npm package name without version/tag, e.g. "@acme/db-mcp". */
  packageName?: string;
  /** Tarball path or URL for sourceKind:"archive". */
  archiveUrl?: string;
}

/** The classification of an `install <source>` argument. */
export type SourceSpec =
  | { kind: "local"; value: string }
  | { kind: "remote"; remote: RemoteSource };

const GITHUB_SEG = /^[A-Za-z0-9._-]+$/;
const NPM_UNSCOPED_NAME_RE = /^[a-z0-9][a-z0-9._~-]*$/i;
const NPM_SCOPE_RE = /^@[a-z0-9][a-z0-9._~-]*$/i;

function isSafeGitHubSegment(segment: string): boolean {
  return GITHUB_SEG.test(segment) && segment !== "." && segment !== "..";
}

function isSafeSubpath(subpath: string | undefined): boolean {
  if (subpath === undefined || subpath === "") return true;
  return subpath
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * True when `value` should be treated as a LOCAL path (existing behavior),
 * before any remote-spec parse is attempted. Conservative on purpose: a path
 * that exists wins, and the common path sigils (`.`, `/`, `~`, `file://`, a
 * Windows drive letter or UNC) are local even when nothing is on disk yet.
 */
export function looksLocal(value: string): boolean {
  if (value === "") return true;
  if (existsSync(value)) return true;
  if (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value === "." ||
    value === ".." ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    value.startsWith("file://")
  ) {
    return true;
  }
  // Windows drive (C:\ or C:/) or UNC (\\server\share).
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) return true;
  return false;
}

/**
 * Parse a remote GitHub spec into a {@link RemoteSource}, or null when `value`
 * is not a recognizable GitHub source. Supports the bare `owner/repo[/sub][#ref]`
 * shorthand, `github:owner/repo`, full `https://github.com/...` (incl.
 * `/tree/<ref>/<subpath>`), and `git@github.com:owner/repo.git`.
 */
export function parseRemoteSource(value: string): RemoteSource | null {
  const raw = value.trim();
  if (raw === "") return null;

  // ── git@github.com:owner/repo(.git) ───────────────────────────────────────
  const scp = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (scp) {
    return finalizeFromPath(scp[1]!, scp[2]!, undefined);
  }

  // ── https://github.com/owner/repo[/tree/<ref>/<subpath>][.git][#ref] ───────
  if (/^https?:\/\//i.test(raw) || raw.startsWith("git://")) {
    let url: URL;
    try {
      url = new URL(raw.replace(/^git:\/\//, "https://"));
    } catch {
      return null;
    }
    if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
    const segs = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    if (segs.length < 2) return null;
    const owner = segs[0]!;
    let repo = segs[1]!.replace(/\.git$/, "");
    let ref: string | undefined;
    let subpath: string | undefined;
    // /tree/<ref>/<subpath...> selects a ref + sub-directory.
    if (segs[2] === "tree" || segs[2] === "blob") {
      ref = segs[3];
      if (segs.length > 4) subpath = segs.slice(4).join("/");
    } else if (segs.length > 2) {
      subpath = segs.slice(2).join("/");
    }
    const hash = url.hash.replace(/^#/, "");
    if (hash) ref = hash;
    if (!isSafeGitHubSegment(owner) || !isSafeGitHubSegment(repo)) return null;
    return cleanRemote({ owner, repo, ref, subpath });
  }

  // ── github:owner/repo[...] ────────────────────────────────────────────────
  const shorthand = raw.startsWith("github:") ? raw.slice("github:".length) : raw;

  // ── owner/repo[/subpath][#ref] ────────────────────────────────────────────
  // Reject anything that doesn't look like the bare `owner/repo` shape (a single
  // path segment, or a leading slash) so we never misread a stray token.
  const [pathPart, refPart] = splitHash(shorthand);
  const segs = pathPart.split("/").filter(Boolean);
  if (segs.length < 2) return null;
  const owner = segs[0]!;
  const repo = segs[1]!.replace(/\.git$/, "");
  const subpath = segs.length > 2 ? segs.slice(2).join("/") : undefined;
  if (!isSafeGitHubSegment(owner) || !isSafeGitHubSegment(repo)) return null;
  return cleanRemote({ owner, repo, ref: refPart, subpath });
}

/** Split a "<path>#<ref>" into [path, ref?]. */
function splitHash(value: string): [string, string | undefined] {
  const i = value.indexOf("#");
  if (i === -1) return [value, undefined];
  const ref = value.slice(i + 1).trim();
  return [value.slice(0, i), ref === "" ? undefined : ref];
}

/** scp-form helper: the repo half may itself carry `/sub` and `#ref`. */
function finalizeFromPath(owner: string, repoAndRest: string, _ref: undefined): RemoteSource | null {
  const [pathPart, ref] = splitHash(repoAndRest);
  const segs = pathPart.split("/").filter(Boolean);
  const repo = (segs[0] ?? "").replace(/\.git$/, "");
  const subpath = segs.length > 1 ? segs.slice(1).join("/") : undefined;
  if (!isSafeGitHubSegment(owner) || !isSafeGitHubSegment(repo)) return null;
  return cleanRemote({ owner, repo, ref, subpath });
}

/**
 * A git-refname-safe ref charset: branch/tag/sha names plus the `/`, `.`, `_`,
 * `-` they may contain. A LEADING `-` is rejected so a ref can never be read as
 * a git flag (e.g. `--upload-pack=…`) when passed to `git clone --branch`, and
 * the constrained charset keeps cache-dir names clean. Empty is invalid.
 */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** True when `ref` is a safe git refname (defense-in-depth before exec). */
export function isSafeRef(ref: string): boolean {
  return REF_RE.test(ref);
}

/**
 * Drop empty optional fields so equality/snapshot comparisons stay clean.
 * Returns null when a present `ref` is not git-refname-safe (defense-in-depth:
 * never pass an attacker-shaped ref to `git clone --branch`).
 */
function cleanRemote(r: RemoteSource): RemoteSource | null {
  if (r.ref !== undefined && !isSafeRef(r.ref)) return null;
  if (!isSafeSubpath(r.subpath)) return null;
  const out: RemoteSource = { owner: r.owner, repo: r.repo };
  if (r.ref) out.ref = r.ref;
  if (r.subpath && r.subpath !== "") out.subpath = r.subpath;
  return out;
}

/**
 * Parse a RAW git clone URL (NOT a github.com owner/repo): `file://…`,
 * `ssh://…`, `git@host:owner/repo`, or `https://<non-github>/…`. These are
 * `git clone`-able directly. A trailing `#ref` selects a branch/tag/sha. These
 * forms point at a repo root (no in-URL subpath). Returns null for anything
 * that isn't a clone URL.
 */
export function parseGitUrl(value: string): RemoteSource | null {
  const [urlPart, ref] = splitHash(value.trim());
  const isScheme =
    urlPart.startsWith("file://") ||
    urlPart.startsWith("ssh://") ||
    urlPart.startsWith("git://") ||
    /^https?:\/\//i.test(urlPart);
  const isScp = /^[^@\s]+@[^:\s]+:.+/.test(urlPart) && !urlPart.startsWith("git@github.com:");
  if (!isScheme && !isScp) return null;
  // Reject an unsafe ref (e.g. a leading-dash flag) before it reaches git.
  if (ref !== undefined && !isSafeRef(ref)) return null;

  // Derive a stable owner/repo cache key from the URL's last two path segments.
  const stripped = urlPart.replace(/\.git$/, "").replace(/\/+$/, "");
  const segs = stripped.split(/[/:]/).filter(Boolean);
  const repo = segs[segs.length - 1] ?? "repo";
  const owner = segs[segs.length - 2] ?? "git";
  const out: RemoteSource = { owner, repo, cloneUrl: urlPart };
  if (ref) out.ref = ref;
  return out;
}

/** Parse an explicit npm source: npm:<package>[@version-or-tag]. */
export function parseNpmSource(value: string): RemoteSource | null {
  const raw = value.trim();
  if (!raw.startsWith("npm:")) return null;
  const spec = raw.slice("npm:".length).trim();
  if (spec === "" || /\s/.test(spec) || spec.startsWith("-")) return null;

  let packageName: string;
  if (spec.startsWith("@")) {
    const match = spec.match(/^(@[^/@\s]+\/[^/@\s]+)(?:@([^/\s]+))?$/);
    if (!match) return null;
    packageName = match[1]!;
  } else {
    const match = spec.match(/^([^/@\s]+)(?:@([^/\s]+))?$/);
    if (!match) return null;
    packageName = match[1]!;
  }

  const parts = packageName.startsWith("@") ? packageName.split("/") : [packageName];
  if (parts.length === 2) {
    if (!NPM_SCOPE_RE.test(parts[0]!) || !NPM_UNSCOPED_NAME_RE.test(parts[1]!)) {
      return null;
    }
  } else if (parts.length === 1) {
    if (!NPM_UNSCOPED_NAME_RE.test(parts[0]!)) return null;
  } else {
    return null;
  }

  return {
    sourceKind: "npm",
    owner: "npm",
    repo: packageName.replace(/^@/, "").replace(/\//g, "__"),
    packageName,
    packageSpec: spec,
  };
}

function stripQueryAndHash(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? value;
}

function archivePathname(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname;
  } catch {
    return value;
  }
}

function isTarballLike(value: string): boolean {
  const p = stripQueryAndHash(archivePathname(value)).toLowerCase();
  return p.endsWith(".tgz") || p.endsWith(".tar.gz");
}

/** Parse a tarball archive source: archive:<path-or-url> or direct *.tgz/*.tar.gz. */
export function parseArchiveSource(value: string): RemoteSource | null {
  const raw = value.trim();
  const explicit = raw.startsWith("archive:");
  const source = explicit ? raw.slice("archive:".length).trim() : raw;
  if (source === "") return null;
  if (!explicit && !isTarballLike(source)) return null;

  const pathish = stripQueryAndHash(archivePathname(source));
  const base = basename(pathish).replace(/\.tar\.gz$/i, "").replace(/\.tgz$/i, "");
  const repo = base || "source";
  return {
    sourceKind: "archive",
    owner: "archive",
    repo,
    archiveUrl: source,
  };
}

/**
 * Classify an `install <source>` argument. A raw git clone URL (file://, ssh://,
 * git@…) or a GitHub spec is REMOTE (a fetch); a local FILESYSTEM path (existing
 * or path-shaped, EXCLUDING file:// which is a clone URL) keeps today's
 * behavior. Returns null when a non-local value is NOT a recognizable remote.
 */
export function classifySource(value: string): SourceSpec | null {
  const npm = parseNpmSource(value);
  if (npm) return { kind: "remote", remote: npm };
  const archive = parseArchiveSource(value);
  if (archive) return { kind: "remote", remote: archive };
  // A raw git clone URL (incl. file://) is always a FETCH, never a config path —
  // even though file:// is "path-shaped" it names a clonable repo, not a config.
  const gitUrl = parseGitUrl(value);
  if (gitUrl) return { kind: "remote", remote: gitUrl };
  if (looksLocal(value)) return { kind: "local", value };
  const remote = parseRemoteSource(value);
  return remote ? { kind: "remote", remote } : null;
}

/** The clone URL for a remote source (its raw cloneUrl, else the github URL). */
export function cloneUrl(r: RemoteSource): string {
  if (r.sourceKind === "npm" || r.sourceKind === "archive") {
    throw new Error(`${describeRemote(r)} is not a git clone source`);
  }
  return r.cloneUrl ?? `https://github.com/${r.owner}/${r.repo}.git`;
}

/** The codeload tarball URL for a github source (default branch when no ref). */
export function tarballUrl(r: RemoteSource): string {
  const ref = r.ref ?? "HEAD";
  return `https://codeload.github.com/${r.owner}/${r.repo}/tar.gz/${ref}`;
}

/** The STABLE cache directory a remote source is fetched into. */
export function sourceCacheDir(r: RemoteSource): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-");
  if (r.sourceKind === "npm") {
    return join(sourcesDir(), `npm__${safe(r.packageName ?? r.repo)}__${shortHash(r.packageSpec ?? r.repo)}`);
  }
  if (r.sourceKind === "archive") {
    return join(sourcesDir(), `archive__${safe(r.repo)}__${shortHash(r.archiveUrl ?? r.repo)}`);
  }
  // A raw clone URL hashes its full URL into the key so two different file://
  // repos that share an owner/repo basename never collide in the cache.
  const base = r.cloneUrl
    ? `${safe(r.owner)}__${safe(r.repo)}__${shortHash(r.cloneUrl)}`
    : `${safe(r.owner)}__${safe(r.repo)}`;
  const name = r.ref ? `${base}__${safe(r.ref)}` : base;
  return join(sourcesDir(), name);
}

/** A short, filename-safe hash for disambiguating raw clone URLs in the cache. */
function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * A fetcher fetches `remote` into the stable directory `dest`. Injected so tests
 * can drive the resolve pipeline against a `file://` git fixture (no network).
 * The default {@link gitFetcher} clones over HTTPS.
 */
export type Fetcher = (remote: RemoteSource, dest: string) => void | Promise<void>;

/** True when a usable `git` is on PATH (probed once per process via a cheap call). */
function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The default fetcher: `git clone --depth 1 [--branch <ref>] <url> <dest>`.
 * Re-fetch replaces the cache dir so the clone reflects the requested ref. The
 * caller may override the clone URL via `urlFor` (tests pass a `file://` repo).
 */
export function makeGitFetcher(urlFor: (r: RemoteSource) => string = cloneUrl): Fetcher {
  return (remote, dest) => {
    if (remote.sourceKind === "npm" || remote.sourceKind === "archive") {
      throw new Error(`${describeRemote(remote)} is not a git clone source`);
    }
    if (!gitAvailable()) {
      throw new Error(
        "git is required to fetch a remote connector source but was not found on PATH. " +
          "Install git, or pass a local --connector <path>.",
      );
    }
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    const args = ["clone", "--depth", "1"];
    if (remote.ref) args.push("--branch", remote.ref);
    args.push(urlFor(remote), dest);
    try {
      execFileSync("git", args, { stdio: "ignore" });
    } catch (err) {
      throw new Error(
        `failed to clone ${urlFor(remote)}${remote.ref ? ` (ref ${remote.ref})` : ""}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}

/**
 * Tarball fallback: download the GitHub codeload `tar.gz` and extract it with
 * the system `tar` (present on Linux, macOS, and Windows 10+). codeload nests
 * everything under a single `<repo>-<ref>/` top dir, which we flatten into
 * `dest`. Used only when `git` is unavailable.
 */
async function tarballFetch(remote: RemoteSource, dest: string): Promise<void> {
  const url = tarballUrl(remote);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  await extractTarballBuffer(Buffer.from(await res.arrayBuffer()), dest);
}

function extractTarballBuffer(buf: Buffer, dest: string): void {
  const work = join(tmpdir(), `ac-src-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const tarPath = join(work, "source.tar.gz");
  writeFileSync(tarPath, buf);
  try {
    execFileSync("tar", ["-xzf", tarPath, "-C", work], { stdio: "ignore" });
  } catch (err) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(
      "neither git nor a usable `tar` is available to fetch a remote connector " +
        `source (${err instanceof Error ? err.message : String(err)}). Install git ` +
        "or tar, or pass a local --connector <path>.",
    );
  }
  // codeload nests under a single `<repo>-<ref>/` directory — flatten it.
  const entries = readdirSync(work).filter((e) => e !== "source.tar.gz");
  const top = entries.length === 1 ? join(work, entries[0]!) : work;
  rmSync(dest, { recursive: true, force: true });
  renameSync(top, dest);
  rmSync(work, { recursive: true, force: true });
}

async function archiveFetch(remote: RemoteSource, dest: string): Promise<void> {
  const source = remote.archiveUrl;
  if (!source) throw new Error("archive source is missing archiveUrl");

  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`failed to download ${source}: HTTP ${res.status} ${res.statusText}`);
    }
    await extractTarballBuffer(Buffer.from(await res.arrayBuffer()), dest);
    return;
  }

  const archivePath = source.startsWith("file://") ? fileURLToPath(source) : source;
  if (!existsSync(archivePath)) {
    throw new Error(`archive source not found: ${source}`);
  }
  extractTarballBuffer(readFileSync(archivePath), dest);
}

function npmAvailable(): boolean {
  try {
    execFileSync("npm", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function npmFetch(remote: RemoteSource, dest: string): Promise<void> {
  const spec = remote.packageSpec;
  if (!spec) throw new Error("npm source is missing packageSpec");
  if (!npmAvailable()) {
    throw new Error(
      `npm is required to fetch npm:${spec} but was not found on PATH. ` +
        "Install npm, or pass a local --connector <path>.",
    );
  }

  const work = join(tmpdir(), `ac-npm-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  let stdout: string;
  try {
    stdout = execFileSync(
      "npm",
      ["pack", spec, "--pack-destination", work, "--silent"],
      { encoding: "utf8" },
    );
  } catch (err) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(
      `failed to fetch npm:${spec}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const packed = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!packed) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(`failed to fetch npm:${spec}: npm pack produced no tarball`);
  }
  const tarPath = isAbsolute(packed) ? packed : join(work, packed);
  try {
    extractTarballBuffer(readFileSync(tarPath), dest);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The default network fetcher: `git clone` when git is on PATH, otherwise the
 * codeload tarball fallback (github.com sources only — a raw clone URL can only
 * be `git clone`d, so it requires git). A clear error is thrown when neither
 * applicable path works.
 */
export const gitFetcher: Fetcher = async (remote, dest) => {
  if (remote.sourceKind === "npm") {
    await npmFetch(remote, dest);
    return;
  }
  if (remote.sourceKind === "archive") {
    await archiveFetch(remote, dest);
    return;
  }
  if (gitAvailable()) {
    makeGitFetcher()(remote, dest);
    return;
  }
  if (remote.cloneUrl) {
    throw new Error(
      `git is required to fetch ${remote.cloneUrl} but was not found on PATH. ` +
        "Install git, or pass a local --connector <path>.",
    );
  }
  await tarballFetch(remote, dest);
};

/** The resolved output of {@link resolveRemoteSource}. */
export interface ResolvedSource {
  /** Absolute path to the agent-connector.config.* found inside the fetch. */
  configPath: string;
  /** The directory the source was fetched into (stable, under the data-root). */
  sourceDir: string;
  /** The (sub)directory the config was found in. */
  connectorDir: string;
  /** The live connector + its absolute module path (ready for the install flow). */
  connector: ResolvedConnector;
  modulePath: string;
}

/** Options for {@link resolveRemoteSource}. */
export interface ResolveOptions {
  /** Override the fetch (tests). Defaults to {@link gitFetcher}. */
  fetcher?: Fetcher;
}

/**
 * Fetch a remote source into its stable cache dir, honor the subpath, and GATE
 * it as a real agent-connector package: `findConnectorConfig` must locate an
 * `agent-connector.config.{mjs,js,json}` that `loadConnectorFromPath` can load.
 * Throws a clear, specific error when the target is not an agent-connector
 * connector. Returns everything the install flow needs.
 */
export async function resolveRemoteSource(
  remote: RemoteSource,
  opts: ResolveOptions = {},
): Promise<ResolvedSource> {
  const fetcher = opts.fetcher ?? gitFetcher;
  const sourceDir = sourceCacheDir(remote);
  mkdirSync(sourcesDir(), { recursive: true });
  await fetcher(remote, sourceDir);

  const label = describeRemote(remote);
  if (!existsSync(sourceDir)) {
    throw new Error(`failed to fetch ${label}: nothing was written to ${sourceDir}`);
  }

  // Honor the subpath; guard against a `..` escape out of the fetched dir.
  // Containment is checked with path.relative (NOT a bare string prefix, which
  // a sibling dir sharing the cache-key prefix would defeat) — mirroring the
  // connectorDir() guard in paths.ts: reject when the relative path is empty,
  // starts with "..", or is absolute.
  const root = resolve(sourceDir);
  const searchDir = remote.subpath ? resolve(root, remote.subpath) : root;
  if (remote.subpath) {
    const rel = relative(root, searchDir);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`subpath escapes the fetched source: ${remote.subpath}`);
    }
  }
  if (!existsSync(searchDir)) {
    throw new Error(
      `${label}: subpath "${remote.subpath}" does not exist in the repository.`,
    );
  }

  // ── PACKAGE GATE ──────────────────────────────────────────────────────────
  // Search only WITHIN the fetched (sub)dir. findConnectorConfig walks UPWARD to
  // the filesystem root, so confine the start dir and verify the hit is inside.
  const configPath = findConfigWithin(searchDir);
  if (!configPath) {
    throw new Error(
      `${label} is not an agent-connector connector — no ` +
        `agent-connector.config.{mjs,js,json} found in the repo` +
        (remote.subpath ? ` at subpath "${remote.subpath}"` : "") +
        ". The target must be a package built with agent-connector (defineConnector).",
    );
  }

  let connector: ResolvedConnector;
  let modulePath: string;
  try {
    ({ connector, modulePath } = await loadConnectorFromPath(configPath));
  } catch (err) {
    throw new Error(
      `${label}: found ${configPath} but it failed to load as an agent-connector ` +
        `connector (${err instanceof Error ? err.message : String(err)}). The target ` +
        "must be a package built with agent-connector (defineConnector).",
    );
  }

  return {
    configPath,
    sourceDir,
    connectorDir: searchDir,
    connector,
    modulePath,
  };
}

/**
 * Locate `agent-connector.config.*` strictly within `dir` (not its ancestors).
 * `findConnectorConfig` walks upward, so we scope the result by asserting the
 * hit is in `dir` itself.
 */
function findConfigWithin(dir: string): string | null {
  const hit = findConnectorConfig(dir);
  if (!hit) return null;
  // Must live directly in the (sub)dir we were pointed at — reject an ancestor
  // hit so a parent dir's config can't masquerade as the repo's.
  const dirAbs = resolve(dir);
  const hitDir = resolve(hit, "..");
  return hitDir === dirAbs ? hit : null;
}

/** A human label for a remote source used in error messages. */
export function describeRemote(r: RemoteSource): string {
  if (r.sourceKind === "npm") return `npm:${r.packageSpec ?? r.repo}`;
  if (r.sourceKind === "archive") return `archive:${r.archiveUrl ?? r.repo}`;
  let s = r.cloneUrl ?? `${r.owner}/${r.repo}`;
  if (r.subpath) s += `/${r.subpath}`;
  if (r.ref) s += `#${r.ref}`;
  return s;
}
