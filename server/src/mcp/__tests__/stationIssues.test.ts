/**
 * Issue tool tests: create_issue (with the duplicate check), update_issue,
 * comment_issue and query_issues against the contract-driven stub station,
 * plus how the tools pick their station vault.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { IssueFrontmatter } from 'dossier-station-api';
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
type AnyTool = { handler: (args: unknown, extra: unknown) => Promise<ToolResult> };

describe('station issue tools', () => {
  let dir: string;
  let stub: StubStation;
  let personal: LocalVaultRuntime;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

  function station(name = 'team', url = stub.url): StationVaultRuntime {
    return createStationRuntime({
      type: 'station',
      name,
      url,
      apiKeyEnv: 'STATION_KEY',
      apiKey: stub.apiKey,
      timeoutMs: 2000,
      contextFile: 'profile.md',
    });
  }

  function wire(vaults: VaultRuntime[]) {
    server = createMcpServer({ vaults, defaultVault: 'personal' }, { version: '0.0.0-test' });
  }

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool: AnyTool | undefined = server._registeredTools[name];
    if (!tool) throw new Error(`tool not registered: ${name}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = (tool as any).inputSchema ? (tool as any).inputSchema.parse(args) : args;
    return tool.handler(parsed, {});
  }

  const text = (r: ToolResult) => r.content[0].text;
  const lastRequest = () => stub.requests.at(-1);
  const stored = (id: string) => stub.notes.get(`issues/${id}`)!;

  function seedIssue(fm: Partial<IssueFrontmatter> & { id: string; title: string }, body = 'Details.\n') {
    stub.notes.set(`issues/${fm.id}`, {
      frontmatter: {
        type: 'issue',
        status: 'backlog',
        created: '2026-10-01T09:00',
        'created-by': { kind: 'human', source: 'ethan' },
        repos: [],
        labels: [],
        'blocked-by': [],
        prs: [],
        ...fm,
      },
      body,
    });
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'library-station-issues-test-'));
    stub = await startStubStation();
    personal = { type: 'local', name: 'personal', notesDir: dir, contextFile: 'profile.md', noteStore: new NoteStore(dir), searchIndex: new SearchIndex() };
    wire([personal, station()]);
    seedIssue({ id: 'STN-1', title: 'Search index drops archived notes', labels: ['search'], repos: ['dossier-mcp'], project: 'app-search' });
  });

  afterEach(async () => {
    await stub.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('create_issue', () => {
    test('creates a triage issue attributed to the agent, recording found-during', async () => {
      const r = await call('create_issue', {
        title: 'Station timeout is not configurable per call',
        body: 'Long queries time out.',
        labels: ['station'],
        found_during: 'STN-1',
      });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toMatch(/^Created issue STN-2: "Station timeout is not configurable per call"\./);
      expect(text(r)).toContain('Long queries time out.');
      expect(lastRequest()).toEqual({
        endpoint: 'createIssue',
        body: {
          title: 'Station timeout is not configurable per call',
          body: 'Long queries time out.',
          labels: ['station'],
          'found-during': 'STN-1',
          'created-by': { kind: 'agent', source: 'dossier-mcp' },
        },
      });
      expect(stored('STN-2').frontmatter).toMatchObject({ status: 'triage', 'found-during': 'STN-1' });
    });

    test('attributes to the MCP client name by default, or to an explicit source', async () => {
      jest.spyOn(server.server, 'getClientVersion').mockReturnValue({ name: 'claude-code', version: '1.0.0' });
      await call('create_issue', { title: 'Unrelated thing one' });
      expect(lastRequest()?.body['created-by']).toEqual({ kind: 'agent', source: 'claude-code' });
      await call('create_issue', { title: 'Unrelated thing two', source: 'session-42', confirm_new: true });
      expect(lastRequest()?.body['created-by']).toEqual({ kind: 'agent', source: 'session-42' });
    });

    test('returns duplicate candidates without creating anything', async () => {
      const r = await call('create_issue', { title: 'Archived notes vanish from search index' });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toMatch(/^No issue was created: 1 existing issue\(s\) may already cover this\./);
      expect(text(r)).toContain('"id": "STN-1"');
      expect(text(r)).toMatch(/comment_issue/);
      expect(text(r)).toMatch(/confirm_new: true/);
      expect(stub.notes.has('issues/STN-2')).toBe(false);
    });

    test('confirm_new creates despite the overlap', async () => {
      const r = await call('create_issue', { title: 'Archived notes vanish from search index', confirm_new: true });
      expect(text(r)).toMatch(/^Created issue STN-2:/);
      expect(lastRequest()?.body.confirm_new).toBe(true);
    });

    test('a station rejection is reported with its code', async () => {
      const r = await call('create_issue', { title: 'Bad project', project: 'Not A Slug!' });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^Failed to create issue: invalid_request/);
    });
  });

  describe('update_issue', () => {
    test('maps snake_case params to the station fields and returns the issue', async () => {
      seedIssue({ id: 'STN-5', title: 'Blocker' });
      const r = await call('update_issue', {
        id: 'STN-1',
        status: 'blocked',
        blocked_by: ['STN-5'],
        last_reviewed: '2026-10-19',
      });
      expect(r.isError).toBeFalsy();
      expect(lastRequest()).toEqual({
        endpoint: 'updateIssue',
        body: { id: 'STN-1', set: { status: 'blocked', 'blocked-by': ['STN-5'], 'last-reviewed': '2026-10-19' } },
      });
      expect(text(r)).toMatch(/status: blocked/);
      expect(stored('STN-1').frontmatter['blocked-by']).toEqual(['STN-5']);
    });

    test('null clears an optional field', async () => {
      seedIssue({ id: 'STN-3', title: 'Owned', owner: 'ethan', 'found-during': 'STN-1' });
      await call('update_issue', { id: 'STN-3', owner: null, found_during: null, project: null });
      expect(lastRequest()?.body.set).toEqual({ owner: null, 'found-during': null, project: null });
      expect(stored('STN-3').frontmatter).not.toHaveProperty('owner');
      expect(stored('STN-3').frontmatter).not.toHaveProperty('found-during');
    });

    test('reopening a canceled duplicate needs resolution and duplicate-of cleared', async () => {
      seedIssue({ id: 'STN-6', title: 'Closed dup', status: 'canceled', resolution: 'duplicate', 'duplicate-of': 'STN-1' });
      const stale = await call('update_issue', { id: 'STN-6', status: 'backlog' });
      expect(stale.isError).toBe(true);
      expect(text(stale)).toMatch(/resolution requires status canceled/);
      const reopened = await call('update_issue', { id: 'STN-6', status: 'backlog', resolution: null, duplicate_of: null });
      expect(reopened.isError).toBeFalsy();
      expect(stored('STN-6').frontmatter).toMatchObject({ status: 'backlog' });
      expect(stored('STN-6').frontmatter).not.toHaveProperty('resolution');
      expect(stored('STN-6').frontmatter).not.toHaveProperty('duplicate-of');
    });

    test('closing as a duplicate sets resolution and duplicate-of together', async () => {
      seedIssue({ id: 'STN-4', title: 'Same as one' });
      const r = await call('update_issue', { id: 'STN-4', status: 'canceled', resolution: 'duplicate', duplicate_of: 'STN-1' });
      expect(r.isError).toBeFalsy();
      expect(stored('STN-4').frontmatter).toMatchObject({ status: 'canceled', resolution: 'duplicate', 'duplicate-of': 'STN-1' });
    });

    test('the station\'s cross-field rules surface as errors', async () => {
      const r = await call('update_issue', { id: 'STN-1', resolution: 'obsolete' });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^Failed to update issue "STN-1": invalid_request/);
      expect(text(r)).toMatch(/resolution requires status canceled/);
    });

    test('no fields to change errors without calling the station', async () => {
      const r = await call('update_issue', { id: 'STN-1' });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/changed nothing/);
      expect(stub.requests).toEqual([]);
    });

    test('an invalid id is reported before an empty change', async () => {
      const r = await call('update_issue', { id: 'bad' });
      expect(text(r)).toMatch(/^Invalid issue id "bad"/);
    });

    test('not_found about another issue is not blamed on the one being updated', async () => {
      const r = await call('update_issue', { id: 'STN-1', status: 'canceled', resolution: 'duplicate', duplicate_of: 'STN-77' });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe('Failed to update issue "STN-1": not_found: no issue STN-77');
    });

    test('an unknown issue reads as not found', async () => {
      const r = await call('update_issue', { id: 'STN-99', status: 'done' });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe('Issue "STN-99" not found in station vault "team" (no issue STN-99).');
    });
  });

  describe('comment_issue', () => {
    test('appends under ## Comments with the client name as default author', async () => {
      const r = await call('comment_issue', { id: 'STN-1', body: 'Seen again today.' });
      expect(r.isError).toBeFalsy();
      expect(lastRequest()).toEqual({
        endpoint: 'commentIssue',
        body: { id: 'STN-1', author: 'dossier-mcp', body: 'Seen again today.' },
      });
      expect(text(r)).toMatch(/## Comments\n\n\*\*dossier-mcp\*\* \(.+\):\n\nSeen again today\./);
    });

    test('an explicit author is passed through', async () => {
      await call('comment_issue', { id: 'STN-1', body: 'Note.', author: 'reviewer-bot' });
      expect(lastRequest()?.body.author).toBe('reviewer-bot');
    });

    test('an unknown issue reads as not found', async () => {
      const r = await call('comment_issue', { id: 'STN-99', body: 'x' });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^Issue "STN-99" not found in station vault "team"/);
    });
  });

  describe('query_issues', () => {
    beforeEach(() => {
      stub.notes.set('projects/app-search', { frontmatter: { type: 'project', title: 'App search', parent: 'dossier' }, body: '' });
      seedIssue({ id: 'STN-2', title: 'Done thing', status: 'done', project: 'dossier', 'last-reviewed': '2026-10-18' });
      seedIssue({ id: 'STN-3', title: 'Other repo', repos: ['station'], labels: ['search'], 'last-reviewed': '2000-01-01' });
    });

    const ids = (r: ToolResult) => (JSON.parse(text(r)) as Array<{ id: string }>).map((i) => i.id);

    test('passes every filter through and returns summaries', async () => {
      const filters = { status: ['backlog', 'done'], project: 'dossier', include_subprojects: true, repo: 'dossier-mcp', label: 'search', stale: true, limit: 5 };
      const r = await call('query_issues', filters);
      expect(lastRequest()).toEqual({ endpoint: 'queryIssues', body: filters });
      expect(ids(r)).toEqual(['STN-1']);
    });

    test('a project matches its subprojects unless told otherwise', async () => {
      expect(ids(await call('query_issues', { project: 'dossier' }))).toEqual(['STN-1', 'STN-2']);
      expect(ids(await call('query_issues', { project: 'dossier', include_subprojects: false }))).toEqual(['STN-2']);
    });

    test('stale only accepts true', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => (server._registeredTools.query_issues as any).inputSchema.parse({ stale: false })).toThrow();
    });

    test('no matches gives a plain line', async () => {
      const r = await call('query_issues', { label: 'nothing' });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toBe('No issues match.');
    });

    test('with no filters sends an empty query', async () => {
      await call('query_issues', {});
      expect(lastRequest()).toEqual({ endpoint: 'queryIssues', body: {} });
    });
  });

  describe('choosing the station', () => {
    test('an invalid issue id errors without calling the station', async () => {
      for (const [tool, args] of [
        ['update_issue', { id: 'stn-1', status: 'done' }],
        ['comment_issue', { id: 'STN-01', body: 'x' }],
      ] as const) {
        const r = await call(tool, args);
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/^Invalid issue id/);
      }
      expect(stub.requests).toEqual([]);
    });

    test('naming a local vault errors', async () => {
      const r = await call('query_issues', { vault: 'personal' });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe('Vault "personal" is a local vault; issues only exist in station vaults.');
    });

    test('an unknown vault errors', async () => {
      const r = await call('comment_issue', { id: 'STN-1', body: 'x', vault: 'nope' });
      expect(text(r)).toMatch(/^Unknown vault "nope"/);
    });

    test('no station configured errors', async () => {
      wire([personal]);
      const r = await call('create_issue', { title: 'x' });
      expect(text(r)).toBe('No station vault is configured; issues only exist in station vaults.');
    });

    test('two stations need vault named; naming one works', async () => {
      wire([personal, station('team'), station('ops')]);
      const r = await call('query_issues', {});
      expect(text(r)).toMatch(/More than one station vault is configured \("team", "ops"\)/);
      const named = await call('query_issues', { vault: 'ops' });
      expect(named.isError).toBeFalsy();
    });

    test('an unreachable station is an error naming the code', async () => {
      await stub.close();
      const r = await call('query_issues', {});
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^Failed to query issues: station unreachable/);
    });

    test('created issues are readable as notes and keep history', async () => {
      await call('create_issue', { title: 'Brand new subject entirely' });
      const note = await call('get_note', { slug: 'issues/STN-2', vault: 'team' });
      expect(text(note)).toMatch(/title: Brand new subject entirely/);
      await call('update_issue', { id: 'STN-2', status: 'backlog' });
      const hist = JSON.parse(text(await call('note_history', { slug: 'issues/STN-2' })));
      expect(hist.map((e: { status_change?: unknown }) => e.status_change)).toEqual([
        { from: 'triage', to: 'backlog' },
        { from: null, to: 'triage' },
      ]);
    });
  });
});
