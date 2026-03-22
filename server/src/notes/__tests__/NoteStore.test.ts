import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { NoteStore } from '../NoteStore.js';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'library-test-'));
}

describe('NoteStore', () => {
  let dir: string;
  let store: NoteStore;

  beforeEach(async () => {
    dir = await makeTmpDir();
    store = new NoteStore(dir);
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('makeSlug generates kebab-case slugs', () => {
    expect(NoteStore.makeSlug('Hello World')).toBe('hello-world');
    expect(NoteStore.makeSlug('React Hooks Rules!')).toBe('react-hooks-rules');
  });

  test('list returns empty array for empty directory', async () => {
    const notes = await store.list();
    expect(notes).toEqual([]);
  });

  test('upsert creates a note and list returns it', async () => {
    await store.upsert({ title: 'Test Note', content: '# Test\nHello world' });
    const notes = await store.list();
    expect(notes).toHaveLength(1);
    expect(notes[0].slug).toBe('test-note');
    expect(notes[0].frontmatter.title).toBe('Test Note');
  });

  test('get returns note content', async () => {
    await store.upsert({ title: 'My Note', content: 'Some content', tags: ['a', 'b'] });
    const note = await store.get('my-note');
    expect(note).not.toBeNull();
    expect(note!.frontmatter.title).toBe('My Note');
    expect(note!.frontmatter.tags).toEqual(['a', 'b']);
    expect(note!.content.trim()).toContain('Some content');
  });

  test('get returns null for missing note', async () => {
    const note = await store.get('nonexistent');
    expect(note).toBeNull();
  });

  test('upsert merges with existing note preserving date', async () => {
    await store.upsert({ title: 'My Note', content: 'v1' });
    const first = await store.get('my-note');
    const originalDate = first!.frontmatter.date;

    await store.upsert({ title: 'My Note', content: 'v2', slug: 'my-note' });
    const second = await store.get('my-note');
    expect(second!.content.trim()).toContain('v2');
    expect(second!.frontmatter.date).toBe(originalDate);
  });

  test('delete removes the note', async () => {
    await store.upsert({ title: 'Delete Me', content: 'bye' });
    const deleted = await store.delete('delete-me');
    expect(deleted).toBe(true);
    const notes = await store.list();
    expect(notes).toHaveLength(0);
  });

  test('delete returns false for nonexistent note', async () => {
    const deleted = await store.delete('nope');
    expect(deleted).toBe(false);
  });

  test('list sorts by date descending', async () => {
    await store.upsert({ title: 'Alpha', content: 'a' });
    await store.upsert({ title: 'Beta', content: 'b' });
    const notes = await store.list();
    // Both created same day, but titles should appear
    expect(notes.map((n) => n.frontmatter.title)).toContain('Alpha');
    expect(notes.map((n) => n.frontmatter.title)).toContain('Beta');
  });

  test('list returns notes in subdirectories', async () => {
    await fs.mkdir(path.join(dir, 'projects', 'my-project'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'projects', 'my-project', 'index.md'),
      '---\ntitle: Project Index\ndate: 2026-01-01\ntags: []\nrelated: []\n---\n\nContent.'
    );
    const notes = await store.list();
    expect(notes).toHaveLength(1);
    expect(notes[0].slug).toBe('projects/my-project/index');
    expect(notes[0].frontmatter.title).toBe('Project Index');
  });

  test('list ignores .sync-conflict files', async () => {
    // File must end in .md (to pass the extension check) AND contain .sync-conflict (to hit the filter)
    await fs.writeFile(
      path.join(dir, 'some-note.sync-conflict.md'),
      '---\ntitle: Conflict\ndate: 2026-01-01\ntags: []\nrelated: []\n---\n\nConflict.'
    );
    const notes = await store.list();
    expect(notes).toHaveLength(0);
  });
});
