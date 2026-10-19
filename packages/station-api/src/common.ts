import { z } from 'zod';
import { named } from './registry.js';

/**
 * A vault-relative note slug: path segments separated by `/`, no extension.
 * Case is preserved, since issue notes are named by their uppercase ID. A
 * segment can't start with `.`, which rules out `..` and hidden files.
 */
export const SlugSchema = named(
  'Slug',
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/, 'invalid slug'),
  'Vault-relative note slug, e.g. `projects/app-search` or `issues/STN-142`.',
);

/**
 * An issue ID: the instance prefix, a hyphen, and a number from one global
 * sequence. The prefix is 1–10 uppercase letters and the number has no leading
 * zero, which is the shape Forgejo's alphanumeric external-tracker style links.
 */
export const IssueIdSchema = named(
  'IssueId',
  z.string().regex(/^[A-Z]{1,10}-[1-9][0-9]*$/, 'invalid issue id'),
  'Issue ID: a 1–10 letter instance prefix and a sequence number, e.g. `STN-142`.',
);

export const IsoDateSchema = named('IsoDate', z.iso.date(), 'Calendar date, `YYYY-MM-DD`.');

/** Minute precision is allowed and the offset is optional, so `2026-10-18T14:02` is valid. */
export const IsoDateTimeSchema = named(
  'IsoDateTime',
  z.iso.datetime({ local: true, offset: true }),
  'ISO 8601 date-time; seconds and offset are optional.',
);

export const CommitShaSchema = named(
  'CommitSha',
  z.string().regex(/^[0-9a-f]{7,64}$/, 'invalid commit sha'),
  'Git commit SHA of a station commit.',
);

export const ErrorCodeSchema = named(
  'ErrorCode',
  z.enum(['invalid_request', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'not_implemented', 'internal']),
);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** HTTP status the station returns with each error code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  internal: 500,
  not_implemented: 501,
};

export const ErrorResponseSchema = named(
  'ErrorResponse',
  z.object({
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string(),
    }),
  }),
  'Body of every non-2xx response.',
);

export type Slug = z.infer<typeof SlugSchema>;
export type IssueId = z.infer<typeof IssueIdSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
