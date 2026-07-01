import type {
  JsonValue,
  PlatformId,
  StatuslineDef,
  StatuslineOptions,
} from "./types.js";

export interface StatuslineCommandOptionSupport {
  refreshInterval?: boolean;
  respectUserColors?: boolean;
  hideContextIndicator?: boolean;
}

/** Merge connector-wide statusline options with a host-specific override. */
export function statuslineOptionsForHost(
  statusline: StatuslineDef | undefined,
  host: PlatformId | string,
): StatuslineOptions {
  if (!statusline) return {};
  const hostOptions = statusline.hosts?.[host as PlatformId]?.options;
  return { ...(statusline.options ?? {}), ...(hostOptions ?? {}) };
}

/** Apply framework-enforced output limits before the host formats the result. */
export function applyStatuslineOutputLimits(
  rendered: string,
  options: StatuslineOptions,
): string {
  const maxLines = options.maxLines;
  if (maxLines === undefined) return rendered;
  if (!Number.isInteger(maxLines) || maxLines < 1) return rendered;
  return rendered.split(/\r?\n/).slice(0, maxLines).join("\n");
}

/**
 * Build the common `{ type:"command", command, ...options }` statusline config.
 * Unsupported options are omitted so hosts never receive invented settings.
 */
export function buildStatuslineCommandConfig(
  command: string,
  options: StatuslineOptions,
  support: StatuslineCommandOptionSupport,
): JsonValue {
  const value: Record<string, JsonValue> = { type: "command", command };
  if (
    support.refreshInterval === true &&
    options.refreshInterval !== undefined
  ) {
    value.refreshInterval = options.refreshInterval;
  }
  if (
    support.respectUserColors === true &&
    options.respectUserColors !== undefined
  ) {
    value.respectUserColors = options.respectUserColors;
  }
  if (
    support.hideContextIndicator === true &&
    options.hideContextIndicator !== undefined
  ) {
    value.hideContextIndicator = options.hideContextIndicator;
  }
  return value;
}
