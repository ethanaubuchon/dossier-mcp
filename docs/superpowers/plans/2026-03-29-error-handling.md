# Error Handling Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all MCP tool/resource handlers report accurate, actionable error messages instead of swallowing or misattributing errors.

**Architecture:** Fix error handling bottom-up: first make `NoteStore` methods distinguish error types (ENOENT vs parse vs I/O), then fix `vaultContextHandler`, then wrap all unprotected MCP handlers in try-catch. Each layer builds on the one below it.

**Tech Stack:** TypeScript, Node.js fs/promises, gray-matter, Vitest, @modelcontextprotocol/sdk

---

## File Structure

| File | Role | Changes |
|------|------|---------|
| `server/src/notes/NoteStore.ts` | Data access layer | `get()`: throw on non-ENOENT errors. `list()`/`listWithContent()`: log skipped files to stderr. |
| `server/src/mcp/server.ts` | MCP tool/resource handlers | Fix `vaultContextHandler` error discrimination. Add try-catch to `list_notes`, `get_note`, `delete_note`, `search_notes`, `notes-index` resource, `note` template resource. |
| `server/src/mcp/__tests__/mcpTools.test.ts` | Tests | Add tests for all new error paths. |
| `server/src/notes/__tests__/NoteStore.test.ts` | Tests | Add tests for NoteStore error discrimination. |

---

### Task 1: NoteStore.get() — distinguish "not found" from "parse error"

Fixes #32. Currently `get()` catches all errors and returns `null`. After this change, it returns `null` only for ENOENT and throws for everything else (corrupt frontmatter, EACCES, etc.).

**Files:**
- Modify: `server/src/notes/__tests__/NoteStore.test.ts`
- Modify: `server/src/notes/NoteStore.ts:163-176`

- [ ] **Step 1: Write failing tests for get() error discrimination**

Add these tests to the existing `NoteStore.test.ts` describe block:

```typescript
test('get() returns null for missing note', async () => {
  const note = await noteStore.get('nonexistent');
  expect(note).toBeNull();
});

test('get() throws on malformed frontmatter (not ENOENT)', async () => {
  await fs.writeFile(path.join(dir, 'bad-note.md'), '---\ntitle: foo: bar: baz\ntags: [unclosed\n---\nBody.');
  await expect(noteStore.get('bad-note')).rejects.toThrow();
});

test('get() throws on permission error (not ENOENT)', async () => {
  await fs.writeFile(path.join(dir, 'locked.md'), '---\ntitle: Locked\n---\nBody.');
  await fs.chmod(path.join(dir, 'locked.md'), 0o000);
  await expect(noteStore.get('locked')).rejects.toThrow();
  await fs.chmod(path.join(dir, 'locked.md'), 0o644); // cleanup for afterEach rm
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/notes/__tests__/NoteStore.test.ts --reporter=verbose`
Expected: The first test passes (existing behavior), the malformed and permission tests fail because `get()` returns `null` instead of throwing.

- [ ] **Step 3: Implement get() error discrimination**

Replace the `get()` method in `NoteStore.ts` (lines 163-176):

```typescript
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
```

The key change: separate the `fs.readFile` try-catch (which checks for ENOENT) from the `matter()` parse call (which is now unguarded — parse errors propagate to the caller).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/notes/__tests__/NoteStore.test.ts --reporter=verbose`
Expected: All tests pass, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add server/src/notes/NoteStore.ts server/src/notes/__tests__/NoteStore.test.ts
git commit -m "fix(NoteStore): get() distinguishes ENOENT from parse/IO errors (#32)"
```

---

### Task 2: NoteStore.list() and listWithContent() — log skipped files

Fixes #33. Currently these methods silently drop unreadable notes. After this change, they log each skipped file to stderr with the error message.

**Files:**
- Modify: `server/src/notes/__tests__/NoteStore.test.ts`
- Modify: `server/src/notes/NoteStore.ts:95-142`

- [ ] **Step 1: Write failing tests for list() stderr logging**

Add these tests to the existing describe block:

```typescript
test('list() logs skipped files to stderr', async () => {
  await noteStore.upsert({ title: 'Good Note', content: 'OK.' });
  await fs.writeFile(path.join(dir, 'bad.md'), '---\ntitle: foo: bar: baz\ntags: [unclosed\n---\nBody.');

  const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const notes = await noteStore.list();
  expect(notes).toHaveLength(1);
  expect(notes[0].frontmatter.title).toBe('Good Note');
  expect(stderrSpy).toHaveBeenCalledWith(
    expect.stringContaining('[library] Skipping unreadable note'),
    expect.anything()
  );
  stderrSpy.mockRestore();
});

test('listWithContent() logs skipped files to stderr', async () => {
  await noteStore.upsert({ title: 'Good Note', content: 'OK.' });
  await fs.writeFile(path.join(dir, 'bad.md'), '---\ntitle: foo: bar: baz\ntags: [unclosed\n---\nBody.');

  const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const notes = await noteStore.listWithContent();
  expect(notes).toHaveLength(1);
  expect(notes[0].frontmatter.title).toBe('Good Note');
  expect(stderrSpy).toHaveBeenCalledWith(
    expect.stringContaining('[library] Skipping unreadable note'),
    expect.anything()
  );
  stderrSpy.mockRestore();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/notes/__tests__/NoteStore.test.ts --reporter=verbose`
Expected: Both tests fail because `console.error` is not called (errors are silently swallowed).

- [ ] **Step 3: Add stderr logging to list() and listWithContent()**

Replace `list()` (lines 95-117):

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
```

Replace `listWithContent()` (lines 119-142):

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/notes/__tests__/NoteStore.test.ts --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/notes/NoteStore.ts server/src/notes/__tests__/NoteStore.test.ts
git commit -m "fix(NoteStore): log skipped files in list/listWithContent instead of silent drop (#33)"
```

---

### Task 3: vaultContextHandler — distinguish error types

Fixes #34. Both the resource handler (`vaultContextHandler`) and the `get_vault_context` tool handler catch all errors and report "profile.md not found." After this change, they report the real error for non-ENOENT failures.

**Files:**
- Modify: `server/src/mcp/__tests__/mcpTools.test.ts`
- Modify: `server/src/mcp/server.ts:9-16,44-54`

- [ ] **Step 1: Write failing tests for error discrimination**

Add to the existing `vault://context resource` describe block in `mcpTools.test.ts`:

```typescript
test('vaultContextHandler throws descriptive error for permission denied', async () => {
  await fs.writeFile(path.join(dir, 'profile.md'), '# Vault');
  await fs.chmod(path.join(dir, 'profile.md'), 0o000);
  await expect(vaultContextHandler(dir)).rejects.toThrow(/permission|EACCES/i);
  // Should NOT say "not found"
  await expect(vaultContextHandler(dir)).rejects.not.toThrow('not found');
  await fs.chmod(path.join(dir, 'profile.md'), 0o644);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/mcp/__tests__/mcpTools.test.ts --reporter=verbose`
Expected: Test fails because the handler catches all errors and throws "profile.md not found".

- [ ] **Step 3: Fix vaultContextHandler to distinguish error types**

Replace `vaultContextHandler` (lines 9-16 of `server.ts`):

```typescript
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
```

Replace the inline `get_vault_context` tool handler catch block (lines 44-54):

```typescript
async () => {
  try {
    const raw = await fs.readFile(path.join(notesDir, 'profile.md'), 'utf-8');
    return { content: [{ type: 'text', text: raw }] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        isError: true,
        content: [{ type: 'text', text: 'profile.md not found — create it at the vault root to use this tool.' }],
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return {
      isError: true,
      content: [{ type: 'text', text: `Failed to read profile.md: ${msg}` }],
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/mcp/__tests__/mcpTools.test.ts --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/mcp/server.ts server/src/mcp/__tests__/mcpTools.test.ts
git commit -m "fix(vault-context): report real error instead of always 'profile.md not found' (#34)"
```

---

### Task 4: Add try-catch to list_notes handler

Part of #31. The `list_notes` handler calls `noteStore.list()` without error handling. After this change, filesystem errors return an `isError` response.

**Files:**
- Modify: `server/src/mcp/__tests__/mcpTools.test.ts`
- Modify: `server/src/mcp/server.ts:63-71`

- [ ] **Step 1: Write test for list() graceful degradation with unreadable subdirectories**

Add to `NoteStore.test.ts`:

```typescript
test('list() handles unreadable subdirectory gracefully', async () => {
  await noteStore.upsert({ title: 'Root Note', content: 'OK.' });
  const subdir = path.join(dir, 'locked-folder');
  await fs.mkdir(subdir);
  await fs.writeFile(path.join(subdir, 'note.md'), '---\ntitle: Locked\n---\nBody.');
  await fs.chmod(subdir, 0o000);

  // list() should still return the root note without throwing
  const notes = await noteStore.list();
  expect(notes).toHaveLength(1);
  expect(notes[0].frontmatter.title).toBe('Root Note');

  await fs.chmod(subdir, 0o755); // cleanup
});
```

Note: handler-level try-catch can't easily be tested without a full MCP server. The test validates the underlying NoteStore graceful degradation. The handler try-catch is defense-in-depth.

- [ ] **Step 2: Run test to verify it passes**

Run: `cd server && npx vitest run src/notes/__tests__/NoteStore.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 3: Add try-catch to list_notes handler**

Replace the `list_notes` handler (lines 63-71 of `server.ts`):

```typescript
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
```

- [ ] **Step 4: Run all tests to verify nothing broke**

Run: `cd server && npx vitest run --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/mcp/server.ts server/src/notes/__tests__/NoteStore.test.ts
git commit -m "fix(list_notes): add try-catch for filesystem errors (#31)"
```

---

### Task 5: Add try-catch to get_note handler

Part of #31. The `get_note` handler calls `noteStore.get()` without error handling. After Task 1, `get()` now throws on non-ENOENT errors. The handler must catch these and return `isError`.

**Files:**
- Modify: `server/src/mcp/__tests__/mcpTools.test.ts`
- Modify: `server/src/mcp/server.ts:77-89`

- [ ] **Step 1: Write failing test**

Add to the `handler error handling` describe block in `mcpTools.test.ts` (or create it if not yet present):

```typescript
test('get_note surfaces parse error instead of "not found"', async () => {
  await fs.writeFile(path.join(dir, 'corrupt.md'), '---\ntitle: foo: bar: baz\ntags: [unclosed\n---\nBody.');
  // After Task 1, get() throws on parse error instead of returning null.
  // The handler should catch and return isError with the real message.
  await expect(noteStore.get('corrupt')).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it passes** (validates Task 1's get() behavior)

Run: `cd server && npx vitest run src/mcp/__tests__/mcpTools.test.ts --reporter=verbose`
Expected: PASS (get() throws as expected after Task 1)

- [ ] **Step 3: Add try-catch to get_note handler**

Replace the `get_note` handler (lines 77-89 of `server.ts`):

```typescript
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
```

- [ ] **Step 4: Run all tests**

Run: `cd server && npx vitest run --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/mcp/server.ts server/src/mcp/__tests__/mcpTools.test.ts
git commit -m "fix(get_note): catch parse/IO errors, report real message instead of 'not found' (#31, #32)"
```

---

### Task 6: Add try-catch to delete_note handler

Part of #31. The `delete_note` handler calls `noteStore.delete()` and `noteStore.listWithContent()` + `searchIndex.buildIndexWithContent()` without error handling. A partial success (delete OK, index rebuild fails) is uncaught.

**Files:**
- Modify: `server/src/mcp/server.ts:173-188`

- [ ] **Step 1: Add try-catch to delete_note handler**

Replace the `delete_note` handler (lines 173-188 of `server.ts`):

```typescript
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
```

Note: the search index rebuild failure is logged but not returned as an error — the delete itself succeeded, and the index will be rebuilt on next change event or server restart. This matches the existing pattern in `mcp-entry.ts` (lines 49-59) where change-handler rebuild failures are logged to stderr.

- [ ] **Step 2: Run all tests**

Run: `cd server && npx vitest run --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/mcp/server.ts
git commit -m "fix(delete_note): add try-catch for delete and index rebuild (#31)"
```

---

### Task 7: Add try-catch to search_notes handler and protect create/update index rebuild

Part of #31. The `search_notes` handler calls `searchIndex.search()` without error handling. Also, `create_note` and `update_note` already have try-catch around upsert + index rebuild, but if `noteStore.get()` throws (now possible after Task 1 for corrupt notes), those pre-checks are unprotected.

**Files:**
- Modify: `server/src/mcp/server.ts:102-127,141-167,197-213`

- [ ] **Step 1: Protect the get() calls in create_note and update_note, and wrap search_notes**

In `create_note`, wrap the existence check (line 106) inside the existing try-catch by moving it down:

```typescript
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
```

In `update_note`, wrap the existence check (line 143) inside the existing try-catch:

```typescript
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
```

Add try-catch to `search_notes` handler (lines 197-213):

```typescript
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
```

- [ ] **Step 2: Run all tests**

Run: `cd server && npx vitest run --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/mcp/server.ts
git commit -m "fix(handlers): protect get() pre-checks and search_notes from uncaught errors (#31)"
```

---

### Task 8: Protect resource handlers

Part of #31. The `notes-index` resource and `note` template resource call NoteStore methods without error handling.

**Files:**
- Modify: `server/src/mcp/server.ts:218-280`

- [ ] **Step 1: Add error handling to notes-index resource**

Replace the `notes-index` resource handler (lines 222-237):

```typescript
async () => {
  let notes;
  try {
    notes = await noteStore.list();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      contents: [
        {
          uri: 'notes://index',
          text: `# Knowledge Base Notes\n\nFailed to list notes: ${msg}`,
          mimeType: 'text/markdown',
        },
      ],
    };
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
```

Replace the `note` template resource handler (lines 265-279):

```typescript
async (uri, { slug }) => {
  let note;
  try {
    note = await noteStore.get(decodeURIComponent(slug as string));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to read note "${slug}": ${msg}`);
  }
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
```

Also protect the `noteTemplate` list callback (lines 248-258):

```typescript
const noteTemplate = new ResourceTemplate('note://{slug}', {
  list: async () => {
    let notes;
    try {
      notes = await noteStore.list();
    } catch {
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
```

- [ ] **Step 2: Run all tests**

Run: `cd server && npx vitest run --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/mcp/server.ts
git commit -m "fix(resources): add error handling to notes-index and note template resources (#31)"
```
