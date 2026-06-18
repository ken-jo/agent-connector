/**
 * adapters/claude-code/render — shared content-surface renderers.
 *
 * The single source of truth for how a connector's commands / skills / subagents
 * are serialized into Claude Code's native `md + YAML-frontmatter` documents.
 * BOTH the live claude-code adapter (which writes into ~/.claude or .claude when
 * installing) AND `core/package` (which emits a marketplace-installable plugin
 * bundle) import these so the two paths produce BYTE-IDENTICAL output — there is
 * no second, subtly-different copy to drift.
 *
 * The frontmatter serializer reuses the `yaml` package (the same serializer
 * core/yaml and BaseAdapter.renderFrontmatterMd use): a `---` fence, the YAML
 * block, a closing `---`, a blank line, then the markdown body and a trailing
 * newline.
 */

import { stringify as stringifyYaml } from "yaml";

import type { CommandDef, SkillDef, SubagentDef } from "../../core/types.js";

/**
 * Render a YAML-frontmatter + markdown body document:
 *   "---\n" + <yaml> + "---\n\n" + <body> + "\n".
 * Identical to BaseAdapter.renderFrontmatterMd (which now delegates here).
 */
export function renderFrontmatterMd(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  return `---\n${stringifyYaml(frontmatter)}---\n\n${body}\n`;
}

/**
 * Render a command to md+frontmatter
 * (description, argument-hint, allowed-tools, model + verbatim extra).
 *
 * `opts.includeToolsAndModel` (default `true`) controls the allowed-tools and
 * model insertions. Hosts whose command frontmatter is only
 * (description, argument-hint + verbatim extra) — i.e. they have no native
 * allowed-tools/model keys — pass `{ includeToolsAndModel: false }` to suppress
 * both; the default reproduces the full shape byte-for-byte.
 */
export function renderCommandMd(
  cmd: CommandDef,
  opts: { includeToolsAndModel?: boolean } = {},
): string {
  const { includeToolsAndModel = true } = opts;
  const frontmatter: Record<string, unknown> = {};
  if (cmd.description !== undefined) frontmatter.description = cmd.description;
  if (cmd.argumentHint !== undefined) frontmatter["argument-hint"] = cmd.argumentHint;
  if (includeToolsAndModel) {
    const allow = cmd.tools?.allow;
    if (allow && allow.length > 0) frontmatter["allowed-tools"] = allow.join(", ");
    if (cmd.model !== undefined) frontmatter.model = cmd.model;
  }
  if (cmd.extra) Object.assign(frontmatter, cmd.extra);
  return renderFrontmatterMd(frontmatter, cmd.prompt);
}

/**
 * Render a skill's SKILL.md: frontmatter (name, description + optional model,
 * allowed-tools, disable-model-invocation, verbatim extra) + body.
 */
export function renderSkillMd(skill: SkillDef): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  };
  if (skill.model !== undefined) frontmatter.model = skill.model;
  const allow = skill.tools?.allow;
  if (allow && allow.length > 0) frontmatter["allowed-tools"] = allow.join(", ");
  if (skill.disableModelInvocation !== undefined) {
    frontmatter["disable-model-invocation"] = skill.disableModelInvocation;
  }
  if (skill.extra) Object.assign(frontmatter, skill.extra);
  return renderFrontmatterMd(frontmatter, skill.body);
}

/** Render a subagent to md+frontmatter (name, description, tools, model) + prompt body. */
export function renderSubagentMd(agent: SubagentDef): string {
  const frontmatter: Record<string, unknown> = {
    name: agent.name,
    description: agent.description,
  };
  const allow = agent.tools?.allow;
  if (allow && allow.length > 0) frontmatter.tools = allow.join(", ");
  if (agent.model !== undefined) frontmatter.model = agent.model;
  if (agent.extra) Object.assign(frontmatter, agent.extra);
  return renderFrontmatterMd(frontmatter, agent.prompt);
}

/**
 * Render a subagent in OpenCode's shape (shared by opencode/kilo/mimo-code):
 * frontmatter (description, mode:"subagent", model?, permission? + verbatim
 * extra) with the system prompt as the body. `name` is NOT a frontmatter
 * field — it comes from the filename. `permission` is derived from the coarse
 * `readonly` knob: a readonly agent gets a per-tool deny map (edit/bash) so it
 * cannot mutate the workspace.
 */
export function renderOpenCodeSubagentMd(agent: SubagentDef): string {
  const frontmatter: Record<string, unknown> = {
    description: agent.description,
    mode: "subagent",
  };
  if (agent.model !== undefined) frontmatter.model = agent.model;
  if (agent.readonly === true) {
    // Per-tool permission map: deny mutating tools for a readonly subagent.
    frontmatter.permission = { edit: "deny", bash: "deny" };
  }
  if (agent.extra) Object.assign(frontmatter, agent.extra);
  return renderFrontmatterMd(frontmatter, agent.prompt);
}
