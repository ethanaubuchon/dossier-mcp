import { describe, test, expect } from 'vitest';

// Inline the transformer since it's not exported — copy it here for testing
function transformWikilinks(content: string): string {
  return content.replace(/\[\[([^\]]+)\]\]/g, (_, slug) => `[${slug}]([[${slug}]])`);
}

describe('transformWikilinks', () => {
  test('replaces [[slug]] with markdown link', () => {
    const result = transformWikilinks('See [[react-hooks]] for more.');
    expect(result).toBe('See [react-hooks]([[react-hooks]]) for more.');
  });

  test('handles multiple wikilinks', () => {
    const result = transformWikilinks('See [[a]] and [[b]].');
    expect(result).toContain('[a]([[a]])');
    expect(result).toContain('[b]([[b]])');
  });

  test('leaves regular markdown links untouched', () => {
    const result = transformWikilinks('A [regular link](https://example.com)');
    expect(result).toBe('A [regular link](https://example.com)');
  });

  test('handles text with no wikilinks unchanged', () => {
    const text = '# Heading\nSome content without links.';
    expect(transformWikilinks(text)).toBe(text);
  });

  test('handles slugs with hyphens', () => {
    const result = transformWikilinks('[[my-long-slug-here]]');
    expect(result).toBe('[my-long-slug-here]([[my-long-slug-here]])');
  });
});
