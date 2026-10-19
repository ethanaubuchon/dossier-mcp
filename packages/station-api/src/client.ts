import { z } from 'zod';
import type { ErrorCode } from './common.js';
import { endpoints, type EndpointDef, type Endpoints } from './endpoints.js';

/**
 * Codes the client adds on top of the station's own: `unreachable` when the
 * request never got a response, `invalid_response` when a response body
 * doesn't match the contract.
 */
export type ClientErrorCode = ErrorCode | 'unreachable' | 'invalid_response';

/**
 * Error envelope as received. The code is left open so that a code added by a
 * newer station still reaches the caller instead of becoming `invalid_response`.
 */
const ReceivedErrorSchema = z.object({
  error: z.object({ code: z.string().min(1), message: z.string() }),
});

export class StationApiError extends Error {
  /** A ClientErrorCode, or a code this client version doesn't know. */
  readonly code: ClientErrorCode | (string & {});
  /** HTTP status, or 0 when no response was received. */
  readonly status: number;

  constructor(code: ClientErrorCode | (string & {}), status: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StationApiError';
    this.code = code;
    this.status = status;
  }
}

export interface StationClientOptions {
  /** Station root URL, e.g. `https://station.lan`; may include a path prefix. */
  baseUrl: string;
  apiKey: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

type ClientMethod<E extends EndpointDef> = E['response'] extends z.ZodType
  ? (request: z.input<E['request']>) => Promise<z.output<E['response']>>
  : (request: z.input<E['request']>) => Promise<never>;

/** One method per endpoint. Every method rejects with StationApiError on failure. */
export type StationClient = { [K in keyof Endpoints]: ClientMethod<Endpoints[K]> };

export function createStationClient(options: StationClientOptions): StationClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;

  async function call(def: EndpointDef, request: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(base + def.path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(request),
      });
    } catch (err) {
      throw new StationApiError('unreachable', 0, `station unreachable: ${String(err)}`, { cause: err });
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new StationApiError('invalid_response', res.status, `response from ${def.path} is not JSON`, {
        cause: err,
      });
    }

    if (!res.ok) {
      const parsed = ReceivedErrorSchema.safeParse(body);
      if (parsed.success) {
        throw new StationApiError(parsed.data.error.code, res.status, parsed.data.error.message);
      }
      throw new StationApiError('invalid_response', res.status, `HTTP ${res.status} from ${def.path}`);
    }

    if (def.response === null) {
      throw new StationApiError('invalid_response', res.status, `${def.path} is reserved but answered ${res.status}`);
    }
    const parsed = def.response.safeParse(body);
    if (!parsed.success) {
      throw new StationApiError('invalid_response', res.status, `response from ${def.path} does not match the contract`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  const client: Record<string, (request: unknown) => Promise<unknown>> = {};
  for (const [name, def] of Object.entries(endpoints) as [string, EndpointDef][]) {
    client[name] = (request) => call(def, request);
  }
  return client as StationClient;
}
