import { z } from 'zod';
import { ErrorResponseSchema, IsoDateTimeSchema } from './common.js';
import { endpoints, type EndpointDef } from './endpoints.js';
import { stationSchemas } from './registry.js';

/** Version of the wire contract; matches this package's `version`. */
export const CONTRACT_VERSION = '0.1.0';

const ref = (id: string) => `#/components/schemas/${id}`;

function schemaId(schema: z.ZodType, where: string): string {
  const id = stationSchemas.get(schema)?.id;
  if (id === undefined) throw new Error(`${where} is not a named schema`);
  return id;
}

/**
 * Build the OpenAPI 3.1 document from the registered schemas and the endpoint
 * table. Deterministic, so the committed `openapi.json` can be compared to it.
 */
export function buildOpenApiDocument(): Record<string, unknown> {
  // `io: 'input'` describes what a sender may put on the wire, so objects stay
  // open to fields added in later contract versions.
  const generated = z.toJSONSchema(stationSchemas, {
    target: 'draft-2020-12',
    io: 'input',
    uri: ref,
    override: (ctx) => {
      // RFC 3339 `date-time` requires seconds and an offset, which IsoDateTime
      // doesn't, so a strict validator would reject valid values. The pattern
      // alone describes the accepted shape.
      if (ctx.zodSchema === IsoDateTimeSchema) delete ctx.jsonSchema.format;
    },
  }).schemas;

  const components: Record<string, unknown> = {};
  for (const id of Object.keys(generated).sort()) {
    const { $schema: _schema, $id: _id, ...schema } = generated[id] as Record<string, unknown>;
    components[id] = schema;
  }

  const errorId = schemaId(ErrorResponseSchema, 'ErrorResponse');
  const errorResponse = {
    description: 'Error; the body names the error code.',
    content: { 'application/json': { schema: { $ref: ref(errorId) } } },
  };

  const paths: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(endpoints) as [string, EndpointDef][]) {
    const responses: Record<string, unknown> =
      def.response === null
        ? { '501': { ...errorResponse, description: 'Reserved verb; always `not_implemented`.' } }
        : {
            '200': {
              description: 'Success',
              content: { 'application/json': { schema: { $ref: ref(schemaId(def.response, `${name} response`)) } } },
            },
          };
    responses.default = errorResponse;
    paths[def.path] = {
      post: {
        operationId: name,
        summary: def.summary,
        'x-key-scope': def.scope,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: ref(schemaId(def.request, `${name} request`)) } } },
        },
        responses,
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'dossier-station API',
      version: CONTRACT_VERSION,
      description:
        'Agent API of dossier-station. Generated from the dossier-station-api schemas; do not edit by hand. ' +
        '`x-key-scope` names the API key scope each operation requires.',
    },
    security: [{ apiKey: [] }],
    paths,
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'Station API key.' } },
      schemas: components,
    },
  };
}

/** The exact text of the committed `openapi.json`. */
export function serializeOpenApiDocument(): string {
  return JSON.stringify(buildOpenApiDocument(), null, 2) + '\n';
}
