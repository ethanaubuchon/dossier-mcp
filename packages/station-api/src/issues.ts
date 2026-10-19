import { z } from 'zod';
import { CommitShaSchema, ErrorResponseSchema, IssueIdSchema, SlugSchema } from './common.js';
import {
  CreatedBySchema,
  IssueFieldsUpdateSchema,
  IssueSchema,
  IssueStatusSchema,
  IssueSummarySchema,
} from './frontmatter.js';
import { named } from './registry.js';

/** Most duplicate candidates a create returns. */
export const MAX_DUPLICATE_CANDIDATES = 5;

export const CreateIssueRequestSchema = named(
  'CreateIssueRequest',
  z.object({
    title: z.string().min(1),
    body: z.string().optional(),
    'created-by': CreatedBySchema,
    status: IssueStatusSchema.optional().describe('Defaults to `triage`; agent-filed issues always land in `triage`.'),
    project: SlugSchema.optional(),
    repos: z.array(z.string().min(1)).optional(),
    labels: z.array(z.string().min(1)).optional(),
    'blocked-by': z.array(IssueIdSchema).optional(),
    'found-during': z.string().min(1).optional(),
    owner: z.string().min(1).optional(),
    origin: z.string().min(1).optional().describe('Source issue, for migrations.'),
    confirm_new: z
      .boolean()
      .optional()
      .describe('Skip the duplicate check. Send after reviewing `possible-duplicates` candidates and deciding none match.'),
  }),
);

export const DuplicateCandidateSchema = named(
  'DuplicateCandidate',
  z.object({
    id: IssueIdSchema,
    title: z.string(),
    status: IssueStatusSchema,
    score: z.number(),
  }),
);

export const CreateIssueResponseSchema = named(
  'CreateIssueResponse',
  z.discriminatedUnion('result', [
    z.object({
      result: z.literal('created'),
      issue: IssueSchema,
      commit: CommitShaSchema,
    }),
    z.object({
      result: z.literal('possible-duplicates'),
      candidates: z.array(DuplicateCandidateSchema).min(1).max(MAX_DUPLICATE_CANDIDATES),
    }),
  ]),
  'Either the created issue, or — when existing issues score above the duplicate threshold — candidates and no issue. On candidates, comment on a match or re-send with `confirm_new: true`.',
);

export const UpdateIssueRequestSchema = named(
  'UpdateIssueRequest',
  z.object({
    id: IssueIdSchema,
    set: IssueFieldsUpdateSchema,
  }),
);

export const IssueWriteResponseSchema = named(
  'IssueWriteResponse',
  z.object({
    issue: IssueSchema,
    commit: CommitShaSchema,
  }),
);

export const CommentIssueRequestSchema = named(
  'CommentIssueRequest',
  z.object({
    id: IssueIdSchema,
    author: z.string().min(1),
    body: z.string().min(1),
  }),
  'Appends a comment under the issue body\'s `## Comments` heading, stamped with the author and time.',
);

export const QueryIssuesRequestSchema = named(
  'QueryIssuesRequest',
  z.object({
    status: z.array(IssueStatusSchema).optional().describe('Match any of these statuses.'),
    project: SlugSchema.optional(),
    include_subprojects: z
      .boolean()
      .optional()
      .describe('With `project`, also match issues in its descendant projects. Defaults to true.'),
    repo: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    stale: z
      .boolean()
      .optional()
      .describe('Only issues not reviewed within the station\'s stale threshold.'),
    limit: z.number().int().min(1).optional(),
  }),
  'All filters are combined with AND.',
);

export const QueryIssuesResponseSchema = named(
  'QueryIssuesResponse',
  z.object({ issues: z.array(IssueSummarySchema) }),
);

export const BulkUpdateIssuesRequestSchema = named(
  'BulkUpdateIssuesRequest',
  z.object({
    updates: z.array(UpdateIssueRequestSchema).min(1),
  }),
);

export const BulkUpdateResultSchema = named(
  'BulkUpdateResult',
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), id: IssueIdSchema, commit: CommitShaSchema }),
    z.object({ ok: z.literal(false), id: IssueIdSchema, error: ErrorResponseSchema.shape.error }),
  ]),
);

export const BulkUpdateIssuesResponseSchema = named(
  'BulkUpdateIssuesResponse',
  z.object({
    results: z.array(BulkUpdateResultSchema).describe('One entry per update, in request order.'),
  }),
  'Each update is applied independently; one failing does not stop the rest.',
);

export type CreateIssueRequest = z.infer<typeof CreateIssueRequestSchema>;
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;
export type CreateIssueResponse = z.infer<typeof CreateIssueResponseSchema>;
export type UpdateIssueRequest = z.infer<typeof UpdateIssueRequestSchema>;
export type IssueWriteResponse = z.infer<typeof IssueWriteResponseSchema>;
export type CommentIssueRequest = z.infer<typeof CommentIssueRequestSchema>;
export type QueryIssuesRequest = z.infer<typeof QueryIssuesRequestSchema>;
export type QueryIssuesResponse = z.infer<typeof QueryIssuesResponseSchema>;
export type BulkUpdateIssuesRequest = z.infer<typeof BulkUpdateIssuesRequestSchema>;
export type BulkUpdateResult = z.infer<typeof BulkUpdateResultSchema>;
export type BulkUpdateIssuesResponse = z.infer<typeof BulkUpdateIssuesResponseSchema>;
