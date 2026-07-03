import { updateWikiLinks } from '../wikilinks.js';

describe('updateWikiLinks', () => {
  test('rewrites a plain [[old]] link', () => {
    const out = updateWikiLinks('see [[old]] here', 'old', 'new');
    expect(out).toEqual({ content: 'see [[new]] here', changed: true });
  });

  test('preserves an alias suffix', () => {
    const out = updateWikiLinks('[[old|Display Text]]', 'old', 'new');
    expect(out.content).toBe('[[new|Display Text]]');
  });

  test('preserves a heading anchor', () => {
    const out = updateWikiLinks('[[old#Section]]', 'old', 'new');
    expect(out.content).toBe('[[new#Section]]');
  });

  test('preserves a heading + alias suffix', () => {
    const out = updateWikiLinks('[[old#Section|Alias]]', 'old', 'new');
    expect(out.content).toBe('[[new#Section|Alias]]');
  });

  test('does not touch a partial-slug match', () => {
    const out = updateWikiLinks('[[old-extra]] and [[oldish]]', 'old', 'new');
    expect(out).toEqual({ content: '[[old-extra]] and [[oldish]]', changed: false });
  });

  test('handles slugs containing slashes and dashes', () => {
    const out = updateWikiLinks('[[projects/dossier-mcp/old-note]]', 'projects/dossier-mcp/old-note', 'projects/dossier-mcp/new-note');
    expect(out.content).toBe('[[projects/dossier-mcp/new-note]]');
  });

  test('leaves a link inside a fenced code block untouched', () => {
    const input = 'real [[old]]\n\n```md\n[[old]]\n```\n';
    const out = updateWikiLinks(input, 'old', 'new');
    expect(out.content).toBe('real [[new]]\n\n```md\n[[old]]\n```\n');
  });

  test('rewrites a link after a fence while leaving the fenced one intact', () => {
    // Exercises index alignment: the masked fence must not shift the offset of
    // the post-fence match.
    const input = '```\n[[old]]\n```\n\nafter [[old]]';
    const out = updateWikiLinks(input, 'old', 'new');
    expect(out.content).toBe('```\n[[old]]\n```\n\nafter [[new]]');
  });

  test('rewrites every occurrence', () => {
    const out = updateWikiLinks('[[old]] x [[old]] y [[old|a]]', 'old', 'new');
    expect(out.content).toBe('[[new]] x [[new]] y [[new|a]]');
  });

  test('does not touch plain (unbracketed) text matching the slug', () => {
    const out = updateWikiLinks('the word old appears but old is not a link', 'old', 'new');
    expect(out).toEqual({ content: 'the word old appears but old is not a link', changed: false });
  });

  test('reports changed:false when there is no match', () => {
    const out = updateWikiLinks('nothing to see', 'old', 'new');
    expect(out).toEqual({ content: 'nothing to see', changed: false });
  });

  test('is a no-op when oldSlug equals newSlug', () => {
    const out = updateWikiLinks('[[same]]', 'same', 'same');
    expect(out).toEqual({ content: '[[same]]', changed: false });
  });
});
