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
});
