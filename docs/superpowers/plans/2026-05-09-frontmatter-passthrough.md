# Frontmatter Passthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `frontmatter` map param to `create_note` and `update_note` so callers can write arbitrary YAML frontmatter fields (e.g. `status:`) without bypassing the typed API. Implements [#65](https://github.com/ethanaubuchon/dossier-mcp/issues/65).

**Architecture:** Widen `NoteFrontmatter` with an index signature (TS-honest for open-ended YAML); preserve unknown fields on read; layer the merge on update as `existing extras → extracted-from-content → explicit param → typed params override`. Denylist (`title`, `date`, `tags`, `related`) is enforced at the MCP boundary in `coerce.ts` with a first-fail error naming the offending key. `matter.stringify` already accepts open-ended records on write — most work is on the read/merge path.

**Tech Stack:** TypeScript, gray-matter (YAML), Zod (MCP schema), Jest.

**Repo layout (worktree):** `~/workspace/library/.worktrees/frontmatter-passthrough/`

**Run tests with:** `npm test --prefix server` from repo root, or `cd server && npx jest`.

**Conventions to follow (from existing code):**
- Tests live in `__tests__/` next to the module under test.
- gray-matter caches parse results internally — use **distinct** malformed YAML strings across tests.
- MCP tool schemas wire through to `noteStore.upsert` for both create and update.
- Existing test pattern accesses tool handlers via `server._registeredTools[name].handler` for direct schema/handler exercises (see `mcpTools.test.ts`).

**Out of scope (do NOT implement):** `move_note` frontmatter handling, tool-managed `updated:` auto-bump, schema validation on values, `frontmatterTemplate` revival, field deletion via API. See scope doc for rationale; do not re-litigate.

**Verbatim text to use:**
- Denylist error wording: `Cannot set '<key>' via frontmatter; use the typed param.`
- `create_note` describe text:
  > Additional YAML frontmatter fields to write (e.g. {status: "shaping"}). Cannot set tool-managed fields (title, date, tags, related) — use the typed params for those.
- `update_note` describe text (same as create) PLUS extend the existing tool-level description with the sentence:
  > Non-tool-managed frontmatter fields (e.g. status) embedded in content are preserved on round-trip update.

---

## Task 1: Widen `NoteFrontmatter` type with index signature

**Files:**
- Modify: `server/src/types.ts:1-6`

This is a pure type change — no runtime behavior changes. It allows downstream code to spread arbitrary keys into a `NoteFrontmatter` without TS errors. Existing typed accesses (`fm.title`, `fm.tags.includes(...)`) keep working because declared fields override the index signature.

- [ ] **Step 1: Edit `NoteFrontmatter` to add index signature**

Replace the current interface body:

```typescript
export interface NoteFrontmatter {
  title: string;
  date: string;
  tags: string[];
  related: string[];
  [key: string]: unknown;
}
```

- [ ] **Step 2: Run typecheck + full test suite — confirm nothing breaks**

```bash
cd server && npx tsc --noEmit && npx jest
```

Expected: typecheck passes, all 188 existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/types.ts
git commit -m "refactor(types): widen NoteFrontmatter with index signature

Allows non-tool-managed frontmatter fields (e.g. status) to flow through
the typed shape without compensating with a parallel extras object.
Declared fields still narrow the index signature, so existing typed
accesses keep working unchanged.

Refs #65"
```

---

## Task 2: Preserve unknown fields in `parseFrontmatter` on read

**Files:**
- Modify: `server/src/notes/NoteStore.ts:420-441` (`parseFrontmatter`)
- Test: `server/src/notes/__tests__/NoteStore.test.ts`

Today `parseFrontmatter` returns an object containing only `title`, `date`, `tags`, `related` — anything else in the YAML is dropped on read. Change it to spread the parsed data first, then overlay the validated typed fields, so non-typed keys survive.

- [ ] **Step 1: Write the failing tests**

Append at the end of the `describe('NoteStore', ...)` block in `server/src/notes/__tests__/NoteStore.test.ts` (before the closing `});`):

```typescript
test('parseFrontmatter preserves non-typed fields on read', async () => {
  await fs.writeFile(
    path.join(dir, 'extras.md'),
    `---
title: Has Extras
date: '2026-05-09'
tags: [a]
related: []
status: shaping
priority: 3
flagged: true
---
body
`,
  );
  const note = await store.get('extras');
  expect(note).not.toBeNull();
  expect(note!.frontmatter.status).toBe('shaping');
  expect(note!.frontmatter.priority).toBe(3);
  expect(note!.frontmatter.flagged).toBe(true);
  // Existing typed accesses still work
  expect(note!.frontmatter.title).toBe('Has Extras');
  expect(note!.frontmatter.tags).toEqual(['a']);
});

test('parseFrontmatter still validates and coerces typed fields', async () => {
  // Non-ISO date falls back to today; missing title falls back to "Untitled"
  await fs.writeFile(
    path.join(dir, 'odd.md'),
    `---
date: not-a-date
tags: bad
related: []
status: ok
---
body
`,
  );
  const note = await store.get('odd');
  expect(note!.frontmatter.title).toBe('Untitled');
  // Non-array tags coerce to []
  expect(note!.frontmatter.tags).toEqual([]);
  // Non-ISO date falls back to today (just verify it's an ISO date string)
  expect(note!.frontmatter.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // Extra survives even when typed fields are odd
  expect(note!.frontmatter.status).toBe('ok');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd server && npx jest -t 'parseFrontmatter preserves non-typed fields'
cd server && npx jest -t 'parseFrontmatter still validates and coerces typed fields'
```

Expected: both fail — `expect(received).toBe('shaping')` returns `undefined` (or similar).

- [ ] **Step 3: Update `parseFrontmatter` to preserve unknowns**

Replace the body of `parseFrontmatter` in `server/src/notes/NoteStore.ts:420-441` with:

```typescript
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
  // Spread unknown fields first, then overlay validated typed fields so they
  // win on key collision. Open-ended YAML round-trips intact for any non-typed
  // key (status, priority, etc.).
  return {
    ...data,
    title: String(data.title || 'Untitled'),
    date,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    related: Array.isArray(data.related) ? data.related.map(String) : [],
  };
}
```

- [ ] **Step 4: Run the new tests + full suite to confirm pass + no regressions**

```bash
cd server && npx jest
```

Expected: 188 + 2 = 190 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/notes/NoteStore.ts server/src/notes/__tests__/NoteStore.test.ts
git commit -m "feat(notes): preserve non-typed frontmatter fields on read

parseFrontmatter previously stripped anything outside the four typed
fields. Spread the parsed data first and overlay validated typed fields
so non-typed keys (status, priority, etc.) survive end-to-end.

Refs #65"
```

---

## Task 3: `upsert` accepts and merges `frontmatter` param

**Files:**
- Modify: `server/src/notes/NoteStore.ts:207-242` (`upsert`)
- Test: `server/src/notes/__tests__/NoteStore.test.ts`

Add an optional `frontmatter: Record<string, unknown>` param to `upsert`. The merge order, when writing, is:

1. Existing note's non-typed extras (preserves keys absent from the call)
2. Caller's `frontmatter` param (overrides existing on key collision)
3. Typed fields (`title`, `date`, `tags`, `related`) override their corresponding fields

Closes the round-trip loop: keys absent from the call are preserved.

- [ ] **Step 1: Write the failing tests**

Append in `server/src/notes/__tests__/NoteStore.test.ts` (before the closing `});` of the main describe):

```typescript
test('upsert with frontmatter param writes extras to YAML on disk', async () => {
  await store.upsert({
    title: 'With Status',
    content: 'body',
    frontmatter: { status: 'shaping', priority: 1 },
  });
  const raw = await fs.readFile(path.join(dir, 'with-status.md'), 'utf-8');
  expect(raw).toMatch(/status:\s*shaping/);
  expect(raw).toMatch(/priority:\s*1/);
});

test('upsert preserves existing extras when frontmatter param is omitted', async () => {
  await store.upsert({
    title: 'Doc',
    content: 'v1',
    frontmatter: { status: 'shaping', author: 'me' },
  });
  // Re-upsert without frontmatter — existing extras must survive.
  await store.upsert({ slug: 'doc', title: 'Doc', content: 'v2' });
  const note = await store.get('doc');
  expect(note!.frontmatter.status).toBe('shaping');
  expect(note!.frontmatter.author).toBe('me');
  expect(note!.content.trim()).toBe('v2');
});

test('upsert frontmatter param overrides existing extras on key collision (last-write-wins)', async () => {
  await store.upsert({
    title: 'Doc',
    content: 'v1',
    frontmatter: { status: 'shaping', priority: 1 },
  });
  await store.upsert({
    slug: 'doc',
    title: 'Doc',
    content: 'v2',
    frontmatter: { status: 'tracked' }, // priority absent → preserved
  });
  const note = await store.get('doc');
  expect(note!.frontmatter.status).toBe('tracked');
  expect(note!.frontmatter.priority).toBe(1);
});

test('upsert frontmatter param accepts varied YAML-serializable types', async () => {
  await store.upsert({
    title: 'Mixed Types',
    content: 'body',
    frontmatter: {
      str: 'hello',
      num: 42,
      bool: true,
      arr: ['x', 'y'],
      obj: { nested: 'val' },
    },
  });
  const note = await store.get('mixed-types');
  expect(note!.frontmatter.str).toBe('hello');
  expect(note!.frontmatter.num).toBe(42);
  expect(note!.frontmatter.bool).toBe(true);
  expect(note!.frontmatter.arr).toEqual(['x', 'y']);
  expect(note!.frontmatter.obj).toEqual({ nested: 'val' });
});

test('upsert typed params still override their corresponding frontmatter fields', async () => {
  // tags via typed param wins even if upsert is given a frontmatter map.
  // (Denylist is enforced at the MCP boundary; upsert itself is permissive
  // for internal callers — tags here is not a denylist test, just merge precedence.)
  await store.upsert({
    title: 'Doc',
    content: 'v1',
    tags: ['typed-tag'],
    frontmatter: { status: 'shaping' },
  });
  const note = await store.get('doc');
  expect(note!.frontmatter.tags).toEqual(['typed-tag']);
  expect(note!.frontmatter.status).toBe('shaping');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd server && npx jest -t 'upsert'
```

Expected: at least the 5 new tests fail (e.g. `frontmatter` is not a known property of the upsert arg).

- [ ] **Step 3: Update `upsert` to accept and merge `frontmatter`**

Replace `upsert` in `server/src/notes/NoteStore.ts:207-242` with:

```typescript
async upsert(data: {
  title: string;
  content: string;
  tags?: string[];
  related?: string[];
  slug?: string;
  frontmatter?: Record<string, unknown>;
}): Promise<Note> {
  const slug = data.slug || NoteStore.makeSlug(data.title);
  const date = new Date().toISOString().split('T')[0];

  // Merge with existing note if it exists. Layer order:
  //   1. Existing non-typed extras (so keys absent from this call survive).
  //   2. Caller's `frontmatter` param (overrides existing on key collision).
  //   3. Typed fields override (title/date/tags/related).
  const existing = await this.get(slug);
  const existingExtras = pickFrontmatterExtras(existing?.frontmatter);
  const frontmatter: NoteFrontmatter = {
    ...existingExtras,
    ...(data.frontmatter ?? {}),
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
```

- [ ] **Step 4: Add the `pickFrontmatterExtras` helper at the bottom of `NoteStore.ts`**

Inside the same file, below the `NoteStore` class export, add:

```typescript
// Returns frontmatter without the typed fields. Used by upsert to layer
// existing non-typed extras under a caller's frontmatter param.
function pickFrontmatterExtras(fm: NoteFrontmatter | undefined): Record<string, unknown> {
  if (!fm) return {};
  const { title, date, tags, related, ...extras } = fm;
  void title; void date; void tags; void related;
  return extras;
}
```

(The `void` lines suppress `noUnusedLocals` in case the project enables it.)

- [ ] **Step 5: Run tests + full suite**

```bash
cd server && npx jest
```

Expected: 190 + 5 = 195 tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/notes/NoteStore.ts server/src/notes/__tests__/NoteStore.test.ts
git commit -m "feat(notes): upsert accepts and merges frontmatter param

Layered merge: existing non-typed extras → caller's frontmatter param →
typed fields override. Closes the round-trip loop — keys absent from the
call are preserved automatically.

Refs #65"
```

---

## Task 4: Extend `resolveFrontmatterParams` extraction + add denylist enforcement

**Files:**
- Modify: `server/src/mcp/coerce.ts`
- Test: `server/src/mcp/__tests__/mcpTools.test.ts`

Two related changes:

1. Extend `resolveFrontmatterParams` to accept an explicit `frontmatter` param, extract all non-typed keys from embedded content, and return a merged `frontmatter` map (extracted < explicit on key collision).
2. Add a denylist (`title`, `date`, `tags`, `related`) and check the **explicit** `frontmatter` param against it (first-fail). Extracted-from-content keys are NOT denylisted — those typed-named keys flow through their own typed extraction.

Why the asymmetry: a caller passing `frontmatter: {title: 'X'}` is calling the wrong tool. A caller doing get_note → modify body → update_note legitimately has a `title:` line in their content; that path is already handled by the existing typed extraction.

- [ ] **Step 1: Write the failing tests**

Append the following inside `mcpTools.test.ts` — find the end of the existing `describe('MCP tool logic — NoteStore + SearchIndex integration', ...)` block (the one that uses `noteStore` directly) and add a NEW top-level describe block at the bottom of the file:

```typescript
describe('resolveFrontmatterParams — extraction + denylist', () => {
  test('extracts non-typed fields from embedded content into frontmatter', () => {
    const content = `---
title: Note
status: shaping
priority: 2
---
body
`;
    const r = resolveFrontmatterParams({ title: undefined, content, tags: undefined, related: undefined, frontmatter: undefined });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.title).toBe('Note');
    expect(r.frontmatter).toEqual({ status: 'shaping', priority: 2 });
    expect(r.content.trim()).toBe('body');
  });

  test('explicit frontmatter param overrides extracted on key collision', () => {
    const content = `---
title: Note
status: shaping
---
body
`;
    const r = resolveFrontmatterParams({
      title: undefined,
      content,
      tags: undefined,
      related: undefined,
      frontmatter: { status: 'tracked', extra: 'x' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.frontmatter).toEqual({ status: 'tracked', extra: 'x' });
  });

  test('denylist: explicit frontmatter param with title raises first-fail error', () => {
    const r = resolveFrontmatterParams({
      title: 'OK',
      content: 'body',
      tags: undefined,
      related: undefined,
      frontmatter: { title: 'NotAllowed' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(`Cannot set 'title' via frontmatter; use the typed param.`);
  });

  test.each(['title', 'date', 'tags', 'related'])(
    'denylist: explicit frontmatter param with %s raises error',
    (key) => {
      const r = resolveFrontmatterParams({
        title: 'OK',
        content: 'body',
        tags: undefined,
        related: undefined,
        frontmatter: { [key]: 'value' },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toBe(`Cannot set '${key}' via frontmatter; use the typed param.`);
    },
  );

  test('extracted typed-named keys (title, date, tags, related) are NOT routed into frontmatter map', () => {
    // The four typed fields go through their own extraction paths; they must
    // not also leak into the `frontmatter` extras map.
    const content = `---
title: Note
date: '2026-05-09'
tags: [a]
related: [r1]
status: ok
---
body
`;
    const r = resolveFrontmatterParams({ title: undefined, content, tags: undefined, related: undefined, frontmatter: undefined });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.frontmatter).toEqual({ status: 'ok' });
  });

  test('returns undefined frontmatter when no extras and no explicit param', () => {
    const content = `---
title: Plain
---
body
`;
    const r = resolveFrontmatterParams({ title: undefined, content, tags: undefined, related: undefined, frontmatter: undefined });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.frontmatter).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd server && npx jest -t 'resolveFrontmatterParams — extraction + denylist'
```

Expected: all 9 tests fail (`frontmatter` is not a recognized param of resolveFrontmatterParams).

- [ ] **Step 3: Update `coerce.ts` — extend type, extraction, denylist**

Replace the entire content of `server/src/mcp/coerce.ts` with:

```typescript
import matter from 'gray-matter';

const FRONTMATTER_DENYLIST = new Set(['title', 'date', 'tags', 'related']);

type ResolvedParams = {
  ok: true;
  title: string;
  content: string;
  tags?: string[];
  related?: string[];
  frontmatter?: Record<string, unknown>;
};
type ResolveFailed = { ok: false; error: string };

/**
 * Resolves update_note parameters, supporting frontmatter-embedded content.
 *
 * When an agent receives a note via get_note (which returns raw markdown including
 * frontmatter) and passes it back to update_note, the frontmatter is embedded in the
 * content string rather than as separate params. This function handles that round-trip:
 * it extracts title/tags/related from frontmatter in content and strips the frontmatter
 * from the body whenever frontmatter is present. Explicit params always take precedence
 * over frontmatter values.
 *
 * Non-typed frontmatter keys (anything outside title/date/tags/related) are routed into
 * the resolved `frontmatter` map. The explicit `frontmatter` param overrides extracted
 * values on key collision. The four typed names are denylisted on the explicit param
 * (first-fail, named key) — extracted typed-named keys are not denylisted because they
 * flow through their own typed-extraction paths.
 */
export function resolveFrontmatterParams(params: {
  title: string | undefined;
  content: string;
  tags: string[] | undefined;
  related: string[] | undefined;
  frontmatter: Record<string, unknown> | undefined;
}): ResolvedParams | ResolveFailed {
  const { tags, related, frontmatter: explicitFrontmatter } = params;

  // Denylist check on the explicit frontmatter param (first-fail).
  if (explicitFrontmatter) {
    for (const key of Object.keys(explicitFrontmatter)) {
      if (FRONTMATTER_DENYLIST.has(key)) {
        return { ok: false, error: `Cannot set '${key}' via frontmatter; use the typed param.` };
      }
    }
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(params.content);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Failed to parse note content: ${msg}` };
  }

  const hasFrontmatter = Object.keys(parsed.data).length > 0;

  const rawTitle = params.title ?? (hasFrontmatter ? parsed.data.title : undefined);
  const title = typeof rawTitle === 'string' ? rawTitle : undefined;
  if (!title) {
    if (hasFrontmatter) {
      return { ok: false, error: 'title is required — frontmatter was detected in content but no title field was found. Pass title as a separate param or add a title field to the frontmatter.' };
    }
    return { ok: false, error: 'title is required — pass it as a separate param or include it in frontmatter' };
  }

  const content = hasFrontmatter ? parsed.content.replace(/^\n/, '') : params.content;
  const resolvedTags = tags ?? (hasFrontmatter ? coerceStringArray(parsed.data.tags) : undefined);
  const resolvedRelated = related ?? (hasFrontmatter ? coerceStringArray(parsed.data.related) : undefined);

  // Extract non-typed extras from embedded content. Typed-named keys are
  // dropped here (they flow through their own extraction paths above).
  const extractedExtras: Record<string, unknown> = {};
  if (hasFrontmatter) {
    for (const [key, value] of Object.entries(parsed.data)) {
      if (!FRONTMATTER_DENYLIST.has(key)) {
        extractedExtras[key] = value;
      }
    }
  }

  // Merge: extracted < explicit. Returns undefined when both are empty so
  // upsert's "preserve existing extras" branch isn't disturbed by an empty
  // overlay object.
  const merged: Record<string, unknown> = { ...extractedExtras, ...(explicitFrontmatter ?? {}) };
  const resolvedFrontmatter = Object.keys(merged).length > 0 ? merged : undefined;

  return {
    ok: true,
    title,
    content,
    tags: resolvedTags,
    related: resolvedRelated,
    frontmatter: resolvedFrontmatter,
  };
}

/**
 * Coerces an unknown input to string[] | undefined.
 *
 * Handles the common case where LLM clients pass tags/related as:
 * - A JSON-encoded array string: '["tag1","tag2"]'
 * - A comma-separated string: 'tag1, tag2'
 * - A single bare string: 'tag1'
 * - An already-correct array: ['tag1', 'tag2']
 * - A JSON-encoded non-array (e.g. '42', '{"a":1}'): treated as a plain string, comma-split
 * - An empty array (`[]` or `'[]'`): coerced to `undefined` so downstream callers
 *   treat it as "preserve existing" rather than "clear all". This guards the
 *   round-trip pattern (get_note → modify → update_note) where LLMs often emit
 *   `tags: []` to mean "I didn't change tags."
 */
export function coerceStringArray(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  // Empty arrays are treated as "preserve existing" rather than "clear all".
  // This protects the round-trip pattern (get_note → modify → update_note) where
  // LLM clients commonly emit `tags: []` to mean "I didn't change tags." If
  // explicit clearing is ever needed, add an explicit sentinel (e.g. a dedicated
  // flag) rather than overloading the empty-array meaning.
  if (Array.isArray(val)) return val.length === 0 ? undefined : val.map(String);
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.length === 0 ? undefined : parsed.map(String);
    } catch {
      // not JSON — fall through to comma split
    }
    return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}
```

- [ ] **Step 4: Run tests + full suite**

```bash
cd server && npx jest
```

Expected: 195 + 9 = 204 tests pass.

Note: this changes the `resolveFrontmatterParams` signature (adds required `frontmatter` field). The single existing call site (`server/src/mcp/server.ts:165`) will break compilation — that's fine, Task 5 fixes it. If you're running tests *between* tasks, jest will surface the type error in the build phase. To unblock partial verification within Task 4, temporarily pass `frontmatter: undefined` at the call site, OR run the affected tests with `--testPathPattern coerce` only:

```bash
cd server && npx jest --testPathPattern 'mcpTools' -t 'resolveFrontmatterParams'
```

If you take the temporary `frontmatter: undefined` route, undo it in Task 5.

- [ ] **Step 5: Commit**

If `server.ts` is broken at this point, do NOT commit until Task 5 lands and the suite is fully green. If the suite is green (because you scoped the test run), commit:

```bash
git add server/src/mcp/coerce.ts server/src/mcp/__tests__/mcpTools.test.ts
git commit -m "feat(mcp): extend resolveFrontmatterParams extraction + denylist

resolveFrontmatterParams now extracts non-typed YAML keys from embedded
content and merges them with an explicit frontmatter param (explicit
wins). Adds first-fail denylist on the explicit param for tool-managed
fields (title, date, tags, related); extracted typed-named keys flow
through their own typed paths and are not denylisted.

Refs #65"
```

If you took the temporary-undefined route, defer the commit and bundle Tasks 4 + 5 together. Either is fine.

---

## Task 5: Wire `frontmatter` zod param into `create_note` and `update_note` handlers

**Files:**
- Modify: `server/src/mcp/server.ts:105-180` (create_note + update_note tool definitions)
- Test: `server/src/mcp/__tests__/mcpTools.test.ts`

Add the `frontmatter` zod param to both tools using the locked describe text. `update_note` already calls `resolveFrontmatterParams` — just thread the new param through. `create_note` doesn't call `resolveFrontmatterParams`; it gets a separate denylist check inline (or via a tiny helper). For the locked-text constraint, write the describe strings as plain string literals (not `import`-shared constants), so future edits land in one obvious place.

- [ ] **Step 1: Write the failing tests**

Append a new describe block in `mcpTools.test.ts`:

```typescript
describe('frontmatter passthrough — MCP handler integration', () => {
  let dir: string;
  let noteStore: NoteStore;
  let searchIndex: SearchIndex;
  let server: ReturnType<typeof createMcpServer>;

  beforeEach(async () => {
    dir = await makeTmpDir();
    noteStore = new NoteStore(dir);
    searchIndex = new SearchIndex();
    await noteStore.initialize();
    server = createMcpServer(noteStore, searchIndex, dir);
  });

  afterEach(async () => {
    await noteStore.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Helper: invoke a registered tool's handler directly.
  // The MCP SDK exposes registered tools at server._registeredTools[name].
  function getTool(name: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reg = (server as any)._registeredTools[name];
    if (!reg) throw new Error(`tool not registered: ${name}`);
    return reg;
  }

  test('create_note accepts frontmatter param and writes extras to YAML', async () => {
    const tool = getTool('create_note');
    const res = await tool.handler({
      title: 'Scoped Doc',
      content: 'body',
      path: 'projects/x/scoped-doc',
      frontmatter: { status: 'shaping', priority: 2 },
    });
    expect(res.isError).toBeFalsy();
    const raw = await fs.readFile(path.join(dir, 'projects/x/scoped-doc.md'), 'utf-8');
    expect(raw).toMatch(/status:\s*shaping/);
    expect(raw).toMatch(/priority:\s*2/);
  });

  test('update_note accepts explicit frontmatter param', async () => {
    await noteStore.upsert({ slug: 'doc', title: 'Doc', content: 'v1' });
    const tool = getTool('update_note');
    const res = await tool.handler({
      slug: 'doc',
      title: 'Doc',
      content: 'v2',
      frontmatter: { status: 'tracked' },
    });
    expect(res.isError).toBeFalsy();
    const note = await noteStore.get('doc');
    expect(note!.frontmatter.status).toBe('tracked');
  });

  test('update_note round-trips status via embedded content (get → modify body → update)', async () => {
    // Seed a note with status via the create path.
    await noteStore.upsert({
      slug: 'doc',
      title: 'Doc',
      content: 'v1',
      frontmatter: { status: 'shaping' },
    });
    // Caller does get_note then update_note(slug, content) with the raw markdown.
    const got = await noteStore.get('doc');
    const updateTool = getTool('update_note');
    const res = await updateTool.handler({
      slug: 'doc',
      content: got!.raw, // raw includes the frontmatter block
      // No title, tags, related, or frontmatter param — pure round-trip.
    });
    expect(res.isError).toBeFalsy();
    const after = await noteStore.get('doc');
    expect(after!.frontmatter.status).toBe('shaping');
    expect(after!.frontmatter.title).toBe('Doc');
  });

  test('update_note: updated: field round-trips via embedded content', async () => {
    // updated is intentionally NOT on the denylist — it flows through as an extra.
    await noteStore.upsert({
      slug: 'doc',
      title: 'Doc',
      content: 'v1',
      frontmatter: { updated: '2026-05-09' },
    });
    const got = await noteStore.get('doc');
    const updateTool = getTool('update_note');
    await updateTool.handler({ slug: 'doc', content: got!.raw });
    const after = await noteStore.get('doc');
    expect(after!.frontmatter.updated).toBe('2026-05-09');
  });

  test('create_note: explicit frontmatter param with title raises denylist error', async () => {
    const tool = getTool('create_note');
    const res = await tool.handler({
      title: 'Real Title',
      content: 'body',
      path: 'projects/x/y',
      frontmatter: { title: 'Sneaky' },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(`Cannot set 'title' via frontmatter; use the typed param.`);
  });

  test.each(['title', 'date', 'tags', 'related'])(
    'update_note: explicit frontmatter param with %s raises denylist error',
    async (key) => {
      await noteStore.upsert({ slug: 'doc', title: 'Doc', content: 'v1' });
      const tool = getTool('update_note');
      const res = await tool.handler({
        slug: 'doc',
        title: 'Doc',
        content: 'v2',
        frontmatter: { [key]: 'value' },
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe(`Cannot set '${key}' via frontmatter; use the typed param.`);
    },
  );

  test('search and list still surface notes that have frontmatter extras', async () => {
    await noteStore.upsert({
      slug: 'projects/x/with-extras',
      title: 'With Extras',
      content: 'distinctkeyword body',
      tags: ['a'],
      frontmatter: { status: 'shaping' },
    });
    // Rebuild the index the way create/update handlers do.
    const allNotes = await noteStore.listWithContent();
    searchIndex.buildIndexWithContent(allNotes);

    const listTool = getTool('list_notes');
    const listRes = await listTool.handler({});
    expect(listRes.isError).toBeFalsy();
    const listed = JSON.parse(listRes.content[0].text);
    expect(listed.find((n: { slug: string }) => n.slug === 'projects/x/with-extras')).toBeDefined();

    const searchTool = getTool('search_notes');
    const searchRes = await searchTool.handler({ query: 'distinctkeyword' });
    expect(searchRes.isError).toBeFalsy();
    const found = JSON.parse(searchRes.content[0].text);
    expect(found.some((r: { slug: string }) => r.slug === 'projects/x/with-extras')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd server && npx jest -t 'frontmatter passthrough — MCP handler integration'
```

Expected: most/all of the new tests fail (handler ignores `frontmatter` param, or denylist not enforced at handler boundary).

- [ ] **Step 3: Update `create_note` tool definition in `server/src/mcp/server.ts`**

Replace the `create_note` block (currently `server.ts:105-139`) with:

```typescript
server.tool(
  'create_note',
  'Create a new note in the knowledge base. Provide a path to place it (e.g. "projects/startup/market-analysis") or omit to land it in inbox/. Use [[slug]] syntax to link to related notes.',
  {
    title: z.string().describe('The note title'),
    content: z.string().describe('Markdown content for the note body'),
    path: z.string().optional().describe('Vault-relative path for the note slug (e.g. "projects/startup/my-note"). Defaults to inbox/<title-slug>.'),
    tags: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Tags to categorize the note'),
    related: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Slugs of related notes'),
    frontmatter: z.record(z.unknown()).optional().describe(
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
```

- [ ] **Step 4: Update `update_note` tool definition in `server/src/mcp/server.ts`**

Replace the `update_note` block (currently `server.ts:141-180`) with:

```typescript
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
    frontmatter: z.record(z.unknown()).optional().describe(
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
```

- [ ] **Step 5: Export `FRONTMATTER_DENYLIST` from `coerce.ts` and import it in `server.ts`**

In `server/src/mcp/coerce.ts`, change the const declaration to add `export`:

```typescript
export const FRONTMATTER_DENYLIST = new Set(['title', 'date', 'tags', 'related']);
```

In `server/src/mcp/server.ts`, update the import line at the top of the file:

```typescript
import { coerceStringArray, resolveFrontmatterParams, FRONTMATTER_DENYLIST } from './coerce.js';
```

- [ ] **Step 6: Run tests + full suite**

```bash
cd server && npx jest
```

Expected: 204 + ~10 tests pass (the `test.each` denylist round above expands to 4). Total ≈ 214.

- [ ] **Step 7: Commit (or combined commit if Task 4 was deferred)**

If Task 4 already committed:

```bash
git add server/src/mcp/server.ts server/src/mcp/coerce.ts server/src/mcp/__tests__/mcpTools.test.ts
git commit -m "feat(mcp): wire frontmatter passthrough into create_note and update_note

Adds frontmatter zod param to both tools with locked describe text.
create_note enforces the denylist inline; update_note delegates to
resolveFrontmatterParams (extraction + denylist). update_note's tool
description picks up the round-trip-preservation sentence.

Closes #65"
```

If Task 4 was deferred to bundle, combined commit covers both:

```bash
git add server/src/mcp server/src/mcp/__tests__
git commit -m "feat(mcp): frontmatter passthrough param on create_note and update_note

Adds an optional frontmatter map param to both tools. Tool-managed
fields (title, date, tags, related) raise a first-fail error naming
the offending key. Non-typed extras flow through to YAML on disk;
update_note round-trips them via embedded content; merge order is
existing < extracted < explicit < typed-override.

Closes #65"
```

---

## Task 6: Audit search/list assumptions and final verification

**Files:**
- Read-only audit: `server/src/notes/NoteStore.ts:124, 142, 154, 201, 333-336`, `server/src/search/SearchIndex.ts`
- Run: full test suite + typecheck

The scope's Decision 8 calls out specific lines that touched `frontmatter` and might assume only-typed-fields. With Decision 1's index signature, existing typed accesses (`fm.title`, `fm.tags`, `fm.related`) still narrow correctly. The risk is code that does `Object.keys(fm)`, `Object.entries(fm)`, or `JSON.stringify(fm)` and assumes only the four fields exist.

- [ ] **Step 1: Audit each cited line**

Run:

```bash
cd server && grep -nE "Object\.(keys|entries|values)\(.*frontmatter" src/
cd server && grep -nE "JSON\.stringify\(.*frontmatter|JSON\.stringify\(.*[nN]ote[^A-Za-z]" src/
```

Manually confirm at the cited lines:

- `NoteStore.ts:124` — `notes.map(({ slug, frontmatter }) => ({ slug, frontmatter }))`. Returns the whole frontmatter; extras flow through. Fine.
- `NoteStore.ts:142, 154` — `parseFrontmatter` (Task 2) and `.localeCompare(...)`. Fine.
- `NoteStore.ts:201` — `frontmatter: this.parseFrontmatter(parsed.data)` on `get`. Fine.
- `NoteStore.ts:333-336` — self-ref rewrite during `move`. Spreads `...source.frontmatter`, then overrides `related`. With the index signature, all extras flow through unchanged. Fine.
- `server/src/search/SearchIndex.ts` — only references `frontmatter.title`, `.tags`, `.related`. No shape assumptions. Fine.

If the audit finds anything that DOES assume only-typed-fields (e.g. `Object.keys(fm).length === 4`, an iteration that errors on unknown keys), add a focused test under the `frontmatter passthrough — MCP handler integration` describe block in `mcpTools.test.ts` capturing the regression, then patch the offending line to be shape-tolerant.

- [ ] **Step 2: Run typecheck**

```bash
cd server && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Run full test suite**

```bash
cd server && npx jest
```

Expected: ~214 tests pass, 0 failures, all 4 suites green.

- [ ] **Step 4: Sanity-check the existing-test backward-compat case with a brand-new note**

This is a manual visual check, not a new test. Run a quick repl-style verify:

```bash
cd server && node -e "
const { NoteStore } = require('./dist/notes/NoteStore.js');
(async () => {
  const os = require('os'); const fs = require('fs/promises'); const path = require('path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-passthrough-'));
  const s = new NoteStore(dir); await s.initialize();
  await s.upsert({ title: 'Smoke', content: 'body', frontmatter: { status: 'shaping', updated: '2026-05-09' } });
  const raw = await fs.readFile(path.join(dir, 'smoke.md'), 'utf-8');
  console.log('---YAML on disk---'); console.log(raw);
  await s.close();
})();
"
```

Expected output includes `status: shaping` and `updated: '2026-05-09'` in the YAML block, with `title`, `date`, `tags`, `related` also present. (You may need to `npm run build --prefix server` first if `dist/` is stale; this is a sanity check only — skip if it's awkward.)

- [ ] **Step 5: Commit (only if audit found and patched something)**

If no patches were needed, no commit here. If the audit surfaced a regression and you patched it:

```bash
git add server/src
git commit -m "test(mcp): cover search/list with frontmatter extras

Audit per #65 scope Decision 8 surfaced [describe what]; added a
regression test and patched the assumption.

Refs #65"
```

---

## Done criteria

- [ ] `npm test --prefix server` is fully green (~214 tests, 0 failures, 4 suites).
- [ ] `npx tsc --noEmit` is clean.
- [ ] All 6 tasks committed (or 5 if Task 6 had no patch, or 5 if Tasks 4+5 were bundled). Each commit message references #65.
- [ ] Branch `feat/frontmatter-passthrough` has linear history, one logical commit per task.
- [ ] No changes outside `server/src/types.ts`, `server/src/notes/NoteStore.ts`, `server/src/notes/__tests__/NoteStore.test.ts`, `server/src/mcp/coerce.ts`, `server/src/mcp/server.ts`, `server/src/mcp/__tests__/mcpTools.test.ts`. (Plus this plan file in `docs/superpowers/plans/`.)

## Self-review notes (recorded by the planner)

- Spec coverage: every AC item in #65 maps to at least one task above (Tasks 2-3 cover read/merge; Task 4 covers extraction + denylist; Task 5 covers MCP wiring + descriptions; Task 6 covers audit + tests already collected in Task 5's integration block).
- Type consistency: `frontmatter?: Record<string, unknown>` is the same shape across `upsert`, `resolveFrontmatterParams`, and the zod schemas. `pickFrontmatterExtras` returns the same shape.
- Placeholder scan: no TBD/TODO/"similar to" placeholders. All code blocks are complete.
- Verbatim-text constraint: denylist error wording and tool describe strings appear at the call site as plain string literals — no constants for them, so future edits are obvious.
