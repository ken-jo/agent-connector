/**
 * adapters/base — shared adapter foundation.
 *
 * Provides JSON config IO, settings backup, and a default doctor. Per-platform
 * specifics (paths, capabilities, native render format, runtime parse/format)
 * are abstract and implemented by each adapter. TOML/YAML adapters override the
 * JSON helpers entirely.
 */

import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import type {
  ChangeRecord,
  DetectedPlatform,
  DiagnosticResult,
  HealthCheck,
  HookParadigm,
  PlatformCapabilities,
  PlatformId,
} from "../core/types.js";
import { backupsDir, ensureDir } from "../core/paths.js";
import { parseJsonc } from "../core/jsonc.js";
import { stringify as stringifyYaml } from "yaml";
import type { Adapter, InstallContext } from "./spi.js";

/** Content-surface kinds with BaseAdapter default install/uninstall handling. */
type ContentSurface = "commands" | "skills" | "subagents";

export abstract class BaseAdapter implements Adapter {
  abstract readonly id: PlatformId;
  abstract readonly name: string;
  abstract readonly paradigm: HookParadigm;
  abstract readonly capabilities: PlatformCapabilities;

  abstract detectInstalled(projectDir: string): DetectedPlatform;
  abstract getConfigDir(ctx: InstallContext): string;
  abstract getServerConfigPath(ctx: InstallContext): string;
  abstract getHookConfigPath(ctx: InstallContext): string;
  abstract installServer(ctx: InstallContext): ChangeRecord[];
  abstract uninstallServer(ctx: InstallContext): ChangeRecord[];
  abstract installHooks(ctx: InstallContext): ChangeRecord[];
  abstract uninstallHooks(ctx: InstallContext): ChangeRecord[];

  // ── Content surfaces (commands / skills / subagents) ─────────────────────
  // CONCRETE (overridable) defaults so every adapter inherits all six methods
  // and the installer can call them without optional-chaining. Each returns a
  // single skip when the connector declares no entries of that surface, else a
  // single "warn" — mirroring the mcp-only hook handling. Supporting adapters
  // override only the surfaces they honor.

  installCommands(ctx: InstallContext): ChangeRecord[] {
    return this.unsupportedSurface(ctx, "commands", ctx.connector.commands.length);
  }
  uninstallCommands(ctx: InstallContext): ChangeRecord[] {
    return this.unsupportedSurface(ctx, "commands", ctx.connector.commands.length);
  }
  installSkills(ctx: InstallContext): ChangeRecord[] {
    return this.unsupportedSurface(ctx, "skills", ctx.connector.skills.length);
  }
  uninstallSkills(ctx: InstallContext): ChangeRecord[] {
    return this.unsupportedSurface(ctx, "skills", ctx.connector.skills.length);
  }
  installSubagents(ctx: InstallContext): ChangeRecord[] {
    return this.unsupportedSurface(ctx, "subagents", ctx.connector.subagents.length);
  }
  uninstallSubagents(ctx: InstallContext): ChangeRecord[] {
    return this.unsupportedSurface(ctx, "subagents", ctx.connector.subagents.length);
  }

  /**
   * Default response for a content surface this platform cannot honor: a single
   * skip when the connector declares none of that surface, else a single "warn"
   * ChangeRecord noting how many were skipped. Mirrors mcp-only hook handling.
   */
  protected unsupportedSurface(
    _ctx: InstallContext,
    surface: ContentSurface,
    count: number,
  ): ChangeRecord[] {
    if (count === 0) {
      return [{ platform: this.id, action: "skip", detail: `connector declares no ${surface}` }];
    }
    return [
      {
        platform: this.id,
        action: "warn",
        detail: `${surface} not supported on ${this.id}; ${count} skipped`,
      },
    ];
  }

  // ── Content-file helpers (used by surface-supporting adapters) ────────────

  /**
   * Write a content file idempotently: "skip" when the existing bytes are
   * already identical, else "create"/"update". Creates parent dirs (mkdir -p).
   * Honors dryRun (computes the action but writes nothing).
   */
  protected writeContentFile(path: string, contents: string, dryRun: boolean): ChangeRecord {
    let action: ChangeRecord["action"];
    if (!existsSync(path)) {
      action = "create";
    } else {
      let current: string | null = null;
      try {
        current = readFileSync(path, "utf8");
      } catch {
        current = null;
      }
      action = current === contents ? "skip" : "update";
    }
    if (action !== "skip" && !dryRun) {
      ensureDir(dirname(path));
      writeFileSync(path, contents, "utf8");
    }
    return { platform: this.id, action, path, detail: basename(path) };
  }

  /**
   * Remove a content file we wrote; "skip" when already absent. Honors dryRun.
   * Uses rmSync with `force` to also tolerate a path that is a directory tree
   * (e.g. a skill folder removed by the supporting adapter).
   */
  protected removeContentFile(path: string, dryRun: boolean): ChangeRecord {
    if (!existsSync(path)) {
      return { platform: this.id, action: "skip", path, detail: `${basename(path)} absent` };
    }
    if (!dryRun) {
      rmSync(path, { recursive: true, force: true });
    }
    return { platform: this.id, action: "remove", path, detail: basename(path) };
  }

  /**
   * Defense-in-depth path containment: resolve `rel` against `baseDir` and
   * return the absolute path ONLY when it stays inside `baseDir`. Returns null
   * when `rel` escapes (absolute path, `..` traversal, etc.) so a caller can
   * skip-and-warn rather than write/delete outside the surface dir. This is the
   * runtime backstop behind the config-time validation in normalizeSkills.
   */
  protected resolveWithin(baseDir: string, rel: string): string | null {
    const base = resolve(baseDir);
    const target = resolve(base, rel);
    if (target === base) return null; // rel resolved to the dir itself (e.g. "" / ".")
    const rind = relative(base, target);
    // Outside when the relative path climbs out (`..`) or is itself absolute.
    if (rind === "" || rind.startsWith("..") || resolve(base, rind) !== target) {
      return null;
    }
    if (rind === ".." || rind.startsWith(`..${sep}`)) return null;
    return target;
  }

  /**
   * Recursively report whether a directory tree contains any regular FILE (vs
   * only empty/nested-empty subdirectories). Symlinks count as files (we never
   * recurse through them). Used by removeDirIfEmpty to decide if a tree is safe
   * to drop. An unreadable entry is treated as "a file is present" (conservative).
   */
  private dirTreeHasFile(dir: string): boolean {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true; // unreadable → assume it holds data; do not remove
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (this.dirTreeHasFile(join(dir, e.name))) return true;
      } else {
        return true; // a file / symlink / special → the tree is not "empty"
      }
    }
    return false;
  }

  /**
   * Remove a directory ONLY when its tree holds NO regular files — i.e. it is
   * empty or contains only (nested) empty directories, such as the intermediate
   * dirs our own nested skill resources created. Replaces the unconditional
   * `rm -rf <dir>` that uninstallSkills used to call, which destroyed user-added
   * files / sibling-tool files / shared skill dirs the connector never wrote.
   * When ANY file remains (at any depth) the whole tree is left in place and the
   * skip is noted. Honors dryRun (computes the action but removes nothing). A
   * missing dir is a no-op "skip".
   */
  protected removeDirIfEmpty(dir: string, dryRun: boolean): ChangeRecord {
    if (!existsSync(dir)) {
      return { platform: this.id, action: "skip", path: dir, detail: `${basename(dir)} absent` };
    }
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(dir);
    } catch {
      return {
        platform: this.id,
        action: "skip",
        path: dir,
        detail: `${basename(dir)} unreadable; left in place`,
      };
    }
    if (!stat.isDirectory()) {
      return {
        platform: this.id,
        action: "skip",
        path: dir,
        detail: `${basename(dir)} not a directory; left in place`,
      };
    }
    if (this.dirTreeHasFile(dir)) {
      return {
        platform: this.id,
        action: "skip",
        path: dir,
        detail: `${basename(dir)} still holds files we did not write; left in place`,
      };
    }
    if (!dryRun) {
      try {
        // The tree is files-free: only (possibly nested) empty dirs remain, which
        // are ours / inert. A recursive remove drops them without touching data.
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Lost a race or perms — non-fatal; report as a skip.
        return {
          platform: this.id,
          action: "skip",
          path: dir,
          detail: `${basename(dir)} could not be removed; left in place`,
        };
      }
    }
    return { platform: this.id, action: "remove", path: dir, detail: basename(dir) };
  }

  /**
   * Render a YAML-frontmatter + markdown body document:
   *   "---\n" + <yaml> + "---\n\n" + <body> + "\n".
   * Reuses the `yaml` package's stringify (the same serializer core/yaml uses).
   */
  protected renderFrontmatterMd(
    frontmatter: Record<string, unknown>,
    body: string,
  ): string {
    return `---\n${stringifyYaml(frontmatter)}---\n\n${body}\n`;
  }

  // ── JSON config helpers (used by JSON-format adapters) ───────────────────

  /**
   * Read + parse a JSON/JSONC config file, returning null when it is absent OR
   * unparseable. Parses TOLERANTLY via parseJsonc (strips // and /* *\/ comments
   * and trailing commas) so a perfectly valid JSONC file never false-fails to
   * null — that null is what `?? {}` would otherwise turn into a clobbering
   * overwrite of the user's whole config.
   */
  protected readJson<T = Record<string, unknown>>(path: string): T | null {
    if (!existsSync(path)) return null;
    try {
      return parseJsonc<T>(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * True when `path` exists and holds non-whitespace content but readJson cannot
   * parse it (even after JSONC stripping). The overwrite guard: writing a
   * `{}`-based config over a present-but-broken settings file would silently
   * destroy the user's data, so callers warn-and-skip instead.
   */
  protected isPresentButUnparseable(path: string): boolean {
    if (!existsSync(path)) return false;
    let raw: string;
    try {
      if (statSync(path).size === 0) return false;
      raw = readFileSync(path, "utf8");
    } catch {
      return false;
    }
    if (raw.trim() === "") return false;
    return this.readJson(path) === null;
  }

  protected writeJson(path: string, data: unknown, dryRun = false): void {
    if (dryRun) return;
    ensureDir(dirname(path));
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  /**
   * Upsert `entry` at `config[rootKey][serverId]` in a JSON file, creating the
   * file/object as needed. Returns a ChangeRecord describing create/update/skip.
   * Idempotent: an identical entry yields "skip".
   */
  protected upsertServerInJson(
    configPath: string,
    rootKey: string,
    serverId: string,
    entry: unknown,
    dryRun = false,
  ): ChangeRecord {
    // OVERWRITE GUARD: never replace a present, non-empty, unparseable settings
    // file with a `{}`-based config — that would silently destroy the user's
    // data. Warn and skip so they can back it up / fix it and re-run.
    if (this.isPresentButUnparseable(configPath)) {
      return {
        platform: this.id,
        action: "warn",
        path: configPath,
        detail: `existing ${configPath} is not parseable; left untouched (back it up / fix it, then re-run)`,
      };
    }
    const cfg = this.readJson<Record<string, Record<string, unknown>>>(configPath) ?? {};
    const bucket = (cfg[rootKey] ??= {});
    const before = JSON.stringify(bucket[serverId]);
    const after = JSON.stringify(entry);
    let action: ChangeRecord["action"];
    if (before === undefined) action = "create";
    else if (before === after) action = "skip";
    else action = "update";
    if (action !== "skip") {
      bucket[serverId] = entry;
      this.writeJson(configPath, cfg, dryRun);
    }
    return { platform: this.id, action, path: configPath, detail: `${rootKey}.${serverId}` };
  }

  /** Remove `config[rootKey][serverId]` from a JSON file. */
  protected removeServerFromJson(
    configPath: string,
    rootKey: string,
    serverId: string,
    dryRun = false,
  ): ChangeRecord {
    // OVERWRITE GUARD (see upsertServerInJson): a present-but-unparseable file
    // would round-trip to `{}` and erase the user's config, so warn and skip.
    if (this.isPresentButUnparseable(configPath)) {
      return {
        platform: this.id,
        action: "warn",
        path: configPath,
        detail: `existing ${configPath} is not parseable; left untouched (back it up / fix it, then re-run)`,
      };
    }
    const cfg = this.readJson<Record<string, Record<string, unknown>>>(configPath);
    const bucket = cfg?.[rootKey];
    if (!cfg || !bucket || !(serverId in bucket)) {
      return { platform: this.id, action: "skip", path: configPath, detail: `${rootKey}.${serverId} absent` };
    }
    delete bucket[serverId];
    this.writeJson(configPath, cfg, dryRun);
    return { platform: this.id, action: "remove", path: configPath, detail: `${rootKey}.${serverId}` };
  }

  // ── Backup ───────────────────────────────────────────────────────────────

  backupSettings(ctx: InstallContext): string | null {
    const files = [...new Set([this.getServerConfigPath(ctx), this.getHookConfigPath(ctx)])].filter(
      (f) => existsSync(f),
    );
    if (files.length === 0) return null;
    if (ctx.dryRun) return null;
    ensureDir(backupsDir());
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let last: string | null = null;
    for (const f of files) {
      const dest = join(backupsDir(), `${this.id}-${stamp}-${basename(f)}`);
      copyFileSync(f, dest);
      last = dest;
    }
    return last;
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────

  getHealthChecks?(ctx: InstallContext): readonly HealthCheck[];

  doctor(ctx: InstallContext): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const cfg = this.getServerConfigPath(ctx);
    results.push(
      existsSync(cfg)
        ? { check: `${this.name}: config present`, status: "pass", message: cfg }
        : {
            check: `${this.name}: config present`,
            status: "warn",
            message: `not found: ${cfg}`,
            fix: `agent-connector install --targets ${this.id}`,
          },
    );
    for (const hc of this.getHealthChecks?.(ctx) ?? []) {
      const r = hc.check();
      results.push({
        check: hc.name,
        status: r.status === "OK" ? "pass" : "fail",
        message: r.detail ?? r.status,
      });
    }
    return results;
  }
}
