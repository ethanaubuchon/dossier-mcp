import fs from 'fs/promises';
import path from 'path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NoteStore } from '../notes/NoteStore.js';
import { SearchIndex } from '../search/SearchIndex.js';
import { coerceStringArray, resolveFrontmatterParams } from './coerce.js';

export async function vaultContextHandler(notesDir: string) {
  try {
    const raw = await fs.readFile(path.join(notesDir, 'profile.md'), 'utf-8');
    return { contents: [{ uri: 'vault://context', text: raw, mimeType: 'text/markdown' }] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('profile.md not found — create it at the vault root.');
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to read profile.md: ${msg}`);
  }
}

export function isValidSlug(slug: string): boolean {
  if (slug.length === 0) return false;
  if (slug.includes('\0')) return false;
  if (slug.startsWith('/') || slug.endsWith('/')) return false;
  if (slug.includes('..')) return false;
  return true;
}

export function slugValidationError(slug: string) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `Invalid slug "${slug}": must be a non-empty relative path without "..", null bytes, or leading/trailing "/"` }],
  };
}

export function createMcpServer(noteStore: NoteStore, searchIndex: SearchIndex, notesDir: string): McpServer {
  const server = new McpServer({
    name: 'library',
    version: '1.0.0',
  });

  // ── Tools ──────────────────────────────────────────────────────────────────

  server.tool(
    'get_vault_context',
    'Fetch the vault bootstrap document (profile.md) from the vault root. ' +
    'Read this first to orient yourself to the vault — its structure, contents, ' +
    'and how to navigate it effectively. ' +
    'Load this silently for context; do not summarize or recite its contents unless the user explicitly asks.',
    {},
    async () => {
      try {
        const result = await vaultContextHandler(notesDir);
        return { content: [{ type: 'text', text: result.contents[0].text }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          isError: true,
          content: [{ type: 'text', text: msg }],
        };
      }
    }
  );

  server.tool(
    'list_notes',
    'List notes in the knowledge base, sorted by date (newest first). Optionally filter by slug prefix to scope results to a folder. If you haven\'t already, call get_vault_context first to orient yourself to this vault.',
    {
      path: z.string().optional().describe('Optional slug prefix to filter by (e.g. "projects/startup"). Trailing slash is normalized automatically.'),
    },
    async ({ path: prefix }) => {
      let notes;
      try {
        notes = await noteStore.list();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: 'text', text: `Failed to list notes: ${msg}` }] };
      }
      const normalized = prefix && (prefix.endsWith('/') ? prefix : prefix + '/');
      const filtered = normalized ? notes.filter((n) => n.slug.startsWith(normalized)) : notes;
      return {
        content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }],
      };
    }
  );

  server.tool(
    'get_note',
    'Get the full content and metadata of a specific note by its slug.',
    { slug: z.string().describe('The note slug (e.g. "react-hooks-rules")') },
    async ({ slug }) => {
      if (!isValidSlug(slug)) return slugValidationError(slug);
      let note;
      try {
        note = await noteStore.get(slug);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to read note "${slug}": ${msg}` }],
        };
      }
      if (!note) {
        return {
          content: [{ type: 'text', text: `Note "${slug}" not found.` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: note.raw }],
      };
    }
  );

  server.tool(
    'create_note',
    'Create a new note in the knowledge base. Provide a path to place it (e.g. "projects/startup/market-analysis") or omit to land it in inbox/. Use [[slug]] syntax to link to related notes.',
    {
      title: z.string().describe('The note title'),
      content: z.string().describe('Markdown content for the note body'),
      path: z.string().optional().describe('Vault-relative path for the note slug (e.g. "projects/startup/my-note"). Defaults to inbox/<title-slug>.'),
      tags: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Tags to categorize the note'),
      related: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Slugs of related notes'),
    },
    async ({ title, content, path: notePath, tags, related }) => {
      const slug = notePath ?? ('inbox/' + NoteStore.makeSlug(title));
      if (!isValidSlug(slug)) return slugValidationError(slug);

      let note;
      try {
        const existing = await noteStore.get(slug);
        if (existing) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Note already exists at "${slug}" — use update_note to modify it.` }],
          };
        }
        note = await noteStore.upsert({ slug, title, content, tags, related });
        const allNotes = await noteStore.listWithContent();
        searchIndex.buildIndexWithContent(allNotes);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: 'text', text: `Failed to write note "${slug}": ${msg}` }] };
      }
      return {
        content: [{ type: 'text', text: `Created note "${note.frontmatter.title}" with slug "${note.slug}".` }],
      };
    }
  );

  server.tool(
    'update_note',
    'Update an existing note. Pass the slug to identify which note to update. ' +
    'title, tags, and related can be passed as separate params or embedded as frontmatter in content — ' +
    'useful when passing back output from get_note directly. Explicit params take precedence over frontmatter values.',
    {
      slug: z.string().describe('The slug of the note to update'),
      title: z.string().optional().describe('New title for the note. Can also be supplied via frontmatter in content.'),
      content: z.string().describe('New markdown content for the note body (frontmatter will be extracted if present)'),
      tags: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Updated tags'),
      related: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Updated related note slugs'),
    },
    async ({ slug, title, content, tags, related }) => {
      if (!isValidSlug(slug)) return slugValidationError(slug);
      let note;
      try {
        const existing = await noteStore.get(slug);
        if (!existing) {
          return {
            content: [{ type: 'text', text: `Note "${slug}" not found.` }],
            isError: true,
          };
        }
        const resolved = resolveFrontmatterParams({ title, content, tags, related });
        if (!resolved.ok) {
          return { isError: true, content: [{ type: 'text', text: resolved.error }] };
        }
        note = await noteStore.upsert({ slug, title: resolved.title, content: resolved.content, tags: resolved.tags, related: resolved.related });
        const allNotes = await noteStore.listWithContent();
        searchIndex.buildIndexWithContent(allNotes);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: 'text', text: `Failed to write note "${slug}": ${msg}` }] };
      }
      return {
        content: [{ type: 'text', text: `Updated note "${note.frontmatter.title}" (slug: "${note.slug}").` }],
      };
    }
  );

  server.tool(
    'delete_note',
    'Delete a note from the knowledge base by its slug.',
    { slug: z.string().describe('The slug of the note to delete') },
    async ({ slug }) => {
      if (!isValidSlug(slug)) return slugValidationError(slug);
      let deleted;
      try {
        deleted = await noteStore.delete(slug);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: 'text', text: `Failed to delete note "${slug}": ${msg}` }] };
      }
      if (!deleted) {
        return {
          content: [{ type: 'text', text: `Note "${slug}" not found.` }],
          isError: true,
        };
      }
      try {
        const allNotes = await noteStore.listWithContent();
        searchIndex.buildIndexWithContent(allNotes);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[library] Failed to rebuild search index after deleting "${slug}":`, msg);
      }
      return {
        content: [{ type: 'text', text: `Deleted note "${slug}".` }],
      };
    }
  );

  server.tool(
    'search_notes',
    'Search the knowledge base using keyword search. Returns matching notes scored by relevance, with excerpts.',
    {
      query: z.string().describe('Search query — keywords to search for'),
      limit: z.number().optional().describe('Maximum number of results to return (default: 10)'),
    },
    async ({ query, limit }) => {
      let results;
      try {
        results = searchIndex.search(query, limit ?? 10);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: 'text', text: `Search failed: ${msg}` }] };
      }
      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: `No notes found matching "${query}".` }],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'move_note',
    'Move a note to a new location in the vault. Preserves all metadata (title, date, tags, related) ' +
    'and automatically updates related fields in other notes that reference the old slug. ' +
    'Use force to overwrite an existing note at the target location.',
    {
      slug: z.string().describe('The current slug of the note to move'),
      new_slug: z.string().describe('The target slug to move the note to'),
      force: z.boolean().optional().describe('If true, overwrite an existing note at the target slug (default: false)'),
    },
    async ({ slug, new_slug, force }) => {
      if (!isValidSlug(slug)) return slugValidationError(slug);
      if (!isValidSlug(new_slug)) return slugValidationError(new_slug);
      if (slug === new_slug) {
        return { isError: true, content: [{ type: 'text', text: 'Source and target slugs are the same.' }] };
      }

      try {
        if (!force) {
          const existing = await noteStore.get(new_slug);
          if (existing) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Note already exists at "${new_slug}" — pass force: true to overwrite, or choose a different slug.` }],
            };
          }
        } else {
          await noteStore.delete(new_slug);
        }

        const { note, updatedRefs } = await noteStore.move(slug, new_slug);
        const allNotes = await noteStore.listWithContent();
        searchIndex.buildIndexWithContent(allNotes);

        let msg = `Moved note from "${slug}" to "${new_slug}".`;
        if (updatedRefs.length > 0) {
          msg += ` Updated references in ${updatedRefs.length} note(s): ${updatedRefs.join(', ')}.`;
        }
        return { content: [{ type: 'text', text: msg }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: 'text', text: `Failed to move note "${slug}": ${msg}` }] };
      }
    }
  );

  // ── Resources ──────────────────────────────────────────────────────────────

  // List all notes as resources
  server.resource(
    'notes-index',
    'notes://index',
    { description: 'Index of all notes in the knowledge base' },
    async () => {
      let notes;
      try {
        notes = await noteStore.list();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to list notes: ${msg}`);
      }
      const lines = notes.map(
        (n) => `- [${n.frontmatter.title}](note://${encodeURIComponent(n.slug)}) — ${n.frontmatter.date} [${n.frontmatter.tags.join(', ')}]`
      );
      return {
        contents: [
          {
            uri: 'notes://index',
            text: `# Knowledge Base Notes\n\n${lines.join('\n') || '_No notes yet._'}`,
            mimeType: 'text/markdown',
          },
        ],
      };
    }
  );

  server.resource(
    'vault-context',
    'vault://context',
    { description: 'Vault bootstrap document (profile.md). Read this first to orient yourself to the vault — its structure, contents, and how to navigate it.' },
    () => vaultContextHandler(notesDir)
  );

  // Individual note resources via template
  const noteTemplate = new ResourceTemplate('note://{slug}', {
    list: async () => {
      let notes;
      try {
        notes = await noteStore.list();
      } catch (e) {
        console.error('[library] Failed to list note resources:', e instanceof Error ? e.message : e);
        return { resources: [] };
      }
      return {
        resources: notes.map((n) => ({
          uri: `note://${encodeURIComponent(n.slug)}`,
          name: n.frontmatter.title,
          description: `Tagged: ${n.frontmatter.tags.join(', ') || 'none'} · ${n.frontmatter.date}`,
          mimeType: 'text/markdown',
        })),
      };
    },
  });

  server.resource(
    'note',
    noteTemplate,
    { description: 'A single note from the knowledge base, identified by its slug' },
    async (uri, { slug }) => {
      const decodedSlug = decodeURIComponent(slug as string);
      if (!isValidSlug(decodedSlug)) {
        throw new Error(`Invalid slug "${decodedSlug}": must be a non-empty relative path without "..", null bytes, or leading/trailing "/"`);
      }
      let note;
      try {
        note = await noteStore.get(decodedSlug);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to read note "${decodedSlug}": ${msg}`);
      }
      if (!note) {
        throw new Error(`Note "${decodedSlug}" not found`);
      }
      return {
        contents: [
          {
            uri: uri.href,
            text: note.raw,
            mimeType: 'text/markdown',
          },
        ],
      };
    }
  );

  return server;
}
