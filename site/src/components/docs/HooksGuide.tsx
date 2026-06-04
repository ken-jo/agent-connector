import { Check, X, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CodeBlock } from "@/components/ui/code-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { DocSection, H3, H4, Lead, P, C, List, LI, Callout } from "./prose";
import {
  canonicalEvents,
  paradigmOrder,
  paradigmLabel,
  paradigmBlurb,
  platformsByParadigm,
  platformById,
  type CanonicalEvent,
  type HookParadigm,
  type PlatformHookEntry,
} from "./hooks-matrix";

/* ------------------------------------------------------------------ */
/* Paradigm color accents (light + dark)                               */
/* ------------------------------------------------------------------ */

const paradigmAccent: Record<
  HookParadigm,
  { dot: string; text: string; chip: string; head: string }
> = {
  "json-stdio": {
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
    chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    head: "bg-emerald-500/5",
  },
  "ts-plugin": {
    dot: "bg-violet-500",
    text: "text-violet-600 dark:text-violet-400",
    chip: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    head: "bg-violet-500/5",
  },
  "mcp-only": {
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
    chip: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    head: "bg-amber-500/5",
  },
};

/* ------------------------------------------------------------------ */
/* Small atoms                                                         */
/* ------------------------------------------------------------------ */

/** A native event-name cell, or a muted skip badge when unsupported. */
function EventCell({
  native,
  paradigm,
  hasHooks,
}: {
  native: string | null;
  paradigm: HookParadigm;
  hasHooks: boolean;
}) {
  if (native) {
    return (
      <code
        className={cn(
          "inline-block whitespace-nowrap font-mono text-[0.72rem] font-medium",
          paradigmAccent[paradigm].text,
        )}
      >
        {native}
      </code>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[0.7rem] font-medium text-muted-foreground/70"
      title={hasHooks ? "No host equivalent — graceful skip-warn" : "mcp-only — no hook layer"}
    >
      <span aria-hidden>—</span>
      <span className="sr-only">unsupported</span>
    </span>
  );
}

/** A green check / red cross for a boolean capability. */
function CapIcon({ on, label }: { on: boolean; label: string }) {
  return on ? (
    <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
      <Check className="size-4 shrink-0" aria-hidden />
      <span className="text-sm text-foreground/90">{label}</span>
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <X className="size-4 shrink-0" aria-hidden />
      <span className="text-sm text-muted-foreground">{label}</span>
    </span>
  );
}

function ParadigmChip({ paradigm }: { paradigm: HookParadigm }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[0.68rem] font-medium",
        paradigmAccent[paradigm].chip,
      )}
    >
      <span className={cn("size-1.5 rounded-full", paradigmAccent[paradigm].dot)} />
      {paradigmLabel[paradigm]}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* The big mapping matrix — one table per paradigm group               */
/* ------------------------------------------------------------------ */

function ParadigmMatrix({
  paradigm,
  entries,
}: {
  paradigm: HookParadigm;
  entries: PlatformHookEntry[];
}) {
  const accent = paradigmAccent[paradigm];
  return (
    <div className="mt-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ParadigmChip paradigm={paradigm} />
        <Badge variant="muted">{entries.length}</Badge>
        <span className="text-sm text-muted-foreground">
          {paradigmBlurb[paradigm]}
        </span>
      </div>
      <div className="not-prose overflow-x-auto rounded-xl border border-border bg-card/40 shadow-sm">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr>
              <th
                className={cn(
                  "sticky left-0 z-10 border-b border-r border-border bg-muted/60 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur",
                )}
              >
                Canonical event
              </th>
              {entries.map((p) => (
                <th
                  key={p.platform}
                  className={cn(
                    "border-b border-border px-3 py-2.5 text-left text-[0.7rem] font-semibold text-foreground",
                    accent.head,
                  )}
                >
                  <span className="whitespace-nowrap">{p.displayName}</span>
                  <span className="mt-0.5 block font-mono text-[0.62rem] font-normal text-muted-foreground">
                    {p.platform}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {canonicalEvents.map((ev) => (
              <tr key={ev}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-b border-r border-border/60 bg-card/95 px-3 py-2.5 text-left backdrop-blur"
                >
                  <code className="whitespace-nowrap font-mono text-[0.74rem] font-medium text-foreground">
                    {ev}
                  </code>
                </th>
                {entries.map((p) => (
                  <td
                    key={p.platform}
                    className="border-b border-border/60 px-3 py-2.5 align-middle"
                  >
                    <EventCell
                      native={p.events[ev]}
                      paradigm={paradigm}
                      hasHooks={p.hasHooks}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MappingMatrix() {
  return (
    <div className="not-prose">
      {paradigmOrder.map((paradigm) => (
        <ParadigmMatrix
          key={paradigm}
          paradigm={paradigm}
          entries={platformsByParadigm[paradigm]}
        />
      ))}
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <code className="font-mono text-emerald-600 dark:text-emerald-400">name</code>
          native event name the connector writes
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden>—</span>
          no host equivalent → graceful skip-warn
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Per-platform detail tabs (grouped by paradigm)                      */
/* ------------------------------------------------------------------ */

function PlatformDetail({ p }: { p: PlatformHookEntry }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h4 className="text-base font-semibold text-foreground">
          {p.displayName}
        </h4>
        <ParadigmChip paradigm={p.paradigm} />
        {!p.hasHooks ? (
          <Badge
            variant="muted"
            className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          >
            no hook layer
          </Badge>
        ) : null}
      </div>

      <div>
        <p className="mb-1 font-mono text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Hook config path
        </p>
        <code className="block overflow-x-auto rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[0.74rem] text-foreground/90">
          {p.configPath}
        </code>
      </div>

      <div>
        <p className="mb-2 font-mono text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Capabilities
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-6">
          <CapIcon on={p.capabilities.canModifyArgs} label="canModifyArgs" />
          <CapIcon on={p.capabilities.canModifyOutput} label="canModifyOutput" />
          <CapIcon
            on={p.capabilities.canInjectSessionContext}
            label="canInjectSessionContext"
          />
        </div>
      </div>

      {p.hasHooks ? (
        <div>
          <p className="mb-2 font-mono text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Per-event native names
          </p>
          <div className="overflow-x-auto rounded-xl border border-border bg-card/40">
            <table className="w-full border-collapse text-left text-sm">
              <tbody>
                {canonicalEvents.map((ev) => (
                  <tr key={ev}>
                    <th
                      scope="row"
                      className="border-b border-border/60 px-3 py-2 text-left align-middle"
                    >
                      <code className="whitespace-nowrap font-mono text-[0.74rem] font-medium text-foreground">
                        {ev}
                      </code>
                    </th>
                    <td className="border-b border-border/60 px-3 py-2 align-middle">
                      <EventCell
                        native={p.events[ev]}
                        paradigm={p.paradigm}
                        hasHooks={p.hasHooks}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div>
        <p className="mb-2 font-mono text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          How a decision is signaled
        </p>
        <p className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm leading-relaxed text-foreground/90">
          {p.notes}
        </p>
      </div>
    </div>
  );
}

function PlatformTabs() {
  return (
    <div className="not-prose mt-6 space-y-10">
      {paradigmOrder.map((paradigm) => {
        const entries = platformsByParadigm[paradigm];
        return (
          <div key={paradigm}>
            <div className="mb-3 flex items-center gap-3">
              <ParadigmChip paradigm={paradigm} />
              <Badge variant="muted">{entries.length}</Badge>
            </div>
            <Tabs defaultValue={entries[0]!.platform}>
              <TabsList className="flex h-auto flex-wrap justify-start gap-1">
                {entries.map((p) => (
                  <TabsTrigger key={p.platform} value={p.platform}>
                    {p.displayName}
                  </TabsTrigger>
                ))}
              </TabsList>
              {entries.map((p) => (
                <TabsContent key={p.platform} value={p.platform}>
                  <div className="rounded-xl border border-border bg-card/30 p-5 shadow-sm">
                    <PlatformDetail p={p} />
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Claude Code ↔ Kilo CLI: same position?                              */
/* ------------------------------------------------------------------ */

const CLAUDE_HOOKS_JSON = `// ~/.claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "agent-connector hook claude-code PreToolUse --connector my-connector"
          }
        ]
      }
    ]
  }
}`;

const KILO_PLUGIN_JS = `// ~/.config/kilo/plugin/my-connector.js  (+ registered in kilo.jsonc "plugin"[])
import { spawnSync } from "node:child_process";

// @kilocode/plugin module: { id, server: (input) => Hooks }
export default {
  id: "my-connector",
  server: () => ({
    // PreToolUse → tool.execute.before; throw to deny, mutate output.args to modify
    "tool.execute.before": async (input, output) => {
      const res = runBridge("PreToolUse", { args: output.args });
      if (res.decision === "deny") throw new Error(res.reason);
      if (res.decision === "modify") output.args = res.updatedInput;
    },
  }),
};

function runBridge(event, payload) {
  // both hosts dispatch the SAME handler via the one home-bin entrypoint:
  const r = spawnSync(
    "agent-connector",
    ["hook", "kilo-cli", event, "--connector", "my-connector"],
    { input: JSON.stringify(payload), encoding: "utf8" },
  );
  return JSON.parse(r.stdout || "{}");
}`;

/** Side-by-side per-event comparison rows for claude-code vs kilo-cli. */
const compareEvents: {
  event: CanonicalEvent;
  align: "same" | "differ" | "claude-only" | "kilo-only";
  note: string;
}[] = [
  {
    event: "SessionStart",
    align: "differ",
    note:
      "Both support it, but via very different mechanics: Claude writes a SessionStart settings hook; Kilo synthesizes an experimental.chat.system.transform plugin handler that injects additionalContext into the system block.",
  },
  {
    event: "SessionEnd",
    align: "claude-only",
    note: "Claude has SessionEnd 1:1; Kilo's plugin surface has no equivalent → skip-warn.",
  },
  {
    event: "UserPromptSubmit",
    align: "claude-only",
    note: "Claude has UserPromptSubmit 1:1; Kilo has no equivalent → skip-warn.",
  },
  {
    event: "PreToolUse",
    align: "differ",
    note:
      "The headline pair. Claude → a PreToolUse command in hooks.json that replies with hookSpecificOutput{ permissionDecision }. Kilo → a tool.execute.before plugin handler that throws to deny and mutates output.args to modify. Same handler, two native shapes.",
  },
  {
    event: "PostToolUse",
    align: "differ",
    note:
      "Claude → PostToolUse command (canModifyOutput false — cannot rewrite emitted output). Kilo → tool.execute.after handler that CAN mutate output.output (canModifyOutput true).",
  },
  {
    event: "PreCompact",
    align: "claude-only",
    note: "Claude has PreCompact 1:1; Kilo has no equivalent → skip-warn.",
  },
  {
    event: "Stop",
    align: "claude-only",
    note: "Claude has Stop 1:1; Kilo has no equivalent → skip-warn.",
  },
  {
    event: "Notification",
    align: "claude-only",
    note: "Claude has Notification 1:1; Kilo has no equivalent → skip-warn.",
  },
];

const alignStyle: Record<
  (typeof compareEvents)[number]["align"],
  { label: string; cls: string }
> = {
  same: {
    label: "lines up",
    cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  differ: {
    label: "same hook, different shape",
    cls: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  "claude-only": {
    label: "claude-code only",
    cls: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  "kilo-only": {
    label: "kilo-cli only",
    cls: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
};

function ClaudeVsKilo() {
  const claude = platformById("claude-code")!;
  const kilo = platformById("kilo-cli")!;
  return (
    <div className="not-prose mt-6">
      {/* Two-column header / position cards */}
      <div className="grid gap-4 md:grid-cols-2">
        {[claude, kilo].map((p) => (
          <div
            key={p.platform}
            className="rounded-xl border border-border bg-card/40 p-5 shadow-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold text-foreground">
                {p.displayName}
              </span>
              <ParadigmChip paradigm={p.paradigm} />
            </div>
            <code className="mt-3 block overflow-x-auto rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[0.72rem] text-foreground/90">
              {p.configPath}
            </code>
            <div className="mt-3 flex flex-col gap-1.5">
              <CapIcon on={p.capabilities.canModifyArgs} label="canModifyArgs" />
              <CapIcon on={p.capabilities.canModifyOutput} label="canModifyOutput" />
              <CapIcon
                on={p.capabilities.canInjectSessionContext}
                label="canInjectSessionContext"
              />
            </div>
          </div>
        ))}
      </div>

      {/* The PreToolUse code pairing (the user's headline example) */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
            <span className={cn("size-1.5 rounded-full", paradigmAccent["json-stdio"].dot)} />
            claude-code · <code className="font-mono text-emerald-600 dark:text-emerald-400">PreToolUse</code>
          </div>
          <CodeBlock
            code={CLAUDE_HOOKS_JSON}
            language="json"
            filename="json-stdio: settings hook"
          />
        </div>
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
            <span className={cn("size-1.5 rounded-full", paradigmAccent["ts-plugin"].dot)} />
            kilo-cli · <code className="font-mono text-violet-600 dark:text-violet-400">tool.execute.before</code>
          </div>
          <CodeBlock
            code={KILO_PLUGIN_JS}
            language="ts"
            filename="ts-plugin: synthesized module"
          />
        </div>
      </div>

      {/* Per-event alignment table */}
      <div className="mt-6 overflow-x-auto rounded-xl border border-border bg-card/40 shadow-sm">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr>
              <th className="border-b border-r border-border bg-muted/40 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Canonical event
              </th>
              <th className="border-b border-border bg-muted/40 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <span className="text-emerald-600 dark:text-emerald-400">claude-code</span> (json-stdio)
              </th>
              <th className="border-b border-border bg-muted/40 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <span className="text-violet-600 dark:text-violet-400">kilo-cli</span> (ts-plugin)
              </th>
              <th className="border-b border-border bg-muted/40 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Alignment
              </th>
            </tr>
          </thead>
          <tbody>
            {compareEvents.map((row) => (
              <tr key={row.event}>
                <th
                  scope="row"
                  className="border-b border-r border-border/60 px-3 py-2.5 text-left align-top"
                >
                  <code className="whitespace-nowrap font-mono text-[0.74rem] font-medium text-foreground">
                    {row.event}
                  </code>
                </th>
                <td className="border-b border-border/60 px-3 py-2.5 align-top">
                  <EventCell
                    native={claude.events[row.event]}
                    paradigm="json-stdio"
                    hasHooks
                  />
                </td>
                <td className="border-b border-border/60 px-3 py-2.5 align-top">
                  <EventCell
                    native={kilo.events[row.event]}
                    paradigm="ts-plugin"
                    hasHooks
                  />
                </td>
                <td className="border-b border-border/60 px-3 py-2.5 align-top">
                  <div className="flex flex-col gap-1.5">
                    <span
                      className={cn(
                        "inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[0.65rem] font-medium",
                        alignStyle[row.align].cls,
                      )}
                    >
                      {alignStyle[row.align].label}
                    </span>
                    <span className="text-xs leading-relaxed text-muted-foreground">
                      {row.note}
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Callout title="The same position, two renderings">
        For the events both hosts support, you write <em>one</em> handler. The
        framework places it at the host&apos;s native position — a{" "}
        <C>PreToolUse</C> command in <C>settings.json</C> for Claude Code, a{" "}
        <C>tool.execute.before</C> handler in a synthesized{" "}
        <C>@kilocode/plugin</C> module for Kilo CLI — and both shell back to the{" "}
        <em>same</em> home-bin entrypoint (
        <C>agent-connector hook &lt;platform&gt; PreToolUse --connector &lt;id&gt;</C>
        ). They line up on PreToolUse / PostToolUse / SessionStart; they diverge
        on output-rewrite (Kilo can rewrite tool output, Claude can&apos;t) and on
        the four lifecycle events Kilo&apos;s plugin surface simply doesn&apos;t
        expose.
      </Callout>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The composed Hooks developer-guide section                          */
/* ------------------------------------------------------------------ */

const SINGLE_WRAPPER_SNIPPET = `import { defineConnector } from "agent-connector";

export default defineConnector({
  id: "my-connector",
  hooks: {
    // ONE handler per canonical event — written once.
    PreToolUse: {
      matcher: "Bash",                 // regex on tool name (tool events only)
      handler: async (event) => {
        if (looksDangerous(event.toolInput)) {
          return { decision: "deny", reason: "blocked by policy" };
        }
        // returning void = allow (the universal default)
      },
    },
    SessionStart: {
      handler: async () => ({
        decision: "context",
        additionalContext: "Project guidelines: …",
      }),
    },
  },
});`;

export function HooksGuideSection() {
  return (
    <DocSection
      id="hooks-guide"
      eyebrow="Developer Guide"
      title="Hooks: cross-platform mapping"
    >
      <Lead>
        Hooks are the surface that varies <strong>most</strong> across hosts —
        every platform names the lifecycle events differently, supports a
        different subset of them, and signals a deny/decision in its own shape.
        You write <strong>one handler per canonical event</strong>;
        agent-connector renders it into each host&apos;s native hook. This page
        is the precise, visible map.
      </Lead>

      {/* a. single-wrapper API */}
      <H3 id="single-wrapper">The single-wrapper hook API</H3>
      <P>
        In <C>defineConnector(&#123; hooks &#125;)</C> you declare one{" "}
        <C>handler</C> per normalized event (the 8 canonical events). The
        framework looks at each detected host&apos;s paradigm and synthesizes the
        right delivery; a universal home-bin <C>hook</C> entrypoint dispatches the
        payload into your one handler and formats the reply back into the
        host&apos;s native control surface.
      </P>
      <div className="not-prose my-6 grid gap-3 md:grid-cols-3">
        {paradigmOrder.map((paradigm) => (
          <div
            key={paradigm}
            className={cn(
              "rounded-xl border p-4 shadow-sm",
              "border-border bg-card/40",
            )}
          >
            <div className="mb-2 flex items-center gap-2">
              <ParadigmChip paradigm={paradigm} />
              <Badge variant="muted">
                {platformsByParadigm[paradigm].length}
              </Badge>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {paradigm === "json-stdio"
                ? "Your handler is rendered into a native JSON hook entry; the host pipes JSON to the home-bin command and reads the reply."
                : paradigm === "ts-plugin"
                  ? "Your handler is rendered into a synthesized plugin module the host loads; it bridges native lifecycle functions to the home-bin entrypoint."
                  : "No hook layer — only the MCP server installs; declared hooks skip-warn (hooks unavailable here)."}
            </p>
          </div>
        ))}
      </div>
      <CodeBlock
        code={SINGLE_WRAPPER_SNIPPET}
        language="ts"
        filename="agent-connector.config.ts"
      />
      <div className="not-prose my-6 flex items-center justify-center gap-3 text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 font-mono text-xs">
          <ArrowRight className="size-3.5" />
          agent-connector hook &lt;platform&gt; &lt;event&gt; --connector &lt;id&gt;
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <Callout title="Degradation rule — graceful skip-warn">
        If a host has no equivalent for a canonical event (e.g. Kilo CLI has no{" "}
        <C>Stop</C>, Cursor has no <C>UserPromptSubmit</C>), that event is simply{" "}
        <strong>never wired</strong> — the install/sync diff reports a{" "}
        <C>warn</C> and moves on. Likewise a host that can&apos;t honor a{" "}
        decision (no output-rewrite, no <C>ask</C> gate) degrades it (modify →
        allow, ask → deny) rather than failing. The runtime entrypoint is{" "}
        <strong>fail-open</strong>: a handler or framework bug can never wedge a
        host&apos;s tool call.
      </Callout>

      {/* b. the big mapping matrix */}
      <H3 id="mapping-matrix">The mapping matrix</H3>
      <P>
        Rows are the 8 canonical events; columns are the platforms, grouped by
        paradigm. A cell shows the <strong>native event name</strong> the
        connector writes for that host, or a muted <C>—</C> when the host has no
        equivalent (graceful skip-warn). The first column is sticky; scroll
        horizontally for the wider groups.
      </P>
      <MappingMatrix />

      {/* c. per-platform detail tabs */}
      <H3 id="platform-detail">Per-platform detail</H3>
      <P>
        Each tab shows that host&apos;s paradigm, hook config path, capabilities
        (<C>canModifyArgs</C> / <C>canModifyOutput</C> /{" "}
        <C>canInjectSessionContext</C>), the per-event native names, and exactly
        how a deny/decision is signaled.
      </P>
      <PlatformTabs />

      {/* d. claude-code vs kilo-cli */}
      <H3 id="claude-vs-kilo">Claude Code ↔ Kilo CLI: same position?</H3>
      <P>
        These two hosts sit in different paradigms —{" "}
        <span className="font-medium text-emerald-600 dark:text-emerald-400">
          claude-code
        </span>{" "}
        is the reference <C>json-stdio</C> host (settings <C>hooks</C>);{" "}
        <span className="font-medium text-violet-600 dark:text-violet-400">
          kilo-cli
        </span>{" "}
        is a <C>ts-plugin</C> host (a generated <C>@kilocode/plugin</C> module
        with <C>tool.execute.*</C> handlers). The question: when you declare a{" "}
        <C>PreToolUse</C> hook once, do they end up in the{" "}
        <em>same position</em>? Here is each canonical event side by side.
      </P>
      <ClaudeVsKilo />

      <H4>Where they line up vs differ</H4>
      <List>
        <LI>
          <strong>Line up:</strong> <C>PreToolUse</C>, <C>PostToolUse</C>,{" "}
          <C>SessionStart</C> — both wire all three (Claude via settings hook
          commands, Kilo via plugin handlers), both deny/inject-context, both
          dispatch your <em>one</em> handler over the same home-bin entrypoint.
        </LI>
        <LI>
          <strong>Differ — output rewrite:</strong> Kilo&apos;s{" "}
          <C>tool.execute.after</C> can mutate <C>output.output</C> (
          <C>canModifyOutput: true</C>); Claude&apos;s <C>PostToolUse</C> cannot
          (<C>canModifyOutput: false</C>).
        </LI>
        <LI>
          <strong>Differ — lifecycle coverage:</strong> Claude maps all 8 events
          1:1; Kilo&apos;s plugin surface only exposes the two tool events plus a{" "}
          SessionStart surrogate, so <C>SessionEnd</C>,{" "}
          <C>UserPromptSubmit</C>, <C>PreCompact</C>, <C>Stop</C> and{" "}
          <C>Notification</C> skip-warn on Kilo.
        </LI>
      </List>
    </DocSection>
  );
}
