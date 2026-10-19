import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildOpenApiDocument, CONTRACT_VERSION, endpoints, serializeOpenApiDocument } from '../index.js';

const packageRoot = path.resolve(__dirname, '../..');

describe('openapi.json', () => {
  it('is up to date with the schemas (run `pnpm -C packages/station-api gen:openapi`)', () => {
    const committed = readFileSync(path.join(packageRoot, 'openapi.json'), 'utf8');
    expect(committed).toBe(serializeOpenApiDocument());
  });
});

describe('buildOpenApiDocument', () => {
  const doc = buildOpenApiDocument() as {
    info: { version: string };
    paths: Record<string, { post: { operationId: string; responses: Record<string, unknown> } }>;
    components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  };

  it('uses the package version as the contract version', () => {
    const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { version: string };
    expect(CONTRACT_VERSION).toBe(pkg.version);
    expect(doc.info.version).toBe(pkg.version);
  });

  it('has one operation per endpoint', () => {
    for (const [name, def] of Object.entries(endpoints)) {
      expect(doc.paths[def.path]?.post.operationId).toBe(name);
    }
    expect(Object.keys(doc.paths)).toHaveLength(Object.keys(endpoints).length);
  });

  it('documents reserved verbs as 501-only', () => {
    for (const p of ['/api/v1/propose', '/api/v1/resolve', '/api/v1/promote']) {
      expect(Object.keys(doc.paths[p]!.post.responses).sort()).toEqual(['501', 'default']);
    }
  });

  it('declares bearer API-key auth', () => {
    expect(doc.components.securitySchemes.apiKey).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  it('does not claim RFC 3339 date-time for IsoDateTime, which allows omitting seconds and offset', () => {
    const schema = doc.components.schemas.IsoDateTime as { format?: string; pattern: string };
    expect(schema.format).toBeUndefined();
    expect(new RegExp(schema.pattern).test('2026-10-18T14:02')).toBe(true);
  });

  it('only references schemas it defines', () => {
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const id of refs) expect(doc.components.schemas).toHaveProperty([id]);
  });
});
