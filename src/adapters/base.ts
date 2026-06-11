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
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  ChangeRecord,
  DetectedPlatform,
  DiagnosticResult,
  HealthCheck,
  HookParadigm,
  PlatformCapabilities,
  PlatformId,
  PlatformMemoryOverride,
} from "../core/types.js";
import { backupsDir, ensureDir } from "../core/paths.js";
import { parseJsonc } from "../core/jsonc.js";
import {
  MEMORY_CONTENT_SOFT_BUDGET_BYTES,
  listManagedBlocks,
  loadMemoryLedger,
  recordMemoryTarget,
  removeManagedBlocksFile,
  saveMemoryLedger,
  upsertManagedBlockFile,
} from "../core/managed-block.js";
import { renderFrontmatterMd } from "./claude-code/render.js";
import type { Adapter, InstallContext, MemoryTarget } from "./spi.js";

/** Content-surface kinds with BaseAdapter default install/uninstall handling. */
type ContentSurface = "commands" | "skills" | "subagents" | "memory";

/**
 * Documented USER-scope AGENTS.md locations, per host (the AGENTS.md-first
 * research matrix). Only hosts with a REAL user/global AGENTS.md file are
 * listed. Hosts whose documented user-scope memory lives in a DIFFERENT file
 * (qwen-code ~/.qwen/QWEN.md, goose .goosehints, kilo/roo/kiro rules dirs,
 * copilot-cli copilot-instructions.md) override memoryTargets in-adapter;
 * hosts whose user rules are app/UI/cloud-managed (warp Drive, trae,
 * jetbrains/cursor settings UI) deliberately have no row — user-scope memory
 * there reports the standard skip-warn (the JetBrains-MCP precedent), never a
 * write into a file the host ignores.
 */
const AGENTS_MD_USER_PATHS: Partial<Record<PlatformId, () => MemoryTarget>> = {
  // codex resolves its own user path in-adapter ($CODEX_HOME with ~ expansion
  // + the AGENTS.override.md shadow probe) — deliberately no row here.
  zed: () => ({
    path:
      process.platform === "win32" && process.env.APPDATA
        ? join(process.env.APPDATA, "Zed", "AGENTS.md")
        : join(homedir(), ".config", "zed", "AGENTS.md"),
    reason: "zed personal instructions file",
  }),
  amp: () => ({
    path: join(homedir(), ".config", "amp", "AGENTS.md"),
    reason: "amp user-scope AGENTS.md",
  }),
  mux: () => ({
    path: join(homedir(), ".mux", "AGENTS.md"),
    reason: "mux global AGENTS.md",
  }),
  pi: () => ({
    path: join(homedir(), ".pi", "agent", "AGENTS.md"),
    reason: "pi global AGENTS.md",
  }),
  droid: () => ({
    path: join(homedir(), ".factory", "AGENTS.md"),
    reason: "droid (Factory) personal AGENTS.md",
  }),
  opencode: () => ({
    path: join(homedir(), ".config", "opencode", "AGENTS.md"),
    reason: "opencode global AGENTS.md",
  }),
  antigravity: () => ({
    path: join(homedir(), ".gemini", "AGENTS.md"),
    reason: "antigravity global rules (~/.gemini/AGENTS.md, shared tree)",
  }),
  "antigravity-cli": () => ({
    path: join(homedir(), ".gemini", "AGENTS.md"),
    reason: "agy shares the IDE's ~/.gemini tree (idempotent upsert dedupes)",
  }),
  omp: () => ({
    path: join(homedir(), ".omp", "agent", "AGENTS.md"),
    reason: "omp global AGENTS.md (pi-parity; verify for your version)",
  }),
};

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

  // ── Memory surface (managed marker blocks; AGENTS.md-first) ───────────────
  // ONE generic implementation for every supporting host: the per-adapter
  // `memoryTargets()` hook resolves WHERE to write (AGENTS.md defaults below;
  // claude-code → CLAUDE.md and gemini-cli → GEMINI.md override it), and the
  // core/managed-block engine performs the surgical, hash-stamped block edit.
  // Unlike commands/skills/subagents these files are SHARED and user-authored —
  // bytes outside this connector's own marker pair are never touched.

  /**
   * Resolve the memory/rules file(s) this host actually reads at ctx.scope.
   * Base default (AGENTS.md-first, owner mandate):
   *   - an explicit `platforms[<id>].memory.path` override wins;
   *   - project scope → `<projectDir>/AGENTS.md` (the agents.md standard);
   *   - user scope → the host's documented user-scope AGENTS.md, when one
   *     exists ({@link AGENTS_MD_USER_PATHS}); otherwise [] → skip-warn.
   * Exception hosts (claude-code, gemini-cli) override this hook.
   */
  protected memoryTargets(ctx: InstallContext): MemoryTarget[] {
    const override = this.memoryOverride(ctx);
    if (override?.path) {
      const base = ctx.scope === "project" ? ctx.projectDir : homedir();
      return [
        {
          path: isAbsolute(override.path) ? override.path : join(base, override.path),
          reason: `platforms.${this.id}.memory.path override`,
        },
      ];
    }
    if (ctx.scope === "project") {
      return [
        { path: join(ctx.projectDir, "AGENTS.md"), reason: "AGENTS.md standard (project root)" },
      ];
    }
    if (ctx.scope === "user") {
      const user = AGENTS_MD_USER_PATHS[this.id]?.();
      return user ? [user] : [];
    }
    return [];
  }

  /** The per-platform memory override object, when one is declared. */
  protected memoryOverride(ctx: InstallContext): PlatformMemoryOverride | undefined {
    const o = ctx.connector.platforms[this.id]?.memory;
    return o && typeof o === "object" ? o : undefined;
  }

  installMemory(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    // `?? []` tolerates pre-resolved connectors from versions before the
    // memory surface existed (the installer applies the same guard).
    const entries = connector.memory ?? [];
    if (connector.platforms[this.id]?.memory === false) {
      return [{ platform: this.id, action: "skip", detail: `memory disabled for ${this.id}` }];
    }
    if (entries.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no memory" }];
    }
    if (!(this.capabilities.supportsMemory ?? false)) {
      return this.unsupportedSurface(ctx, "memory", entries.length);
    }

    const changes: ChangeRecord[] = [];
    const override = this.memoryOverride(ctx);
    if (override?.mode && this.id !== "claude-code") {
      changes.push({
        platform: this.id,
        action: "warn",
        detail: `memory.mode is claude-code-only; ignored on ${this.id}`,
      });
    }
    if (ctx.scope !== "project" && ctx.scope !== "user") {
      // system/profile/managed memory files are admin-owned — out of scope (v1).
      changes.push({
        platform: this.id,
        action: "warn",
        detail:
          `memory not supported at ${ctx.scope} scope on ${this.id} ` +
          `(managed/admin memory files are out of scope); ${entries.length} skipped`,
      });
      return changes;
    }
    const targets = this.memoryTargets(ctx);
    if (targets.length === 0) {
      changes.push({
        platform: this.id,
        action: "warn",
        detail:
          `no ${ctx.scope}-scope memory file on ${this.id} ` +
          `(user rules are app/UI-managed or undocumented); ${entries.length} skipped`,
      });
      return changes;
    }
    changes.push(...this.writeMemoryBlocks(ctx, targets));
    return changes;
  }

  /**
   * Upsert every declared memory entry's block into every resolved target and
   * record the ownership ledger rows (`connectorDir(id)/memory-state.json`).
   * Shared by the base implementation and the exception-host overrides.
   */
  protected writeMemoryBlocks(ctx: InstallContext, targets: MemoryTarget[]): ChangeRecord[] {
    const changes: ChangeRecord[] = [];
    const ledger = loadMemoryLedger(ctx.connector.id);
    let ledgerMutated = false;

    for (const target of targets) {
      for (const entry of ctx.connector.memory ?? []) {
        const blockId = `${ctx.connector.id}/${entry.name ?? "memory"}`;
        const res = upsertManagedBlockFile(target.path, {
          blockId,
          connectorId: ctx.connector.id,
          content: entry.content,
          ...(target.commentStyle ? { commentStyle: target.commentStyle } : {}),
          force: ctx.force ?? false,
          dryRun: ctx.dryRun,
        });
        changes.push({
          platform: this.id,
          action: res.action,
          path: target.path,
          detail: `memory: ${res.detail} — ${target.reason}`,
        });
        if (res.backupPath) {
          changes.push({
            platform: this.id,
            action: "create",
            path: res.backupPath,
            detail: "backed up memory file before destructive change",
          });
        }
        const bytes = Buffer.byteLength(entry.content, "utf8");
        if (bytes > MEMORY_CONTENT_SOFT_BUDGET_BYTES) {
          changes.push({
            platform: this.id,
            action: "warn",
            path: target.path,
            detail:
              `memory entry "${entry.name ?? "memory"}" is ${bytes} bytes ` +
              `(soft budget ${MEMORY_CONTENT_SOFT_BUDGET_BYTES}); this file is injected into ` +
              `every prompt — keep guidance terse`,
          });
        }
        if (res.action !== "warn") {
          recordMemoryTarget(ledger, {
            platform: this.id,
            scope: ctx.scope,
            path: target.path,
            blockId,
            createdFile: res.createdFile,
            hash: res.hash,
          });
          ledgerMutated = true;
        }
      }
      // Per-FILE budget (e.g. codex caps combined project docs at 32 KiB —
      // budgetBytes ≈ 28 KiB leaves headroom): warn when the whole target file
      // (user content + every block) outgrows what the host will actually load.
      if (target.budgetBytes !== undefined && !ctx.dryRun && existsSync(target.path)) {
        const fileBytes = statSync(target.path).size;
        if (fileBytes > target.budgetBytes) {
          changes.push({
            platform: this.id,
            action: "warn",
            path: target.path,
            detail:
              `memory file is ${fileBytes} bytes — over this host's ~${target.budgetBytes}-byte ` +
              `budget; the host may truncate or drop it`,
          });
        }
      }
    }

    if (ledgerMutated && !ctx.dryRun) saveMemoryLedger(ctx.connector.id, ledger);
    return changes;
  }

  uninstallMemory(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (!(this.capabilities.supportsMemory ?? false)) {
      // Nothing could ever have been written by a non-supporting adapter.
      return this.unsupportedSurface(ctx, "memory", (connector.memory ?? []).length);
    }

    // Candidate files = union of (a) memoryTargets recomputed NOW (probe re-run
    // — catches teammate machines with no ledger; the markers in the committed
    // file are the source of truth) and (b) ledger rows for this platform from
    // EVERY scope (catches a scope flag that differs from install time).
    const ledger = loadMemoryLedger(connector.id);
    const mine = ledger.targets.filter((t) => t.platform === this.id);
    const candidates = new Map<string, { createdFile: boolean }>();
    if (ctx.scope === "project" || ctx.scope === "user") {
      for (const t of this.memoryTargets(ctx)) {
        candidates.set(t.path, { createdFile: false });
      }
    }
    for (const row of mine) {
      const existing = candidates.get(row.path);
      candidates.set(row.path, { createdFile: (existing?.createdFile ?? false) || row.createdFile });
    }
    if (candidates.size === 0) {
      return [
        { platform: this.id, action: "skip", detail: `no memory targets to clean on ${this.id}` },
      ];
    }

    // Prefix scan (`<connectorId>/`), NOT the declared entry list: renamed or
    // removed entries and stale blocks from older versions are reclaimed too.
    const changes: ChangeRecord[] = [];
    for (const [path, { createdFile }] of candidates) {
      const results = removeManagedBlocksFile(
        path,
        { blockIdPrefix: `${connector.id}/` },
        { dryRun: ctx.dryRun, deleteFileIfCreated: createdFile },
      );
      for (const r of results) {
        changes.push({
          platform: this.id,
          action: r.action,
          path: r.path,
          detail: `memory: ${r.detail}`,
        });
        if (r.backupPath) {
          changes.push({
            platform: this.id,
            action: "create",
            path: r.backupPath,
            detail: "backed up memory file before block removal",
          });
        }
      }
    }

    // Prune this connector's ledger rows for this platform (the file itself is
    // deleted when no rows remain). Markers stay the uninstall source of truth.
    if (!ctx.dryRun && mine.length > 0) {
      ledger.targets = ledger.targets.filter((t) => t.platform !== this.id);
      saveMemoryLedger(connector.id, ledger);
    }
    return changes;
  }

  /**
   * Doctor: per-ledger-row memory state for this platform — file present,
   * block present, and recorded-vs-actual inner hash (drift → warn, the
   * user edited inside our block; sync reports the same drift and never
   * clobbers it without --force).
   */
  protected memoryDiagnostics(ctx: InstallContext): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const rows = loadMemoryLedger(ctx.connector.id).targets.filter(
      (t) => t.platform === this.id,
    );
    for (const row of rows) {
      const check = `${this.name}: memory block ${row.blockId}`;
      if (!existsSync(row.path)) {
        results.push({
          check,
          status: "warn",
          message: `memory file missing: ${row.path}`,
          fix: "agent-connector install (sync) will re-create the block",
        });
        continue;
      }
      let raw: string;
      try {
        raw = readFileSync(row.path, "utf8");
      } catch {
        results.push({ check, status: "warn", message: `cannot read ${row.path}` });
        continue;
      }
      const block = listManagedBlocks(raw).find((b) => b.blockId === row.blockId);
      if (!block) {
        results.push({
          check,
          status: "warn",
          message: `managed block not found in ${row.path}`,
          fix: "agent-connector install (sync) will re-append it",
        });
      } else if (block.drifted) {
        results.push({
          check,
          status: "warn",
          message:
            `user-edited: inner content hash ${block.actualHash} differs from recorded ` +
            `${block.recordedHash} in ${row.path}; sync leaves it intact (use --force to overwrite)`,
        });
      } else {
        results.push({ check, status: "pass", message: `intact in ${row.path}` });
      }
      // Shadow-flip probe: re-run memoryTargets NOW for the row's scope — if
      // the host's resolution moved (a WARP.md / AGENTS.override.md / .rules /
      // .hermes.md appeared, gemini context.fileName changed), the written
      // block sits in a file the host no longer reads. The #1 wrong-file
      // risk; doctor is the detection layer.
      // (`_shared/` bridge rows deliberately live OUTSIDE memoryTargets —
      // e.g. claude-code's @AGENTS.md import in CLAUDE.md — skip those.)
      if (
        !row.blockId.startsWith("_shared/") &&
        row.scope === ctx.scope &&
        (ctx.scope === "project" || ctx.scope === "user")
      ) {
        const current = this.memoryTargets(ctx);
        if (current.length > 0 && !current.some((t) => t.path === row.path)) {
          results.push({
            check,
            status: "warn",
            message:
              `${this.id} now resolves its ${row.scope}-scope memory file to ` +
              `${current[0]!.path} (${current[0]!.reason}) — the block in ${row.path} ` +
              `may no longer be read`,
            fix: "agent-connector install (sync) re-probes and writes the file the host reads now",
          });
        }
      }
    }
    return results;
  }

  // ── Declarative host-config key patches (configPatch) ─────────────────────
  // CONCRETE (overridable) defaults, mirroring the content surfaces above: the
  // installer additionally guards these behind capabilities.supportsConfigPatch
  // (the nativeHooks precedent), so these defaults only fire if a capability-
  // flagged adapter forgot to override them — still skip-warn, never silent.

  installConfigPatches(ctx: InstallContext): ChangeRecord[] {
    const count = (ctx.connector.platforms[this.id]?.configPatch ?? []).length;
    if (count === 0) {
      return [
        { platform: this.id, action: "skip", detail: "connector declares no configPatch entries" },
      ];
    }
    return [
      {
        platform: this.id,
        action: "warn",
        detail: `configPatch not supported on ${this.id}; ${count} skipped`,
      },
    ];
  }

  uninstallConfigPatches(_ctx: InstallContext): ChangeRecord[] {
    // Nothing was ever applied by a non-supporting adapter → nothing to release.
    return [];
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
   * Delegates to the shared renderer (adapters/claude-code/render) so every
   * content-file path — adapters AND the plugin packager — emits identical bytes.
   */
  protected renderFrontmatterMd(
    frontmatter: Record<string, unknown>,
    body: string,
  ): string {
    return renderFrontmatterMd(frontmatter, body);
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
    // Memory-surface checks are ledger-driven: no installed memory → no rows →
    // no noise. Shared by every adapter (the overrides call super.doctor()).
    results.push(...this.memoryDiagnostics(ctx));
    return results;
  }
}
