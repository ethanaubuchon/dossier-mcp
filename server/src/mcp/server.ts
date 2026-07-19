import fs from 'fs/promises';
import path from 'path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NoteStore, pickFrontmatterExtras } from '../notes/NoteStore.js';
import { SearchIndex } from '../search/SearchIndex.js';
import { coerceStringArray, resolveFrontmatterParams, FRONTMATTER_DENYLIST } from './coerce.js';
import { extractTodos } from '../notes/todos.js';
import { filterByExcludedTags } from '../notes/tagFilter.js';
import { appendToSection, editBody } from '../notes/sections.js';
import { applyFrontmatterEdit } from '../notes/frontmatter.js';
import type { Note, NoteListItem, SearchResult } from '../types.js';

/**
 * The runtime counterpart to `VaultConfig`: a configured vault with its live
 * `NoteStore` (own chokidar watcher) and `SearchIndex`. The entry point builds
 * one per registry vault; the tool handlers route reads/writes across them by
 * name. Defined here rather than in `types.ts` to avoid a `types.ts` →
 * `NoteStore` → `types.ts` import cycle.
 */
export interface VaultRuntime {
  /** Slug-safe vault name (matches the config entry). */
  name: string;
  /** Absolute vault root — used to read the context file directly. */
  notesDir: string;
  /** Bootstrap doc filename relative to `notesDir` (defaults to `profile.md`). */
  contextFile: string;
  noteStore: NoteStore;
  searchIndex: SearchIndex;
}

/** The live per-vault stores/indexes plus the default (write-narrow) vault name. */
export interface VaultRuntimeRegistry {
  vaults: VaultRuntime[];
  defaultVault: string;
}

export async function vaultContextHandler(notesDir: string, contextFile = 'profile.md') {
  try {
    const raw = await fs.readFile(path.join(notesDir, contextFile), 'utf-8');
    return { contents: [{ uri: 'vault://context', text: raw, mimeType: 'text/markdown' }] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${contextFile} not found — create it at the vault root.`);
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to read ${contextFile}: ${msg}`);
  }
}

export function isValidSlug(slug: string): boolean {
  if (slug.length === 0) return false;
  if (slug.includes('\0')) return false;
  if (slug.startsWith('/') || slug.endsWith('/')) return false;
  if (slug.includes('..')) return false;
  return true;
}

type ToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// The two response shapes every tool handler returns: `ok(text)` for success,
// `err(text)` for a caller-facing error (isError: true). `slugValidationError`
// and `withToolError` are specializations that route through `err`.
function ok(text: string): ToolResponse {
  return { content: [{ type: 'text', text }] };
}

function err(text: string): ToolResponse {
  return { isError: true, content: [{ type: 'text', text }] };
}

export function slugValidationError(slug: string): ToolResponse {
  return err(`Invalid slug "${slug}": must be a non-empty relative path without "..", null bytes, or leading/trailing "/"`);
}

// Narrow a vault-resolution result to the error branch. VaultRuntime and
// VaultRuntime[] never carry `content`; a ToolResponse always does, and is
// never an array — so this distinguishes the error branch from either a single
// runtime or a runtime list.
function isToolError(x: unknown): x is ToolResponse {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && 'content' in x;
}

export function createMcpServer(
  registry: VaultRuntimeRegistry,
  config: { defaultExcludeTags?: string[] } = {},
): McpServer {
  const defaultExcludeTags = config.defaultExcludeTags ?? [];
  const vaultsByName = new Map(registry.vaults.map((v) => [v.name, v]));
  const defaultRuntime = vaultsByName.get(registry.defaultVault)!;
  const configuredNames = registry.vaults.map((v) => `"${v.name}"`).join(', ');
  // Default vault first, then the rest in registry order. This is the scan order
  // get_note uses when `vault` is omitted. Because a slug found in >1 vault
  // errors (never silently resolves), the ordering only determines the vault
  // order in that collision message — it does not pick a winner.
  const orderedVaults: VaultRuntime[] = [
    defaultRuntime,
    ...registry.vaults.filter((v) => v.name !== registry.defaultVault),
  ];

  const server = new McpServer({
    name: 'library',
    version: '1.0.0',
  });

  function unknownVaultError(name: string): ToolResponse {
    return err(`Unknown vault "${name}". Configured vaults: ${configuredNames}.`);
  }

  // Read tools: omitted `vault` spans all vaults (read-wide); a named vault
  // scopes to it (unknown → error). Returns the vault list or an error response.
  function resolveReadVaults(vault?: string): VaultRuntime[] | ToolResponse {
    if (vault === undefined) return registry.vaults;
    const v = vaultsByName.get(vault);
    if (!v) return unknownVaultError(vault);
    return [v];
  }

  // Write tools: omitted `vault` targets the default vault (write-narrow); a
  // named vault targets it (unknown → error). Returns the runtime or an error.
  function resolveWriteVault(vault?: string): VaultRuntime | ToolResponse {
    if (vault === undefined) return defaultRuntime;
    const v = vaultsByName.get(vault);
    if (!v) return unknownVaultError(vault);
    return v;
  }

  // Reused `vault` param descriptions.
  const readVaultParam = z.string().optional().describe(
    'Optional vault name. Omit to span all configured vaults (each result is tagged with its source vault); pass a name to scope to that vault.'
  );
  const writeVaultParam = z.string().optional().describe(
    'Optional vault name. Omit to target the default vault; pass a name to write to that specific vault.'
  );

  // Rebuild one vault's search index from its full note corpus. Called after
  // every write so subsequent searches in that vault see the change without
  // waiting for the watcher tick. Scoped to the written vault only.
  async function rebuildIndex(v: VaultRuntime): Promise<void> {
    const allNotes = await v.noteStore.listWithContent();
    v.searchIndex.buildIndexWithContent(allNotes);
  }

  // The shared skeleton of the surgical body/frontmatter mutators
  // (append_to_section, edit_note, edit_frontmatter): validate the slug, load the
  // note from the resolved vault, run a pure `transform`, and on success stamp
  // "updated", upsert, rebuild that vault's index, and return the full written
  // note. `transform` carries the only per-tool differences — the transform call,
  // its reason→message table, and which upsert fields change (body edits keep the
  // note's tags/related; frontmatter edits keep the body and supply new
  // tags/related/extras). The success shape's omitted `frontmatter` spreads to
  // `{ updated }`, matching the body-edit path.
  type SurgicalWriteResult =
    | { ok: true; content: string; tags?: string[]; related?: string[]; frontmatter?: Record<string, unknown> }
    | { ok: false; message: string };

  async function surgicalWrite(
    v: VaultRuntime,
    slug: string,
    failPrefix: string,
    transform: (note: Note) => SurgicalWriteResult,
  ): Promise<ToolResponse> {
    if (!isValidSlug(slug)) return slugValidationError(slug);
    let written;
    try {
      const note = await v.noteStore.get(slug);
      if (!note) {
        return err(`Note "${slug}" not found.`);
      }
      const result = transform(note);
      if (!result.ok) {
        return err(result.message);
      }
      const updated = new Date().toISOString().split('T')[0];
      written = await v.noteStore.upsert({
        slug,
        title: note.frontmatter.title,
        content: result.content,
        tags: result.tags,
        related: result.related,
        frontmatter: { ...result.frontmatter, updated },
      });
      await rebuildIndex(v);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`${failPrefix} "${slug}": ${msg}`);
    }
    return ok(written.raw);
  }

  async function withToolError(prefix: string, fn: () => Promise<ToolResponse>): Promise<ToolResponse> {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`${prefix}: ${msg}`);
    }
  }

  // ── Tools ──────────────────────────────────────────────────────────────────

  server.tool(
    'get_vault_context',
    'Fetch the vault bootstrap document (profile.md) from the vault root. ' +
    'Read this first to orient yourself to the vault — its structure, contents, ' +
    'and how to navigate it effectively. ' +
    'Load this silently for context; do not summarize or recite its contents unless the user explicitly asks.',
    {
      vault: z.string().optional().describe(
        'Optional vault name. Omit for the default vault\'s context; pass a name to load a specific vault\'s context file.'
      ),
    },
    async ({ vault }) =>
      withToolError('Failed to load vault context', async () => {
        const v = resolveWriteVault(vault);
        if (isToolError(v)) return v;
        const result = await vaultContextHandler(v.notesDir, v.contextFile);
        return ok(result.contents[0].text);
      })
  );

  server.tool(
    'list_notes',
    'List notes in the knowledge base, sorted by date (newest first). Optionally filter by slug prefix to scope results to a folder. '
    + 'By default spans all configured vaults; each result carries a `vault` field naming its source vault. '
    + 'Notes tagged with the vault\'s default-excluded tags (e.g. archived, historical) are omitted by default; pass exclude_tags: [] to include them, or a custom list to override the default. '
    + 'If you haven\'t already, call get_vault_context first to orient yourself to this vault.',
    {
      path: z.string().optional().describe('Optional slug prefix to filter by (e.g. "projects/startup"). Trailing slash is normalized automatically.'),
      exclude_tags: z.array(z.string()).optional().describe('Tags to exclude from results (case-insensitive). Omit to use the vault default-exclude set; pass [] to exclude nothing; pass a list to replace the default.'),
      vault: readVaultParam,
    },
    async ({ path: prefix, exclude_tags, vault }) =>
      withToolError('Failed to list notes', async () => {
        const vaults = resolveReadVaults(vault);
        if (isToolError(vaults)) return vaults;
        const normalized = prefix && (prefix.endsWith('/') ? prefix : prefix + '/');
        const tagged: Array<NoteListItem & { vault: string }> = [];
        for (const v of vaults) {
          const notes = await v.noteStore.list();
          for (const n of notes) tagged.push({ ...n, vault: v.name });
        }
        const filtered = normalized ? tagged.filter((n) => n.slug.startsWith(normalized)) : tagged;
        const excluded = filterByExcludedTags(filtered, exclude_tags ?? defaultExcludeTags);
        // Concat + sort by date desc across vaults (matches single-vault order:
        // same comparator NoteStore.list() uses, and Array.sort is stable).
        excluded.sort((a, b) => b.frontmatter.date.localeCompare(a.frontmatter.date));
        return ok(JSON.stringify(excluded, null, 2));
      })
  );

  server.tool(
    'get_note',
    'Get the full content and metadata of a specific note by its slug. ' +
    'By default resolves the slug across all vaults (default vault first); pass `vault` to read from a specific vault. '
    + 'If the slug exists in more than one vault, the call errors listing them so you can disambiguate with `vault`.',
    {
      slug: z.string().describe('The note slug (e.g. "react-hooks-rules")'),
      vault: z.string().optional().describe(
        'Optional vault name. Omit to resolve the slug across all vaults (default vault first); pass a name to read from that vault.'
      ),
    },
    async ({ slug, vault }) => {
      if (!isValidSlug(slug)) return slugValidationError(slug);
      if (vault !== undefined) {
        const v = vaultsByName.get(vault);
        if (!v) return unknownVaultError(vault);
        return withToolError(`Failed to read note "${slug}"`, async () => {
          const note = await v.noteStore.get(slug);
          if (!note) {
            return err(`Note "${slug}" not found in vault "${vault}".`);
          }
          return ok(note.raw);
        });
      }
      // Omitted vault → resolve default-first across all vaults. Raw is returned
      // unchanged (round-trips into update_note); a cross-vault slug collision
      // errors so the caller passes `vault` explicitly.
      return withToolError(`Failed to read note "${slug}"`, async () => {
        const hits: Array<{ vault: string; note: Note }> = [];
        for (const v of orderedVaults) {
          const note = await v.noteStore.get(slug);
          if (note) hits.push({ vault: v.name, note });
        }
        if (hits.length === 0) {
          return err(`Note "${slug}" not found.`);
        }
        if (hits.length > 1) {
          const names = hits.map((h) => `"${h.vault}"`).join(', ');
          return err(`Note "${slug}" exists in multiple vaults: ${names}. Pass vault to disambiguate.`);
        }
        return ok(hits[0].note.raw);
      });
    }
  );

  server.tool(
    'create_note',
    'Create a new note in the knowledge base. Provide a path to place it (e.g. "projects/startup/market-analysis") or omit to land it in inbox/. Use [[slug]] syntax to link to related notes. '
    + 'Writes to the default vault unless `vault` is given.',
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
      vault: writeVaultParam,
    },
    async ({ title, content, path: notePath, tags, related, frontmatter, vault }) => {
      const wv = resolveWriteVault(vault);
      if (isToolError(wv)) return wv;
      const slug = notePath ?? ('inbox/' + NoteStore.makeSlug(title));
      if (!isValidSlug(slug)) return slugValidationError(slug);

      // Denylist check on the explicit frontmatter param (first-fail, named key).
      if (frontmatter) {
        for (const key of Object.keys(frontmatter)) {
          if (FRONTMATTER_DENYLIST.has(key)) {
            return err(`Cannot set '${key}' via frontmatter; use the typed param.`);
          }
        }
      }

      let note;
      try {
        const existing = await wv.noteStore.get(slug);
        if (existing) {
          return err(`Note already exists at "${slug}" — use update_note to modify it.`);
        }
        note = await wv.noteStore.upsert({ slug, title, content, tags, related, frontmatter });
        await rebuildIndex(wv);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Failed to write note "${slug}": ${msg}`);
      }
      return ok(`Created note "${note.frontmatter.title}" with slug "${note.slug}".`);
    }
  );

  server.tool(
    'update_note',
    'Update an existing note. Pass the slug to identify which note to update. ' +
    'title, tags, and related can be passed as separate params or embedded as frontmatter in content — ' +
    'useful when passing back output from get_note directly. Explicit params take precedence over frontmatter values. ' +
    'Omit tags or related (or pass an empty array) to preserve existing values; pass a non-empty array to replace them. ' +
    'Non-tool-managed frontmatter fields (e.g. status) embedded in content are preserved on round-trip update. '
    + 'Targets the default vault unless `vault` is given — a note fetched from a non-default vault must pass that vault here.',
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
      vault: writeVaultParam,
    },
    async ({ slug, title, content, tags, related, frontmatter, vault }) => {
      const wv = resolveWriteVault(vault);
      if (isToolError(wv)) return wv;
      if (!isValidSlug(slug)) return slugValidationError(slug);
      let note;
      try {
        const existing = await wv.noteStore.get(slug);
        if (!existing) {
          return err(`Note "${slug}" not found.`);
        }
        const resolved = resolveFrontmatterParams({ title, content, tags, related, frontmatter });
        if (!resolved.ok) {
          return err(resolved.error);
        }
        note = await wv.noteStore.upsert({
          slug,
          title: resolved.title,
          content: resolved.content,
          tags: resolved.tags,
          related: resolved.related,
          frontmatter: resolved.frontmatter,
        });
        await rebuildIndex(wv);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Failed to write note "${slug}": ${msg}`);
      }
      return ok(`Updated note "${note.frontmatter.title}" (slug: "${note.slug}").`);
    }
  );

  server.tool(
    'append_to_section',
    'Append content under a named "## heading" in an existing note, without regenerating the whole body. ' +
    'Cheaper and safer than update_note for the common "add a bullet / log an entry" case — no need to read and resend the full note. ' +
    'The heading is matched by exact text (level-agnostic); content is inserted at the end of that section. ' +
    'Stamps the note\'s "updated" frontmatter field and returns the full updated note. '
    + 'Targets the default vault unless `vault` is given.',
    {
      slug: z.string().describe('The slug of the note to append to'),
      heading: z.string().min(1).describe('Exact text of the target "## heading" (without the leading #s)'),
      content: z.string().min(1).describe('Markdown content to append at the end of the section'),
      create_if_missing: z.boolean().default(false).describe(
        'If the heading is absent, create a new "## heading" section at the end of the note. ' +
        'Defaults to false — a missing heading errors with the note\'s existing headings so you can correct it.'
      ),
      vault: writeVaultParam,
    },
    async ({ slug, heading, content, create_if_missing, vault }) => {
      const wv = resolveWriteVault(vault);
      if (isToolError(wv)) return wv;
      return surgicalWrite(wv, slug, 'Failed to append to note', (note) => {
        const result = appendToSection(note.content, heading, content, create_if_missing);
        if (!result.ok) {
          if (result.reason === 'missing') {
            const list = result.headings.length ? result.headings.map((h) => `"${h}"`).join(', ') : '(none)';
            return { ok: false, message: `Heading "${heading}" not found in "${slug}". Existing headings: ${list}. Pass create_if_missing=true to create it.` };
          }
          return { ok: false, message: `Heading "${heading}" is ambiguous — matches ${result.count} headings in "${slug}". Use a more specific or nested heading.` };
        }
        return { ok: true, content: result.body, tags: note.frontmatter.tags, related: note.frontmatter.related };
      });
    }
  );

  server.tool(
    'edit_note',
    'Replace an exact string in a note\'s body with a new string, without regenerating the whole note. ' +
    'Mirrors the Edit-tool pattern — surgical exact-match find/replace — for targeted mid-body changes; ' +
    'cheaper and safer than update_note when you only need to change a specific passage. ' +
    'old_string must match exactly (whitespace included) and be unique unless replace_all is set. ' +
    'Stamps the note\'s "updated" frontmatter field and returns the full updated note. '
    + 'Targets the default vault unless `vault` is given.',
    {
      slug: z.string().describe('The slug of the note to edit'),
      old_string: z.string().min(1).describe('Exact text to find in the note body (whitespace-sensitive)'),
      new_string: z.string().describe('Text to replace it with (may be empty to delete the match)'),
      replace_all: z.boolean().default(false).describe(
        'Replace every occurrence of old_string. ' +
        'Defaults to false — a non-unique old_string errors with the match count so you can disambiguate.'
      ),
      vault: writeVaultParam,
    },
    async ({ slug, old_string, new_string, replace_all, vault }) => {
      const wv = resolveWriteVault(vault);
      if (isToolError(wv)) return wv;
      return surgicalWrite(wv, slug, 'Failed to edit note', (note) => {
        const result = editBody(note.content, old_string, new_string, replace_all);
        if (!result.ok) {
          if (result.reason === 'not_found') {
            return { ok: false, message: `old_string not found in "${slug}". It must match the note body exactly, including whitespace (frontmatter is not editable via this tool).` };
          }
          if (result.reason === 'no_change') {
            return { ok: false, message: `old_string and new_string are identical — no change to make in "${slug}".` };
          }
          return { ok: false, message: `old_string is not unique — matches ${result.count} places in "${slug}". Provide a longer, more specific old_string or pass replace_all=true.` };
        }
        return { ok: true, content: result.body, tags: note.frontmatter.tags, related: note.frontmatter.related };
      });
    }
  );

  server.tool(
    'edit_frontmatter',
    'Surgically edit a note\'s frontmatter — set scalar fields (e.g. status) and add/remove tags or related — without regenerating the body. ' +
    'Cheaper and safer than update_note for frontmatter-only maintenance (status transitions, retagging, related cleanup): the body is read from disk and passed through byte-for-byte, never re-emitted. ' +
    'set writes scalar passthrough fields (cannot set title/date/tags/related — use add_/remove_ or update_note); add_/remove_tags and add_/remove_related mutate those lists with set semantics (re-adding an existing entry or removing an absent one is a no-op). ' +
    'Stamps the note\'s "updated" frontmatter field and returns the full updated note. '
    + 'Targets the default vault unless `vault` is given.',
    {
      slug: z.string().describe('The slug of the note to edit'),
      set: z.record(z.string(), z.unknown()).optional().describe(
        'Scalar frontmatter fields to set, e.g. {status: "implemented"}. Cannot set title/date/tags/related — use add_tags/remove_tags, add_related/remove_related, or update_note. The "updated" field is stamped automatically and is ignored if supplied here.'
      ),
      add_tags: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Tags to add (union; re-adding an existing tag is a no-op)'),
      remove_tags: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Tags to remove (removing an absent tag is a no-op)'),
      add_related: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Related slugs to add (union; re-adding an existing one is a no-op)'),
      remove_related: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Related slugs to remove (removing an absent one is a no-op)'),
      vault: writeVaultParam,
    },
    async ({ slug, set, add_tags, remove_tags, add_related, remove_related, vault }) => {
      const wv = resolveWriteVault(vault);
      if (isToolError(wv)) return wv;
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
            return err(`Cannot set '${key}' via set; use ${lever}.`);
          }
        }
      }

      // `updated` is stamped automatically on every write; drop any caller value
      // so it can't manufacture a spurious "successful" write that just re-stamps
      // today. (It's off FRONTMATTER_DENYLIST — which update_note's content
      // round-trip relies on — so this tool strips it explicitly instead.)
      const setFields = set
        ? Object.fromEntries(Object.entries(set).filter(([k]) => k !== 'updated'))
        : undefined;

      return surgicalWrite(wv, slug, 'Failed to edit frontmatter of note', (note) => {
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
            return { ok: false, message: `edit_frontmatter on "${slug}" changed nothing — supply at least one of set, add_tags, remove_tags, add_related, remove_related.` };
          }
          if (result.reason === 'conflict') {
            return { ok: false, message: `${result.field} lists both add and remove of: ${result.entries.join(', ')} — incoherent, pick one.` };
          }
          // no_change
          return { ok: false, message: `edit_frontmatter on "${slug}" is a no-op — all adds already present, all removes absent, and set matches the current frontmatter.` };
        }
        // result.tags / result.related go straight to upsert's typed params —
        // never through coerceStringArray, whose []→undefined "preserve" collapse
        // would make "remove the last tag" silently no-op. result.extras is the
        // computed (existing + set) extras; `updated` is stamped by surgicalWrite.
        // The body is passed through untouched; only frontmatter changes.
        return { ok: true, content: note.content, tags: result.tags, related: result.related, frontmatter: result.extras };
      });
    }
  );

  server.tool(
    'delete_note',
    'Delete a note from the knowledge base by its slug. Targets the default vault unless `vault` is given.',
    {
      slug: z.string().describe('The slug of the note to delete'),
      vault: writeVaultParam,
    },
    async ({ slug, vault }) => {
      const wv = resolveWriteVault(vault);
      if (isToolError(wv)) return wv;
      if (!isValidSlug(slug)) return slugValidationError(slug);
      const result = await withToolError(`Failed to delete note "${slug}"`, async () => {
        const deleted = await wv.noteStore.delete(slug);
        if (!deleted) {
          return err(`Note "${slug}" not found.`);
        }
        return ok(`Deleted note "${slug}".`);
      });
      // Secondary best-effort: rebuild the search index after a successful delete.
      // A failure here is logged but does not change the response — the deletion
      // itself succeeded, and the index will catch up on the next watcher tick.
      if (!result.isError) {
        try {
          await rebuildIndex(wv);
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
    'Search the knowledge base using keyword search. Returns matching notes scored by relevance, with excerpts. '
    + 'By default spans all configured vaults, merging results by score; each result carries a `vault` field naming its source vault. '
    + 'Notes tagged with the vault\'s default-excluded tags (e.g. archived, historical) are omitted by default; pass exclude_tags: [] to include them, or a custom list to override the default.',
    {
      query: z.string().describe('Search query — keywords to search for'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum number of results to return (default: 10, max: 100)'),
      exclude_tags: z.array(z.string()).optional().describe('Tags to exclude from results (case-insensitive). Omit to use the vault default-exclude set; pass [] to exclude nothing; pass a list to replace the default.'),
      vault: readVaultParam,
    },
    async ({ query, limit, exclude_tags, vault }) =>
      withToolError('Search failed', async () => {
        const vaults = resolveReadVaults(vault);
        if (isToolError(vaults)) return vaults;
        const cap = limit ?? 10;
        // Query each vault's index (asking each for up to `cap`), tag results
        // with provenance, then merge by raw BM25 score and take the global top
        // `cap`.
        //
        // Limitation: each vault's scores are computed against
        // *its own* corpus statistics — IDF, avgDocLen, docFreq are per-index —
        // so raw scores are NOT normalized across vaults and are only loosely
        // comparable. A term that is rare (high IDF) in a small vault can outrank
        // the same term in a large vault where it is common. This is accepted at
        // the single-user / few-vaults scale; no cross-corpus score normalization
        // ships in v1. Asking each index for `cap` (not a per-vault fraction)
        // keeps the merge exact for the top `cap` — no vault is under-sampled.
        const merged: Array<SearchResult & { vault: string }> = [];
        for (const v of vaults) {
          const results = v.searchIndex.search(query, cap, exclude_tags ?? defaultExcludeTags);
          for (const r of results) merged.push({ ...r, vault: v.name });
        }
        merged.sort((a, b) => b.score - a.score);
        const limited = merged.slice(0, cap);
        if (limited.length === 0) {
          return ok(`No notes found matching "${query}".`);
        }
        return ok(JSON.stringify(limited, null, 2));
      })
  );

  server.tool(
    'list_todos',
    'List notes that contain incomplete `- [ ]` markdown checkboxes, with each todo\'s text excerpted. ' +
    'Filter by slug prefix to scope to a folder. ' +
    'Useful for finding open work across the vault. Note: checkbox syntax inside fenced code blocks is ignored. '
    + 'By default spans all configured vaults; each result carries a `vault` field naming its source vault. '
    + 'Notes tagged with the vault\'s default-excluded tags (e.g. archived, historical) are omitted by default; pass exclude_tags: [] to include them, or a custom list to override the default.',
    {
      path: z.string().optional().describe('Optional slug prefix to filter by (e.g. "projects/startup"). Trailing slash is normalized automatically.'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum number of notes to return (default: 10, max: 100)'),
      exclude_tags: z.array(z.string()).optional().describe('Tags to exclude from results (case-insensitive). Omit to use the vault default-exclude set; pass [] to exclude nothing; pass a list to replace the default.'),
      vault: readVaultParam,
    },
    async ({ path: prefix, limit, exclude_tags, vault }) =>
      withToolError('Failed to list todos', async () => {
        const vaults = resolveReadVaults(vault);
        if (isToolError(vaults)) return vaults;
        const normalized = prefix && (prefix.endsWith('/') ? prefix : prefix + '/');
        const gathered: Array<NoteListItem & { content: string; vault: string }> = [];
        for (const v of vaults) {
          const notes = await v.noteStore.listWithContent();
          for (const n of notes) gathered.push({ ...n, vault: v.name });
        }
        // Concat + sort by date desc across vaults (same comparator as list()).
        gathered.sort((a, b) => b.frontmatter.date.localeCompare(a.frontmatter.date));
        const scoped = normalized ? gathered.filter((n) => n.slug.startsWith(normalized)) : gathered;
        // Exclude before the map below drops frontmatter (and before the limit slice).
        const visible = filterByExcludedTags(scoped, exclude_tags ?? defaultExcludeTags);

        const withTodos = visible
          .map((n) => ({
            slug: n.slug,
            title: n.frontmatter.title,
            todos: extractTodos(n.content),
            vault: n.vault,
          }))
          .filter((n) => n.todos.length > 0)
          .slice(0, limit ?? 10);

        if (withTodos.length === 0) {
          return ok('No notes found with incomplete TODOs.');
        }
        return ok(JSON.stringify(withTodos, null, 2));
      })
  );

  server.tool(
    'move_note',
    'Move a note to a new location in the vault. Preserves all metadata (title, date, tags, related) ' +
    'and automatically updates related fields in other notes that reference the old slug. ' +
    'Fails if a note already exists at the target slug — delete it first if you intend to replace. '
    + 'Operates within a single vault (the default unless `vault` is given); cross-vault moves are not supported here — use the promote skill.',
    {
      slug: z.string().describe('The current slug of the note to move'),
      new_slug: z.string().describe('The target slug to move the note to'),
      vault: writeVaultParam,
    },
    async ({ slug, new_slug, vault }) => {
      const wv = resolveWriteVault(vault);
      if (isToolError(wv)) return wv;
      if (!isValidSlug(slug)) return slugValidationError(slug);
      if (!isValidSlug(new_slug)) return slugValidationError(new_slug);
      if (slug === new_slug) {
        return err('Source and target slugs are the same.');
      }

      try {
        const { updatedRefs } = await wv.noteStore.move(slug, new_slug);
        await rebuildIndex(wv);

        let msg = `Moved note from "${slug}" to "${new_slug}".`;
        if (updatedRefs.length > 0) {
          msg += ` Updated references in ${updatedRefs.length} note(s): ${updatedRefs.join(', ')}.`;
        }
        return ok(msg);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Surface the "already exists" case with user-friendly guidance.
        // The underlying error message contains the absolute target path
        // (from writeAtomically); we match on the prefix instead of the slug.
        if (msg.startsWith('Note already exists at "')) {
          return err(`Note already exists at "${new_slug}" — choose a different slug.`);
        }
        return err(`Failed to move note "${slug}": ${msg}`);
      }
    }
  );

  // ── Resources ──────────────────────────────────────────────────────────────
  //
  // MCP resources have no param surface, so they stay bound to the default
  // vault. Multi-vault resource enumeration is not supported through resources.

  // List all notes as resources (default vault)
  server.resource(
    'notes-index',
    'notes://index',
    { description: 'Index of all notes in the knowledge base' },
    async () => {
      let notes;
      try {
        notes = await defaultRuntime.noteStore.list();
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
    () => vaultContextHandler(defaultRuntime.notesDir, defaultRuntime.contextFile)
  );

  // Individual note resources via template (default vault)
  const noteTemplate = new ResourceTemplate('note://{slug}', {
    list: async () => {
      let notes;
      try {
        notes = await defaultRuntime.noteStore.list();
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
        note = await defaultRuntime.noteStore.get(decodedSlug);
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
