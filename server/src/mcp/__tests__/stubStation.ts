/**
 * An in-process dossier-station stand-in for tests, driven by the shared
 * contract in `dossier-station-api`: it routes by the package's endpoint table,
 * validates every request with that endpoint's request schema, and parses every
 * response through its response schema before sending, so the stub can't
 * drift from what a real station is allowed to answer.
 *
 * Notes and their history live in memory. Only the note reads and the
 * write/history/freshen verbs are implemented; every other endpoint answers
 * `not_implemented`.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import {
  ERROR_STATUS,
  endpoints,
  type EndpointDef,
  type ErrorCode,
  type HistoryEntry,
  type NoteFrontmatter,
} from 'dossier-station-api';

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

export async function startStubStation(apiKey = 'test-key'): Promise<StubStation> {
  const notes = new Map<string, StubNote>();
  const history = new Map<string, HistoryEntry[]>();
  const requests: StubStation['requests'] = [];
  let commitCounter = 0;

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
      const commit = (++commitCounter).toString(16).padStart(7, '0');
      const entry: HistoryEntry = {
        commit,
        date: new Date().toISOString(),
        author: 'stub',
        message: message ?? `${existing ? 'Update' : 'Create'} ${slug}`,
      };
      history.set(slug, [entry, ...(history.get(slug) ?? [])]);
      return { slug, commit, created: !existing };
    },
    history: ({ slug, limit }) => {
      const entries = history.get(slug);
      if (!entries) throw new StubError('not_found', `no history for ${slug}`);
      return { entries: entries.slice(0, limit ?? entries.length) };
    },
    freshen: () => ({ current: true }),
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
