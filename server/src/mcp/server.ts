import fs from 'fs/promises';
import path from 'path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NoteStore, pickFrontmatterExtras } from '../notes/NoteStore.js';
import { SearchIndex } from '../search/SearchIndex.js';
import { coerceStringArray, resolveFrontmatterParams, FRONTMATTER_DENYLIST } from './coerce.js';
import { extractTodos } from '../notes/todos.js';
import { appendToSection, editBody } from '../notes/sections.js';
import { applyFrontmatterEdit } from '../notes/frontmatter.js';

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

  type ToolResponse = {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  };

  async function withToolError(prefix: string, fn: () => Promise<ToolResponse>): Promise<ToolResponse> {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: 'text', text: `${prefix}: ${msg}` }] };
    }
  }

  // ── Tools ──────────────────────────────────────────────────────────────────

  server.tool(
    'get_vault_context',
    'Fetch the vault bootstrap document (profile.md) from the vault root. ' +
    'Read this first to orient yourself to the vault — its structure, contents, ' +
    'and how to navigate it effectively. ' +
    'Load this silently for context; do not summarize or recite its contents unless the user explicitly asks.',
    {},
    async () =>
      withToolError('Failed to load vault context', async () => {
        const result = await vaultContextHandler(notesDir);
        return { content: [{ type: 'text', text: result.contents[0].text }] };
      })
  );

  server.tool(
    'list_notes',
    'List notes in the knowledge base, sorted by date (newest first). Optionally filter by slug prefix to scope results to a folder. If you haven\'t already, call get_vault_context first to orient yourself to this vault.',
    {
      path: z.string().optional().describe('Optional slug prefix to filter by (e.g. "projects/startup"). Trailing slash is normalized automatically.'),
    },
    async ({ path: prefix }) =>
      withToolError('Failed to list notes', async () => {
        const notes = await noteStore.list();
        const normalized = prefix && (prefix.endsWith('/') ? prefix : prefix + '/');
        const filtered = normalized ? notes.filter((n) => n.slug.startsWith(normalized)) : notes;
        return { content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }] };
      })
  );

  server.tool(
    'get_note',
    'Get the full content and metadata of a specific note by its slug.',
    { slug: z.string().describe('The note slug (e.g. "react-hooks-rules")') },
    async ({ slug }) => {
      if (!isValidSlug(slug)) return slugValidationError(slug);
      return withToolError(`Failed to read note "${slug}"`, async () => {
        const note = await noteStore.get(slug);
        if (!note) {
          return { isError: true, content: [{ type: 'text', text: `Note "${slug}" not found.` }] };
        }
        return { content: [{ type: 'text', text: note.raw }] };
      });
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
      frontmatter: z.record(z.string(), z.unknown()).optional().describe(
        'Additional YAML frontmatter fields to write (e.g. {status: "shaping"}). ' +
        'Cannot set tool-managed fields (title, date, tags, related) — use the typed params for those.'
      ),
    },
    async ({ title, content, path: notePath, tags, related, frontmatter }) => {
      const slug = notePath ?? ('inbox/' + NoteStore.makeSlug(title));
      if (!isValidSlug(slug)) return slugValidationError(slug);

      // Denylist check on the explicit frontmatter param (first-fail, named key).
      if (frontmatter) {
        for (const key of Object.keys(frontmatter)) {
          if (FRONTMATTER_DENYLIST.has(key)) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Cannot set '${key}' via frontmatter; use the typed param.` }],
            };
          }
        }
      }

      let note;
      try {
        const existing = await noteStore.get(slug);
        if (existing) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Note already exists at "${slug}" — use update_note to modify it.` }],
          };
        }
        note = await noteStore.upsert({ slug, title, content, tags, related, frontmatter });
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
    'useful when passing back output from get_note directly. Explicit params take precedence over frontmatter values. ' +
    'Omit tags or related (or pass an empty array) to preserve existing values; pass a non-empty array to replace them. ' +
    'Non-tool-managed frontmatter fields (e.g. status) embedded in content are preserved on round-trip update.',
    {
      slug: z.string().describe('The slug of the note to update'),
      title: z.string().optional().describe('New title for the note. Can also be supplied via frontmatter in content.'),
      content: z.string().describe('New markdown content for the note body (frontmatter will be extracted if present)'),
      tags: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Updated tags'),
      related: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Updated related note slugs'),
      frontmatter: z.record(z.string(), z.unknown()).optional().describe(
        'Additional YAML frontmatter fields to write (e.g. {status: "shaping"}). ' +
        'Cannot set tool-managed fields (title, date, tags, related) — use the typed params for those.'
      ),
    },
    async ({ slug, title, content, tags, related, frontmatter }) => {
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
        const resolved = resolveFrontmatterParams({ title, content, tags, related, frontmatter });
        if (!resolved.ok) {
          return { isError: true, content: [{ type: 'text', text: resolved.error }] };
        }
        note = await noteStore.upsert({
          slug,
          title: resolved.title,
          content: resolved.content,
          tags: resolved.tags,
          related: resolved.related,
          frontmatter: resolved.frontmatter,
        });
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
    'append_to_section',
    'Append content under a named "## heading" in an existing note, without regenerating the whole body. ' +
    'Cheaper and safer than update_note for the common "add a bullet / log an entry" case — no need to read and resend the full note. ' +
    'The heading is matched by exact text (level-agnostic); content is inserted at the end of that section. ' +
    'Stamps the note\'s "updated" frontmatter field and returns the full updated note.',
    {
      slug: z.string().describe('The slug of the note to append to'),
      heading: z.string().min(1).describe('Exact text of the target "## heading" (without the leading #s)'),
      content: z.string().min(1).describe('Markdown content to append at the end of the section'),
      create_if_missing: z.boolean().default(false).describe(
        'If the heading is absent, create a new "## heading" section at the end of the note. ' +
        'Defaults to false — a missing heading errors with the note\'s existing headings so you can correct it.'
      ),
    },
    async ({ slug, heading, content, create_if_missing }) => {
      if (!isValidSlug(slug)) return slugValidationError(slug);
      let written;
      try {
        const note = await noteStore.get(slug);
        if (!note) {
          return { isError: true, content: [{ type: 'text', text: `Note "${slug}" not found.` }] };
        }
        const result = appendToSection(note.content, heading, content, create_if_missing);
        if (!result.ok) {
          if (result.reason === 'missing') {
            const list = result.headings.length ? result.headings.map((h) => `"${h}"`).join(', ') : '(none)';
            return {
              isError: true,
              content: [{ type: 'text', text: `Heading "${heading}" not found in "${slug}". Existing headings: ${list}. Pass create_if_missing=true to create it.` }],
            };
          }
          return {
            isError: true,
            content: [{ type: 'text', text: `Heading "${heading}" is ambiguous — matches ${result.count} headings in "${slug}". Use a more specific or nested heading.` }],
          };
        }
        const updated = new Date().toISOString().split('T')[0];
        written = await noteStore.upsert({
          slug,
          title: note.frontmatter.title,
          content: result.body,
          tags: note.frontmatter.tags,
          related: note.frontmatter.related,
          frontmatter: { updated },
        });
        const allNotes = await noteStore.listWithContent();
        searchIndex.buildIndexWithContent(allNotes);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: 'text', text: `Failed to append to note "${slug}": ${msg}` }] };
      }
      return { content: [{ type: 'text', text: written.raw }] };
    }
  );

  server.tool(
    'edit_note',
    'Replace an exact string in a note\'s body with a new string, without regenerating the whole note. ' +
    'Mirrors the Edit-tool pattern — surgical exact-match find/replace — for targeted mid-body changes; ' +
    'cheaper and safer than update_note when you only need to change a specific passage. ' +
    'old_string must match exactly (whitespace included) and be unique unless replace_all is set. ' +
    'Stamps the note\'s "updated" frontmatter field and returns the full updated note.',
    {
      slug: z.string().describe('The slug of the note to edit'),
      old_string: z.string().min(1).describe('Exact text to find in the note body (whitespace-sensitive)'),
      new_string: z.string().describe('Text to replace it with (may be empty to delete the match)'),
      replace_all: z.boolean().default(false).describe(
        'Replace every occurrence of old_string. ' +
        'Defaults to false — a non-unique old_string errors with the match count so you can disambiguate.'
      ),
    },
    async ({ slug, old_string, new_string, replace_all }) => {
      if (!isValidSlug(slug)) return slugValidationError(slug);
      let written;
      try {
        const note = await noteStore.get(slug);
        if (!note) {
          return { isError: true, content: [{ type: 'text', text: `Note "${slug}" not found.` }] };
        }
        const result = editBody(note.content, old_string, new_string, replace_all);
        if (!result.ok) {
          if (result.reason === 'not_found') {
            return {
              isError: true,
              content: [{ type: 'text', text: `old_string not found in "${slug}". It must match the note body exactly, including whitespace (frontmatter is not editable via this tool).` }],
            };
          }
          if (result.reason === 'no_change') {
            return {
              isError: true,
              content: [{ type: 'text', text: `old_string and new_string are identical — no change to make in "${slug}".` }],
            };
          }
          return {
            isError: true,
            content: [{ type: 'text', text: `old_string is not unique — matches ${result.count} places in "${slug}". Provide a longer, more specific old_string or pass replace_all=true.` }],
          };
        }
        const updated = new Date().toISOString().split('T')[0];
        written = await noteStore.upsert({
          slug,
          title: note.frontmatter.title,
          content: result.body,
          tags: note.frontmatter.tags,
          related: note.frontmatter.related,
          frontmatter: { updated },
        });
        const allNotes = await noteStore.listWithContent();
        searchIndex.buildIndexWithContent(allNotes);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: 'text', text: `Failed to edit note "${slug}": ${msg}` }] };
      }
      return { content: [{ type: 'text', text: written.raw }] };
    }
  );

  server.tool(
    'edit_frontmatter',
    'Surgically edit a note\'s frontmatter — set scalar fields (e.g. status) and add/remove tags or related — without regenerating the body. ' +
    'Cheaper and safer than update_note for frontmatter-only maintenance (status transitions, retagging, related cleanup): the body is read from disk and passed through byte-for-byte, never re-emitted. ' +
    'set writes scalar passthrough fields (cannot set title/date/tags/related — use add_/remove_ or update_note); add_/remove_tags and add_/remove_related mutate those lists with set semantics (re-adding an existing entry or removing an absent one is a no-op). ' +
    'Stamps the note\'s "updated" frontmatter field and returns the full updated note.',
    {
      slug: z.string().describe('The slug of the note to edit'),
      set: z.record(z.string(), z.unknown()).optional().describe(
        'Scalar frontmatter fields to set, e.g. {status: "implemented"}. Cannot set title/date/tags/related — use add_tags/remove_tags, add_related/remove_related, or update_note. The "updated" field is stamped automatically and is ignored if supplied here.'
      ),
      add_tags: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Tags to add (union; re-adding an existing tag is a no-op)'),
      remove_tags: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Tags to remove (removing an absent tag is a no-op)'),
      add_related: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Related slugs to add (union; re-adding an existing one is a no-op)'),
      remove_related: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Related slugs to remove (removing an absent one is a no-op)'),
    },
    async ({ slug, set, add_tags, remove_tags, add_related, remove_related }) => {
      if (!isValidSlug(slug)) return slugValidationError(slug);

      // Denylist check on `set` (first-fail, named key) — mirrors create_note,
      // reusing the shared FRONTMATTER_DENYLIST so tool-managed fields can't be
      // set via passthrough. Points the caller at the right lever.
      if (set) {
        for (const key of Object.keys(set)) {
          if (FRONTMATTER_DENYLIST.has(key)) {
            const lever = key === 'tags' || key === 'related'
              ? `add_${key}/remove_${key}`
              : 'the typed update_note param';
            return {
              isError: true,
              content: [{ type: 'text', text: `Cannot set '${key}' via set; use ${lever}.` }],
            };
          }
        }
      }

      // `updated` is stamped automatically on every write; drop any caller value
      // so it can't manufacture a spurious "successful" write that just re-stamps
      // today. (It's off FRONTMATTER_DENYLIST — which #65 keeps for update_note's
      // content round-trip — so this tool strips it explicitly instead.)
      const setFields = set
        ? Object.fromEntries(Object.entries(set).filter(([k]) => k !== 'updated'))
        : undefined;

      let written;
      try {
        const note = await noteStore.get(slug);
        if (!note) {
          return { isError: true, content: [{ type: 'text', text: `Note "${slug}" not found.` }] };
        }
        const result = applyFrontmatterEdit(
          {
            tags: note.frontmatter.tags,
            related: note.frontmatter.related,
            extras: pickFrontmatterExtras(note.frontmatter),
          },
          { set: setFields, addTags: add_tags, removeTags: remove_tags, addRelated: add_related, removeRelated: remove_related },
        );
        if (!result.ok) {
          if (result.reason === 'no_ops') {
            return {
              isError: true,
              content: [{ type: 'text', text: `edit_frontmatter on "${slug}" changed nothing — supply at least one of set, add_tags, remove_tags, add_related, remove_related.` }],
            };
          }
          if (result.reason === 'conflict') {
            return {
              isError: true,
              content: [{ type: 'text', text: `${result.field} lists both add and remove of: ${result.entries.join(', ')} — incoherent, pick one.` }],
            };
          }
          // no_change
          return {
            isError: true,
            content: [{ type: 'text', text: `edit_frontmatter on "${slug}" is a no-op — all adds already present, all removes absent, and set matches the current frontmatter.` }],
          };
        }
        const updated = new Date().toISOString().split('T')[0];
        // result.tags / result.related go straight to upsert's typed params —
        // never through coerceStringArray, whose []→undefined "preserve" collapse
        // would make "remove the last tag" silently no-op. result.extras is the
        // computed (existing + set) extras; `updated` is stamped here so it wins.
        // The body is passed through untouched; only frontmatter changes.
        written = await noteStore.upsert({
          slug,
          title: note.frontmatter.title,
          content: note.content,
          tags: result.tags,
          related: result.related,
          frontmatter: { ...result.extras, updated },
        });
        const allNotes = await noteStore.listWithContent();
        searchIndex.buildIndexWithContent(allNotes);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: 'text', text: `Failed to edit frontmatter of note "${slug}": ${msg}` }] };
      }
      return { content: [{ type: 'text', text: written.raw }] };
    }
  );

  server.tool(
    'delete_note',
    'Delete a note from the knowledge base by its slug.',
    { slug: z.string().describe('The slug of the note to delete') },
    async ({ slug }) => {
      if (!isValidSlug(slug)) return slugValidationError(slug);
      const result = await withToolError(`Failed to delete note "${slug}"`, async () => {
        const deleted = await noteStore.delete(slug);
        if (!deleted) {
          return { isError: true, content: [{ type: 'text', text: `Note "${slug}" not found.` }] };
        }
        return { content: [{ type: 'text', text: `Deleted note "${slug}".` }] };
      });
      // Secondary best-effort: rebuild the search index after a successful delete.
      // A failure here is logged but does not change the response — the deletion
      // itself succeeded, and the index will catch up on the next watcher tick.
      if (!result.isError) {
        try {
          const allNotes = await noteStore.listWithContent();
          searchIndex.buildIndexWithContent(allNotes);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[library] Failed to rebuild search index after deleting "${slug}":`, msg);
        }
      }
      return result;
    }
  );

  server.tool(
    'search_notes',
    'Search the knowledge base using keyword search. Returns matching notes scored by relevance, with excerpts.',
    {
      query: z.string().describe('Search query — keywords to search for'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum number of results to return (default: 10, max: 100)'),
    },
    async ({ query, limit }) =>
      withToolError('Search failed', async () => {
        const results = searchIndex.search(query, limit ?? 10);
        if (results.length === 0) {
          return { content: [{ type: 'text', text: `No notes found matching "${query}".` }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      })
  );

  server.tool(
    'list_todos',
    'List notes that contain incomplete `- [ ]` markdown checkboxes, with each todo\'s text excerpted. ' +
    'Filter by slug prefix to scope to a folder. ' +
    'Useful for finding open work across the vault. Note: checkbox syntax inside fenced code blocks is ignored.',
    {
      path: z.string().optional().describe('Optional slug prefix to filter by (e.g. "projects/startup"). Trailing slash is normalized automatically.'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum number of notes to return (default: 10, max: 100)'),
    },
    async ({ path: prefix, limit }) =>
      withToolError('Failed to list todos', async () => {
        const notes = await noteStore.listWithContent();
        const normalized = prefix && (prefix.endsWith('/') ? prefix : prefix + '/');
        const scoped = normalized ? notes.filter((n) => n.slug.startsWith(normalized)) : notes;

        const withTodos = scoped
          .map((n) => ({
            slug: n.slug,
            title: n.frontmatter.title,
            todos: extractTodos(n.content),
          }))
          .filter((n) => n.todos.length > 0)
          .slice(0, limit ?? 10);

        if (withTodos.length === 0) {
          return { content: [{ type: 'text', text: 'No notes found with incomplete TODOs.' }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(withTodos, null, 2) }] };
      })
  );

  server.tool(
    'move_note',
    'Move a note to a new location in the vault. Preserves all metadata (title, date, tags, related) ' +
    'and automatically updates related fields in other notes that reference the old slug. ' +
    'Fails if a note already exists at the target slug — delete it first if you intend to replace.',
    {
      slug: z.string().describe('The current slug of the note to move'),
      new_slug: z.string().describe('The target slug to move the note to'),
    },
    async ({ slug, new_slug }) => {
      if (!isValidSlug(slug)) return slugValidationError(slug);
      if (!isValidSlug(new_slug)) return slugValidationError(new_slug);
      if (slug === new_slug) {
        return { isError: true, content: [{ type: 'text', text: 'Source and target slugs are the same.' }] };
      }

      try {
        const { updatedRefs } = await noteStore.move(slug, new_slug);
        const allNotes = await noteStore.listWithContent();
        searchIndex.buildIndexWithContent(allNotes);

        let msg = `Moved note from "${slug}" to "${new_slug}".`;
        if (updatedRefs.length > 0) {
          msg += ` Updated references in ${updatedRefs.length} note(s): ${updatedRefs.join(', ')}.`;
        }
        return { content: [{ type: 'text', text: msg }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Surface the "already exists" case with user-friendly guidance.
        // The underlying error message contains the absolute target path
        // (from writeAtomically); we match on the prefix instead of the slug.
        if (msg.startsWith('Note already exists at "')) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Note already exists at "${new_slug}" — choose a different slug.` }],
          };
        }
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
