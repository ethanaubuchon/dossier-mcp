/**
 * An in-process dossier-station stand-in for tests, driven by the shared
 * contract in `dossier-station-api`: it routes by the package's endpoint table,
 * validates every request with that endpoint's request schema, and parses every
 * response through its response schema before sending, so the stub can't
 * drift from what a real station is allowed to answer.
 *
 * Notes and their history live in memory; issues are notes under `issues/`.
 * The note reads, the write/history/freshen verbs and the single-issue
 * operations are implemented; every other endpoint answers `not_implemented`.
 * Duplicate detection is a simple title-word overlap, enough to drive the
 * candidates branch.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import {
  ERROR_STATUS,
  IssueFrontmatterSchema,
  MAX_DUPLICATE_CANDIDATES,
  endpoints,
  type EndpointDef,
  type ErrorCode,
  type HistoryEntry,
  type IssueFrontmatter,
  type IssueStatus,
  type NoteFrontmatter,
} from 'dossier-station-api';

/** Share of a new title's words an existing title must contain to be a candidate. */
const DUPLICATE_THRESHOLD = 0.5;
/** Days after which an issue's `last-reviewed` makes it stale. */
const STALE_DAYS = 30;

export interface StubNote {
  frontmatter: NoteFrontmatter;
  body: string;
}

export interface StubStation {
  /** Base URL to point a client at. */
  url: string;
  apiKey: string;
  notes: Map<string, StubNote>;
  history: Map<string, HistoryEntry[]>;
  /** Every authenticated, valid request, in arrival order. */
  requests: Array<{ endpoint: string; body: Record<string, unknown> }>;
  /** When set, requests are accepted but never answered. */
  hang: boolean;
  close(): Promise<void>;
}

class StubError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

function tagsOf(fm: NoteFrontmatter): string[] {
  return Array.isArray(fm.tags) ? fm.tags.map((t) => String(t).toLowerCase()) : [];
}

function excluded(fm: NoteFrontmatter, excludeTags: string[] | undefined): boolean {
  if (!excludeTags || excludeTags.length === 0) return false;
  const set = new Set(excludeTags.map((t) => t.toLowerCase()));
  return tagsOf(fm).some((t) => set.has(t));
}

function kindOf(slug: string): 'issue' | 'doc' {
  return slug.startsWith('issues/') ? 'issue' : 'doc';
}

function titleWords(title: string): Set<string> {
  return new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
}

export async function startStubStation(apiKey = 'test-key'): Promise<StubStation> {
  const notes = new Map<string, StubNote>();
  const history = new Map<string, HistoryEntry[]>();
  const requests: StubStation['requests'] = [];
  let commitCounter = 0;

  function record(slug: string, message: string, statusChange?: HistoryEntry['status_change']): string {
    const commit = (++commitCounter).toString(16).padStart(7, '0');
    const entry: HistoryEntry = {
      commit,
      date: new Date().toISOString(),
      author: 'stub',
      message,
      ...(statusChange ? { status_change: statusChange } : {}),
    };
    history.set(slug, [entry, ...(history.get(slug) ?? [])]);
    return commit;
  }

  /** Every stored issue whose frontmatter is valid; seeded notes that aren't are ignored. */
  function issues(): Array<{ slug: string; fm: IssueFrontmatter; body: string }> {
    const out = [];
    for (const [slug, n] of notes) {
      if (kindOf(slug) !== 'issue') continue;
      const parsed = IssueFrontmatterSchema.safeParse(n.frontmatter);
      if (parsed.success) out.push({ slug, fm: parsed.data, body: n.body });
    }
    return out;
  }

  function getIssue(id: string): { slug: string; fm: IssueFrontmatter; body: string } {
    const found = issues().find((i) => i.fm.id === id);
    if (!found) throw new StubError('not_found', `no issue ${id}`);
    return found;
  }

  function nextIssueId(): string {
    let max = 0;
    for (const slug of notes.keys()) {
      const m = /^issues\/STN-(\d+)$/.exec(slug);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `STN-${max + 1}`;
  }

  function storeIssue(fm: Record<string, unknown>, body: string, message: string, from: IssueStatus | null) {
    const parsed = IssueFrontmatterSchema.safeParse(fm);
    if (!parsed.success) throw new StubError('invalid_request', parsed.error.message);
    const slug = `issues/${parsed.data.id}`;
    notes.set(slug, { frontmatter: parsed.data, body });
    const to = parsed.data.status;
    const commit = record(slug, message, from === to ? undefined : { from, to });
    return { issue: { frontmatter: parsed.data, body }, commit };
  }

  /** `project` itself, or a project whose `parent` chain reaches it. */
  function inProject(project: string | undefined, target: string, subprojects: boolean): boolean {
    const seen = new Set<string>();
    let current = project;
    while (current !== undefined && !seen.has(current)) {
      if (current === target) return true;
      if (!subprojects) return false;
      seen.add(current);
      const parent = notes.get(`projects/${current}`)?.frontmatter.parent;
      current = typeof parent === 'string' ? parent : undefined;
    }
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers: Record<string, (req: any) => unknown> = {
    getNote: ({ slug }) => {
      const note = notes.get(slug);
      if (!note) throw new StubError('not_found', `no note at ${slug}`);
      return { note: { slug, ...note } };
    },
    listNotes: ({ path, kind, exclude_tags }) => {
      const items = [...notes.entries()]
        .filter(([slug]) => !path || slug.startsWith(path))
        .filter(([slug]) => !kind || kindOf(slug) === kind)
        .filter(([, n]) => !excluded(n.frontmatter, exclude_tags))
        .map(([slug, n]) => ({ slug, frontmatter: n.frontmatter }));
      items.sort((a, b) => String(b.frontmatter.date ?? '').localeCompare(String(a.frontmatter.date ?? '')));
      return { notes: items };
    },
    searchNotes: ({ query, limit, kind, exclude_tags }) => {
      const q = String(query).toLowerCase();
      const results = [...notes.entries()]
        .filter(([slug]) => !kind || kindOf(slug) === kind)
        .filter(([, n]) => !excluded(n.frontmatter, exclude_tags))
        .map(([slug, n]) => {
          const text = `${String(n.frontmatter.title ?? '')} ${n.body}`.toLowerCase();
          const score = text.split(q).length - 1;
          return { slug, frontmatter: n.frontmatter, score, excerpt: n.body.slice(0, 80) };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score);
      return { results: results.slice(0, limit ?? 10) };
    },
    write: ({ slug, body, frontmatter, create_only, message }) => {
      const existing = notes.get(slug);
      if (existing && create_only) throw new StubError('conflict', `${slug} already exists`);
      notes.set(slug, { frontmatter: frontmatter ?? existing?.frontmatter ?? {}, body });
      const commit = record(slug, message ?? `${existing ? 'Update' : 'Create'} ${slug}`);
      return { slug, commit, created: !existing };
    },
    history: ({ slug, limit }) => {
      const entries = history.get(slug);
      if (!entries) throw new StubError('not_found', `no history for ${slug}`);
      return { entries: entries.slice(0, limit ?? entries.length) };
    },
    freshen: () => ({ current: true }),
    createIssue: ({ confirm_new, body, ...req }) => {
      if (!confirm_new) {
        const words = titleWords(req.title);
        const candidates = issues()
          .map(({ fm }) => {
            const existing = titleWords(fm.title);
            const shared = [...words].filter((w) => existing.has(w)).length;
            return { id: fm.id, title: fm.title, status: fm.status, score: words.size ? shared / words.size : 0 };
          })
          .filter((c) => c.score >= DUPLICATE_THRESHOLD)
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_DUPLICATE_CANDIDATES);
        if (candidates.length > 0) return { result: 'possible-duplicates', candidates };
      }
      const id = nextIssueId();
      const fm = {
        id,
        type: 'issue',
        status: 'triage',
        created: new Date().toISOString(),
        repos: [],
        labels: [],
        'blocked-by': [],
        prs: [],
        ...req,
      };
      return { result: 'created', ...storeIssue(fm, body ?? '', `Create ${id}`, null) };
    },
    updateIssue: ({ id, set }) => {
      const { fm, body } = getIssue(id);
      if (typeof set['duplicate-of'] === 'string') getIssue(set['duplicate-of']);
      const next: Record<string, unknown> = { ...fm };
      for (const [key, value] of Object.entries(set as Record<string, unknown>)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      return storeIssue(next, body, `Update ${id}`, fm.status);
    },
    commentIssue: ({ id, author, body }) => {
      const issue = getIssue(id);
      const heading = /^## Comments$/m.test(issue.body) ? '' : '\n## Comments\n';
      const comment = `${heading}\n**${author}** (${new Date().toISOString()}):\n\n${body}\n`;
      return storeIssue(issue.fm, issue.body + comment, `Comment on ${id}`, issue.fm.status);
    },
    queryIssues: ({ status, project, include_subprojects, repo, label, stale, limit }) => {
      const cutoff = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString().slice(0, 10);
      const matches = issues()
        .map(({ fm }) => fm)
        .filter((fm) => !status || status.includes(fm.status))
        .filter((fm) => !project || inProject(fm.project, project, include_subprojects ?? true))
        .filter((fm) => !repo || fm.repos.includes(repo))
        .filter((fm) => !label || fm.labels.includes(label))
        .filter((fm) => stale !== true || fm['last-reviewed'] === undefined || fm['last-reviewed'] < cutoff)
        .map((fm) => ({
          id: fm.id,
          title: fm.title,
          status: fm.status,
          ...(fm.project ? { project: fm.project } : {}),
          repos: fm.repos,
          labels: fm.labels,
          ...(fm['last-reviewed'] ? { 'last-reviewed': fm['last-reviewed'] } : {}),
        }));
      return { issues: matches.slice(0, limit ?? matches.length) };
    },
  };

  const byPath = new Map<string, { name: string; def: EndpointDef }>(
    (Object.entries(endpoints) as [string, EndpointDef][]).map(([name, def]) => [def.path, { name, def }]),
  );

  const stub = { url: '', apiKey, notes, history, requests, hang: false } as StubStation;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (stub.hang) return;
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const fail = (code: ErrorCode, message: string) => send(ERROR_STATUS[code], { error: { code, message } });

      const route = req.method === 'POST' ? byPath.get(req.url ?? '') : undefined;
      if (!route) return fail('not_found', `no endpoint ${req.method} ${req.url}`);
      if (req.headers.authorization !== `Bearer ${apiKey}`) return fail('unauthorized', 'bad API key');

      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        return fail('invalid_request', 'body is not JSON');
      }
      const parsed = route.def.request.safeParse(raw);
      if (!parsed.success) return fail('invalid_request', parsed.error.message);
      requests.push({ endpoint: route.name, body: parsed.data as Record<string, unknown> });

      const handler = handlers[route.name];
      if (!handler || route.def.response === null) return fail('not_implemented', `${route.name} is not implemented`);
      try {
        send(200, route.def.response.parse(handler(parsed.data)));
      } catch (e) {
        if (e instanceof StubError) return fail(e.code, e.message);
        fail('internal', e instanceof Error ? e.message : String(e));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  stub.url = `http://127.0.0.1:${port}`;
  // Idempotent, so a test can stop the station early and teardown still succeeds.
  let closed: Promise<void> | undefined;
  stub.close = () =>
    (closed ??= new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((e) => (e ? reject(e) : resolve()));
    }));
  return stub;
}
