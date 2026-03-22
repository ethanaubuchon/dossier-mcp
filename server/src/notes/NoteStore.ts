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

  constructor(notesDir: string) {
    super();
    this.notesDir = notesDir;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.notesDir, { recursive: true });
    this.startWatcher();
  }

  private startWatcher(): void {
    this.watcher = chokidar.watch(path.join(this.notesDir, '*.md'), {
      ignoreInitial: true,
      persistent: true,
    });

    const onChange = async () => {
      const notes = await this.list();
      this.emit('change', notes);
    };

    this.watcher.on('add', onChange);
    this.watcher.on('change', onChange);
    this.watcher.on('unlink', onChange);
  }

  async close(): Promise<void> {
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
        } catch {
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
        } catch {
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
    try {
      const raw = await fs.readFile(this.notePath(slug), 'utf-8');
      const parsed = matter(raw);
      return {
        slug,
        frontmatter: this.parseFrontmatter(parsed.data),
        content: parsed.content,
        raw,
      };
    } catch {
      return null;
    }
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

  async delete(slug: string): Promise<boolean> {
    try {
      await fs.unlink(this.notePath(slug));
      return true;
    } catch {
      return false;
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
