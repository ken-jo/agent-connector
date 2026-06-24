import * as React from "react";

import { Nav } from "@/components/sections/Nav";
import { Footer } from "@/components/sections/Footer";
import { SkipLink } from "@/components/ui/skip-link";
import { CodeBlock } from "@/components/ui/code-block";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { setMetaDescription } from "@/components/docs/meta";
import { canonicalEvents } from "@/components/docs/hooks-matrix";

const CONTENT_ID = "wizard-content";

const WIZARD_DESCRIPTION =
  "Generate starter defineConnector code for an agent-connector MCP connector — pick your server transport, hook events and surfaces and copy the scaffold.";

/** npm package + bin, single-sourced with the real package.json / CLI. */
const PACKAGE = "@ken-jo/agent-connector";

/**
 * The optional surfaces a connector can ship, keyed by the EXACT
 * ConnectorConfig field they emit. Mirrors src/core/types.ts — do not rename.
 */
const SURFACES = [
  { key: "hooks", label: "Hooks", hint: "Lifecycle hooks (PreToolUse, …)" },
  { key: "commands", label: "Commands", hint: "Slash commands" },
  { key: "skills", label: "Skills", hint: "Agent Skills (SKILL.md)" },
  { key: "subagents", label: "Subagents", hint: "Named delegate agents" },
  { key: "memory", label: "Memory", hint: "Managed AGENTS.md guidance blocks" },
  { key: "statusline", label: "Statusline", hint: "A status-line HUD" },
  { key: "actions", label: "Actions", hint: "User-invokable action verbs" },
] as const;

type SurfaceKey = (typeof SURFACES)[number]["key"];
type Transport = "stdio" | "http";

interface WizardState {
  id: string;
  displayName: string;
  binName: string;
  transport: Transport;
  command: string;
  args: string;
  env: string;
  url: string;
  surfaces: Record<SurfaceKey, boolean>;
  hookEvents: Record<string, boolean>;
  telemetryOff: boolean;
}

const INITIAL: WizardState = {
  id: "acme-db",
  displayName: "Acme DB",
  binName: "",
  transport: "stdio",
  command: "npx",
  args: "-y, @acme/db-mcp",
  env: "ACME_DB_DSN=${env:ACME_DB_DSN}",
  url: "https://mcp.acme.dev/sse",
  surfaces: {
    hooks: true,
    commands: false,
    skills: false,
    subagents: false,
    memory: false,
    statusline: false,
    actions: false,
  },
  hookEvents: { PreToolUse: true },
  telemetryOff: false,
};

const KEBAB_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Split a comma-separated list into trimmed, non-empty entries. */
function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse `KEY=value` lines/commas into an ordered [key, value] list. */
function parseEnv(raw: string): [string, string][] {
  return raw
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const eq = line.indexOf("=");
      if (eq === -1) return [line, ""] as [string, string];
      return [line.slice(0, eq).trim(), line.slice(eq + 1).trim()] as [
        string,
        string,
      ];
    })
    .filter(([k]) => k);
}

/** A double-quoted TS string literal with the escapes the snippet needs. */
function q(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const PAD = "  ";

/**
 * Build the `defineConnector({...})` scaffold from the form state. Pure (no
 * React), so it is trivially testable and renders identically server-side.
 * Every emitted key is a real ConnectorConfig field (src/core/types.ts).
 */
function generateConnector(state: WizardState): string {
  const lines: string[] = [];
  lines.push(`import { defineConnector } from ${q(PACKAGE)};`, "");
  lines.push("export default defineConnector({");

  lines.push(`${PAD}id: ${q(state.id || "my-connector")},`);
  if (state.displayName.trim())
    lines.push(`${PAD}displayName: ${q(state.displayName.trim())},`);

  // ── server ──
  lines.push(`${PAD}server: {`);
  if (state.transport === "stdio") {
    lines.push(`${PAD}${PAD}transport: "stdio",`);
    lines.push(`${PAD}${PAD}command: ${q(state.command || "npx")},`);
    const args = splitList(state.args);
    if (args.length) {
      lines.push(`${PAD}${PAD}args: [${args.map(q).join(", ")}],`);
    }
    const env = parseEnv(state.env);
    if (env.length) {
      lines.push(`${PAD}${PAD}env: {`);
      for (const [k, v] of env) {
        lines.push(`${PAD}${PAD}${PAD}${q(k)}: ${q(v)},`);
      }
      lines.push(`${PAD}${PAD}},`);
    }
  } else {
    lines.push(`${PAD}${PAD}transport: "http",`);
    lines.push(`${PAD}${PAD}url: ${q(state.url || "https://example.com/mcp")},`);
  }
  lines.push(`${PAD}},`);

  // ── hooks ──
  if (state.surfaces.hooks) {
    const events = canonicalEvents.filter((e) => state.hookEvents[e]);
    if (events.length) {
      lines.push(`${PAD}hooks: {`);
      for (const event of events) {
        lines.push(`${PAD}${PAD}${event}: {`);
        lines.push(`${PAD}${PAD}${PAD}matcher: "",`);
        lines.push(`${PAD}${PAD}${PAD}async handler(event) {`);
        lines.push(`${PAD}${PAD}${PAD}${PAD}// TODO: inspect \`event\` and return a HookResponse.`);
        lines.push(`${PAD}${PAD}${PAD}${PAD}return { decision: "allow" };`);
        lines.push(`${PAD}${PAD}${PAD}},`);
        lines.push(`${PAD}${PAD}},`);
      }
      lines.push(`${PAD}},`);
    }
  }

  // ── commands ──
  if (state.surfaces.commands) {
    lines.push(`${PAD}commands: [`);
    lines.push(`${PAD}${PAD}{`);
    lines.push(`${PAD}${PAD}${PAD}name: "hello",`);
    lines.push(`${PAD}${PAD}${PAD}description: "A starter slash command.",`);
    lines.push(`${PAD}${PAD}${PAD}prompt: "You are a helpful assistant. ...",`);
    lines.push(`${PAD}${PAD}},`);
    lines.push(`${PAD}],`);
  }

  // ── skills ──
  if (state.surfaces.skills) {
    lines.push(`${PAD}skills: [`);
    lines.push(`${PAD}${PAD}{`);
    lines.push(`${PAD}${PAD}${PAD}name: "starter-skill",`);
    lines.push(
      `${PAD}${PAD}${PAD}description: "What this skill does and when to use it.",`,
    );
    lines.push(`${PAD}${PAD}${PAD}body: "# Starter skill\\n\\nInstructions go here.",`);
    lines.push(`${PAD}${PAD}},`);
    lines.push(`${PAD}],`);
  }

  // ── subagents ──
  if (state.surfaces.subagents) {
    lines.push(`${PAD}subagents: [`);
    lines.push(`${PAD}${PAD}{`);
    lines.push(`${PAD}${PAD}${PAD}name: "starter-agent",`);
    lines.push(
      `${PAD}${PAD}${PAD}description: "When the orchestrator should delegate here.",`,
    );
    lines.push(`${PAD}${PAD}${PAD}prompt: "You are a specialist subagent. ...",`);
    lines.push(`${PAD}${PAD}},`);
    lines.push(`${PAD}],`);
  }

  // ── memory ──
  if (state.surfaces.memory) {
    lines.push(`${PAD}memory: [`);
    lines.push(`${PAD}${PAD}{`);
    lines.push(`${PAD}${PAD}${PAD}content: "Standing guidance written into each host's memory file.",`);
    lines.push(`${PAD}${PAD}},`);
    lines.push(`${PAD}],`);
  }

  // ── statusline (singular) ──
  if (state.surfaces.statusline) {
    lines.push(`${PAD}statusline: {`);
    lines.push(`${PAD}${PAD}render(ctx) {`);
    lines.push(`${PAD}${PAD}${PAD}return ctx.model?.id ?? "";`);
    lines.push(`${PAD}${PAD}},`);
    lines.push(`${PAD}},`);
  }

  // ── actions ──
  if (state.surfaces.actions) {
    lines.push(`${PAD}actions: [`);
    lines.push(`${PAD}${PAD}{`);
    lines.push(`${PAD}${PAD}${PAD}id: "say-hello",`);
    lines.push(`${PAD}${PAD}${PAD}description: "A starter action verb.",`);
    lines.push(`${PAD}${PAD}${PAD}run() {`);
    lines.push(`${PAD}${PAD}${PAD}${PAD}return { message: "Hello from the connector." };`);
    lines.push(`${PAD}${PAD}${PAD}},`);
    lines.push(`${PAD}${PAD}},`);
    lines.push(`${PAD}],`);
  }

  // ── telemetry (on by default; only emit an override when turned off) ──
  if (state.telemetryOff) {
    lines.push(`${PAD}telemetry: { enabled: false },`);
  } else {
    lines.push(`${PAD}// telemetry is on by default`);
  }

  lines.push("});");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Form primitives                                                      */
/* ------------------------------------------------------------------ */

const fieldClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card/40 p-3 transition-colors hover:bg-accent/40">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-primary"
      />
      <span className="flex flex-col">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {hint ? (
          <span className="text-xs text-muted-foreground">{hint}</span>
        ) : null}
      </span>
    </label>
  );
}

/** A copyable next-step line (numbered, with its own copy button). */
function Step({
  num,
  title,
  command,
  description,
}: {
  num: number;
  title: string;
  command: string;
  description?: string;
}) {
  return (
    <li className="flex gap-4">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-card font-mono text-xs font-semibold text-muted-foreground">
        {num}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        ) : null}
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
            {command}
          </code>
          <CopyButton value={command} label={`Copy: ${title}`} />
        </div>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

/**
 * /wizard — a standalone, client-side connector scaffold generator. A single
 * scrollable form drives a live, syntax-highlighted `defineConnector({...})`
 * snippet (the site's shared CodeBlock + CopyButton), grounded field-for-field
 * in the real ConnectorConfig (src/core/types.ts). No backend, no new deps.
 * Code-split (App.tsx React.lazy) so the form never weighs down the landing
 * chunk, and prerendered + in the sitemap like /coverage.
 */
export function WizardPage() {
  const [state, setState] = React.useState<WizardState>(INITIAL);

  React.useEffect(() => {
    document.title = "Connector wizard — agent-connector";
    setMetaDescription(WIZARD_DESCRIPTION);
    window.scrollTo({ top: 0 });
  }, []);

  const set = React.useCallback(
    <K extends keyof WizardState>(key: K, value: WizardState[K]) =>
      setState((s) => ({ ...s, [key]: value })),
    [],
  );

  const idError =
    state.id.trim() === ""
      ? "Required."
      : KEBAB_RE.test(state.id.trim())
        ? undefined
        : "Must be kebab-case (lowercase letters, digits and single dashes).";

  const generated = React.useMemo(() => generateConnector(state), [state]);

  const installCmd = `npm install ${PACKAGE}`;
  const deployCmd = `npx ${PACKAGE} install`;

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <SkipLink targetId={CONTENT_ID} />
      <Nav />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-14 sm:py-20">
        <div id={CONTENT_ID} tabIndex={-1} className="scroll-mt-24 outline-none">
          <div className="text-center">
            <p className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Wizard
            </p>
            <h1 className="mt-2 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
              Scaffold a connector
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-pretty text-base leading-relaxed text-muted-foreground">
              Pick your MCP server transport, hook events and surfaces — this
              page generates a copy-paste-valid{" "}
              <code className="font-mono text-sm text-foreground">
                defineConnector(&#123;…&#125;)
              </code>{" "}
              starter. Everything runs in your browser; nothing is sent
              anywhere.
            </p>
          </div>

          <div className="mt-12 grid gap-10 lg:grid-cols-2">
            {/* ── Form ── */}
            <form
              className="flex flex-col gap-8"
              onSubmit={(e) => e.preventDefault()}
            >
              {/* Basics */}
              <fieldset className="flex flex-col gap-4">
                <legend className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Basics
                </legend>
                <Field
                  id="wiz-id"
                  label="Connector id"
                  hint="kebab-case — the stable identifier."
                  error={idError}
                >
                  <input
                    id="wiz-id"
                    className={cn(
                      fieldClass,
                      idError &&
                        "border-destructive focus-visible:ring-destructive",
                    )}
                    value={state.id}
                    onChange={(e) => set("id", e.target.value)}
                    placeholder="acme-db"
                    aria-invalid={Boolean(idError)}
                    spellCheck={false}
                  />
                </Field>
                <Field
                  id="wiz-name"
                  label="Display name"
                  hint="Optional human-readable name."
                >
                  <input
                    id="wiz-name"
                    className={fieldClass}
                    value={state.displayName}
                    onChange={(e) => set("displayName", e.target.value)}
                    placeholder="Acme DB"
                  />
                </Field>
                <Field
                  id="wiz-bin"
                  label="Branded bin name"
                  hint="Optional — used in the deploy command below (defaults to agent-connector)."
                >
                  <input
                    id="wiz-bin"
                    className={fieldClass}
                    value={state.binName}
                    onChange={(e) => set("binName", e.target.value)}
                    placeholder="agent-connector"
                    spellCheck={false}
                  />
                </Field>
              </fieldset>

              {/* MCP server */}
              <fieldset className="flex flex-col gap-4">
                <legend className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  MCP server
                </legend>
                <Field id="wiz-transport" label="Transport">
                  <div
                    role="radiogroup"
                    aria-label="Transport"
                    className="flex gap-2"
                  >
                    {(["stdio", "http"] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        role="radio"
                        aria-checked={state.transport === t}
                        onClick={() => set("transport", t)}
                        className={cn(
                          "flex-1 rounded-md border px-3 py-2 font-mono text-sm transition-colors",
                          state.transport === t
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border bg-background text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </Field>

                {state.transport === "stdio" ? (
                  <>
                    <Field
                      id="wiz-command"
                      label="Command"
                      hint="The executable that launches your MCP server."
                    >
                      <input
                        id="wiz-command"
                        className={fieldClass}
                        value={state.command}
                        onChange={(e) => set("command", e.target.value)}
                        placeholder="npx"
                        spellCheck={false}
                      />
                    </Field>
                    <Field
                      id="wiz-args"
                      label="Args"
                      hint="Comma-separated, in order."
                    >
                      <input
                        id="wiz-args"
                        className={fieldClass}
                        value={state.args}
                        onChange={(e) => set("args", e.target.value)}
                        placeholder="-y, @acme/db-mcp"
                        spellCheck={false}
                      />
                    </Field>
                    <Field
                      id="wiz-env"
                      label="Env"
                      hint="KEY=value per line or comma-separated. ${env:VAR} interpolation is supported."
                    >
                      <textarea
                        id="wiz-env"
                        className={cn(fieldClass, "min-h-[4.5rem] resize-y")}
                        value={state.env}
                        onChange={(e) => set("env", e.target.value)}
                        placeholder="ACME_DB_DSN=${env:ACME_DB_DSN}"
                        spellCheck={false}
                      />
                    </Field>
                  </>
                ) : (
                  <Field
                    id="wiz-url"
                    label="URL"
                    hint="The remote MCP endpoint."
                  >
                    <input
                      id="wiz-url"
                      className={fieldClass}
                      value={state.url}
                      onChange={(e) => set("url", e.target.value)}
                      placeholder="https://mcp.acme.dev/sse"
                      spellCheck={false}
                    />
                  </Field>
                )}
              </fieldset>

              {/* Surfaces */}
              <fieldset className="flex flex-col gap-4">
                <legend className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Surfaces to include
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {SURFACES.map((s) => (
                    <Checkbox
                      key={s.key}
                      label={s.label}
                      hint={s.hint}
                      checked={state.surfaces[s.key]}
                      onChange={(v) =>
                        set("surfaces", { ...state.surfaces, [s.key]: v })
                      }
                    />
                  ))}
                </div>

                {state.surfaces.hooks ? (
                  <fieldset className="rounded-lg border border-border bg-card/40 p-4">
                    <legend className="px-1 text-xs font-medium text-muted-foreground">
                      Hook events ({canonicalEvents.length} canonical)
                    </legend>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {canonicalEvents.map((event) => (
                        <label
                          key={event}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent/40"
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(state.hookEvents[event])}
                            onChange={(e) =>
                              set("hookEvents", {
                                ...state.hookEvents,
                                [event]: e.target.checked,
                              })
                            }
                            className="size-4 accent-primary"
                          />
                          <span className="font-mono text-xs text-foreground">
                            {event}
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : null}
              </fieldset>

              {/* Telemetry */}
              <fieldset className="flex flex-col gap-3">
                <legend className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Telemetry
                </legend>
                <Checkbox
                  label="Disable telemetry"
                  hint="Telemetry is on by default (platform-independent per-tool token counts). Tick to emit an explicit opt-out."
                  checked={state.telemetryOff}
                  onChange={(v) => set("telemetryOff", v)}
                />
              </fieldset>
            </form>

            {/* ── Live output ── */}
            <div className="flex flex-col gap-8 lg:sticky lg:top-24 lg:self-start">
              <div>
                <div className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <span className="size-2 rounded-full bg-emerald-500" />
                  Live output
                </div>
                <CodeBlock
                  code={generated}
                  filename="agent-connector.config.ts"
                  language="ts"
                />
              </div>

              <div>
                <h2 className="text-base font-semibold text-foreground">
                  Next steps
                </h2>
                <ol className="mt-4 flex flex-col gap-5">
                  <Step
                    num={1}
                    title="Install the framework"
                    command={installCmd}
                    description="Add agent-connector to your project."
                  />
                  <Step
                    num={2}
                    title="Save the file"
                    command="agent-connector.config.ts"
                    description="Paste the generated code into this file (or your project's connector entry) and finish the TODOs."
                  />
                  <Step
                    num={3}
                    title="Deploy across every detected host"
                    command={deployCmd}
                    description="Renders the native config + hooks for each installed agent platform."
                  />
                </ol>
                {state.binName.trim() && state.binName.trim() !== "agent-connector" ? (
                  <p className="mt-4 text-xs text-muted-foreground">
                    Once published with your branded bin{" "}
                    <code className="font-mono text-foreground">
                      {state.binName.trim()}
                    </code>
                    , your users run{" "}
                    <code className="font-mono text-foreground">
                      {state.binName.trim()} install
                    </code>{" "}
                    instead.
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
