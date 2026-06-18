/** Decision for one inner-array upsert. */
export type ArrayUpsertAction = "create" | "update" | "skip";

export interface ArrayUpsertResult<E> {
  array: E[];
  action: ArrayUpsertAction;
}

/**
 * Upsert one rendered `candidate` into a per-event hook array.
 *  - find the FIRST entry the caller OWNS via `ownsEntry`;
 *  - hit + JSON-equal  → skip   (array returned unchanged);
 *  - hit + differs     → update (replace that slot);
 *  - miss              → create (push).
 */
export function upsertInArray<E>(
  array: E[],
  candidate: E,
  ownsEntry: (entry: E) => boolean,
): ArrayUpsertResult<E> {
  const idx = array.findIndex(ownsEntry);
  if (idx >= 0) {
    if (JSON.stringify(array[idx]) === JSON.stringify(candidate)) {
      return { array, action: "skip" };
    }
    const next = array.slice();
    next[idx] = candidate;
    return { array: next, action: "update" };
  }
  return { array: [...array, candidate], action: "create" };
}

export interface ArrayRemoveResult<E> {
  array: E[];
  removed: number;
}

/**
 * Remove owned content from a per-event hook array.
 *  - FLAT hosts: omit `stripInner` → drop whole entries matching `ownsEntry`;
 *    `removed` = whole entries dropped.
 *  - NESTED hosts: pass `stripInner` → strip owned inner commands and rebuild,
 *    dropping entries left empty; `removed` = inner commands removed.
 */
export function removeFromArray<E>(
  array: E[],
  ownsEntry: (entry: E) => boolean,
  stripInner?: (entry: E) => { next: E | null; removed: number },
): ArrayRemoveResult<E> {
  if (!stripInner) {
    const kept = array.filter((e) => !ownsEntry(e));
    return { array: kept, removed: array.length - kept.length };
  }
  const kept: E[] = [];
  let removed = 0;
  for (const e of array) {
    const r = stripInner(e);
    removed += r.removed;
    if (r.next !== null) kept.push(r.next);
  }
  return { array: kept, removed };
}
