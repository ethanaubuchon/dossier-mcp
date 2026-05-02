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

    test('move throws a clear error when source and target slugs match', async () => {
      // Defense-in-depth: without the early guard, this would fail at the wx
      // open step with a misleading "already exists" error.
      await store.upsert({ slug: 'same-slug', title: 'Same', content: 'Body.' });
      await expect(store.move('same-slug', 'same-slug')).rejects.toThrow(
        /Source and target slugs are the same/
      );
      // Source must remain intact.
      const stored = await store.get('same-slug');
      expect(stored).not.toBeNull();
      expect(stored!.frontmatter.title).toBe('Same');
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

    test('move rewrites self-reference in moved note\'s related[]', async () => {
      // The moved note's own related[] referenced its old slug. After the move,
      // that entry should point to the new slug (not the now-stale old slug).
      await store.upsert({
        slug: 'old-slug',
        title: 'Self Ref',
        content: 'Body.',
        related: ['old-slug', 'other-slug'],
      });

      const result = await store.move('old-slug', 'new-slug');

      expect(result.note.frontmatter.related).toEqual(['new-slug', 'other-slug']);
      // Read from disk to confirm persistence (not just the in-memory return).
      const persisted = await store.get('new-slug');
      expect(persisted!.frontmatter.related).toEqual(['new-slug', 'other-slug']);
    });

    test('move preserves other frontmatter fields when rewriting self-reference', async () => {
      // Self-ref rewrite path uses matter.stringify; ensure other fields survive.
      await store.upsert({
        slug: 'old-slug',
        title: 'Self Ref',
        content: 'Body.',
        tags: ['a'],
        related: ['old-slug'],
      });

      const result = await store.move('old-slug', 'new-slug');

      expect(result.note.frontmatter.title).toBe('Self Ref');
      expect(result.note.frontmatter.tags).toEqual(['a']);
      expect(result.note.frontmatter.related).toEqual(['new-slug']);
    });

    test('move rolls back the new file when source unlink fails', async () => {
      // Simulate a partial-failure mid-move: target write succeeds, source
      // unlink throws. The post-condition must restore the pre-move state —
      // source intact, target absent.
      await store.upsert({ slug: 'src', title: 'Src', content: 'Body.' });

      const sourcePath = path.join(dir, 'src.md');
      const targetPath = path.join(dir, 'dst.md');
      const realUnlink = fs.unlink.bind(fs);
      const unlinkSpy = jest.spyOn(fs, 'unlink').mockImplementation(async (p) => {
        // Only fail the source-unlink during move(); let the rollback unlink
        // (and any other unlinks) hit the real implementation so the test
        // can clean up and inspect filesystem state correctly.
        if (typeof p === 'string' && p === sourcePath) {
          throw Object.assign(new Error('EACCES: simulated permission denied'), { code: 'EACCES' });
        }
        return realUnlink(p as Parameters<typeof realUnlink>[0]);
      });

      try {
        await expect(store.move('src', 'dst')).rejects.toThrow(/EACCES/);

        // The simulated source-unlink fired (and rollback was triggered).
        expect(unlinkSpy).toHaveBeenCalledWith(sourcePath);

        // Source still exists (unlink failed before deletion).
        await expect(fs.access(sourcePath)).resolves.toBeUndefined();
        // Target was rolled back.
        await expect(fs.access(targetPath)).rejects.toThrow();
      } finally {
        unlinkSpy.mockRestore();
      }
    });
  });

  describe('atomic write', () => {
    // Helper: list any tmp orphans inside the vault (recursively).
    async function findTmpFiles(root: string): Promise<string[]> {
      const out: string[] = [];
      async function walk(d: string): Promise<void> {
        const entries = await fs.readdir(d, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) {
            await walk(full);
          } else if (e.isFile() && /\.tmp\./.test(e.name)) {
            out.push(full);
          }
        }
      }
      await walk(root);
      return out;
    }

    test('upsert leaves no .tmp.* files after a successful write', async () => {
      await store.upsert({ slug: 'happy/path', title: 'Happy', content: 'Body.' });
      const tmps = await findTmpFiles(dir);
      expect(tmps).toEqual([]);
    });

    test('upsert preserves existing content if rename fails partway', async () => {
      // Pre-populate the target with OLD content (via a successful upsert).
      await store.upsert({ slug: 'target', title: 'Target', content: 'OLD' });
      const targetPath = path.join(dir, 'target.md');
      const before = await fs.readFile(targetPath, 'utf-8');
      expect(before).toContain('OLD');

      // Force the rename to throw on the next upsert.
      const renameSpy = jest.spyOn(fs, 'rename').mockImplementation(async () => {
        throw Object.assign(new Error('EIO: simulated rename failure'), { code: 'EIO' });
      });

      try {
        await expect(
          store.upsert({ slug: 'target', title: 'Target', content: 'NEW' })
        ).rejects.toThrow(/rename failure/);

        // Target file is untouched (still OLD, byte-for-byte).
        const after = await fs.readFile(targetPath, 'utf-8');
        expect(after).toBe(before);

        // No tmp orphans left behind.
        const tmps = await findTmpFiles(dir);
        expect(tmps).toEqual([]);
      } finally {
        renameSpy.mockRestore();
      }
    });

    test('upsert leaves target untouched if writeFile to tmp fails', async () => {
      await store.upsert({ slug: 'target', title: 'Target', content: 'OLD' });
      const targetPath = path.join(dir, 'target.md');
      const before = await fs.readFile(targetPath, 'utf-8');

      const writeSpy = jest.spyOn(fs, 'writeFile').mockImplementation(async () => {
        throw Object.assign(new Error('ENOSPC: simulated disk full'), { code: 'ENOSPC' });
      });

      try {
        await expect(
          store.upsert({ slug: 'target', title: 'Target', content: 'NEW' })
        ).rejects.toThrow(/disk full/);

        // Target untouched.
        const after = await fs.readFile(targetPath, 'utf-8');
        expect(after).toBe(before);

        // No tmp orphans (writeFile threw before tmp could be created — but
        // even if a partial tmp existed, the catch block would clean it up).
        const tmps = await findTmpFiles(dir);
        expect(tmps).toEqual([]);
      } finally {
        writeSpy.mockRestore();
      }
    });

    test('move leaves source intact and target absent if link fails (non-EEXIST)', async () => {
      await store.upsert({ slug: 'src', title: 'Src', content: 'Body.' });
      const sourcePath = path.join(dir, 'src.md');
      const targetPath = path.join(dir, 'dst.md');

      const linkSpy = jest.spyOn(fs, 'link').mockImplementation(async () => {
        throw Object.assign(new Error('EACCES: simulated link denied'), { code: 'EACCES' });
      });

      try {
        await expect(store.move('src', 'dst')).rejects.toThrow(/EACCES/);

        // Source still exists at the old slug.
        await expect(fs.access(sourcePath)).resolves.toBeUndefined();
        // Target was never created.
        await expect(fs.access(targetPath)).rejects.toThrow();
        // No tmp orphans left behind.
        const tmps = await findTmpFiles(dir);
        expect(tmps).toEqual([]);
      } finally {
        linkSpy.mockRestore();
      }
    });

    test('move still surfaces "already exists" when target exists', async () => {
      // Verifies the EEXIST -> "already exists" mapping inside writeAtomically
      // preserves the existing contract relied on by the MCP server's
      // user-friendly error mapping.
      await store.upsert({ slug: 'src', title: 'Src', content: 'A.' });
      await store.upsert({ slug: 'dst', title: 'Dst', content: 'B.' });
      await expect(store.move('src', 'dst')).rejects.toThrow(/already exists/);
      // No tmp orphans either way.
      const tmps = await findTmpFiles(dir);
      expect(tmps).toEqual([]);
    });

    test('chokidar emits at most one coalesced change for a single upsert', async () => {
      // The atomic-write tmp lifecycle (writeFile + rename, ms-scale) must NOT
      // trigger separate watcher events. awaitWriteFinish's stability window
      // is what keeps the watcher quiet during the brief tmp lifecycle —
      // verifying that here.
      let changeCount = 0;
      store.on('change', () => { changeCount++; });

      await store.upsert({ slug: 'watched-note', title: 'Watched', content: 'Body.' });

      // awaitWriteFinish stability (500ms) + debounce (300ms) + slack for CI.
      await new Promise((resolve) => setTimeout(resolve, 1200));

      expect(changeCount).toBeLessThanOrEqual(1);
    }, 5000);
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
