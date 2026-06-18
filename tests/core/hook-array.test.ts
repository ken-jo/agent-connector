/**
 * tests/core/hook-array — locks the pure per-event hook-array merge primitive
 * that the shared engine (BaseAdapter.upsertHookEntries / removeHookEntries)
 * and every object-map hook host delegate to. The primitive owns ONLY the
 * create/update/skip decision and the FLAT-vs-NESTED removal mechanics; it does
 * no IO and carries no host wording. THIS file exercises it in isolation so the
 * decision, the array-unchanged-identity on skip, and the `removed` counts are
 * pinned independent of any host. The claude-code adapter + contract suites
 * prove the host binding on top is byte-identical.
 */

import { describe, expect, it } from "vitest";

import { removeFromArray, upsertInArray } from "../../src/core/hook-array.js";

// A minimal NESTED element shape (claude-code-style): a matcher + inner commands.
interface Entry {
  matcher: string;
  hooks: Array<{ command: string }>;
}

const ownsCommand =
  (command: string) =>
  (e: Entry): boolean =>
    e.hooks.some((h) => h.command === command);

describe("upsertInArray", () => {
  it("create: miss → pushes the candidate and reports create", () => {
    const array: Entry[] = [];
    const candidate: Entry = { matcher: "a", hooks: [{ command: "ours" }] };

    const r = upsertInArray(array, candidate, ownsCommand("ours"));

    expect(r.action).toBe("create");
    expect(r.array).toEqual([candidate]);
    // Pure: the input array is never mutated.
    expect(array).toEqual([]);
  });

  it("update: owned-but-different → replaces that slot and reports update", () => {
    const stale: Entry = { matcher: "old", hooks: [{ command: "ours" }] };
    const array: Entry[] = [{ matcher: "x", hooks: [{ command: "other" }] }, stale];
    const candidate: Entry = { matcher: "new", hooks: [{ command: "ours" }] };

    const r = upsertInArray(array, candidate, ownsCommand("ours"));

    expect(r.action).toBe("update");
    expect(r.array).toHaveLength(2);
    expect(r.array[1]).toEqual(candidate);
    // The unrelated entry is preserved; the input array is untouched.
    expect(r.array[0]).toEqual({ matcher: "x", hooks: [{ command: "other" }] });
    expect(array[1]).toBe(stale);
  });

  it("update: replaces only the FIRST owned slot", () => {
    const array: Entry[] = [
      { matcher: "first", hooks: [{ command: "ours" }] },
      { matcher: "second", hooks: [{ command: "ours" }] },
    ];
    const candidate: Entry = { matcher: "fresh", hooks: [{ command: "ours" }] };

    const r = upsertInArray(array, candidate, ownsCommand("ours"));

    expect(r.action).toBe("update");
    expect(r.array[0]).toEqual(candidate);
    expect(r.array[1]).toEqual({ matcher: "second", hooks: [{ command: "ours" }] });
  });

  it("skip: owned + JSON-equal → returns the SAME array reference unchanged", () => {
    const existing: Entry = { matcher: "a", hooks: [{ command: "ours" }] };
    const array: Entry[] = [existing];
    const candidate: Entry = { matcher: "a", hooks: [{ command: "ours" }] };

    const r = upsertInArray(array, candidate, ownsCommand("ours"));

    expect(r.action).toBe("skip");
    // Same-array identity is the no-write signal the engine relies on.
    expect(r.array).toBe(array);
  });
});

describe("removeFromArray — FLAT (no stripInner)", () => {
  it("drops every whole entry matching ownsEntry; removed = entries dropped", () => {
    const array: Entry[] = [
      { matcher: "a", hooks: [{ command: "ours" }] },
      { matcher: "b", hooks: [{ command: "other" }] },
      { matcher: "c", hooks: [{ command: "ours" }] },
    ];

    const r = removeFromArray(array, ownsCommand("ours"));

    expect(r.removed).toBe(2);
    expect(r.array).toEqual([{ matcher: "b", hooks: [{ command: "other" }] }]);
  });

  it("no match → removed 0 and the kept array is intact", () => {
    const array: Entry[] = [{ matcher: "b", hooks: [{ command: "other" }] }];

    const r = removeFromArray(array, ownsCommand("ours"));

    expect(r.removed).toBe(0);
    expect(r.array).toEqual(array);
  });
});

describe("removeFromArray — NESTED (stripInner)", () => {
  // Mirrors claude-code's inner-strip: drop owned inner commands, rebuild the
  // entry, return null when it is left empty; removed = inner commands removed.
  const stripInner = (e: Entry): { next: Entry | null; removed: number } => {
    const before = e.hooks.length;
    const inner = e.hooks.filter((h) => h.command !== "ours");
    return {
      next: inner.length > 0 ? { matcher: e.matcher, hooks: inner } : null,
      removed: before - inner.length,
    };
  };

  it("strips owned inner commands and counts inner removals (not whole entries)", () => {
    const array: Entry[] = [
      { matcher: "a", hooks: [{ command: "ours" }, { command: "keep" }] },
    ];

    const r = removeFromArray(array, () => false, stripInner);

    expect(r.removed).toBe(1);
    // Entry survives because a non-owned inner command remains.
    expect(r.array).toEqual([{ matcher: "a", hooks: [{ command: "keep" }] }]);
  });

  it("drops an entry left empty after stripping; sums inner removals across entries", () => {
    const array: Entry[] = [
      { matcher: "a", hooks: [{ command: "ours" }] },
      { matcher: "b", hooks: [{ command: "ours" }, { command: "ours" }, { command: "keep" }] },
    ];

    const r = removeFromArray(array, () => false, stripInner);

    expect(r.removed).toBe(3);
    // First entry fully emptied → dropped; second keeps its non-owned command.
    expect(r.array).toEqual([{ matcher: "b", hooks: [{ command: "keep" }] }]);
  });
});
