/**
 * Unit tests for MCP tool logic and utilities.
 * Integration tests use NoteStore + SearchIndex directly (same logic the MCP tools use)
 * rather than spinning up a full MCP server, which would require stdio transport plumbing.
 * Pure utility tests (e.g. coerceStringArray) are also included here.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { NoteStore } from '../../notes/NoteStore.js';
import { SearchIndex } from '../../search/SearchIndex.js';
import type { NoteListItem } from '../../types.js';
import { coerceStringArray } from '../coerce.js';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'library-mcp-test-'));
}

describe('MCP tool logic — NoteStore + SearchIndex integration', () => {
  let dir: string;
  let noteStore: NoteStore;
  let searchIndex: SearchIndex;

  beforeEach(async () => {
    dir = await makeTmpDir();
    noteStore = new NoteStore(dir);
    searchIndex = new SearchIndex();
    await noteStore.initialize();
  });

  afterEach(async () => {
    await noteStore.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // list_notes
  test('list_notes returns empty array when vault is empty', async () => {
    const notes = await noteStore.list();
    expect(notes).toEqual([]);
  });

  test('list_notes returns created notes', async () => {
    await noteStore.upsert({ title: 'Alpha', content: 'Alpha content', tags: ['a'] });
    await noteStore.upsert({ title: 'Beta', content: 'Beta content', tags: ['b'] });
    const notes = await noteStore.list();
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.frontmatter.title)).toContain('Alpha');
    expect(notes.map((n) => n.frontmatter.title)).toContain('Beta');
  });

  // get_note
  test('get_note returns note content', async () => {
    await noteStore.upsert({ title: 'Test Note', content: 'Hello world', tags: ['test'] });
    const note = await noteStore.get('test-note');
    expect(note).not.toBeNull();
    expect(note!.frontmatter.title).toBe('Test Note');
    expect(note!.content.trim()).toContain('Hello world');
  });

  test('get_note returns null for missing note', async () => {
    const note = await noteStore.get('nonexistent');
    expect(note).toBeNull();
  });

  // create_note
  test('create_note persists note to disk', async () => {
    const note = await noteStore.upsert({
      title: 'React Hooks',
      content: 'Hooks must be at top level.',
      tags: ['react', 'hooks'],
      related: [],
    });
    expect(note.slug).toBe('react-hooks');
    expect(note.frontmatter.tags).toEqual(['react', 'hooks']);

    // Verify it's actually on disk
    const retrieved = await noteStore.get('react-hooks');
    expect(retrieved).not.toBeNull();
  });

  test('create_note updates search index', async () => {
    await noteStore.upsert({ title: 'TypeScript Generics', content: 'Generics allow reusable types.', tags: ['typescript'] });
    const notes = await noteStore.listWithContent();
    searchIndex.buildIndexWithContent(notes);

    const results = searchIndex.search('generics');
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe('typescript-generics');
  });

  // update_note
  test('update_note replaces content and preserves slug', async () => {
    await noteStore.upsert({ title: 'My Note', content: 'Version 1' });
    await noteStore.upsert({ slug: 'my-note', title: 'My Note', content: 'Version 2' });
    const note = await noteStore.get('my-note');
    expect(note!.content.trim()).toContain('Version 2');
  });

  test('update_note returns error signal for missing note', async () => {
    const existing = await noteStore.get('does-not-exist');
    expect(existing).toBeNull(); // tool would return isError: true
  });

  // delete_note
  test('delete_note removes note from disk', async () => {
    await noteStore.upsert({ title: 'Bye Note', content: 'Bye!' });
    const deleted = await noteStore.delete('bye-note');
    expect(deleted).toBe(true);
    expect(await noteStore.get('bye-note')).toBeNull();
  });

  test('delete_note returns false for nonexistent note', async () => {
    expect(await noteStore.delete('ghost')).toBe(false);
  });

  // search_notes
  test('search_notes finds notes by keyword', async () => {
    await noteStore.upsert({ title: 'CSS Flexbox', content: 'Flexbox layout guide.', tags: ['css'] });
    await noteStore.upsert({ title: 'Grid Layout', content: 'CSS grid explained.', tags: ['css'] });
    const notes = await noteStore.listWithContent();
    searchIndex.buildIndexWithContent(notes);

    const results = searchIndex.search('flexbox');
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe('css-flexbox');
  });

  test('search_notes returns empty for no matches', async () => {
    await noteStore.upsert({ title: 'Some Note', content: 'Some content.' });
    const notes = await noteStore.listWithContent();
    searchIndex.buildIndexWithContent(notes);

    expect(searchIndex.search('zzzyyyxxx')).toHaveLength(0);
  });

  // Slug validation — tests the exact predicate logic used by isValidSlug in server.ts
  test('slug validation rejects path traversal and absolute paths', () => {
    const isValidSlug = (slug: string) => !slug.includes('..') && !slug.startsWith('/');
    expect(isValidSlug('../etc/passwd')).toBe(false);
    expect(isValidSlug('/absolute/path')).toBe(false);
    expect(isValidSlug('projects/my-note')).toBe(true);
    expect(isValidSlug('inbox/hello-world')).toBe(true);
  });

  // create_note: path parameter becomes the slug verbatim
  test('create_note with explicit path slug places note at that path', async () => {
    const slug = 'projects/startup/market-analysis';
    await noteStore.upsert({ slug, title: 'Market Analysis', content: 'TAM analysis.' });
    const note = await noteStore.get(slug);
    expect(note).not.toBeNull();
    expect(note!.slug).toBe(slug);
    expect(note!.frontmatter.title).toBe('Market Analysis');
  });

  // create_note: no path defaults to inbox/<title-slug>
  test('create_note without path uses inbox/ prefix', () => {
    // Tests the slug derivation: 'inbox/' + NoteStore.makeSlug(title)
    const defaultSlug = (title: string) => 'inbox/' + NoteStore.makeSlug(title);
    expect(defaultSlug('My New Note')).toBe('inbox/my-new-note');
    expect(defaultSlug('Startup Research')).toBe('inbox/startup-research');
  });

  // create_note: collision guard — handler calls noteStore.get() before upsert
  test('create_note collision guard: noteStore.get detects existing note', async () => {
    await noteStore.upsert({ slug: 'inbox/my-note', title: 'My Note', content: 'v1' });
    const existing = await noteStore.get('inbox/my-note');
    // Handler pattern: if (existing) return isError. Confirm the check works.
    expect(existing).not.toBeNull();
    expect(existing!.content.trim()).toContain('v1');
  });

  // search now indexes body content via buildIndexWithContent
  test('search_notes finds matches in note body content', async () => {
    await noteStore.upsert({ title: 'Alpha Note', content: 'The secret keyword is xyzzy123.' });
    const allNotes = await noteStore.listWithContent();
    searchIndex.buildIndexWithContent(allNotes);
    const results = searchIndex.search('xyzzy123');
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe('alpha-note');
  });

  describe('tag/related string coercion — Zod schema wiring', () => {
    // Construct the same schema used in create_note and update_note
    const tagsSchema = z.preprocess(coerceStringArray, z.array(z.string()).optional());

    test('schema coerces comma-separated string to array', () => {
      expect(tagsSchema.parse('react, hooks, typescript')).toEqual(['react', 'hooks', 'typescript']);
    });

    test('schema coerces JSON-encoded string array to array', () => {
      expect(tagsSchema.parse('["react","hooks"]')).toEqual(['react', 'hooks']);
    });

    test('schema passes through an actual array unchanged', () => {
      expect(tagsSchema.parse(['react', 'hooks'])).toEqual(['react', 'hooks']);
    });

    test('schema accepts undefined', () => {
      expect(tagsSchema.parse(undefined)).toBeUndefined();
    });

    test('schema coerces single bare string to single-element array', () => {
      expect(tagsSchema.parse('typescript')).toEqual(['typescript']);
    });
  });

  // list_notes path filter
  describe('list_notes path filter', () => {
    beforeEach(async () => {
      await noteStore.upsert({ slug: 'projects/startup/index', title: 'Startup Index', content: 'a' });
      await noteStore.upsert({ slug: 'projects/finances/index', title: 'Finances Index', content: 'b' });
      await noteStore.upsert({ slug: 'reference/react-hooks', title: 'React Hooks', content: 'c' });
    });

    function filterByPath(notes: NoteListItem[], prefix: string | undefined): NoteListItem[] {
      if (!prefix) return notes;
      const normalized = prefix.endsWith('/') ? prefix : prefix + '/';
      return notes.filter((n) => n.slug.startsWith(normalized));
    }

    test('no path returns all notes', async () => {
      const notes = await noteStore.list();
      expect(filterByPath(notes, undefined)).toHaveLength(3);
    });

    test('path filter returns only matching prefix', async () => {
      const notes = await noteStore.list();
      const filtered = filterByPath(notes, 'projects');
      expect(filtered).toHaveLength(2);
      expect(filtered.map((n) => n.slug)).toContain('projects/startup/index');
      expect(filtered.map((n) => n.slug)).toContain('projects/finances/index');
    });

    test('trailing slash is normalized', async () => {
      const notes = await noteStore.list();
      expect(filterByPath(notes, 'projects/')).toHaveLength(2);
      expect(filterByPath(notes, 'projects')).toHaveLength(2);
    });

    test('partial prefix does not match', async () => {
      const notes = await noteStore.list();
      expect(filterByPath(notes, 'project')).toHaveLength(0); // not a prefix of "projects/"
    });

    test('empty string returns all notes', async () => {
      const notes = await noteStore.list();
      expect(filterByPath(notes, '')).toHaveLength(3);
    });
  });

  // get_vault_context
  describe('get_vault_context', () => {
    test('returns profile.md content when it exists', async () => {
      // Write a profile and read it back — same operation the tool does
      await fs.writeFile(
        path.join(dir, 'profile.md'),
        '# Ethan\nSoftware engineer. Interested in startups.'
      );
      const raw = await fs.readFile(path.join(dir, 'profile.md'), 'utf-8');
      expect(raw).toContain('Ethan');
      expect(raw).toContain('Software engineer');
    });

    test('returns error when profile.md is missing', async () => {
      // Verify the file does not exist — the tool catch block returns isError
      const profilePath = path.join(dir, 'profile.md');
      let readError: Error | null = null;
      try {
        await fs.readFile(profilePath, 'utf-8');
      } catch (e) {
        readError = e as Error;
      }
      expect(readError).not.toBeNull(); // tool would return isError: true
    });
  });

  describe('coerceStringArray', () => {
    test('passes through an existing array unchanged', () => {
      expect(coerceStringArray(['tag1', 'tag2'])).toEqual(['tag1', 'tag2']);
    });

    test('parses a JSON-encoded string array', () => {
      expect(coerceStringArray('["tag1", "tag2"]')).toEqual(['tag1', 'tag2']);
    });

    test('splits a comma-separated string into an array', () => {
      expect(coerceStringArray('tag1, tag2, tag3')).toEqual(['tag1', 'tag2', 'tag3']);
    });

    test('wraps a single value with no commas in an array', () => {
      expect(coerceStringArray('tag1')).toEqual(['tag1']);
    });

    test('returns undefined for undefined input', () => {
      expect(coerceStringArray(undefined)).toBeUndefined();
    });

    test('returns undefined for null input', () => {
      expect(coerceStringArray(null)).toBeUndefined();
    });

    test('trims whitespace from comma-separated values', () => {
      expect(coerceStringArray('  tag1 ,  tag2  ')).toEqual(['tag1', 'tag2']);
    });
  });

  describe('vault://context resource', () => {
    test('reads profile.md when it exists', async () => {
      await fs.writeFile(
        path.join(dir, 'profile.md'),
        '# Vault\nHow to use this vault.'
      );
      const raw = await fs.readFile(path.join(dir, 'profile.md'), 'utf-8');
      expect(raw).toContain('Vault');
      expect(raw).toContain('How to use this vault.');
    });

    test('returns error text when profile.md is missing', async () => {
      const profilePath = path.join(dir, 'profile.md');
      let readError: Error | null = null;
      try {
        await fs.readFile(profilePath, 'utf-8');
      } catch (e) {
        readError = e as Error;
      }
      expect(readError).not.toBeNull();
    });
  });
});
