/**
 * regression/review-fixes-2 — regression tests for the second-pass independent
 * review fixes. One file so the whole batch is easy to run + reason about:
 *
 *   1. Path traversal via skill.resources keys (config-time reject + adapter
 *      runtime skip of an escaping key).
 *   2. uninstallSkills must NOT rm -rf a skill dir holding a user-added file.
 *   3. opencode agent normalization before the dedup fingerprint (fork copies
 *      collapse).
 *   4. serve tolerates an unknown future flag before `--`.
 *   5. goose bare "YYYY-MM-DD HH:MM:SS" parsed as UTC (not local).
 *   6. codex model-less token_count rows back-filled + flushed-as-unknown WITH
 *      a dedup key.
 *   7. copilot-cli best-session-attr keeps the LAST equal-priority candidate.
 *   8. CSV export carries the installScope / launchMethod columns.
 *   9. cursor body-only command description containing "-->" cannot break out
 *      of the HTML comment header.
 *  10. leaderboard scope:"unknown" matches only when BOTH dimensions are absent.
 *
 * Env (HOME / XDG_*) is snapshotted + restored per test so reader fixtures stay
 * isolated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import initSqlJs from "sql.js";
import type { SqlJsStatic } from "sql.js";

// Mock the runtime so `serve`'s `runServe` does NOT spawn a real child / proxy
// stdio (which would block on process.stdin in a unit test). We only need to
// prove arg-parsing tolerates the unknown flag and reaches the spawn path with
// the correctly-parsed connector + server invocation.
const runServeRuntimeMock = vi.fn(async () => 0);
vi.mock("../../src/runtime/index.js", () => ({
  runServe: (opts: unknown) => runServeRuntimeMock(opts),
}));

import { defineConnector, ConnectorConfigError } from "../../src/core/define-connector.js";
import claudeAdapter from "../../src/adapters/claude-code/index.js";
import cursorAdapter from "../../src/adapters/cursor/index.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import { run as runServe } from "../../src/cli/commands/serve.js";
import codexReader from "../../src/usage/readers/codex.js";
import copilotReader from "../../src/usage/readers/copilot-cli.js";
import gooseReader from "../../src/usage/readers/goose.js";
import opencodeReader from "../../src/usage/readers/opencode.js";
import { normalizeOpencodeAgentName } from "../../src/usage/normalize.js";
import { mcpLeaderboard } from "../../src/telemetry/leaderboard.js";
import { toCSV } from "../../src/telemetry/report.js";
import type {
  QueryFilter,
  TelemetryStore,
  ToolEventRecord,
} from "../../src/telemetry/types.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fake-HOME harness for the reader fixtures.
// ─────────────────────────────────────────────────────────────────────────

const SAVED_ENV = ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"] as const;
let tmpHome: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of SAVED_ENV) savedEnv[k] = process.env[k];
  tmpHome = mkdtempSync(join(tmpdir(), "ac-rf2-home-"));
  process.env.HOME = tmpHome;
  process.env.XDG_DATA_HOME = join(tmpHome, ".local", "share");
  process.env.XDG_CONFIG_HOME = join(tmpHome, ".config");
});

afterEach(() => {
  for (const k of SAVED_ENV) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

let SQL: SqlJsStatic;
beforeEach(async () => {
  SQL ??= await initSqlJs({});
});

function writeSqliteDb(dbPath: string, statements: string[]): void {
  const db = new SQL.Database();
  try {
    for (const sql of statements) db.run(sql);
    const bytes = db.export();
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, Buffer.from(bytes));
  } finally {
    db.close();
  }
}

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function writeJsonl(dir: string, name: string, lines: unknown[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

// ═════════════════════════════════════════════════════════════════════════
// 1. Path traversal via skill.resources keys.
// ═════════════════════════════════════════════════════════════════════════

describe("HIGH/SECURITY: skill.resources path-traversal rejection", () => {
  const base = (resources: Record<string, string>) => ({
    id: "demo",
    skills: [{ name: "s", description: "d", body: "b", resources }],
  });

  it("defineConnector throws on a parent-escaping key '../x'", () => {
    expect(() => defineConnector(base({ "../x": "pwned" }))).toThrow(ConnectorConfigError);
  });

  it("rejects a deep traversal '../../settings.json'", () => {
    expect(() => defineConnector(base({ "../../settings.json": "x" }))).toThrow(/escape/i);
  });

  it("rejects an embedded '/../' segment 'a/../../b'", () => {
    expect(() => defineConnector(base({ "a/../../b": "x" }))).toThrow(ConnectorConfigError);
  });

  it("rejects an absolute key", () => {
    expect(() => defineConnector(base({ "/etc/passwd": "x" }))).toThrow(/absolute/i);
  });

  it("rejects an empty / '.' key", () => {
    expect(() => defineConnector(base({ "": "x" }))).toThrow(ConnectorConfigError);
    expect(() => defineConnector(base({ ".": "x" }))).toThrow(ConnectorConfigError);
  });

  it("rejects a backslash traversal '..\\\\x' regardless of host OS", () => {
    expect(() => defineConnector(base({ "..\\x": "x" }))).toThrow(ConnectorConfigError);
  });

  it("ACCEPTS safe nested keys (scripts/run.sh, references/api.md)", () => {
    const c = defineConnector(base({ "scripts/run.sh": "echo", "references/api.md": "# api" }));
    expect(Object.keys(c.skills[0]!.resources!)).toEqual(["scripts/run.sh", "references/api.md"]);
  });

  it("DEFENSE-IN-DEPTH: an adapter resource loop skips an escaping key without writing outside the skill dir", () => {
    // Build a connector that bypasses defineConnector's validation (simulate a
    // hand-rolled ResolvedConnector) so we exercise the adapter's own guard.
    const projectDir = mkdtempSync(join(tmpdir(), "ac-rf2-proj-"));
    const connector = defineConnector({ id: "demo", skills: [{ name: "s", description: "d", body: "b" }] });
    // Inject an escaping resource AFTER validation (defense-in-depth target).
    (connector.skills[0] as { resources?: Record<string, string> }).resources = {
      "../../../escape.txt": "should-not-be-written",
    };
    const ctx: InstallContext = {
      connector,
      scope: "project",
      projectDir,
      homeBinPath: "/home/u/.agent-connector/bin/agent-connector",
      dataRoot: join(projectDir, ".data"),
      dryRun: false,
    };
    const changes = claudeAdapter.installSkills!(ctx);
    // The escaping resource is skip+warned, never written.
    expect(changes.some((c) => c.action === "warn" && /escape/i.test(c.detail ?? ""))).toBe(true);
    // The escape target (would-be sibling of projectDir) does NOT exist.
    expect(existsSync(join(projectDir, "..", "..", "escape.txt"))).toBe(false);
    expect(existsSync(join(dirname(projectDir), "escape.txt"))).toBe(false);
    rmSync(projectDir, { recursive: true, force: true });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. uninstallSkills must preserve a user file & only remove what it wrote.
// ═════════════════════════════════════════════════════════════════════════

describe("HIGH: uninstallSkills does not rm -rf user-added files", () => {
  function ctxFor(projectDir: string): InstallContext {
    const connector = defineConnector({
      id: "demo",
      skills: [
        {
          name: "pdf-tools",
          description: "Work with PDFs",
          body: "Body",
          resources: { "scripts/extract.sh": "#!/bin/sh\necho hi\n" },
        },
      ],
    });
    return {
      connector,
      scope: "project",
      projectDir,
      homeBinPath: "/home/u/.agent-connector/bin/agent-connector",
      dataRoot: join(projectDir, ".data"),
      dryRun: false,
    };
  }

  it("preserves a user file in the skill dir; removes ONLY what was written", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ac-rf2-proj-"));
    const ctx = ctxFor(projectDir);
    const skillDir = join(projectDir, ".claude", "skills", "pdf-tools");

    claudeAdapter.installSkills!(ctx);
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillDir, "scripts", "extract.sh"))).toBe(true);

    // The user drops a hand-written note beside the connector's files.
    const userFile = join(skillDir, "NOTES.md");
    writeFileSync(userFile, "my own notes", "utf8");

    claudeAdapter.uninstallSkills!(ctx);

    // Connector-written files gone …
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(false);
    expect(existsSync(join(skillDir, "scripts", "extract.sh"))).toBe(false);
    // … but the user file (and therefore the dir) survives, with content intact.
    expect(existsSync(userFile)).toBe(true);
    expect(readFileSync(userFile, "utf8")).toBe("my own notes");
    expect(existsSync(skillDir)).toBe(true);

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("removes the skill dir when it holds ONLY connector-written (incl. nested) files", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ac-rf2-proj-"));
    const ctx = ctxFor(projectDir);
    const skillDir = join(projectDir, ".claude", "skills", "pdf-tools");

    claudeAdapter.installSkills!(ctx);
    claudeAdapter.uninstallSkills!(ctx);

    // Whole tree gone, including the now-empty scripts/ subdir.
    expect(existsSync(skillDir)).toBe(false);
    rmSync(projectDir, { recursive: true, force: true });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. opencode agent normalization before the dedup fingerprint.
// ═════════════════════════════════════════════════════════════════════════

describe("HIGH: opencode agent normalization (fork copies collapse)", () => {
  const dbPath = (): string => join(tmpHome, ".local", "share", "opencode", "opencode.db");

  function msg(over: Record<string, unknown>): string {
    return JSON.stringify({
      role: "assistant",
      modelID: "claude-sonnet-4-5",
      providerID: "anthropic",
      time: { created: 1775000000000 },
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      ...over,
    });
  }

  it("normalizeOpencodeAgentName ports the Rust pipeline", () => {
    expect(normalizeOpencodeAgentName("sisyphus")).toBe("Sisyphus");
    expect(normalizeOpencodeAgentName("oh-my-codex:sisyphus")).toBe("Sisyphus");
    expect(normalizeOpencodeAgentName("  Sisyphus (Ultraworker) ")).toBe("Sisyphus");
    expect(normalizeOpencodeAgentName("​sisyphus")).toBe("Sisyphus"); // zero-width prefix
    expect(normalizeOpencodeAgentName("planner-sisyphus")).toBe("Planner-Sisyphus");
    expect(normalizeOpencodeAgentName("ui-designer")).toBe("UI Designer"); // titlecase + UI
  });

  it("two rows whose agents differ only by raw form dedup to ONE record", async () => {
    // Same fingerprint everything EXCEPT the raw agent string, which both
    // normalize to "Sisyphus" → must collapse to a single record (no double count).
    // Different m.id so the only thing that could keep them apart is the agent.
    writeSqliteDb(dbPath(), [
      "CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);",
      `INSERT INTO message VALUES ('row-a', 'sess-1', ${lit(msg({ agent: "sisyphus" }))});`,
      `INSERT INTO message VALUES ('row-b', 'sess-2', ${lit(msg({ agent: "oh-my-codex:Sisyphus" }))});`,
    ]);

    const records = await opencodeReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.agent).toBe("Sisyphus");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. serve tolerates an unknown future flag before `--`.
// ═════════════════════════════════════════════════════════════════════════

describe("HIGH: serve unknown-flag tolerance", () => {
  beforeEach(() => runServeRuntimeMock.mockClear());

  it("an extra --future-flag before -- does NOT throw; the server invocation still reaches spawn", async () => {
    const savedExit = process.exit;
    let exitCode: number | undefined;
    // The serve command calls process.exit(code) on success; intercept it.
    (process as { exit: (code?: number) => never }).exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`__exit__:${code}`);
    }) as never;
    try {
      await runServe([
        "--connector",
        "demo",
        "--future-flag", // an unknown FUTURE flag — must be tolerated, not fatal
        "--scope",
        "user",
        "--",
        "my-server",
        "--server-arg",
      ]).catch((e: unknown) => {
        if (!(e instanceof Error) || !e.message.startsWith("__exit__:")) throw e;
      });
    } finally {
      process.exit = savedExit;
    }
    // Parsing tolerated the unknown flag and proceeded to spawn with the right args.
    expect(runServeRuntimeMock).toHaveBeenCalledTimes(1);
    const opts = runServeRuntimeMock.mock.calls[0]![0] as {
      connectorId: string;
      serverCommand: string;
      serverArgs: string[];
      installScope?: string;
    };
    expect(opts.connectorId).toBe("demo");
    expect(opts.serverCommand).toBe("my-server");
    expect(opts.serverArgs).toEqual(["--server-arg"]);
    expect(opts.installScope).toBe("user");
    expect(exitCode).toBe(0);
  });

  it("still fails clearly (non-zero, no throw, no spawn) when --connector is missing", async () => {
    const code = await runServe(["--future-flag", "--", "my-server"]);
    expect(code).toBeGreaterThan(0); // fail() returns a non-zero code, never throws
    expect(runServeRuntimeMock).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5. goose bare "YYYY-MM-DD HH:MM:SS" parsed as UTC.
// ═════════════════════════════════════════════════════════════════════════

describe("MEDIUM: goose parses bare timestamps as UTC", () => {
  const dbPath = (): string =>
    join(tmpHome, ".local", "share", "goose", "sessions", "sessions.db");

  const CREATE = `CREATE TABLE sessions(
    id TEXT PRIMARY KEY, model_config_json TEXT, provider_name TEXT, created_at TEXT,
    total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
    accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER,
    accumulated_output_tokens INTEGER);`;

  it("a bare 'YYYY-MM-DD HH:MM:SS' timestamp is UTC (matches Date.UTC, not local)", async () => {
    const modelCfg = JSON.stringify({ model_name: "claude-sonnet-4-5" });
    writeSqliteDb(dbPath(), [
      CREATE,
      `INSERT INTO sessions VALUES ('g-bare', ${lit(modelCfg)}, 'anthropic',
        '2026-04-14 16:18:53', 700, 400, 250, NULL, NULL, NULL);`,
    ]);

    const records = await gooseReader.read({});
    expect(records).toHaveLength(1);
    // Built from Date.UTC, NOT Date.parse (which V8 would treat as LOCAL time).
    expect(records[0]!.ts).toBe(Date.UTC(2026, 3, 14, 16, 18, 53));
  });

  it("a bare 'YYYY-MM-DD' date is UTC midnight", async () => {
    const modelCfg = JSON.stringify({ model_name: "claude-sonnet-4-5" });
    writeSqliteDb(dbPath(), [
      CREATE,
      `INSERT INTO sessions VALUES ('g-date', ${lit(modelCfg)}, 'anthropic',
        '2026-04-14', 700, 400, 250, NULL, NULL, NULL);`,
    ]);
    const records = await gooseReader.read({});
    expect(records[0]!.ts).toBe(Date.UTC(2026, 3, 14));
  });

  it("an RFC3339 timestamp with explicit Z still parses via the ISO fallback", async () => {
    const modelCfg = JSON.stringify({ model_name: "claude-sonnet-4-5" });
    writeSqliteDb(dbPath(), [
      CREATE,
      `INSERT INTO sessions VALUES ('g-iso', ${lit(modelCfg)}, 'anthropic',
        '2026-04-14T16:18:53Z', 700, 400, 250, NULL, NULL, NULL);`,
    ]);
    const records = await gooseReader.read({});
    expect(records[0]!.ts).toBe(Date.parse("2026-04-14T16:18:53Z"));
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 6. codex model-less token_count back-fill + flush-as-unknown WITH dedup key.
// ═════════════════════════════════════════════════════════════════════════

describe("MEDIUM: codex model-less token_count back-fill", () => {
  const sessDir = (): string => join(tmpHome, ".codex", "sessions", "2026", "01", "15");

  const tokenCount = (ts: string, total: Record<string, number>, last: Record<string, number>) => ({
    timestamp: ts,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
  });

  it("a model-less token_count row is BACK-FILLED with a later turn_context model + a dedup key", async () => {
    // The first token_count arrives BEFORE any model is known. A later
    // turn_context resolves the model and must back-fill it onto the buffered row.
    writeJsonl(sessDir(), "rollout-backfill.jsonl", [
      { type: "session_meta", payload: { type: "session_meta", model_provider: "openai" } },
      // token_count with NO model yet known.
      tokenCount(
        "2026-01-15T10:00:00Z",
        { input_tokens: 100, output_tokens: 30 },
        { input_tokens: 100, output_tokens: 30 },
      ),
      // A turn_context later resolves the model → back-fill the pending row.
      { type: "turn_context", payload: { type: "turn_context", model: "gpt-5-codex" } },
    ]);

    const records = await codexReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.modelId).toBe("gpt-5-codex"); // back-filled (not "unknown")
    expect(r.tokens.input).toBe(100);
    expect(r.tokens.output).toBe(30);
    // dedup key present because the row carried a real timestamp.
    expect(r.dedupKey).toBeDefined();
    expect(r.dedupKey).toContain("gpt-5-codex");
  });

  it("a model that never resolves flushes as 'unknown' but STILL with a dedup key", async () => {
    writeJsonl(sessDir(), "rollout-unknown.jsonl", [
      // No session_meta model, no turn_context, no payload/info model anywhere.
      tokenCount(
        "2026-01-15T11:00:00Z",
        { input_tokens: 42, output_tokens: 7 },
        { input_tokens: 42, output_tokens: 7 },
      ),
    ]);

    const records = await codexReader.read({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.modelId).toBe("unknown");
    expect(r.tokens.input).toBe(42);
    // Flushed-as-unknown rows are STILL keyed when the row had a real timestamp.
    expect(r.dedupKey).toBeDefined();
    expect(r.dedupKey).toContain(":unknown:");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 7. copilot-cli best-session-attr keeps the LAST equal-priority candidate.
// ═════════════════════════════════════════════════════════════════════════

describe("MEDIUM: copilot-cli best-session-attr — LAST equal-priority wins", () => {
  const telemetryDir = (): string => join(tmpHome, ".local", "share", "Copilot", "telemetry");

  it("session.id (later Session-priority key) beats gen_ai.conversation.id when both present", async () => {
    // SESSION_ATTRS lists gen_ai.conversation.id, copilot_chat.session_id,
    // copilot_chat.chat_session_id, session.id all at Session priority. Rust's
    // max_by_key keeps the LAST equal max → session.id must win.
    writeJsonl(telemetryDir(), "otel-last.jsonl", [
      {
        type: "span",
        traceId: "trace-1",
        spanId: "span-1",
        name: "chat gpt-5.4",
        endTime: [1775934264, 0],
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.response.model": "gpt-5.4",
          "gen_ai.conversation.id": "conversation-FIRST",
          "session.id": "session-LAST",
          "gen_ai.usage.input_tokens": 100,
          "gen_ai.usage.output_tokens": 30,
        },
      },
    ]);

    const records = await copilotReader.read({});
    expect(records).toHaveLength(1);
    expect(records[0]!.sessionId).toBe("session-LAST");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 8. CSV export carries the installScope / launchMethod columns.
// ═════════════════════════════════════════════════════════════════════════

describe("MEDIUM: CSV export includes scope columns", () => {
  function rec(over: Partial<ToolEventRecord> = {}): ToolEventRecord {
    return {
      id: "r1",
      ts: 1_700_000_000_000,
      connectorId: "acme",
      toolName: "q",
      scope: "call",
      hostPlatform: "claude-code",
      sessionId: "s1",
      inputTokens: 1,
      outputTokens: 2,
      confidenceSource: "tokenizer-exact",
      isError: false,
      ...over,
    };
  }

  it("the header lists installScope and launchMethod as the trailing columns", () => {
    const header = toCSV([]).split("\r\n")[0]!;
    expect(header.endsWith("installScope,launchMethod")).toBe(true);
  });

  it("a record with scope fields renders them in the trailing cells", () => {
    const csv = toCSV([rec({ installScope: "project", launchMethod: "binary" })]);
    const header = csv.split("\r\n")[0]!.split(",");
    const cells = csv.split("\r\n")[1]!.split(",");
    expect(cells[header.indexOf("installScope")]).toBe("project");
    expect(cells[header.indexOf("launchMethod")]).toBe("binary");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 9. cursor body-only command: a description with "-->" cannot break the header.
// ═════════════════════════════════════════════════════════════════════════

describe("LOW: cursor command description with '-->' does not break the comment", () => {
  function ctxFor(projectDir: string, description: string): InstallContext {
    const connector = defineConnector({
      id: "demo",
      commands: [{ name: "go", description, prompt: "RUN THE PROMPT BODY" }],
    });
    return {
      connector,
      scope: "project",
      projectDir,
      homeBinPath: "/home/u/.agent-connector/bin/agent-connector",
      dataRoot: join(projectDir, ".data"),
      dryRun: false,
    };
  }

  it("a '-->' inside the description is neutralized; the body stays out of the header comment", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ac-rf2-cur-"));
    const ctx = ctxFor(projectDir, "do the thing --> then leak");
    cursorAdapter.installCommands!(ctx);
    const file = join(projectDir, ".cursor", "commands", "go.md");
    const text = readFileSync(file, "utf8");

    // The raw comment-close must NOT appear (it would terminate the header early).
    expect(text).not.toContain("--> then leak");
    // Exactly one well-formed HTML comment header wrapping the description.
    expect(text.startsWith("<!-- ")).toBe(true);
    const firstClose = text.indexOf("-->");
    expect(firstClose).toBeGreaterThan(-1);
    // The prompt body lives AFTER the (single) comment close, not inside it.
    expect(text.indexOf("RUN THE PROMPT BODY")).toBeGreaterThan(firstClose);
    // And the description text survives (escaped) inside the header.
    expect(text).toContain("do the thing");

    rmSync(projectDir, { recursive: true, force: true });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 10. leaderboard scope:"unknown" — matches only when BOTH dimensions are absent.
// ═════════════════════════════════════════════════════════════════════════

describe("LOW: leaderboard scope:unknown requires BOTH dimensions absent", () => {
  class ArrayStore implements TelemetryStore {
    constructor(private readonly rows: ToolEventRecord[]) {}
    append(): void {}
    query(_f: QueryFilter): ToolEventRecord[] {
      return [...this.rows];
    }
    rollup(): never {
      throw new Error("unused");
    }
    close(): void {}
  }

  function rec(over: Partial<ToolEventRecord>): ToolEventRecord {
    return {
      id: over.id ?? "r",
      ts: 1,
      connectorId: over.connectorId ?? "c",
      toolName: "t",
      scope: "call",
      hostPlatform: "claude-code",
      sessionId: "s",
      inputTokens: 1,
      outputTokens: 1,
      confidenceSource: "tokenizer-exact",
      isError: false,
      ...over,
    };
  }

  it("a row with a known installScope but NO launchMethod is NOT 'unknown'", () => {
    const store = new ArrayStore([
      rec({ id: "a", connectorId: "both-absent" }), // truly unknown
      rec({ id: "b", connectorId: "scope-only", installScope: "user" }), // has installScope
      rec({ id: "c", connectorId: "launch-only", launchMethod: "npx" }), // has launchMethod
    ]);
    const rows = mcpLeaderboard({ store, scope: "unknown" });
    const ids = rows.map((r) => r.connectorId).sort();
    expect(ids).toEqual(["both-absent"]); // only the fully-absent row matches
  });
});
