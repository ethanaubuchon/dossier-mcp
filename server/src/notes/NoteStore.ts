import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import slugifyLib from 'slugify';
import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'events';
import type { Note, NoteListItem, NoteFrontmatter } from '../types.js';

// slugify CJS/ESM compat: the callable may be the default export or the module itself
const slugify = (slugifyLib as unknown as (text: string, options?: object) => string);

export class NoteStore extends EventEmitter {
  private notesDir: string;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(notesDir: string) {
    super();
    // Resolve to an absolute path so the boundary check in notePath() and the
    // ancestor walk in pruneEmptyParents() are stable regardless of cwd.
    this.notesDir = path.resolve(notesDir);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.notesDir, { recursive: true });
    await this.startWatcher();
  }

  private startWatcher(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Chokidar v4 dropped glob support — watch the directory directly and
      // filter to .md files via `ignored`. The previous **/*.md glob was treated
      // as a literal path that doesn't exist, so no events were ever emitted.
      this.watcher = chokidar.watch(this.notesDir, {
        ignoreInitial: true,
        persistent: true,
        ignored: (filePath: string, stats?: import('fs').Stats) =>
          // Exclude Syncthing conflict copies and any non-.md files.
          // When stats are available, directories are always allowed through so
          // chokidar descends into subdirectories. Without stats (initial scan
          // pass), we also allow anything without an extension to pass through.
          filePath.includes('.sync-conflict') ||
          (stats?.isFile() === true && !filePath.endsWith('.md')),
        // awaitWriteFinish polls stat() after an add/change event and delays
        // emitting until the file size has been stable for stabilityThreshold ms.
        // This prevents a premature event when the OS delivers the notification
        // before the file content is fully flushed. Chokidar's built-in `atomic`
        // option (enabled by default) handles Syncthing's write-to-temp-then-rename
        // pattern; the `ignored` predicate above prevents events for .tmp files.
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      });

      const onChange = () => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          this.emit('change');
        }, 300).unref();
      };

      this.watcher.on('add', onChange);
      this.watcher.on('change', onChange);
      this.watcher.on('unlink', onChange);

      const onStartupError = (err: unknown) => reject(err);
      this.watcher.once('error', onStartupError);
      this.watcher.once('ready', () => {
        this.watcher!.off('error', onStartupError);
        this.watcher!.on('error', (err) => {
          console.error('[library] Chokidar watcher error:', err);
          this.emit('watcherError', err);
        });
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  static makeSlug(title: string): string {
    return slugify(title, { lower: true, strict: true });
  }

  private validateSlug(slug: string): void {
    if (slug.length === 0) {
      throw new Error('Invalid slug: must be non-empty');
    }
    if (slug.includes('\0')) {
      throw new Error('Invalid slug: contains null byte');
    }
    if (slug.startsWith('/') || slug.endsWith('/')) {
      throw new Error(`Invalid slug "${slug}": must not start or end with "/"`);
    }
    const segments = slug.split('/');
    if (segments.some((seg) => seg === '..')) {
      throw new Error(`Invalid slug "${slug}": must not contain ".." segments`);
    }
  }

  private notePath(slug: string): string {
    this.validateSlug(slug);
    const resolved = path.resolve(this.notesDir, `${slug}.md`);
    // Defense in depth: even if validateSlug ever misses a case, ensure the
    // resolved path stays inside the vault. Using `notesDir + path.sep` prevents
    // matches against sibling directories that share a prefix (e.g. "/vault" vs
    // "/vault-evil").
    if (resolved !== this.notesDir && !resolved.startsWith(this.notesDir + path.sep)) {
      throw new Error(`Invalid slug "${slug}": escapes vault`);
    }
    return resolved;
  }

  async list(): Promise<NoteListItem[]> {
    const mdFiles = await this.walkMdFiles(this.notesDir);
    const notes = await Promise.all(
      mdFiles.map(async (filePath) => {
        const rel = path.relative(this.notesDir, filePath);
        const slug = rel.replace(/\.md$/, '');
        try {
          const raw = await fs.readFile(filePath, 'utf-8');
          const parsed = matter(raw);
          return {
            slug,
            frontmatter: this.parseFrontmatter(parsed.data),
          } as NoteListItem;
        } catch (e) {
          console.error(`[library] Skipping unreadable note "${slug}":`, e instanceof Error ? e.message : e);
          return null;
        }
      })
    );

    return notes
      .filter((n): n is NoteListItem => n !== null)
      .sort((a, b) => b.frontmatter.date.localeCompare(a.frontmatter.date));
  }

  async listWithContent(): Promise<Array<NoteListItem & { content: string }>> {
    const mdFiles = await this.walkMdFiles(this.notesDir);
    const notes = await Promise.all(
      mdFiles.map(async (filePath) => {
        const rel = path.relative(this.notesDir, filePath);
        const slug = rel.replace(/\.md$/, '');
        try {
          const raw = await fs.readFile(filePath, 'utf-8');
          const parsed = matter(raw);
          return {
            slug,
            frontmatter: this.parseFrontmatter(parsed.data),
            content: parsed.content,
          };
        } catch (e) {
          console.error(`[library] Skipping unreadable note "${slug}":`, e instanceof Error ? e.message : e);
          return null;
        }
      })
    );

    return notes
      .filter((n): n is NoteListItem & { content: string } => n !== null)
      .sort((a, b) => b.frontmatter.date.localeCompare(a.frontmatter.date));
  }

  private async walkMdFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await this.walkMdFiles(fullPath)));
      } else if (entry.isFile() && entry.name.endsWith('.md') && !fullPath.includes('.sync-conflict')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  async get(slug: string): Promise<Note | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.notePath(slug), 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    const parsed = matter(raw);
    return {
      slug,
      frontmatter: this.parseFrontmatter(parsed.data),
      content: parsed.content,
      raw,
    };
  }

  async upsert(data: {
    title: string;
    content: string;
    tags?: string[];
    related?: string[];
    slug?: string;
  }): Promise<Note> {
    const slug = data.slug || NoteStore.makeSlug(data.title);
    const date = new Date().toISOString().split('T')[0];

    // Merge with existing note if it exists
    const existing = await this.get(slug);
    const frontmatter: NoteFrontmatter = {
      title: data.title,
      date: existing?.frontmatter.date || date,
      tags: data.tags ?? existing?.frontmatter.tags ?? [],
      related: data.related ?? existing?.frontmatter.related ?? [],
    };

    const notePath = this.notePath(slug);
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    const fileContent = matter.stringify(data.content, frontmatter as unknown as Record<string, unknown>);
    // Atomic overwrite: tmp file in the same directory + rename. The watcher
    // stays quiet because awaitWriteFinish (not the `ignored` predicate alone)
    // requires file size stability for 500ms before firing — the tmp file's
    // create-then-rename lifecycle completes in milliseconds, so no event for
    // the tmp path ever stabilizes.
    await this.writeAtomically(notePath, fileContent, { mode: 'overwrite' });

    return {
      slug,
      frontmatter,
      content: data.content,
      raw: fileContent,
    };
  }

  /**
   * Write `content` to `targetPath` atomically.
   *
   * Strategy: write to a sibling `.tmp.*` file first, then either rename
   * (`mode: 'overwrite'`) or hardlink (`mode: 'create'`) into place. Both
   * primitives are atomic at the kernel level on the same filesystem, which is
   * guaranteed here because the tmp file always lives in the same directory
   * as the target.
   *
   * Crash recovery is automatic: orphan `.tmp.*` files are invisible to
   * `walkMdFiles` (which filters by `.md` extension). The chokidar watcher
   * also ignores them — and more importantly, awaitWriteFinish's stability
   * window keeps the watcher quiet during the brief tmp lifecycle.
   *
   * Note on the tmp suffix: pid + timestamp + random tail assumes a single-
   * process deployment. If we ever move to worker threads (which share pid),
   * swap in `crypto.randomBytes` for a process-unique suffix.
   */
  private async writeAtomically(
    targetPath: string,
    content: string,
    opts: { mode: 'create' | 'overwrite' }
  ): Promise<void> {
    const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fs.writeFile(tmpPath, content);
      if (opts.mode === 'overwrite') {
        // rename is atomic same-filesystem (guaranteed: tmp is a sibling of target)
        await fs.rename(tmpPath, targetPath);
        return; // tmp is gone after rename
      }
      // mode === 'create': atomic create-or-fail via hardlink. EEXIST surfaces
      // if the target already exists, with no TOCTOU window.
      // EXDEV (cross-device link) is structurally impossible here because tmp
      // and target always share a directory (and therefore a filesystem).
      try {
        await fs.link(tmpPath, targetPath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(`Note already exists at "${targetPath}"`);
        }
        throw e;
      }
      // Hardlink succeeded — drop the tmp reference, leaving the target as
      // the sole link to the inode. Guard the cleanup: if it fails (extremely
      // rare, e.g. EPERM on an exotic filesystem), the write itself logically
      // succeeded — the target inode is in place. Re-throwing here would
      // trigger move()'s rollback, which would unlink the just-linked target
      // and silently destroy the user's data. Best-effort cleanup, then return.
      await fs.unlink(tmpPath).catch(() => {});
      return;
    } catch (e) {
      // Best-effort cleanup. Only reached on failure of writeFile / rename /
      // link. After a successful rename the tmp is already gone (we returned
      // above); after a successful link we returned above too.
      await fs.unlink(tmpPath).catch(() => {});
      throw e;
    }
  }

  async move(oldSlug: string, newSlug: string): Promise<{ note: Note; updatedRefs: string[] }> {
    // Defense-in-depth: same-slug move would otherwise fail at step 3 with a
    // misleading "already exists" error (the source's own file is still on
    // disk). Reject explicitly so callers see the real cause. The MCP handler
    // already guards this upstream; this protects any direct caller.
    if (oldSlug === newSlug) {
      throw new Error(`Source and target slugs are the same: "${oldSlug}"`);
    }

    // 1. Read source note
    const source = await this.get(oldSlug);
    if (!source) {
      throw new Error(`Note "${oldSlug}" not found`);
    }

    // 2. Self-ref preflight: if the source's own related[] references its old
    //    slug, rewrite that one entry to the new slug before writing. We re-
    //    stringify with gray-matter ONLY in this case so the verbatim raw
    //    content path (preserving the user's exact YAML) holds for the common
    //    case where there's no self-reference.
    //
    //    Trade-off: matter.stringify serializes frontmatter in JS object
    //    property order, which may differ from the user's hand-edited field
    //    order. Acceptable because (a) the rewrite path only fires for self-
    //    referencing notes, (b) the alternative is leaving a dangling related
    //    entry pointing at a deleted slug.
    const oldPath = this.notePath(oldSlug);
    const newPath = this.notePath(newSlug);
    let content: string;
    if (source.frontmatter.related.includes(oldSlug)) {
      const newFrontmatter: NoteFrontmatter = {
        ...source.frontmatter,
        related: source.frontmatter.related.map((r) => (r === oldSlug ? newSlug : r)),
      };
      content = matter.stringify(source.content, newFrontmatter as unknown as Record<string, unknown>);
    } else {
      content = source.raw;
    }

    // 3. Atomic create-or-fail at the target via writeAtomically (write to
    //    sibling tmp, then hardlink into place). The helper guarantees that
    //    `newPath` either ends up fully written or is never created — no
    //    partial-file leak even if writeFile throws midway. EEXIST is
    //    surfaced as a structured error.
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    await this.writeAtomically(newPath, content, { mode: 'create' });

    // 4. Unlink old file. If this fails, roll back the new-location write so
    //    the pre-move state is restored exactly. The rollback is safe because
    //    writeAtomically's create mode used a hardlink that fails on EEXIST —
    //    the file at newPath is a brand new file we just created, so deleting
    //    it cannot clobber pre-existing data.
    try {
      await fs.unlink(oldPath);
    } catch (e) {
      await fs.unlink(newPath).catch(() => {});
      throw e;
    }

    // 5. Prune empty parents at the old location.
    await this.pruneEmptyParents(oldPath);

    // 6. Update references in other notes. The moved note's own self-ref was
    //    already handled in step 2, so updateRelatedRefs's `entry.slug ===
    //    newSlug` skip-guard is correct here.
    const updatedRefs = await this.updateRelatedRefs(oldSlug, newSlug);

    // 7. Return note at new location
    const note = await this.get(newSlug);
    return { note: note!, updatedRefs };
  }

  private async updateRelatedRefs(oldSlug: string, newSlug: string): Promise<string[]> {
    const updatedSlugs: string[] = [];
    const allNotes = await this.listWithContent();
    for (const entry of allNotes) {
      if (entry.slug === newSlug) continue; // Skip the moved note itself to preserve its raw content
      if (entry.frontmatter.related.includes(oldSlug)) {
        const newRelated = entry.frontmatter.related.map((r) => (r === oldSlug ? newSlug : r));
        await this.upsert({
          slug: entry.slug,
          title: entry.frontmatter.title,
          content: entry.content,
          tags: entry.frontmatter.tags,
          related: newRelated,
        });
        updatedSlugs.push(entry.slug);
      }
    }
    return updatedSlugs;
  }

  async delete(slug: string): Promise<boolean> {
    const filePath = this.notePath(slug);
    try {
      await fs.unlink(filePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
    await this.pruneEmptyParents(filePath);
    return true;
  }

  private async pruneEmptyParents(filePath: string): Promise<void> {
    let current = path.dirname(filePath);
    while (current !== this.notesDir && current.startsWith(this.notesDir + path.sep)) {
      try {
        await fs.rmdir(current);
      } catch {
        break; // Directory not empty or other error — stop climbing
      }
      current = path.dirname(current);
    }
  }

  private parseFrontmatter(data: Record<string, unknown>): NoteFrontmatter {
    // gray-matter parses YAML date scalars (e.g. `date: 2020-01-01`) as JS
    // Date objects. Extract the UTC calendar date in that case, which preserves
    // the author's intent regardless of local timezone. Plain strings (e.g.
    // from notes created by this app) stay as-is. Anything else (missing,
    // malformed non-ISO string) falls back to today.
    let date: string;
    if (data.date instanceof Date) {
      date = data.date.toISOString().split('T')[0];
    } else {
      const rawDate = String(data.date ?? '');
      date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
        ? rawDate
        : new Date().toISOString().split('T')[0];
    }
    return {
      title: String(data.title || 'Untitled'),
      date,
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      related: Array.isArray(data.related) ? data.related.map(String) : [],
    };
  }
}
