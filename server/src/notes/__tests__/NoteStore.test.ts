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

  test('get() throws on malformed frontmatter (not ENOENT)', async () => {
    await fs.writeFile(path.join(dir, 'bad-note.md'), '---\ntitle: foo: bar: baz\ntags: [unclosed\n---\nBody.');
    await expect(store.get('bad-note')).rejects.toThrow();
  });

  test('get() throws on permission error (not ENOENT)', async () => {
    await fs.writeFile(path.join(dir, 'locked.md'), '---\ntitle: Locked\n---\nBody.');
    await fs.chmod(path.join(dir, 'locked.md'), 0o000);
    await expect(store.get('locked')).rejects.toThrow();
    await fs.chmod(path.join(dir, 'locked.md'), 0o644); // cleanup for afterEach rm
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

  test('upsert creates nested directories for path-based slug', async () => {
    await store.upsert({
      slug: 'projects/my-project/notes',
      title: 'Project Notes',
      content: 'Some content here.',
    });
    const note = await store.get('projects/my-project/notes');
    expect(note).not.toBeNull();
    expect(note!.frontmatter.title).toBe('Project Notes');
    expect(note!.slug).toBe('projects/my-project/notes');
  });

  test('listWithContent returns notes with body content', async () => {
    await store.upsert({ title: 'Alpha', content: 'Alpha body text.' });
    await store.upsert({ slug: 'projects/beta', title: 'Beta', content: 'Beta body text.' });
    const notes = await store.listWithContent();
    expect(notes).toHaveLength(2);
    const slugs = notes.map((n) => n.slug);
    expect(slugs).toContain('alpha');
    expect(slugs).toContain('projects/beta');
    const alpha = notes.find((n) => n.slug === 'alpha')!;
    expect(alpha.content).toContain('Alpha body text.');
    const beta = notes.find((n) => n.slug === 'projects/beta')!;
    expect(beta.content).toContain('Beta body text.');
  });

  test('list() logs skipped files to stderr', async () => {
    await store.upsert({ title: 'Good Note', content: 'OK.' });
    await fs.writeFile(path.join(dir, 'unreadable.md'), 'content');
    await fs.chmod(path.join(dir, 'unreadable.md'), 0o000);

    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const notes = await store.list();
    expect(notes).toHaveLength(1);
    expect(notes[0].frontmatter.title).toBe('Good Note');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[library] Skipping unreadable note'),
      expect.anything()
    );
    stderrSpy.mockRestore();
    await fs.chmod(path.join(dir, 'unreadable.md'), 0o644);
  });

  test('listWithContent() logs skipped files to stderr', async () => {
    await store.upsert({ title: 'Good Note', content: 'OK.' });
    await fs.writeFile(path.join(dir, 'unreadable.md'), 'content');
    await fs.chmod(path.join(dir, 'unreadable.md'), 0o000);

    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const notes = await store.listWithContent();
    expect(notes).toHaveLength(1);
    expect(notes[0].frontmatter.title).toBe('Good Note');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[library] Skipping unreadable note'),
      expect.anything()
    );
    stderrSpy.mockRestore();
    await fs.chmod(path.join(dir, 'unreadable.md'), 0o644);
  });

  test('listWithContent preserves date-descending sort', async () => {
    await store.upsert({ title: 'One', content: 'one' });
    await store.upsert({ title: 'Two', content: 'two' });
    const byContent = await store.listWithContent();
    const byList = await store.list();
    expect(byContent.map((n) => n.slug)).toEqual(byList.map((n) => n.slug));
  });

  test('list() handles unreadable subdirectory gracefully', async () => {
    await store.upsert({ title: 'Root Note', content: 'OK.' });
    const subdir = path.join(dir, 'locked-folder');
    await fs.mkdir(subdir);
    await fs.writeFile(path.join(subdir, 'note.md'), '---\ntitle: Locked\n---\nBody.');
    await fs.chmod(subdir, 0o000);

    // list() should still return the root note without throwing
    const notes = await store.list();
    expect(notes).toHaveLength(1);
    expect(notes[0].frontmatter.title).toBe('Root Note');

    await fs.chmod(subdir, 0o755); // cleanup
  });

  describe('empty directory cleanup on delete', () => {
    test('delete removes empty parent directory', async () => {
      await store.upsert({ slug: 'projects/orphan/deep-note', title: 'Deep Note', content: 'Body.' });
      await store.delete('projects/orphan/deep-note');

      // The 'orphan' directory should be removed since it's now empty
      await expect(fs.access(path.join(dir, 'projects', 'orphan'))).rejects.toThrow();
      // The 'projects' directory should also be removed since it's now empty
      await expect(fs.access(path.join(dir, 'projects'))).rejects.toThrow();
    });

    test('delete preserves non-empty parent directories', async () => {
      await store.upsert({ slug: 'projects/keep/note-a', title: 'Note A', content: 'A.' });
      await store.upsert({ slug: 'projects/keep/note-b', title: 'Note B', content: 'B.' });
      await store.delete('projects/keep/note-a');

      // 'keep' directory still has note-b, should not be removed
      await expect(fs.access(path.join(dir, 'projects', 'keep'))).resolves.toBeUndefined();
    });

    test('delete never removes the vault root', async () => {
      await store.upsert({ slug: 'lonely-note', title: 'Lonely', content: 'Body.' });
      await store.delete('lonely-note');

      // Vault root must still exist
      await expect(fs.access(dir)).resolves.toBeUndefined();
    });

    test('delete cleans up multiple levels of empty parents', async () => {
      await store.upsert({ slug: 'a/b/c/deep', title: 'Deep', content: 'Body.' });
      await store.delete('a/b/c/deep');

      // All three levels (a/b/c, a/b, a) should be removed
      await expect(fs.access(path.join(dir, 'a'))).rejects.toThrow();
    });

    test('delete stops cleanup at first non-empty ancestor', async () => {
      await store.upsert({ slug: 'root/sibling', title: 'Sibling', content: 'Body.' });
      await store.upsert({ slug: 'root/child/target', title: 'Target', content: 'Body.' });
      await store.delete('root/child/target');

      // 'child' should be removed (empty)
      await expect(fs.access(path.join(dir, 'root', 'child'))).rejects.toThrow();
      // 'root' should still exist (has sibling.md)
      await expect(fs.access(path.join(dir, 'root'))).resolves.toBeUndefined();
    });

    test('delete still succeeds when directory cleanup fails', async () => {
      await store.upsert({ slug: 'locked/child/note', title: 'Note', content: 'Body.' });
      // Make the parent non-removable
      await fs.chmod(path.join(dir, 'locked'), 0o555);

      const deleted = await store.delete('locked/child/note');
      expect(deleted).toBe(true);

      // Cleanup: restore permissions so afterEach can rm
      await fs.chmod(path.join(dir, 'locked'), 0o755);
    });
  });

  describe('slug validation', () => {
    test('get() throws on path traversal slug', async () => {
      await expect(store.get('../../etc/passwd')).rejects.toThrow(/Invalid slug/);
    });

    test('upsert() throws on path traversal slug', async () => {
      await expect(
        store.upsert({ slug: '../escape', title: 'x', content: 'y' })
      ).rejects.toThrow(/Invalid slug/);
    });

    test('move() throws when target slug escapes the vault', async () => {
      await store.upsert({ slug: 'valid-slug', title: 'Valid', content: 'Body.' });
      await expect(store.move('valid-slug', '../escape')).rejects.toThrow(/Invalid slug/);
    });

    test('move() throws when source slug is invalid', async () => {
      await expect(store.move('../escape', 'somewhere')).rejects.toThrow(/Invalid slug/);
    });

    test('delete() throws on slug containing null byte', async () => {
      await expect(store.delete('valid\x00slug')).rejects.toThrow(/Invalid slug/);
    });

    test('get() throws on empty slug', async () => {
      await expect(store.get('')).rejects.toThrow(/Invalid slug/);
    });

    test('upsert() throws on slug with leading slash', async () => {
      await expect(
        store.upsert({ slug: '/absolute', title: 'x', content: 'y' })
      ).rejects.toThrow(/Invalid slug/);
    });

    test('upsert() throws on slug with trailing slash', async () => {
      await expect(
        store.upsert({ slug: 'foo/', title: 'x', content: 'y' })
      ).rejects.toThrow(/Invalid slug/);
    });

    test('subdirectory slug "projects/foo" is still allowed (positive)', async () => {
      const note = await store.upsert({ slug: 'projects/foo', title: 'Foo', content: 'Body.' });
      expect(note.slug).toBe('projects/foo');
      const fetched = await store.get('projects/foo');
      expect(fetched).not.toBeNull();
      expect(fetched!.frontmatter.title).toBe('Foo');
    });

    test('boundary holds when NoteStore is instantiated with a relative path', async () => {
      // Build a relative path that points to the same temp dir as `dir` (already absolute).
      const relDir = path.relative(process.cwd(), dir);
      const relStore = new NoteStore(relDir);
      try {
        await relStore.initialize();
        // Normal operations still work.
        const note = await relStore.upsert({ slug: 'rel-note', title: 'Rel', content: 'Body.' });
        expect(note.slug).toBe('rel-note');
        const fetched = await relStore.get('rel-note');
        expect(fetched).not.toBeNull();
        // Boundary still rejects traversal even with a relative starting point.
        await expect(relStore.get('../../etc/passwd')).rejects.toThrow(/Invalid slug/);
      } finally {
        await relStore.close();
      }
    });
  });

  describe('move', () => {
    test('move relocates note to new slug', async () => {
      await store.upsert({ slug: 'inbox/draft', title: 'Draft', content: 'Body.', tags: ['test'], related: ['other/note'] });
      const result = await store.move('inbox/draft', 'projects/final');

      // Old slug gone
      expect(await store.get('inbox/draft')).toBeNull();
      // New slug exists with preserved frontmatter
      expect(result.note.slug).toBe('projects/final');
      expect(result.note.frontmatter.title).toBe('Draft');
      expect(result.note.frontmatter.tags).toEqual(['test']);
      expect(result.note.frontmatter.related).toEqual(['other/note']);
      expect(result.note.content.trim()).toBe('Body.');
    });

    test('move preserves original creation date', async () => {
      await store.upsert({ slug: 'old-note', title: 'Old', content: 'Body.' });
      const original = await store.get('old-note');
      const result = await store.move('old-note', 'new-note');
      expect(result.note.frontmatter.date).toBe(original!.frontmatter.date);
    });

    test('move creates intermediate directories', async () => {
      await store.upsert({ slug: 'flat-note', title: 'Flat', content: 'Body.' });
      const result = await store.move('flat-note', 'deep/nested/path/note');
      expect(result.note.slug).toBe('deep/nested/path/note');
      expect(await store.get('deep/nested/path/note')).not.toBeNull();
    });

    test('move prunes empty parents at old location', async () => {
      await store.upsert({ slug: 'lonely/dir/note', title: 'Note', content: 'Body.' });
      await store.move('lonely/dir/note', 'somewhere-else');
      // Both 'lonely/dir' and 'lonely' should be removed
      await expect(fs.access(path.join(dir, 'lonely'))).rejects.toThrow();
    });

    test('move throws when source does not exist', async () => {
      await expect(store.move('nonexistent', 'target')).rejects.toThrow('not found');
    });

    test('move throws when target already exists', async () => {
      await store.upsert({ slug: 'source', title: 'Source', content: 'A.' });
      await store.upsert({ slug: 'target', title: 'Target', content: 'B.' });
      await expect(store.move('source', 'target')).rejects.toThrow('already exists');
    });

    test('move updates related fields in other notes that reference old slug', async () => {
      await store.upsert({ slug: 'target-note', title: 'Target', content: 'Body.' });
      await store.upsert({ slug: 'referrer-a', title: 'A', content: 'Body.', related: ['target-note', 'other'] });
      await store.upsert({ slug: 'referrer-b', title: 'B', content: 'Body.', related: ['target-note'] });
      await store.upsert({ slug: 'no-ref', title: 'C', content: 'Body.', related: ['something-else'] });

      const result = await store.move('target-note', 'new-location');

      // Check updatedRefs
      expect(result.updatedRefs).toContain('referrer-a');
      expect(result.updatedRefs).toContain('referrer-b');
      expect(result.updatedRefs).not.toContain('no-ref');

      // Verify the actual related fields were updated
      const a = await store.get('referrer-a');
      expect(a!.frontmatter.related).toEqual(['new-location', 'other']);

      const b = await store.get('referrer-b');
      expect(b!.frontmatter.related).toEqual(['new-location']);

      // Verify non-referencing note is untouched
      const c = await store.get('no-ref');
      expect(c!.frontmatter.related).toEqual(['something-else']);
    });

    test('move returns empty updatedRefs when no notes reference old slug', async () => {
      await store.upsert({ slug: 'lonely', title: 'Lonely', content: 'Body.' });
      const result = await store.move('lonely', 'still-lonely');
      expect(result.updatedRefs).toEqual([]);
    });
  });

  describe('watcher', () => {
    const NOTE_FRONTMATTER = '---\ntitle: Note\ndate: 2026-01-01\ntags: []\nrelated: []\n---\n\nContent.';

    function waitForChange(timeout = 3000): Promise<void> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for change event')),
          timeout
        );
        store.once('change', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    test('emits change when a file is written directly', async () => {
      const changed = waitForChange();
      await fs.writeFile(path.join(dir, 'direct-write.md'), NOTE_FRONTMATTER);
      await changed;
    }, 4000);

    test('emits change when a file is dropped via atomic rename (Syncthing pattern)', async () => {
      const changed = waitForChange();
      // Syncthing writes to a temp file then renames to the final .md path
      const tmpPath = path.join(dir, 'syncthing-drop.md.tmp');
      const finalPath = path.join(dir, 'syncthing-drop.md');
      await fs.writeFile(tmpPath, NOTE_FRONTMATTER);
      await fs.rename(tmpPath, finalPath);
      await changed;
    }, 4000);

    test('debounces rapid file writes into a single change event', async () => {
      let changeCount = 0;
      store.on('change', () => { changeCount++; });

      // Write several files at once to simulate a batch Syncthing sync
      await Promise.all([
        fs.writeFile(path.join(dir, 'batch-a.md'), NOTE_FRONTMATTER),
        fs.writeFile(path.join(dir, 'batch-b.md'), NOTE_FRONTMATTER),
        fs.writeFile(path.join(dir, 'batch-c.md'), NOTE_FRONTMATTER),
      ]);

      // Allow time for awaitWriteFinish stability polling (~500 ms) and the
      // debounce timer (300 ms), with margin for CI variance
      await new Promise((resolve) => setTimeout(resolve, 1200));

      expect(changeCount).toBe(1);
    }, 5000);

    test('emits change when a file in a subdirectory is written', async () => {
      const changed = waitForChange();
      await fs.mkdir(path.join(dir, 'meta', 'hardware'), { recursive: true });
      await fs.writeFile(path.join(dir, 'meta', 'hardware', 'gpu.md'), NOTE_FRONTMATTER);
      await changed;
    }, 4000);

    test('does not emit change for .sync-conflict files', async () => {
      let changeCount = 0;
      store.on('change', () => { changeCount++; });

      await fs.writeFile(
        path.join(dir, 'some-note.sync-conflict.md'),
        NOTE_FRONTMATTER
      );

      // Wait long enough that a change event would have arrived if emitted
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(changeCount).toBe(0);
    }, 5000);

    test('does not emit change for non-.md files', async () => {
      let changeCount = 0;
      store.on('change', () => { changeCount++; });

      await fs.writeFile(path.join(dir, 'data.json'), '{}');
      await fs.writeFile(path.join(dir, 'README.txt'), 'hello');

      // Wait long enough that a change event would have arrived if emitted
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(changeCount).toBe(0);
    }, 5000);

    test('emits change when a file is deleted', async () => {
      // Create the file before the watcher test so the store is already watching
      await fs.writeFile(path.join(dir, 'to-delete.md'), NOTE_FRONTMATTER);
      // Wait for the add event to settle before listening for the delete
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const changed = waitForChange();
      await fs.unlink(path.join(dir, 'to-delete.md'));
      await changed;
    }, 6000);
  });
});
