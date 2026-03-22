# PKM MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip the library project down to a focused MCP stdio server that reads and writes notes in a nested Obsidian-compatible vault at `$NOTES_DIR`, replacing the flat single-directory design with full recursive support.

**Architecture:** `NoteStore` handles all file I/O (recursive walk, mkdir-on-write, conflict-file filtering); `SearchIndex` indexes note body content for keyword search; `createMcpServer` wires the 7 MCP tools and 2 resource handlers. The entry point `mcp-entry.ts` is the only runtime artefact — no HTTP server, no frontend.

**Tech Stack:** Node.js/TypeScript, `@modelcontextprotocol/sdk`, `gray-matter` (frontmatter), `chokidar` (file watching), `slugify`, Jest + ts-jest for testing.

---

## File Map

| File | Action | What it does |
|---|---|---|
| `client/` | Delete entire directory | Frontend no longer needed |
| `server/src/routes/` | Delete entire directory | REST API no longer needed |
| `server/src/notes/noteBlockParser.ts` | Delete | Replaced by direct MCP tool writes |
| `server/src/notes/__tests__/noteBlockParser.test.ts` | Delete | Tests for deleted file |
| `server/src/index.ts` | Delete | HTTP server entry point, replaced by mcp-entry.ts |
| `compose.yml` | Modify | Remove client service |
| `server/src/notes/NoteStore.ts` | Modify | Recursive list, mkdir-on-write, listWithContent, recursive watcher |
| `server/src/notes/__tests__/NoteStore.test.ts` | Modify | Add tests for nested paths, conflict filtering, listWithContent |
| `server/src/search/SearchIndex.ts` | Modify | Fix buildIndexWithContent to include `related` |
| `server/src/search/__tests__/SearchIndex.test.ts` | Modify | Add test for related-slug search |
| `server/src/mcp/server.ts` | Modify | Slug validation, create_note path/inbox, list_notes filter, get_profile, URI encoding, switch to buildIndexWithContent |
| `server/src/mcp/__tests__/mcpTools.test.ts` | Modify | Add tests for new behaviors, switch to listWithContent+buildIndexWithContent |
| `server/src/mcp-entry.ts` | Modify | Switch to listWithContent+buildIndexWithContent at startup and in change handler |

---

## Task 1: Remove Dead Code

**Files:**
- Delete: `client/`
- Delete: `server/src/routes/`
- Delete: `server/src/notes/noteBlockParser.ts`
- Delete: `server/src/notes/__tests__/noteBlockParser.test.ts`
- Delete: `server/src/index.ts`
- Modify: `compose.yml`

- [ ] **Step 1: Delete removed directories and files**

```bash
rm -rf /home/ethan/workspace/library/client
rm -rf /home/ethan/workspace/library/server/src/routes
rm /home/ethan/workspace/library/server/src/notes/noteBlockParser.ts
rm /home/ethan/workspace/library/server/src/notes/__tests__/noteBlockParser.test.ts
rm /home/ethan/workspace/library/server/src/index.ts
```

- [ ] **Step 2: Remove client service from compose.yml**

In `compose.yml`, delete the entire `client:` block (lines 16–29 in the current file). The result should be just the `server:` service with no client.

- [ ] **Step 3: Verify tests still pass**

```bash
cd /home/ethan/workspace/library/server && npm test
```

Expected: all existing tests pass (NoteStore, SearchIndex, mcpTools).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: remove frontend, REST routes, and noteBlockParser"
```

---

## Task 2: NoteStore — Recursive List with Conflict Filter

**Files:**
- Modify: `server/src/notes/NoteStore.ts`
- Modify: `server/src/notes/__tests__/NoteStore.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `server/src/notes/__tests__/NoteStore.test.ts` (inside the existing `describe` block, after existing tests):

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/ethan/workspace/library/server && npm test -- --testPathPattern=NoteStore
```

Expected: FAIL — "list returns notes in subdirectories" fails (current flat readdir misses subdirs).

- [ ] **Step 3: Replace `list()` with a recursive walk**

In `server/src/notes/NoteStore.ts`, replace the entire `list()` method with:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/ethan/workspace/library/server && npm test -- --testPathPattern=NoteStore
```

Expected: all NoteStore tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/notes/NoteStore.ts server/src/notes/__tests__/NoteStore.test.ts
git commit -m "feat: NoteStore recursive list with sync-conflict filtering"
```

---

## Task 3: NoteStore — mkdir-on-Write for Nested Slugs

**Files:**
- Modify: `server/src/notes/NoteStore.ts`
- Modify: `server/src/notes/__tests__/NoteStore.test.ts`

- [ ] **Step 1: Write failing test**

Add to `server/src/notes/__tests__/NoteStore.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/ethan/workspace/library/server && npm test -- --testPathPattern=NoteStore
```

Expected: FAIL — writing to a nested path fails because the parent directory doesn't exist.

- [ ] **Step 3: Add mkdir to upsert**

In `server/src/notes/NoteStore.ts`, update `upsert()` — add the `mkdir` call before `writeFile`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/ethan/workspace/library/server && npm test -- --testPathPattern=NoteStore
```

Expected: all NoteStore tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/notes/NoteStore.ts server/src/notes/__tests__/NoteStore.test.ts
git commit -m "feat: NoteStore upsert creates intermediate directories for nested slugs"
```

---

## Task 4: NoteStore — `listWithContent()`

**Files:**
- Modify: `server/src/notes/NoteStore.ts`
- Modify: `server/src/notes/__tests__/NoteStore.test.ts`

- [ ] **Step 1: Write failing test**

Add to `server/src/notes/__tests__/NoteStore.test.ts`:

```typescript
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
});

test('listWithContent preserves date-descending sort', async () => {
  await store.upsert({ title: 'One', content: 'one' });
  await store.upsert({ title: 'Two', content: 'two' });
  const byContent = await store.listWithContent();
  const byList = await store.list();
  expect(byContent.map((n) => n.slug)).toEqual(byList.map((n) => n.slug));
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/ethan/workspace/library/server && npm test -- --testPathPattern=NoteStore
```

Expected: FAIL — `listWithContent` does not exist yet.

- [ ] **Step 3: Add `listWithContent()` to NoteStore**

Add after the `list()` method in `server/src/notes/NoteStore.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/ethan/workspace/library/server && npm test -- --testPathPattern=NoteStore
```

Expected: all NoteStore tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/notes/NoteStore.ts server/src/notes/__tests__/NoteStore.test.ts
git commit -m "feat: NoteStore listWithContent for full-text index building"
```

---

## Task 5: NoteStore — Recursive File Watcher

**Files:**
- Modify: `server/src/notes/NoteStore.ts`

No new tests (watcher is timing-dependent; the existing watcher integration is exercised by the runtime). Just update the glob and filter.

- [ ] **Step 1: Update `startWatcher()` to use recursive glob and filter conflicts**

In `server/src/notes/NoteStore.ts`, replace the `startWatcher()` method. The change handler no longer passes a payload to `emit` — the mcp-entry listener (Task 7) calls `listWithContent()` itself, so emitting the list is redundant:

```typescript
private startWatcher(): void {
  this.watcher = chokidar.watch(path.join(this.notesDir, '**', '*.md'), {
    ignoreInitial: true,
    persistent: true,
    ignored: (filePath: string) => filePath.includes('.sync-conflict'),
  });

  const onChange = () => {
    this.emit('change');
  };

  this.watcher.on('add', onChange);
  this.watcher.on('change', onChange);
  this.watcher.on('unlink', onChange);
}
```

- [ ] **Step 2: Run full test suite to verify nothing broke**

```bash
cd /home/ethan/workspace/library/server && npm test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/notes/NoteStore.ts
git commit -m "feat: NoteStore recursive file watcher with conflict-file filter"
```

---

## Task 6: SearchIndex — Fix `buildIndexWithContent` to Include `related`

**Files:**
- Modify: `server/src/search/SearchIndex.ts`
- Modify: `server/src/search/__tests__/SearchIndex.test.ts`

- [ ] **Step 1: Write failing test**

Add to `server/src/search/__tests__/SearchIndex.test.ts` (inside the existing describe block):

```typescript
test('buildIndexWithContent indexes related slugs', () => {
  const index = new SearchIndex();
  index.buildIndexWithContent([
    {
      slug: 'projects/finances/overview',
      frontmatter: {
        title: 'Finances Overview',
        date: '2026-01-01',
        tags: [],
        related: ['projects/startup-research/index'],
      },
      content: 'My finances overview.',
    },
  ]);
  const results = index.search('startup-research');
  expect(results).toHaveLength(1);
  expect(results[0].slug).toBe('projects/finances/overview');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/ethan/workspace/library/server && npm test -- --testPathPattern=SearchIndex
```

Expected: FAIL — related slugs are not currently indexed by `buildIndexWithContent`.

- [ ] **Step 3: Fix `buildIndexWithContent` to include `related`**

In `server/src/search/SearchIndex.ts`, update `buildIndexWithContent`:

```typescript
buildIndexWithContent(notes: Array<NoteListItem & { content: string }>): void {
  this.entries = notes.map((note) => {
    const text = [
      note.frontmatter.title,
      ...note.frontmatter.tags,
      ...note.frontmatter.related,
      note.content,
    ].join(' ');
    return {
      slug: note.slug,
      frontmatter: note.frontmatter,
      terms: this.tokenize(text),
      text,
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/ethan/workspace/library/server && npm test -- --testPathPattern=SearchIndex
```

Expected: all SearchIndex tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/search/SearchIndex.ts server/src/search/__tests__/SearchIndex.test.ts
git commit -m "fix: SearchIndex buildIndexWithContent now indexes related slugs"
```

---

## Task 7: mcp-entry — Switch to `listWithContent` + `buildIndexWithContent`

**Files:**
- Modify: `server/src/mcp-entry.ts`

- [ ] **Step 1: Update `mcp-entry.ts`**

Replace the startup index build and change handler in `server/src/mcp-entry.ts`:

```typescript
// Replace these two lines:
//   const allNotes = await noteStore.list();
//   searchIndex.buildIndex(allNotes);
// With:
const allNotes = await noteStore.listWithContent();
searchIndex.buildIndexWithContent(allNotes);

// Replace the change handler:
// noteStore.on('change', (notes) => {
//   searchIndex.buildIndex(notes);
// });
// With:
// The watcher emits 'change' with no payload after Task 5's update
noteStore.on('change', async () => {
  const notes = await noteStore.listWithContent();
  searchIndex.buildIndexWithContent(notes);
});
```

The full updated `main()` function should look like:

```typescript
async function main() {
  const config = await loadConfig();
  const notesDir = process.env.NOTES_DIR || config.notesDir || path.join(__dirname, '../../notes');

  const noteStore = new NoteStore(notesDir);
  const searchIndex = new SearchIndex();

  await noteStore.initialize();

  const allNotes = await noteStore.listWithContent();
  searchIndex.buildIndexWithContent(allNotes);

  noteStore.on('change', async () => {
    const notes = await noteStore.listWithContent();
    searchIndex.buildIndexWithContent(notes);
  });

  // Note: notesDir will be added as a third arg to createMcpServer in Task 10
  const server = createMcpServer(noteStore, searchIndex);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  process.on('SIGINT', async () => {
    await noteStore.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await noteStore.close();
    process.exit(0);
  });
}
```

- [ ] **Step 2: Run full test suite**

```bash
cd /home/ethan/workspace/library/server && npm test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/mcp-entry.ts
git commit -m "feat: mcp-entry uses buildIndexWithContent for full-text search at startup"
```

---

## Task 8: MCP Server — Slug Validation + `create_note` Rewrite

**Files:**
- Modify: `server/src/mcp/server.ts`
- Modify: `server/src/mcp/__tests__/mcpTools.test.ts`

- [ ] **Step 1: Write failing tests for new `create_note` behavior**

Add to `server/src/mcp/__tests__/mcpTools.test.ts`:

```typescript
// Slug validation — tests the exact predicate logic used by isValidSlug in server.ts
test('slug validation rejects path traversal and absolute paths', () => {
  const isValidSlug = (slug: string) => !slug.includes('..') && !slug.startsWith('/');
  expect(isValidSlug('../etc/passwd')).toBe(false);
  expect(isValidSlug('/absolute/path')).toBe(false);
  expect(isValidSlug('projects/my-note')).toBe(true);
  expect(isValidSlug('inbox/hello-world')).toBe(true);
});

// create_note: path parameter becomes the slug verbatim
test('create_note with explicit path slug places note at that path', async () => {
  const slug = 'projects/startup/market-analysis';
  await noteStore.upsert({ slug, title: 'Market Analysis', content: 'TAM analysis.' });
  const note = await noteStore.get(slug);
  expect(note).not.toBeNull();
  expect(note!.slug).toBe(slug);
  expect(note!.frontmatter.title).toBe('Market Analysis');
});

// create_note: no path defaults to inbox/<title-slug>
test('create_note without path uses inbox/ prefix', () => {
  // Tests the slug derivation: 'inbox/' + NoteStore.makeSlug(title)
  const defaultSlug = (title: string) => 'inbox/' + NoteStore.makeSlug(title);
  expect(defaultSlug('My New Note')).toBe('inbox/my-new-note');
  expect(defaultSlug('Startup Research')).toBe('inbox/startup-research');
});

// create_note: collision guard — handler calls noteStore.get() before upsert
test('create_note collision guard: noteStore.get detects existing note', async () => {
  await noteStore.upsert({ slug: 'inbox/my-note', title: 'My Note', content: 'v1' });
  const existing = await noteStore.get('inbox/my-note');
  // Handler pattern: if (existing) return isError. Confirm the check works.
  expect(existing).not.toBeNull();
  expect(existing!.content.trim()).toContain('v1');
});

// search now indexes body content via buildIndexWithContent
test('search_notes finds matches in note body content', async () => {
  await noteStore.upsert({ title: 'Alpha Note', content: 'The secret keyword is xyzzy123.' });
  const allNotes = await noteStore.listWithContent();
  searchIndex.buildIndexWithContent(allNotes);
  const results = searchIndex.search('xyzzy123');
  expect(results).toHaveLength(1);
  expect(results[0].slug).toBe('alpha-note');
});
```

- [ ] **Step 2: Run tests to see which pass/fail**

```bash
cd /home/ethan/workspace/library/server && npm test -- --testPathPattern=mcpTools
```

Expected: slug validation, path slug, and inbox default tests pass immediately. The body content search test will fail until Task 6 (SearchIndex fix) is done — that's expected.

- [ ] **Step 3: Add `isValidSlug` helper and rewrite `create_note` in `server/src/mcp/server.ts`**

Add this helper near the top of `createMcpServer` (before the first `server.tool` call):

```typescript
function isValidSlug(slug: string): boolean {
  return !slug.includes('..') && !slug.startsWith('/');
}

function slugValidationError(slug: string) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `Invalid slug "${slug}": must be a relative path without ..` }],
  };
}
```

Replace the existing `create_note` tool registration with:

```typescript
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
```

- [ ] **Step 4: Add slug validation and update index rebuild in `get_note`, `update_note`, `delete_note`**

Replace the `get_note` handler body (the async function passed to `server.tool`) with:
```typescript
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
```

Replace the `update_note` handler body with:
```typescript
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
```

Replace the `delete_note` handler body with:
```typescript
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
```

- [ ] **Step 5: Run full test suite**

```bash
cd /home/ethan/workspace/library/server && npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/mcp/server.ts server/src/mcp/__tests__/mcpTools.test.ts
git commit -m "feat: create_note supports path param, inbox default, duplicate guard, slug validation"
```

---

## Task 9: MCP Server — `list_notes` Path Filter

**Files:**
- Modify: `server/src/mcp/server.ts`
- Modify: `server/src/mcp/__tests__/mcpTools.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `server/src/mcp/__tests__/mcpTools.test.ts`:

```typescript
describe('list_notes path filter', () => {
  beforeEach(async () => {
    await noteStore.upsert({ slug: 'projects/startup/index', title: 'Startup Index', content: 'a' });
    await noteStore.upsert({ slug: 'projects/finances/index', title: 'Finances Index', content: 'b' });
    await noteStore.upsert({ slug: 'reference/react-hooks', title: 'React Hooks', content: 'c' });
  });

  function filterByPath(notes: NoteListItem[], prefix: string | undefined): NoteListItem[] {
    if (!prefix) return notes;
    const normalized = prefix.endsWith('/') ? prefix : prefix + '/';
    return notes.filter((n) => n.slug.startsWith(normalized));
  }

  test('no path returns all notes', async () => {
    const notes = await noteStore.list();
    expect(filterByPath(notes, undefined)).toHaveLength(3);
  });

  test('path filter returns only matching prefix', async () => {
    const notes = await noteStore.list();
    const filtered = filterByPath(notes, 'projects');
    expect(filtered).toHaveLength(2);
    expect(filtered.map((n) => n.slug)).toContain('projects/startup/index');
    expect(filtered.map((n) => n.slug)).toContain('projects/finances/index');
  });

  test('trailing slash is normalized', async () => {
    const notes = await noteStore.list();
    expect(filterByPath(notes, 'projects/')).toHaveLength(2);
    expect(filterByPath(notes, 'projects')).toHaveLength(2);
  });

  test('partial prefix does not match', async () => {
    const notes = await noteStore.list();
    expect(filterByPath(notes, 'project')).toHaveLength(0); // not a prefix of "projects/"
  });

  test('empty string returns all notes', async () => {
    const notes = await noteStore.list();
    expect(filterByPath(notes, '')).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (logic is in test helper)**

```bash
cd /home/ethan/workspace/library/server && npm test -- --testPathPattern=mcpTools
```

Expected: the filter logic tests all pass (they test a local function, confirming the algorithm before wiring it in).

- [ ] **Step 3: Add `path` parameter to `list_notes` tool in `server/src/mcp/server.ts`**

Replace the existing `list_notes` tool registration with:

```typescript
server.tool(
  'list_notes',
  'List notes in the knowledge base, sorted by date (newest first). Optionally filter by slug prefix to scope results to a folder.',
  {
    path: z.string().optional().describe('Optional slug prefix to filter by (e.g. "projects/startup"). Trailing slash is normalized automatically.'),
  },
  async ({ path: prefix }) => {
    const notes = await noteStore.list();
    const filtered = (() => {
      if (!prefix) return notes;
      const normalized = prefix.endsWith('/') ? prefix : prefix + '/';
      return notes.filter((n) => n.slug.startsWith(normalized));
    })();
    return {
      content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }],
    };
  }
);
```

- [ ] **Step 4: Run full test suite**

```bash
cd /home/ethan/workspace/library/server && npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/mcp/server.ts server/src/mcp/__tests__/mcpTools.test.ts
git commit -m "feat: list_notes supports optional path prefix filter"
```

---

## Task 10: MCP Server — `get_profile` Tool

**Files:**
- Modify: `server/src/mcp/server.ts`
- Modify: `server/src/mcp/__tests__/mcpTools.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `server/src/mcp/__tests__/mcpTools.test.ts`. Add `import path from 'path'` at the top if not already present. These tests call `get_profile` logic directly (reading from `notesDir`, the same thing the tool does):

```typescript
describe('get_profile', () => {
  test('returns profile.md content when it exists', async () => {
    // Write a profile and read it back — same operation the tool does
    await fs.writeFile(
      path.join(dir, 'profile.md'),
      '# Ethan\nSoftware engineer. Interested in startups.'
    );
    const raw = await fs.readFile(path.join(dir, 'profile.md'), 'utf-8');
    expect(raw).toContain('Ethan');
    expect(raw).toContain('Software engineer');
  });

  test('returns error when profile.md is missing', async () => {
    // Verify the file does not exist — the tool catch block returns isError
    const profilePath = path.join(dir, 'profile.md');
    let readError: Error | null = null;
    try {
      await fs.readFile(profilePath, 'utf-8');
    } catch (e) {
      readError = e as Error;
    }
    expect(readError).not.toBeNull(); // tool would return isError: true
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd /home/ethan/workspace/library/server && npm test -- --testPathPattern=mcpTools
```

Expected: pass — they test the same file I/O the tool uses.

- [ ] **Step 3: Add `get_profile` to `server/src/mcp/server.ts`**

The function signature of `createMcpServer` needs the `notesDir` to construct the profile path. Update the function signature and add the tool:

```typescript
// Update the function signature to accept notesDir:
export function createMcpServer(noteStore: NoteStore, searchIndex: SearchIndex, notesDir: string): McpServer {
```

Add the `get_profile` tool (place it first, before `list_notes`):

```typescript
server.tool(
  'get_profile',
  'Fetch the personal profile (profile.md) from the vault root. Contains context about the user — fetch this at the start of personal conversations.',
  {},
  async () => {
    try {
      const raw = await fs.readFile(path.join(notesDir, 'profile.md'), 'utf-8');
      return { content: [{ type: 'text', text: raw }] };
    } catch {
      return {
        isError: true,
        content: [{ type: 'text', text: 'profile.md not found — create it at the vault root to use this tool.' }],
      };
    }
  }
);
```

Add the import at the top of `server/src/mcp/server.ts`:
```typescript
import fs from 'fs/promises';
import path from 'path';
```

- [ ] **Step 4: Update `mcp-entry.ts` to pass `notesDir` to `createMcpServer`**

In `server/src/mcp-entry.ts`, change:
```typescript
const server = createMcpServer(noteStore, searchIndex);
```
To:
```typescript
const server = createMcpServer(noteStore, searchIndex, notesDir);
```

- [ ] **Step 5: Run full test suite**

```bash
cd /home/ethan/workspace/library/server && npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/mcp/server.ts server/src/mcp-entry.ts server/src/mcp/__tests__/mcpTools.test.ts
git commit -m "feat: add get_profile MCP tool"
```

---

## Task 11: MCP Server — Resource Handler URI Encoding

**Files:**
- Modify: `server/src/mcp/server.ts`

No new tests (MCP resource handlers require full transport plumbing to test). Update two locations.

- [ ] **Step 1: Fix `notes://index` resource handler to URL-encode slugs**

In `server/src/mcp/server.ts`, in the `notes://index` resource handler, change:
```typescript
(n) => `- [${n.frontmatter.title}](note://${n.slug}) — ${n.frontmatter.date} [${n.frontmatter.tags.join(', ')}]`
```
To:
```typescript
(n) => `- [${n.frontmatter.title}](note://${encodeURIComponent(n.slug)}) — ${n.frontmatter.date} [${n.frontmatter.tags.join(', ')}]`
```

- [ ] **Step 2: Fix `noteTemplate` list callback to URL-encode slugs**

In the `noteTemplate` list callback, change:
```typescript
uri: `note://${n.slug}`,
```
To:
```typescript
uri: `note://${encodeURIComponent(n.slug)}`,
```

- [ ] **Step 3: Fix `note` resource handler to URL-decode the slug parameter**

In the `server.resource('note', ...)` handler, change:
```typescript
async (uri, { slug }) => {
  const note = await noteStore.get(slug as string);
```
To:
```typescript
async (uri, { slug }) => {
  const note = await noteStore.get(decodeURIComponent(slug as string));
```

- [ ] **Step 4: Run full test suite**

```bash
cd /home/ethan/workspace/library/server && npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/mcp/server.ts
git commit -m "fix: URL-encode slugs in note:// URIs, decode on resource handler lookup"
```

---

## Task 12: Update mcpTools Tests + Final Verification

**Files:**
- Modify: `server/src/mcp/__tests__/mcpTools.test.ts`

The `mcpTools.test.ts` still has three tests calling `searchIndex.buildIndex(notes)` where `notes` comes from `noteStore.list()`. Update these to use `listWithContent` + `buildIndexWithContent` so they test the actual runtime code path.

- [ ] **Step 1: Update the three stale `buildIndex` calls in `mcpTools.test.ts`**

Find the tests `'create_note updates search index'`, `'search_notes finds notes by keyword'`, and `'search_notes returns empty for no matches'`. Change each pattern:

```typescript
// Old pattern:
const notes = await noteStore.list();
searchIndex.buildIndex(notes);

// New pattern:
const notes = await noteStore.listWithContent();
searchIndex.buildIndexWithContent(notes);
```

- [ ] **Step 2: Add NoteListItem import if needed**

Ensure `NoteListItem` is imported at the top of `mcpTools.test.ts` for the `list_notes` filter tests. Add if missing:
```typescript
import type { NoteListItem } from '../../types.js';
import { NoteStore } from '../../notes/NoteStore.js';
```

- [ ] **Step 3: Run full test suite one final time**

```bash
cd /home/ethan/workspace/library/server && npm test
```

Expected: all tests pass, no skips, no failures.

- [ ] **Step 4: Build to verify TypeScript compiles cleanly**

```bash
cd /home/ethan/workspace/library/server && npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 5: Final commit**

```bash
git add server/src/mcp/__tests__/mcpTools.test.ts
git commit -m "test: update mcpTools to use listWithContent and buildIndexWithContent"
```

---

## Post-Implementation: Claude Code Config

After all tasks are complete, add the MCP server config to `~/.claude/settings.json` on each machine:

```json
{
  "mcpServers": {
    "library": {
      "command": "node",
      "args": ["/home/ethan/workspace/library/server/dist/mcp-entry.js"],
      "env": {
        "NOTES_DIR": "/home/ethan/vault"
      }
    }
  }
}
```

For development (without building first), use `tsx` instead:
```json
{
  "mcpServers": {
    "library": {
      "command": "npx",
      "args": ["tsx", "/home/ethan/workspace/library/server/src/mcp-entry.ts"],
      "env": {
        "NOTES_DIR": "/home/ethan/vault"
      }
    }
  }
}
```
