/**
 * usage/normalize — model/provider/workspace normalization.
 *
 * `normalizeModelForGrouping` and `inferProvider` are FAITHFUL ports of
 * tokscale's order-dependent logic (tokscale-core/src/lib.rs
 * normalize_model_for_grouping + provider_identity.rs inferred_provider_from_model).
 * The matching order is load-bearing — keep the steps in sequence.
 *
 * `normalizeWorkspaceKey` / `workspaceLabelFromKey` port tokscale
 * sessions/mod.rs (same slash-collapsing + UNC-prefix handling) so a cwd string
 * from a host log maps to the same stable project key tokscale would produce.
 */

// ─────────────────────────────────────────────────────────────────────────
// Model normalization (port of lib.rs normalize_model_for_grouping)
// ─────────────────────────────────────────────────────────────────────────

const REASONING_TIERS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "auto",
  "none",
]);

/**
 * Strip a `(level)` reasoning-effort suffix, returning the base model — or null
 * when the suffix is not one of the recognized tiers. Port of
 * strip_parenthesized_reasoning_tier: the base must be non-empty and already
 * trimmed (no surrounding whitespace).
 */
function stripParenthesizedReasoningTier(modelId: string): string | null {
  if (!modelId.endsWith(")")) return null;
  const withoutClosing = modelId.slice(0, -1);
  const open = withoutClosing.lastIndexOf("(");
  if (open < 0) return null;
  const base = withoutClosing.slice(0, open);
  const tier = withoutClosing.slice(open + 1);
  if (base === "" || base.trim() !== base) return null;
  if (!REASONING_TIERS.has(tier)) return null;
  return base;
}

/**
 * Map an `anthropic/claude-<major>-<minor>-<family>` id to the canonical
 * `claude-<family>-<major>-<minor>` form. Returns null when the shape does not
 * match exactly (too many parts, unknown family). Port of
 * normalize_anthropic_prefixed_claude_model.
 */
function normalizeAnthropicPrefixedClaudeModel(modelId: string): string | null {
  const prefix = "anthropic/claude-";
  if (!modelId.startsWith(prefix)) return null;
  const rest = modelId.slice(prefix.length);
  const parts = rest.split("-");
  const major = parts[0];
  const minor = parts[1];
  const family = parts[2];
  if (major === undefined || minor === undefined || family === undefined) return null;
  if (parts.length > 3) return null; // too many parts
  if (family !== "opus" && family !== "sonnet" && family !== "haiku") return null;
  return `claude-${family}-${major}-${minor}`;
}

/**
 * Normalize a raw model id to a stable grouping key. ORDER MATTERS — this is the
 * exact tokscale sequence:
 *   1. lowercase;
 *   2. strip a recognized `(tier)` reasoning suffix;
 *   3. strip a trailing `-YYYYMMDD` 8-digit date (only when len > 9 and the
 *      9th-from-end char is '-');
 *   4. for claude ids, replace dots between two digits with dashes
 *      (e.g. "claude-3.5-sonnet" → "claude-3-5-sonnet");
 *   5. canonicalize an `anthropic/claude-*` prefix.
 */
export function normalizeModelForGrouping(modelId: string): string {
  let name = modelId.toLowerCase();

  const base = stripParenthesizedReasoningTier(name);
  if (base !== null) name = base;

  if (name.length > 9) {
    const potentialDate = name.slice(name.length - 8);
    const allDigits = /^[0-9]{8}$/.test(potentialDate);
    if (allDigits && name.charCodeAt(name.length - 9) === 0x2d /* '-' */) {
      name = name.slice(0, name.length - 9);
    }
  }

  if (name.includes("claude")) {
    const chars = [...name];
    let result = "";
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i] as string;
      const prev = chars[i - 1];
      const next = chars[i + 1];
      if (
        c === "." &&
        i > 0 &&
        i < chars.length - 1 &&
        prev !== undefined &&
        next !== undefined &&
        isAsciiDigit(prev) &&
        isAsciiDigit(next)
      ) {
        result += "-";
      } else {
        result += c;
      }
    }
    name = result;
  }

  const canonical = normalizeAnthropicPrefixedClaudeModel(name);
  if (canonical !== null) name = canonical;

  return name;
}

function isAsciiDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

// ─────────────────────────────────────────────────────────────────────────
// Provider inference (port of provider_identity.rs inferred_provider_from_model)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Whether `needle` occurs in `haystack` not flanked by alphanumerics on either
 * side (so "o1" matches "o1-preview" but not "protocol1"). Port of
 * contains_delimited.
 */
function containsDelimited(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const pos = haystack.indexOf(needle, from);
    if (pos < 0) return false;
    const beforeOk = pos === 0 || !isAlphaNum(haystack.charCodeAt(pos - 1));
    const afterPos = pos + needle.length;
    const afterOk = afterPos === haystack.length || !isAlphaNum(haystack.charCodeAt(afterPos));
    if (beforeOk && afterOk) return true;
    from = pos + 1;
  }
}

function isAlphaNum(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) // a-z
  );
}

/**
 * Infer a canonical provider id from a model id. ORDER MATTERS — first match
 * wins, exactly as tokscale's inferred_provider_from_model. Returns null when no
 * family matches (caller supplies a platform default).
 */
export function inferProvider(model: string): string | null {
  const lower = model.toLowerCase();

  if (
    lower.includes("claude") ||
    lower.includes("anthropic") ||
    containsDelimited(lower, "opus") ||
    containsDelimited(lower, "sonnet") ||
    containsDelimited(lower, "haiku")
  ) {
    return "anthropic";
  }
  if (
    lower.includes("gpt") ||
    lower.includes("openai") ||
    containsDelimited(lower, "o1") ||
    containsDelimited(lower, "o3") ||
    containsDelimited(lower, "o4")
  ) {
    return "openai";
  }
  if (lower.includes("gemini") || lower.includes("google")) return "google";
  if (lower.includes("grok")) return "xai";
  if (lower.includes("deepseek")) return "deepseek";
  if (lower.includes("minimax")) return "minimax";
  if (lower.includes("mistral") || lower.includes("mixtral")) return "mistral";
  if (lower.includes("llama") || containsDelimited(lower, "meta")) return "meta";
  if (lower.includes("qwen")) return "qwen";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Agent-name normalization (port of sessions/mod.rs normalize_agent_name +
// normalize_opencode_agent_name). The opencode reader MUST normalize the agent
// before its dedup fingerprint, or fork-copied history (which differs only in a
// raw agent string) escapes dedup and double-counts.
// ─────────────────────────────────────────────────────────────────────────

// U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM/ZWNBSP.
const ZERO_WIDTH_RE = /[​‌‍﻿]/g;

/** Strip zero-width chars oh-my-openagent uses as invisible sort prefixes. */
function stripZeroWidthChars(s: string): string {
  ZERO_WIDTH_RE.lastIndex = 0;
  return ZERO_WIDTH_RE.test(s) ? s.replace(ZERO_WIDTH_RE, "") : s;
}

const AGENT_PREFIXES = ["astrape:", "oh-my-claudecode:", "oh-my-codex:"] as const;

/** Strip a known namespace prefix (case-insensitive), else return as-is. */
function stripAgentPrefix(name: string): string {
  for (const prefix of AGENT_PREFIXES) {
    if (name.length >= prefix.length && name.slice(0, prefix.length).toLowerCase() === prefix) {
      return name.slice(prefix.length);
    }
  }
  return name;
}

/** Collapse internal whitespace runs to single spaces (port of canonicalize_agent_name). */
function canonicalizeAgentName(name: string): string {
  return name.split(/\s+/).filter((w) => w !== "").join(" ");
}

/** Titlecase one word, with UI/UX/API kept uppercase (port of titlecase_word). */
function titlecaseWord(word: string): string {
  const lower = word.toLowerCase();
  if (lower === "ui") return "UI";
  if (lower === "ux") return "UX";
  if (lower === "api") return "API";
  if (word === "") return "";
  const chars = [...word];
  const first = chars[0] as string;
  return first.toUpperCase() + chars.slice(1).join("");
}

/** Titlecase an agent name across '-' and whitespace boundaries (port of titlecase_agent). */
function titlecaseAgent(name: string): string {
  if (name === "") return "";
  return name
    .split("-")
    .flatMap((part) => part.split(/\s+/))
    .filter((w) => w !== "")
    .map(titlecaseWord)
    .join(" ");
}

/** Port of normalize_agent_name. */
export function normalizeAgentName(agent: string): string {
  const cleaned = stripZeroWidthChars(agent);
  const trimmed = cleaned.trim();
  const stripped = stripAgentPrefix(trimmed);
  const canonical = canonicalizeAgentName(stripped);
  const agentLower = canonical.toLowerCase();

  if (agentLower.includes("plan")) {
    if (agentLower.includes("omo") || agentLower.includes("sisyphus")) {
      return "Planner-Sisyphus";
    }
    return titlecaseAgent(canonical);
  }
  if (agentLower === "omo" || agentLower === "sisyphus") return "Sisyphus";
  if (agentLower === "orchestrator-sisyphus") return "Atlas";
  return titlecaseAgent(canonical);
}

/** Port of normalize_oh_my_opencode_agent_name (returns undefined when no match). */
function normalizeOhMyOpencodeAgentName(agentLower: string): string | undefined {
  switch (agentLower) {
    case "sisyphus (ultraworker)":
    case "sisyphus - ultraworker":
    case "sisyphus ultraworker":
    case "sisyphus":
      return "Sisyphus";
    case "hephaestus (deep agent)":
    case "hephaestus - deep agent":
    case "hephaestus deep agent":
    case "hephaestus":
      return "Hephaestus";
    case "prometheus (plan builder)":
    case "prometheus - plan builder":
    case "prometheus plan builder":
    case "prometheus (planner)":
    case "prometheus":
      return "Prometheus";
    case "atlas (plan executor)":
    case "atlas - plan executor":
    case "atlas plan executor":
    case "atlas":
      return "Atlas";
    case "metis (plan consultant)":
    case "metis - plan consultant":
    case "metis plan consultant":
    case "metis":
      return "Metis";
    case "momus (plan critic)":
    case "momus - plan critic":
    case "momus plan critic":
    case "momus (plan reviewer)":
    case "momus":
      return "Momus";
    case "orchestrator-sisyphus":
      return "Atlas";
    case "sisyphus-junior":
      return "Sisyphus-Junior";
    case "planner-sisyphus":
      return "Planner-Sisyphus";
    default:
      return undefined;
  }
}

/**
 * Port of normalize_opencode_agent_name (sessions/mod.rs:88-154). Applies the
 * shared cleaning pipeline, then the oh-my-opencode agent table, then falls back
 * to normalizeAgentName. Used by the opencode reader BEFORE its dedup fingerprint
 * so fork copies collapse (matching opencode.rs:272).
 */
export function normalizeOpencodeAgentName(agent: string): string {
  const cleaned = stripZeroWidthChars(agent);
  const trimmed = cleaned.trim();
  const stripped = stripAgentPrefix(trimmed);
  const canonical = canonicalizeAgentName(stripped);
  const agentLower = canonical.toLowerCase();

  const ohMy = normalizeOhMyOpencodeAgentName(agentLower);
  if (ohMy !== undefined) return ohMy;

  return normalizeAgentName(canonical);
}

// ─────────────────────────────────────────────────────────────────────────
// Workspace key / label (port of sessions/mod.rs)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Normalize an arbitrary cwd/dir string to a stable workspace key. Port of
 * normalize_workspace_key: backslashes → forward slashes, collapse repeated
 * slashes, strip a trailing slash (preserving a leading `//` UNC prefix).
 * Returns undefined for an empty input.
 */
export function normalizeWorkspaceKey(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  const preserveUnc = trimmed.startsWith("\\\\") || trimmed.startsWith("//");
  let normalized = trimmed.replace(/\\/g, "/");

  if (preserveUnc) {
    let body = normalized.replace(/^\/+/, "");
    while (body.includes("//")) body = body.replace(/\/\//g, "/");
    normalized = `//${body}`;
  } else {
    while (normalized.includes("//")) normalized = normalized.replace(/\/\//g, "/");
  }

  const minLen = preserveUnc ? 2 : 1;
  if (normalized.length > minLen) {
    normalized = normalized.replace(/\/+$/, "");
  }

  return normalized === "" ? undefined : normalized;
}

/**
 * Human-readable label from a workspace key: the last non-empty path segment.
 * Port of workspace_label_from_key. Returns undefined when no segment remains.
 */
export function workspaceLabelFromKey(key: string): string | undefined {
  const segments = key.split("/");
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg !== undefined && seg !== "") return seg;
  }
  return undefined;
}

/**
 * Convert a cwd/dir string to both its normalized key and label in one call.
 * Both fields are undefined when the input does not yield a usable key.
 */
export function workspaceFromPath(raw: string): {
  projectKey?: string;
  projectLabel?: string;
} {
  const key = normalizeWorkspaceKey(raw);
  if (key === undefined) return {};
  const label = workspaceLabelFromKey(key);
  return label === undefined ? { projectKey: key } : { projectKey: key, projectLabel: label };
}
