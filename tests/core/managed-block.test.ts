/**
 * core/managed-block — the marker-fenced managed-block engine matrix.
 *
 * Pure-text engine cases (upsertBlockInText / removeBlocksFromText /
 * listManagedBlocks): idempotent re-upsert (hash skip), in-place replacement
 * preserving every outside byte AND block position, CRLF round-trips with no
 * duplicate blocks, EOL-conversion NOT flagged as drift (normalized hashing),
 * UTF-8 BOM preservation, fence-quoted markers ignored, lone-marker recovery
 * (stray line strip only), duplicate-pair collapse, nested/foreign marker
 * abuse, drift detection (warn, no overwrite without force), EOF append with
 * exactly one blank separator, removal reclaiming exactly one blank line, and
 * multi-connector coexistence.
 *
 * File-wrapper cases (upsertManagedBlockFile / removeManagedBlocksFile):
 * create-on-missing, dry-run no-write, created-file deletion rights, and the
 * ownership ledger round-trip.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hashBlockContent,
  hasMemoryLedger,
  linesOutsideFences,
  listManagedBlocks,
  loadMemoryLedger,
  recordMemoryTarget,
  removeBlocksFromText,
  removeManagedBlocksFile,
  renderBlockLines,
  saveMemoryLedger,
  upsertBlockInText,
  upsertManagedBlockFile,
} from "../../src/core/managed-block.js";

const ID_A = "acme-db/memory";
const ID_B = "other-tool/memory";

function upsert(raw: string, content: string, extra: Record<string, unknown> = {}) {
  return upsertBlockInText(raw, {
    blockId: ID_A,
    connectorId: "acme-db",
    content,
    ...extra,
  });
}

let savedDataDir: string | undefined;

beforeEach(() => {
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  process.env.AGENT_CONNECTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "ac-mblock-data-"));
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.AGENT_CONNECTOR_DATA_DIR;
  else process.env.AGENT_CONNECTOR_DATA_DIR = savedDataDir;
});

describe("managed-block: hashing", () => {
  it("normalizes CRLF→LF and trims before hashing", () => {
    const lf = hashBlockContent("alpha\nbeta");
    expect(hashBlockContent("alpha\r\nbeta")).toBe(lf);
    expect(hashBlockContent("\n\nalpha\nbeta\n\n")).toBe(lf);
    expect(hashBlockContent("alpha\nbeta!")).not.toBe(lf);
    expect(lf).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("managed-block: upsert into text", () => {
  it("creates the block as the whole content of an empty file", () => {
    const res = upsert("", "Use the acme tools.");
    expect(res.action).toBe("create");
    expect(res.changed).toBe(true);
    const lines = res.text.split("\n");
    expect(lines[0]).toMatch(/^<!-- agent-connector:begin acme-db\/memory hash=[0-9a-f]{12} -->$/);
    expect(lines[1]).toContain('Managed by agent-connector for "acme-db"');
    expect(lines[2]).toBe("Use the acme tools.");
    expect(lines[3]).toBe("<!-- agent-connector:end acme-db/memory -->");
    expect(res.text.endsWith("\n")).toBe(true);
  });

  it("appends at EOF with exactly ONE blank separator line", () => {
    const res = upsert("# My rules\nBe kind.\n", "Use acme.");
    expect(res.text.startsWith("# My rules\nBe kind.\n\n<!-- agent-connector:begin ")).toBe(true);
    // No double blank line, and existing trailing newlines are normalized to one separator.
    const res2 = upsert("# My rules\n\n\n\n", "Use acme.");
    expect(res2.text.startsWith("# My rules\n\n<!-- agent-connector:begin ")).toBe(true);
    // A file with no trailing newline gains one before the separator.
    const res3 = upsert("# My rules", "Use acme.");
    expect(res3.text.startsWith("# My rules\n\n<!-- agent-connector:begin ")).toBe(true);
  });

  it("is idempotent: identical content → skip, byte-identical text", () => {
    const first = upsert("# Rules\n", "Use acme.");
    const second = upsert(first.text, "Use acme.");
    expect(second.action).toBe("skip");
    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
  });

  it("replaces the block IN PLACE — outside bytes and position untouched", () => {
    const before = "# Top\n\nuser line  \n";
    const after = "\n# Bottom — user's odd  spacing\n\n\nlast\n";
    const v1 = upsert(before, "v1 guidance");
    const positioned = v1.text + after.slice(1); // block sits mid-file once we append more below
    const withTail = `${v1.text}${after}`;
    const v2 = upsert(withTail, "v2 guidance");
    expect(v2.action).toBe("update");
    expect(v2.text.startsWith(before)).toBe(true);
    expect(v2.text.endsWith(after)).toBe(true);
    expect(v2.text).toContain("v2 guidance");
    expect(v2.text).not.toContain("v1 guidance");
    // Exactly one block remains.
    expect(listManagedBlocks(v2.text)).toHaveLength(1);
    expect(positioned).toContain("# Top"); // sanity
  });

  it("CRLF file: block found on re-upsert (no duplicate) and emitted with CRLF", () => {
    const res = upsert("# Win rules\r\nline two\r\n", "Use acme.");
    expect(res.action).toBe("create");
    expect(res.text).toContain("\r\n<!-- agent-connector:begin acme-db/memory");
    expect(res.text).toContain("acme-db/memory -->\r\n");
    const again = upsert(res.text, "Use acme.");
    expect(again.action).toBe("skip");
    expect(listManagedBlocks(again.text)).toHaveLength(1);
    const updated = upsert(res.text, "New guidance.");
    expect(updated.action).toBe("update");
    expect(listManagedBlocks(updated.text)).toHaveLength(1);
    // The replaced block keeps the file's CRLF EOLs.
    expect(updated.text).toContain("New guidance.\r\n");
  });

  it("EOL conversion of the whole file is NOT drift (normalized hashing)", () => {
    const lf = upsert("# Rules\n", "alpha\nbeta");
    const crlfConverted = lf.text.replace(/\n/g, "\r\n");
    const res = upsert(crlfConverted, "alpha\nbeta");
    expect(res.action).toBe("skip");
  });

  it("preserves a UTF-8 BOM and still finds the block behind it", () => {
    const res = upsert("\uFEFF# BOM file\n", "Use acme.");
    expect(res.text.startsWith("\uFEFF# BOM file\n")).toBe(true);
    const again = upsert(res.text, "Use acme.");
    expect(again.action).toBe("skip");
    expect(again.text.startsWith("\uFEFF")).toBe(true);
  });

  it("ignores marker text quoted inside fenced code blocks", () => {
    const doc =
      "# How AC markers look\n\n```md\n<!-- agent-connector:begin acme-db/memory hash=000000000000 -->\nfake\n<!-- agent-connector:end acme-db/memory -->\n```\n";
    const res = upsert(doc, "Real guidance.");
    expect(res.action).toBe("create"); // the quoted pair was NOT treated as the block
    expect(res.text.startsWith(doc.slice(0, doc.length - 1))).toBe(true);
    expect(listManagedBlocks(res.text)).toHaveLength(1);
    // And the fence content is untouched.
    expect(res.text).toContain("hash=000000000000");
  });

  it("recovers from a lone begin marker: strips the stray LINE only, then appends", () => {
    const doc =
      "# Rules\n<!-- agent-connector:begin acme-db/memory hash=abcdefabcdef -->\nuser text that must survive\n";
    const res = upsert(doc, "Fresh block.");
    expect(res.action).toBe("create");
    expect(res.recovered).toBe(true);
    expect(res.text).toContain("user text that must survive");
    expect(res.text).not.toContain("hash=abcdefabcdef");
    expect(listManagedBlocks(res.text)).toHaveLength(1);
  });

  it("recovers from a lone end marker the same way", () => {
    const doc = "# Rules\n<!-- agent-connector:end acme-db/memory -->\nkeep me\n";
    const res = upsert(doc, "Fresh block.");
    expect(res.action).toBe("create");
    expect(res.recovered).toBe(true);
    expect(res.text).toContain("keep me");
    expect(listManagedBlocks(res.text)).toHaveLength(1);
  });

  it("collapses duplicate pairs for the same blockId into one", () => {
    const one = upsert("", "Same.");
    const dup = `${one.text}\n${one.text}`;
    const res = upsert(dup, "Same.");
    expect(res.action).toBe("update");
    expect(res.recovered).toBe(true);
    expect(listManagedBlocks(res.text)).toHaveLength(1);
  });

  it("a missing end for connector A never swallows connector B's block", () => {
    const b = upsertBlockInText("", {
      blockId: ID_B,
      connectorId: "other-tool",
      content: "B guidance.",
    });
    // A's stray begin sits above B's complete block.
    const doc = `<!-- agent-connector:begin acme-db/memory hash=abcdefabcdef -->\n\n${b.text}`;
    const res = upsert(doc, "A guidance.");
    expect(res.recovered).toBe(true);
    expect(res.text).toContain("B guidance.");
    const blocks = listManagedBlocks(res.text);
    expect(blocks.map((x) => x.blockId).sort()).toEqual([ID_A, ID_B]);
    expect(blocks.find((x) => x.blockId === ID_B)?.drifted).toBe(false);
  });

  it("DRIFT: user edits inside the block → warn, text untouched, no overwrite", () => {
    const v1 = upsert("# Rules\n", "Original.");
    const edited = v1.text.replace("Original.", "User's own edit.");
    const res = upsert(edited, "Original.");
    expect(res.action).toBe("warn");
    expect(res.changed).toBe(false);
    expect(res.text).toBe(edited);
    expect(res.detail).toContain("edited inside the markers");
    expect(res.detail).toContain("--force");
  });

  it("DRIFT + force: overwrites and flags the change as recovered (backup-worthy)", () => {
    const v1 = upsert("# Rules\n", "Original.");
    const edited = v1.text.replace("Original.", "User's own edit.");
    const res = upsert(edited, "Original.", { force: true });
    expect(res.action).toBe("update");
    expect(res.recovered).toBe(true);
    expect(res.text).toContain("Original.");
    expect(res.text).not.toContain("User's own edit.");
  });

  it("renders hash-style markers and round-trips them", () => {
    const res = upsertBlockInText("", {
      blockId: ID_A,
      connectorId: "acme-db",
      content: "Plain text guidance.",
      commentStyle: "hash",
    });
    expect(res.text).toMatch(/^# agent-connector:begin acme-db\/memory hash=[0-9a-f]{12}\n/);
    expect(res.text).toContain("\n# agent-connector:end acme-db/memory\n");
    expect(upsertBlockInText(res.text, {
      blockId: ID_A,
      connectorId: "acme-db",
      content: "Plain text guidance.",
      commentStyle: "hash",
    }).action).toBe("skip");
  });
});

describe("managed-block: removal", () => {
  it("removes the block plus exactly ONE adjacent blank separator line", () => {
    const original = "# My rules\nBe kind.\n";
    const installed = upsert(original, "Use acme.");
    const removed = removeBlocksFromText(installed.text, { blockId: ID_A });
    expect(removed.changed).toBe(true);
    expect(removed.text).toBe(original); // byte-identical round trip
    expect(removed.records.map((r) => r.action)).toEqual(["remove"]);
  });

  it("repeated install/uninstall cycles do not bloat the file", () => {
    let text = "# My rules\n";
    for (let i = 0; i < 3; i++) {
      text = upsert(text, "Use acme.").text;
      text = removeBlocksFromText(text, { blockId: ID_A }).text;
    }
    expect(text).toBe("# My rules\n");
  });

  it("no matching markers → changed=false, zero records (idempotent skip upstream)", () => {
    const res = removeBlocksFromText("# nothing here\n", { blockIdPrefix: "acme-db/" });
    expect(res.changed).toBe(false);
    expect(res.records).toHaveLength(0);
  });

  it("multi-connector coexistence: removing A leaves B byte-identical", () => {
    const base = "# Shared AGENTS.md\n";
    const withA = upsert(base, "A guidance.");
    const withBoth = upsertBlockInText(withA.text, {
      blockId: ID_B,
      connectorId: "other-tool",
      content: "B guidance.",
    });
    const removedA = removeBlocksFromText(withBoth.text, { blockIdPrefix: "acme-db/" });
    // Exactly what installing B alone over the base would have produced.
    const onlyB = upsertBlockInText(base, {
      blockId: ID_B,
      connectorId: "other-tool",
      content: "B guidance.",
    });
    expect(removedA.text).toBe(onlyB.text);
  });

  it("prefix removal reclaims every entry under the connector namespace", () => {
    let text = upsert("# base\n", "entry one").text;
    text = upsertBlockInText(text, {
      blockId: "acme-db/style",
      connectorId: "acme-db",
      content: "entry two",
    }).text;
    const res = removeBlocksFromText(text, { blockIdPrefix: "acme-db/" });
    expect(res.records.filter((r) => r.action === "remove")).toHaveLength(2);
    expect(res.text).toBe("# base\n");
  });

  it("drifted block is still removed at uninstall, with a warn", () => {
    const installed = upsert("# base\n", "Original.");
    const edited = installed.text.replace("Original.", "Edited.");
    const res = removeBlocksFromText(edited, { blockIdPrefix: "acme-db/" });
    expect(res.recovered).toBe(true);
    expect(res.records.some((r) => r.action === "warn")).toBe(true);
    expect(res.records.some((r) => r.action === "remove")).toBe(true);
    expect(res.text).toBe("# base\n");
  });

  it("stray matching markers are stripped line-only with a warn", () => {
    const doc = "# base\nkeep\n<!-- agent-connector:end acme-db/memory -->\n";
    const res = removeBlocksFromText(doc, { blockIdPrefix: "acme-db/" });
    expect(res.text).toContain("keep");
    expect(res.text).not.toContain("agent-connector:end");
    expect(res.records[0]?.action).toBe("warn");
  });

  it("reports fileNowEmpty when only whitespace remains", () => {
    const installed = upsert("", "Only block.");
    const res = removeBlocksFromText(installed.text, { blockId: ID_A });
    expect(res.fileNowEmpty).toBe(true);
  });
});

describe("managed-block: listManagedBlocks / linesOutsideFences", () => {
  it("enumerates blocks with drift flags", () => {
    let text = upsert("# base\n", "A content").text;
    text = upsertBlockInText(text, {
      blockId: ID_B,
      connectorId: "other-tool",
      content: "B content",
    }).text;
    const tampered = text.replace("B content", "B content (edited)");
    const blocks = listManagedBlocks(tampered);
    expect(blocks).toHaveLength(2);
    expect(blocks.find((b) => b.blockId === ID_A)?.drifted).toBe(false);
    expect(blocks.find((b) => b.blockId === ID_B)?.drifted).toBe(true);
  });

  it("linesOutsideFences drops fence content (import-probe helper)", () => {
    const doc = "before\n```\n@AGENTS.md\n```\nafter @AGENTS.md\n";
    const lines = linesOutsideFences(doc);
    expect(lines).toContain("before");
    expect(lines).toContain("after @AGENTS.md");
    expect(lines).not.toContain("@AGENTS.md");
  });
});

describe("managed-block: file wrappers", () => {
  function tmp(): string {
    return mkdtempSync(join(tmpdir(), "ac-mblock-"));
  }

  it("creates a missing file (createdFile=true) and is dry-run safe", () => {
    const dir = tmp();
    const file = join(dir, "AGENTS.md");
    const dry = upsertManagedBlockFile(file, {
      blockId: ID_A,
      connectorId: "acme-db",
      content: "Hello.",
      dryRun: true,
    });
    expect(dry.action).toBe("create");
    expect(dry.createdFile).toBe(true);
    expect(existsSync(file)).toBe(false);

    const real = upsertManagedBlockFile(file, {
      blockId: ID_A,
      connectorId: "acme-db",
      content: "Hello.",
      dryRun: false,
    });
    expect(real.createdFile).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("Hello.");
    expect(real.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("deleteFileIfCreated removes a whitespace-only leftover file", () => {
    const dir = tmp();
    const file = join(dir, "AGENTS.md");
    upsertManagedBlockFile(file, {
      blockId: ID_A,
      connectorId: "acme-db",
      content: "Hello.",
      dryRun: false,
    });
    const changes = removeManagedBlocksFile(
      file,
      { blockIdPrefix: "acme-db/" },
      { dryRun: false, deleteFileIfCreated: true },
    );
    expect(existsSync(file)).toBe(false);
    expect(changes.some((c) => c.action === "remove" && c.detail.includes("deleted"))).toBe(true);
  });

  it("without deletion rights the trimmed file stays in place", () => {
    const dir = tmp();
    const file = join(dir, "AGENTS.md");
    writeFileSync(file, "# user content\n", "utf8");
    upsertManagedBlockFile(file, {
      blockId: ID_A,
      connectorId: "acme-db",
      content: "Hello.",
      dryRun: false,
    });
    removeManagedBlocksFile(file, { blockIdPrefix: "acme-db/" }, { dryRun: false });
    expect(readFileSync(file, "utf8")).toBe("# user content\n");
  });

  it("missing file → single idempotent skip", () => {
    const changes = removeManagedBlocksFile(
      join(tmp(), "AGENTS.md"),
      { blockIdPrefix: "acme-db/" },
      { dryRun: false },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });
});

describe("managed-block: ownership ledger", () => {
  it("records, persists, and prunes targets (file deleted when empty)", () => {
    expect(hasMemoryLedger("acme-db")).toBe(false);
    const ledger = loadMemoryLedger("acme-db");
    recordMemoryTarget(ledger, {
      platform: "codex",
      scope: "project",
      path: "/tmp/x/AGENTS.md",
      blockId: ID_A,
      createdFile: true,
      hash: "abcdefabcdef",
    });
    // Re-record with createdFile=false: the original creation fact is sticky.
    recordMemoryTarget(ledger, {
      platform: "codex",
      scope: "project",
      path: "/tmp/x/AGENTS.md",
      blockId: ID_A,
      createdFile: false,
      hash: "ffffffffffff",
    });
    expect(ledger.targets).toHaveLength(1);
    expect(ledger.targets[0]?.createdFile).toBe(true);
    expect(ledger.targets[0]?.hash).toBe("ffffffffffff");
    saveMemoryLedger("acme-db", ledger);
    expect(hasMemoryLedger("acme-db")).toBe(true);
    saveMemoryLedger("acme-db", { version: 1, targets: [] });
    expect(hasMemoryLedger("acme-db")).toBe(false);
  });
});

describe("managed-block: render grammar", () => {
  it("emits begin/notice/content/end with the documented marker grammar", () => {
    const lines = renderBlockLines({
      blockId: ID_A,
      connectorId: "acme-db",
      content: "one\ntwo",
    });
    expect(lines[0]).toMatch(/^<!-- agent-connector:begin acme-db\/memory hash=[0-9a-f]{12} -->$/);
    expect(lines[1]).toMatch(/^<!-- Managed by agent-connector for "acme-db"\./);
    expect(lines.slice(2, 4)).toEqual(["one", "two"]);
    expect(lines[4]).toBe("<!-- agent-connector:end acme-db/memory -->");
  });
});
