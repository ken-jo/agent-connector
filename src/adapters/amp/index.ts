/**
 * adapters/amp — Amp (Sourcegraph / AmpCode) platform adapter for agent-connector.
 *
 * Amp is an **mcp-only** host: it exposes no lifecycle hook system, so MCP is the
 * only extensibility surface. This adapter installs the MCP server entry and
 * reports hooks as unavailable — the same shape validated by the Warp adapter.
 *
 * MCP config (report §2 / §5.3):
 *   - user scope    → ~/.config/amp/settings.json
 *   - project scope → <projectDir>/.amp/settings.json
 *   Both are JSONC (we write plain JSON, which is valid JSONC). The settings file
 *   is SHARED with the rest of Amp's configuration, so we MERGE our entry into
 *   the existing object and never clobber unrelated keys.
 *
 * QUIRK 1 — dotted top-level key: Amp does NOT use a nested `mcpServers` object.
 * The MCP registry is a single FLAT settings key literally named
 * `"amp.mcpServers"`, whose value is an object of `{ id: { command, args, env } }`.
 * We therefore set `settings["amp.mcpServers"][connectorId] = entry`. Because the
 * base JSON helpers index `config[rootKey][serverId]`, passing the dotted string
 * as the root key writes exactly that flat key while preserving every sibling
 * setting (true merge).
 *
 * QUIRK 2 — native interpolation: Amp expands `${VAR_NAME}` in stdio entries at
 * runtime, so we KEEP env/header/url refs native by rewriting the portable
 * `${env:VAR}` syntax to Amp's `${VAR}` token rather than resolving to literals
 * (secrets stay out of the settings file).
 *
 * Skills surface: Amp reads SKILL.md files (dir-per-skill, same shape as
 * claude-code) from a skill root that is NOT under the config dir
 * (`~/.config/amp`):
 *   - user scope    → ~/.config/agents/skills/<name>/SKILL.md  (the sibling
 *     cross-agent `agents` dir — `~/.config/amp/skills/` is also documented-native,
 *     but the `agents` root is the cross-agent standard we standardize on)
 *   - project scope → <projectDir>/.agents/skills/<name>/SKILL.md
 * Because that root differs from getConfigDir, skills use a dedicated skillDir()
 * helper rather than reusing getConfigDir.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  SkillDef,
  Transport,
} from "../../core/types.js";
import { rewriteEnvRefs } from "../../core/interpolate.js";
import {
  buildServeWrapperCommand,
  isHomeBinHookCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";
import { renderSkillMd } from "../claude-code/render.js";

const HOST: PlatformId = "amp";
/**
 * QUIRK: a single FLAT, dotted settings key — NOT a nested object. The base
 * JSON helpers treat this as `config["amp.mcpServers"][serverId]`.
 */
const MCP_ROOT_KEY = "amp.mcpServers";

/** Native MCP server entry shapes Amp accepts under `amp.mcpServers`. */
interface AmpStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
interface AmpHttpServer {
  url: string;
  headers?: Record<string, string>;
}

export class AmpAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Amp";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block via the BaseAdapter default
    // (memoryTargets: project <projectDir>/AGENTS.md; user scope where documented).
    supportsMemory: true,
    // Amp has no lifecycle hook system — every hook capability is false.
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
    // Amp registers stdio and Streamable HTTP MCP servers.
    transports: ["stdio", "http"],
    // Skills: Amp reads SKILL.md from ~/.config/agents/skills/<name>/SKILL.md
    // (user) and <projectDir>/.agents/skills/<name>/SKILL.md (project) — a root
    // OUTSIDE the config dir, so the skillDir() helper resolves it explicitly.
    supportsSkills: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".config", "amp");
    const userSettings = join(userDir, "settings.json");
    const projectDirAmp = join(projectDir, ".amp");
    const projectSettings = join(projectDirAmp, "settings.json");

    const userInstalled = existsSync(userDir) || existsSync(userSettings);
    const projectInstalled = existsSync(projectDirAmp) || existsSync(projectSettings);
    const installed = userInstalled || projectInstalled;
    const scope = projectInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projectSettings : userSettings;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? `found Amp config (${scope}) at ${configPath}`
        : `no Amp config at ${userSettings} or ${projectSettings}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".amp")
      : join(homedir(), ".config", "amp");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "settings.json");
  }

  /**
   * Amp has no hook file — hooks are not a thing here. The hook "config path" is
   * the same settings.json so the generic doctor/backup behave sensibly.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return this.getServerConfigPath(ctx);
  }

  // ── MCP server install / uninstall ───────────────────────────────────────

  installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    const override = connector.platforms[HOST]?.server;
    if (!connector.server || override === false) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail: connector.server
            ? "server registration disabled for amp"
            : "connector declares no MCP server",
        },
      ];
    }

    // Shallow-merge any per-platform server override into the base ServerDef.
    const server: ServerDef =
      override && typeof override === "object"
        ? { ...connector.server, ...override }
        : connector.server;

    const serverPath = this.getServerConfigPath(ctx);
    const entry = this.renderServerEntry(ctx, server);

    // Upsert into the flat "amp.mcpServers" key, merging into existing settings.
    return [
      this.upsertServerInJson(serverPath, MCP_ROOT_KEY, connector.id, entry, ctx.dryRun),
    ];
  }

  uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const serverPath = this.getServerConfigPath(ctx);
    return [
      this.removeServerFromJson(serverPath, MCP_ROOT_KEY, ctx.connector.id, ctx.dryRun),
    ];
  }

  /** Render a normalized ServerDef into Amp's native `amp.mcpServers` entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): AmpStdioServer | AmpHttpServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

      // Transparent telemetry wrapping: route the real command through
      // `<homeBin> serve --connector <id> -- <command> <args...>`.
      if (shouldWrapForTelemetry(server, ctx.connector.telemetry)) {
        const wrapped = buildServeWrapperCommand(
          ctx.homeBinPath,
          ctx.connector.id,
          command,
          args,
          ctx.scope,
          this.id,
        );
        command = wrapped.command;
        args = wrapped.args;
      }

      // Amp expands ${VAR_NAME} natively, so keep refs native (no literals).
      const entry: AmpStdioServer = { command: this.rewrite(command) };
      if (args.length > 0) entry.args = args.map((a) => this.rewrite(a));
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // http (and any other remote transport we surface) — Amp registers a URL.
    const entry: AmpHttpServer = { url: this.rewrite(server.url ?? "") };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Amp supports native `${VAR_NAME}` interpolation,
   * so translate `${env:VAR}` refs to that native token rather than baking
   * secrets into the file. Literals pass through unchanged.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) out[k] = this.rewrite(v);
    return out;
  }

  /** Translate `${env:VAR(:-default)}` to Amp's native `${VAR}` token. */
  private rewrite(value: string): string {
    return rewriteEnvRefs(value, ampEnvToken);
  }

  // ── Skills surface ───────────────────────────────────────────────────────
  // CONTENT-ONLY: pure native-file writers under the skill root. No runtime
  // dispatch, no home-bin pointer, no telemetry wrap. Idempotent (byte-identical
  // → skip) via writeContentFile and reversible via removeContentFile. Honors
  // platforms["amp"].skills === false to skip.
  //
  // QUIRK: the skill root is NOT under getConfigDir (~/.config/amp). Amp reads
  // SKILL.md from the sibling cross-agent `agents` tree:
  //   user scope    → ~/.config/agents/skills/<name>/SKILL.md
  //   project scope → <projectDir>/.agents/skills/<name>/SKILL.md
  // so skillDir() resolves it explicitly rather than reusing getConfigDir.

  /** Skill root: user `~/.config/agents/skills`, project `<projectDir>/.agents/skills`. */
  private skillsDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".agents", "skills")
      : join(homedir(), ".config", "agents", "skills");
  }

  /** Native skill dir: <skillRoot>/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for amp" }];
    }
    if (connector.skills.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no skills" }];
    }
    const changes: ChangeRecord[] = [];
    for (const skill of connector.skills) {
      const dir = this.skillDir(ctx, skill.name);
      changes.push(
        this.writeContentFile(join(dir, "SKILL.md"), this.renderSkill(skill), ctx.dryRun),
      );
      // Bundle any resource files beside SKILL.md (relative path → contents).
      // Defense-in-depth: skip+warn on any key that escapes the skill dir
      // (config-time validation already rejects these, but never trust input).
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
    return changes;
  }

  /** Render a skill's SKILL.md (delegates to the shared renderer). */
  private renderSkill(skill: SkillDef): string {
    return renderSkillMd(skill);
  }

  // ── Hooks (unavailable — Amp is mcp-only) ────────────────────────────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Amp is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Amp is mcp-only)",
      },
    ];
  }

  /**
   * True when a hook command references our home binary AND this connector id
   * (anchored so a shared-prefix id can't collide — see isHomeBinHookCommand).
   * Amp installs no hooks, but this guard keeps any future shared-file edit from
   * removing another connector's entries.
   */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const settingsPath = this.getServerConfigPath(ctx);
    const connectorId = ctx.connector.id;
    return [
      {
        name: `${this.name}: settings.json present`,
        check: () =>
          existsSync(settingsPath)
            ? { status: "OK", detail: settingsPath }
            : { status: "FAIL", detail: `not found: ${settingsPath}` },
      },
      {
        name: `${this.name}: server entry registered`,
        check: () => {
          // Only assert what the connector declares: a server-less connector
          // never writes a server entry, so its absence is healthy.
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const cfg = this.readJson<{ [k: string]: Record<string, unknown> }>(settingsPath);
          const bucket = cfg?.[MCP_ROOT_KEY];
          if (!cfg || !bucket) {
            return { status: "FAIL", detail: `no "${MCP_ROOT_KEY}" in ${settingsPath}` };
          }
          return connectorId in bucket
            ? { status: "OK", detail: `"${MCP_ROOT_KEY}".${connectorId} present` }
            : {
                status: "FAIL",
                detail: `no "${MCP_ROOT_KEY}".${connectorId} in ${settingsPath}`,
              };
        },
      },
    ];
  }
}

/**
 * Amp native interpolation token: `${env:VAR}` → `${VAR}`.
 *
 * When the portable ref carried a default (`${env:VAR:-fallback}`), Amp's native
 * `${VAR}` token has no way to express it — so a bare native token would silently
 * DROP the default. Instead, resolve the default at install time: emit the live
 * value when VAR is set and non-empty, else the literal fallback. The native
 * token is only emitted when there is no default to preserve.
 */
function ampEnvToken(name: string, def?: string): string {
  if (def !== undefined) {
    const v = process.env[name];
    return v != null && v !== "" ? v : def;
  }
  return `\${${name}}`;
}

export const adapter = new AmpAdapter();
export default adapter;
