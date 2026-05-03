import { SearchIndex } from '../SearchIndex.js';
import type { NoteListItem } from '../../types.js';

const makeNote = (slug: string, title: string, tags: string[] = []): NoteListItem => ({
  slug,
  frontmatter: { title, date: '2026-03-05', tags, related: [] },
});

describe('SearchIndex', () => {
  let index: SearchIndex;

  beforeEach(() => {
    index = new SearchIndex();
  });

  test('returns empty results for empty query', () => {
    index.buildIndex([makeNote('a', 'Alpha Note')]);
    expect(index.search('')).toEqual([]);
  });

  test('returns empty results when no notes match', () => {
    index.buildIndex([makeNote('a', 'Alpha Note')]);
    expect(index.search('zzzyyyxxx')).toEqual([]);
  });

  test('finds note by title keyword', () => {
    index.buildIndex([
      makeNote('react-hooks', 'React Hooks Rules', ['react']),
      makeNote('css-tips', 'CSS Tips and Tricks', ['css']),
    ]);
    const results = index.search('react');
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe('react-hooks');
  });

  test('title matches score higher than tag matches', () => {
    index.buildIndex([
      makeNote('no-title-match', 'Something Else', ['react']),
      makeNote('title-match', 'React Hooks', []),
    ]);
    const results = index.search('react');
    expect(results[0].slug).toBe('title-match');
  });

  test('multi-term query scores notes with more matching terms higher', () => {
    index.buildIndex([
      makeNote('a', 'React Note', ['react']),
      makeNote('b', 'React Hooks Guide', ['react', 'hooks']),
    ]);
    const results = index.search('react hooks');
    expect(results[0].slug).toBe('b');
  });

  test('returns up to limit results', () => {
    const notes = Array.from({ length: 20 }, (_, i) =>
      makeNote(`note-${i}`, `Note ${i}`, ['common'])
    );
    index.buildIndex(notes);
    const results = index.search('common', 5);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  test('includes excerpt in results', () => {
    index.buildIndex([makeNote('a', 'Alpha Beta Note')]);
    const results = index.search('alpha');
    expect(results[0].excerpt).toBeDefined();
    expect(typeof results[0].excerpt).toBe('string');
  });

  test('field boosting: title match > tag match > related match > body match', () => {
    index.buildIndexWithContent([
      {
        slug: 'title-hit',
        frontmatter: { title: 'Kubernetes Guide', date: '2026-01-01', tags: [], related: [] },
        content: 'A guide about containers.',
      },
      {
        slug: 'tag-hit',
        frontmatter: { title: 'Container Guide', date: '2026-01-01', tags: ['kubernetes'], related: [] },
        content: 'A guide about containers.',
      },
      {
        slug: 'related-hit',
        frontmatter: { title: 'Container Guide', date: '2026-01-01', tags: [], related: ['kubernetes-overview'] },
        content: 'A guide about containers.',
      },
      {
        slug: 'body-hit',
        frontmatter: { title: 'Container Guide', date: '2026-01-01', tags: [], related: [] },
        content: 'Learn about kubernetes orchestration.',
      },
    ]);
    const results = index.search('kubernetes');
    expect(results.length).toBe(4);
    expect(results[0].slug).toBe('title-hit');
    expect(results[1].slug).toBe('tag-hit');
    expect(results[2].slug).toBe('related-hit');
    expect(results[3].slug).toBe('body-hit');
  });

  test('BM25: same term in short note scores higher than in long note', () => {
    index.buildIndexWithContent([
      {
        slug: 'short',
        frontmatter: { title: 'Kubernetes', date: '2026-01-01', tags: [], related: [] },
        content: '',
      },
      {
        slug: 'long',
        frontmatter: { title: 'Kubernetes', date: '2026-01-01', tags: [], related: [] },
        content: 'word '.repeat(500),
      },
    ]);
    const results = index.search('kubernetes');
    expect(results.length).toBe(2);
    expect(results[0].slug).toBe('short');
  });

  test('BM25: term saturation — 10 occurrences do not score 10x higher than 1', () => {
    index.buildIndexWithContent([
      {
        slug: 'once',
        frontmatter: { title: 'Note', date: '2026-01-01', tags: [], related: [] },
        content: 'kubernetes is useful',
      },
      {
        slug: 'ten-times',
        frontmatter: { title: 'Note', date: '2026-01-01', tags: [], related: [] },
        content: Array(10).fill('kubernetes').join(' and '),
      },
    ]);
    const results = index.search('kubernetes');
    const scoreOnce = results.find((r) => r.slug === 'once')!.score;
    const scoreTen = results.find((r) => r.slug === 'ten-times')!.score;
    // With saturation, 10x occurrences should score well under 5x (not 10x)
    expect(scoreTen / scoreOnce).toBeLessThan(5);
    expect(scoreTen).toBeGreaterThan(scoreOnce);
  });

  test('prefix matching: query "think" matches note containing "thinkpad"', () => {
    index.buildIndexWithContent([
      {
        slug: 'laptop',
        frontmatter: { title: 'Hardware — ThinkPad X1 Carbon', date: '2026-01-01', tags: ['hardware'], related: [] },
        content: 'Arch Linux laptop setup notes.',
      },
    ]);
    const results = index.search('think');
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe('laptop');
  });

  test('prefix matching: sums frequencies when prefix matches multiple terms', () => {
    index.buildIndexWithContent([
      {
        slug: 'a',
        frontmatter: { title: 'Note', date: '2026-01-01', tags: [], related: [] },
        content: 'computer components computation',
      },
    ]);
    const results = index.search('comp');
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  test('prefix matching: minimum length 3 — two-char terms require exact match', () => {
    index.buildIndexWithContent([
      {
        slug: 'a',
        frontmatter: { title: 'Note', date: '2026-01-01', tags: [], related: [] },
        content: 'the theorem is theoretical',
      },
    ]);
    const results = index.search('th');
    expect(results).toHaveLength(0);
  });

  test('prefix matching: exact match still works for short terms', () => {
    index.buildIndexWithContent([
      {
        slug: 'a',
        frontmatter: { title: 'Go Language', date: '2026-01-01', tags: ['go'], related: [] },
        content: 'Go is a compiled language.',
      },
    ]);
    const results = index.search('go');
    expect(results).toHaveLength(1);
  });

  test('excerpt includes context around prefix-matched term', () => {
    index.buildIndexWithContent([
      {
        slug: 'a',
        frontmatter: { title: 'Note', date: '2026-01-01', tags: [], related: [] },
        content: 'The ThinkPad X1 Carbon is a great laptop for development work.',
      },
    ]);
    const results = index.search('think');
    expect(results).toHaveLength(1);
    expect(results[0].excerpt.toLowerCase()).toContain('thinkpad');
  });

  test('issue #3 regression: finds ThinkPad note by indirect queries', () => {
    index.buildIndexWithContent([
      {
        slug: 'hardware/thinkpad-x1-carbon',
        frontmatter: {
          title: 'Hardware — ThinkPad X1 Carbon (Arch Laptop)',
          date: '2026-01-01',
          tags: ['hardware', 'laptop', 'arch-linux'],
          related: [],
        },
        content:
          'Spec sheet and setup notes for the ThinkPad X1 Carbon running Arch Linux. ' +
          'Todo: document BIOS settings and power management.',
      },
      {
        slug: 'projects/startup/index',
        frontmatter: { title: 'Startup Project', date: '2026-01-01', tags: ['project'], related: [] },
        content: 'Unrelated startup content.',
      },
    ]);

    // "ThinkPad" — direct title term
    const r1 = index.search('ThinkPad');
    expect(r1.length).toBeGreaterThanOrEqual(1);
    expect(r1[0].slug).toBe('hardware/thinkpad-x1-carbon');

    // "spec laptop todo" — indirect multi-field query
    const r2 = index.search('spec laptop todo');
    expect(r2.length).toBeGreaterThanOrEqual(1);
    expect(r2[0].slug).toBe('hardware/thinkpad-x1-carbon');
  });

  test('buildIndexWithContent indexes related slugs', () => {
    index.buildIndexWithContent([
      {
        slug: 'projects/finances/overview',
        frontmatter: {
          title: 'Finances Overview',
          date: '2026-01-01',
          tags: [],
          related: ['projects/startup-research/index'],
        },
        content: 'My finances overview.',
      },
    ]);
    const results = index.search('startup-research');
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe('projects/finances/overview');
  });

  test('issue #54: single-character search query "C" matches notes mentioning C', () => {
    index.buildIndexWithContent([
      {
        slug: 'c-lang',
        frontmatter: { title: 'The C Programming Language', date: '2026-01-01', tags: ['c'], related: [] },
        content: 'Notes on C.',
      },
      {
        slug: 'rust-lang',
        frontmatter: { title: 'Rust Programming Language', date: '2026-01-01', tags: ['rust'], related: [] },
        content: 'Notes on Rust.',
      },
    ]);
    const results = index.search('C');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].slug).toBe('c-lang');
  });

  test('issue #54: single-character query does not trigger prefix matching', () => {
    // Without the length-3 prefix gate, "c" would match "computer", "code", etc.
    // We keep the gate (prefix-match requires >= 3 chars), so single-char queries
    // are exact-only.
    index.buildIndexWithContent([
      {
        slug: 'a',
        frontmatter: { title: 'Computer Programming', date: '2026-01-01', tags: [], related: [] },
        content: 'About computers.',
      },
    ]);
    // No exact "c" token in the indexed text, so result is empty.
    const results = index.search('c');
    expect(results).toHaveLength(0);
  });

  test('issue #46: excerpt does not center on a related-slug match', () => {
    index.buildIndexWithContent([
      {
        slug: 'overview',
        frontmatter: {
          title: 'Finances Overview',
          date: '2026-01-01',
          tags: [],
          related: ['react-hooks-deep-dive'],
        },
        content: 'A long body of meaningful prose about finances and budgeting.',
      },
    ]);
    const results = index.search('hooks');
    expect(results).toHaveLength(1);
    // Excerpt must come from human-readable text (title or body),
    // not the related slug `react-hooks-deep-dive`.
    expect(results[0].excerpt).not.toMatch(/react-hooks-deep-dive/);
  });

  test('issue #43: search on empty-content corpus does not throw or leak NaN scores', () => {
    // Single note with all-empty fields → docLen = 0 and avgDocLen = 0.
    // The safeAvgDocLen guard prevents x/0 NaN if the inner loop ever reached
    // the BM25 length-normalization line. With current control flow tf === 0
    // short-circuits earlier, but we lock in the defensive contract anyway.
    index.buildIndexWithContent([
      {
        slug: 'empty',
        frontmatter: { title: '', date: '2026-01-01', tags: [], related: [] },
        content: '',
      },
    ]);
    expect(() => index.search('anything')).not.toThrow();
    expect(index.search('anything')).toEqual([]);
  });

  test('issue #43: search on mixed empty + real notes returns finite scores', () => {
    index.buildIndexWithContent([
      {
        slug: 'empty',
        frontmatter: { title: '', date: '2026-01-01', tags: [], related: [] },
        content: '',
      },
      {
        slug: 'real',
        frontmatter: { title: 'Kubernetes', date: '2026-01-01', tags: [], related: [] },
        content: '',
      },
    ]);
    const results = index.search('kubernetes');
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe('real');
    expect(Number.isFinite(results[0].score)).toBe(true);
  });
});
