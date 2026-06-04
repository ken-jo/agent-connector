/**
 * telemetry/surface-footprint — the STATIC developer-axis surfaces.
 *
 * Commands, skills, and subagents are NOT runtime-intercepted: the host loads
 * them as context (slash-command bodies, SKILL.md + resources, subagent system
 * prompts) and we never sit in the byte path the way the serve-proxy does for a
 * server or the hook runtime does for a hook. So we do NOT (and must not) write
 * fake usage rows for them. Instead we compute a deterministic STATIC FOOTPRINT:
 * the token cost the surface IMPOSES on a host that loads it, tokenized with the
 * SAME shared tokenizer the proxy + hook runtime use.
 *
 * This is pure: the only input is the passed {@link ResolvedConnector}; there is
 * no IO beyond reading that object's already-loaded fields.
 */

import type { ResolvedConnector } from "../core/types.js";
import { getTokenizer, inferModelFamily } from "./tokenizer.js";
import type { ModelFamily, SurfaceKind, Tokenizer } from "./types.js";

/**
 * One static surface footprint: a content surface (command/skill/subagent) and
 * the token cost it imposes on a host that loads it. `kind` is the surface kind
 * (never `server`/`hook` — those are runtime-measured), `name` is the surface's
 * declared name, and `tokens` is the tokenized whole-surface footprint.
 */
export interface SurfaceFootprint {
  surfaceKind: Extract<SurfaceKind, "command" | "skill" | "subagent">;
  name: string;
  tokens: number;
}

/** Tokenize a list of text fragments (joined with "\n") under `family`. */
function countParts(
  parts: readonly string[],
  family: ModelFamily,
  tok: Tokenizer,
): number {
  // A surface's footprint is its concatenated content — joining with a newline
  // mirrors how the host renders the fields together as one context blob.
  return tok.count(parts.join("\n"), family).tokens;
}

/**
 * Compute the STATIC footprints of every content surface declared on a
 * connector, deterministically (same input → same output) and without IO.
 *
 *   • command  → description + prompt + argumentHint
 *   • skill    → description + body + every resource value (sorted by path for
 *                deterministic ordering, so the joined text is stable)
 *   • subagent → description + prompt
 *
 * The shared {@link Tokenizer} is used so a command/skill/subagent footprint is
 * directly comparable with the runtime `server`/`hook` token counts. The model
 * family is inferred from the connector's telemetry hint (no host context here).
 */
export function computeSurfaceFootprints(
  connector: ResolvedConnector,
  tok: Tokenizer = getTokenizer(),
): SurfaceFootprint[] {
  const family = inferModelFamily("", connector.telemetry.modelFamilyHint);
  const out: SurfaceFootprint[] = [];

  for (const cmd of connector.commands) {
    const parts: string[] = [];
    if (cmd.description !== undefined) parts.push(cmd.description);
    parts.push(cmd.prompt);
    if (cmd.argumentHint !== undefined) parts.push(cmd.argumentHint);
    out.push({
      surfaceKind: "command",
      name: cmd.name,
      tokens: countParts(parts, family, tok),
    });
  }

  for (const skill of connector.skills) {
    const parts: string[] = [skill.description, skill.body];
    if (skill.resources !== undefined) {
      // Sort by resource path so the joined text (and thus the count) is stable
      // regardless of object key insertion order.
      const paths = Object.keys(skill.resources).sort();
      for (const p of paths) {
        const value = skill.resources[p];
        if (value !== undefined) parts.push(value);
      }
    }
    out.push({
      surfaceKind: "skill",
      name: skill.name,
      tokens: countParts(parts, family, tok),
    });
  }

  for (const agent of connector.subagents) {
    out.push({
      surfaceKind: "subagent",
      name: agent.name,
      tokens: countParts([agent.description, agent.prompt], family, tok),
    });
  }

  return out;
}
