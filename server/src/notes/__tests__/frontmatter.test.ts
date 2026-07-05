import { applyFrontmatterEdit, type FrontmatterEditResult } from '../frontmatter.js';

// Narrow to an ok result or fail loudly, so type errors surface as test
// failures rather than silent undefined access.
function ok(result: FrontmatterEditResult): Extract<FrontmatterEditResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
  return result;
}

const base = () => ({ tags: ['a', 'b'], related: ['x/one'], extras: { status: 'shaping', updated: '2026-01-01' } });

describe('applyFrontmatterEdit — list semantics', () => {
  test('add appends only genuinely-new entries, order preserved', () => {
    const r = ok(applyFrontmatterEdit(base(), { addTags: ['c', 'a', 'd'] }));
    // 'a' already present (dropped); 'c' and 'd' appended in given order.
    expect(r.tags).toEqual(['a', 'b', 'c', 'd']);
  });

  test('add dedupes duplicates within a single batch (first occurrence wins)', () => {
    const r = ok(applyFrontmatterEdit(base(), { addTags: ['x', 'x', 'y', 'x'] }));
    expect(r.tags).toEqual(['a', 'b', 'x', 'y']);
  });

  test('remove drops matching entries', () => {
    const r = ok(applyFrontmatterEdit(base(), { removeTags: ['a'] }));
    expect(r.tags).toEqual(['b']);
  });

  test('remove then add compose (remove first, append new)', () => {
    const r = ok(applyFrontmatterEdit(base(), { removeTags: ['a'], addTags: ['c'] }));
    expect(r.tags).toEqual(['b', 'c']);
  });

  test('removing an absent entry is a silent no-op (as part of a real change)', () => {
    const r = ok(applyFrontmatterEdit(base(), { removeTags: ['nope'], addTags: ['c'] }));
    expect(r.tags).toEqual(['a', 'b', 'c']);
  });

  test('removing all entries yields an empty array (not a preserve)', () => {
    const r = ok(applyFrontmatterEdit(base(), { removeTags: ['a', 'b'] }));
    expect(r.tags).toEqual([]);
  });

  test('related add/remove works the same as tags', () => {
    const r = ok(applyFrontmatterEdit(base(), { addRelated: ['x/two'], removeRelated: ['x/one'] }));
    expect(r.related).toEqual(['x/two']);
  });
});

describe('applyFrontmatterEdit — conflict', () => {
  test('same entry in add and remove tags → conflict', () => {
    const r = applyFrontmatterEdit(base(), { addTags: ['a'], removeTags: ['a'] });
    expect(r).toEqual({ ok: false, reason: 'conflict', field: 'tags', entries: ['a'] });
  });

  test('same entry in add and remove related → conflict', () => {
    const r = applyFrontmatterEdit(base(), { addRelated: ['x/one'], removeRelated: ['x/one'] });
    expect(r).toEqual({ ok: false, reason: 'conflict', field: 'related', entries: ['x/one'] });
  });
});

describe('applyFrontmatterEdit — set', () => {
  test('set overlays scalar fields last-write-wins', () => {
    const r = ok(applyFrontmatterEdit(base(), { set: { status: 'implemented' } }));
    expect(r.extras.status).toBe('implemented');
  });

  test('set adds a new scalar extra', () => {
    const r = ok(applyFrontmatterEdit(base(), { set: { priority: 2 } }));
    expect(r.extras.priority).toBe(2);
    expect(r.extras.status).toBe('shaping'); // untouched
  });

  test.each([
    ['string', 'done'],
    ['number', 3],
    ['boolean', true],
  ])('set accepts a %s value', (_label, value) => {
    const r = ok(applyFrontmatterEdit(base(), { set: { field: value } }));
    expect(r.extras.field).toBe(value);
  });

  test('set drops nested/array values (flat-extras contract)', () => {
    const r = ok(applyFrontmatterEdit(base(), { set: { meta: { x: 1 }, list: [1, 2], keep: 'yes' } }));
    expect(r.extras.keep).toBe('yes');
    expect(r.extras).not.toHaveProperty('meta');
    expect(r.extras).not.toHaveProperty('list');
  });

  test('a Date value coerces to YYYY-MM-DD (matches the write path)', () => {
    const r = ok(applyFrontmatterEdit(base(), { set: { due: new Date('2026-05-09T00:00:00Z') } }));
    expect(r.extras.due).toBe('2026-05-09');
  });
});

describe('applyFrontmatterEdit — no_ops / no_change', () => {
  test('no ops supplied → no_ops', () => {
    expect(applyFrontmatterEdit(base(), {})).toEqual({ ok: false, reason: 'no_ops' });
  });

  test('re-adding an existing tag with no other change → no_change', () => {
    expect(applyFrontmatterEdit(base(), { addTags: ['a'] })).toEqual({ ok: false, reason: 'no_change' });
  });

  test('removing an absent tag with no other change → no_change', () => {
    expect(applyFrontmatterEdit(base(), { removeTags: ['nope'] })).toEqual({ ok: false, reason: 'no_change' });
  });

  test('set to the current value → no_change', () => {
    expect(applyFrontmatterEdit(base(), { set: { status: 'shaping' } })).toEqual({ ok: false, reason: 'no_change' });
  });

  test('set with only droppable (nested/array) values → no_change', () => {
    expect(applyFrontmatterEdit(base(), { set: { meta: { x: 1 } } })).toEqual({ ok: false, reason: 'no_change' });
  });

  test('a redundant list op combined with a real set change still proceeds', () => {
    const r = ok(applyFrontmatterEdit(base(), { addTags: ['a'], set: { status: 'implemented' } }));
    expect(r.tags).toEqual(['a', 'b']);
    expect(r.extras.status).toBe('implemented');
  });
});
