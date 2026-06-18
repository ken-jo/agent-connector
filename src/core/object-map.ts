import type { ChangeRecord } from "./types.js";

/**
 * Format-agnostic upsert/remove for a config that stores entries in an object
 * map at config[rootKey][entryId]. Extracted from BaseAdapter.upsertServerInJson
 * / removeServerFromJson so JSON today (and other formats via a Codec later)
 * share ONE create/skip/update + overwrite/malformed-guard orchestration. The
 * JSON binding in BaseAdapter is a byte-identical wrapper over this.
 */

/** The only format-specific surface: parse a config file to a record and
 * serialize it back. parse() fail-softs to null (absent or unparseable). */
export interface ObjectMapCodec {
  parse(path: string): Record<string, unknown> | null;
  serialize(path: string, data: Record<string, unknown>, dryRun: boolean): void;
  /** Detection half of the overwrite guard: present, non-empty, still unparseable. */
  isPresentButUnparseable(path: string): boolean;
}

/** What to do when config[rootKey] is present but the wrong type (hand-edited to
 * an array / primitive). "warn-skip" leaves the user's value untouched (the JSON
 * server/hook policy); "coerce" replaces it with a fresh {} and proceeds (the
 * TOML/YAML host policy, used by a later follow-up). */
export type MalformedRootPolicy = "warn-skip" | "coerce";

/** True when a PRESENT value is not a plain object map (array / primitive).
 * null/undefined is NOT malformed — that is the well-formed "absent" case the
 * engine creates fresh. */
export function isMalformedRootValue(value: unknown): boolean {
  return value != null && (typeof value !== "object" || Array.isArray(value));
}

export interface ObjectMapUpsertOptions {
  codec: ObjectMapCodec;
  rootKey: string;
  platform: string;
  configPath: string;
  entryId: string;
  entry: unknown;
  dryRun?: boolean;
  policy?: MalformedRootPolicy;
}

export interface ObjectMapRemoveOptions {
  codec: ObjectMapCodec;
  rootKey: string;
  platform: string;
  configPath: string;
  entryId: string;
  dryRun?: boolean;
  policy?: MalformedRootPolicy;
}

function unparseableWarn(platform: string, configPath: string): ChangeRecord {
  return {
    platform: platform as ChangeRecord["platform"],
    action: "warn",
    path: configPath,
    detail: `existing ${configPath} is not parseable; left untouched (back it up / fix it, then re-run)`,
  };
}

function malformedWarn(platform: string, rootKey: string, configPath: string): ChangeRecord {
  return {
    platform: platform as ChangeRecord["platform"],
    action: "warn",
    path: configPath,
    detail: `existing "${rootKey}" in ${configPath} is not an object map; left untouched (fix it, then re-run)`,
  };
}

export function upsertInObjectMap(o: ObjectMapUpsertOptions): ChangeRecord {
  const policy = o.policy ?? "warn-skip";
  if (o.codec.isPresentButUnparseable(o.configPath)) {
    return unparseableWarn(o.platform, o.configPath);
  }
  const cfg = o.codec.parse(o.configPath) ?? {};
  if (isMalformedRootValue(cfg[o.rootKey])) {
    if (policy === "warn-skip") return malformedWarn(o.platform, o.rootKey, o.configPath);
    cfg[o.rootKey] = {}; // coerce
  }
  const bucket = (cfg[o.rootKey] ?? (cfg[o.rootKey] = {})) as Record<string, unknown>;
  const before = JSON.stringify(bucket[o.entryId]);
  const after = JSON.stringify(o.entry);
  let action: ChangeRecord["action"];
  if (before === undefined) action = "create";
  else if (before === after) action = "skip";
  else action = "update";
  if (action !== "skip") {
    bucket[o.entryId] = o.entry;
    o.codec.serialize(o.configPath, cfg, o.dryRun ?? false);
  }
  return {
    platform: o.platform as ChangeRecord["platform"],
    action,
    path: o.configPath,
    detail: `${o.rootKey}.${o.entryId}`,
  };
}

export function removeFromObjectMap(o: ObjectMapRemoveOptions): ChangeRecord {
  const policy = o.policy ?? "warn-skip";
  if (o.codec.isPresentButUnparseable(o.configPath)) {
    return unparseableWarn(o.platform, o.configPath);
  }
  const cfg = o.codec.parse(o.configPath);
  if (cfg && isMalformedRootValue(cfg[o.rootKey])) {
    if (policy === "warn-skip") return malformedWarn(o.platform, o.rootKey, o.configPath);
    // coerce: a malformed root holds nothing of ours to remove → absent skip
    return {
      platform: o.platform as ChangeRecord["platform"],
      action: "skip",
      path: o.configPath,
      detail: `${o.rootKey}.${o.entryId} absent`,
    };
  }
  const bucket = cfg?.[o.rootKey] as Record<string, unknown> | undefined;
  if (!cfg || !bucket || !(o.entryId in bucket)) {
    return {
      platform: o.platform as ChangeRecord["platform"],
      action: "skip",
      path: o.configPath,
      detail: `${o.rootKey}.${o.entryId} absent`,
    };
  }
  delete bucket[o.entryId];
  o.codec.serialize(o.configPath, cfg, o.dryRun ?? false);
  return {
    platform: o.platform as ChangeRecord["platform"],
    action: "remove",
    path: o.configPath,
    detail: `${o.rootKey}.${o.entryId}`,
  };
}
