/**
 * adapters/antigravity-cli — Google Antigravity CLI (`agy`) platform adapter.
 *
 * Antigravity ships in two distinct runtimes that share the Gemini-family
 * `~/.gemini` tree and ALL of the same native formats (the JSON `mcp_config.json`
 * shape, the `hooks.json` lifecycle-hook shape, markdown Workflows, and Agent
 * Skills `SKILL.md`): the IDE/desktop app (the parent `AntigravityAdapter`,
 * id "antigravity") and this standalone CLI binary `agy` (id "antigravity-cli").
 *
 * This adapter is a thin fork of the IDE adapter. It REUSES every render / hook /
 * parse / surface path from {@link AntigravityAdapter} unchanged — the only
 * differences are identity and detection:
 *
 *   - id   = "antigravity-cli", name = "Antigravity CLI". Identity flows into the
 *     universal hook command (`<homeBin> hook antigravity-cli <event> …`) and the
 *     `hostPlatform` stamp, so a CLI-installed hook dispatches back to THIS
 *     adapter at runtime — the reason the parent's install/parse logic was made
 *     to read `this.id` rather than a fixed host constant.
 *   - Detection probes the `agy` binary at ~/.local/bin/agy and/or the SHARED
 *     ~/.gemini/antigravity/ presence (distinct runtime markers from the IDE).
 *
 * CONFIRMED-BY-INSTALL (2026-06-03, docs/research/antigravity-paths-confirmed.md):
 * the `agy` CLI v1.0.0 has NO separate config dir — `~/.gemini/antigravity-cli/`,
 * `~/.config/antigravity*`, and `~/.agy` are ALL ABSENT. `agy` SHARES the IDE's
 * `~/.gemini/antigravity/` tree (mcp_config.json, hooks.json, workflows, skills).
 * So the user-scope config resolution here is IDENTICAL to the IDE adapter (the
 * inherited USER_CONFIG_CANDIDATES) — installing both the IDE and CLI connectors
 * therefore writes the SAME files and is idempotent (observed as skip), which is
 * expected and correct. `agy`'s own extension surface is the `agy plugin` system
 * (install/uninstall/list/enable/disable) — future work would deploy as an agy
 * plugin; for now the MCP/workflows/skills surfaces ride the shared IDE files.
 *
 * LIVE-TEST RESOLUTION (2026-06-04, real `agy` v1.0.5 login + spawn): the prior
 * "shares the IDE's ~/.gemini/antigravity/ file" claim was WRONG for the CLI. The
 * standalone `agy` reads user MCP from **~/.gemini/config/mcp_config.json**
 * (root key `mcpServers`; project scope <proj>/.agents/mcp_config.json) — PROVEN:
 * a live `agy -p` session spawned an MCP server placed in `config/` and completed
 * a real initialize+tools/list+tools/call handshake; a negative control in
 * `antigravity/` was ignored. The binary carries "failed to read mcp_config.json"
 * + a literal "/.gemini/config" path; there is NO `--mcp-config` flag and `agy
 * mcp` is TUI-only. So this adapter now OVERRIDES userConfigCandidates to prefer
 * `~/.gemini/config/mcp_config.json` (canonical) over the inherited IDE
 * `antigravity/` default (kept as a prefer-existing fallback). Telemetry-wrap is
 * compatible: agy spawns command+args verbatim, so the home-bin serve wrapper is
 * spawned as written — i.e. a real agy session now emits a per-MCP telemetry row.
 * (agy also keeps its own home ~/.gemini/antigravity-cli/ for auth/state, but MCP
 * config lives in the shared ~/.gemini/config/.)
 *
 * Project scope is IDENTICAL to the IDE adapter (`<proj>/.agents/…`), as is every
 * hook/command/skill render and the runtime parse/format — all inherited.
 *
 * The user-scope config paths shared with the IDE (hooks.json + the global skills
 * dir) remain MEDIUM-CONFIDENCE / PATH-PROBED in the parent (not present on the
 * observed install) and surfaced by the doctor; user-scope mcp_config + workflows
 * are CONFIRMED at ~/.gemini/antigravity/.
 *
 * STATUSLINE SURFACE (LIVE-VERIFIED 2026-06-21, agy v1.0.10): the `agy` CLI ships
 * a first-party custom status line — `/statusline <command>` configures a shell
 * command that agy execs on each refresh, piping a JSON status payload on stdin.
 * The config is persisted in the GLOBAL `~/.gemini/antigravity-cli/settings.json`
 * under the top-level `statusLine` key, value shape `{ enabled: true, command }`
 * — NOT claude-code's `{ type:"command", command }` and NOT qwen-code's nested
 * `ui.statusLine`. This was confirmed by a real headless `agy -p` turn with the
 * statusLine command pointed at a stdin-logging script: the captured payload is
 *   { cwd, session_id, conversation_id, transcript_path,
 *     model:{ id, display_name },
 *     workspace:{ current_dir, project_dir },
 *     version,
 *     context_window:{ total_input_tokens, total_output_tokens,
 *                       context_window_size, used_percentage,
 *                       remaining_percentage,
 *                       current_usage:{ input_tokens, output_tokens, … } },
 *     exceeds_200k_tokens, product, quota, agent_state, vcs, sandbox,
 *     plan_tier, email, terminal_width }
 * Only the antigravity-cli FORK wires this (the IDE app's payload is not verified),
 * so the CLI adapter overrides `capabilities` to add `supportsStatusline: true`
 * and the statusline parse/format/install/uninstall here — every other path stays
 * inherited from {@link AntigravityAdapter}.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { AntigravityAdapter, adapter as antigravityIdeAdapter } from "../antigravity/index.js";
import type { Adapter, HookReply, InstallContext } from "../spi.js";
import type {
  ChangeRecord,
  DetectedPlatform,
  HealthCheck,
  HookEventName,
  JsonValue,
  PlatformCapabilities,
  PlatformId,
  StatuslineContext,
} from "../../core/types.js";
import {
  buildHomeBinStatuslineCommand,
  isHomeBinStatuslineCommand,
} from "../../core/spawn.js";
import {
  type ConfigPatchLedgerEntry,
  addLedgerOwner,
  createLedgerEntry,
  describeJsonValue,
  dropLedgerEntry,
  findLedgerEntry,
  hashJsonValue,
  jsonDeepEquals,
  ledgerEntriesOwnedBy,
  loadConfigPatchLedger,
  removeLedgerOwner,
  saveConfigPatchLedger,
} from "../../core/config-patch-ledger.js";

const HOST: PlatformId = "antigravity-cli";

/**
 * settings.json key the statusline surface owns on `agy`. The agy CLI stores its
 * custom status line under the TOP-LEVEL `statusLine` key (a single segment —
 * unlike qwen-code's nested `ui.statusLine`). LIVE-VERIFIED against agy v1.0.10
 * (binary StatusLineConfig JSON tags `statusLine`/`command`/`enabled`; a real turn
 * accepted and fired this shape). We own the `statusLine` leaf via the SAME
 * refcounted ownership ledger as configPatch — never clobbering a `statusLine` a
 * user (or another tool) already set.
 */
const STATUSLINE_KEY = "statusLine";

/**
 * The `agy` statusLine custom-command stdin payload (the documented status-line
 * input agy pipes on stdin, read once). Every field optional — a refresh only
 * carries what the host knows. LIVE-CAPTURED (agy v1.0.10, 2026-06-21). Unmodeled
 * fields (version, agent_state, vcs, plan_tier, quota, product, email,
 * terminal_width) stay in StatuslineContext.raw.
 *
 * NOTE the divergence from qwen-code: agy's `context_window.current_usage` is an
 * OBJECT (`{ input_tokens, output_tokens, … }`), NOT a number — so used tokens are
 * derived from the top-level `total_input_tokens + total_output_tokens`, and the
 * percent from `used_percentage`.
 */
interface AgyStatuslineInput {
  cwd?: string;
  session_id?: string;
  conversation_id?: string;
  transcript_path?: string;
  version?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  context_window?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
    used_percentage?: number;
    remaining_percentage?: number;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

export class AntigravityCliAdapter extends AntigravityAdapter implements Adapter {
  override readonly id: PlatformId = HOST;
  override readonly name = "Antigravity CLI";

  /**
   * Capabilities = the inherited IDE surface, with the two CLI-specific
   * divergences applied on top:
   *
   *   - `supportsStatusline: true` — the `agy` custom status line, live-verified
   *     above (the IDE app does NOT advertise statusline; its payload is unverified).
   *   - `sessionStart: false` — the `agy` CLI does NOT recognize a SessionStart
   *     hook. LIVE-VERIFIED (agy): the binary's recognized hook events are exactly
   *     PreToolUse / PostToolUse / PreInvocation / PostInvocation / Stop — the
   *     `/hooks` UI lists only those five and writing both SessionStart + PreToolUse
   *     into hooks.json loads ONLY PreToolUse. Declaring SessionStart on the IDE
   *     `antigravity` adapter is left UNCHANGED (this finding is agy-CLI-specific
   *     and was NOT verified for the IDE app). This flag is the source of truth for
   *     the docs hooks-matrix + the fleet-wide never-silent-drop contract; the
   *     matching install-time warn-skip is driven by {@link supportedHookEvents}.
   *
   * Everything else is spread from the IDE adapter's own capabilities so the two
   * surfaces stay in lock-step (a parent field added later flows in automatically).
   * `super.capabilities` is unusable here: the parent's `capabilities` is an
   * instance FIELD (not on the prototype), so it resolves to undefined in a
   * subclass field initializer — spread the IDE singleton instead.
   */
  override readonly capabilities: PlatformCapabilities = {
    ...antigravityIdeAdapter.capabilities,
    supportsStatusline: true,
    statuslineMode: "command-stdin",
    sessionStart: false,
  };

  /**
   * The hook events the `agy` CLI actually recognizes. LIVE-VERIFIED: agy's hook
   * event tokens are exactly PreToolUse / PostToolUse / PreInvocation /
   * PostInvocation / Stop — confirmed by the `/hooks` UI listing only those five,
   * by the binary's hook-event tokens, and by agy loading ONLY PreToolUse when
   * both SessionStart + PreToolUse are written into hooks.json. SessionStart is
   * therefore DROPPED: a declared SessionStart hook warn-skips at install rather
   * than writing an inert hooks.json entry that never loads / never fires / never
   * shows in `/hooks`. NOTE: PreInvocation / PostInvocation are agy-only events
   * with no canonical AC analog — left unmapped here (a possible future
   * nativeHooks enhancement, NOT this fix). This narrows the IDE's
   * {@link AntigravityAdapter.supportedHookEvents} (which still includes
   * SessionStart for the IDE app, where this finding was not verified).
   */
  private static readonly CLI_SUPPORTED_EVENTS: ReadonlySet<HookEventName> =
    new Set<HookEventName>(["PreToolUse", "PostToolUse", "Stop"]);

  protected override supportedHookEvents(): ReadonlySet<HookEventName> {
    return AntigravityCliAdapter.CLI_SUPPORTED_EVENTS;
  }

  // ── Detection ────────────────────────────────────────────────────────────

  /**
   * Probe the CLI's runtime markers, DISTINCT from the IDE app even though the
   * two share `~/.gemini/antigravity/`: the `agy` binary at ~/.local/bin/agy
   * (the definitive CLI marker, CONFIRMED present) and the shared
   * ~/.gemini/antigravity/ tree (or a user-scope mcp_config candidate / the
   * project config). Reported before the IDE adapter in the registry so the
   * more-specific CLI marker (the `agy` binary) wins host detection. Note: a
   * machine with ONLY the IDE (no `agy` binary) will not match here, while one
   * with the CLI matches on the binary regardless of the shared config dir.
   */
  override detectInstalled(projectDir: string): DetectedPlatform {
    const home = homedir();
    const userConfig = this.resolveUserConfigPath();
    const agyBin = join(home, ".local", "bin", "agy");
    const sharedDir = join(home, ".gemini", "antigravity");
    const projectConfig = join(projectDir, ".agents", "mcp_config.json");

    // The `agy` binary is the definitive CLI marker. The shared antigravity dir
    // and the user-scope mcp_config candidates are secondary signals (they also
    // match a pure-IDE install, so the binary is what truly distinguishes the CLI).
    const cliMarker = existsSync(agyBin);
    const userInstalled =
      cliMarker ||
      existsSync(sharedDir) ||
      this.userConfigCandidates().some((parts) => existsSync(join(home, ...parts)));
    const projInstalled = existsSync(projectConfig);
    const installed = userInstalled || projInstalled;

    // Report the scope/path that actually matched, so a project-only install
    // isn't misreported as a (non-existent) user install.
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projectConfig : userConfig;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? scope === "project"
          ? `found project Antigravity CLI config at ${projectConfig}`
          : `found Antigravity CLI (agy) at ${agyBin} / shared ${sharedDir}`
        : `no Antigravity CLI install at ${agyBin}, ${sharedDir}, or ${projectConfig}`,
      // The `agy` binary is a high-confidence CLI marker; matching only the shared
      // config dir is weaker (it could be a pure-IDE install).
      confidence: cliMarker ? "high" : installed ? "medium" : "low",
    };
  }

  /**
   * MCP user-config path — LIVE-PROVEN for `agy` v1.0.5 (2026-06-04). The
   * standalone CLI reads user MCP servers from `~/.gemini/config/mcp_config.json`
   * (root key `mcpServers`), NOT the IDE's `~/.gemini/antigravity/mcp_config.json`:
   * a real `agy -p` session spawned an MCP server ONLY when it was placed in
   * `config/` (negative control: a server in `antigravity/` was ignored), and the
   * binary carries the error string "failed to read mcp_config.json" + a literal
   * "/.gemini/config" path. `agy mcp` is TUI-only (no headless add) and there is
   * no `--mcp-config` flag. So the CLI must PREFER `config/` over the inherited
   * `antigravity/` default; the IDE path stays as a prefer-existing fallback.
   * (Skills/workflows/hooks dirs remain inherited; project scope
   * `<proj>/.agents/mcp_config.json` is already correct and live-proven.)
   */
  private static readonly CLI_USER_CONFIG_CANDIDATES = [
    [".gemini", "config", "mcp_config.json"], // CONFIRMED canonical for agy v1.0.5
    [".gemini", "antigravity", "mcp_config.json"], // legacy IDE layout (prefer-existing)
  ] as const;

  protected override userConfigCandidates(): ReadonlyArray<readonly string[]> {
    return AntigravityCliAdapter.CLI_USER_CONFIG_CANDIDATES;
  }

  // ── Statusline surface (the `agy` custom status line) ─────────────────────
  // Wires settings.json `statusLine` = { enabled:true, command:<home-bin
  // statusline cmd> } through the SAME refcounted ownership ledger as configPatch
  // (the ledger primitives are surface-agnostic). antigravity-cli does NOT
  // advertise supportsConfigPatch, so — like qwen-code — this adapter performs the
  // set-if-absent write directly with the exported ledger primitives. Semantics
  // are identical to claude-code/qwen-code: never clobber a `statusLine`
  // agent-connector does not own (skip-warn), record prior state + owner
  // (refcounted across connectors), reversible by uninstallStatusline
  // (last-owner-verified delete).
  //
  // The home-bin command makes agy exec
  // `<homeBin> statusline antigravity-cli --connector <id>` on every refresh,
  // which re-imports the connector module and renders the line (runtime/
  // statusline-entrypoint). The status line lives in the GLOBAL
  // ~/.gemini/antigravity-cli/settings.json (agy has no project-scope statusLine),
  // so this surface is user-scope regardless of the install scope. No telemetry
  // in v1.

  /**
   * The `agy` settings.json that holds the statusLine config. LIVE-VERIFIED at
   * ~/.gemini/antigravity-cli/settings.json (the CLI's own global home — distinct
   * from the shared ~/.gemini/config/mcp_config.json the MCP surface writes). agy
   * stores statusLine as a GLOBAL UI setting with no project-scope variant, so the
   * path is scope-independent.
   */
  private statuslineSettingsPath(): string {
    return join(homedir(), ".gemini", "antigravity-cli", "settings.json");
  }

  /** The statusLine config value agent-connector writes at `statusLine`. */
  private statuslineValue(ctx: InstallContext): JsonValue {
    const command = buildHomeBinStatuslineCommand(ctx.homeBinPath, HOST, ctx.connector.id);
    return { enabled: true, command };
  }

  override installStatusline(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.statusline == null) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no statusline" }];
    }
    if (connector.platforms[HOST]?.statusline === false) {
      return [{ platform: this.id, action: "skip", detail: `statusline disabled for ${HOST}` }];
    }

    const filePath = this.statuslineSettingsPath();
    const symlink = this.symlinkPathWarning(filePath);
    if (symlink) return [symlink];

    // OVERWRITE GUARD (upsertServerInJson precedent): never round-trip a
    // present-but-unparseable settings file into `{}`.
    if (this.isPresentButUnparseable(filePath)) {
      return [
        {
          platform: this.id,
          action: "warn",
          path: filePath,
          detail: `existing ${filePath} is not parseable; statusline left unapplied (back it up / fix it, then re-run)`,
        },
      ];
    }
    const settings = this.readJson<Record<string, unknown>>(filePath) ?? {};
    if (typeof settings !== "object" || Array.isArray(settings)) {
      return [
        {
          platform: this.id,
          action: "warn",
          path: filePath,
          detail: `existing ${filePath} is not a JSON object; statusline left unapplied`,
        },
      ];
    }

    const ledger = loadConfigPatchLedger(ctx.dataRoot);
    const desired = this.statuslineValue(ctx);
    const leaf = settings[STATUSLINE_KEY];
    const entry = findLedgerEntry(ledger, HOST, filePath, STATUSLINE_KEY);
    const changes: ChangeRecord[] = [];

    if (leaf === undefined) {
      // SET-IF-ABSENT: the one write path.
      settings[STATUSLINE_KEY] = desired;
      this.writeJson(filePath, settings, ctx.dryRun);
      if (entry) {
        // Stale ledger row (key deleted out from under us): re-assert the value,
        // keep existing owners (they still rely on the key), record what we wrote.
        entry.writtenValue = desired;
        entry.writtenValueHash = hashJsonValue(desired);
        addLedgerOwner(entry, connector.id, connector.version);
      } else {
        createLedgerEntry(ledger, {
          platform: HOST,
          file: filePath,
          key: STATUSLINE_KEY,
          value: desired,
          connectorId: connector.id,
          connectorVersion: connector.version,
        });
      }
      if (!ctx.dryRun) saveConfigPatchLedger(ctx.dataRoot, ledger);
      changes.push({
        platform: this.id,
        action: "create",
        path: filePath,
        detail: `statusline ${STATUSLINE_KEY}: <absent> → ${describeJsonValue(desired)}`,
      });
      return changes;
    }

    // Key PRESENT — never overwrite; the only question is ownership/refcount.
    const leafValue = leaf as JsonValue;
    if (!entry) {
      // User- (or other-tool-) owned. No ownership is taken even when the values
      // happen to match — uninstall must never delete a key we did not create.
      return [
        {
          platform: this.id,
          action: "warn",
          path: filePath,
          detail:
            `statusline ${STATUSLINE_KEY} skipped: already set to ${describeJsonValue(leafValue)} ` +
            `(not created by agent-connector) — left untouched`,
        },
      ];
    }

    if (!jsonDeepEquals(leafValue, entry.writtenValue)) {
      // DRIFT: the user edited the value after we wrote it. Never revert.
      return [
        {
          platform: this.id,
          action: "warn",
          path: filePath,
          detail:
            `statusline ${STATUSLINE_KEY}: value changed since install ` +
            `(current ${describeJsonValue(leafValue)}, wrote ${describeJsonValue(entry.writtenValue)}); ` +
            `leaving in place`,
        },
      ];
    }

    if (jsonDeepEquals(desired, leafValue)) {
      // Same value we own: register as co-owner (refcount++) or idempotent skip.
      const owners = entry.owners.map((o) => o.connectorId);
      if (addLedgerOwner(entry, connector.id, connector.version)) {
        if (!ctx.dryRun) saveConfigPatchLedger(ctx.dataRoot, ledger);
        return [
          {
            platform: this.id,
            action: "skip",
            path: filePath,
            detail: `statusline ${STATUSLINE_KEY} already installed; registered as co-owner (co-owned with ${owners.join(", ")})`,
          },
        ];
      }
      return [
        {
          platform: this.id,
          action: "skip",
          path: filePath,
          detail: `statusline ${STATUSLINE_KEY} already installed`,
        },
      ];
    }

    // FIRST-WRITER-WINS: another connector owns the key with a different value.
    return [
      {
        platform: this.id,
        action: "warn",
        path: filePath,
        detail:
          `statusline ${STATUSLINE_KEY} skipped: already owned by ${entry.owners
            .map((o) => o.connectorId)
            .join(", ")} with a different value — left untouched`,
      },
    ];
  }

  override uninstallStatusline(ctx: InstallContext): ChangeRecord[] {
    const ledger = loadConfigPatchLedger(ctx.dataRoot);
    // Release ONLY the statusLine ledger row this connector owns (keyed off the
    // ledger, not the declaration, so an id-only synthetic uninstall still reclaims
    // it). Last-owner-verified delete: remove the key ONLY when last-owner ∧
    // value-unchanged ∧ prior-absent (else skip-warn + leave the key).
    const owned = ledgerEntriesOwnedBy(ledger, HOST, ctx.connector.id).filter(
      (e) => e.key === STATUSLINE_KEY,
    );
    if (owned.length === 0) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail: "statusline: no ownership recorded; left untouched",
        },
      ];
    }

    const changes: ChangeRecord[] = [];
    let ledgerMutated = false;

    // Group by file (one global settings.json in practice, but stay robust to a
    // scope drift between install and uninstall).
    const byFile = new Map<string, ConfigPatchLedgerEntry[]>();
    for (const entry of owned) {
      const bucket = byFile.get(entry.file) ?? [];
      bucket.push(entry);
      byFile.set(entry.file, bucket);
    }

    for (const [filePath, entries] of byFile) {
      const symlink = this.symlinkPathWarning(filePath);
      if (symlink) {
        changes.push(symlink);
        continue;
      }

      const unparseable = this.isPresentButUnparseable(filePath);
      const settings = unparseable ? null : this.readJson<Record<string, unknown>>(filePath);
      let fileMutated = false;

      for (const entry of entries) {
        const { lastOwner } = removeLedgerOwner(entry, ctx.connector.id);
        ledgerMutated = true;

        if (!lastOwner) {
          // Shared-flag case: A uninstalls, B still relies on the key.
          changes.push({
            platform: this.id,
            action: "skip",
            path: filePath,
            detail: `statusline ${entry.key} retained: still owned by ${entry.owners
              .map((o) => o.connectorId)
              .join(", ")}`,
          });
          continue;
        }

        // Last owner out → the ledger row is dropped on every branch below; the
        // KEY is removed only on the fully-verified branch.
        dropLedgerEntry(ledger, entry);

        if (unparseable) {
          changes.push({
            platform: this.id,
            action: "warn",
            path: filePath,
            detail: `statusline ${entry.key}: ${filePath} is not parseable; key left in place (ownership released)`,
          });
          continue;
        }
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: filePath,
            detail: `statusline ${entry.key} already absent (no settings file); ownership record dropped`,
          });
          continue;
        }
        const leaf = settings[entry.key];
        if (leaf === undefined) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: filePath,
            detail: `statusline ${entry.key} already absent; ownership record dropped`,
          });
          continue;
        }
        if (entry.prior?.present !== false || !jsonDeepEquals(leaf as JsonValue, entry.writtenValue)) {
          // User edited the value after install (or the row predates the
          // set-if-absent guarantee): deleting would clobber them. Leave it.
          changes.push({
            platform: this.id,
            action: "warn",
            path: filePath,
            detail:
              `statusline ${entry.key}: value changed since install ` +
              `(current ${describeJsonValue(leaf as JsonValue)}, wrote ${describeJsonValue(entry.writtenValue)}); ` +
              `left in place`,
          });
          continue;
        }

        // VERIFIED: last owner + current === writtenValue + prior absent.
        delete settings[entry.key];
        fileMutated = true;
        changes.push({
          platform: this.id,
          action: "remove",
          path: filePath,
          detail: `statusline ${entry.key} removed (was ${describeJsonValue(entry.writtenValue)})`,
        });
      }

      if (fileMutated && settings) this.writeJson(filePath, settings, ctx.dryRun);
    }

    if (ledgerMutated && !ctx.dryRun) saveConfigPatchLedger(ctx.dataRoot, ledger);
    return changes;
  }

  /**
   * Parse the `agy` statusLine stdin JSON into the normalized
   * {@link StatuslineContext}. agy pipes a JSON object on stdin
   * (model/context_window/workspace/…); fields the payload omits stay undefined.
   * `raw` keeps the verbatim payload (incl. version/agent_state/vcs/plan_tier/
   * quota/email/terminal_width). agy has no cost analog, so `ctx.cost` is left
   * undefined. LIVE-CAPTURED against agy v1.0.10 (see header / AgyStatuslineInput).
   */
  parseStatusInput(raw: unknown): StatuslineContext {
    const input = (raw ?? {}) as AgyStatuslineInput;

    const ctx: StatuslineContext = {
      host: HOST,
      capabilities: this.capabilities,
      raw,
    };
    // Stable session id: prefer conversation_id (the active agent conversation),
    // fall back to session_id (the capture showed them equal).
    const sessionId =
      typeof input.conversation_id === "string" && input.conversation_id !== ""
        ? input.conversation_id
        : typeof input.session_id === "string" && input.session_id !== ""
          ? input.session_id
          : undefined;
    if (sessionId !== undefined) ctx.sessionId = sessionId;
    // cwd: prefer the top-level cwd, else the workspace.current_dir.
    const cwd =
      typeof input.cwd === "string"
        ? input.cwd
        : typeof input.workspace?.current_dir === "string"
          ? input.workspace.current_dir
          : undefined;
    if (cwd !== undefined) ctx.cwd = cwd;
    if (typeof input.transcript_path === "string") ctx.transcriptPath = input.transcript_path;

    const model: { id?: string; displayName?: string } = {};
    if (typeof input.model?.id === "string") model.id = input.model.id;
    if (typeof input.model?.display_name === "string") model.displayName = input.model.display_name;
    if (model.id !== undefined || model.displayName !== undefined) ctx.model = model;

    const cw = input.context_window;
    if (cw) {
      const context: { usedTokens?: number; maxTokens?: number; percent?: number } = {};
      if (typeof cw.context_window_size === "number") context.maxTokens = cw.context_window_size;
      // agy's current_usage is an OBJECT (not a number like qwen) — used tokens are
      // the documented top-level total_input_tokens + total_output_tokens sum.
      if (
        typeof cw.total_input_tokens === "number" ||
        typeof cw.total_output_tokens === "number"
      ) {
        context.usedTokens = (cw.total_input_tokens ?? 0) + (cw.total_output_tokens ?? 0);
      }
      if (typeof cw.used_percentage === "number") context.percent = cw.used_percentage;
      if (
        context.usedTokens !== undefined ||
        context.maxTokens !== undefined ||
        context.percent !== undefined
      ) {
        ctx.context = context;
      }
    }
    // ctx.cost stays undefined: agy's status payload has no cost analog.
    return ctx;
  }

  /** Format the rendered status line into agy's native reply: stdout = line, exit 0. */
  formatStatusOutput(rendered: string): HookReply {
    return { exitCode: 0, stdout: rendered };
  }

  // ── Diagnostics: add the statusline check on top of the inherited IDE checks ─

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const checks = [...super.getHealthChecks(ctx)];

    // Statusline check: assert it when the connector declares a statusline AND it
    // is not disabled for this host, OR when the ownership ledger holds a
    // statusLine row this connector owns (the REGISTERED-connector path:
    // connectorFromMeta can't re-expose the render fn, so statusline comes back
    // undefined — but the ledger row proves the surface was wired). Mirrors
    // claude-code/qwen-code's "statusline wired" check.
    const settingsPath = this.statuslineSettingsPath();
    const connectorId = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const statuslineLedgerOwned = ledgerEntriesOwnedBy(
      loadConfigPatchLedger(ctx.dataRoot),
      HOST,
      connectorId,
    ).some((e) => e.key === STATUSLINE_KEY);
    if (
      (ctx.connector.statusline != null || statuslineLedgerOwned) &&
      ctx.connector.platforms[HOST]?.statusline !== false
    ) {
      checks.push({
        name: `${this.name}: statusline wired`,
        check: () => {
          const settings = this.readJson<{ statusLine?: { command?: unknown } }>(settingsPath);
          const command = settings?.statusLine?.command;
          if (command === undefined) {
            return { status: "FAIL", detail: `statusLine not set in ${settingsPath}` };
          }
          if (
            typeof command === "string" &&
            isHomeBinStatuslineCommand(command, homeBin, connectorId)
          ) {
            return { status: "OK", detail: "statusLine command present" };
          }
          // Present but not ours — a non-AC statusLine we must never clobber.
          return {
            status: "FAIL",
            detail: `statusLine in ${settingsPath} is not agent-connector's (left untouched)`,
          };
        },
      });
    }
    return checks;
  }
}

export const adapter = new AntigravityCliAdapter();
export default adapter;
