import { hasExcludedTag, filterByExcludedTags, makeTagExcluder } from '../tagFilter.js';

const item = (slug: string, tags: string[]) => ({
  slug,
  frontmatter: { title: slug, date: '2026-03-05', tags, related: [] },
});

describe('hasExcludedTag', () => {
  test('empty exclude set is always false', () => {
    expect(hasExcludedTag(['archived'], [])).toBe(false);
    expect(hasExcludedTag([], [])).toBe(false);
  });

  test('true when a tag matches', () => {
    expect(hasExcludedTag(['note', 'archived'], ['archived'])).toBe(true);
  });

  test('false when no tag matches', () => {
    expect(hasExcludedTag(['note', 'active'], ['archived', 'historical'])).toBe(false);
  });

  test('matches case-insensitively (tag or exclude in any case)', () => {
    expect(hasExcludedTag(['Archived'], ['archived'])).toBe(true);
    expect(hasExcludedTag(['archived'], ['ARCHIVED'])).toBe(true);
    expect(hasExcludedTag(['ArChIvEd'], ['archived'])).toBe(true);
  });

  test('a single matching tag among many excludes', () => {
    expect(hasExcludedTag(['a', 'b', 'historical', 'c'], ['historical'])).toBe(true);
  });
});

describe('makeTagExcluder', () => {
  test('empty exclude set → constant-false predicate', () => {
    const isExcluded = makeTagExcluder([]);
    expect(isExcluded(['archived'])).toBe(false);
  });

  test('returns a reusable predicate that matches case-insensitively', () => {
    const isExcluded = makeTagExcluder(['archived']);
    expect(isExcluded(['Archived'])).toBe(true);
    expect(isExcluded(['active'])).toBe(false);
    expect(isExcluded(['note', 'ARCHIVED'])).toBe(true);
  });
});

describe('filterByExcludedTags', () => {
  const items = [
    item('keep-1', ['active']),
    item('drop-archived', ['archived']),
    item('keep-2', ['project', 'reference']),
    item('drop-historical', ['note', 'Historical']),
  ];

  test('empty exclude set returns the input unchanged', () => {
    const out = filterByExcludedTags(items, []);
    expect(out).toBe(items);
  });

  test('drops items carrying any excluded tag (case-insensitive)', () => {
    const out = filterByExcludedTags(items, ['archived', 'historical']);
    expect(out.map((i) => i.slug)).toEqual(['keep-1', 'keep-2']);
  });

  test('an explicit custom list replaces the default behaviour', () => {
    const out = filterByExcludedTags(items, ['reference']);
    expect(out.map((i) => i.slug)).toEqual(['keep-1', 'drop-archived', 'drop-historical']);
  });
});
