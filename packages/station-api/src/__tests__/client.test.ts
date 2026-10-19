import { createStationClient, endpoints, StationApiError } from '../index.js';

interface Recorded {
  url: string;
  init: RequestInit;
}

function stubFetch(status: number, body: unknown): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fake, calls };
}

async function rejection(promise: Promise<unknown>): Promise<StationApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof StationApiError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

describe('createStationClient', () => {
  it('posts JSON with the API key to the endpoint path', async () => {
    const { fetch, calls } = stubFetch(200, { slug: 'docs/a', commit: 'abc1234', created: true });
    const client = createStationClient({ baseUrl: 'https://station.lan/', apiKey: 'k-123', fetch });

    const result = await client.write({ slug: 'docs/a', body: 'hello' });

    expect(result).toEqual({ slug: 'docs/a', commit: 'abc1234', created: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://station.lan/api/v1/write');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer k-123');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ slug: 'docs/a', body: 'hello' });
  });

  it('keeps a path prefix in the base URL', async () => {
    const { fetch, calls } = stubFetch(200, { current: true });
    const client = createStationClient({ baseUrl: 'https://lan/station', apiKey: 'k', fetch });
    await client.freshen({});
    expect(calls[0]!.url).toBe('https://lan/station/api/v1/freshen');
  });

  it('exposes one method per endpoint', () => {
    const client = createStationClient({ baseUrl: 'https://lan', apiKey: 'k', fetch: stubFetch(200, {}).fetch });
    expect(Object.keys(client).sort()).toEqual(Object.keys(endpoints).sort());
  });

  it('returns the possible-duplicates branch of a create', async () => {
    const body = {
      result: 'possible-duplicates',
      candidates: [{ id: 'STN-7', title: 'Same thing', status: 'backlog', score: 9 }],
    };
    const client = createStationClient({ baseUrl: 'https://lan', apiKey: 'k', fetch: stubFetch(200, body).fetch });
    const result = await client.createIssue({ title: 'Same thing', 'created-by': { kind: 'agent' } });
    expect(result.result).toBe('possible-duplicates');
  });

  it('strips unknown response fields so newer stations stay compatible', async () => {
    const client = createStationClient({
      baseUrl: 'https://lan',
      apiKey: 'k',
      fetch: stubFetch(200, { current: true, extra: 1 }).fetch,
    });
    expect(await client.freshen({})).toEqual({ current: true });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [409, 'conflict'],
  ] as const)('maps a %i error envelope to StationApiError(%s)', async (status, code) => {
    const client = createStationClient({
      baseUrl: 'https://lan',
      apiKey: 'k',
      fetch: stubFetch(status, { error: { code, message: 'nope' } }).fetch,
    });
    const err = await rejection(client.getNote({ slug: 'docs/a' }));
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.message).toBe('nope');
  });

  it('passes through an error code this client does not know', async () => {
    const client = createStationClient({
      baseUrl: 'https://lan',
      apiKey: 'k',
      fetch: stubFetch(429, { error: { code: 'rate_limited', message: 'slow down' } }).fetch,
    });
    const err = await rejection(client.getNote({ slug: 'docs/a' }));
    expect(err.code).toBe('rate_limited');
    expect(err.status).toBe(429);
    expect(err.message).toBe('slow down');
  });

  it('rejects reserved verbs with not_implemented', async () => {
    const client = createStationClient({
      baseUrl: 'https://lan',
      apiKey: 'k',
      fetch: stubFetch(501, { error: { code: 'not_implemented', message: 'v2' } }).fetch,
    });
    const err = await rejection(client.propose({ slug: 'docs/a', body: 'x' }));
    expect(err.code).toBe('not_implemented');
    expect(err.status).toBe(501);
  });

  it('treats a 2xx answer from a reserved verb as invalid', async () => {
    const client = createStationClient({ baseUrl: 'https://lan', apiKey: 'k', fetch: stubFetch(200, {}).fetch });
    const err = await rejection(client.promote({ slug: 'docs/a', body: 'x' }));
    expect(err.code).toBe('invalid_response');
  });

  it('rejects a 2xx body that does not match the contract', async () => {
    const client = createStationClient({
      baseUrl: 'https://lan',
      apiKey: 'k',
      fetch: stubFetch(200, { slug: 'docs/a', commit: 'not-a-sha', created: true }).fetch,
    });
    const err = await rejection(client.write({ slug: 'docs/a', body: '' }));
    expect(err.code).toBe('invalid_response');
    expect(err.status).toBe(200);
  });

  it('reports a non-envelope error body as invalid_response with the status', async () => {
    const client = createStationClient({
      baseUrl: 'https://lan',
      apiKey: 'k',
      fetch: stubFetch(502, { message: 'bad gateway' }).fetch,
    });
    const err = await rejection(client.freshen({}));
    expect(err.code).toBe('invalid_response');
    expect(err.status).toBe(502);
  });

  it('reports a non-JSON body as invalid_response', async () => {
    const client = createStationClient({
      baseUrl: 'https://lan',
      apiKey: 'k',
      fetch: stubFetch(502, '<html>bad gateway</html>').fetch,
    });
    const err = await rejection(client.freshen({}));
    expect(err.code).toBe('invalid_response');
    expect(err.status).toBe(502);
  });

  it('reports a failed fetch as unreachable', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const client = createStationClient({ baseUrl: 'https://lan', apiKey: 'k', fetch: failing });
    const err = await rejection(client.freshen({}));
    expect(err.code).toBe('unreachable');
    expect(err.status).toBe(0);
    expect(err.cause).toBeInstanceOf(TypeError);
  });
});
