/**
 * Multi-vault routing tests: the read-wide / write-narrow tool surface,
 * per-result provenance, get_note default-first resolution + collision, per-vault
 * get_vault_context, unknown-vault errors, and scoped index rebuilds.
 *
 * Two real NoteStore/SearchIndex pairs over temp dirs are wired into one runtime
 * registry, and the tool handlers are invoked directly (same pattern as
 * mcpTools.test.ts) — no stdio plumbing.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { NoteStore } from '../../notes/NoteStore.js';
import { SearchIndex } from '../../search/SearchIndex.js';
import { createMcpServer, type VaultRuntime } from '../server.js';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'library-mvault-test-'));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = { inputSchema: any; handler: (args: unknown, extra: unknown) => Promise<{
  isError?: boolean;
  content: { type: string; text: string }[];
}> };

describe('multi-vault tool routing', () => {
  let personalDir: string;
  let workDir: string;
  let personal: VaultRuntime;
  let work: VaultRuntime;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

  async function makeRuntime(name: string, dir: string): Promise<VaultRuntime> {
    const noteStore = new NoteStore(dir);
    const searchIndex = new SearchIndex();
    // Deliberately skip initialize(): these routing tests never rely on
    // watcher-driven rebuilds (the handlers rebuild indexes via direct fs reads),
    // and the temp dir already exists (mkdtemp). Starting a chokidar watcher per
    // vault here only leaks poll timers that race afterEach's dir removal.
    return { name, notesDir: dir, contextFile: 'profile.md', noteStore, searchIndex };
  }

  async function reindex(rt: VaultRuntime) {
    rt.searchIndex.buildIndexWithContent(await rt.noteStore.listWithContent());
  }

  function getTool(name: string): AnyTool {
    const reg = server._registeredTools[name];
    if (!reg) throw new Error(`tool not registered: ${name}`);
    return reg;
  }

  function rebuild() {
    server = createMcpServer(
      { vaults: [personal, work], defaultVault: 'personal' },
      { defaultExcludeTags: [] },
    );
  }

  beforeEach(async () => {
    personalDir = await makeTmpDir();
    workDir = await makeTmpDir();
    personal = await makeRuntime('personal', personalDir);
    work = await makeRuntime('work', workDir);
    rebuild();
  });

  afterEach(async () => {
    // close() is a no-op without a started watcher, but kept for symmetry.
    await personal.noteStore.close();
    await work.noteStore.close();
    await fs.rm(personalDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  });

  // ── Reads span all vaults with provenance ──────────────────────────────────

  describe('read-wide + provenance', () => {
    beforeEach(async () => {
      await personal.noteStore.upsert({ slug: 'p-note', title: 'Personal Note', content: 'alpha body' });
      await work.noteStore.upsert({ slug: 'w-note', title: 'Work Note', content: 'beta body' });
      await reindex(personal);
      await reindex(work);
    });

    test('list_notes with no vault spans both, tagging each result', async () => {
      const res = await getTool('list_notes').handler({}, {});
      const parsed = JSON.parse(res.content[0].text) as Array<{ slug: string; vault: string }>;
      const bySlug = Object.fromEntries(parsed.map((n) => [n.slug, n.vault]));
      expect(bySlug['p-note']).toBe('personal');
      expect(bySlug['w-note']).toBe('work');
      expect(parsed).toHaveLength(2);
    });

    test('list_notes with vault:"work" returns only that vault', async () => {
      const res = await getTool('list_notes').handler({ vault: 'work' }, {});
      const parsed = JSON.parse(res.content[0].text) as Array<{ slug: string; vault: string }>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0].slug).toBe('w-note');
      expect(parsed[0].vault).toBe('work');
    });

    test('search_notes with no vault merges both corpora with provenance', async () => {
      const res = await getTool('search_notes').handler({ query: 'body' }, {});
      const parsed = JSON.parse(res.content[0].text) as Array<{ slug: string; vault: string }>;
      const bySlug = Object.fromEntries(parsed.map((n) => [n.slug, n.vault]));
      expect(bySlug['p-note']).toBe('personal');
      expect(bySlug['w-note']).toBe('work');
    });

    test('search_notes with vault:"personal" scopes to that index', async () => {
      const res = await getTool('search_notes').handler({ query: 'body', vault: 'personal' }, {});
      const parsed = JSON.parse(res.content[0].text) as Array<{ slug: string; vault: string }>;
      expect(parsed.map((n) => n.slug)).toEqual(['p-note']);
      expect(parsed[0].vault).toBe('personal');
    });

    test('list_todos with no vault spans both, tagging each result', async () => {
      await personal.noteStore.upsert({ slug: 'p-todo', title: 'P Todo', content: '- [ ] ptask' });
      await work.noteStore.upsert({ slug: 'w-todo', title: 'W Todo', content: '- [ ] wtask' });
      const res = await getTool('list_todos').handler({}, {});
      const parsed = JSON.parse(res.content[0].text) as Array<{ slug: string; vault: string }>;
      const bySlug = Object.fromEntries(parsed.map((n) => [n.slug, n.vault]));
      expect(bySlug['p-todo']).toBe('personal');
      expect(bySlug['w-todo']).toBe('work');
    });
  });

  // ── Cross-vault search merge contract ──────────────────────────────────────

  describe('cross-vault search merge', () => {
    test('merged results order by raw score across vaults, not by vault iteration order', async () => {
      // `personal` is the default vault, so it is iterated first — a concat-only
      // merge would place its hit first. Give `work` (iterated second) the much
      // higher term frequency (title-weighted + three body occurrences → tf 6)
      // and `personal` a weak one (single body occurrence → tf 1), so a correct
      // score-sorted merge reorders work ahead of personal.
      await personal.noteStore.upsert({ slug: 'p-weak', title: 'Personal Note', content: 'quokka appears once here' });
      await work.noteStore.upsert({ slug: 'w-strong', title: 'Quokka Field Report', content: 'quokka quokka quokka' });
      await reindex(personal);
      await reindex(work);

      const res = await getTool('search_notes').handler({ query: 'quokka' }, {});
      const parsed = JSON.parse(res.content[0].text) as Array<{ slug: string; vault: string; score: number }>;

      expect(parsed.map((n) => n.slug)).toEqual(['w-strong', 'p-weak']);
      expect(parsed.map((n) => n.vault)).toEqual(['work', 'personal']);
      expect(parsed[0].score).toBeGreaterThan(parsed[1].score);
    });

    test('the global limit is applied after the cross-vault merge', async () => {
      await personal.noteStore.upsert({ slug: 'p-a', title: 'Alpha topicword', content: 'topicword topicword' });
      await personal.noteStore.upsert({ slug: 'p-b', title: 'Beta', content: 'topicword' });
      await work.noteStore.upsert({ slug: 'w-a', title: 'Gamma topicword', content: 'topicword topicword topicword' });
      await reindex(personal);
      await reindex(work);

      const res = await getTool('search_notes').handler({ query: 'topicword', limit: 2 }, {});
      const parsed = JSON.parse(res.content[0].text) as Array<{ slug: string }>;
      // 3 matches across 2 vaults, capped to the global top 2 by score.
      // Assert the *specific* survivors (w-a highest, then p-a) and that the
      // weakest match (p-b) is dropped — so a per-vault-fractional-sampling bug
      // that also returned length 2 (e.g. ['p-a','w-a']) can't pass vacuously.
      expect(parsed.map((n) => n.slug)).toEqual(['w-a', 'p-a']);
      expect(parsed.map((n) => n.slug)).not.toContain('p-b');
    });

    test('per-vault index independence: a write/rebuild in one vault does not perturb another vault\'s scores', async () => {
      await personal.noteStore.upsert({ slug: 'p-sig', title: 'Signal P', content: 'signal here' });
      await work.noteStore.upsert({ slug: 'w-sig', title: 'Signal W', content: 'signal here' });
      await reindex(personal);
      await reindex(work);

      const before = JSON.parse(
        (await getTool('search_notes').handler({ query: 'signal', vault: 'work' }, {})).content[0].text,
      ) as Array<{ slug: string; score: number }>;
      const workScoreBefore = before.find((r) => r.slug === 'w-sig')!.score;

      // Add signal-heavy notes to the DEFAULT (personal) vault via the handler,
      // which rebuilds only personal's index. With a shared index this would
      // shift work's IDF/docFreq (and thus its score); with per-vault indexes it
      // must not.
      for (let i = 0; i < 5; i++) {
        await getTool('create_note').handler(
          { path: `p-noise-${i}`, title: `Signal noise ${i}`, content: 'signal signal signal signal' },
          {},
        );
      }

      const after = JSON.parse(
        (await getTool('search_notes').handler({ query: 'signal', vault: 'work' }, {})).content[0].text,
      ) as Array<{ slug: string; score: number }>;
      const workScoreAfter = after.find((r) => r.slug === 'w-sig')!.score;

      expect(workScoreAfter).toBe(workScoreBefore);
      // And personal's own search now reflects its rebuilt, larger corpus.
      const personalHits = JSON.parse(
        (await getTool('search_notes').handler({ query: 'signal', vault: 'personal' }, {})).content[0].text,
      ) as Array<{ slug: string }>;
      expect(personalHits.length).toBeGreaterThan(1);
    });
  });

  // ── get_note default-first resolution + collision ──────────────────────────

  describe('get_note cross-vault resolution', () => {
    test('resolves a unique slug and returns raw unchanged', async () => {
      const written = await work.noteStore.upsert({ slug: 'only-work', title: 'Only Work', content: 'w body' });
      const res = await getTool('get_note').handler({ slug: 'only-work' }, {});
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toBe(written.raw);
    });

    test('a slug present in multiple vaults errors listing them', async () => {
      await personal.noteStore.upsert({ slug: 'shared', title: 'P', content: 'p' });
      await work.noteStore.upsert({ slug: 'shared', title: 'W', content: 'w' });
      const res = await getTool('get_note').handler({ slug: 'shared' }, {});
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/multiple vaults/);
      expect(res.content[0].text).toContain('"personal"');
      expect(res.content[0].text).toContain('"work"');
    });

    test('an explicit vault disambiguates a colliding slug', async () => {
      await personal.noteStore.upsert({ slug: 'shared', title: 'P', content: 'p' });
      const written = await work.noteStore.upsert({ slug: 'shared', title: 'W', content: 'w body' });
      const res = await getTool('get_note').handler({ slug: 'shared', vault: 'work' }, {});
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toBe(written.raw);
    });

    test('default-vault copy wins is not assumed — collision is surfaced, not silently resolved', async () => {
      await personal.noteStore.upsert({ slug: 'shared', title: 'P', content: 'p' });
      await work.noteStore.upsert({ slug: 'shared', title: 'W', content: 'w' });
      const res = await getTool('get_note').handler({ slug: 'shared' }, {});
      expect(res.isError).toBe(true);
    });

    test('missing slug in a named vault reports not-found for that vault', async () => {
      const res = await getTool('get_note').handler({ slug: 'nope', vault: 'work' }, {});
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('not found in vault "work"');
    });
  });

  // ── Writes default narrow ──────────────────────────────────────────────────

  describe('write-narrow routing', () => {
    test('create_note with no vault lands in the default (personal) vault only', async () => {
      const res = await getTool('create_note').handler({ path: 'draft', title: 'Draft', content: 'x' }, {});
      expect(res.isError).toBeFalsy();
      expect(await personal.noteStore.get('draft')).not.toBeNull();
      expect(await work.noteStore.get('draft')).toBeNull();
    });

    test('create_note with vault:"work" lands in work only', async () => {
      const res = await getTool('create_note').handler({ path: 'wdraft', title: 'W Draft', content: 'x', vault: 'work' }, {});
      expect(res.isError).toBeFalsy();
      expect(await work.noteStore.get('wdraft')).not.toBeNull();
      expect(await personal.noteStore.get('wdraft')).toBeNull();
    });

    test('a default-vault write rebuilds only the default index (scoped rebuild)', async () => {
      await getTool('create_note').handler({ path: 'searchme', title: 'Searchme', content: 'zebra content' }, {});
      // Search scoped to work must not see the personal write.
      const workRes = await getTool('search_notes').handler({ query: 'zebra', vault: 'work' }, {});
      expect(workRes.content[0].text).toContain('No notes found');
      // Search scoped to personal sees it (its index was rebuilt).
      const personalRes = await getTool('search_notes').handler({ query: 'zebra', vault: 'personal' }, {});
      const parsed = JSON.parse(personalRes.content[0].text) as Array<{ slug: string }>;
      expect(parsed.map((n) => n.slug)).toContain('searchme');
    });

    test('update_note targets the named vault', async () => {
      await work.noteStore.upsert({ slug: 'wdoc', title: 'W', content: 'old' });
      const res = await getTool('update_note').handler({ slug: 'wdoc', title: 'W', content: 'new body', vault: 'work' }, {});
      expect(res.isError).toBeFalsy();
      const note = await work.noteStore.get('wdoc');
      expect(note?.content.trim()).toBe('new body');
    });

    test('update_note omitting vault does not find a note that lives only in work', async () => {
      await work.noteStore.upsert({ slug: 'wonly', title: 'W', content: 'x' });
      const res = await getTool('update_note').handler({ slug: 'wonly', content: 'y' }, {});
      // Write-narrow: default vault has no such note → not found (does NOT reach into work).
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('not found');
    });

    test('append_to_section, edit_note, edit_frontmatter, delete_note, move_note all honor vault', async () => {
      await work.noteStore.upsert({ slug: 'wsurgical', title: 'W', content: '## H\n\nline', tags: ['t'] });

      const append = await getTool('append_to_section').handler({ slug: 'wsurgical', heading: 'H', content: 'added', vault: 'work' }, {});
      expect(append.isError).toBeFalsy();
      expect((await work.noteStore.get('wsurgical'))?.content).toContain('added');

      const edit = await getTool('edit_note').handler({ slug: 'wsurgical', old_string: 'line', new_string: 'LINE', vault: 'work' }, {});
      expect(edit.isError).toBeFalsy();
      expect((await work.noteStore.get('wsurgical'))?.content).toContain('LINE');

      const fm = await getTool('edit_frontmatter').handler({ slug: 'wsurgical', set: { status: 'done' }, vault: 'work' }, {});
      expect(fm.isError).toBeFalsy();
      expect((await work.noteStore.get('wsurgical'))?.frontmatter.status).toBe('done');

      const move = await getTool('move_note').handler({ slug: 'wsurgical', new_slug: 'wmoved', vault: 'work' }, {});
      expect(move.isError).toBeFalsy();
      expect(await work.noteStore.get('wmoved')).not.toBeNull();

      const del = await getTool('delete_note').handler({ slug: 'wmoved', vault: 'work' }, {});
      expect(del.isError).toBeFalsy();
      expect(await work.noteStore.get('wmoved')).toBeNull();
    });
  });

  // ── get_vault_context per-vault ────────────────────────────────────────────

  describe('get_vault_context', () => {
    test('omitted vault reads the default vault context file', async () => {
      await fs.writeFile(path.join(personalDir, 'profile.md'), 'PERSONAL PROFILE', 'utf-8');
      await fs.writeFile(path.join(workDir, 'profile.md'), 'WORK PROFILE', 'utf-8');
      const res = await getTool('get_vault_context').handler({}, {});
      expect(res.content[0].text).toBe('PERSONAL PROFILE');
    });

    test('vault:"work" reads that vault context file', async () => {
      await fs.writeFile(path.join(workDir, 'profile.md'), 'WORK PROFILE', 'utf-8');
      const res = await getTool('get_vault_context').handler({ vault: 'work' }, {});
      expect(res.content[0].text).toBe('WORK PROFILE');
    });

    test('a per-vault custom context_file is honored', async () => {
      const customWork: VaultRuntime = { ...work, contextFile: 'conventions.md' };
      server = createMcpServer(
        { vaults: [personal, customWork], defaultVault: 'personal' },
        { defaultExcludeTags: [] },
      );
      await fs.writeFile(path.join(workDir, 'conventions.md'), 'WORK CONVENTIONS', 'utf-8');
      const res = await getTool('get_vault_context').handler({ vault: 'work' }, {});
      expect(res.content[0].text).toBe('WORK CONVENTIONS');
    });

    test('missing context file errors clearly', async () => {
      const res = await getTool('get_vault_context').handler({ vault: 'work' }, {});
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('profile.md not found');
    });
  });

  // ── Unknown vault ──────────────────────────────────────────────────────────

  describe('unknown vault errors', () => {
    test('read tool with an unknown vault lists configured vaults', async () => {
      const res = await getTool('list_notes').handler({ vault: 'nope' }, {});
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Unknown vault "nope"');
      expect(res.content[0].text).toContain('"personal"');
      expect(res.content[0].text).toContain('"work"');
    });

    test('write tool with an unknown vault errors before writing', async () => {
      const res = await getTool('create_note').handler({ path: 'x', title: 'X', content: 'y', vault: 'nope' }, {});
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Unknown vault "nope"');
      expect(await personal.noteStore.get('x')).toBeNull();
      expect(await work.noteStore.get('x')).toBeNull();
    });

    test('get_note with an unknown vault errors', async () => {
      const res = await getTool('get_note').handler({ slug: 'x', vault: 'nope' }, {});
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Unknown vault "nope"');
    });

    test('get_vault_context with an unknown vault errors', async () => {
      const res = await getTool('get_vault_context').handler({ vault: 'nope' }, {});
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Unknown vault "nope"');
    });
  });
});
