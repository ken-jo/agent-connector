/**
 * adapters/base — shared adapter foundation.
 *
 * Provides JSON config IO, settings backup, and a default doctor. Per-platform
 * specifics (paths, capabilities, native render format, runtime parse/format)
 * are abstract and implemented by each adapter. TOML/YAML adapters override the
 * JSON helpers entirely.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
import type { Adapter, InstallContext } from "./spi.js";

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

  // ── JSON config helpers (used by JSON-format adapters) ───────────────────

  protected readJson<T = Record<string, unknown>>(path: string): T | null {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return null;
    }
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
