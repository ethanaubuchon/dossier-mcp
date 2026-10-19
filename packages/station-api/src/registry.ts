import { z } from 'zod';

export interface SchemaMeta {
  id: string;
}

/**
 * Every named schema in the contract. The OpenAPI generator emits each entry
 * as a component and replaces nested uses with `$ref`s. IDs live in a
 * package-local registry rather than zod's global one so that two copies of
 * this package in one process cannot collide on them; descriptions use
 * `.describe()`, which records them globally, like inline field descriptions.
 */
export const stationSchemas = z.registry<SchemaMeta>();

/** Register `schema` under `id`, attaching `description` if given. */
export function named<T extends z.ZodType>(id: string, schema: T, description?: string): T {
  const described = description === undefined ? schema : schema.describe(description);
  stationSchemas.add(described, { id });
  return described;
}
