/**
 * tests/core/object-map — locks the format-agnostic object-map engine that the
 * JSON server helpers (BaseAdapter.upsertServerInJson / removeServerFromJson)
 * and mux delegate to. The engine owns the create/skip/update + remove
 * orchestration and the overwrite/malformed-root guards; the contract +
 * adapter suites prove the JSON binding is byte-identical, while THIS file
 * exercises the engine in isolation (pure in-memory codec, no disk) so the
 * exact ChangeRecord shape, detail strings, warn messages, and write/no-write
 * behavior are pinned independent of any host. If a string here changes, the
 * byte-identical contract with every JSON server host is broken.
 */

import { describe, expect, it } from "vitest";

import {
  isMalformedRootValue,
  removeFromObjectMap,
  upsertInObjectMap,
  type ObjectMapCodec,
} from "../../src/core/object-map.js";

const PLATFORM = "claude-code";
const PATH = "/cfg/config.json";
const ROOT = "mcpServers";
const ID = "demo";

/**
 * In-memory codec backed by a Map<path, string> of JSON text. `serialize`
 * tracks every write so a test can assert "wrote nothing" on skip/warn paths.
 * `unparseable` is an explicit set of paths the overwrite guard treats as
 * present-but-broken (mirrors BaseAdapter.isPresentButUnparseable).
 */
function makeCodec(initial?: { path?: string; value?: unknown; unparseable?: boolean }) {
  const store = new Map<string, string>();
  const unparseable = new Set<string>();
  if (initial?.path && initial.value !== undefined) {
    store.set(initial.path, JSON.stringify(initial.value));
  }
  if (initial?.unparseable && initial.path) unparseable.add(initial.path);

  const writes: { path: string; data: Record<string, unknown>; dryRun: boolean }[] = [];

  const codec: ObjectMapCodec = {
    parse(path) {
      if (!store.has(path)) return null;
      return JSON.parse(store.get(path) as string) as Record<string, unknown>;
    },
    serialize(path, data, dryRun) {
      writes.push({ path, data: structuredClone(data), dryRun });
      if (!dryRun) store.set(path, JSON.stringify(data));
    },
    isPresentButUnparseable(path) {
      return unparseable.has(path);
    },
  };

  return {
    codec,
    writes,
    read: (path: string) => (store.has(path) ? JSON.parse(store.get(path) as string) : null),
  };
}

describe("isMalformedRootValue", () => {
  it("treats arrays and primitives as malformed, plain objects + null/undefined as not", () => {
    expect(isMalformedRootValue([])).toBe(true);
    expect(isMalformedRootValue([1, 2])).toBe(true);
    expect(isMalformedRootValue("x")).toBe(true);
    expect(isMalformedRootValue(42)).toBe(true);
    expect(isMalformedRootValue(true)).toBe(true);
    expect(isMalformedRootValue({})).toBe(false);
    expect(isMalformedRootValue({ a: 1 })).toBe(false);
    expect(isMalformedRootValue(null)).toBe(false);
    expect(isMalformedRootValue(undefined)).toBe(false);
  });
});

describe("upsertInObjectMap", () => {
  it("create: absent file → action create, entry lands on disk", () => {
    const c = makeCodec();
    const rec = upsertInObjectMap({
      codec: c.codec,
      rootKey: ROOT,
      platform: PLATFORM,
      configPath: PATH,
      entryId: ID,
      entry: { command: "x" },
    });
    expect(rec).toEqual({ platform: PLATFORM, action: "create", path: PATH, detail: `${ROOT}.${ID}` });
    expect(c.read(PATH)).toEqual({ [ROOT]: { [ID]: { command: "x" } } });
    expect(c.writes).toHaveLength(1);
  });

  it("skip: identical entry → action skip, writes nothing", () => {
    const c = makeCodec({ path: PATH, value: { [ROOT]: { [ID]: { command: "x" } } } });
    const rec = upsertInObjectMap({
      codec: c.codec,
      rootKey: ROOT,
      platform: PLATFORM,
      configPath: PATH,
      entryId: ID,
      entry: { command: "x" },
    });
    expect(rec).toEqual({ platform: PLATFORM, action: "skip", path: PATH, detail: `${ROOT}.${ID}` });
    expect(c.writes).toHaveLength(0);
  });

  it("update: changed entry → action update, new value on disk", () => {
    const c = makeCodec({ path: PATH, value: { [ROOT]: { [ID]: { command: "old" } } } });
    const rec = upsertInObjectMap({
      codec: c.codec,
      rootKey: ROOT,
      platform: PLATFORM,
      configPath: PATH,
      entryId: ID,
      entry: { command: "new" },
    });
    expect(rec).toEqual({ platform: PLATFORM, action: "update", path: PATH, detail: `${ROOT}.${ID}` });
    expect(c.read(PATH)).toEqual({ [ROOT]: { [ID]: { command: "new" } } });
    expect(c.writes).toHaveLength(1);
  });

  it("string-valued entry (mux shape): value-agnostic create", () => {
    const c = makeCodec();
    const rec = upsertInObjectMap({
      codec: c.codec,
      rootKey: "servers",
      platform: "mux",
      configPath: PATH,
      entryId: ID,
      entry: "node server.js --flag",
    });
    expect(rec).toEqual({ platform: "mux", action: "create", path: PATH, detail: `servers.${ID}` });
    expect(c.read(PATH)).toEqual({ servers: { [ID]: "node server.js --flag" } });
  });
});

describe("removeFromObjectMap", () => {
  it("remove: present entry → action remove, entry deleted on disk", () => {
    const c = makeCodec({ path: PATH, value: { [ROOT]: { [ID]: { command: "x" } } } });
    const rec = removeFromObjectMap({
      codec: c.codec,
      rootKey: ROOT,
      platform: PLATFORM,
      configPath: PATH,
      entryId: ID,
    });
    expect(rec).toEqual({ platform: PLATFORM, action: "remove", path: PATH, detail: `${ROOT}.${ID}` });
    expect(c.read(PATH)).toEqual({ [ROOT]: {} });
    expect(c.writes).toHaveLength(1);
  });

  it("skip-absent: absent file → action skip with '<root>.<id> absent', writes nothing", () => {
    const c = makeCodec();
    const rec = removeFromObjectMap({
      codec: c.codec,
      rootKey: ROOT,
      platform: PLATFORM,
      configPath: PATH,
      entryId: ID,
    });
    expect(rec).toEqual({ platform: PLATFORM, action: "skip", path: PATH, detail: `${ROOT}.${ID} absent` });
    expect(c.writes).toHaveLength(0);
  });

  it("skip-absent: present file missing the key → action skip, writes nothing", () => {
    const c = makeCodec({ path: PATH, value: { [ROOT]: { other: { command: "y" } } } });
    const rec = removeFromObjectMap({
      codec: c.codec,
      rootKey: ROOT,
      platform: PLATFORM,
      configPath: PATH,
      entryId: ID,
    });
    expect(rec).toEqual({ platform: PLATFORM, action: "skip", path: PATH, detail: `${ROOT}.${ID} absent` });
    expect(c.writes).toHaveLength(0);
  });
});

describe("malformed root, default warn-skip policy", () => {
  const ARRAY_ROOT = { [ROOT]: [] as unknown[] };
  const STRING_ROOT = { [ROOT]: "x" };
  const WARN_DETAIL = `existing "${ROOT}" in ${PATH} is not an object map; left untouched (fix it, then re-run)`;

  for (const [label, value] of [
    ["array root", ARRAY_ROOT],
    ["string root", STRING_ROOT],
  ] as const) {
    it(`upsert: ${label} → warn, writes nothing, value intact`, () => {
      const c = makeCodec({ path: PATH, value });
      const rec = upsertInObjectMap({
        codec: c.codec,
        rootKey: ROOT,
        platform: PLATFORM,
        configPath: PATH,
        entryId: ID,
        entry: { command: "x" },
      });
      expect(rec).toEqual({ platform: PLATFORM, action: "warn", path: PATH, detail: WARN_DETAIL });
      expect(c.writes).toHaveLength(0);
      expect(c.read(PATH)).toEqual(value);
    });

    it(`remove: ${label} → warn, writes nothing, value intact`, () => {
      const c = makeCodec({ path: PATH, value });
      const rec = removeFromObjectMap({
        codec: c.codec,
        rootKey: ROOT,
        platform: PLATFORM,
        configPath: PATH,
        entryId: ID,
      });
      expect(rec).toEqual({ platform: PLATFORM, action: "warn", path: PATH, detail: WARN_DETAIL });
      expect(c.writes).toHaveLength(0);
      expect(c.read(PATH)).toEqual(value);
    });
  }
});

describe("malformed root, coerce policy", () => {
  it("upsert: replaces the malformed root and the entry lands (create)", () => {
    const c = makeCodec({ path: PATH, value: { [ROOT]: [1, 2, 3] } });
    const rec = upsertInObjectMap({
      codec: c.codec,
      rootKey: ROOT,
      platform: PLATFORM,
      configPath: PATH,
      entryId: ID,
      entry: { command: "x" },
      policy: "coerce",
    });
    expect(rec).toEqual({ platform: PLATFORM, action: "create", path: PATH, detail: `${ROOT}.${ID}` });
    expect(c.read(PATH)).toEqual({ [ROOT]: { [ID]: { command: "x" } } });
    expect(c.writes).toHaveLength(1);
  });

  it("remove: malformed root holds nothing of ours → skip-absent, writes nothing", () => {
    const c = makeCodec({ path: PATH, value: { [ROOT]: "x" } });
    const rec = removeFromObjectMap({
      codec: c.codec,
      rootKey: ROOT,
      platform: PLATFORM,
      configPath: PATH,
      entryId: ID,
      policy: "coerce",
    });
    expect(rec).toEqual({ platform: PLATFORM, action: "skip", path: PATH, detail: `${ROOT}.${ID} absent` });
    expect(c.writes).toHaveLength(0);
  });
});

describe("unparseable overwrite guard", () => {
  const UNPARSEABLE_DETAIL = `existing ${PATH} is not parseable; left untouched (back it up / fix it, then re-run)`;

  it("upsert: present-but-unparseable → warn, writes nothing", () => {
    const c = makeCodec({ path: PATH, value: { junk: true }, unparseable: true });
    const rec = upsertInObjectMap({
      codec: c.codec,
      rootKey: ROOT,
      platform: PLATFORM,
      configPath: PATH,
      entryId: ID,
      entry: { command: "x" },
    });
    expect(rec).toEqual({ platform: PLATFORM, action: "warn", path: PATH, detail: UNPARSEABLE_DETAIL });
    expect(c.writes).toHaveLength(0);
  });

  it("remove: present-but-unparseable → warn, writes nothing", () => {
    const c = makeCodec({ path: PATH, value: { junk: true }, unparseable: true });
    const rec = removeFromObjectMap({
      codec: c.codec,
      rootKey: ROOT,
      platform: PLATFORM,
      configPath: PATH,
      entryId: ID,
    });
    expect(rec).toEqual({ platform: PLATFORM, action: "warn", path: PATH, detail: UNPARSEABLE_DETAIL });
    expect(c.writes).toHaveLength(0);
  });
});
