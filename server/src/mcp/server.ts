import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NoteStore } from '../notes/NoteStore.js';
import { SearchIndex } from '../search/SearchIndex.js';

function isValidSlug(slug: string): boolean {
  return !slug.includes('..') && !slug.startsWith('/');
}

function slugValidationError(slug: string) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `Invalid slug "${slug}": must be a relative path without ..` }],
  };
}

export function createMcpServer(noteStore: NoteStore, searchIndex: SearchIndex): McpServer {
  const server = new McpServer({
    name: 'library',
    version: '1.0.0',
  });

  // ── Tools ──────────────────────────────────────────────────────────────────

  server.tool(
    'list_notes',
    'List all notes in the knowledge base, sorted by date (newest first). Returns slug, title, date, and tags for each note.',
    {},
    async () => {
      const notes = await noteStore.list();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(notes, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'get_note',
    'Get the full content and metadata of a specific note by its slug.',
    { slug: z.string().describe('The note slug (e.g. "react-hooks-rules")') },
    async ({ slug }) => {
      if (!isValidSlug(slug)) return slugValidationError(slug);
      const note = await noteStore.get(slug);
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
      tags: z.array(z.string()).optional().describe('Tags to categorize the note'),
      related: z.array(z.string()).optional().describe('Slugs of related notes'),
    },
    async ({ title, content, path: notePath, tags, related }) => {
      const slug = notePath ?? ('inbox/' + NoteStore.makeSlug(title));
      if (!isValidSlug(slug)) return slugValidationError(slug);

      const existing = await noteStore.get(slug);
      if (existing) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Note already exists at "${slug}" — use update_note to modify it.` }],
        };
      }

      const note = await noteStore.upsert({ slug, title, content, tags, related });
      const allNotes = await noteStore.listWithContent();
      searchIndex.buildIndexWithContent(allNotes);
      return {
        content: [{ type: 'text', text: `Created note "${note.frontmatter.title}" with slug "${note.slug}".` }],
      };
    }
  );

  server.tool(
    'update_note',
    'Update an existing note. Pass the slug to identify which note to update.',
    {
      slug: z.string().describe('The slug of the note to update'),
      title: z.string().describe('New title for the note'),
      content: z.string().describe('New markdown content for the note body'),
      tags: z.array(z.string()).optional().describe('Updated tags'),
      related: z.array(z.string()).optional().describe('Updated related note slugs'),
    },
    async ({ slug, title, content, tags, related }) => {
      if (!isValidSlug(slug)) return slugValidationError(slug);
      const existing = await noteStore.get(slug);
      if (!existing) {
        return {
          content: [{ type: 'text', text: `Note "${slug}" not found.` }],
          isError: true,
        };
      }
      const note = await noteStore.upsert({ slug, title, content, tags, related });
      const allNotes = await noteStore.listWithContent();
      searchIndex.buildIndexWithContent(allNotes);
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
      const deleted = await noteStore.delete(slug);
      if (!deleted) {
        return {
          content: [{ type: 'text', text: `Note "${slug}" not found.` }],
          isError: true,
        };
      }
      const allNotes = await noteStore.listWithContent();
      searchIndex.buildIndexWithContent(allNotes);
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
      const results = searchIndex.search(query, limit ?? 10);
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

  // ── Resources ──────────────────────────────────────────────────────────────

  // List all notes as resources
  server.resource(
    'notes-index',
    'notes://index',
    { description: 'Index of all notes in the knowledge base' },
    async () => {
      const notes = await noteStore.list();
      const lines = notes.map(
        (n) => `- [${n.frontmatter.title}](note://${n.slug}) — ${n.frontmatter.date} [${n.frontmatter.tags.join(', ')}]`
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

  // Individual note resources via template
  const noteTemplate = new ResourceTemplate('note://{slug}', {
    list: async () => {
      const notes = await noteStore.list();
      return {
        resources: notes.map((n) => ({
          uri: `note://${n.slug}`,
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
      const note = await noteStore.get(slug as string);
      if (!note) {
        throw new Error(`Note "${slug}" not found`);
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
