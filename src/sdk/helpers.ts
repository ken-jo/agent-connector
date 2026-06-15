/**
 * sdk/helpers — host-aware authoring helpers for connector handlers.
 *
 * A handler (a hook, a statusline render, an action run) sees the host it is
 * dispatched for via the {@link HostCtx} (`ctx.host`). These two helpers let a
 * handler render a host-correct value without hardcoding a per-host branch:
 *
 *   • {@link toolName} — resolve a bare MCP tool name to the host's native
 *     reference form (some hosts namespace MCP tools as `mcp__<id>__<tool>`).
 *   • {@link style}    — wrap text in an ANSI escape ONLY on hosts that render
 *     ANSI in a status line / output; plain everywhere else.
 *
 * Both are deliberately MODEST, documented best-effort lists — NOT a capability
 * query. The per-host convention each encodes is not centrally modeled in
 * {@link PlatformCapabilities} yet; if either set grows it should migrate to a
 * capability flag (a `mcpToolPrefix` / `rendersAnsi` flag) the adapter declares.
 */

import type { PlatformId } from "../core/types.js";

/**
 * Hosts that namespace MCP tools as `mcp__<connectorId>__<tool>` — the
 * `mcp__`-prefix convention Claude Code popularized and most MCP-client agents
 * adopted. CONFIRMED in-repo via the adapters' own `mcp__` PreToolUse matchers
 * for claude-code, codex, and kimi; the remaining members are MCP-client hosts
 * the convention applies to but are not separately verified here (a wrong
 * inclusion only ever yields a name the host doesn't resolve, the same outcome
 * as wrongly EXCLUDING a prefixing host — and an author can always construct the
 * reference themselves). This is a SMALL explicit set, not a capability query;
 * if it grows, migrate it to a per-adapter `mcpToolPrefix` capability flag.
 * (Follow-up: spot-verify gemini-cli / a copilot variant on a live box.)
 */
const PREFIXED_HOSTS: ReadonlySet<PlatformId> = new Set<PlatformId>([
  "claude-code",
  "codex",
  "kimi",
  "cursor",
  "copilot-cli",
  "vscode-copilot",
  "jetbrains-copilot",
  "gemini-cli",
  "qwen-code",
]);

/**
 * Resolve a bare MCP tool name to the host's native reference form.
 *
 * On a {@link PREFIXED_HOSTS} host the result is `mcp__<connectorId>__<baseName>`
 * (how those hosts surface a connector's MCP tools); on every other host it is
 * the bare `baseName`. When the host prefixes but no `connectorId` is supplied
 * the helper falls back to the bare name rather than emitting a malformed
 * `mcp__undefined__…` reference — it NEVER throws.
 */
export function toolName(
  ctx: { host: PlatformId; connectorId?: string },
  baseName: string,
): string {
  if (PREFIXED_HOSTS.has(ctx.host) && ctx.connectorId) {
    return `mcp__${ctx.connectorId}__${baseName}`;
  }
  return baseName;
}

/**
 * Hosts that render ANSI escape sequences in a status line / terminal output —
 * the CLI/TUI hosts. IDE-embedded hosts (where output lands in a webview /
 * editor panel that shows the raw escape) are deliberately EXCLUDED. Like
 * {@link PREFIXED_HOSTS} this is a documented best-effort list, not a capability
 * query; migrate it to a `rendersAnsi` capability flag if it grows.
 */
const ANSI_HOSTS: ReadonlySet<PlatformId> = new Set<PlatformId>([
  "claude-code",
  "codex",
  "gemini-cli",
  "qwen-code",
  "cursor",
  "copilot-cli",
  "opencode",
  "droid",
  "crush",
  "goose",
  "amp",
]);

/**
 * Style `text` with an ANSI SGR escape on hosts that render it (a status line /
 * terminal output), plain everywhere else.
 *
 * When `ctx.host` is in {@link ANSI_HOSTS} and `codes.ansi` is provided, returns
 * `\x1b[<ansi>m<text>\x1b[0m`; otherwise returns `text` unchanged (an
 * IDE-embedded host, or no `ansi` code given). `codes.ansi` is the SGR
 * parameter(s), e.g. `"1"` (bold) or `"1;32"` (bold green).
 */
export function style(
  ctx: { host: PlatformId },
  text: string,
  codes: { ansi?: string },
): string {
  if (codes.ansi && ANSI_HOSTS.has(ctx.host)) {
    return `\x1b[${codes.ansi}m${text}\x1b[0m`;
  }
  return text;
}
