/**
 * cli/commands/detect — list the AI-agent platforms installed on this machine.
 *
 * `detect` probes every registered adapter (via detectInstalledPlatforms) and
 * prints, for each installed host: id, name, hook paradigm, install scope, the
 * native config path that would be written, and a one-line capabilities summary.
 * `--json` emits the raw DetectedPlatform[] for scripting.
 */

import { parseArgs } from "node:util";

import type { DetectedPlatform, PlatformCapabilities } from "../../core/types.js";
import { detectInstalledPlatforms } from "../../adapters/detect.js";
import { print } from "../app.js";

/** Compact, human one-line summary of what a host can honor. */
function capabilitySummary(caps: PlatformCapabilities): string {
  const events: string[] = [];
  if (caps.preToolUse) events.push("PreToolUse");
  if (caps.postToolUse) events.push("PostToolUse");
  if (caps.sessionStart) events.push("SessionStart");
  if (caps.sessionEnd) events.push("SessionEnd");
  if (caps.userPromptSubmit) events.push("UserPromptSubmit");
  if (caps.preCompact) events.push("PreCompact");
  if (caps.stop) events.push("Stop");
  if (caps.notification) events.push("Notification");
  // Newer optional per-event flags (absent ⇒ unsupported, read as `?? false`).
  if (caps.permissionRequest ?? false) events.push("PermissionRequest");
  if (caps.postToolUseFailure ?? false) events.push("PostToolUseFailure");
  if (caps.subagentStart ?? false) events.push("SubagentStart");
  if (caps.subagentStop ?? false) events.push("SubagentStop");

  const extras: string[] = [];
  if (caps.canModifyArgs) extras.push("modifyArgs");
  if (caps.canModifyOutput) extras.push("modifyOutput");
  if (caps.canInjectSessionContext) extras.push("injectContext");

  const transports = caps.transports.length > 0 ? caps.transports.join("/") : "none";
  const parts = [
    `events: ${events.length > 0 ? events.join(",") : "none"}`,
    `transports: ${transports}`,
  ];
  if (extras.length > 0) parts.push(extras.join(","));
  return parts.join(" | ");
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
      project: { type: "string" },
    },
    allowPositionals: false,
  });

  const projectDir = values.project ?? process.cwd();
  const detected: DetectedPlatform[] = await detectInstalledPlatforms(projectDir);

  if (values.json) {
    print(JSON.stringify(detected, null, 2));
    return 0;
  }

  if (detected.length === 0) {
    print("No supported AI-agent platforms detected on this machine.");
    return 0;
  }

  print(`Detected ${detected.length} platform(s):\n`);
  for (const p of detected) {
    print(`${p.name} (${p.id})`);
    print(`  paradigm:    ${p.paradigm}`);
    print(`  scope:       ${p.scope}`);
    print(`  configPath:  ${p.configPath}`);
    print(`  confidence:  ${p.confidence}  (${p.reason})`);
    print(`  capabilities: ${capabilitySummary(p.capabilities)}`);
    print("");
  }
  return 0;
}
