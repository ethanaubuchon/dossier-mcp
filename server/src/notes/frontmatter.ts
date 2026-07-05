/**
 * Result of {@link applyFrontmatterEdit}. A discriminated union so the caller
 * translates expected failures (nothing to do / incoherent op / no-op) into
 * structured responses without try/catch; only genuinely unexpected states
 * throw. The denylist check (`set` targeting a tool-managed field) lives in the
 * MCP handler, alongside the shared `FRONTMATTER_DENYLIST`, so this module stays
 * free of an mcp/ dependency — mirroring `create_note`'s inline denylist check.
 */
export type FrontmatterEditResult =
  | { ok: true; tags: string[]; related: string[]; extras: Record<string, unknown> }
  | { ok: false; reason: 'no_ops' }
  | { ok: false; reason: 'conflict'; field: 'tags' | 'related'; entries: string[] }
  | { ok: false; reason: 'no_change' };

export interface FrontmatterEditOps {
  set?: Record<string, unknown>;
  addTags?: string[];
  removeTags?: string[];
  addRelated?: string[];
  removeRelated?: string[];
}

/**
 * Normalize a `set` map to the flat-scalar contract that `NoteStore.upsert`
 * persists: Date scalars become `YYYY-MM-DD` strings (gray-matter parses
 * unquoted YAML dates as JS `Date`, which `matter.stringify` would otherwise
 * re-emit as full ISO timestamps); arrays and nested objects are dropped.
 * Kept in sync with `normalizeFrontmatterExtras` in NoteStore so the no-op
 * detection below compares against exactly what the write path will store.
 *
 * Deterministic (no `new Date()` / `Date.now()`): only reads a caller-supplied
 * Date instance, so the module stays pure and resume-safe.
 */
function normalizeSet(set: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(set)) {
    if (value instanceof Date) {
      out[key] = value.toISOString().split('T')[0];
      continue;
    }
    if (Array.isArray(value)) continue;
    if (typeof value === 'object' && value !== null) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Order-preserving set union: append only entries not already present, deduping
 * within `toAdd` too so a value repeated in one call lands once (first
 * occurrence wins). Preserves the "set" contract end-to-end.
 */
function addMissing(existing: string[], toAdd: string[]): string[] {
  const result = [...existing];
  const seen = new Set(existing);
  for (const e of toAdd) {
    if (!seen.has(e)) {
      seen.add(e);
      result.push(e);
    }
  }
  return result;
}

/** Same-size, same-membership (order-insensitive) equality for string lists. */
function sameMembers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bset = new Set(b);
  return a.every((e) => bset.has(e));
}

function intersect(a: string[], b: string[]): string[] {
  const bset = new Set(b);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of a) {
    if (bset.has(e) && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

/**
 * Compute the new frontmatter for a surgical `edit_frontmatter` operation
 * against a note's current `tags`, `related`, and non-typed `extras`.
 *
 * List semantics are order-preserving set operations: `addTags`/`addRelated`
 * append only genuinely-new entries (re-adding an existing one is a silent
 * no-op); `removeTags`/`removeRelated` drop matches (removing an absent one is a
 * silent no-op). This is deliberately idempotent so repair passes (link-symmetry,
 * orphan-ref cleanup, retagging) are safe to re-run — the aggregate `no_change`
 * guard below still catches a call whose *net* effect is nothing.
 *
 * `set` overlays scalar passthrough fields onto `extras`, last-write-wins, after
 * normalization to the flat-scalar contract the write path stores.
 *
 * Failure reasons:
 * - `no_ops`   — no `set` and no list entries supplied (nothing to do).
 * - `conflict` — the same entry appears in both add and remove for a list
 *                (incoherent intent; reported before any write).
 * - `no_change`— every add already present, every remove absent, and every `set`
 *                value equals the current one. Reported (not `ok`) so the caller
 *                skips the write + spurious `updated` stamp, mirroring `edit_note`.
 *
 * Pure: no I/O. The caller owns reading the note, the denylist check, and the
 * write.
 */
export function applyFrontmatterEdit(
  current: { tags: string[]; related: string[]; extras: Record<string, unknown> },
  ops: FrontmatterEditOps,
): FrontmatterEditResult {
  const addTags = ops.addTags ?? [];
  const removeTags = ops.removeTags ?? [];
  const addRelated = ops.addRelated ?? [];
  const removeRelated = ops.removeRelated ?? [];
  const set = ops.set ?? {};

  const hasListOps = addTags.length || removeTags.length || addRelated.length || removeRelated.length;
  if (!hasListOps && Object.keys(set).length === 0) {
    return { ok: false, reason: 'no_ops' };
  }

  const tagConflict = intersect(addTags, removeTags);
  if (tagConflict.length) return { ok: false, reason: 'conflict', field: 'tags', entries: tagConflict };
  const relatedConflict = intersect(addRelated, removeRelated);
  if (relatedConflict.length) return { ok: false, reason: 'conflict', field: 'related', entries: relatedConflict };

  const newTags = addMissing(
    current.tags.filter((t) => !removeTags.includes(t)),
    addTags,
  );
  const newRelated = addMissing(
    current.related.filter((r) => !removeRelated.includes(r)),
    addRelated,
  );
  const normalizedSet = normalizeSet(set);
  const newExtras = { ...current.extras, ...normalizedSet };

  // no_change: lists unchanged (by membership) AND every set key already equals
  // its current value. `updated` is not touched by callers, so it never forces a
  // false diff here; the handler stamps it only when this returns `ok`.
  const listsUnchanged = sameMembers(newTags, current.tags) && sameMembers(newRelated, current.related);
  const setUnchanged = Object.entries(normalizedSet).every(
    ([k, v]) => Object.is(current.extras[k], v),
  );
  if (listsUnchanged && setUnchanged) {
    return { ok: false, reason: 'no_change' };
  }

  return { ok: true, tags: newTags, related: newRelated, extras: newExtras };
}
