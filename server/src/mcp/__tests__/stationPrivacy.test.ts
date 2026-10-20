/**
 * The privacy check on station-bound writes, end to end: a personal local
 * vault, an optional shared local vault, and the stub station. A held write
 * must never reach the station, and a read-wide get_note of a personal note
 * must never send the station its slug.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
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

const PROFILE_LINE =
  'Ethan prefers to lead with the conclusion and one example, and disengages from repetitive work regardless of skill level.';
const QUOTE = 'lead with the conclusion and one example, and disengages from repetitive work';
const BUDGET_LINE = 'Monthly spend is tracked against the savings target for the house fund every quarter.';

describe('privacy check on station writes', () => {
  const dirs: string[] = [];
  let stub: StubStation;
  let personal: LocalVaultRuntime;
  let team: StationVaultRuntime;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

  async function localVault(name: string, shared = false): Promise<LocalVaultRuntime> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `library-privacy-${name}-`));
    dirs.push(dir);
    return { type: 'local', name, notesDir: dir, contextFile: 'profile.md', noteStore: new NoteStore(dir), searchIndex: new SearchIndex(), shared };
  }

  function wire(vaults: VaultRuntime[], defaultVault = 'personal') {
    server = createMcpServer({ vaults, defaultVault }, { version: '0.0.0-test' });
  }

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool: AnyTool | undefined = server._registeredTools[name];
    if (!tool) throw new Error(`tool not registered: ${name}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = (tool as any).inputSchema ? (tool as any).inputSchema.parse(args) : args;
    return tool.handler(parsed, {});
  }

  const text = (r: ToolResult) => r.content[0].text;
  const writes = () => stub.requests.filter((r) => r.endpoint !== 'getNote' && r.endpoint !== 'listNotes');
  const tokenOf = (r: ToolResult) => /approve_hold: "(hold-[0-9a-f]+)"/.exec(text(r))?.[1];

  beforeEach(async () => {
    stub = await startStubStation();
    personal = await localVault('personal');
    await fs.writeFile(path.join(personal.notesDir, 'profile.md'), `---\ntitle: Profile\n---\n# Profile\n\n${PROFILE_LINE}\n`);
    await personal.noteStore.upsert({ slug: 'finances/budget', title: 'Budget', content: BUDGET_LINE, tags: [], related: [] });
    team = createStationRuntime({
      type: 'station', name: 'team', url: stub.url, apiKeyEnv: 'K', apiKey: stub.apiKey, timeoutMs: 2000, contextFile: 'profile.md',
    });
    wire([personal, team]);
    stub.notes.set('docs/runbook', { frontmatter: { title: 'Runbook', date: '2026-10-01' }, body: '## Steps\n\nRestart the service.\n' });
    stub.notes.set('issues/STN-1', {
      frontmatter: {
        id: 'STN-1', type: 'issue', title: 'Flaky deploy', status: 'backlog', created: '2026-10-01T09:00',
        'created-by': { kind: 'human' }, repos: [], labels: [], 'blocked-by': [], prs: [],
      },
      body: 'Deploys fail sometimes.\n',
    });
  });

  afterEach(async () => {
    await stub.close();
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  describe('every station-bound write is held on personal content', () => {
    test.each([
      ['create_note', { title: 'New doc', content: `See [[finances/budget]].`, path: 'docs/new' }, /link to personal note "finances\/budget" \(vault "personal"\)/],
      ['update_note', { slug: 'docs/runbook', title: 'Runbook', content: `Context: ${QUOTE}.` }, /verbatim text from "profile\.md \(vault context\)"/],
      ['append_to_section', { slug: 'docs/runbook', heading: 'Steps', content: BUDGET_LINE }, /verbatim text from "finances\/budget"/],
      ['edit_note', { slug: 'docs/runbook', old_string: 'Restart the service.', new_string: `Restart. ${QUOTE}.` }, /profile\.md \(vault context\)/],
      ['edit_frontmatter', { slug: 'docs/runbook', set: { summary: `From finances/budget` } }, /link to personal note "finances\/budget"/],
      ['create_issue', { title: 'Budget tooling', body: BUDGET_LINE }, /verbatim text from "finances\/budget"/],
      ['update_issue', { id: 'STN-1', title: 'See [[profile]]' }, /link to personal note "profile"/],
      ['comment_issue', { id: 'STN-1', body: `Per my notes: ${QUOTE}.` }, /profile\.md \(vault context\)/],
    ])('%s', async (tool, args, match) => {
      const r = await call(tool, { ...args, vault: 'team' });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^Held: possible personal content — nothing was sent to station vault "team"\./);
      expect(text(r)).toMatch(match);
      expect(text(r)).toMatch(new RegExp(`call ${tool} again with the same arguments plus approve_hold: "hold-[0-9a-f]{16}"`));
      expect(writes()).toEqual([]);
    });
  });

  test('a personal note with broken frontmatter is still a source', async () => {
    await fs.mkdir(path.join(personal.notesDir, 'health'), { recursive: true });
    await fs.writeFile(
      path.join(personal.notesDir, 'health', 'notes.md'),
      '---\ntitle: Foo: bar: [unclosed\n---\nThe specialist appointment moved to the second Tuesday of every month going forward.\n',
    );
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await call('comment_issue', { id: 'STN-1', body: 'The specialist appointment moved to the second Tuesday of every month going forward.' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/verbatim text from "health\/notes"/);
    const link = await call('comment_issue', { id: 'STN-1', body: 'See [[health/notes]].' });
    expect(text(link)).toMatch(/link to personal note "health\/notes"/);
  });

  test('writing a station note at a personal note\'s path is held', async () => {
    const r = await call('create_note', { title: 'Budget', content: 'Team budget.', path: 'Finances/Budget', vault: 'team' });
    expect(text(r)).toMatch(/station path matches personal note "finances\/budget" \(vault "personal"\)/);
    expect(text(r)).not.toMatch(/link to personal note/);
    expect(writes()).toEqual([]);
  });

  test('editing a station note whose path matches a personal note is not held for the path', async () => {
    stub.notes.set('finances/budget', { frontmatter: { title: 'Team budget' }, body: '## Notes\n\nShared figures.\n' });
    const r = await call('append_to_section', { slug: 'finances/budget', heading: 'Notes', content: 'Updated.', vault: 'team' });
    expect(r.isError).toBeFalsy();
  });

  test('a personal vault folder that has gone missing fails the write instead of passing it', async () => {
    await fs.rm(personal.notesDir, { recursive: true, force: true });
    const r = await call('comment_issue', { id: 'STN-1', body: 'Nothing personal here.' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Failed to comment on issue "STN-1": .*ENOENT/);
    expect(writes()).toEqual([]);
  });

  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  (asRoot ? test.skip : test)('an unreadable personal folder fails the write instead of being skipped', async () => {
    const locked = path.join(personal.notesDir, 'health');
    await fs.mkdir(locked);
    await fs.writeFile(path.join(locked, 'x.md'), 'secret');
    await fs.chmod(locked, 0o000);
    try {
      const r = await call('comment_issue', { id: 'STN-1', body: 'Nothing personal here.' });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^Failed to comment on issue "STN-1": .*EACCES/);
      expect(writes()).toEqual([]);
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });

  test('frontmatter keys are checked as well as values', async () => {
    const r = await call('edit_frontmatter', { slug: 'docs/runbook', set: { [BUDGET_LINE]: 'x' }, vault: 'team' });
    expect(text(r)).toMatch(/verbatim text from "finances\/budget"/);
    expect(writes()).toEqual([]);
  });

  test('clean content goes through', async () => {
    const r = await call('create_issue', { title: 'Deploy flake', body: 'The deploy job times out on large images.' });
    expect(r.isError).toBeFalsy();
    expect(writes().map((w) => w.endpoint)).toEqual(['createIssue']);
  });

  test('local writes are not checked', async () => {
    const r = await call('create_note', { title: 'Copy', content: `${QUOTE} [[finances/budget]]`, path: 'notes/copy' });
    expect(r.isError).toBeFalsy();
  });

  test('shared local vaults are not sources', async () => {
    const shared = await localVault('team-docs', true);
    await shared.noteStore.upsert({ slug: 'shared/guide', title: 'Guide', content: 'The release checklist lives in the shared guide and covers every step we take.', tags: [], related: [] });
    wire([personal, shared, team]);
    const r = await call('comment_issue', { id: 'STN-1', body: 'The release checklist lives in the shared guide and covers every step we take. See [[shared/guide]].' });
    expect(r.isError).toBeFalsy();
  });

  test('without a personal vault there is nothing to check', async () => {
    wire([team], 'team');
    const r = await call('comment_issue', { id: 'STN-1', body: QUOTE });
    expect(r.isError).toBeFalsy();
  });

  test('content already on the station note does not re-trigger an edit', async () => {
    stub.notes.set('docs/approved', { frontmatter: { title: 'Approved' }, body: `## Notes\n\n${QUOTE}\n` });
    const r = await call('append_to_section', { slug: 'docs/approved', heading: 'Notes', content: 'An unrelated new line.', vault: 'team' });
    expect(r.isError).toBeFalsy();
  });

  describe('approving a held write with approve_hold', () => {
    test('the token from the held result sends exactly that content', async () => {
      const args = { id: 'STN-1', body: `Per my notes: ${QUOTE}.` };
      const held = await call('comment_issue', args);
      const token = tokenOf(held);
      expect(token).toBeDefined();
      const sent = await call('comment_issue', { ...args, approve_hold: token });
      expect(sent.isError).toBeFalsy();
      expect(writes().map((w) => w.endpoint)).toEqual(['commentIssue']);
    });

    test('a token does not carry over to different content', async () => {
      const held = await call('comment_issue', { id: 'STN-1', body: `Per my notes: ${QUOTE}.` });
      const r = await call('comment_issue', { id: 'STN-1', body: `Also: ${QUOTE}.`, approve_hold: tokenOf(held) });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/approve_hold did not match this content, so it was checked again\./);
      expect(writes()).toEqual([]);
    });

    test('a create_issue approval survives the confirm_new re-send', async () => {
      const args = { title: 'Budget tooling', body: BUDGET_LINE };
      const token = tokenOf(await call('create_issue', args));
      const r = await call('create_issue', { ...args, confirm_new: true, approve_hold: token });
      expect(r.isError).toBeFalsy();
      expect(writes().map((w) => w.endpoint)).toEqual(['createIssue']);
    });

    test('an update_issue token does not carry over to another issue', async () => {
      const issue = stub.notes.get('issues/STN-1')!;
      stub.notes.set('issues/STN-2', { ...issue, frontmatter: { ...issue.frontmatter, id: 'STN-2' } });
      const held = await call('update_issue', { id: 'STN-1', title: 'See [[profile]]' });
      const r = await call('update_issue', { id: 'STN-2', title: 'See [[profile]]', approve_hold: tokenOf(held) });
      expect(text(r)).toMatch(/approve_hold did not match this content/);
      expect(writes()).toEqual([]);
    });

    test('a note write approved by token goes through', async () => {
      const args = { title: 'New doc', content: 'See [[finances/budget]].', path: 'docs/new', vault: 'team' };
      const held = await call('create_note', args);
      const r = await call('create_note', { ...args, approve_hold: tokenOf(held) });
      expect(r.isError).toBeFalsy();
      expect(stub.notes.get('docs/new')?.body).toBe('See [[finances/budget]].');
    });
  });

  describe('asking the user directly (clients with elicitation)', () => {
    function withElicitation(answer: () => Promise<{ action: string }>) {
      // The SDK reports a bare `elicitation: {}` capability as `{ form: {} }`.
      jest.spyOn(server.server, 'getClientCapabilities').mockReturnValue({ elicitation: { form: {} } });
      return jest.spyOn(server.server, 'elicitInput').mockImplementation(answer);
    }

    test('accept sends the write', async () => {
      const ask = withElicitation(async () => ({ action: 'accept' }));
      const r = await call('comment_issue', { id: 'STN-1', body: QUOTE });
      expect(r.isError).toBeFalsy();
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask.mock.calls[0][0]).toMatchObject({ message: expect.stringMatching(/station vault "team" that may be personal/) });
      expect(ask.mock.calls[0][1]).toEqual({ timeout: 10 * 60_000 });
      expect(writes().map((w) => w.endpoint)).toEqual(['commentIssue']);
    });

    test('decline holds it without offering a token', async () => {
      withElicitation(async () => ({ action: 'decline' }));
      const r = await call('comment_issue', { id: 'STN-1', body: QUOTE });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/The user declined sending it\./);
      expect(tokenOf(r)).toBeUndefined();
      expect(writes()).toEqual([]);
    });

    test('approve_hold cannot skip the prompt: a declined prompt holds even with a valid token', async () => {
      const args = { id: 'STN-1', body: QUOTE };
      const token = tokenOf(await call('comment_issue', args));
      withElicitation(async () => ({ action: 'decline' }));
      const r = await call('comment_issue', { ...args, approve_hold: token });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/The user declined sending it\./);
      expect(writes()).toEqual([]);
    });

    test('a prompt that fails or times out refuses, with no token, even when one is supplied', async () => {
      const args = { id: 'STN-1', body: QUOTE };
      const token = tokenOf(await call('comment_issue', args));
      withElicitation(async () => {
        throw new Error('Request timed out');
      });
      jest.spyOn(console, 'error').mockImplementation(() => {});
      for (const extra of [{}, { approve_hold: token }]) {
        const r = await call('comment_issue', { ...args, ...extra });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/The user's approval couldn't be obtained \(Request timed out\)/);
        expect(tokenOf(r)).toBeUndefined();
      }
      expect(writes()).toEqual([]);
    });

    test('the prompt is tied to the tool call, so cancelling the call cancels it', async () => {
      const ask = withElicitation(async () => ({ action: 'decline' }));
      const controller = new AbortController();
      const tool: AnyTool = server._registeredTools.comment_issue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args = (tool as any).inputSchema.parse({ id: 'STN-1', body: QUOTE });
      await tool.handler(args, { signal: controller.signal });
      expect(ask.mock.calls[0][1]).toEqual({ timeout: 10 * 60_000, signal: controller.signal });
    });

    test('a client that rejects the prompt as an unknown method gets the token route', async () => {
      withElicitation(async () => {
        throw new McpError(ErrorCode.MethodNotFound, 'Method not found');
      });
      const args = { id: 'STN-1', body: QUOTE };
      const held = await call('comment_issue', args);
      expect(held.isError).toBe(true);
      expect(tokenOf(held)).toBeDefined();
      const sent = await call('comment_issue', { ...args, approve_hold: tokenOf(held) });
      expect(sent.isError).toBeFalsy();
      expect(writes().map((w) => w.endpoint)).toEqual(['commentIssue']);
    });

    test('a client that declares only URL elicitation gets the token route', async () => {
      jest.spyOn(server.server, 'getClientCapabilities').mockReturnValue({ elicitation: { url: {} } });
      const ask = jest.spyOn(server.server, 'elicitInput');
      const args = { id: 'STN-1', body: QUOTE };
      const held = await call('comment_issue', args);
      expect(tokenOf(held)).toBeDefined();
      const sent = await call('comment_issue', { ...args, approve_hold: tokenOf(held) });
      expect(sent.isError).toBeFalsy();
      expect(ask).not.toHaveBeenCalled();
    });
  });

  test('an unreadable context file fails the write instead of skipping the check', async () => {
    await fs.rm(path.join(personal.notesDir, 'profile.md'));
    await fs.mkdir(path.join(personal.notesDir, 'profile.md'));
    const r = await call('comment_issue', { id: 'STN-1', body: 'Nothing personal here.' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Failed to comment on issue "STN-1": /);
    expect(writes()).toEqual([]);
  });

  describe('read-wide get_note keeps personal slugs off the station', () => {
    const mentionsSlug = (slug: string) => stub.requests.some((r) => JSON.stringify(r.body).includes(slug));

    test('a personal note is read without sending its slug or folder', async () => {
      const r = await call('get_note', { slug: 'finances/budget' });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toContain(BUDGET_LINE);
      expect(stub.requests).toEqual([{ endpoint: 'listNotes', body: { kind: 'doc', exclude_tags: [] } }]);
      expect(mentionsSlug('finances')).toBe(false);
    });

    test('a station note at a personal slug is still a collision, found by listing', async () => {
      stub.notes.set('finances/budget', { frontmatter: { title: 'Team budget' }, body: 'Team spend.\n' });
      const r = await call('get_note', { slug: 'finances/budget' });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe('Note "finances/budget" exists in multiple vaults: "personal", "team". Pass vault to disambiguate.');
      expect(stub.requests.map((q) => q.endpoint)).toEqual(['listNotes']);
      expect(mentionsSlug('finances')).toBe(false);
    });

    test('a personal note under issues/ lists the station\'s issues', async () => {
      await personal.noteStore.upsert({ slug: 'issues/STN-1', title: 'Mine', content: 'Private.', tags: [], related: [] });
      const r = await call('get_note', { slug: 'issues/STN-1' });
      expect(text(r)).toBe('Note "issues/STN-1" exists in multiple vaults: "personal", "team". Pass vault to disambiguate.');
      expect(stub.requests).toEqual([{ endpoint: 'listNotes', body: { kind: 'issue', exclude_tags: [] } }]);
    });

    test('a collision lists the default vault first, even when it is a station', async () => {
      stub.notes.set('finances/budget', { frontmatter: { title: 'Team budget' }, body: 'Team spend.\n' });
      wire([personal, team], 'team');
      const r = await call('get_note', { slug: 'finances/budget' });
      expect(text(r)).toBe('Note "finances/budget" exists in multiple vaults: "team", "personal". Pass vault to disambiguate.');
      expect(stub.requests.map((q) => q.endpoint)).toEqual(['listNotes']);
    });

    test('an unreachable station is skipped with a notice on a personal hit', async () => {
      await stub.close();
      const r = await call('get_note', { slug: 'finances/budget' });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toContain(BUDGET_LINE);
      expect(r.content[1].text).toMatch(/^Station vault "team" unavailable/);
    });

    test('a slug that is not in a personal vault is asked for directly', async () => {
      const shared = await localVault('team-docs', true);
      await shared.noteStore.upsert({ slug: 'docs/onboarding', title: 'Onboarding', content: 'Welcome.', tags: [], related: [] });
      wire([personal, shared, team]);
      const hit = await call('get_note', { slug: 'docs/onboarding' });
      expect(hit.isError).toBeFalsy();
      const station = await call('get_note', { slug: 'docs/runbook' });
      expect(text(station)).toContain('Restart the service.');
      expect(stub.requests).toEqual([
        { endpoint: 'getNote', body: { slug: 'docs/onboarding' } },
        { endpoint: 'getNote', body: { slug: 'docs/runbook' } },
      ]);
    });

    test('a personal hit alongside a shared hit still errors, and the station only lists', async () => {
      const shared = await localVault('team-docs', true);
      await shared.noteStore.upsert({ slug: 'finances/budget', title: 'Budget', content: 'Shared.', tags: [], related: [] });
      wire([personal, shared, team]);
      const r = await call('get_note', { slug: 'finances/budget' });
      expect(text(r)).toBe('Note "finances/budget" exists in multiple vaults: "personal", "team-docs". Pass vault to disambiguate.');
      expect(stub.requests.map((q) => q.endpoint)).toEqual(['listNotes']);
    });

    test('a collision still reports a station that went unchecked', async () => {
      const shared = await localVault('team-docs', true);
      await shared.noteStore.upsert({ slug: 'finances/budget', title: 'Budget', content: 'Shared.', tags: [], related: [] });
      wire([personal, shared, team]);
      await stub.close();
      const r = await call('get_note', { slug: 'finances/budget' });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/exists in multiple vaults: "personal", "team-docs"/);
      expect(r.content[1].text).toMatch(/^Station vault "team" unavailable/);
    });
  });
});
