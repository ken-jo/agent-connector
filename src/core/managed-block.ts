/**
 * core/managed-block — the marker-fenced MANAGED BLOCK engine behind the
 * `memory` content surface.
 *
 * Memory/rules files (AGENTS.md, CLAUDE.md, GEMINI.md, …) are SHARED,
 * user-authored files — unlike commands/skills/subagents, agent-connector does
 * not own them. Every write therefore goes through this one module, which
 * implements idempotent, hash-stamped, uninstall-reversible blocks:
 *
 *   <!-- agent-connector:begin <connectorId>/<name> hash=<sha256-12> -->
 *   <!-- Managed by agent-connector for "<connectorId>". Do not edit … -->
 *   …guidance…
 *   <!-- agent-connector:end <connectorId>/<name> -->
 *
 * Design rules (each grounded in surveyed prior art — ansible blockinfile,
 * conda init, OMC mergeClaudeMd, Ruler, doctoc):
 *   • UNIQUE marker per block: the blockId (`<connectorId>/<entryName>`) lives
 *     ON the marker line, so multiple connectors coexist in one file and each
 *     update path only ever touches its own pair (ansible's documented
 *     multi-block rule). The shared `agent-connector` namespace token lets
 *     doctor/uninstall enumerate every block with one scan.
 *   • `hash=` is the first 12 hex chars of sha256 over the NORMALIZED inner
 *     region (CRLF→LF + trim — stable under prettier/EOL converters): O(1)
 *     idempotence (unchanged → skip, no mtime/git churn) and tamper detection
 *     (actual inner hash ≠ recorded ⇒ the user edited inside the block ⇒ warn,
 *     never clobber without an explicit force).
 *   • IN-PLACE replacement (conda semantics): zero bytes outside the marker
 *     pair ever change — no move-to-top, no user blank-line reflow.
 *   • Line-anchored matching that explicitly tolerates `\r` line ends and a
 *     FENCE-AWARE scanner (markers quoted inside ``` / ~~~ code fences never
 *     match) — fixes the CRLF duplicate-block and quoted-marker classes.
 *   • First-begin / FIRST-end-after pairing (never last-end): a missing end
 *     marker must not swallow a sibling connector's block.
 *   • HTML-comment markers are CORRECT for CLAUDE.md: Claude Code strips HTML
 *     comments from CLAUDE.md before context injection (verified against docs
 *     and the 2.1.172 binary), so the markers and the do-not-edit notice are
 *     INVISIBLE to the model there while remaining fully parseable by us for
 *     sync/doctor/uninstall. On AGENTS.md hosts (which inline the whole file
 *     into the prompt) the short notice doubles as an in-prompt "do not edit"
 *     instruction to the host's own agent. A `commentStyle: "hash"` variant
 *     exists for future non-markdown targets (`#`-prefixed marker lines).
 *
 * The module also owns the per-connector MEMORY OWNERSHIP LEDGER
 * (`connectorDir(id)/memory-state.json`): the markers in the file remain the
 * source of truth for uninstall (a teammate's machine with no ledger still
 * uninstalls via the prefix scan); the ledger only adds the created-vs-modified
 * distinction (file deletion rights) and doctor diagnostics.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { backupsDir, connectorDir, ensureDir } from "./paths.js";

// ─────────────────────────────────────────────────────────────────────────
// Grammar constants (shared with defineConnector's content validation)
// ─────────────────────────────────────────────────────────────────────────

/** Literal begin token. Connector memory content MUST NOT contain it. */
export const MANAGED_BLOCK_BEGIN_TOKEN = "agent-connector:begin";
/** Literal end token. Connector memory content MUST NOT contain it. */
export const MANAGED_BLOCK_END_TOKEN = "agent-connector:end";

/** Hard cap on one memory entry's content (ConnectorConfigError above this). */
export const MEMORY_CONTENT_HARD_CAP_BYTES = 16 * 1024;
/**
 * Soft per-entry budget — exceeded → install-time `warn` ChangeRecord (memory
 * files are injected into EVERY prompt of EVERY session on the host; codex
 * additionally caps combined project docs at 32 KiB).
 */
export const MEMORY_CONTENT_SOFT_BUDGET_BYTES = 4 * 1024;

/** Marker comment style: HTML comments (default, all v1 markdown targets) or `#` lines. */
export type BlockCommentStyle = "html" | "hash";

// ─────────────────────────────────────────────────────────────────────────
// Hashing / rendering
// ─────────────────────────────────────────────────────────────────────────

/** CRLF/CR → LF + trim: the normalization both hashing sides use. */
function normalizeInner(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

/** First 12 hex chars of sha256 over the NORMALIZED inner region. */
export function hashBlockContent(inner: string): string {
  return createHash("sha256").update(normalizeInner(inner), "utf8").digest("hex").slice(0, 12);
}

/** The conda-style in-block warning, adapted for the LLM era (see header). */
function defaultNotice(connectorId: string): string {
  return (
    `Managed by agent-connector for "${connectorId}". Do not edit between these markers: ` +
    `\`agent-connector sync\` rewrites this block; ` +
    `\`agent-connector uninstall ${connectorId}\` removes it.`
  );
}

function beginLine(blockId: string, hash: string, style: BlockCommentStyle): string {
  return style === "hash"
    ? `# ${MANAGED_BLOCK_BEGIN_TOKEN} ${blockId} hash=${hash}`
    : `<!-- ${MANAGED_BLOCK_BEGIN_TOKEN} ${blockId} hash=${hash} -->`;
}

/** END line is a fixed exact string (no hash) so a content change never strands it. */
function endLine(blockId: string, style: BlockCommentStyle): string {
  return style === "hash"
    ? `# ${MANAGED_BLOCK_END_TOKEN} ${blockId}`
    : `<!-- ${MANAGED_BLOCK_END_TOKEN} ${blockId} -->`;
}

function noticeLine(notice: string, style: BlockCommentStyle): string {
  return style === "hash" ? `# ${notice}` : `<!-- ${notice} -->`;
}

export interface RenderBlockOptions {
  /** `<connectorId>/<entryName>` (or the reserved `_shared/<name>` bridge prefix). */
  blockId: string;
  /** Connector id named in the default do-not-edit notice line. */
  connectorId: string;
  /** The guidance payload (plain markdown; normalized + trimmed on emit). */
  content: string;
  /** Marker comment style; default "html". */
  commentStyle?: BlockCommentStyle;
  /** Override the default notice line TEXT (without comment delimiters). */
  notice?: string;
}

/**
 * Render the block as LOGICAL lines (no EOL chars). The recorded `hash=`
 * covers the full inner region (notice line + content) so install and scan
 * compare like for like.
 */
export function renderBlockLines(opts: RenderBlockOptions): string[] {
  const style = opts.commentStyle ?? "html";
  const inner = [
    noticeLine(opts.notice ?? defaultNotice(opts.connectorId), style),
    ...normalizeInner(opts.content).split("\n"),
  ];
  const hash = hashBlockContent(inner.join("\n"));
  return [beginLine(opts.blockId, hash, style), ...inner, endLine(opts.blockId, style)];
}

// ─────────────────────────────────────────────────────────────────────────
// Scanning (fence-aware, line-anchored, CRLF-tolerant)
// ─────────────────────────────────────────────────────────────────────────

// Both comment styles are RECOGNIZED in one pass (a file may legitimately mix
// styles only across rewrites; emission always uses the requested style).
const BEGIN_RE =
  /^(?:<!--\s+agent-connector:begin\s+(\S+)\s+hash=([0-9a-f]{12})\s+-->|#\s+agent-connector:begin\s+(\S+)\s+hash=([0-9a-f]{12}))\s*$/;
const END_RE = /^(?:<!--\s+agent-connector:end\s+(\S+)\s+-->|#\s+agent-connector:end\s+(\S+))\s*$/;

interface MarkerEvent {
  kind: "begin" | "end";
  blockId: string;
  /** Recorded hash (begin markers only). */
  hash?: string;
  /** Line index into the logical-lines array. */
  index: number;
}

/** Strip ONE trailing `\r` — `raw.split("\n")` leaves it on CRLF files. */
function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Scan logical lines for marker events, tracking ``` / ~~~ fence state so a
 * marker QUOTED inside a fenced code block never matches (the OMC class of
 * false positives, eliminated rather than just reduced).
 */
function scanMarkers(logical: string[]): MarkerEvent[] {
  const events: MarkerEvent[] = [];
  let fence: { char: string; len: number } | null = null;
  for (let i = 0; i < logical.length; i++) {
    const line = logical[i]!;
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = { char: open[1]![0]!, len: open[1]!.length };
      continue;
    }
    const b = line.match(BEGIN_RE);
    if (b) {
      events.push({ kind: "begin", blockId: (b[1] ?? b[3])!, hash: (b[2] ?? b[4])!, index: i });
      continue;
    }
    const e = line.match(END_RE);
    if (e) events.push({ kind: "end", blockId: (e[1] ?? e[2])!, index: i });
  }
  return events;
}

/**
 * Logical lines of `raw` that sit OUTSIDE ``` / ~~~ code fences — for host
 * probes that must ignore quoted examples (e.g. the claude-code `@AGENTS.md`
 * import detection). Fence lines themselves are excluded.
 */
export function linesOutsideFences(raw: string): string[] {
  const body = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const logical = body.split("\n").map(stripCr);
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of logical) {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = { char: open[1]![0]!, len: open[1]!.length };
      continue;
    }
    out.push(line);
  }
  return out;
}

interface BlockPair {
  blockId: string;
  begin: MarkerEvent;
  end: MarkerEvent;
}

/**
 * Pair markers per blockId: first begin, then the FIRST end at-or-after it.
 * A nested begin for the SAME id (inside an open pair) is treated as inner
 * content; unpaired markers are returned as strays. Per-id state means a
 * missing end for connector A can never swallow connector B's block.
 */
function pairMarkers(events: MarkerEvent[]): { pairs: BlockPair[]; strays: MarkerEvent[] } {
  const open = new Map<string, MarkerEvent>();
  const pairs: BlockPair[] = [];
  const strays: MarkerEvent[] = [];
  for (const ev of events) {
    if (ev.kind === "begin") {
      if (!open.has(ev.blockId)) open.set(ev.blockId, ev);
      // else: a begin inside an open pair — inner content / abuse; the hash
      // check will flag the pair as drifted rather than guessing boundaries.
    } else {
      const b = open.get(ev.blockId);
      if (b) {
        pairs.push({ blockId: ev.blockId, begin: b, end: ev });
        open.delete(ev.blockId);
      } else {
        strays.push(ev);
      }
    }
  }
  for (const b of open.values()) strays.push(b);
  return { pairs, strays };
}

/** One discovered block (for doctor / refcount / uninstall enumeration). */
export interface ManagedBlockInfo {
  blockId: string;
  /** The hash recorded on the begin marker line. */
  recordedHash: string;
  /** Hash of the actual normalized inner region as found on disk. */
  actualHash: string;
  /** True when recordedHash ≠ actualHash — the user edited inside the block. */
  drifted: boolean;
  beginLine: number;
  endLine: number;
}

/** Enumerate every complete agent-connector block in `raw` (namespace scan). */
export function listManagedBlocks(raw: string): ManagedBlockInfo[] {
  const body = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const logical = body.split("\n").map(stripCr);
  const { pairs } = pairMarkers(scanMarkers(logical));
  return pairs.map((p) => {
    const inner = logical.slice(p.begin.index + 1, p.end.index).join("\n");
    const actualHash = hashBlockContent(inner);
    const recordedHash = p.begin.hash ?? "";
    return {
      blockId: p.blockId,
      recordedHash,
      actualHash,
      drifted: recordedHash !== actualHash,
      beginLine: p.begin.index,
      endLine: p.end.index,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Pure text upsert / removal
// ─────────────────────────────────────────────────────────────────────────

export interface UpsertBlockOptions extends RenderBlockOptions {
  /** Overwrite a USER-EDITED (drifted) block. Default false → warn + leave intact. */
  force?: boolean;
}

export interface BlockTextResult {
  /** Resulting full text (=== input when nothing changed). */
  text: string;
  action: "create" | "update" | "skip" | "warn";
  detail: string;
  changed: boolean;
  /**
   * True when the rewrite was DESTRUCTIVE-ADJACENT (force-overwrote a drifted
   * block, collapsed duplicate pairs, or stripped stray markers) — the file
   * wrapper writes a timestamped backup before persisting such a change.
   */
  recovered: boolean;
  /** Hash of the (new) rendered inner region — recorded in the ledger. */
  hash: string;
}

/** Detect the file's dominant EOL; new/replaced lines are emitted with it. */
function detectEol(body: string): "\n" | "\r\n" {
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const total = (body.match(/\n/g) ?? []).length;
  return crlf > 0 && crlf >= total - crlf ? "\r\n" : "\n";
}

/** Add `\r` to logical lines when the file is CRLF (joined with "\n" later). */
function withEol(lines: string[], eol: "\n" | "\r\n"): string[] {
  return eol === "\r\n" ? lines.map((l) => `${l}\r`) : lines;
}

/**
 * Strip trailing newline(s) + whitespace-only line tails WITHOUT touching
 * trailing spaces on the last content line (bytes outside our block).
 */
function trimTrailingBlank(body: string): string {
  let out = body;
  for (;;) {
    const m = out.match(/\r?\n[ \t]*$/);
    if (!m) return out;
    out = out.slice(0, out.length - m[0].length);
  }
}

/** Append the rendered block at EOF with exactly ONE blank separator line. */
function appendBlock(body: string, blockLines: string[], eol: "\n" | "\r\n"): string {
  const blockText = blockLines.join(eol) + eol;
  if (body.trim() === "") return blockText;
  return trimTrailingBlank(body) + eol + eol + blockText;
}

/**
 * Idempotent upsert of one managed block into `raw` (pure; no I/O).
 * See the module header for the full algorithm contract.
 */
export function upsertBlockInText(raw: string, opts: UpsertBlockOptions): BlockTextResult {
  const bom = raw.startsWith("\uFEFF");
  const body = bom ? raw.slice(1) : raw;
  const eol = detectEol(body);
  const lines = body.split("\n"); // elements keep a trailing "\r" on CRLF files
  const logical = lines.map(stripCr);

  const events = scanMarkers(logical).filter((e) => e.blockId === opts.blockId);
  const { pairs, strays } = pairMarkers(events);

  const newLines = renderBlockLines(opts);
  const newHash = hashBlockContent(newLines.slice(1, -1).join("\n"));
  const finish = (text: string, r: Omit<BlockTextResult, "text" | "hash">): BlockTextResult => ({
    text: bom ? `\uFEFF${text}` : text,
    hash: newHash,
    ...r,
  });

  if (pairs.length > 0) {
    const { begin, end } = pairs[0]!;
    const recorded = begin.hash ?? "";
    const actualHash = hashBlockContent(logical.slice(begin.index + 1, end.index).join("\n"));
    const drifted = actualHash !== recorded;

    if (drifted && !opts.force) {
      return finish(body, {
        action: "warn",
        detail:
          `block ${opts.blockId} was edited inside the markers ` +
          `(recorded hash ${recorded}, found ${actualHash}); left untouched — ` +
          `re-run with --force to overwrite the in-block edits`,
        changed: false,
        recovered: false,
      });
    }

    const duplicates = pairs.slice(1);
    const needsWrite =
      drifted || recorded !== newHash || duplicates.length > 0 || strays.length > 0;
    if (!needsWrite) {
      return finish(body, {
        action: "skip",
        detail: `block ${opts.blockId} already up to date (hash ${newHash})`,
        changed: false,
        recovered: false,
      });
    }

    // Build the deletion set: the canonical pair region (replaced in place),
    // duplicate pairs (+ ONE adjacent blank line each), and stray marker LINES.
    const del = new Set<number>();
    for (let i = begin.index; i <= end.index; i++) del.add(i);
    for (const dup of duplicates) {
      for (let i = dup.begin.index; i <= dup.end.index; i++) del.add(i);
      reclaimBlankLine(logical, dup.begin.index, dup.end.index, del, lines.length);
    }
    for (const s of strays) del.add(s.index);

    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i === begin.index) out.push(...withEol(newLines, eol));
      if (!del.has(i)) out.push(lines[i]!);
    }
    const notes: string[] = [];
    if (drifted) notes.push("in-block edits overwritten (--force; backup taken)");
    if (duplicates.length > 0) notes.push(`${duplicates.length} duplicate pair(s) collapsed`);
    if (strays.length > 0) notes.push(`${strays.length} stray marker line(s) removed`);
    return finish(out.join("\n"), {
      action: "update",
      detail:
        `block ${opts.blockId} updated (hash ${recorded || "?"} → ${newHash})` +
        (notes.length > 0 ? `; ${notes.join("; ")}` : ""),
      changed: true,
      recovered: drifted || duplicates.length > 0 || strays.length > 0,
    });
  }

  if (strays.length > 0) {
    // Corruption recovery: strip ONLY the stray marker line(s) (never the text
    // between guessed boundaries), then proceed as not-found.
    const del = new Set(strays.map((s) => s.index));
    const cleaned = lines.filter((_, i) => !del.has(i)).join("\n");
    return finish(appendBlock(cleaned, newLines, eol), {
      action: "create",
      detail:
        `block ${opts.blockId} appended after recovery: ${strays.length} stray ` +
        `marker line(s) removed (backup taken)`,
      changed: true,
      recovered: true,
    });
  }

  // Not found → append at EOF (one blank separator; whole file when empty).
  return finish(appendBlock(body, newLines, eol), {
    action: "create",
    detail: `block ${opts.blockId} appended (hash ${newHash})`,
    changed: true,
    recovered: false,
  });
}

/**
 * Mark ONE blank line adjacent to a removed begin..end region for deletion
 * (prefer the line before; never the post-final-newline "" sentinel).
 */
function reclaimBlankLine(
  logical: string[],
  beginIdx: number,
  endIdx: number,
  del: Set<number>,
  lineCount: number,
): void {
  const before = beginIdx - 1;
  if (before >= 0 && !del.has(before) && logical[before]!.trim() === "") {
    del.add(before);
    return;
  }
  const after = endIdx + 1;
  // The final "" element of split("\n") on a newline-terminated file is the
  // trailing-newline sentinel, not a blank line — leave it alone.
  const isSentinel = after === lineCount - 1 && logical[after] === "";
  if (after < lineCount && !isSentinel && !del.has(after) && logical[after]!.trim() === "") {
    del.add(after);
  }
}

export interface RemoveBlocksOptions {
  /** Remove the block with EXACTLY this id… */
  blockId?: string;
  /** …or every block whose id starts with this prefix (e.g. `<connectorId>/`). */
  blockIdPrefix?: string;
}

export interface RemoveRecord {
  blockId: string;
  action: "remove" | "warn";
  detail: string;
}

export interface RemoveBlocksResult {
  text: string;
  changed: boolean;
  records: RemoveRecord[];
  /** True when the remaining text is whitespace-only (file-deletion candidate). */
  fileNowEmpty: boolean;
  /** True when a drifted block was removed or stray markers were stripped. */
  recovered: boolean;
}

/**
 * Remove every matching managed block (begin..end inclusive + at most ONE
 * adjacent blank separator line — no blank-line accumulation across cycles).
 * Drifted blocks are removed WITH a warn (uninstall intent is explicit; the
 * file wrapper backs the file up first). Stray matching markers are stripped
 * line-only with a warn. Pure; no I/O.
 */
export function removeBlocksFromText(raw: string, match: RemoveBlocksOptions): RemoveBlocksResult {
  const bom = raw.startsWith("\uFEFF");
  const body = bom ? raw.slice(1) : raw;
  const lines = body.split("\n");
  const logical = lines.map(stripCr);

  const matches = (id: string): boolean =>
    (match.blockId !== undefined && id === match.blockId) ||
    (match.blockIdPrefix !== undefined && id.startsWith(match.blockIdPrefix));

  const { pairs, strays } = pairMarkers(scanMarkers(logical));
  const targetPairs = pairs.filter((p) => matches(p.blockId));
  const targetStrays = strays.filter((s) => matches(s.blockId));

  if (targetPairs.length === 0 && targetStrays.length === 0) {
    return { text: raw, changed: false, records: [], fileNowEmpty: false, recovered: false };
  }

  const del = new Set<number>();
  const records: RemoveRecord[] = [];
  let recovered = false;

  for (const p of targetPairs) {
    const recorded = p.begin.hash ?? "";
    const actualHash = hashBlockContent(
      logical.slice(p.begin.index + 1, p.end.index).join("\n"),
    );
    for (let i = p.begin.index; i <= p.end.index; i++) del.add(i);
    reclaimBlankLine(logical, p.begin.index, p.end.index, del, lines.length);
    if (actualHash !== recorded) {
      recovered = true;
      records.push({
        blockId: p.blockId,
        action: "warn",
        detail:
          `block ${p.blockId} had in-block edits (recorded hash ${recorded}, found ` +
          `${actualHash}); removed anyway (backup taken)`,
      });
    }
    records.push({ blockId: p.blockId, action: "remove", detail: `block ${p.blockId} removed` });
  }
  for (const s of targetStrays) {
    del.add(s.index);
    recovered = true;
    records.push({
      blockId: s.blockId,
      action: "warn",
      detail: `stray ${s.kind} marker for ${s.blockId} removed (marker line only)`,
    });
  }

  const text = lines.filter((_, i) => !del.has(i)).join("\n");
  return {
    text: bom ? `\uFEFF${text}` : text,
    changed: true,
    records,
    fileNowEmpty: text.trim() === "",
    recovered,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// File-level wrappers (atomic write, backups, dry-run)
// ─────────────────────────────────────────────────────────────────────────

export interface BlockFileChange {
  action: "create" | "update" | "skip" | "warn" | "remove";
  path: string;
  detail: string;
  /** True when the FILE did not exist and this upsert created it (ledger fact). */
  createdFile: boolean;
  /** Set when a pre-mutation backup was written (destructive/recovery paths only). */
  backupPath?: string;
  /** Hash of the rendered inner region (ledger / doctor). */
  hash: string;
}

/** Timestamped copy into backupsDir(); best-effort (null on failure). */
function backupFile(path: string): string | null {
  try {
    ensureDir(backupsDir());
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(backupsDir(), `memory-${stamp}-${basename(path)}`);
    copyFileSync(path, dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * Atomic write: temp file in the SAME directory + rename, preserving the
 * destination's mode. Shrinks (does not eliminate) the read-modify-write race
 * with hosts that append to memory files mid-session (Claude `#` quick-memory).
 */
function atomicWriteFile(path: string, text: string): void {
  const dir = dirname(path);
  ensureDir(dir);
  const tmp = join(dir, `.${basename(path)}.ac-tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, text, "utf8");
    try {
      chmodSync(tmp, statSync(path).mode);
    } catch {
      /* destination absent — default mode is fine */
    }
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Upsert one managed block into the file at `path` (created when absent).
 * Re-reads immediately before computing+writing; honors dryRun (the action is
 * computed and reported, nothing is written).
 */
export function upsertManagedBlockFile(
  path: string,
  opts: UpsertBlockOptions & { dryRun: boolean },
): BlockFileChange {
  let raw: string | null = null;
  if (existsSync(path)) {
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return {
        action: "warn",
        path,
        detail: `cannot read ${path}; memory block ${opts.blockId} not written`,
        createdFile: false,
        hash: "",
      };
    }
  }

  if (raw === null) {
    const lines = renderBlockLines(opts);
    const hash = hashBlockContent(lines.slice(1, -1).join("\n"));
    if (!opts.dryRun) atomicWriteFile(path, `${lines.join("\n")}\n`);
    return {
      action: "create",
      path,
      detail: `created ${basename(path)} with block ${opts.blockId} (hash ${hash})`,
      createdFile: true,
      hash,
    };
  }

  const res = upsertBlockInText(raw, opts);
  const change: BlockFileChange = {
    action: res.action,
    path,
    detail: res.detail,
    createdFile: false,
    hash: res.hash,
  };
  if (res.changed && !opts.dryRun) {
    if (res.recovered) {
      const backup = backupFile(path);
      if (backup) change.backupPath = backup;
    }
    atomicWriteFile(path, res.text);
  }
  return change;
}

/**
 * Remove every matching managed block from the file at `path`. Missing file or
 * no matching markers → a single idempotent "skip". When the remaining content
 * is whitespace-only AND `deleteFileIfCreated` is true (the ledger recorded
 * that agent-connector created this file), the file itself is deleted (Ruler
 * revert semantics: delete only what we created).
 */
export function removeManagedBlocksFile(
  path: string,
  match: RemoveBlocksOptions,
  opts: { dryRun: boolean; deleteFileIfCreated?: boolean },
): BlockFileChange[] {
  if (!existsSync(path)) {
    return [
      {
        action: "skip",
        path,
        detail: `${basename(path)} absent; nothing to remove`,
        createdFile: false,
        hash: "",
      },
    ];
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [
      {
        action: "warn",
        path,
        detail: `cannot read ${path}; managed blocks left in place`,
        createdFile: false,
        hash: "",
      },
    ];
  }

  const res = removeBlocksFromText(raw, match);
  if (!res.changed) {
    return [
      {
        action: "skip",
        path,
        detail: `no agent-connector blocks matching ${match.blockId ?? match.blockIdPrefix ?? "?"} in ${basename(path)}`,
        createdFile: false,
        hash: "",
      },
    ];
  }

  const changes: BlockFileChange[] = [];
  let backupPath: string | undefined;
  if (!opts.dryRun) {
    if (res.recovered) backupPath = backupFile(path) ?? undefined;
    if (res.fileNowEmpty && opts.deleteFileIfCreated) {
      rmSync(path, { force: true });
    } else {
      atomicWriteFile(path, res.text);
    }
  }
  for (const r of res.records) {
    changes.push({
      action: r.action,
      path,
      detail: r.detail,
      createdFile: false,
      hash: "",
      ...(backupPath && r.action === "warn" ? { backupPath } : {}),
    });
  }
  if (res.fileNowEmpty && opts.deleteFileIfCreated) {
    changes.push({
      action: "remove",
      path,
      detail: `${basename(path)} deleted (agent-connector created it; only whitespace remained)`,
      createdFile: false,
      hash: "",
    });
  }
  return changes;
}

// ─────────────────────────────────────────────────────────────────────────
// Memory ownership ledger — connectorDir(id)/memory-state.json
// ─────────────────────────────────────────────────────────────────────────

export interface MemoryLedgerTarget {
  platform: string;
  scope: string;
  path: string;
  blockId: string;
  /** True when agent-connector CREATED the file (grants deletion rights). */
  createdFile: boolean;
  /** Inner-region hash we last wrote (doctor drift detection). */
  hash: string;
}

export interface MemoryLedger {
  version: 1;
  targets: MemoryLedgerTarget[];
}

export function memoryLedgerPath(connectorId: string): string {
  return join(connectorDir(connectorId), "memory-state.json");
}

export function loadMemoryLedger(connectorId: string): MemoryLedger {
  const p = memoryLedgerPath(connectorId);
  if (!existsSync(p)) return { version: 1, targets: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as MemoryLedger;
    if (parsed && Array.isArray(parsed.targets)) return { version: 1, targets: parsed.targets };
  } catch {
    /* corrupt → fresh ledger; the markers remain the source of truth */
  }
  return { version: 1, targets: [] };
}

/** Persist the ledger; an EMPTY ledger deletes the file (no orphan state). */
export function saveMemoryLedger(connectorId: string, ledger: MemoryLedger): void {
  const p = memoryLedgerPath(connectorId);
  if (ledger.targets.length === 0) {
    rmSync(p, { force: true });
    return;
  }
  ensureDir(dirname(p));
  writeFileSync(p, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

/** True when the connector has any recorded memory targets (uninstall guard). */
export function hasMemoryLedger(connectorId: string): boolean {
  return loadMemoryLedger(connectorId).targets.length > 0;
}

/**
 * Upsert one ledger row (keyed by platform+scope+path+blockId). The
 * `createdFile` fact is STICKY: once we created the file, deletion rights
 * survive later syncs that found it present.
 */
export function recordMemoryTarget(ledger: MemoryLedger, t: MemoryLedgerTarget): void {
  const i = ledger.targets.findIndex(
    (x) =>
      x.platform === t.platform &&
      x.scope === t.scope &&
      x.path === t.path &&
      x.blockId === t.blockId,
  );
  if (i >= 0) {
    ledger.targets[i] = { ...t, createdFile: ledger.targets[i]!.createdFile || t.createdFile };
  } else {
    ledger.targets.push(t);
  }
}
