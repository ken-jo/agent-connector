/**
 * adapters/mux — Xum (Coder, formerly Mux) platform adapter for agent-connector.
 *
 * Xum is an **mcp-only** host: it exposes no lifecycle hook system, and MCP is
 * its extensibility mechanism. This adapter therefore installs only the MCP
 * server and reports hooks as unavailable — the same shape as the Warp
 * reference adapter.
 *
 * MCP config:
 *   - user scope    → ~/.xum/mcp.jsonc   (legacy home: ~/.mux/mcp.jsonc)
 *   - project scope → <projectDir>/.xum/mcp.jsonc (legacy: .mux/mcp.jsonc)
 *
 * RENAME (verified 2026-09-02): Coder renamed Mux to **Xum** (repo coder/mux →
 * coder/xum, xum.coder.com) and moved the config home from `.mux` to `.xum`.
 * The docs are explicit that the old home still works — "Legacy project files
 * under `.mux/` remain readable when the corresponding `.xum/` file is absent",
 * and "the exact location derives from the active Xum home (a legacy `~/.mux`
 * home keeps working)" (docs/config/mcp-servers.mdx). So `xumHome()` mirrors the
 * host: prefer `.xum`, fall back to an EXISTING `.mux`, and default new installs
 * to `.xum`. Writing blindly to `.xum` would strand every current user; writing
 * blindly to `.mux` would rot. The platform id stays `mux` — renaming it would
 * break existing connector configs and telemetry keys for no user benefit.
 *
 * NOT WIRED (noted 2026-09-02): Xum has an EXPERIMENTAL Agent Plugins reader
 * (Settings → Experiments) that installs plugins into `~/.xum/plugins`, honors
 * the spec's `PLUGIN_ROOT`/`PLUGIN_DATA`, and surfaces a plugin's `mcp.json`
 * servers. We deliberately do NOT route this host to the `agent-plugin` format:
 * Xum is absent from agent-plugins.org/compatible-clients, the reader is behind
 * an experiment flag, and its plugin servers are disabled-by-default and
 * trust-gated — so an AP bundle would install into a surface most users have
 * turned off. Revisit if Xum ships it on by default or joins the client list.
 *   Both are JSONC (comments allowed) but we write strict JSON. The root key is
 *   "servers", and this file doubles as the (non-existent) hook config — there
 *   is no separate hook file here.
 *
 * QUIRK: Xum models each server entry as a single shell-command STRING, not an
 * object. So `servers[id]` is `"<exe> <arg1> <arg2> ..."` — space-joined, with
 * any token containing whitespace double-quoted. We therefore build that string
 * ourselves and upsert it idempotently (the generic object upsert helper would
 * write the wrong shape). When telemetry-wrapping, the string is the home-bin
 * `serve` wrapper command followed by its args.
 *
 * Xum documents no native `${env:VAR}` interpolation token, so env-refs in the
 * command/args are resolved to literals at install time. The string form has no
 * place for an env map, so server.env is dropped with no native equivalent.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { BaseAdapter } from "../base.js";
import type { Adapter, InstallContext } from "../spi.js";
import type {
  ChangeRecord,
  DetectedPlatform,
  HealthCheck,
  HookParadigm,
  PlatformCapabilities,
  PlatformId,
  ServerDef,
} from "../../core/types.js";
import { resolveEnvRefs, resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildWrappedStdio,
} from "../../core/spawn.js";
import { renderSkillMd } from "../claude-code/render.js";

const HOST: PlatformId = "mux";
const MCP_ROOT_KEY = "servers";

/**
 * Xum enforces this exact pattern (1–64 chars) on a SKILL directory name, and
 * the SKILL.md `name` field MUST equal the directory name
 * (mux.coder.com/agents/agent-skills). A skill name that does not match is
 * skip-warned rather than written to a dir Xum would reject.
 */
const MUX_SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MUX_SKILL_NAME_MAX = 64;

/**
 * Resolve Xum's config home under `base`, mirroring the host's own rule.
 *
 * Xum reads `.xum/` and falls back to a legacy `.mux/` home
 * (docs/config/mcp-servers.mdx). We resolve the same way so that:
 *   - a machine already running the old Mux keeps its servers in `.mux/`
 *     instead of silently gaining a second, ignored config;
 *   - anything new lands in `.xum/`, which is where Xum looks first.
 * Only an EXISTING legacy dir wins — `.xum` is the default for fresh installs.
 */
function xumHome(base: string): string {
  const current = join(base, ".xum");
  if (existsSync(current)) return current;
  const legacy = join(base, ".mux");
  return existsSync(legacy) ? legacy : current;
}

/** Quote a token only when it contains whitespace (Xum command-string form). */
function quoteToken(token: string): string {
  return /\s/.test(token) ? `"${token}"` : token;
}

/** Join an executable + args into Xum's single shell-command string. */
function buildCommandString(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteToken).join(" ");
}

export class MuxAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Xum";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block via the BaseAdapter default
    // (memoryTargets: project <projectDir>/AGENTS.md; user scope where documented).
    supportsMemory: true,
    // Xum has no lifecycle hook system — every hook capability is false.
    preToolUse: false,
    postToolUse: false,
    preCompact: false,
    sessionStart: false,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: false,
    // Xum's command-string server entry is stdio-only.
    transports: ["stdio"],
    // Content surface: Xum auto-discovers dir-per-skill SKILL.md from its
    // workspace-local and global roots (mux.coder.com/agents/agent-skills,
    // fetched 2026-06-16):
    //   project → <projectDir>/.xum/skills/<name>/SKILL.md (workspace-local)
    //   user    → ~/.xum/skills/<name>/SKILL.md (global, Xum-specific)
    // The skill directory name MUST match ^[a-z0-9]+(?:-[a-z0-9]+)*$ (1–64
    // chars) and the SKILL.md `name` field must equal it — a name that cannot
    // be represented is skip-warned (see installSkills).
    supportsSkills: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = xumHome(homedir());
    const userMcp = join(userDir, "mcp.jsonc");
    const projDir = xumHome(projectDir);
    const projMcp = join(projDir, "mcp.jsonc");

    const userInstalled = existsSync(userDir) || existsSync(userMcp);
    const projInstalled = existsSync(projDir) || existsSync(projMcp);
    const installed = userInstalled || projInstalled;
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projMcp : userMcp;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? `found Xum config (${scope})`
        : `no Xum config at ${userDir} or ${projDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return xumHome(ctx.scope === "project" ? ctx.projectDir : homedir());
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "mcp.jsonc");
  }

  /**
   * Xum has no hook file — hooks are not a thing here. The hook "config path"
   * is the same mcp.jsonc so the generic doctor/backup behave sensibly.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return this.getServerConfigPath(ctx);
  }

  // ── MCP server install / uninstall ───────────────────────────────────────

  installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const override = connector.platforms[HOST]?.server;
    if (!connector.server || override === false) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail: connector.server
            ? "server registration disabled for mux"
            : "connector declares no MCP server",
        },
      ];
    }

    // Shallow-merge any per-platform server override into the base ServerDef.
    const server: ServerDef =
      override && typeof override === "object"
        ? { ...connector.server, ...override }
        : connector.server;

    const path = this.getServerConfigPath(ctx);

    if (server.transport !== "stdio" || !server.command) {
      // Xum's command-string entry is stdio-only; remote transports skip.
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: `transport "${server.transport}" not registrable (mux expects a stdio command string)`,
        },
      ];
    }

    const entry = this.renderCommandString(ctx, server);
    // Xum's server VALUE is a command string, but the object-map upsert is
    // value-agnostic — route through the shared helper (byte-identical output).
    return [this.upsertServerInJson(path, MCP_ROOT_KEY, connector.id, entry, dryRun)];
  }

  uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const path = this.getServerConfigPath(ctx);
    return [
      this.removeServerFromJson(path, MCP_ROOT_KEY, ctx.connector.id, ctx.dryRun),
    ];
  }

  /**
   * Render a stdio ServerDef into Xum's single shell-command string. Honors the
   * telemetry serve-wrapper and resolves every `${env:VAR}` to a literal (Xum
   * documents no native interpolation token).
   */
  private renderCommandString(ctx: InstallContext, server: ServerDef): string {
    let command = server.command ?? "";
    let args = [...(server.args ?? [])];

    // Transparent telemetry wrapping: route the real command through
    // `<homeBin> serve --connector <id> -- <command> <args...>`.
    ({ command, args } = buildWrappedStdio(ctx, server, this.id, command, args));

    // Resolve env-refs to literals (Xum has no native interpolation token).
    command = resolveEnvRefs(command);
    args = resolveEnvRefsDeep(args);

    return buildCommandString(command, args);
  }

  // ── Hooks (unavailable — Xum is mcp-only) ─────────────────────────────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Xum is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Xum is mcp-only)",
      },
    ];
  }

  // ── Content surface: skills (dir-per-skill SKILL.md) ─────────────────────
  // CONTENT-ONLY: pure native-file writers, mirroring goose/openclaw. No
  // runtime dispatch, no home-bin pointer, no telemetry wrap. Idempotent
  // (byte-identical → skip) via writeContentFile and reversible via
  // removeContentFile + removeDirIfEmpty. Honors platforms["mux"].skills ===
  // false. No mcp.jsonc entry — Xum auto-discovers the skills dirs.
  //
  // Native locations (mux.coder.com/agents/agent-skills):
  //   project → <projectDir>/.xum/skills/<name>/SKILL.md (workspace-local)
  //   user    → ~/.xum/skills/<name>/SKILL.md (global, Xum-specific)
  // The dir name MUST match MUX_SKILL_NAME_RE (1–64 chars) and the SKILL.md
  // `name` field must equal it — a name that can't be represented is skip-warned.

  /** The skills ROOT dir for ctx.scope (parent of every per-skill dir). */
  private skillsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "skills");
  }

  /** Per-skill directory: <skillsDir>/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for mux" }];
    }
    if (connector.skills.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no skills" }];
    }
    const changes: ChangeRecord[] = [];
    for (const skill of connector.skills) {
      // Xum REQUIRES the dir name (and SKILL.md `name`) to match its pattern;
      // a name we cannot represent is skip-warned rather than written to a dir
      // Xum would reject (the honesty bar — never write an unreadable path).
      if (!this.isValidSkillName(skill.name)) {
        changes.push({
          platform: this.id,
          action: "warn",
          detail:
            `skill "${skill.name}" cannot be represented on mux ` +
            `(name must match ${MUX_SKILL_NAME_RE.source}, 1–${MUX_SKILL_NAME_MAX} chars); skipped`,
        });
        continue;
      }
      const dir = this.skillDir(ctx, skill.name);
      // Guard a skills path occupied by a regular FILE (mkdir would throw
      // ENOTDIR): skip-warn rather than crash (cline `.clinerules`-is-a-file
      // precedent).
      const blockingFile = this.firstFileOnSkillPath(ctx, dir);
      if (blockingFile !== null) {
        changes.push({
          platform: this.id,
          action: "warn",
          path: blockingFile,
          detail: `${blockingFile} is a file, not a directory; skill "${skill.name}" skipped`,
        });
        continue;
      }
      changes.push(
        this.writeContentFile(join(dir, "SKILL.md"), renderSkillMd(skill), ctx.dryRun),
      );
      // Bundle any resource files beside SKILL.md (relative path → contents).
      // Defense-in-depth: skip+warn on any key that escapes the skill dir.
      for (const [rel, contents] of Object.entries(skill.resources ?? {})) {
        const target = this.resolveWithin(dir, rel);
        if (target === null) {
          changes.push({
            platform: this.id,
            action: "warn",
            detail: `skill resource "${rel}" escapes the skill dir; skipped`,
          });
          continue;
        }
        changes.push(this.writeContentFile(target, contents, ctx.dryRun));
      }
    }
    return changes;
  }

  override uninstallSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.skills.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no skills" }];
    }
    const changes: ChangeRecord[] = [];
    for (const skill of connector.skills) {
      // Skip names install never wrote (invalid → never on disk under our dir).
      if (!this.isValidSkillName(skill.name)) continue;
      const dir = this.skillDir(ctx, skill.name);
      // Remove only the files we wrote (SKILL.md + declared resources), then the
      // skill dir itself when we own its full contents.
      changes.push(this.removeContentFile(join(dir, "SKILL.md"), ctx.dryRun));
      for (const rel of Object.keys(skill.resources ?? {})) {
        const target = this.resolveWithin(dir, rel);
        if (target === null) continue; // never delete outside the skill dir
        changes.push(this.removeContentFile(target, ctx.dryRun));
      }
      // Only remove the skill dir when WE own its full contents — never rm -rf a
      // dir that still holds user-added / sibling-tool / shared files.
      changes.push(this.removeDirIfEmpty(dir, ctx.dryRun));
    }
    if (changes.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "no installable skills to remove" }];
    }
    return changes;
  }

  /** True when a skill name is representable as a Xum skill directory name. */
  private isValidSkillName(name: string): boolean {
    return name.length >= 1 && name.length <= MUX_SKILL_NAME_MAX && MUX_SKILL_NAME_RE.test(name);
  }

  /**
   * Walk from the skills root down to `leaf` and return the FIRST segment that
   * exists as a regular file (a mkdir there throws ENOTDIR), else null — so
   * installSkills can skip-warn instead of crashing.
   */
  private firstFileOnSkillPath(ctx: InstallContext, leaf: string): string | null {
    const root = this.skillsDir(ctx);
    const segments: string[] = [];
    let cur = leaf;
    while (cur.length >= root.length) {
      segments.unshift(cur);
      if (cur === root) break;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    for (const p of segments) {
      if (!existsSync(p)) return null;
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        return null;
      }
    }
    return null;
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const mcpPath = this.getServerConfigPath(ctx);
    const connectorId = ctx.connector.id;
    return [
      {
        name: `${this.name}: mcp.jsonc present`,
        check: () =>
          existsSync(mcpPath)
            ? { status: "OK", detail: mcpPath }
            : { status: "FAIL", detail: `not found: ${mcpPath}` },
      },
      {
        name: `${this.name}: server entry registered`,
        check: () => {
          // Only assert what the connector declares: a server-less connector
          // never writes an mcpServers entry, so its absence is healthy.
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const cfg = this.readJson<{ [k: string]: Record<string, unknown> }>(
            mcpPath,
          );
          const bucket = cfg?.[MCP_ROOT_KEY];
          if (!cfg || !bucket) {
            return { status: "FAIL", detail: `no ${MCP_ROOT_KEY} in ${mcpPath}` };
          }
          return connectorId in bucket
            ? { status: "OK", detail: `${MCP_ROOT_KEY}.${connectorId} present` }
            : {
                status: "FAIL",
                detail: `no ${MCP_ROOT_KEY}.${connectorId} in ${mcpPath}`,
              };
        },
      },
    ];
  }
}

export const adapter = new MuxAdapter();
export default adapter;
