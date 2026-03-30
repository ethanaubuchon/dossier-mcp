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
    this.notesDir = notesDir;
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

  private notePath(slug: string): string {
    return path.join(this.notesDir, `${slug}.md`);
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
    await fs.writeFile(notePath, fileContent);

    return {
      slug,
      frontmatter,
      content: data.content,
      raw: fileContent,
    };
  }

  async move(oldSlug: string, newSlug: string): Promise<{ note: Note; updatedRefs: string[] }> {
    // 1. Read source note
    const source = await this.get(oldSlug);
    if (!source) {
      throw new Error(`Note "${oldSlug}" not found`);
    }

    // 2. Check target doesn't exist
    const existing = await this.get(newSlug);
    if (existing) {
      throw new Error(`Note already exists at "${newSlug}"`);
    }

    // 3. Write to new location (preserving all frontmatter)
    const newPath = this.notePath(newSlug);
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    await fs.writeFile(newPath, source.raw);

    // 4. Delete old file and prune empty parents
    const oldPath = this.notePath(oldSlug);
    await fs.unlink(oldPath);
    await this.pruneEmptyParents(oldPath);

    // 5. Update references in other notes
    const updatedRefs = await this.updateRelatedRefs(oldSlug, newSlug);

    // 6. Return note at new location
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
    return {
      title: String(data.title || 'Untitled'),
      date: String(data.date || new Date().toISOString().split('T')[0]),
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      related: Array.isArray(data.related) ? data.related.map(String) : [],
    };
  }
}
