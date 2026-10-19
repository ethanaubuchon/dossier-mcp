import { z } from 'zod';
import { IsoDateSchema, IsoDateTimeSchema, IssueIdSchema, SlugSchema } from './common.js';
import { named } from './registry.js';

export const ISSUE_STATUSES = ['triage', 'backlog', 'in-progress', 'in-review', 'done', 'blocked', 'canceled'] as const;

export const IssueStatusSchema = named('IssueStatus', z.enum(ISSUE_STATUSES));

export const ResolutionSchema = named(
  'Resolution',
  z.enum(['duplicate', 'obsolete', 'wont-do']),
  'Why a canceled issue was closed.',
);

export const CreatedBySchema = named(
  'CreatedBy',
  z.object({
    kind: z.enum(['agent', 'human', 'migration']),
    source: z
      .string()
      .optional()
      .describe('Agent session or tool for agents, account name for humans, source system for migrations.'),
  }),
);

/**
 * Field shapes shared by the full frontmatter and by partial updates. Kept as
 * a bare shape because zod refuses `pick`/`partial` on refined objects.
 */
const issueFields = {
  id: IssueIdSchema,
  type: z.literal('issue'),
  title: z.string().min(1),
  status: IssueStatusSchema,
  created: IsoDateTimeSchema,
  'created-by': CreatedBySchema,
  project: SlugSchema.optional().describe('Slug of the one project this issue belongs to.'),
  repos: z.array(z.string().min(1)).describe('Repos the issue concerns; one by convention.'),
  labels: z.array(z.string().min(1)),
  'blocked-by': z.array(IssueIdSchema),
  'found-during': z.string().min(1).optional().describe('Issue ID or PR URL the issue came out of.'),
  owner: z.string().min(1).optional(),
  'last-reviewed': IsoDateSchema.optional(),
  resolution: ResolutionSchema.optional().describe('Set only when status is `canceled`.'),
  'duplicate-of': IssueIdSchema.optional().describe('Set only when resolution is `duplicate`.'),
  prs: z.array(z.string().min(1)).describe('URLs of PRs that address the issue.'),
  origin: z.string().min(1).optional().describe('Source issue for migrated issues, e.g. `owner/repo#142`.'),
};

type IssueResolutionFields = {
  status?: z.infer<typeof IssueStatusSchema>;
  resolution?: z.infer<typeof ResolutionSchema>;
  'duplicate-of'?: string;
};

/** Cross-field rules that JSON Schema can't carry; the OpenAPI doc states them in descriptions. */
function checkResolution(fm: IssueResolutionFields, ctx: z.core.$RefinementCtx<unknown>): void {
  if (fm.resolution !== undefined && fm.status !== 'canceled') {
    ctx.addIssue({ code: 'custom', path: ['resolution'], message: 'resolution requires status canceled' });
  }
  if (fm['duplicate-of'] !== undefined && fm.resolution !== 'duplicate') {
    ctx.addIssue({ code: 'custom', path: ['duplicate-of'], message: 'duplicate-of requires resolution duplicate' });
  }
}

export const IssueFrontmatterSchema = named(
  'IssueFrontmatter',
  z.object(issueFields).superRefine(checkResolution),
  'Frontmatter of `issues/<id>.md`. `resolution` requires status `canceled`; `duplicate-of` requires resolution `duplicate`.',
);

/**
 * Fields an update may change. `null` clears an optional field. `id`, `type`,
 * `created`, `created-by` and `origin` are fixed at creation.
 */
export const IssueFieldsUpdateSchema = named(
  'IssueFieldsUpdate',
  z.object({
    title: issueFields.title.optional(),
    status: issueFields.status.optional(),
    project: SlugSchema.nullable().optional(),
    repos: issueFields.repos.optional(),
    labels: issueFields.labels.optional(),
    'blocked-by': issueFields['blocked-by'].optional(),
    'found-during': z.string().min(1).nullable().optional(),
    owner: z.string().min(1).nullable().optional(),
    'last-reviewed': IsoDateSchema.nullable().optional(),
    resolution: ResolutionSchema.nullable().optional(),
    'duplicate-of': IssueIdSchema.nullable().optional(),
    prs: issueFields.prs.optional(),
  }),
  'Fields to change on an issue; omitted fields are untouched and `null` clears an optional field. The result must still satisfy the IssueFrontmatter rules.',
);

export const ProjectFrontmatterSchema = named(
  'ProjectFrontmatter',
  z.object({
    type: z.literal('project'),
    title: z.string().min(1),
    parent: SlugSchema.optional().describe('Slug of the parent project; projects form a tree.'),
    owner: z.string().min(1).optional(),
  }),
  'Frontmatter of `projects/<slug>.md`.',
);

export const IssueSchema = named(
  'Issue',
  z.object({
    frontmatter: IssueFrontmatterSchema,
    body: z.string().describe('Markdown body; comments are under a `## Comments` heading.'),
  }),
);

export const IssueSummarySchema = named(
  'IssueSummary',
  z.object({
    id: IssueIdSchema,
    title: z.string(),
    status: IssueStatusSchema,
    project: SlugSchema.optional(),
    repos: z.array(z.string()),
    labels: z.array(z.string()),
    'last-reviewed': IsoDateSchema.optional(),
  }),
);

export type IssueStatus = z.infer<typeof IssueStatusSchema>;
export type Resolution = z.infer<typeof ResolutionSchema>;
export type CreatedBy = z.infer<typeof CreatedBySchema>;
export type IssueFrontmatter = z.infer<typeof IssueFrontmatterSchema>;
export type IssueFieldsUpdate = z.infer<typeof IssueFieldsUpdateSchema>;
export type ProjectFrontmatter = z.infer<typeof ProjectFrontmatterSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type IssueSummary = z.infer<typeof IssueSummarySchema>;
