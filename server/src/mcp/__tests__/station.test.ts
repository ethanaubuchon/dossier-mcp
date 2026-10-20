/**
 * Station vault tests: a local vault and a dossier-station vault wired into one
 * registry, with the station played by the contract-driven stub in
 * stubStation.ts over real HTTP. Covers read-wide merging, degraded reads when
 * the station fails, writes through the `write` verb, history, and the tools a
 * station refuses.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { NoteStore } from '../../notes/NoteStore.js';
import { SearchIndex } from '../../search/SearchIndex.js';
import {
  createMcpServer,
  createStationRuntime,
  type LocalVaultRuntime,
  type StationVaultRuntime,
  type VaultRuntime,
} from '../server.js';
import { startStubStation, type StubStation } from './stubStation.js';

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = { handler: (args: unknown, extra: unknown) => Promise<ToolResult> };

describe('station vault', () => {
  let dir: string;
  let stub: StubStation;
  let personal: LocalVaultRuntime;
  let team: StationVaultRuntime;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

  function station(overrides: { url?: string; apiKey?: string; timeoutMs?: number } = {}): StationVaultRuntime {
    return createStationRuntime({
      type: 'station',
      name: 'team',
      url: overrides.url ?? stub.url,
      apiKeyEnv: 'STATION_KEY',
      apiKey: overrides.apiKey ?? stub.apiKey,
      timeoutMs: overrides.timeoutMs ?? 2000,
      contextFile: 'profile.md',
    });
  }

  function wire(vaults: VaultRuntime[], defaultVault = 'personal') {
    server = createMcpServer({ vaults, defaultVault }, { version: '0.0.0-test', defaultExcludeTags: ['archived'] });
  }

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool: AnyTool | undefined = server._registeredTools[name];
    if (!tool) throw new Error(`tool not registered: ${name}`);
    // Run the args through the tool's schema so defaults apply, as the SDK does.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = (tool as any).inputSchema ? (tool as any).inputSchema.parse(args) : args;
    return tool.handler(parsed, {});
  }

  const text = (r: ToolResult) => r.content[0].text;
  const notices = (r: ToolResult) => r.content.slice(1).map((c) => c.text);

  async function seedLocal(slug: string, title: string, content: string, date: string) {
    await personal.noteStore.upsert({ slug, title, content, tags: [], related: [] });
    // Pin the date so merge order is deterministic.
    const file = path.join(dir, `${slug}.md`);
    const raw = await fs.readFile(file, 'utf-8');
    await fs.writeFile(file, raw.replace(/date: .*/, `date: '${date}'`));
    personal.searchIndex.buildIndexWithContent(await personal.noteStore.listWithContent());
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'library-station-test-'));
    stub = await startStubStation();
    personal = { type: 'local', name: 'personal', notesDir: dir, contextFile: 'profile.md', noteStore: new NoteStore(dir), searchIndex: new SearchIndex() };
    team = station();
    wire([personal, team]);

    await seedLocal('notes/local-alpha', 'Local alpha', 'alpha content here', '2026-10-01');
    stub.notes.set('projects/app-search', {
      frontmatter: { type: 'project', title: 'App search', date: '2026-10-05', tags: ['search'], parent: 'dossier' },
      body: 'alpha project body\n',
    });
    stub.notes.set('issues/STN-1', {
      frontmatter: { id: 'STN-1', type: 'issue', title: 'First issue', created: '2026-09-20T10:00', labels: ['x'] },
      body: 'issue body\n',
    });
    stub.notes.set('docs/old', {
      frontmatter: { title: 'Old', date: '2026-01-01', tags: ['archived'] },
      body: 'alpha but archived\n',
    });
  });

  afterEach(async () => {
    await stub.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // ── Reads ──────────────────────────────────────────────────────────────────

  describe('reads', () => {
    test('list_notes merges station notes, tagged and sorted by date (created as fallback)', async () => {
      const r = await call('list_notes', {});
      expect(r.isError).toBeFalsy();
      expect(notices(r)).toEqual([]);
      const items = JSON.parse(text(r)) as Array<{ slug: string; vault: string }>;
      expect(items.map((i) => [i.slug, i.vault])).toEqual([
        ['projects/app-search', 'team'],
        ['notes/local-alpha', 'personal'],
        ['issues/STN-1', 'team'],
      ]);
    });

    test('list_notes sends the prefix and effective exclude set to the station', async () => {
      await call('list_notes', { path: 'projects' });
      expect(stub.requests.at(-1)).toEqual({
        endpoint: 'listNotes',
        body: { path: 'projects/', exclude_tags: ['archived'] },
      });
      const r = await call('list_notes', { exclude_tags: [], vault: 'team' });
      expect(JSON.parse(text(r))).toHaveLength(3);
    });

    test('search_notes merges station results by score with provenance', async () => {
      const r = await call('search_notes', { query: 'alpha' });
      const hits = JSON.parse(text(r)) as Array<{ slug: string; vault: string }>;
      expect(hits.map((h) => h.vault).sort()).toEqual(['personal', 'team']);
      expect(hits.find((h) => h.vault === 'team')!.slug).toBe('projects/app-search');
    });

    test('get_note on a station returns raw markdown with frontmatter, lists and objects intact', async () => {
      const r = await call('get_note', { slug: 'issues/STN-1', vault: 'team' });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toMatch(/^---\n/);
      expect(text(r)).toContain('id: STN-1');
      expect(text(r)).toContain('- x');
      expect(text(r)).toContain('issue body');
    });

    test('get_note without vault finds a station-only note, and a missing note is not found', async () => {
      expect(text(await call('get_note', { slug: 'projects/app-search' }))).toContain('alpha project body');
      const missing = await call('get_note', { slug: 'nope' });
      expect(missing.isError).toBe(true);
      expect(text(missing)).toBe('Note "nope" not found.');
    });

    test('get_note without vault errors on a local/station collision', async () => {
      stub.notes.set('notes/local-alpha', { frontmatter: { title: 'Dup' }, body: 'dup' });
      const r = await call('get_note', { slug: 'notes/local-alpha' });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/multiple vaults: "personal", "team"/);
    });

    test('get_vault_context on a station reads its context note', async () => {
      stub.notes.set('profile', { frontmatter: { title: 'Team profile' }, body: 'Team conventions\n' });
      const r = await call('get_vault_context', { vault: 'team' });
      expect(text(r)).toContain('Team conventions');
    });
  });

  describe('search type filter', () => {
    beforeEach(async () => {
      await seedLocal('issues/local-alpha', 'Local alpha issue', 'alpha issue here', '2026-10-02');
      stub.notes.set('issues/STN-2', {
        frontmatter: { id: 'STN-2', type: 'issue', title: 'Alpha issue', created: '2026-09-21T10:00' },
        body: 'alpha issue body\n',
      });
    });

    const slugs = (r: ToolResult) => (JSON.parse(text(r)) as Array<{ slug: string }>).map((h) => h.slug).sort();

    test('type: "issue" sends kind to the station and keeps only local issues/ notes', async () => {
      const r = await call('search_notes', { query: 'alpha', type: 'issue' });
      expect(stub.requests.at(-1)).toEqual({
        endpoint: 'searchNotes',
        body: { query: 'alpha', limit: 10, exclude_tags: ['archived'], kind: 'issue' },
      });
      expect(slugs(r)).toEqual(['issues/STN-2', 'issues/local-alpha']);
    });

    test('type: "doc" leaves out issues on both sides', async () => {
      const r = await call('search_notes', { query: 'alpha', type: 'doc' });
      expect(stub.requests.at(-1)?.body.kind).toBe('doc');
      expect(slugs(r)).toEqual(['notes/local-alpha', 'projects/app-search']);
    });

    test('omitted type searches both and sends no kind', async () => {
      const r = await call('search_notes', { query: 'alpha' });
      expect(stub.requests.at(-1)?.body).not.toHaveProperty('kind');
      expect(slugs(r)).toEqual(['issues/STN-2', 'issues/local-alpha', 'notes/local-alpha', 'projects/app-search']);
    });

    test('the local type filter applies before the limit', async () => {
      const r = await call('search_notes', { query: 'alpha', type: 'issue', limit: 1, vault: 'personal' });
      expect(slugs(r)).toEqual(['issues/local-alpha']);
    });
  });

  // ── Degraded reads ─────────────────────────────────────────────────────────

  describe('when the station fails', () => {
    async function expectDegraded(code: RegExp) {
      const list = await call('list_notes', {});
      expect(list.isError).toBeFalsy();
      expect(JSON.parse(text(list)).map((i: { slug: string }) => i.slug)).toEqual(['notes/local-alpha']);
      expect(notices(list)).toHaveLength(1);
      expect(notices(list)[0]).toMatch(/^Station vault "team" unavailable/);
      expect(notices(list)[0]).toMatch(code);

      const search = await call('search_notes', { query: 'alpha' });
      expect(search.isError).toBeFalsy();
      expect(JSON.parse(text(search)).map((h: { vault: string }) => h.vault)).toEqual(['personal']);
      expect(notices(search)[0]).toMatch(code);

      const hit = await call('get_note', { slug: 'notes/local-alpha' });
      expect(hit.isError).toBeFalsy();
      expect(text(hit)).toContain('alpha content here');
      expect(notices(hit)[0]).toMatch(code);

      const miss = await call('get_note', { slug: 'projects/app-search' });
      expect(miss.isError).toBe(true);
      expect(notices(miss)[0]).toMatch(code);

      const explicit = await call('list_notes', { vault: 'team' });
      expect(explicit.isError).toBe(true);
      expect(text(explicit)).toMatch(code);
    }

    test('unreachable (server gone): local results plus a notice; an explicit station read errors', async () => {
      await stub.close();
      await expectDegraded(/unreachable/);
    });

    test('a hanging station trips the timeout and degrades the same way', async () => {
      team = station({ timeoutMs: 100 });
      wire([personal, team]);
      stub.hang = true;
      await expectDegraded(/unreachable/);
    });

    test('a rejected API key degrades read-wide calls with the error code', async () => {
      team = station({ apiKey: 'wrong' });
      wire([personal, team]);
      await expectDegraded(/unauthorized/);
    });
  });

  // ── Writes ─────────────────────────────────────────────────────────────────

  describe('writes', () => {
    test('create_note writes through the write verb with create_only; a second create conflicts', async () => {
      const r = await call('create_note', { title: 'Runbook', content: 'steps\n', path: 'docs/runbook', tags: ['ops'], vault: 'team' });
      expect(r.isError).toBeFalsy();
      const req = stub.requests.find((q) => q.endpoint === 'write')!;
      expect(req.body).toMatchObject({ slug: 'docs/runbook', body: 'steps\n', create_only: true });
      expect(req.body.frontmatter).toMatchObject({ title: 'Runbook', tags: ['ops'], related: [] });

      const again = await call('create_note', { title: 'Runbook', content: 'x', path: 'docs/runbook', vault: 'team' });
      expect(again.isError).toBe(true);
      expect(text(again)).toBe('Note already exists at "docs/runbook" — use update_note to modify it.');
    });

    test('update_note keeps existing tags and non-flat extras', async () => {
      const r = await call('update_note', { slug: 'projects/app-search', title: 'App search', content: 'new body\n', vault: 'team' });
      expect(r.isError).toBeFalsy();
      const stored = stub.notes.get('projects/app-search')!;
      expect(stored.body).toBe('new body\n');
      expect(stored.frontmatter).toMatchObject({ title: 'App search', tags: ['search'], parent: 'dossier', type: 'project', date: '2026-10-05' });
      const write = stub.requests.find((q) => q.endpoint === 'write')!;
      expect(write.body.create_only).toBeUndefined();
    });

    test('update_note round-trips get_note output, keeping lists the content can carry', async () => {
      const raw = text(await call('get_note', { slug: 'projects/app-search', vault: 'team' }));
      const r = await call('update_note', { slug: 'projects/app-search', content: raw.replace('alpha project body', 'edited'), vault: 'team' });
      expect(r.isError).toBeFalsy();
      const stored = stub.notes.get('projects/app-search')!;
      expect(stored.body).toBe('edited\n');
      expect(stored.frontmatter).toMatchObject({ title: 'App search', tags: ['search'], parent: 'dossier' });
    });

    test('update_note on a missing station note is not found and writes nothing', async () => {
      const r = await call('update_note', { slug: 'docs/nope', title: 'Nope', content: 'x', vault: 'team' });
      expect(text(r)).toBe('Note "docs/nope" not found.');
      expect(stub.requests.some((q) => q.endpoint === 'write')).toBe(false);
    });

    test('edit_note and append_to_section round-trip through get and write, preserving lists', async () => {
      stub.notes.set('docs/guide', {
        frontmatter: { title: 'Guide', date: '2026-10-02', tags: [], owners: ['a', 'b'] },
        body: '## Steps\n\n- one\n',
      });
      const edit = await call('edit_note', { slug: 'docs/guide', old_string: 'one', new_string: 'uno', vault: 'team' });
      expect(edit.isError).toBeFalsy();
      const append = await call('append_to_section', { slug: 'docs/guide', heading: 'Steps', content: '- two', vault: 'team' });
      expect(append.isError).toBeFalsy();
      const stored = stub.notes.get('docs/guide')!;
      expect(stored.body).toContain('- uno');
      expect(stored.body).toContain('- two');
      expect(stored.frontmatter.owners).toEqual(['a', 'b']);
      expect(stored.frontmatter.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('editing a station note adds no placeholder title, date, or empty lists it lacked', async () => {
      stub.notes.set('docs/bare', { frontmatter: { owner: 'ops', created: '2026-09-01T09:00' }, body: 'old text\n' });
      const r = await call('edit_note', { slug: 'docs/bare', old_string: 'old', new_string: 'new', vault: 'team' });
      expect(r.isError).toBeFalsy();
      const fm = stub.notes.get('docs/bare')!.frontmatter;
      expect(Object.keys(fm).sort()).toEqual(['created', 'owner', 'updated']);

      await call('edit_frontmatter', { slug: 'docs/bare', add_tags: ['ops'], vault: 'team' });
      expect(stub.notes.get('docs/bare')!.frontmatter.tags).toEqual(['ops']);
    });

    test('editing a station note keeps typed fields it could not read', async () => {
      stub.notes.set('docs/odd', { frontmatter: { title: 'Odd', tags: 'solo', date: 20261001 }, body: 'x\n' });
      await call('edit_note', { slug: 'docs/odd', old_string: 'x', new_string: 'y', vault: 'team' });
      expect(stub.notes.get('docs/odd')!.frontmatter).toMatchObject({ title: 'Odd', tags: 'solo', date: 20261001 });
    });

    test('station errors name their code once', async () => {
      await stub.close();
      const r = await call('list_notes', {});
      expect(notices(r)[0]).toMatch(/\(station unreachable: /);
    });

    test('edit_frontmatter sets fields on a station note', async () => {
      const r = await call('edit_frontmatter', { slug: 'projects/app-search', set: { status: 'active' }, add_tags: ['infra'], vault: 'team' });
      expect(r.isError).toBeFalsy();
      expect(stub.notes.get('projects/app-search')!.frontmatter).toMatchObject({ status: 'active', tags: ['search', 'infra'], parent: 'dossier' });
    });

    test('a station default vault receives writes that name no vault', async () => {
      wire([personal, team], 'team');
      const r = await call('create_note', { title: 'Plan', content: 'p', path: 'docs/plan' });
      expect(r.isError).toBeFalsy();
      expect(stub.notes.has('docs/plan')).toBe(true);
      expect(await personal.noteStore.get('docs/plan')).toBeNull();
    });

    test('a station error during a write is reported with its code', async () => {
      await stub.close();
      const r = await call('create_note', { title: 'X', content: 'x', path: 'docs/x', vault: 'team' });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^Failed to write note "docs\/x": station unreachable: /);
    });
  });

  // ── History and refusals ───────────────────────────────────────────────────

  describe('note_history', () => {
    test('returns the station history, newest first, using the only station when vault is omitted', async () => {
      await call('update_note', { slug: 'projects/app-search', title: 'App search', content: 'v2', vault: 'team' });
      await call('update_note', { slug: 'projects/app-search', title: 'App search', content: 'v3', vault: 'team' });
      const r = await call('note_history', { slug: 'projects/app-search' });
      expect(r.isError).toBeFalsy();
      const entries = JSON.parse(text(r)) as Array<{ commit: string }>;
      expect(entries.map((e) => e.commit)).toEqual(['0000002', '0000001']);
      const limited = JSON.parse(text(await call('note_history', { slug: 'projects/app-search', limit: 1 })));
      expect(limited).toHaveLength(1);
    });

    test('a local vault keeps no history', async () => {
      const r = await call('note_history', { slug: 'notes/local-alpha', vault: 'personal' });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/local vault/);
    });

    test('with no station configured, vault cannot be inferred', async () => {
      wire([personal]);
      const r = await call('note_history', { slug: 'x' });
      expect(text(r)).toMatch(/No station vault is configured/);
    });
  });

  describe('refused on station vaults', () => {
    test.each([
      ['create_note', { title: 'I', content: 'x', path: 'issues/STN-9' }],
      ['update_note', { slug: 'issues/STN-1', title: 'I', content: 'x' }],
      ['edit_note', { slug: 'issues/STN-1', old_string: 'issue', new_string: 'x' }],
      ['append_to_section', { slug: 'issues/STN-1', heading: 'H', content: 'x' }],
      ['edit_frontmatter', { slug: 'issues/STN-1', set: { status: 'done' } }],
    ])('%s on an issue slug errors without calling the station', async (tool, args) => {
      const r = await call(tool, { ...args, vault: 'team' });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/is an issue in station vault "team"/);
      expect(text(r)).toMatch(/update_issue or comment_issue/);
      expect(stub.requests).toEqual([]);
    });

    test('issue slugs stay writable in local vaults', async () => {
      const r = await call('create_note', { title: 'Local issue note', content: 'x', path: 'issues/local' });
      expect(r.isError).toBeFalsy();
    });

    test('delete_note and move_note error without calling the station', async () => {
      const del = await call('delete_note', { slug: 'projects/app-search', vault: 'team' });
      expect(del.isError).toBe(true);
      expect(text(del)).toMatch(/delete_note is not supported on station vault "team"/);
      const mv = await call('move_note', { slug: 'projects/app-search', new_slug: 'projects/x', vault: 'team' });
      expect(text(mv)).toMatch(/move_note is not supported on station vault "team"/);
      expect(stub.requests).toEqual([]);
    });

    test('list_todos skips stations with a notice, and refuses one by name', async () => {
      await seedLocal('notes/todo', 'Todo', '- [ ] do it', '2026-10-03');
      const wide = await call('list_todos', {});
      expect(JSON.parse(text(wide)).map((n: { slug: string }) => n.slug)).toEqual(['notes/todo']);
      expect(notices(wide)).toEqual(['Station vault "team" is not scanned for todos.']);
      const named = await call('list_todos', { vault: 'team' });
      expect(named.isError).toBe(true);
    });
  });
});
